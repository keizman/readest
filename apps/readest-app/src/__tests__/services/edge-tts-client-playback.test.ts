import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TTSMessageEvent } from '@/services/tts/TTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import { FakeAudioContext } from './tts-fake-audio';

// Mock control shared with the hoisted module mock.
type MockAudioData = {
  data: ArrayBuffer;
  boundaries: Array<{ offset: number; duration: number; text: string }>;
};
let createAudioDataBehavior: (payloadText: string) => Promise<MockAudioData>;
let parsedMarks: Array<{ offset?: number; name: string; text: string; language: string }> = [];
let hasPrefetchCapacity = true;

vi.mock('@/libs/edgeTTS', () => {
  const voices = [{ id: 'en-US-AriaNeural', name: 'Aria', lang: 'en-US' }];
  return {
    EdgeSpeechTTS: class MockEdgeSpeechTTS {
      static voices = voices;
      create = vi.fn().mockResolvedValue(undefined);
      createAudioData = vi
        .fn()
        .mockImplementation((payload: { text: string }) => createAudioDataBehavior(payload.text));
    },
    EDGE_TTS_MAX_RATE: 2.0,
    EDGE_TTS_PROTOCOL: 'wss',
    TTS_WS_MAX_CONCURRENT: 2,
    getEdgeTTSWsMaxConcurrent: () => 2,
    TTS_AUDIO_CACHE_MAX_BYTES: 20 * 60 * 6 * 1024,
    getTTSAudioCacheBytes: () => 0,
    hasTTSPrefetchCapacity: () => hasPrefetchCapacity,
    isTTSPayloadCached: () => false,
  };
});

vi.mock('@/utils/ssml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/ssml')>();
  return {
    ...actual,
    parseSSMLMarks: vi.fn(() => ({ marks: parsedMarks })),
  };
});

vi.mock('@/utils/misc', () => ({
  getUserLocale: vi.fn((lang: string) => (lang === 'en' ? 'en-US' : lang)),
}));

vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredVoice: vi.fn(() => null),
    sortVoicesPreferLocaleFunc: () => () => 0,
  },
}));

const consoleSpy = {
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
};
void consoleSpy;

