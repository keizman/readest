import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import {
  EdgeSpeechTTS,
  EdgeTTSPayload,
  EDGE_TTS_MAX_RATE,
  EDGE_TTS_PROTOCOL,
  getEdgeTTSWsMaxConcurrent,
  getTTSPayloadCacheState,
  type TTSPayloadCacheState,
  TTS_WS_MAX_CONCURRENT,
  TTSWordBoundary,
  WsSlotPriority,
} from '@/libs/edgeTTS';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import {
  collapseRepeatedPausePunctuation,
  hasSpeakableText,
  isEmptyAudioError,
  isNoAudioSynthesisError,
  parseSSMLMarks,
} from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { findBoundaryIndexAtTime } from './wordHighlight';
import {
  findSpeechBounds,
  LONG_PAUSE_SEC,
  MIN_COMPRESS_GAP_SEC,
  planSilenceCompression,
  SHORT_PAUSE_SEC,
} from './pcm';
import { timeStretch } from './timeStretch';
import {
  calibrateVoiceRate,
  recordMeasuredDuration,
  recordProvisionalDuration,
} from './ttsDuration';
import { buildBatches, partitionBatch } from './ttsBatch';
import { TTSAudioBuffer, WebAudioPlayer, WebAudioPlayerEvent } from './WebAudioPlayer';
import { elapsedMs, nowMs, ttsLog, ttsWarn } from './ttsDiagnostics';

// One Edge request is one immutable Web Audio source. Sentence boundaries are
// metadata on that source, never PCM cut points — highlighting, the scrubber,
// and audio share one clock. Edge's baked inter-sentence silences are removed
// via planSilenceCompression before scheduling; chunk boundaries stay gapSec 0.
const BATCH_EDGE_KEEP_SEC = 0.06;
// Final PCM padding around word-boundary-trimmed speech. Keep these tight so
// adjacent Edge batches do not sound like separate audio clips with a pause.
const EDGE_KEEP_SEC = 0.008;
const TRAILING_KEEP_SEC = 0.004;
const TICKS_PER_SECOND = 10_000_000;
// Visible playback should keep materially more than the two active WS slots
// queued, especially at 2x+ speed, but not jump to the aggressive hidden-tier
// depth that previously overwhelmed the self-hosted relay while the app was
// foregrounded. EdgeSpeechTTS still enforces TTS_WS_MAX_CONCURRENT network
// concurrency; this only keeps a bounded wait queue warm.
const PIPELINE_LOOKAHEAD_VISIBLE = 8;
// While the app is backgrounded, WS fetches/decodes on the main thread can be
// throttled far more than the bounded visible lookahead can absorb — that gap
// between "audio already scheduled" and "next batch prepared" is exactly what
// reintroduces audible pauses once the user leaves the foreground. Look further
// ahead in the batch queue while hidden so a deeper buffer of already-fetched
// chunks is queued up (bounded by WebAudioPlayer's MAX_PENDING_HIDDEN /
// MAX_AHEAD_SEC_HIDDEN backpressure, which allows scheduling that far ahead in
// the first place) before background throttling can starve it. Sized generously against
// MAX_AHEAD_SEC_HIDDEN (300s): even short (~10s) batches need ~30 in flight
// to fill that window, and each is a small MP3-derived buffer.
const PIPELINE_LOOKAHEAD_HIDDEN = 32;
// If a single playhead batch preparation (fetch + decode) stays pending longer
// than this, log a diagnostic. It is a warning only: the WS layer's own
// per-request timeout + retry guarantees the await eventually settles, so this
// never changes playback behavior — it just makes a slow network visible.
const BATCH_PREPARE_STALL_WARN_MS = 8000;
// REVERTED: an earlier attempt made Android always request this deep
// lookahead (see WebAudioPlayer.ts's comment on the removed
// isMobileBackgroundRiskPlatform) even while visible, to get ahead of
// app-switch throttling. It caused sustained over-fetching against the
// self-hosted Edge TTS relay and broke playback outright (WS timeouts on
// every batch, including the first). Keep this reactive to the actual
// visibility signal only.
const isPageHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const delayUnlessAborted = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    }
    function finish(shouldContinue: boolean) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(shouldContinue);
    }
    function onAbort() {
      finish(false);
    }

    timeoutId = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

interface BatchMarkMeta {
  mark: TTSMark;
  boundaries: TTSWordBoundary[];
  startMediaSec: number;
  durationMediaSec: number;
}

interface ChunkMeta {
  marks: BatchMarkMeta[];
  trimStartSec: number;
  trimmedDurationSec: number;
}

type SpeakQueueEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'chunk-skip'; markName: string }
  | { kind: 'session-end' }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string };

type BatchPrepareResult =
  | {
      kind: 'ready';
      prepared: ChunkMeta & { buffer: TTSAudioBuffer };
      voiceId: string;
      batchIndex: number;
      cacheHit: boolean;
      cacheState: TTSPayloadCacheState;
      boundaryCount: number;
      audioBytes: number;
      fetchMs: number;
      decodeMs: number;
      pcmMs: number;
      totalMs: number;
    }
  | { kind: 'skip'; marks: TTSMark[]; batchIndex: number }
  | { kind: 'fatal'; message: string; batchIndex: number };

