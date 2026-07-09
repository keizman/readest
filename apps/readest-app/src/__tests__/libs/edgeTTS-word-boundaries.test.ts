import { describe, test, expect, vi, beforeEach } from 'vitest';

// Controllable WebSocket fake for the browser (isomorphic-ws) transport.
const wsState = vi.hoisted(() => ({
  instances: [] as Array<{
    url: string;
    binaryType: string;
    listeners: Record<string, Array<(event: unknown) => void>>;
    sent: unknown[];
    emit: (type: string, event?: unknown) => void;
  }>,
}));

vi.mock('isomorphic-ws', () => ({
  default: class MockWebSocket {
    url: string;
    opts?: unknown;
    binaryType = '';
    listeners: Record<string, Array<(event: unknown) => void>> = {};
    sent: unknown[] = [];
    constructor(url: string, opts?: unknown) {
      this.url = url;
      this.opts = opts;
      wsState.instances.push(this);
    }
    addEventListener(type: string, cb: (event: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {}
    emit(type: string, event?: unknown) {
      for (const cb of this.listeners[type] ?? []) cb(event);
    }
  },
}));

vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'http://localhost/api',
  getEdgeTTSBaseUrl: () => 'http://localhost',
  getEdgeTTSWsUrl: () => 'ws://localhost/consumer/speech/synthesize/readaloud/edge/v1',
  isTauriAppPlatform: () => false,
}));

vi.mock('@/utils/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
  createSupabaseClient: () => ({}),
  createSupabaseAdminClient: () => ({}),
}));

// Controllable stub for the self-hosted HTTPS Edge TTS fetch.
const httpState = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  body: new Uint8Array([1, 2, 3]),
  requests: [] as Array<{ input: unknown; init?: RequestInit }>,
}));
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: unknown, init?: RequestInit) => {
    httpState.requests.push({ input, init });
    return new Response(httpState.body, { status: 200, headers: httpState.headers });
  }),
);

const makeBinaryAudioFrame = (audio: Uint8Array) => {
  const header = new TextEncoder().encode('Path:audio\r\n');
  const buf = new ArrayBuffer(2 + header.length + audio.length);
  new DataView(buf).setInt16(0, header.length);
  new Uint8Array(buf).set(header, 2);
  new Uint8Array(buf).set(audio, 2 + header.length);
  return buf;
};

const makeMetadataFrame = (text: string, offset: number, duration: number) =>
  'X-RequestId:abc\r\nContent-Type:application/json; charset=utf-8\r\nPath:audio.metadata\r\n\r\n' +
  JSON.stringify({
    Metadata: [
      {
        Type: 'WordBoundary',
        Data: { Offset: offset, Duration: duration, text: { Text: text, Length: text.length } },
      },
    ],
  });