// One second of fake audio bytes: the fake decoder maps 1 byte -> 1 sample at
// 24kHz, and all-zero samples make findSpeechBounds keep the full range.
const audioOf = (seconds: number): MockAudioData => ({
  data: new ArrayBuffer(Math.round(seconds * 24000)),
  boundaries: [],
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let rafCallbacks: Map<number, FrameRequestCallback>;
let rafId = 0;
const runRaf = () => {
  const cbs = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of cbs) cb(0);
};

interface MockController {
  dispatchSpeakMark: ReturnType<typeof vi.fn>;
  prepareSpeakWords: ReturnType<typeof vi.fn>;
  dispatchSpeakWord: ReturnType<typeof vi.fn>;
}

type EdgeClientClass = typeof import('@/services/tts/EdgeTTSClient').EdgeTTSClient;

describe('EdgeTTSClient Web Audio playback', () => {
  let EdgeTTSClient: EdgeClientClass;
  let controller: MockController;

  beforeEach(async () => {
    vi.resetModules();
    FakeAudioContext.instances = [];
    rafCallbacks = new Map();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.set(++rafId, cb);
      return rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
    createAudioDataBehavior = async () => audioOf(1);
    hasPrefetchCapacity = true;
    parsedMarks = [
      { name: '0', text: 'First sentence.', language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    controller = {
      dispatchSpeakMark: vi.fn(),
      prepareSpeakWords: vi.fn(),
      dispatchSpeakWord: vi.fn(),
    };
    ({ EdgeTTSClient } = await import('@/services/tts/EdgeTTSClient'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const startClient = async () => {
    const client = new EdgeTTSClient(controller as unknown as TTSController);
    await client.init();
    return client;
  };

  const collectSpeak = (
    client: InstanceType<EdgeClientClass>,
    signal: AbortSignal,
    options: { preload?: boolean; startup?: boolean } = {},
  ) => {
    const { preload = false, startup = false } = options;
    const events: TTSMessageEvent[] = [];
    const done = (async () => {
      for await (const event of client.speak('<ssml/>', signal, preload, startup)) {
        events.push(event);
      }
    })();
    return { events, done };
  };

  const ctx = () => FakeAudioContext.instances[0]!;

  test('ellipsis-only paragraph ends without audio so playback can advance', async () => {
    parsedMarks = [{ name: '0', text: '……', language: 'zh' }];
    const client = await startClient();
    let fetchCount = 0;
    createAudioDataBehavior = async () => {
      fetchCount++;
      return audioOf(1);
    };
    const { events, done } = collectSpeak(client, new AbortController().signal);
    await done;
    expect(fetchCount).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(events.at(-1)?.code).toBe('end');
  });

  test('batches short marks into one Edge request', async () => {
    const client = await startClient();
    let fetchCount = 0;
    createAudioDataBehavior = async () => {
      fetchCount++;
      return audioOf(1);
    };
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await ctx().advanceTo(5);
    await done;
    expect(fetchCount).toBe(1);
    expect(ctx().sources.length).toBe(1);
  });

  test('keeps sentences in one continuous source while mark and progress follow its clock', async () => {
    const firstText = 'First sentence.';
    const secondText = 'Second sentence.';
    parsedMarks = [
      { offset: 0, name: '0', text: firstText, language: 'en' },
      { offset: firstText.length, name: '1', text: secondText, language: 'en' },
    ];
    createAudioDataBehavior = async () => ({
      data: new ArrayBuffer(48000),
      boundaries: [
        { offset: 1_000_000, duration: 4_000_000, text: 'First' },
        { offset: 11_000_000, duration: 4_000_000, text: 'Second' },
      ],
    });
    const client = await startClient();
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();

    expect(ctx().sources).toHaveLength(1);
    // Baked 0.6s inter-sentence gap is removed; only minimal speech-edge padding remains.
    expect(ctx().sources[0]!.buffer!.duration).toBeCloseTo(0.81, 2);
    expect(client.getCurrentSpeakMark()?.name).toBe('0');

    const sourceStart = ctx().sources[0]!.startedAt!;
    ctx().currentTime = sourceStart + 0.55;
    runRaf();

    expect(client.getCurrentSpeakMark()?.name).toBe('1');
    expect(client.getChunkPosition()).toBeGreaterThan(0);
    expect(controller.dispatchSpeakMark).toHaveBeenLastCalledWith(parsedMarks[1]);

    await ctx().advanceTo(5);
    await done;
  });

  test('preload releases after critical batches while later batches fill in background', async () => {
    parsedMarks = [
      { name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
      { name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
      { name: '2', text: `${'c'.repeat(119)}.`, language: 'en' },
      { name: '3', text: `${'d'.repeat(119)}.`, language: 'en' },
    ];
    let resolveThird!: (audio: MockAudioData) => void;
    let fourthStarted = false;
    createAudioDataBehavior = async (text) => {
      if (text.startsWith('a') || text.startsWith('b')) return audioOf(1);
      if (text.startsWith('c')) {
        return new Promise<MockAudioData>((resolve) => {
          resolveThird = resolve;
        });
      }
      if (text.startsWith('d')) {
        fourthStarted = true;
      }
      return audioOf(1);
    };
    const client = await startClient();
    let preloadFinished = false;
    const { done } = collectSpeak(client, new AbortController().signal, { preload: true });
    done.then(() => {
      preloadFinished = true;
    });
    await flush();
    await flush();
    expect(preloadFinished).toBe(true);
    expect(fourthStarted).toBe(false);
    resolveThird(audioOf(1));
    await vi.waitFor(() => expect(fourthStarted).toBe(true));
    await done;
  });

  test('always prepares the imminent first batch even when lookahead cache is full', async () => {
    hasPrefetchCapacity = false;
    let fetchCount = 0;
    createAudioDataBehavior = async () => {
      fetchCount++;
      return audioOf(1);
    };
    const client = await startClient();
    const { done } = collectSpeak(client, new AbortController().signal, { preload: true });
    await done;
    expect(fetchCount).toBe(1);
  });

  test('plays marks gaplessly inside one batch source with one final end', async () => {
    const client = await startClient();
    const { events, done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();

    // Both sentences share one immutable source. The first mark is active
    // until the source clock crosses the second sentence's interval.
    expect(ctx().sources.length).toBe(1);
    expect(controller.dispatchSpeakMark).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.code === 'boundary')).toHaveLength(1);

    ctx().currentTime = ctx().sources[0]!.startedAt! + 0.6;
    runRaf();
    expect(controller.dispatchSpeakMark).toHaveBeenCalledTimes(2);

    await ctx().advanceTo(3);
    await done;
    expect(events.map((e) => e.code)).toEqual(['boundary', 'end']);
    expect(events[0]!.mark).toBe('0');
  });

  test('visual progress follows the audio clock before a delayed onended callback', async () => {
    const firstText = 'First sentence.';
    const secondText = 'Second sentence.';
    parsedMarks = [
      { offset: 0, name: '0', text: firstText, language: 'en' },
      { offset: firstText.length, name: '1', text: secondText, language: 'en' },
    ];
    createAudioDataBehavior = async () => ({
      data: new ArrayBuffer(48000),
      boundaries: [
        { offset: 1_000_000, duration: 5_000_000, text: 'First' },
        { offset: 11_000_000, duration: 5_000_000, text: 'Second' },
      ],
    });
    const client = await startClient();
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();

    const sourceStart = ctx().sources[0]!.startedAt!;
    // Move only the audio clock. No source transition or onended callback is
    // involved: sentence progress is metadata on the continuous batch source.
    ctx().currentTime = sourceStart + 0.55;
    runRaf();

    expect(controller.dispatchSpeakMark).toHaveBeenLastCalledWith(parsedMarks[1]);
    await ctx().advanceTo(5);
    await done;
  });

  test('chunks are scheduled gaplessly with no element restarts', async () => {
    parsedMarks = [
      { name: '0', text: `${'a'.repeat(119)},`, language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    const client = await startClient();
    await client.setRate(1);
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();
    const [first, second] = ctx().sources;
    expect(second!.startedAt! - first!.endTime).toBeCloseTo(0, 5);
    await ctx().advanceTo(5);
    await done;
  });

  test('trims batch-edge padding so adjacent chunks do not carry audible silence', async () => {
    parsedMarks = [
      { name: '0', text: `${'a'.repeat(119)},`, language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    createAudioDataBehavior = async () => ({
      data: new ArrayBuffer(24000),
      boundaries: [{ offset: 2_000_000, duration: 4_000_000, text: 'word' }],
    });
    const client = await startClient();
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();

    const [first, second] = ctx().sources;
    expect(first!.buffer!.duration).toBeCloseTo(0.41, 2);
    expect(second!.buffer!.duration).toBeCloseTo(0.41, 2);
    expect(second!.startedAt! - first!.endTime).toBeCloseTo(0, 5);

    await ctx().advanceTo(5);
    await done;
  });

  test('inter-batch scheduling stays gapless when playback rate increases', async () => {
    parsedMarks = [
      { name: '0', text: `${'a'.repeat(119)},`, language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    const client = await startClient();
    await client.setRate(2);
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();
    const [first, second] = ctx().sources;
    expect(second!.startedAt! - first!.endTime).toBeCloseTo(0, 5);
    await ctx().advanceTo(5);
    await done;
  });

  test('pipelines much further ahead while the page is hidden (backgrounded)', async () => {
    // Foreground fetches keep ~TTS_WS_MAX_CONCURRENT batches warm, which is
    // enough since prep keeps pace with playback. Backgrounded, the same
    // main-thread work (WS fetch/decode) can be throttled far more, so the
    // pipeline must queue much deeper ahead of time or the already-scheduled
    // audio drains before the next batch is ready — reintroducing the exact
    // audible pauses between sentences this pipeline exists to remove.
    const originalVisibilityState = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    try {
      const manyMarks = Array.from({ length: 12 }, (_, i) => ({
        offset: i * 120,
        name: String(i),
        text: `${String.fromCharCode(97 + i).repeat(119)}.`,
        language: 'en',
      }));
      let fetchCount = 0;
      const neverResolve = new Promise<MockAudioData>(() => {});
      createAudioDataBehavior = async () => {
        fetchCount++;
        return neverResolve;
      };
      const client = await startClient();
      const done = (async () => {
        for await (const _ of client.speakMarks(manyMarks, new AbortController().signal)) {
          void _;
        }
      })();
      await vi.waitFor(() => expect(fetchCount).toBeGreaterThan(2));
      expect(fetchCount).toBeGreaterThanOrEqual(10);
      void done;
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      }
    }
  });

  test('pipelines a larger bounded window while visible', async () => {
    const manyMarks = Array.from({ length: 12 }, (_, i) => ({
      offset: i * 120,
      name: String(i),
      text: `${String.fromCharCode(97 + i).repeat(119)}.`,
      language: 'en',
    }));
    let fetchCount = 0;
    const neverResolve = new Promise<MockAudioData>(() => {});
    createAudioDataBehavior = async () => {
      fetchCount++;
      return neverResolve;
    };
    const client = await startClient();
    const done = (async () => {
      for await (const _ of client.speakMarks(manyMarks, new AbortController().signal)) {
        void _;
      }
    })();
    await vi.waitFor(() => expect(fetchCount).toBeGreaterThan(2));
    expect(fetchCount).toBeGreaterThanOrEqual(8);
    expect(fetchCount).toBeLessThan(12);
    void done;
  });

  // Regression guard: an earlier change made the native Android app always
  // pipeline this deeply (PIPELINE_LOOKAHEAD_HIDDEN) even while visible, to
  // get ahead of app-switch throttling. In the field this sustained
  // over-fetching overwhelmed the self-hosted Edge TTS relay and broke
  // playback outright (every batch, including the first, timed out), so it
  // was reverted. Android must stay at the bounded visible-tier lookahead
  // until the page is actually hidden, not jump to the hidden-tier depth.
  test('does not deepen lookahead on the Android native app while visible', async () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
      configurable: true,
    });
    process.env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
    try {
      const manyMarks = Array.from({ length: 12 }, (_, i) => ({
        offset: i * 120,
        name: String(i),
        text: `${String.fromCharCode(97 + i).repeat(119)}.`,
        language: 'en',
      }));
      let fetchCount = 0;
      const neverResolve = new Promise<MockAudioData>(() => {});
      createAudioDataBehavior = async () => {
        fetchCount++;
        return neverResolve;
      };
      const client = await startClient();
      const done = (async () => {
        for await (const _ of client.speakMarks(manyMarks, new AbortController().signal)) {
          void _;
        }
      })();
      await vi.waitFor(() => expect(fetchCount).toBeGreaterThan(0));
      // Give any errant extra pipelining a chance to fire before asserting
      // it stayed capped at the same bounded visible-tier depth as any other
      // platform.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchCount).toBeGreaterThanOrEqual(8);
      expect(fetchCount).toBeLessThan(12);
      void done;
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
      delete process.env['NEXT_PUBLIC_APP_PLATFORM'];
    }
  });

  // Regression: backgrounding can happen while the scheduler is parked on
  // `await preparations[batchIndex]` for a batch that is itself slow under
  // throttling — exactly when the deeper hidden lookahead is most needed.
  // It must not wait for that await to resolve before deepening the queue.
  test('reacts immediately to backgrounding mid-batch instead of waiting for the loop to advance', async () => {
    const originalVisibilityState = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    try {
      const manyMarks = Array.from({ length: 12 }, (_, i) => ({
        offset: i * 120,
        name: String(i),
        text: `${String.fromCharCode(97 + i).repeat(119)}.`,
        language: 'en',
      }));
      let fetchCount = 0;
      const neverResolve = new Promise<MockAudioData>(() => {});
      createAudioDataBehavior = async () => {
        fetchCount++;
        return neverResolve;
      };
      const client = await startClient();
      const done = (async () => {
        for await (const _ of client.speakMarks(manyMarks, new AbortController().signal)) {
          void _;
        }
      })();

      // Starts visible: the bounded visible lookahead is queued, and batch 0
      // never resolves, so the scheduler loop is parked on it.
      await vi.waitFor(() => expect(fetchCount).toBe(8));

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // No further await/flush beyond the event dispatch: the deeper queue
      // must be triggered synchronously by the visibilitychange handler,
      // not by the stalled loop reaching its next per-batch check.
      await vi.waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(10));
      void done;
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      }
    }
  });

  test('pipelines batch fetch so later batches start before earlier ones finish', async () => {
    const marks = [
      { offset: 0, name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
      { offset: 120, name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
    ];
    let resolveFirst!: (audio: MockAudioData) => void;
    let fetchCount = 0;
    createAudioDataBehavior = async (text) => {
      fetchCount++;
      if (text.startsWith('a')) {
        return new Promise<MockAudioData>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return audioOf(2);
    };
    const client = await startClient();
    const done = (async () => {
      for await (const _ of client.speakMarks(marks, new AbortController().signal)) {
        void _;
      }
    })();
    await vi.waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
    resolveFirst(audioOf(2));
    await flush();
    await flush();
    if (ctx().sources.length >= 2) {
      const [first, second] = ctx().sources;
      expect(second!.startedAt! - first!.endTime).toBeCloseTo(0, 5);
    }
    await ctx().advanceTo(10);
    await done;
  });

  test('inter-batch scheduling stays gapless at 3.0x playback rate', async () => {
    parsedMarks = [
      { name: '0', text: `${'a'.repeat(119)},`, language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    const client = await startClient();
    await client.setRate(3);
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();
    const [first, second] = ctx().sources;
    expect(second!.startedAt! - first!.endTime).toBeCloseTo(0, 5);
    await ctx().advanceTo(5);
    await done;
  });

  test('rates above EDGE_TTS_MAX_RATE speed up via time-stretch, not raw source.playbackRate', async () => {
    // Edge's prosody rate already covers up to EDGE_TTS_MAX_RATE (2.0)
    // preserving pitch. The remaining factor used to be applied via
    // AudioBufferSourceNode.playbackRate, which resamples the audio and
    // shifts pitch upward — the "chipmunk"/Minions voice regression. It must
    // instead go through the pitch-preserving WSOLA stretch, so the native
    // source stays at its default rate.
    parsedMarks = [{ name: '0', text: 'Hello there.', language: 'en' }];
    createAudioDataBehavior = async () => audioOf(2);
    const client = await startClient();
    await client.setRate(3);
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();
    const [source] = ctx().sources;
    expect(source!.playbackRate.value).toBe(1);
    // webAudioRate = rate / EDGE_TTS_MAX_RATE = 3 / 2 = 1.5, so the 2s source
    // buffer should have been stretched down to roughly 2 / 1.5s of real audio.
    expect(source!.buffer!.duration).toBeCloseTo(2 / 1.5, 1);
    await ctx().advanceTo(5);
    await done;
  });

  test('word tracking follows the audio clock and survives pause/resume', async () => {
    createAudioDataBehavior = async () => ({
      data: new ArrayBuffer(48000), // 2s
      boundaries: [
        { offset: 1_000_000, duration: 4_000_000, text: 'Hello' }, // 0.1s
        { offset: 6_000_000, duration: 4_000_000, text: 'brave' }, // 0.6s
        { offset: 11_000_000, duration: 4_000_000, text: 'world' }, // 1.1s
      ],
    });
    parsedMarks = [{ name: '0', text: 'Hello brave world', language: 'en' }];
    const client = await startClient();
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();

    expect(controller.prepareSpeakWords).toHaveBeenCalledWith(['Hello', 'brave', 'world']);
    ctx().currentTime = 0.03 + 0.15;
    runRaf();
    expect(controller.dispatchSpeakWord).toHaveBeenLastCalledWith(0);

    await client.pause();
    expect(ctx().state).toBe('suspended');
    await client.resume();
    expect(ctx().state).toBe('running');

    ctx().currentTime = 0.03 + 0.7;
    runRaf();
    expect(controller.dispatchSpeakWord).toHaveBeenLastCalledWith(1);

    // Same index is not re-dispatched.
    const calls = controller.dispatchSpeakWord.mock.calls.length;
    runRaf();
    expect(controller.dispatchSpeakWord.mock.calls.length).toBe(calls);

    await ctx().advanceTo(5);
    await done;
  });

  test('abort mid-stream yields Aborted and stops all sources', async () => {
    const client = await startClient();
    const abortController = new AbortController();
    const { events, done } = collectSpeak(client, abortController.signal);
    await flush();
    await flush();
    abortController.abort();
    await done;
    expect(events.at(-1)).toMatchObject({ code: 'error', message: 'Aborted' });
    expect(ctx().sources.every((s) => s.stopped)).toBe(true);
  });

  test('a no-audio mark is skipped and the session continues', async () => {
    // Speakable empty-audio is retried (5x) then skipped; second mark plays.
    parsedMarks = [
      { name: '0', text: 'a'.repeat(80), language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    createAudioDataBehavior = async (text: string) => {
      if (text.includes('a'.repeat(20))) throw new Error('No audio data received.');
      return audioOf(1);
    };
    const client = await startClient();
    // startup splits into separate batches so the failure is isolated
    const { events, done } = collectSpeak(client, new AbortController().signal, {
      startup: true,
    });
    // Do not advance the clock until the second batch has actually scheduled
    // audio (first batch spends ~2.5s in retry backoff before skip).
    await vi.waitFor(
      () => {
        expect(FakeAudioContext.instances[0]?.sources.length ?? 0).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );
    await ctx().advanceTo(10);
    await done;
    const codes = events.map((e) => e.code);
    expect(codes.filter((c) => c === 'boundary')).toHaveLength(1);
    expect(codes.at(-1)).toBe('end');
  }, 20000);

  test('a decode failure is treated like no-audio: warn, skip, continue', async () => {
    parsedMarks = [
      { name: '0', text: 'a'.repeat(80), language: 'en' },
      { name: '1', text: 'Second sentence.', language: 'en' },
    ];
    // The context exists once the scheduler's first fetch runs (ensureContext
    // precedes it), so the first fetch installs a decoder that fails exactly
    // once — the first batch's decode dies, the second succeeds.
    let installed = false;
    createAudioDataBehavior = async () => {
      if (!installed) {
        installed = true;
        const context = FakeAudioContext.instances[0]!;
        const original = context.decodeImpl;
        let failed = false;
        context.decodeImpl = async (data) => {
          if (!failed) {
            failed = true;
            throw new Error('bad mp3');
          }
          return original(data);
        };
      }
      return audioOf(1);
    };
    const client = await startClient();
    // startup keeps marks in separate batches so a failed decode skips only mark 0
    const { events, done } = collectSpeak(client, new AbortController().signal, { startup: true });
    await flush();
    await flush();
    await ctx().advanceTo(10);
    await done;
    const codes = events.map((e) => e.code);
    expect(codes.filter((c) => c === 'boundary')).toHaveLength(1); // only mark 1 played
    expect(codes.at(-1)).toBe('end');
  });

  test('all marks failing still ends the session with end (no wedge)', async () => {
    createAudioDataBehavior = async () => {
      throw new Error('No audio data received.');
    };
    const client = await startClient();
    const { events, done } = collectSpeak(client, new AbortController().signal);
    await done; // zero chunks scheduled; session-end fires synchronously
    const codes = events.map((e) => e.code);
    expect(codes.at(-1)).toBe('end');
    expect(codes).not.toContain('boundary');
  });

  test('a hard fetch error yields error and terminates', async () => {
    createAudioDataBehavior = async () => {
      throw new Error('network exploded');
    };
    const client = await startClient();
    const { events, done } = collectSpeak(client, new AbortController().signal);
    await done;
    expect(events.at(-1)).toMatchObject({ code: 'error', message: 'network exploded' });
  }, 10000);

  test('pause without a session is a no-op returning true', async () => {
    const client = await startClient();
    expect(await client.pause()).toBe(true);
    expect(await client.resume()).toBe(true);
  });

  test('getChunkPosition reports trim-relative clamped seconds', async () => {
    const client = await startClient();
    parsedMarks = [{ name: '0', text: 'Only sentence.', language: 'en' }];
    const { done } = collectSpeak(client, new AbortController().signal);
    await flush();
    await flush();
    ctx().currentTime = 0.03 + 0.4;
    const pos = client.getChunkPosition();
    expect(pos).not.toBeNull();
    expect(pos!).toBeGreaterThan(0.3);
    expect(pos!).toBeLessThanOrEqual(1);
    await ctx().advanceTo(5);
    await done;
    expect(client.getChunkPosition()).toBeNull();
  });
});
