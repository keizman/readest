import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildBatches } from '@/services/tts/ttsBatch';

// Shared mock control: tests can override createBehavior to change how create() behaves
let createBehavior: () => Promise<undefined> = () => Promise.resolve(undefined);

// Shared mock control for createAudioData() and parsed SSML marks
type MockAudioData = {
  data: ArrayBuffer;
  boundaries: Array<{ offset: number; duration: number; text: string }>;
};
let createAudioDataBehavior = vi.fn<() => Promise<MockAudioData>>(() =>
  Promise.resolve({ data: new ArrayBuffer(8), boundaries: [] }),
);
let createAudioDataPayloads: Array<{ text: string }> = [];
let parsedMarks: Array<{ name: string; text: string; language: string }> = [];

// --- Mocks ---

vi.mock('@/libs/edgeTTS', () => {
  const voices = [
    { id: 'en-US-AriaNeural', name: 'Aria', lang: 'en-US' },
    { id: 'en-US-AnaNeural', name: 'Ana', lang: 'en-US' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia', lang: 'en-GB' },
    { id: 'fr-FR-DeniseNeural', name: 'Denise', lang: 'fr-FR' },
  ];
  return {
    EdgeSpeechTTS: class MockEdgeSpeechTTS {
      static voices = voices;
      create = vi.fn().mockImplementation(() => createBehavior());
      createAudioData = vi.fn().mockImplementation((payload: { text: string }) => {
        createAudioDataPayloads.push(payload);
        return createAudioDataBehavior();
      });
    },
    EDGE_TTS_MAX_RATE: 2.0,
    EDGE_TTS_PROTOCOL: 'wss',
    TTS_WS_MAX_CONCURRENT: 2,
    getEdgeTTSWsMaxConcurrent: () => 2,
    TTS_AUDIO_CACHE_MAX_BYTES: 20 * 60 * 6 * 1024,
    getTTSAudioCacheBytes: () => 0,
    hasTTSPrefetchCapacity: () => true,
    getTTSPayloadCacheState: () => 'miss',
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

vi.mock('@/services/tts/TTSUtils', async (importOriginal) => {
  const { TTSUtils: ActualTTSUtils } =
    await importOriginal<typeof import('@/services/tts/TTSUtils')>();
  return {
    TTSUtils: {
      getPreferredVoice: vi.fn(() => null),
      sortVoicesFunc: ActualTTSUtils.sortVoicesFunc,
      sortVoicesPreferLocaleFunc: ActualTTSUtils.sortVoicesPreferLocaleFunc,
    },
  };
});

import { EdgeTTSClient } from '@/services/tts/EdgeTTSClient';
import { TTSController } from '@/services/tts/TTSController';

// Suppress console noise during tests
const consoleSpy = {
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
};
void consoleSpy;

describe('EdgeTTSClient', () => {
  let client: EdgeTTSClient;

  beforeEach(() => {
    createBehavior = () => Promise.resolve(undefined);
    createAudioDataBehavior = vi.fn<() => Promise<MockAudioData>>(() =>
      Promise.resolve({ data: new ArrayBuffer(8), boundaries: [] }),
    );
    createAudioDataPayloads = [];
    parsedMarks = [];
    client = new EdgeTTSClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    test('sets name to edge-tts', () => {
      expect(client.name).toBe('edge-tts');
    });

    test('starts uninitialized', () => {
      expect(client.initialized).toBe(false);
    });

    test('stores controller and appService when provided', () => {
      const mockController = {} as TTSController;
      const mockAppService = { isLinuxApp: false } as never;
      const c = new EdgeTTSClient(mockController, mockAppService);
      expect(c.controller).toBe(mockController);
      expect(c.appService).toBe(mockAppService);
    });

    test('controller and appService are undefined when not provided', () => {
      expect(client.controller).toBeUndefined();
      expect(client.appService).toBeUndefined();
    });
  });

  describe('init', () => {
    test('succeeds when create resolves and sets initialized to true', async () => {
      const result = await client.init();
      expect(result).toBe(true);
      expect(client.initialized).toBe(true);
    });

    test('populates voices from EdgeSpeechTTS.voices on init', async () => {
      await client.init();
      const voices = await client.getAllVoices();
      expect(voices).toHaveLength(4);
      expect(voices.map((v) => v.id)).toContain('en-US-AriaNeural');
    });

    test('does not require a live probe or auth for the self-hosted service', async () => {
      createBehavior = vi.fn(() => Promise.reject(new Error('probe should not run')));

      await expect(client.init()).resolves.toBe(true);
      expect(createBehavior).not.toHaveBeenCalled();
    });
  });

  describe('setRate', () => {
    test('stores rate value', async () => {
      await client.setRate(1.5);
      // Rate is private, so we verify indirectly - no error thrown
      await expect(client.setRate(0.5)).resolves.toBeUndefined();
    });

    test('accepts boundary values', async () => {
      await expect(client.setRate(0.5)).resolves.toBeUndefined();
      await expect(client.setRate(2.0)).resolves.toBeUndefined();
    });

    test('getPayload caps Edge TTS rate at 2.0 for rates above the limit', async () => {
      // Edge TTS SSML prosody rate silently caps at 2.0; passing a higher value
      // has no effect. The extra factor must be applied via Web Audio playbackRate.
      await client.setRate(3.0);
      const payload = client.getPayload('en-US', 'hello', 'en-US-AriaNeural');
      expect(payload.rate).toBe(2.0);
    });

    test('getPayload passes rate unchanged for rates within Edge TTS range', async () => {
      await client.setRate(1.5);
      const payload = client.getPayload('en-US', 'hello', 'en-US-AriaNeural');
      expect(payload.rate).toBe(1.5);
    });

    // Regression: a doubled Chinese ellipsis ("……") or an excessive run of
    // literal periods synthesizes as several stacked baked-in pauses on
    // Edge's side, observed as a multi-second stall before the next batch
    // plays. getPayload collapses these before they ever reach the wire.
    test('getPayload collapses repeated pause punctuation before sending to Edge', () => {
      const payload = client.getPayload('zh-CN', 'o……', 'zh-CN-XiaoxiaoNeural');
      expect(payload.text).toBe('o…');
    });

    test('getPayload leaves normal punctuation untouched', () => {
      const payload = client.getPayload('en-US', 'Hello, world!', 'en-US-AriaNeural');
      expect(payload.text).toBe('Hello, world!');
    });
  });

  describe('setPitch', () => {
    test('stores pitch value', async () => {
      await expect(client.setPitch(1.2)).resolves.toBeUndefined();
    });

    test('accepts boundary values', async () => {
      await expect(client.setPitch(0.5)).resolves.toBeUndefined();
      await expect(client.setPitch(1.5)).resolves.toBeUndefined();
    });
  });

  describe('setVoice', () => {
    test('sets voice when voice id exists in voice list', async () => {
      await client.init();
      await client.setVoice('en-US-AriaNeural');
      expect(client.getVoiceId()).toBe('en-US-AriaNeural');
    });

    test('does not change voice id when voice id is not found', async () => {
      await client.init();
      await client.setVoice('en-US-AriaNeural');
      await client.setVoice('nonexistent-voice');
      expect(client.getVoiceId()).toBe('en-US-AriaNeural');
    });

    test('voice id remains empty when no voice has been set', () => {
      expect(client.getVoiceId()).toBe('');
    });
  });

  describe('setPrimaryLang', () => {
    test('sets primary language', () => {
      client.setPrimaryLang('fr');
      // No public getter for primaryLang, but we verify no error
      // The effect is observed when speak() uses it
    });

    test('accepts any language string', () => {
      client.setPrimaryLang('zh-CN');
      client.setPrimaryLang('ja');
      client.setPrimaryLang('en');
      // No error thrown
    });
  });

  describe('supportsWordBoundaries', () => {
    test('returns true (Edge reports word-boundary timings)', () => {
      expect(client.supportsWordBoundaries()).toBe(true);
    });
  });

  describe('getGranularities', () => {
    test('returns array with sentence granularity only', () => {
      const granularities = client.getGranularities();
      expect(granularities).toEqual(['sentence']);
    });

    test('returns the same value regardless of initialization', async () => {
      const before = client.getGranularities();
      await client.init();
      const after = client.getGranularities();
      expect(before).toEqual(after);
    });
  });

  describe('getVoiceId', () => {
    test('returns empty string by default', () => {
      expect(client.getVoiceId()).toBe('');
    });

    test('returns the set voice id after setVoice', async () => {
      await client.init();
      await client.setVoice('fr-FR-DeniseNeural');
      expect(client.getVoiceId()).toBe('fr-FR-DeniseNeural');
    });
  });

  describe('getSpeakingLang', () => {
    test('returns empty string by default', () => {
      expect(client.getSpeakingLang()).toBe('');
    });
  });

  describe('getAllVoices', () => {
    test('returns voices from EdgeSpeechTTS after init', async () => {
      await client.init();
      const voices = await client.getAllVoices();
      expect(voices).toHaveLength(4);
      expect(voices[0]!.id).toBe('en-US-AriaNeural');
    });

    test('marks voices as disabled when not initialized', async () => {
      // Do NOT call init
      const voices = await client.getAllVoices();
      for (const voice of voices) {
        expect(voice.disabled).toBe(true);
      }
    });

    test('marks voices as enabled when initialized', async () => {
      await client.init();
      const voices = await client.getAllVoices();
      for (const voice of voices) {
        expect(voice.disabled).toBe(false);
      }
    });

    test('returns empty array before init since voices are assigned during init', async () => {
      // Before init, #voices is the empty default
      const voices = await client.getAllVoices();
      // Actually, the constructor doesn't call init, so #voices starts as []
      // But wait - init sets #voices = EdgeSpeechTTS.voices. Without init, it stays [].
      // However, getAllVoices returns this.#voices which starts as [].
      // Let's check: the mock voices are set on static, not on the instance default.
      expect(voices).toHaveLength(0);
    });
  });

  describe('getVoices', () => {
    beforeEach(async () => {
      await client.init();
    });

    test('filters voices by language prefix', async () => {
      const groups = await client.getVoices('fr-FR');
      expect(groups).toHaveLength(1);
      expect(groups[0]!.id).toBe('edge-tts');
      expect(groups[0]!.name).toBe('Edge TTS');
      expect(groups[0]!.voices).toHaveLength(1);
      expect(groups[0]!.voices[0]!.id).toBe('fr-FR-DeniseNeural');
    });

    test('handles "en" by expanding to locale and including en-US and en-GB', async () => {
      const groups = await client.getVoices('en');
      const voiceIds = groups[0]!.voices.map((v) => v.id);
      expect(voiceIds).toContain('en-US-AriaNeural');
      expect(voiceIds).toContain('en-US-AnaNeural');
      expect(voiceIds).toContain('en-GB-SoniaNeural');
    });

    test('returns sorted voices with user-locale voices first for "en"', async () => {
      // getUserLocale is mocked to return en-US for 'en'
      const groups = await client.getVoices('en');
      const voiceIds = groups[0]!.voices.map((v) => v.id);
      expect(voiceIds).toEqual(['en-US-AnaNeural', 'en-US-AriaNeural', 'en-GB-SoniaNeural']);
    });

    // #4033: the voice set must not change between parts of a single book that
    // mix region variants of the same language (e.g. en-US front matter and
    // en-GB body text in Standard Ebooks)
    test('returns the same English voice set for any region variant', async () => {
      const ids = async (lang: string) =>
        (await client.getVoices(lang))[0]!.voices.map((v) => v.id).sort();
      const us = await ids('en-US');
      const gb = await ids('en-GB');
      const en = await ids('en');
      expect(gb).toEqual(us);
      expect(en).toEqual(us);
      expect(us).toEqual(['en-GB-SoniaNeural', 'en-US-AnaNeural', 'en-US-AriaNeural']);
    });

    test('lists voices of the requested locale first', async () => {
      const gb = await client.getVoices('en-GB');
      expect(gb[0]!.voices[0]!.id).toBe('en-GB-SoniaNeural');
      const us = await client.getVoices('en-US');
      expect(us[0]!.voices[0]!.id).toBe('en-US-AnaNeural');
    });

    test('does not include voices from other languages', async () => {
      const fr = await client.getVoices('fr-FR');
      expect(fr[0]!.voices.map((v) => v.id)).toEqual(['fr-FR-DeniseNeural']);
      const en = await client.getVoices('en-US');
      expect(en[0]!.voices.map((v) => v.id)).not.toContain('fr-FR-DeniseNeural');
    });

    test('getVoiceIdFromLang still resolves an exact-locale default voice', async () => {
      expect(await client.getVoiceIdFromLang('en-GB')).toBe('en-GB-SoniaNeural');
      // AnaNeural sorts first for en-US but is avoided as default
      expect(await client.getVoiceIdFromLang('en-US')).toBe('en-US-AriaNeural');
    });

    test('marks group as disabled when not initialized', async () => {
      const uninitClient = new EdgeTTSClient();
      // We need voices to be populated but not initialized
      // Since uninitClient hasn't called init, #voices is empty
      const groups = await uninitClient.getVoices('en');
      expect(groups[0]!.disabled).toBe(true);
    });

    test('marks group as disabled when no matching voices found', async () => {
      const groups = await client.getVoices('zh-CN');
      expect(groups[0]!.disabled).toBe(true);
      expect(groups[0]!.voices).toHaveLength(0);
    });

    test('returns group not disabled when initialized and voices match', async () => {
      const groups = await client.getVoices('en');
      expect(groups[0]!.disabled).toBe(false);
    });
  });

  describe('shutdown', () => {
    test('sets initialized to false', async () => {
      await client.init();
      expect(client.initialized).toBe(true);
      await client.shutdown();
      expect(client.initialized).toBe(false);
    });

    test('clears the voice list', async () => {
      await client.init();
      const voicesBefore = await client.getAllVoices();
      expect(voicesBefore.length).toBeGreaterThan(0);

      await client.shutdown();
      const voicesAfter = await client.getAllVoices();
      expect(voicesAfter).toHaveLength(0);
    });

    test('can be called multiple times without error', async () => {
      await client.shutdown();
      await client.shutdown();
      expect(client.initialized).toBe(false);
    });

    test('can re-initialize after shutdown', async () => {
      await client.init();
      await client.shutdown();
      expect(client.initialized).toBe(false);

      await client.init();
      expect(client.initialized).toBe(true);
      const voices = await client.getAllVoices();
      expect(voices.length).toBeGreaterThan(0);
    });
  });

  describe('speak preload retry', () => {
    const consumePreload = async (c: EdgeTTSClient, signal: AbortSignal) => {
      for await (const _ of c.speak('<ssml/>', signal, true)) {
        void _;
      }
    };

    test('retries createAudioData up to 5 times when preload fails', async () => {
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];
      createAudioDataBehavior = vi.fn(() => Promise.reject(new Error('network error')));

      await consumePreload(client, new AbortController().signal);

      expect(createAudioDataBehavior).toHaveBeenCalledTimes(5);
    });

    test('does not retry when the first preload attempt succeeds', async () => {
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];

      await consumePreload(client, new AbortController().signal);

      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
    });

    test('stops retrying once an attempt succeeds', async () => {
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];
      let calls = 0;
      createAudioDataBehavior = vi.fn(() => {
        calls++;
        return calls < 2
          ? Promise.reject(new Error('network error'))
          : Promise.resolve({ data: new ArrayBuffer(8), boundaries: [] });
      });

      await consumePreload(client, new AbortController().signal);

      expect(createAudioDataBehavior).toHaveBeenCalledTimes(2);
    });

    test('retries no-audio for speakable text (transient upstream empty audio)', async () => {
      // Upstream Edge sometimes returns empty audio for real sentences; that is
      // no longer treated as permanent (see isNoAudioSynthesisError + text).
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];
      createAudioDataBehavior = vi.fn(() => Promise.reject(new Error('No audio data received.')));

      await consumePreload(client, new AbortController().signal);

      expect(createAudioDataBehavior).toHaveBeenCalledTimes(5);
    });

    test('stops retrying once the signal is aborted', async () => {
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];
      const controller = new AbortController();
      createAudioDataBehavior = vi.fn(() => {
        controller.abort();
        return Promise.reject(new Error('network error'));
      });

      await consumePreload(client, controller.signal);

      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
    });

    test('releases retry backoff immediately when the signal is aborted', async () => {
      await client.init();
      parsedMarks = [{ name: 'mark-0', text: 'hello', language: 'en' }];
      const controller = new AbortController();
      createAudioDataBehavior = vi.fn(() => Promise.reject(new Error('network error')));

      const pending = consumePreload(client, controller.signal);
      await vi.waitFor(() => expect(createAudioDataBehavior).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();

      await expect(
        Promise.race([
          pending.then(() => 'released'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
        ]),
      ).resolves.toBe('released');
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
    });

    test('starts the next startup batch immediately but releases preload after the first two startup batches', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
        { name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
      ];
      const resolvers: Array<(value: MockAudioData) => void> = [];
      createAudioDataBehavior = vi.fn(
        () =>
          new Promise<MockAudioData>((resolve) => {
            resolvers.push(resolve);
          }),
      );

      const marks = [
        { offset: 0, name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
        { offset: 120, name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
      ];
      const criticalFetches = Math.min(buildBatches(marks, true).length, 2);
      expect(criticalFetches).toBeGreaterThanOrEqual(2);
      const iterator = client.speakMarks(marks, new AbortController().signal, true, true);
      const pending = iterator.next();

      await vi.waitFor(() =>
        expect(createAudioDataBehavior).toHaveBeenCalledTimes(criticalFetches),
      );
      resolvers[0]!({ data: new ArrayBuffer(8), boundaries: [] });
      await expect(
        Promise.race([
          pending.then(() => 'released'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
        ]),
      ).resolves.toBe('blocked');
      resolvers[1]!({ data: new ArrayBuffer(8), boundaries: [] });
      await expect(pending).resolves.toEqual({
        done: false,
        value: { code: 'end', message: 'Preload finished' },
      });
    });

    test('releases normal preload after the first batch while later batches keep warming', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
        { name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
      ];
      const resolvers: Array<(value: MockAudioData) => void> = [];
      createAudioDataBehavior = vi.fn(
        () =>
          new Promise<MockAudioData>((resolve) => {
            resolvers.push(resolve);
          }),
      );

      const iterator = client.speakMarks(
        [
          { offset: 0, name: '0', text: `${'a'.repeat(119)}.`, language: 'en' },
          { offset: 120, name: '1', text: `${'b'.repeat(119)}.`, language: 'en' },
        ],
        new AbortController().signal,
        true,
        false,
      );
      const pending = iterator.next();

      // Only the blocking first batch is launched before release; later batches
      // start in the background after the playhead can begin.
      await vi.waitFor(() => expect(createAudioDataBehavior).toHaveBeenCalledTimes(1));
      resolvers[0]!({ data: new ArrayBuffer(8), boundaries: [] });
      try {
        await expect(
          Promise.race([
            pending.then(() => 'released'),
            new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
          ]),
        ).resolves.toBe('released');
      } finally {
        resolvers[1]?.({ data: new ArrayBuffer(8), boundaries: [] });
        await pending.catch(() => {});
      }
    });

    test('skips pure Chinese ellipsis without requesting Edge audio', async () => {
      await client.init();
      parsedMarks = [{ name: '0', text: '……', language: 'zh' }];

      await consumePreload(client, new AbortController().signal);

      expect(createAudioDataBehavior).not.toHaveBeenCalled();
    });

    test('ends playback immediately for ellipsis-only marks', async () => {
      await client.init();
      parsedMarks = [{ name: '0', text: '……', language: 'zh' }];
      const events: { code: string }[] = [];
      for await (const event of client.speak('<ssml/>', new AbortController().signal)) {
        events.push(event);
      }
      expect(createAudioDataBehavior).not.toHaveBeenCalled();
      expect(events).toEqual([{ code: 'end', message: 'Nothing to speak' }]);
    });

    test('skips an ellipsis mark and synthesizes the next sentence', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: '……', language: 'zh' },
        { name: '1', text: 'Hello world.', language: 'zh' },
      ];
      for await (const _ of client.speak('<ssml/>', new AbortController().signal, true, true)) {
        void _;
      }
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
      expect(createAudioDataPayloads[0]!.text).toBe('Hello world.');
    });
  });

  describe('char batching preload', () => {
    const consumePreload = async (c: EdgeTTSClient, signal: AbortSignal, startup = false) => {
      for await (const _ of c.speak('<ssml/>', signal, true, startup)) {
        void _;
      }
    };

    test('merges marks under the char budget into one preload request', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: 'a'.repeat(20), language: 'en' },
        { name: '1', text: 'b'.repeat(20), language: 'en' },
      ];
      await consumePreload(client, new AbortController().signal);
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
      expect(createAudioDataPayloads[0]!.text.length).toBe(40);
    });

    test('uses a small first batch on startup preload', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: 'a'.repeat(30), language: 'en' },
        { name: '1', text: 'b'.repeat(30), language: 'en' },
        { name: '2', text: 'c'.repeat(30), language: 'en' },
      ];
      await consumePreload(client, new AbortController().signal, true);
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(2);
      expect(createAudioDataPayloads.map((p) => p.text.length).sort((a, b) => a - b)).toEqual([
        30, 60,
      ]);
    });

    test('merges marks past 120 chars when no punctuation boundary exists', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: 'a'.repeat(80), language: 'en' },
        { name: '1', text: 'b'.repeat(80), language: 'en' },
      ];
      await consumePreload(client, new AbortController().signal);
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(1);
      expect(createAudioDataPayloads[0]!.text.length).toBe(160);
    });

    test('splits at punctuation after the 120-char budget is met', async () => {
      await client.init();
      parsedMarks = [
        { name: '0', text: `${'a'.repeat(119)},`, language: 'en' },
        { name: '1', text: 'Second sentence.', language: 'en' },
      ];
      await consumePreload(client, new AbortController().signal);
      expect(createAudioDataBehavior).toHaveBeenCalledTimes(2);
      expect(createAudioDataPayloads[0]!.text.length).toBe(120);
    });
  });

  describe('pause / resume / stop', () => {
    test('pause returns true when no audio element exists', async () => {
      const result = await client.pause();
      expect(result).toBe(true);
    });

    test('resume returns true when no audio element exists', async () => {
      const result = await client.resume();
      expect(result).toBe(true);
    });

    test('stop resolves without error when no audio element exists', async () => {
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });
});