describe('EdgeSpeechTTS.createAudioData word boundaries (browser WebSocket path)', () => {
  beforeEach(() => {
    vi.resetModules();
    wsState.instances.length = 0;
    (URL as unknown as { createObjectURL?: (blob: Blob) => string }).createObjectURL = vi.fn(
      () => 'blob:mock-object-url',
    );
  });

  test('captures word boundaries from audio.metadata frames and caches them', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');
    const payload = {
      lang: 'en',
      text: 'Hello brave world',
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    };

    const promise = tts.createAudioData(payload);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));
    const ws = wsState.instances[0]!;
    expect(ws.url).toBe('ws://localhost/consumer/speech/synthesize/readaloud/edge/v1');
    // In a browser (jsdom has `window`), the WebSocket constructor must be
    // called WITHOUT an options argument: native WebSocket treats a second
    // argument as subprotocols and throws SyntaxError on an options object.
    expect((ws as unknown as { opts?: unknown }).opts).toBeUndefined();
    ws.emit('open');
    ws.emit('message', { data: makeMetadataFrame('Hello', 1000000, 4000000) });
    ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([1, 2, 3, 4])) });
    ws.emit('message', { data: makeMetadataFrame('brave', 6000000, 4000000) });
    ws.emit('message', { data: 'Path:turn.end\r\n\r\n' });

    const { data, boundaries } = await promise;
    expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(boundaries).toEqual([
      { offset: 1000000, duration: 4000000, text: 'Hello' },
      { offset: 6000000, duration: 4000000, text: 'brave' },
    ]);

    // A second call for the same payload is served from the cache: no new
    // WebSocket connection, same boundaries.
    const cached = await tts.createAudioData(payload);
    expect(wsState.instances.length).toBe(1);
    expect(new Uint8Array(cached.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(cached.boundaries).toEqual(boundaries);
  });

  test('caps low-priority prefetch to one WS slot and reserves one for playback', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');
    const payload = (text: string) => ({
      lang: 'en',
      text,
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });

    const p1 = tts.createAudioData(payload('one'));
    const p2 = tts.createAudioData(payload('two'));
    const p3High = tts.createAudioData(payload('three'), undefined, 'high');
    // Only one low slot is available, so the second low request queues while the
    // reserved slot is taken immediately by the high-priority playback fetch.
    await vi.waitFor(() => expect(wsState.instances.length).toBe(2));

    const finish = (index: number) => {
      const ws = wsState.instances[index]!;
      ws.emit('open');
      ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([index])) });
      ws.emit('message', { data: 'Path:turn.end\r\n\r\n' });
    };
    finish(0);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(3));
    finish(1);
    finish(2);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3High]);
    expect(new Uint8Array(r1.data)[0]).toBe(0); // socket 0: first low
    expect(new Uint8Array(r3.data)[0]).toBe(1); // socket 1: high (reserved slot)
    expect(new Uint8Array(r2.data)[0]).toBe(2); // socket 2: queued low
  });

  test('aborted queued WS request does not block later audio from starting', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');
    const payload = (text: string) => ({
      lang: 'en',
      text,
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });
    const abortQueued = new AbortController();

    const p1 = tts.createAudioData(payload('abort-queue-one'));
    const p2 = tts.createAudioData(payload('abort-queue-two'));
    const p3 = tts
      .createAudioData(payload('abort-queue-three'), abortQueued.signal)
      .catch((error) => error);
    const p4 = tts.createAudioData(payload('abort-queue-four'));
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));

    abortQueued.abort();
    await expect(p3).resolves.toBeInstanceOf(Error);

    const finish = (index: number) => {
      const ws = wsState.instances[index]!;
      ws.emit('open');
      ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([index])) });
      ws.emit('message', { data: 'Path:turn.end\r\n\r\n' });
    };
    finish(0);

    await vi.waitFor(() => expect(wsState.instances.length).toBe(2));
    finish(1);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(3));
    finish(2);

    await expect(Promise.all([p1, p2, p4])).resolves.toHaveLength(3);
  });

  test('rejects (does not hang forever) when the WS resets after partial audio arrives', async () => {
    // Regression test: an abnormal close before turn.end used to be silently
    // ignored whenever any audio bytes had already arrived, leaving the
    // returned promise (and the whole TTS scheduler awaiting it) parked
    // forever — the "WS resets, next sentence never plays" bug.
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');

    const promise = tts
      .createAudioData({
        lang: 'en',
        text: 'Reset mid stream',
        voice: 'en-US-AriaNeural',
        rate: 1.0,
        pitch: 1.0,
      })
      .catch((error) => error);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));
    const ws = wsState.instances[0]!;
    ws.emit('open');
    ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([1, 2, 3])) });
    // Connection resets before turn.end ever arrives.
    ws.emit('close');

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    // Must be retryable, not classified as the permanent "no audio" failure.
    expect((result as Error).message.toLowerCase()).not.toContain('no audio data received');
  });

  test('still rejects with "No audio data received" when the WS closes with zero bytes', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');

    const promise = tts
      .createAudioData({
        lang: 'en',
        text: 'Never sends audio',
        voice: 'en-US-AriaNeural',
        rate: 1.0,
        pitch: 1.0,
      })
      .catch((error) => error);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));
    const ws = wsState.instances[0]!;
    ws.emit('open');
    ws.emit('close');

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message.toLowerCase()).toContain('no audio data received');
  });

  test('a high-priority request jumps ahead of queued low-priority (background prefetch) requests', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');
    const payload = (text: string) => ({
      lang: 'en',
      text,
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });
    const open = (index: number) => wsState.instances[index]!.emit('open');
    const complete = (index: number) => {
      const ws = wsState.instances[index]!;
      ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([index])) });
      ws.emit('message', { data: 'Path:turn.end\r\n\r\n' });
    };

    // One low-priority prefetch takes the single background slot.
    const pSlotOne = tts.createAudioData(payload('prefetch-slot-one'));
    const pSlotTwo = tts.createAudioData(payload('prefetch-slot-two'));
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));
    open(0);

    // Another background prefetch queues behind the lone low slot.
    const pQueuedLow = tts.createAudioData(payload('prefetch-queued-low'));
    // The imminent-playback fetch uses the reserved slot immediately.
    const pQueuedHigh = tts.createAudioData(payload('playback-queued-high'), undefined, 'high');
    await vi.waitFor(() => expect(wsState.instances.length).toBe(2));
    open(1);

    // The playback-critical request must be on the reserved slot, not behind
    // the earlier-queued background prefetch request.
    const highWs = wsState.instances[1]!;
    expect(String(highWs.sent[1])).toContain('playback-queued-high');
    expect(String(highWs.sent[1])).not.toContain('prefetch-queued-low');

    complete(0);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(3));
    open(2);
    // The second low prefetch must finish before the third queued low can open:
    // only one low slot is available at a time.
    complete(2);
    await vi.waitFor(() => expect(wsState.instances.length).toBe(4));
    open(3);
    complete(1);
    complete(3);

    await Promise.all([pSlotOne, pSlotTwo, pQueuedLow, pQueuedHigh]);
  });

  test('resolves with empty boundaries when no metadata frames arrive', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('wss');

    const promise = tts.createAudioData({
      lang: 'en',
      text: 'No metadata here',
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });
    await vi.waitFor(() => expect(wsState.instances.length).toBe(1));
    const ws = wsState.instances[0]!;
    ws.emit('open');
    ws.emit('message', { data: makeBinaryAudioFrame(new Uint8Array([9, 9])) });
    ws.emit('message', { data: 'Path:turn.end\r\n\r\n' });

    const { boundaries } = await promise;
    expect(boundaries).toEqual([]);
  });
});