class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.#resolvers.shift();
    if (resolve) resolve(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

export class EdgeTTSClient implements TTSClient {
  name = 'edge-tts';
  initialized = false;
  controller?: TTSController;
  appService?: AppService | null;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;
  #pitch = 1.0;

  #edgeTTS: EdgeSpeechTTS | null = null;
  #player = new WebAudioPlayer();
  #activeGeneration: number | null = null;
  #activeQueue: AsyncQueue<SpeakQueueEvent> | null = null;
  #chunkMeta: ChunkMeta[] = [];
  #isPlaying = false;
  #wordTrackingRafId: number | null = null;
  #activeVisualChunkIndex = -1;
  #activeVisualMarkIndex = -1;
  #activeWordIndex = -1;

  constructor(controller?: TTSController, appService?: AppService | null) {
    this.controller = controller;
    this.appService = appService;
  }

  async init(protocol: EDGE_TTS_PROTOCOL = 'wss') {
    this.#edgeTTS = new EdgeSpeechTTS({ protocol, wsTarget: 'self-hosted' });
    this.#voices = EdgeSpeechTTS.voices;
    // Self-hosted WS needs no auth or startup probe. A slow or transient probe
    // must not disable the complete voice list before playback.
    this.initialized = true;
    return this.initialized;
  }

  getPayload = (lang: string, text: string, voiceId: string) => {
    // Speed is rendered server-side via Edge's prosody rate, which changes
    // tempo while preserving pitch. The MP3 cache key includes rate, so each
    // speed keeps its own cached audio. Edge TTS silently caps prosody rate at
    // EDGE_TTS_MAX_RATE; any extra factor is applied via Web Audio playbackRate.
    return {
      lang,
      text: collapseRepeatedPausePunctuation(text),
      voice: voiceId,
      rate: Math.min(this.#rate, EDGE_TTS_MAX_RATE),
      pitch: this.#pitch,
    } as EdgeTTSPayload;
  };

  // Edge renders the MP3 at the prosody rate (≤ EDGE_TTS_MAX_RATE), so its word
  // boundaries live in that sped-up timeline. Scale them back to rate-1.0 media
  // time — the reference frame the player's mediaScale and the section timeline
  // both use.
  #applyRateToBoundaries = (boundaries: TTSWordBoundary[], rate: number): TTSWordBoundary[] => {
    if (rate === 1) return boundaries;
    return boundaries.map((b) => ({ ...b, offset: b.offset * rate, duration: b.duration * rate }));
  };

  // Edge / self-hosted relays fail intermittently (empty audio, 500, timeout).
  // Retry several times; only permanent unspeakable-text no-audio skips early.
  // Each createAudioData call already fails over across the backend pool.
  #createAudioDataWithRetry = async (
    payload: EdgeTTSPayload,
    signal: AbortSignal,
    priority: WsSlotPriority = 'low',
    maxAttempts = 5,
  ): Promise<{ data: ArrayBuffer; boundaries: TTSWordBoundary[] } | undefined> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) return undefined;
      try {
        return await this.#edgeTTS?.createAudioData(payload, signal, priority);
      } catch (err) {
        // An in-flight fetch/WS wait rejects with this exact DOMException when
        // its signal is aborted (see wsAbortError in edgeTTS.ts) — an expected
        // outcome of the caller being superseded (navigation, stop, a newer
        // session), not a real synthesis failure. Logging it as a "failed"
        // warning is misleading (indistinguishable from a genuine server/
        // network error in logs) and needlessly burns a retry-backoff delay
        // for something that will never be retried anyway.
        if (signal.aborted) return undefined;
        // Permanent only for unspeakable text (…… etc.). Speakable "no audio"
        // from a flaky upstream is retryable — do not skip the sentence yet.
        if (isNoAudioSynthesisError(err, payload.text)) throw err;
        lastError = err;
        ttsWarn(
          'fetch-attempt-failed',
          {
            attempt,
            maxAttempts,
            priority,
            textLen: payload.text.length,
          },
          err,
        );
        if (attempt < maxAttempts) {
          const shouldRetry = await delayUnlessAborted(250 * attempt, signal);
          if (!shouldRetry) return undefined;
        }
      }
    }
    throw lastError;
  };

  #recordDurations = (
    voiceId: string,
    text: string,
    boundaries: TTSWordBoundary[],
    trimmedDurationSec?: number,
  ) => {
    if (trimmedDurationSec !== undefined) {
      // Canonical: decode-time trimmed duration; also feeds the per-voice
      // speaking-rate calibration used by timeline estimates.
      recordMeasuredDuration(voiceId, text, trimmedDurationSec);
      calibrateVoiceRate(voiceId, text, trimmedDurationSec);
      return;
    }
    const last = boundaries[boundaries.length - 1];
    if (last) {
      recordProvisionalDuration(voiceId, text, (last.offset + last.duration) / TICKS_PER_SECOND);
    }
  };

  getVoiceIdFromLang = async (lang: string) => {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferredVoice = this.#voices.find(
      (v) => v.id === preferredVoiceId && isSameLang(v.lang, lang),
    );
    if (preferredVoice) return preferredVoice.id;

    const availableVoices = (await this.getVoices(lang))[0]?.voices || [];
    const defaultVoice: TTSVoice | null = availableVoices[0] || null;
    if (defaultVoice?.id === 'en-US-AnaNeural') return 'en-US-AriaNeural'; // avoid using AnaNeural as default
    const currentVoice = this.#voices.find((v) => v.id === this.#currentVoiceId);
    if (defaultVoice) return defaultVoice.id;
    if (currentVoice && isSameLang(currentVoice.lang, lang)) return currentVoice.id;
    return 'en-US-AriaNeural';
  };

  async *speak(ssml: string, signal: AbortSignal, preload = false, startup = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    const speakableMarks = marks.filter((mark) => hasSpeakableText(mark.text));
    yield* this.speakMarks(speakableMarks, signal, preload, startup);
  }

  // Speak or preload an explicit mark list (possibly spanning foliate paragraphs).
  async *speakMarks(
    speakableMarks: TTSMark[],
    signal: AbortSignal,
    preload = false,
    startup = false,
    preloadPriority: WsSlotPriority = 'low',
    preloadAwaitAll = false,
  ) {
    if (preload) {
      yield* this.#preload(speakableMarks, signal, startup, preloadPriority, preloadAwaitAll);
      return;
    }

    if (speakableMarks.length === 0) {
      yield { code: 'end', message: 'Nothing to speak' } as TTSMessageEvent;
      return;
    }

    await this.stopInternal();

    const queue = new AsyncQueue<SpeakQueueEvent>();
    const chunkMeta: ChunkMeta[] = [];
    this.#activeQueue = queue;
    this.#chunkMeta = chunkMeta;

    // startSession before ensureContext: starting a session declares playback
    // intent, clearing any lingering user-pause so the context may resume.
    const generation = this.#player.startSession((event: WebAudioPlayerEvent) => {
      if (event.type === 'chunk-start') {
        queue.push({ kind: 'chunk-start', index: event.chunkIndex });
      } else if (event.type === 'session-end') {
        queue.push({ kind: 'session-end' });
      } else if (event.type === 'audio-interrupted') {
        queue.push({ kind: 'interrupted' });
      } else {
        queue.push({ kind: 'error', message: event.message });
      }
    });
    this.#activeGeneration = generation;
    await this.#player.ensureContext();
    this.#isPlaying = true;
    this.#startPlaybackTracking(generation);

    this.#runScheduler(speakableMarks, signal, generation, queue, chunkMeta, startup);

    let abortHandler: (() => void) | null = null;
    try {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      abortHandler = () => queue.push({ kind: 'error', message: 'Aborted' });
      signal.addEventListener('abort', abortHandler);

      for (;;) {
        const event = await queue.next();
        if (event.kind === 'chunk-start') {
          const meta = chunkMeta[event.index];
          if (!meta) continue;
          // onended is a background-safe fallback, but it can arrive after the
          // audio clock has already crossed the boundary. The rAF tracker uses
          // the same idempotent activation path for foreground accuracy.
          const active = this.#activateVisualMark(generation, event.index);
          yield {
            code: 'boundary',
            message: `Start batch: ${active?.mark.name ?? ''}`,
            mark: active?.mark.name,
          } as TTSMessageEvent;
        } else if (event.kind === 'chunk-skip') {
          yield {
            code: 'end',
            message: `Chunk skipped: ${event.markName}`,
          } as TTSMessageEvent;
        } else if (event.kind === 'session-end') {
          yield { code: 'end', message: 'Speak finished' } as TTSMessageEvent;
          return;
        } else if (event.kind === 'interrupted') {
          yield { code: 'interrupted' } as TTSMessageEvent;
          return;
        } else {
          yield { code: 'error', message: event.message } as TTSMessageEvent;
          return;
        }
      }
    } finally {
      // The controller aborts the signal after every successful paragraph; a
      // lingering listener would push a stale 'Aborted' into a dead queue.
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      this.#stopWordTracking();
      this.#isPlaying = false;
      if (this.#activeGeneration === generation) {
        this.#activeGeneration = null;
        this.#activeQueue = null;
        // Natural paragraph end: session-end is announced up to
        // SESSION_END_EARLY_LEAD_SEC before the last chunk's audio actually
        // finishes, so the tail may still be audible here. Hand the session
        // over (tail keeps playing; the next paragraph's first chunk gets
        // scheduled at its exact end) instead of aborting, which would cut
        // the last words off. Aborts (user stop, error, interruption) never
        // reach the handoff state and stop the audio immediately as before.
        if (!this.#player.finishSessionForHandoff()) {
          this.#player.abortSession();
        }
      }
    }
  }

  // Batches that must be warm before playback starts. Capped at the WS
  // concurrency limit so startup preload does not overload the server.
  #criticalPreloadBatches(batchCount: number): number {
    return Math.min(batchCount, TTS_WS_MAX_CONCURRENT);
  }

  async *#preload(
    marks: TTSMark[],
    signal: AbortSignal,
    startup: boolean,
    priority: WsSlotPriority = 'low',
    awaitAll = false,
  ) {
    // Preload by batch so LRU keys match playback requests. The first
    // TTS_WS_MAX_CONCURRENT batches are warmed before playback; later batches
    // keep filling in a single background worker so long paragraphs do not fall
    // back to playback-time one-by-one synthesis.
    const preloadStartedAt = nowMs();
    const batches = buildBatches(marks, startup);
    const criticalCount = this.#criticalPreloadBatches(batches.length);
    // Startup playback peels the first one or two sentences into separate
    // batches; warming only the first batch let batch 1 miss the playhead once
    // parallel deep prefetch saturated the WS pool — the first lines sounded
    // stuck until a skip restarted the pipeline. Block until the first two
    // startup batches (or all batches when shorter) are cached before release.
    const blockingCount = startup
      ? Math.min(2, criticalCount, batches.length)
      : Math.min(1, criticalCount);
    if (priority === 'high') {
      ttsLog('preload-start', {
        priority,
        startup,
        awaitAll,
        marks: marks.length,
        batches: batches.length,
        blocking: blockingCount,
      });
    }
    const preloadBatch = async (batch: TTSMark[], index: number) => {
      const voiceLang = batch[0]!.language;
      const voiceId = await this.getVoiceIdFromLang(voiceLang);
      this.#currentVoiceId = voiceId;
      const text = batch.map((m) => m.text).join('');
      const payload = this.getPayload(voiceLang, text, voiceId);
      const cacheState = getTTSPayloadCacheState(payload);
      const fetchStartedAt = nowMs();
      const audio = await this.#createAudioDataWithRetry(payload, signal, priority);
      if (!audio) return;
      const fetchMs = elapsedMs(fetchStartedAt);
      if (priority === 'high' || fetchMs > 1000) {
        ttsLog('preload-batch-ready', {
          priority,
          batch: index,
          cacheHit: cacheState === 'ready',
          cacheState,
          fetchMs,
          bytes: audio.data.byteLength,
          boundaries: audio.boundaries.length,
          textLen: text.length,
        });
      }
      const { perMark } = partitionBatch(batch, audio.boundaries);
      for (let i = 0; i < batch.length; i++) {
        const markBoundaries = perMark[i] ?? [];
        const firstOffset = markBoundaries[0]?.offset ?? 0;
        this.#recordDurations(
          voiceId,
          batch[i]!.text,
          this.#applyRateToBoundaries(
            markBoundaries.map((boundary) => ({
              ...boundary,
              offset: boundary.offset - firstOffset,
            })),
            Math.min(this.#rate, EDGE_TTS_MAX_RATE),
          ),
        );
      }
    };
    const runBatch = async (index: number) => {
      if (signal.aborted || index >= batches.length) return;
      try {
        await preloadBatch(batches[index]!, index);
      } catch (err) {
        ttsWarn('preload-batch-error', { batch: index, priority }, err);
      }
    };
    // Only launch the batches we will wait on. Starting the full "critical"
    // window in parallel used to race the playhead's first lines for WS slots
    // (non-blocking critical + deep-prefetch workers), so lines 1–2 stayed cold.
    await Promise.all(Array.from({ length: blockingCount }, (_, index) => runBatch(index)));
    if (priority === 'high') {
      ttsLog('preload-blocking-done', {
        priority,
        ms: elapsedMs(preloadStartedAt),
        blocking: blockingCount,
      });
    }
    // Remaining work (rest of the paragraph, including non-blocking critical)
    // starts after release so opening audio is never delayed by it.
    let nextBackgroundIndex = blockingCount;
    const runBackgroundBatches = async () => {
      // Leave headroom for the playhead's 'high' requests; startup used to
      // spawn one worker per relay and starve the first warm batches.
      const workerCount = Math.min(
        Math.max(1, getEdgeTTSWsMaxConcurrent() - 2),
        Math.max(1, batches.length - nextBackgroundIndex),
      );
      const backgroundWorker = async () => {
        while (!signal.aborted) {
          const index = nextBackgroundIndex++;
          if (index >= batches.length) return;
          await runBatch(index);
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => backgroundWorker()));
    };
    // Deep look-ahead prefetch (awaitAll) must finish every batch of this
    // paragraph before the caller moves to the next one, so the walk truly
    // processes one paragraph at a time. Detaching here is what let each
    // paragraph's remaining batches keep fetching after the walk had already
    // advanced: a 100-paragraph prefetch could pile up hundreds of concurrent
    // low-priority fetches, saturate the shared WS slots, and starve the
    // playhead until playback wedged ("stuck after the current sentence
    // finished"). The current-paragraph startup preload keeps detaching
    // (awaitAll === false) so first audio is never delayed by later batches.
    if (awaitAll) {
      await runBackgroundBatches();
    } else {
      void runBackgroundBatches();
    }
    yield {
      code: 'end',
      message: 'Preload finished',
    } as TTSMessageEvent;
  }

  // Fetch, decode, and compress one batch. The scheduler keeps at most
  // TTS_WS_MAX_CONCURRENT preparations in flight while earlier chunks play.
  async #prepareBatchForSchedule(
    batch: TTSMark[],
    batchIndex: number,
    signal: AbortSignal,
    generation: number,
    rate: number,
    webAudioRate: number,
  ): Promise<BatchPrepareResult> {
    const totalStartedAt = nowMs();
    if (signal.aborted || this.#activeGeneration !== generation) {
      return { kind: 'skip', marks: batch, batchIndex };
    }
    const voiceLang = batch[0]!.language;
    const voiceId = await this.getVoiceIdFromLang(voiceLang);
    if (signal.aborted || this.#activeGeneration !== generation) {
      return { kind: 'skip', marks: batch, batchIndex };
    }
    this.#speakingLang = voiceLang;
    this.#currentVoiceId = voiceId;
    const batchText = batch.map((m) => m.text).join('');
    if (!hasSpeakableText(batchText)) {
      return { kind: 'skip', marks: batch, batchIndex };
    }
    const payload = this.getPayload(voiceLang, batchText, voiceId);
    const cacheState = getTTSPayloadCacheState(payload);

    let audio: { data: ArrayBuffer; boundaries: TTSWordBoundary[] } | undefined;
    let fetchMs = 0;
    try {
      // 'high': this batch is on the imminent-playback critical path, so it
      // must not queue behind background paragraph prefetch for the same WS
      // slots — that contention was a real source of the audible gaps this
      // pipeline exists to remove.
      const fetchStartedAt = nowMs();
      audio = await this.#createAudioDataWithRetry(payload, signal, 'high');
      fetchMs = elapsedMs(fetchStartedAt);
    } catch (error) {
      // Permanent unspeakable no-audio, OR speakable empty-audio that still
      // failed after retries: skip the batch so the session can continue
      // (do not wedge/kill the whole TTS run on one bad sentence).
      if (isNoAudioSynthesisError(error, batchText) || isEmptyAudioError(error)) {
        ttsWarn('batch-no-audio', {
          gen: generation,
          batch: batchIndex,
          textLen: batchText.length,
        });
        return { kind: 'skip', marks: batch, batchIndex };
      }
      const message = error instanceof Error ? error.message : String(error);
      ttsWarn('batch-fetch-fatal', {
        gen: generation,
        batch: batchIndex,
        textLen: batchText.length,
        message,
      });
      return { kind: 'fatal', message, batchIndex };
    }
    if (!audio || signal.aborted || this.#activeGeneration !== generation) {
      return { kind: 'skip', marks: batch, batchIndex };
    }
    const audioBytes = audio.data.byteLength;

    let decoded: TTSAudioBuffer;
    let decodeMs = 0;
    try {
      const decodeStartedAt = nowMs();
      decoded = await this.#player.decode(audio.data);
      decodeMs = elapsedMs(decodeStartedAt);
    } catch (error) {
      ttsWarn(
        'batch-decode-failed',
        { gen: generation, batch: batchIndex, bytes: audioBytes },
        error,
      );
      return { kind: 'skip', marks: batch, batchIndex };
    }

    let prepared: ChunkMeta & { buffer: TTSAudioBuffer };
    let pcmMs = 0;
    try {
      const pcmStartedAt = nowMs();
      prepared = await this.#prepareBatchBuffer(
        decoded,
        batch,
        audio.boundaries,
        rate,
        webAudioRate,
      );
      pcmMs = elapsedMs(pcmStartedAt);
    } catch (error) {
      ttsWarn('batch-pcm-failed', { gen: generation, batch: batchIndex, bytes: audioBytes }, error);
      return { kind: 'skip', marks: batch, batchIndex };
    }

    return {
      kind: 'ready',
      prepared,
      voiceId,
      batchIndex,
      cacheHit: cacheState === 'ready',
      cacheState,
      boundaryCount: audio.boundaries.length,
      audioBytes,
      fetchMs,
      decodeMs,
      pcmMs,
      totalMs: elapsedMs(totalStartedAt),
    };
  }

  // Detached scheduler: pipelines batch preparation across the mark list, then
  // schedules in order under the player's backpressure. Never throws; failures
  // surface through the event queue.
  async #runScheduler(
    marks: TTSMark[],
    signal: AbortSignal,
    generation: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: ChunkMeta[],
    startup: boolean,
  ): Promise<void> {
    const edgeRate = Math.min(this.#rate, EDGE_TTS_MAX_RATE);
    const webAudioRate = this.#rate / edgeRate;
    const finishSession = () => {
      if (!signal.aborted && this.#activeGeneration === generation) {
        this.#player.endSession(generation);
      }
    };
    // Backgrounding can happen mid-batch, i.e. while the loop below is
    // parked on `await preparations[batchIndex]`, which would otherwise
    // leave the deeper hidden lookahead unapplied until that await resolves
    // and the loop reaches its next per-iteration check — exactly the
    // narrow window where a batch already slow from throttling most needs
    // the wider buffer. React to the transition immediately instead.
    let onVisibilityChange: (() => void) | undefined;
    try {
      const batches = buildBatches(marks, startup);
      const preparations: Array<Promise<BatchPrepareResult>> = new Array(batches.length);
      let started = 0;
      const startPreparationsThrough = (throughIndex: number) => {
        const limit = Math.min(throughIndex, batches.length - 1);
        while (started <= limit) {
          const batchIndex = started++;
          preparations[batchIndex] = this.#prepareBatchForSchedule(
            batches[batchIndex]!,
            batchIndex,
            signal,
            generation,
            edgeRate,
            webAudioRate,
          );
        }
      };
      if (typeof document !== 'undefined') {
        onVisibilityChange = () => {
          if (isPageHidden()) {
            startPreparationsThrough(started + PIPELINE_LOOKAHEAD_HIDDEN - 1);
          }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        // Re-checked every iteration: backgrounding can happen mid-playback,
        // and the deeper lookahead should kick in immediately rather than
        // waiting for the session to restart.
        const lookahead = isPageHidden() ? PIPELINE_LOOKAHEAD_HIDDEN : PIPELINE_LOOKAHEAD_VISIBLE;
        startPreparationsThrough(batchIndex + lookahead - 1);
        if (signal.aborted || this.#activeGeneration !== generation) break;
        // Observability watchdog: the playhead batch is fetched at 'high'
        // priority against a reserved WS slot, and every fetch has its own hard
        // timeout (WS_REQUEST_TIMEOUT_MS) with a bounded retry, so this await
        // cannot hang forever. If it still takes unexpectedly long the network
        // (not the client) is the bottleneck — surface it instead of silently
        // stalling, which is what makes "playback froze" diagnosable in logs.
        const stallTimer = setTimeout(() => {
          ttsWarn('batch-prepare-stall', {
            gen: generation,
            batch: batchIndex,
            waitMs: BATCH_PREPARE_STALL_WARN_MS,
            hidden: isPageHidden(),
          });
        }, BATCH_PREPARE_STALL_WARN_MS);
        let result: BatchPrepareResult;
        try {
          result = await preparations[batchIndex]!;
        } finally {
          clearTimeout(stallTimer);
        }
        if (result.kind === 'fatal') {
          queue.push({ kind: 'error', message: result.message });
          return;
        }
        if (result.kind === 'skip') {
          for (const mark of result.marks) {
            queue.push({ kind: 'chunk-skip', markName: mark.name });
          }
          continue;
        }

        for (const markMeta of result.prepared.marks) {
          this.#recordDurations(
            result.voiceId,
            markMeta.mark.text,
            markMeta.boundaries,
            markMeta.durationMediaSec,
          );
        }

        const waitReadyStartedAt = nowMs();
        const ready = await this.#player.waitUntilReady(generation);
        const waitReadyMs = elapsedMs(waitReadyStartedAt);
        if (!ready || signal.aborted || this.#activeGeneration !== generation) break;

        ttsLog('batch-ready', {
          gen: generation,
          batch: result.batchIndex,
          cacheHit: result.cacheHit,
          cacheState: result.cacheState,
          bytes: result.audioBytes,
          fetchMs: result.fetchMs,
          decodeMs: result.decodeMs,
          pcmMs: result.pcmMs,
          totalMs: result.totalMs,
          waitReadyMs,
          boundaries: result.boundaryCount,
          marks: result.prepared.marks.length,
          durMs: result.prepared.trimmedDurationSec * 1000,
          hidden: isPageHidden(),
        });

        chunkMeta.push({
          marks: result.prepared.marks,
          trimStartSec: result.prepared.trimStartSec,
          trimmedDurationSec: result.prepared.trimmedDurationSec,
        });
        // The buffer's samples are already tempo-shifted by `webAudioRate`
        // (see #prepareBatchBuffer), via pitch-preserving WSOLA rather than
        // AudioBufferSourceNode.playbackRate — a naive resample-based rate
        // change, which is what produced the sped-up, pitch-distorted
        // "chipmunk"/Minions voice for rates above EDGE_TTS_MAX_RATE. Its
        // duration is therefore already correct in real time, so mediaScale
        // needs no extra correction here.
        this.#player.scheduleChunk(generation, result.prepared.buffer, {
          trimStartSec: result.prepared.trimStartSec,
          mediaScale: result.prepared.trimmedDurationSec / result.prepared.buffer.duration,
          gapSec: 0,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    } finally {
      if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
      finishSession();
    }
  }

  async #prepareBatchBuffer(
    decoded: TTSAudioBuffer,
    batch: TTSMark[],
    rawBoundaries: TTSWordBoundary[],
    rate: number,
    webAudioRate: number,
  ): Promise<ChunkMeta & { buffer: TTSAudioBuffer }> {
    const sampleRate = decoded.sampleRate;
    const channel = decoded.getChannelData(0);
    let trimStartRawSec: number;
    let trimEndRawSec: number;
    if (rawBoundaries.length > 0) {
      const first = rawBoundaries[0]!;
      const last = rawBoundaries[rawBoundaries.length - 1]!;
      const keepRawSec = BATCH_EDGE_KEEP_SEC / rate;
      trimStartRawSec = Math.max(0, first.offset / TICKS_PER_SECOND - keepRawSec);
      trimEndRawSec = Math.min(
        decoded.duration,
        (last.offset + last.duration) / TICKS_PER_SECOND + keepRawSec,
      );
    } else {
      const bounds = findSpeechBounds(channel, sampleRate);
      trimStartRawSec = bounds.startSec;
      trimEndRawSec = bounds.endSec;
    }

    const startSample = Math.max(0, Math.floor(trimStartRawSec * sampleRate));
    const endSample = Math.min(
      decoded.length,
      Math.max(startSample + 1, Math.ceil(trimEndRawSec * sampleRate)),
    );
    const trimmed = channel.subarray(startSample, endSample);

    if (rawBoundaries.length === 0) {
      return this.#prepareBatchWithoutBoundaries(trimmed, batch, sampleRate, rate, webAudioRate);
    }

    const { perMark: perMarkRaw } = partitionBatch(batch, rawBoundaries);
    const sentenceEndWordIndices = this.#sentenceEndWordIndices(batch, perMarkRaw);

    const secToSamples = (sec: number) => Math.round(sec * sampleRate);
    const wordStarts = rawBoundaries.map(
      (b) => Math.floor((b.offset / TICKS_PER_SECOND) * sampleRate) - startSample,
    );
    const wordEnds = rawBoundaries.map(
      (b) => Math.ceil(((b.offset + b.duration) / TICKS_PER_SECOND) * sampleRate) - startSample,
    );
    const plan = planSilenceCompression(
      wordStarts,
      wordEnds,
      rawBoundaries.map((b) => b.text),
      trimmed.length,
      secToSamples(EDGE_KEEP_SEC / rate),
      secToSamples(TRAILING_KEEP_SEC / rate),
      secToSamples(MIN_COMPRESS_GAP_SEC / rate),
      secToSamples(SHORT_PAUSE_SEC / rate),
      secToSamples(LONG_PAUSE_SEC / rate),
      sentenceEndWordIndices,
    );

    const out = new Float32Array(plan.outLength);
    let write = 0;
    for (const [s, e] of plan.segments) {
      const seg = trimmed.subarray(Math.max(0, s), Math.min(trimmed.length, e));
      out.set(seg, write);
      write += seg.length;
    }
    // Rates above EDGE_TTS_MAX_RATE need extra speed beyond what Edge's
    // pitch-preserving prosody already rendered. Applying that via
    // AudioBufferSourceNode.playbackRate would resample the audio — changing
    // pitch along with tempo, which is exactly the sped-up, "chipmunk"/Minions
    // voice this stretch avoids by re-laying waveform frames at a different
    // spacing instead (see timeStretch.ts).
    const finalSamples = webAudioRate !== 1 ? timeStretch(out, sampleRate, webAudioRate) : out;
    const buffer = await this.#player.createMonoBuffer(finalSamples, sampleRate);
    const trimmedDurationSec = (plan.outLength / sampleRate) * rate;

    const remappedBoundaries = rawBoundaries.map((b, i) => ({
      ...b,
      offset: (plan.wordStartsOut[i]! / sampleRate) * TICKS_PER_SECOND,
    }));
    const { perMark } = partitionBatch(batch, remappedBoundaries);
    const totalChars = Math.max(
      1,
      batch.reduce((sum, mark) => sum + mark.text.length, 0),
    );
    let charsBefore = 0;
    const starts = batch.map((mark, index) => {
      const exact = perMark[index]?.[0];
      const fallback = (trimmedDurationSec * charsBefore) / totalChars;
      charsBefore += mark.text.length;
      const start = exact ? (exact.offset / TICKS_PER_SECOND) * rate : fallback;
      return Math.min(Math.max(start, 0), trimmedDurationSec);
    });
    for (let i = 1; i < starts.length; i++) {
      starts[i] = Math.max(starts[i]!, starts[i - 1]!);
    }

    const marks = batch.map((mark, index): BatchMarkMeta => {
      const startMediaSec = starts[index]!;
      const endMediaSec = starts[index + 1] ?? trimmedDurationSec;
      return {
        mark,
        boundaries: this.#applyRateToBoundaries(perMark[index] ?? [], rate),
        startMediaSec,
        durationMediaSec: Math.max(0, endMediaSec - startMediaSec),
      };
    });

    return { buffer, marks, trimStartSec: 0, trimmedDurationSec };
  }

  #sentenceEndWordIndices(batch: TTSMark[], perMarkRaw: TTSWordBoundary[][]): Set<number> {
    const indices = new Set<number>();
    let wordIndex = 0;
    for (let markIndex = 0; markIndex < batch.length - 1; markIndex++) {
      const count = perMarkRaw[markIndex]!.length;
      if (count > 0) {
        indices.add(wordIndex + count - 1);
        wordIndex += count;
      } else if (/[.!?。！？]["'»」』)\]""']*$/u.test(batch[markIndex]!.text.trimEnd())) {
        if (wordIndex > 0) indices.add(wordIndex - 1);
      }
    }
    return indices;
  }

  // Edge occasionally returns no word boundaries. Compress inter-mark silences
  // using char-proportional pseudo slots so batch-internal pauses are still removed.
  async #prepareBatchWithoutBoundaries(
    trimmed: Float32Array,
    batch: TTSMark[],
    sampleRate: number,
    rate: number,
    webAudioRate: number,
  ): Promise<ChunkMeta & { buffer: TTSAudioBuffer }> {
    const totalChars = Math.max(
      1,
      batch.reduce((sum, mark) => sum + mark.text.length, 0),
    );

    if (batch.length === 1) {
      const finalSamples =
        webAudioRate !== 1 ? timeStretch(trimmed, sampleRate, webAudioRate) : trimmed;
      const buffer = await this.#player.createMonoBuffer(finalSamples, sampleRate);
      const trimmedDurationSec = (trimmed.length / sampleRate) * rate;
      return {
        buffer,
        marks: [
          {
            mark: batch[0]!,
            boundaries: [],
            startMediaSec: 0,
            durationMediaSec: trimmedDurationSec,
          },
        ],
        trimStartSec: 0,
        trimmedDurationSec,
      };
    }

    const sentenceEndWordIndices = new Set<number>();
    const wordStarts: number[] = [];
    const wordEnds: number[] = [];
    const wordTexts: string[] = [];
    let charsBefore = 0;
    for (let i = 0; i < batch.length; i++) {
      const start = Math.floor((charsBefore / totalChars) * trimmed.length);
      charsBefore += batch[i]!.text.length;
      const end =
        i + 1 < batch.length
          ? Math.floor((charsBefore / totalChars) * trimmed.length)
          : trimmed.length;
      wordStarts.push(start);
      wordEnds.push(Math.max(start + 1, end));
      wordTexts.push(batch[i]!.text);
      if (i < batch.length - 1) sentenceEndWordIndices.add(i);
    }

    const secToSamples = (sec: number) => Math.round(sec * sampleRate);
    const plan = planSilenceCompression(
      wordStarts,
      wordEnds,
      wordTexts,
      trimmed.length,
      secToSamples(EDGE_KEEP_SEC / rate),
      secToSamples(TRAILING_KEEP_SEC / rate),
      secToSamples(MIN_COMPRESS_GAP_SEC / rate),
      secToSamples(SHORT_PAUSE_SEC / rate),
      secToSamples(LONG_PAUSE_SEC / rate),
      sentenceEndWordIndices,
    );

    const out = new Float32Array(plan.outLength);
    let write = 0;
    for (const [s, e] of plan.segments) {
      const seg = trimmed.subarray(Math.max(0, s), Math.min(trimmed.length, e));
      out.set(seg, write);
      write += seg.length;
    }
    const finalSamples = webAudioRate !== 1 ? timeStretch(out, sampleRate, webAudioRate) : out;
    const buffer = await this.#player.createMonoBuffer(finalSamples, sampleRate);
    const trimmedDurationSec = (plan.outLength / sampleRate) * rate;

    charsBefore = 0;
    const starts = batch.map((mark) => {
      const start = (trimmedDurationSec * charsBefore) / totalChars;
      charsBefore += mark.text.length;
      return start;
    });
    for (let i = 1; i < starts.length; i++) {
      starts[i] = Math.max(starts[i]!, starts[i - 1]!);
    }

    const marks = batch.map((mark, index): BatchMarkMeta => {
      const startMediaSec = starts[index]!;
      const endMediaSec = starts[index + 1] ?? trimmedDurationSec;
      return {
        mark,
        boundaries: [],
        startMediaSec,
        durationMediaSec: Math.max(0, endMediaSec - startMediaSec),
      };
    });

    return { buffer, marks, trimStartSec: 0, trimmedDurationSec };
  }

  #findMarkAtTime(
    meta: ChunkMeta,
    mediaTimeSec: number,
  ): { meta: BatchMarkMeta; index: number } | null {
    if (meta.marks.length === 0) return null;
    let index = 0;
    for (let i = 1; i < meta.marks.length; i++) {
      if (meta.marks[i]!.startMediaSec <= mediaTimeSec) index = i;
      else break;
    }
    return { meta: meta.marks[index]!, index };
  }

  #activateVisualMark(
    generation: number,
    chunkIndex: number,
    mediaTimeSec?: number,
  ): BatchMarkMeta | null {
    if (this.#activeGeneration !== generation) return null;
    const chunk = this.#chunkMeta[chunkIndex];
    if (!chunk) return null;
    if (mediaTimeSec === undefined) {
      mediaTimeSec =
        this.#player.getPlaybackPosition(generation)?.mediaTimeSec ?? chunk.trimStartSec;
    }
    const active = this.#findMarkAtTime(chunk, mediaTimeSec);
    if (!active) return null;
    if (
      this.#activeVisualChunkIndex !== chunkIndex ||
      this.#activeVisualMarkIndex !== active.index
    ) {
      this.#activeVisualChunkIndex = chunkIndex;
      this.#activeVisualMarkIndex = active.index;
      this.#activeWordIndex = -1;
      this.controller?.dispatchSpeakMark(active.meta.mark);
      this.controller?.prepareSpeakWords(active.meta.boundaries.map((boundary) => boundary.text));
    }
    return active.meta;
  }

  // Poll the authoritative audio clock for both sentence and word progress.
  // `AudioBufferSourceNode.onended` remains the fallback when rAF is throttled,
  // but foreground UI no longer waits for a delayed callback after the next
  // already-scheduled chunk has become audible.
  #startPlaybackTracking(generation: number): void {
    this.#stopWordTracking();
    this.#activeVisualChunkIndex = -1;
    this.#activeVisualMarkIndex = -1;
    this.#activeWordIndex = -1;
    const controller = this.controller;
    const tick = () => {
      if (this.#activeGeneration !== generation) return;
      const pos = this.#player.getPlaybackPosition(generation);
      if (pos) {
        const markMeta = this.#activateVisualMark(generation, pos.chunkIndex, pos.mediaTimeSec);
        if (controller && markMeta?.boundaries.length) {
          const index = findBoundaryIndexAtTime(markMeta.boundaries, pos.mediaTimeSec);
          if (index !== this.#activeWordIndex && index >= 0) {
            this.#activeWordIndex = index;
            controller.dispatchSpeakWord(index);
          }
        }
      }
      this.#wordTrackingRafId = requestAnimationFrame(tick);
    };
    this.#wordTrackingRafId = requestAnimationFrame(tick);
  }

  #stopWordTracking(): void {
    if (this.#wordTrackingRafId !== null) {
      cancelAnimationFrame(this.#wordTrackingRafId);
      this.#wordTrackingRafId = null;
    }
  }

  async pause() {
    if (!this.#isPlaying) return true;
    await this.#player.pauseContext();
    return true;
  }

  async resume() {
    // Throws when the context refuses to run again (iOS post-interruption);
    // the controller's catch stops playback visibly instead of showing
    // "playing" over silence.
    await this.#player.resumeContext();
    return true;
  }

  async stop() {
    await this.stopInternal();
  }

  private async stopInternal() {
    this.#stopWordTracking();
    this.#activeVisualChunkIndex = -1;
    this.#activeVisualMarkIndex = -1;
    this.#activeWordIndex = -1;
    this.#isPlaying = false;
    if (this.#activeGeneration !== null) {
      this.#activeGeneration = null;
      // Unblock a generator awaiting the queue; without this a stop() outside
      // the abort path would leave the consumer parked forever.
      this.#activeQueue?.push({ kind: 'error', message: 'Aborted' });
      this.#activeQueue = null;
      this.#player.abortSession();
    }
  }

  getPlaybackSnapshot(): { mark: TTSMark; position: number } | null {
    const generation = this.#activeGeneration;
    if (generation === null) return null;
    const pos = this.#player.getPlaybackPosition(generation);
    if (!pos) return null;
    const chunk = this.#chunkMeta[pos.chunkIndex];
    if (!chunk) return null;
    const markMeta = this.#findMarkAtTime(chunk, pos.mediaTimeSec)?.meta;
    if (!markMeta) return null;
    return {
      mark: markMeta.mark,
      position: Math.min(
        Math.max(pos.mediaTimeSec - markMeta.startMediaSec, 0),
        markMeta.durationMediaSec,
      ),
    };
  }

  // Compatibility surfaces for non-atomic callers.
  getCurrentSpeakMark(): TTSMark | null {
    return this.getPlaybackSnapshot()?.mark ?? null;
  }

  getChunkPosition(): number | null {
    return this.getPlaybackSnapshot()?.position ?? null;
  }

  async setRate(rate: number) {
    // Rendered server-side via Edge's prosody rate (pitch-preserving); takes
    // effect on the next speak() session (the controller restarts playback on
    // rate changes).
    this.#rate = rate;
  }

  async setPitch(pitch: number) {
    // The Edge TTS API uses pitch in [0.5 .. 1.5].
    this.#pitch = pitch;
  }

  async setVoice(voice: string) {
    const selectedVoice = this.#voices.find((v) => v.id === voice);
    if (selectedVoice) {
      this.#currentVoiceId = selectedVoice.id;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    this.#voices.forEach((voice) => {
      voice.disabled = !this.initialized;
    });
    return this.#voices;
  }

  async getVoices(lang: string) {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = await this.getAllVoices();
    // Match by primary language so the voice set stays the same across a book
    // whose sections mix region variants (e.g. en-US front matter and en-GB
    // body text); the requested locale's voices sort first. See #4033.
    const filteredVoices = voices.filter((v) => isSameLang(v.lang, lang));

    const voicesGroup: TTSVoicesGroup = {
      id: 'edge-tts',
      name: 'Edge TTS',
      voices: filteredVoices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
      disabled: !this.initialized || filteredVoices.length === 0,
    };

    return [voicesGroup];
  }

  setPrimaryLang(lang: string) {
    this.#primaryLang = lang;
  }

  supportsWordBoundaries(): boolean {
    return true;
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    await this.stopInternal();
    await this.#player.shutdown();
    this.initialized = false;
    this.#voices = [];
  }
}
