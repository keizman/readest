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
});
