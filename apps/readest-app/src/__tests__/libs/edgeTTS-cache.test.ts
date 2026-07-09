import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
  createSupabaseClient: () => ({}),
  createSupabaseAdminClient: () => ({}),
}));

type Listener = (event: { data?: unknown }) => void;

const h = vi.hoisted(() => {
  const sockets: MockWebSocket[] = [];

  class MockWebSocket {
    binaryType = '';
    send = vi.fn();
    close = vi.fn();
    private listeners: Record<string, Listener[]> = {};

    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type: string, cb: Listener) {
      (this.listeners[type] ??= []).push(cb);
    }

    emit(type: string, event: { data?: unknown }) {
      for (const cb of this.listeners[type] ?? []) cb(event);
    }
  }

  return { MockWebSocket, sockets };
});

vi.mock('isomorphic-ws', () => ({
  default: h.MockWebSocket,
}));

// The pool-wide WS concurrency limit scales with the number of configured
// self-hosted relays (getEdgeTTSWsMaxConcurrent = per-backend * relay count).
// Pin the pool to a single relay so the reserve-one-slot invariant is exercised
// against one relay's budget (TTS_WS_MAX_CONCURRENT) regardless of the default
// multi-backend deployment configured in constants.ts.
vi.mock('@/services/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/environment')>();
  const wsUrl = 'ws://localhost/consumer/speech/synthesize/readaloud/edge/v1';
  return {
    ...actual,
    getEdgeTTSWsUrl: () => wsUrl,
    getEdgeTTSWsUrls: () => [wsUrl],
  };
});

const payload = {
  lang: 'zh-CN',
  text: '陈越越想越觉得无奈。',
  voice: 'zh-CN-YunxiNeural',
  rate: 1.62,
  pitch: 1,
};

const audioFrame = (body: Uint8Array) => {
  const headerText = 'X-RequestId:1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n';
  const headerBytes = new TextEncoder().encode(headerText);
  const frame = new Uint8Array(2 + headerBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setInt16(0, headerBytes.byteLength);
  frame.set(headerBytes, 2);
  frame.set(body, 2 + headerBytes.byteLength);
  return frame.buffer;
};

const finishSocketWithAudio = (socket: InstanceType<typeof h.MockWebSocket>) => {
  socket.emit('message', { data: audioFrame(new Uint8Array([1, 2, 3, 4])) });
  socket.emit('message', { data: 'X-RequestId:1\r\nPath:turn.end\r\n\r\n' });
};

const waitForSocketReady = async (index: number) => {
  await vi.waitFor(() => {
    expect(h.sockets[index]).toBeDefined();
    expect(h.sockets[index]!.send).toHaveBeenCalledTimes(2);
  });
  return h.sockets[index]!;
};

describe('EdgeSpeechTTS audio cache inflight sharing', () => {
  beforeEach(() => {
    vi.resetModules();
    h.sockets.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('keeps a cache-fill request alive when a prefetch consumer aborts', async () => {
    const { EdgeSpeechTTS } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS({ protocol: 'wss', wsTarget: 'self-hosted' });
    const prefetchController = new AbortController();
    const prefetchResult = tts
      .createAudioData(payload, prefetchController.signal, 'low')
      .catch((error: unknown) => error);

    const socket = await waitForSocketReady(0);
    prefetchController.abort();
    await prefetchResult;

    const playback = tts.createAudioData(payload, new AbortController().signal, 'high');
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sockets).toHaveLength(1);
    finishSocketWithAudio(socket);

    await expect(playback).resolves.toMatchObject({
      data: expect.any(ArrayBuffer),
      boundaries: [],
    });
    expect(h.sockets).toHaveLength(1);
  });

  test('reserves a slot for high-priority playback so low prefetch cannot fill the pool', async () => {
    const { EdgeSpeechTTS, TTS_WS_MAX_CONCURRENT } = await import('@/libs/edgeTTS');
    const tts = new EdgeSpeechTTS({ protocol: 'wss', wsTarget: 'self-hosted' });
    const mk = (text: string) => ({
      lang: 'zh-CN',
      text,
      voice: 'zh-CN-YunxiNeural',
      rate: 1,
      pitch: 1,
    });

    // One relay: pool-wide max = TTS_WS_MAX_CONCURRENT, low limit = max - 1.
    // Prefetch may fill every low slot; the last slot stays reserved for high.
    const lowLimit = Math.max(1, TTS_WS_MAX_CONCURRENT - 1);
    const lowPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < lowLimit; i++) {
      lowPromises.push(
        tts
          .createAudioData(mk(`sentence-low-${i}`), new AbortController().signal, 'low')
          .catch((error: unknown) => error),
      );
      await waitForSocketReady(i);
    }
    expect(h.sockets).toHaveLength(lowLimit);

    // One more low must queue: low slots full, remaining slot reserved for high.
    const queuedLow = tts
      .createAudioData(mk('sentence-queued-low'), new AbortController().signal, 'low')
      .catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sockets).toHaveLength(lowLimit);

    // High takes the reserved slot immediately while lows are still running.
    const high = tts.createAudioData(mk('sentence-high'), new AbortController().signal, 'high');
    const socketHigh = await waitForSocketReady(lowLimit);
    expect(h.sockets).toHaveLength(lowLimit + 1); // = TTS_WS_MAX_CONCURRENT

    // Free one low slot → queued low starts; high still holds its reserved slot.
    finishSocketWithAudio(h.sockets[0]!);
    await lowPromises[0];
    const socketQueued = await waitForSocketReady(lowLimit + 1);
    expect(h.sockets).toHaveLength(lowLimit + 2);

    finishSocketWithAudio(socketHigh);
    await high;
    for (let i = 1; i < lowLimit; i++) {
      finishSocketWithAudio(h.sockets[i]!);
      await lowPromises[i];
    }
    finishSocketWithAudio(socketQueued);
    await queuedLow;
  });
});
