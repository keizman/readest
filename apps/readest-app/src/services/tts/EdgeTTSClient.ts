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
import { findSpeechBounds } from './pcm';
import {
  calibrateVoiceRate,
  recordMeasuredDuration,
  recordProvisionalDuration,
} from './ttsDuration';
import { buildBatches, partitionBatch } from './ttsBatch';
import { TTSAudioBuffer, WebAudioPlayer, WebAudioPlayerEvent } from './WebAudioPlayer';

// One Edge request is one immutable Web Audio source. Sentence boundaries are
// metadata on that source, never PCM cut points. This preserves Edge's native
// pacing and gives highlighting, the scrubber, and audio one shared clock.
// Only batch-edge padding is trimmed before sources are scheduled back-to-back.
const BATCH_EDGE_KEEP_SEC = 0.06;
const TICKS_PER_SECOND = 10_000_000;

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
  #activeVisualChunkIndex = -1;
  #activeVisualMarkIndex = -1;
  #activeWordIndex = -1;

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
    // Preload by batch so LRU keys match playback requests. Only batch zero is
    // on the playback critical path; later requests fill concurrently. Waiting
    // for two cold batches here used to create a network-sized silence at every
    // controller session transition.
    const batches = buildBatches(marks, startup);
    const preloadBatch = async (batch: TTSMark[]) => {
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
          ),
        );
      }
    };
    const runBatch = async (index: number) => {
      // Batch zero is required for imminent playback even when the lookahead
      // cache is nominally full; inserting it evicts an older LRU entry.
      if (signal.aborted || (index > 0 && !hasTTSPrefetchCapacity())) return;
      try {
        await preloadBatch(batches[index]!);
      } catch (err) {
        console.warn('Error preloading batch', index, err);
      }
    };
    const firstPromise = batches.length > 0 ? runBatch(0) : Promise.resolve();
    let nextIndex = 1;
    const worker = async () => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= batches.length || !hasTTSPrefetchCapacity()) return;
        await runBatch(index);
      }
    };
    const backgroundPromise = Promise.all([worker(), worker(), worker()]);
    await firstPromise;
    void backgroundPromise;

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
      for (const batch of batches) {
        if (signal.aborted || this.#activeGeneration !== generation) break;
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
        if (!audio || signal.aborted || this.#activeGeneration !== generation) break;

        let decoded: TTSAudioBuffer;
        try {
          decoded = await this.#player.decode(audio.data);
        } catch (error) {
          console.warn('Failed to decode TTS audio for:', batchText, error);
          for (const mark of batch) queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }

        let prepared: ChunkMeta & { buffer: TTSAudioBuffer };
        try {
          prepared = await this.#prepareBatchBuffer(decoded, batch, audio.boundaries, rate);
        } catch (error) {
          console.warn('Failed to prepare TTS audio batch:', batchText, error);
          for (const mark of batch) queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }

        for (const markMeta of prepared.marks) {
          this.#recordDurations(
            voiceId,
            markMeta.mark.text,
            markMeta.boundaries,
            markMeta.durationMediaSec,
          );
        }

        const ready = await this.#player.waitUntilReady(generation);
        if (!ready || signal.aborted || this.#activeGeneration !== generation) break;
        chunkMeta.push({
          marks: prepared.marks,
          trimStartSec: prepared.trimStartSec,
          trimmedDurationSec: prepared.trimmedDurationSec,
        });
        this.#player.scheduleChunk(generation, prepared.buffer, {
          trimStartSec: prepared.trimStartSec,
          mediaScale: prepared.trimmedDurationSec / prepared.buffer.duration,
          gapSec: 0,
        });
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

  async #prepareBatchBuffer(
    decoded: TTSAudioBuffer,
    batch: TTSMark[],
    rawBoundaries: TTSWordBoundary[],
    rate: number,
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
    trimStartRawSec = startSample / sampleRate;
    trimEndRawSec = endSample / sampleRate;
    const buffer = await this.#player.createMonoBuffer(
      channel.subarray(startSample, endSample),
      sampleRate,
    );

    const trimStartSec = trimStartRawSec * rate;
    const trimEndSec = trimEndRawSec * rate;
    const trimmedDurationSec = trimEndSec - trimStartSec;
    const { perMark } = partitionBatch(batch, rawBoundaries);
    const totalChars = Math.max(
      1,
      batch.reduce((sum, mark) => sum + mark.text.length, 0),
    );
    let charsBefore = 0;
    const starts = batch.map((mark, index) => {
      const exact = perMark[index]?.[0];
      const fallback = trimStartSec + (trimmedDurationSec * charsBefore) / totalChars;
      charsBefore += mark.text.length;
      const start = exact ? (exact.offset / TICKS_PER_SECOND) * rate : fallback;
      return Math.min(Math.max(start, trimStartSec), trimEndSec);
    });
    for (let i = 1; i < starts.length; i++) {
      starts[i] = Math.max(starts[i]!, starts[i - 1]!);
    }

    const marks = batch.map((mark, index): BatchMarkMeta => {
      const startMediaSec = starts[index]!;
      const endMediaSec = starts[index + 1] ?? trimEndSec;
      return {
        mark,
        boundaries: this.#applyRateToBoundaries(perMark[index] ?? []),
        startMediaSec,
        durationMediaSec: Math.max(0, endMediaSec - startMediaSec),
      };
    });

    return { buffer, marks, trimStartSec, trimmedDurationSec };
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
