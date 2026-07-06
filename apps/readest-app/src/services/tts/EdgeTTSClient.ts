import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import {
  EdgeSpeechTTS,
  EdgeTTSPayload,
  EDGE_TTS_PROTOCOL,
  hasTTSPrefetchCapacity,
  TTSWordBoundary,
} from '@/libs/edgeTTS';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import { hasSpeakableText, isNoAudioSynthesisError, parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { findBoundaryIndexAtTime } from './wordHighlight';
import {
  LONG_PAUSE_SEC,
  MIN_COMPRESS_GAP_SEC,
  SHORT_PAUSE_SEC,
  findSpeechBounds,
  planSilenceCompression,
} from './pcm';
import {
  calibrateVoiceRate,
  recordMeasuredDuration,
  recordProvisionalDuration,
} from './ttsDuration';
import {
  buildBatches,
  markSliceRangeSec,
  markSpeechEndSec,
  partitionBatch,
  rebaseBoundaries,
} from './ttsBatch';
import { TTSAudioBuffer, WebAudioPlayer, WebAudioPlayerEvent } from './WebAudioPlayer';

// Playback pipeline: group sentence marks into Edge requests of up to ~120
// chars (first request smaller for fast startup) -> fetch MP3 (rendered at the
// playback rate via Edge's prosody rate, cached per combined text) -> decode
// once per batch -> per-mark slice -> compress inter-word silences -> schedule
// gaplessly on the shared AudioContext. Marks within a batch share one mp3;
// each sentence chunk gets a fixed client-side gap after its trimmed speech
// (Edge's variable inter-sentence tail is cut off the slice). Marks dispatch
// when a chunk becomes AUDIBLE (chunk-start rides source onended), not at fetch.

// Fixed pause at every sentence/line chunk boundary (foliate splits at 。？！
// and block/line breaks). Matches LONG_PAUSE_SEC so period/newline pacing
// equals in-chunk sentence enders; scaled by playback rate (#2033).
const INTER_SENTENCE_GAP_SEC = LONG_PAUSE_SEC;
// Keep this much audio past the first/last word when trimming a chunk's edges,
// so word onsets/releases are not clipped (not Edge's baked sentence tail).
const EDGE_KEEP_SEC = 0.02;
const TRAILING_KEEP_SEC = 0.01;
const TICKS_PER_SECOND = 10_000_000;

interface ChunkMeta {
  mark: TTSMark;
  boundaries: TTSWordBoundary[];
  trimStartSec: number;
  trimmedDurationSec: number;
}

type SpeakQueueEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'chunk-skip'; markName: string }
  | { kind: 'session-end' }
  | { kind: 'error'; message: string };

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

  constructor(controller?: TTSController, appService?: AppService | null) {
    this.controller = controller;
    this.appService = appService;
  }

  async init(protocol: EDGE_TTS_PROTOCOL = 'https') {
    this.#edgeTTS = new EdgeSpeechTTS(protocol);
    this.#voices = EdgeSpeechTTS.voices;
    // The self-hosted HTTPS service needs no auth or startup probe. A slow or
    // transient probe must not disable the complete voice list before playback.
    this.initialized = true;
    return this.initialized;
  }

  getPayload = (lang: string, text: string, voiceId: string) => {
    // Speed is rendered server-side via Edge's prosody rate, which changes
    // tempo while preserving pitch. Applying it here instead of via a
    // client-side time-stretch avoids the "warble"/fan artifact that
    // overlap-add resampling produces. The MP3 cache key includes rate, so
    // each speed keeps its own cached audio.
    return { lang, text, voice: voiceId, rate: this.#rate, pitch: this.#pitch } as EdgeTTSPayload;
  };

  // Edge renders the MP3 at the playback rate (prosody rate), so its word
  // boundaries live in that sped-up timeline. Scale them back to rate-1.0 media
  // time — the reference frame the player's mediaScale and the section timeline
  // both use.
  #applyRateToBoundaries = (boundaries: TTSWordBoundary[]): TTSWordBoundary[] => {
    const rate = this.#rate;
    if (rate === 1) return boundaries;
    return boundaries.map((b) => ({ ...b, offset: b.offset * rate, duration: b.duration * rate }));
  };

  // Edge TTS websocket requests fail intermittently; retry a few times before
  // giving up so a single transient failure doesn't stall playback. The
  // "No audio data received." failure is permanent for a given sentence, so it
  // rethrows immediately for the caller's skip path.
  #createAudioDataWithRetry = async (
    payload: EdgeTTSPayload,
    signal: AbortSignal,
    maxAttempts = 3,
  ): Promise<{ data: ArrayBuffer; boundaries: TTSWordBoundary[] } | undefined> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) return undefined;
      try {
        return await this.#edgeTTS?.createAudioData(payload);
      } catch (err) {
        if (isNoAudioSynthesisError(err)) throw err;
        lastError = err;
        console.warn(`Edge TTS fetch attempt ${attempt}/${maxAttempts} failed`, err);
        if (attempt < maxAttempts && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
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
    const preferredVoice = this.#voices.find((v) => v.id === preferredVoiceId);
    if (preferredVoice) return preferredVoice.id;

    const availableVoices = (await this.getVoices(lang))[0]?.voices || [];
    const defaultVoice: TTSVoice | null = availableVoices[0] || null;
    if (defaultVoice?.id === 'en-US-AnaNeural') return 'en-US-AriaNeural'; // avoid using AnaNeural as default
    return defaultVoice?.id || this.#currentVoiceId || 'en-US-AriaNeural';
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
  ) {
    if (preload) {
      yield* this.#preload(speakableMarks, signal, startup);
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
      } else {
        queue.push({ kind: 'error', message: event.message });
      }
    });
    this.#activeGeneration = generation;
    await this.#player.ensureContext();
    this.#isPlaying = true;

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
          this.controller?.dispatchSpeakMark(meta.mark);
          this.#startWordTracking(generation, event.index, meta);
          yield {
            code: 'boundary',
            message: `Start chunk: ${meta.mark.name}`,
            mark: meta.mark.name,
          } as TTSMessageEvent;
        } else if (event.kind === 'chunk-skip') {
          yield {
            code: 'end',
            message: `Chunk skipped: ${event.markName}`,
          } as TTSMessageEvent;
        } else if (event.kind === 'session-end') {
          yield { code: 'end', message: 'Speak finished' } as TTSMessageEvent;
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
        this.#player.abortSession();
      }
    }
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal, startup: boolean) {
    // Preload by batch so LRU keys match playback requests. On startup block on
    // one small batch; otherwise prefetch two batches before background fill.
    // Stop once the shared LRU holds ~5 minutes of audio; playback resuming
    // after a block will top it up again via preloadNextSSML.
    const batches = buildBatches(marks, startup);
    const maxImmediate = startup ? 1 : 2;
    const preloadBatch = async (batch: TTSMark[]) => {
      if (!hasTTSPrefetchCapacity()) return;
      const voiceLang = batch[0]!.language;
      const voiceId = await this.getVoiceIdFromLang(voiceLang);
      this.#currentVoiceId = voiceId;
      const text = batch.map((m) => m.text).join('');
      const audio = await this.#createAudioDataWithRetry(
        this.getPayload(voiceLang, text, voiceId),
        signal,
      );
      if (!audio) return;
      const { perMark } = partitionBatch(batch, audio.boundaries);
      for (let i = 0; i < batch.length; i++) {
        this.#recordDurations(
          voiceId,
          batch[i]!.text,
          this.#applyRateToBoundaries(perMark[i] ?? []),
        );
      }
    };
    for (let i = 0; i < Math.min(maxImmediate, batches.length); i++) {
      if (signal.aborted) break;
      try {
        await preloadBatch(batches[i]!);
      } catch (err) {
        console.warn('Error preloading batch', i, err);
      }
    }
    if (batches.length > maxImmediate) {
      (async () => {
        for (let i = maxImmediate; i < batches.length; i++) {
          if (signal.aborted || !hasTTSPrefetchCapacity()) break;
          try {
            await preloadBatch(batches[i]!);
          } catch (err) {
            console.warn('Error preloading batch (bg)', i, err);
          }
        }
      })();
    }

    yield {
      code: 'end',
      message: 'Preload finished',
    } as TTSMessageEvent;
  }

  // Detached scheduler: fetches, prepares, and schedules chunks ahead of the
  // playhead under the player's backpressure. Never throws; failures surface
  // through the event queue.
  async #runScheduler(
    marks: TTSMark[],
    signal: AbortSignal,
    generation: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: ChunkMeta[],
    startup: boolean,
  ): Promise<void> {
    const rate = this.#rate;
    const finishSession = () => {
      if (!signal.aborted && this.#activeGeneration === generation) {
        this.#player.endSession(generation);
      }
    };
    try {
      const batches = buildBatches(marks, startup);
      batchLoop: for (const batch of batches) {
        if (signal.aborted || this.#activeGeneration !== generation) break batchLoop;
        const voiceLang = batch[0]!.language;
        const voiceId = await this.getVoiceIdFromLang(voiceLang);
        this.#speakingLang = voiceLang;
        this.#currentVoiceId = voiceId;
        const batchText = batch.map((m) => m.text).join('');
        if (!hasSpeakableText(batchText)) {
          for (const mark of batch) queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }
        const payload = this.getPayload(voiceLang, batchText, voiceId);

        let audio: { data: ArrayBuffer; boundaries: TTSWordBoundary[] } | undefined;
        try {
          audio = await this.#createAudioDataWithRetry(payload, signal);
        } catch (error) {
          if (isNoAudioSynthesisError(error, batchText)) {
            console.warn('No audio data received for:', batchText);
            for (const mark of batch) queue.push({ kind: 'chunk-skip', markName: mark.name });
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          console.warn('TTS error for batch:', batchText, message);
          queue.push({ kind: 'error', message });
          return;
        }
        if (!audio || signal.aborted || this.#activeGeneration !== generation) break batchLoop;

        let decoded: TTSAudioBuffer;
        try {
          decoded = await this.#player.decode(audio.data);
        } catch (error) {
          console.warn('Failed to decode TTS audio for:', batchText, error);
          for (const mark of batch) queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }

        // Boundaries from Edge live in the decoded MP3 timeline (prosody rate).
        const bufferBoundaries = audio.boundaries;
        const { perMark, startSec } = partitionBatch(batch, bufferBoundaries);

        for (let mi = 0; mi < batch.length; mi++) {
          if (signal.aborted || this.#activeGeneration !== generation) break batchLoop;
          const mark = batch[mi]!;
          const { startSec: sliceStart, endSec: sliceEndRaw } = markSliceRangeSec(
            batch,
            startSec,
            mi,
            decoded.duration,
          );
          const markBoundariesRaw = perMark[mi] ?? [];
          const sliceEnd = markSpeechEndSec(
            markBoundariesRaw,
            sliceEndRaw,
            TRAILING_KEEP_SEC / rate,
          );
          const sampleRate = decoded.sampleRate;
          const startSample = Math.floor(sliceStart * sampleRate);
          const endSample = Math.min(
            decoded.length,
            Math.max(startSample + 1, Math.ceil(sliceEnd * sampleRate)),
          );
          const slice = decoded.getChannelData(0).subarray(startSample, endSample);
          const markBoundaries = rebaseBoundaries(markBoundariesRaw, sliceStart);

          let prepared: {
            buffer: TTSAudioBuffer;
            boundaries: TTSWordBoundary[];
            trimStartSec: number;
            trimmedDurationSec: number;
          };
          try {
            prepared = await this.#prepareSamplesBuffer(slice, sampleRate, markBoundaries, rate);
          } catch (error) {
            console.warn('Failed to prepare TTS audio for:', mark.text, error);
            queue.push({ kind: 'chunk-skip', markName: mark.name });
            continue;
          }

          const boundaries = this.#applyRateToBoundaries(prepared.boundaries);
          this.#recordDurations(voiceId, mark.text, boundaries, prepared.trimmedDurationSec);

          const ready = await this.#player.waitUntilReady(generation);
          if (!ready || signal.aborted) break batchLoop;
          chunkMeta.push({
            mark,
            boundaries,
            trimStartSec: prepared.trimStartSec,
            trimmedDurationSec: prepared.trimmedDurationSec,
          });
          const gapSec = INTER_SENTENCE_GAP_SEC / rate;
          this.#player.scheduleChunk(generation, prepared.buffer, {
            trimStartSec: prepared.trimStartSec,
            mediaScale: prepared.trimmedDurationSec / prepared.buffer.duration,
            gapSec,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    } finally {
      // Always close the session when the scheduler exits — including when every
      // mark was skipped (e.g. punctuation-only ellipsis) or the loop broke
      // early — so auto-advance never dead-ends with controls stuck playing.
      finishSession();
    }
  }

  async #prepareSamplesBuffer(
    channel: Float32Array,
    sampleRate: number,
    boundaries: TTSWordBoundary[],
    rate: number,
  ): Promise<{
    buffer: TTSAudioBuffer;
    boundaries: TTSWordBoundary[];
    trimStartSec: number;
    trimmedDurationSec: number;
  }> {
    if (boundaries.length === 0) {
      const bounds = findSpeechBounds(channel, sampleRate);
      const startSample = Math.floor(bounds.startSec * sampleRate);
      const endSample = Math.min(
        channel.length,
        Math.max(startSample + 1, Math.ceil(bounds.endSec * sampleRate)),
      );
      const trimmed = channel.subarray(startSample, endSample);
      const buffer = await this.#player.createMonoBuffer(trimmed, sampleRate);
      return {
        buffer,
        boundaries,
        trimStartSec: (startSample / sampleRate) * rate,
        trimmedDurationSec: (trimmed.length / sampleRate) * rate,
      };
    }

    const secToSamples = (sec: number) => Math.round(sec * sampleRate);
    const wordStarts = boundaries.map((b) =>
      Math.floor((b.offset / TICKS_PER_SECOND) * sampleRate),
    );
    const wordEnds = boundaries.map((b) =>
      Math.ceil(((b.offset + b.duration) / TICKS_PER_SECOND) * sampleRate),
    );
    const plan = planSilenceCompression(
      wordStarts,
      wordEnds,
      boundaries.map((b) => b.text),
      channel.length,
      secToSamples(EDGE_KEEP_SEC / rate),
      secToSamples(TRAILING_KEEP_SEC / rate),
      secToSamples(MIN_COMPRESS_GAP_SEC / rate),
      secToSamples(SHORT_PAUSE_SEC / rate),
      secToSamples(LONG_PAUSE_SEC / rate),
    );

    const out = new Float32Array(plan.outLength);
    let write = 0;
    for (const [s, e] of plan.segments) {
      const seg = channel.subarray(Math.max(0, s), Math.min(channel.length, e));
      out.set(seg, write);
      write += seg.length;
    }
    const buffer = await this.#player.createMonoBuffer(out, sampleRate);
    const remapped = boundaries.map((b, i) => ({
      ...b,
      offset: (plan.wordStartsOut[i]! / sampleRate) * TICKS_PER_SECOND,
    }));
    return {
      buffer,
      boundaries: remapped,
      trimStartSec: 0,
      trimmedDurationSec: (plan.outLength / sampleRate) * rate,
    };
  }

  // Poll the audio clock (visual concern only, so rAF throttling with the
  // screen off is fine) and tell the controller which word is being spoken.
  // The player reports original (rate-1.0) media time; boundaries were scaled
  // to that same frame at fetch, so no rescaling is needed here.
  #startWordTracking(generation: number, chunkIndex: number, meta: ChunkMeta): void {
    this.#stopWordTracking();
    const controller = this.controller;
    if (!controller) return;
    // Always hand the words to the controller — with boundaries it highlights
    // word-by-word; with none it draws the sentence highlight that was
    // suppressed at mark dispatch (see TTSController.prepareSpeakWords).
    controller.prepareSpeakWords(meta.boundaries.map((boundary) => boundary.text));
    if (!meta.boundaries.length) return;
    let lastIndex = -1;
    const tick = () => {
      const pos = this.#player.getPlaybackPosition(generation);
      // Guard the one-frame window around a transition where this tick still
      // holds the previous chunk's boundaries.
      if (pos && pos.chunkIndex === chunkIndex) {
        const index = findBoundaryIndexAtTime(meta.boundaries, pos.mediaTimeSec);
        if (index !== lastIndex && index >= 0) {
          lastIndex = index;
          controller.dispatchSpeakWord(index);
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

  getChunkPosition(): number | null {
    const generation = this.#activeGeneration;
    if (generation === null) return null;
    const pos = this.#player.getPlaybackPosition(generation);
    if (!pos) return null;
    const meta = this.#chunkMeta[pos.chunkIndex];
    if (!meta) return null;
    // Trim-relative and clamped: the section timeline sums TRIMMED durations,
    // while the player reports untrimmed media time (kept that way for word
    // boundaries).
    return Math.min(Math.max(pos.mediaTimeSec - meta.trimStartSec, 0), meta.trimmedDurationSec);
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