describe('word-boundary header (de)serialization', () => {
  test('round-trips boundaries, ASCII-safe for HTTP headers, incl. non-ASCII text', async () => {
    const { serializeWordBoundaries, parseWordBoundariesHeader } = await import('@/libs/edgeTTS');
    const boundaries = [
      { offset: 1000000, duration: 4000000, text: 'Hello' },
      { offset: 6000000, duration: 4000000, text: 'café—世界' },
    ];
    const header = serializeWordBoundaries(boundaries);
    // HTTP header values must be ASCII; non-ASCII text would corrupt the header.
    expect([...header].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(parseWordBoundariesHeader(header)).toEqual(boundaries);
  });

  test('parse returns [] for null, malformed, or non-boundary payloads', async () => {
    const { parseWordBoundariesHeader } = await import('@/libs/edgeTTS');
    expect(parseWordBoundariesHeader(null)).toEqual([]);
    expect(parseWordBoundariesHeader('not-json')).toEqual([]);
    expect(parseWordBoundariesHeader(encodeURIComponent(JSON.stringify({ x: 1 })))).toEqual([]);
    expect(parseWordBoundariesHeader(encodeURIComponent(JSON.stringify([{ text: 'x' }])))).toEqual(
      [],
    );
  });
});

describe('EdgeSpeechTTS.createAudioData over the HTTPS proxy (word boundaries via header)', () => {
  beforeEach(() => {
    httpState.headers = {};
    httpState.body = new Uint8Array([1, 2, 3]);
    httpState.requests.length = 0;
    (URL as unknown as { createObjectURL?: (blob: Blob) => string }).createObjectURL = vi.fn(
      () => 'blob:mock-object-url',
    );
  });

  test('parses word boundaries from the X-TTS-Word-Boundaries response header', async () => {
    const { EdgeSpeechTTS, serializeWordBoundaries, WORD_BOUNDARIES_HEADER } = await import(
      '@/libs/edgeTTS'
    );
    const boundaries = [
      { offset: 1000000, duration: 4000000, text: 'Hello' },
      { offset: 6000000, duration: 4000000, text: 'world' },
    ];
    httpState.headers = { [WORD_BOUNDARIES_HEADER]: serializeWordBoundaries(boundaries) };

    const tts = new EdgeSpeechTTS('https');
    const result = await tts.createAudioData({
      lang: 'en',
      text: 'Hello world https',
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });
    expect(result.boundaries).toEqual(boundaries);
  });

  test('returns empty boundaries when the proxy omits the header', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS('https');
    const result = await tts.createAudioData({
      lang: 'en',
      text: 'No header https',
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });
    expect(result.boundaries).toEqual([]);
  });

  test('requests gzip transport compression from the self-hosted HTTP server', async () => {
    const edgeTTS = await import('@/libs/edgeTTS');
    const { EdgeSpeechTTS } = edgeTTS;
    const tts = new EdgeSpeechTTS('https');

    await tts.createAudioData({
      lang: 'en',
      text: 'Compression header https',
      voice: 'en-US-AriaNeural',
      rate: 1.0,
      pitch: 1.0,
    });

    expect(httpState.requests).toHaveLength(1);
    const headers = httpState.requests[0]!.init?.headers as Record<string, string>;
    expect(edgeTTS.TTS_ACCEPT_ENCODING_HEADER).toBe('X-TTS-Accept-Encoding');
    expect(edgeTTS.TTS_ACCEPT_ENCODING_VALUE).toBe('gzip');
    expect(headers['X-TTS-Accept-Encoding']).toBe('gzip');
  });
});
