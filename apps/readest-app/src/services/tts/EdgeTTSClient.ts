import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { LRUCache } from '@/utils/lru';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { EdgeSpeechTTS, EdgeTTSPayload, EDGE_TTS_PROTOCOL, TTSWordBoundary } from '@/libs/edgeTTS';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import { hasSpeakableText, parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { findBoundaryIndexAtTime } from './wordHighlight';

// Edge word-boundary offsets/durations are in 100-nanosecond ticks.
const TICKS_PER_SECOND = 10_000_000;
// Trim each segment's trailing silence (the padding Edge appends after the last
// word) so batches butt together at speech, not at silence. Keep a small margin
// past the last word so it isn't clipped, and only trim when the silence is long
// enough to be worth removing.
const TRAIL_SAFETY_MARGIN_SEC = 0.12;
const MIN_TRAILING_SILENCE_SEC = 0.25;

// Small lead before the first source of a paragraph starts, so `start(when)` is
// scheduled just ahead of the clock rather than in the past (which can glitch).
// Batches within a paragraph are scheduled contiguously with no lead, so this
// only affects the very first sample of each paragraph.
const SCHEDULE_LEAD_SEC = 0.02;

// Decoded AudioBuffers are ~10x the mp3 size, so keep this cache small; the mp3
// blobs stay in EdgeSpeechTTS's larger LRU and re-decoding a cached blob is
// cheap (single-digit ms), so eviction never costs a network round-trip.
const AUDIO_BUFFER_CACHE_SIZE = 16;

// Edge TTS always returns 24kHz mp3. Some WebViews (WebKit) decode the mp3 but
// play the buffer back at the context's device rate (~48kHz) without resampling,
// doubling the pitch ("chipmunk"). Creating the AudioContext at the source rate
// removes the mismatch entirely, so there is nothing to resample.
const EDGE_TTS_SAMPLE_RATE = 24000;

// A single sentence-mark placed on the audio-context timeline. `batchCtxStart`
// is when its batch's audio begins (context time); word-boundary offsets are
// media-time relative to that. `markCtxStart` is when this mark's first word is
// heard, used to switch the sentence highlight as playback crosses marks.
interface MarkEntry {
  mark: TTSMark;
  boundaries: TTSWordBoundary[];
  batchCtxStart: number;
  markCtxStart: number;
}

// Group consecutive sentence-marks of a paragraph into a single Edge request of
// up to this many characters. Each foliate paragraph carries one mark per
// sentence, and the client used to issue one request per mark — short CJK
// sentences (e.g. dialogue) meant many tiny requests and a torn-down <audio>
// src (hence a gap/click) at every sentence. Batching yields one mp3 that plays
// gaplessly across its sentences and cuts request frequency; ~120 chars keeps
// first-audio latency low (~25-30s of CJK speech per request). Word/sentence
// highlighting is preserved by remapping the combined word-boundaries back to
// each mark. Marks are never split, and a batch never mixes languages.
const BATCH_MAX_CHARS = 120;
// The first request should contain roughly one short sentence so playback can
// begin after a single small synthesis response. Remaining batches keep the
// normal budget and continue filling the existing look-ahead cache.
const STARTUP_BATCH_MAX_CHARS = 40;

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
  #audioContext: AudioContext | null = null;
  #gainNode: GainNode | null = null;
  // Currently scheduled sources for the active paragraph. Cancelled on stop and
  // cleared once a paragraph ends naturally.
  #sources: AudioBufferSourceNode[] = [];
  #audioSegmentCache = new LRUCache<string, { buffer: AudioBuffer; boundaries: TTSWordBoundary[] }>(
    AUDIO_BUFFER_CACHE_SIZE,
  );
  #isPlaying = false;
  #wordTrackingRafId: number | null = null;

  constructor(controller?: TTSController, appService?: AppService | null) {
    this.controller = controller;
    this.appService = appService;
  }

  // Default to the HTTPS path, which targets the self-hosted Edge TTS server
  // (see getEdgeTTSBaseUrl). No auth is required, so there is no wss fallback
  // or tts-need-auth prompt.
  //
  // The voice list is a static, local catalog and the self-hosted server has
  // no per-voice gating, so mark the client ready without a live network probe.
  // A single failed/slow probe at startup must not disable every voice in the
  // picker (that made voices like zh-CN-YunxiNeural unselectable); transient
  // server issues surface at playback time, where #createAudioUrlWithRetry
  // already retries and errors are reported.
  async init(protocol: EDGE_TTS_PROTOCOL = 'https') {
    this.#edgeTTS = new EdgeSpeechTTS(protocol);
    this.#voices = EdgeSpeechTTS.voices;
    this.initialized = true;
    return this.initialized;
  }

  getPayload = (lang: string, text: string, voiceId: string) => {
    // Speed is rendered server-side via Edge's prosody rate, which changes tempo
    // while preserving pitch. Applying speed here instead of via the Web Audio
    // source's playbackRate avoids the "chipmunk" pitch shift that resampling a
    // buffer faster/slower would cause.
    return { lang, text, voice: voiceId, rate: this.#rate, pitch: this.#pitch } as EdgeTTSPayload;
  };

  // Edge TTS websocket requests fail intermittently; retry the preload a few times
  // before giving up so a single transient failure doesn't stall playback.
  #createAudioUrlWithRetry = async (
    payload: EdgeTTSPayload,
    signal: AbortSignal,
    maxAttempts = 3,
  ): Promise<string | undefined> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) return undefined;
      try {
        return await this.#edgeTTS?.createAudioUrl(payload);
      } catch (err) {
        lastError = err;
        console.warn(`Edge TTS preload attempt ${attempt}/${maxAttempts} failed`, err);
        if (attempt < maxAttempts && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    throw lastError;
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

    if (preload) {
      // Preload by batch (not per mark) so the cached payloads are keyed on the
      // exact combined text that playback will request — otherwise the cache
      // would miss and playback would re-fetch mid-play. First couple of
      // batches immediately, the rest in the background.
      const batches = this.#buildBatches(marks, startup);
      const maxImmediate = startup ? 1 : 2;
      const preloadBatch = async (batch: TTSMark[]) => {
        const voiceLang = batch[0]!.language;
        const voiceId = await this.getVoiceIdFromLang(voiceLang);
        this.#currentVoiceId = voiceId;
        const text = batch.map((m) => m.text).join('');
        await this.#createAudioUrlWithRetry(this.getPayload(voiceLang, text, voiceId), signal);
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
            if (signal.aborted) break;
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

      return;
    }

    await this.stopInternal();

    const batches = this.#buildBatches(marks, startup);
    if (batches.length === 0) {
      yield { code: 'end', message: 'Nothing to speak' } as TTSMessageEvent;
      return;
    }

    const ctx = this.#ensureContext();
    await this.#resumeContext(ctx);

    yield {
      code: 'boundary',
      message: `Start chunk: ${batches[0]![0]!.name}`,
      mark: batches[0]![0]!.name,
    } as TTSMessageEvent;

    const result = await this.#scheduleParagraph(ctx, batches, signal);
    yield result;

    await this.stopInternal();
  }

  #ensureContext(): AudioContext {
    if (!this.#audioContext) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        this.#audioContext = new Ctor({ sampleRate: EDGE_TTS_SAMPLE_RATE });
      } catch {
        // Some engines reject a forced sample rate; fall back to the default
        // rate and rely on the playbackRate ratio compensation below.
        this.#audioContext = new Ctor();
      }
      this.#gainNode = this.#audioContext.createGain();
      this.#gainNode.connect(this.#audioContext.destination);
    }
    return this.#audioContext;
  }

  async #resumeContext(ctx: AudioContext) {
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
  }

  // Decode (and cache) the mp3 for a payload into an AudioBuffer. The blob is
  // already cached by EdgeSpeechTTS, so a cache miss here only pays the (cheap)
  // decode cost, never a network round-trip.
  async #getSegment(ctx: AudioContext, payload: EdgeTTSPayload) {
    const key = `${payload.voice}\u0000${payload.pitch}\u0000${payload.rate}\u0000${payload.text}`;
    const cached = this.#audioSegmentCache.get(key);
    if (cached) return cached;
    const { data, boundaries } = await this.#edgeTTS!.createAudioData(payload);
    const buffer = await ctx.decodeAudioData(data);
    const segment = { buffer, boundaries };
    this.#audioSegmentCache.set(key, segment);
    return segment;
  }

  // Schedule every batch of a paragraph back-to-back on the audio-context
  // timeline so mid-paragraph sentence periods play gaplessly (batches are cut
  // arbitrarily inside a continuous paragraph, so any silence between them is
  // padding). Trailing silence is trimmed via each batch's last word boundary,
  // and the next batch butts on at that point. Word/sentence highlighting is
  // driven from context time in #startTracking. Resolves 'end' when the last
  // scheduled source finishes, or 'error' on abort.
  async #scheduleParagraph(
    ctx: AudioContext,
    batches: TTSMark[][],
    signal: AbortSignal,
  ): Promise<TTSMessageEvent> {
    const gain = this.#gainNode!;
    const markEntries: MarkEntry[] = [];
    const sources: AudioBufferSourceNode[] = [];
    let startTime = ctx.currentTime + SCHEDULE_LEAD_SEC;
    let lastSource: AudioBufferSourceNode | null = null;
    let pendingError: string | null = null;

    for (const batch of batches) {
      if (signal.aborted) break;
      const voiceLang = batch[0]!.language;
      const voiceId = await this.getVoiceIdFromLang(voiceLang);
      this.#speakingLang = voiceLang;
      this.#currentVoiceId = voiceId;
      const text = batch.map((m) => m.text).join('');

      let segment: { buffer: AudioBuffer; boundaries: TTSWordBoundary[] };
      try {
        segment = await this.#getSegment(ctx, this.getPayload(voiceLang, text, voiceId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'No audio data received.') {
          console.warn('No audio data received for:', text);
          continue;
        }
        console.warn('TTS error for batch:', text, message);
        pendingError = message;
        break;
      }
      if (signal.aborted) break;

      const { buffer, boundaries } = segment;
      const speechEndSec = boundaries.length
        ? (boundaries[boundaries.length - 1]!.offset +
            boundaries[boundaries.length - 1]!.duration) /
          TICKS_PER_SECOND
        : buffer.duration;
      const trailingSilence = buffer.duration - speechEndSec;
      const playMediaDur =
        trailingSilence > MIN_TRAILING_SILENCE_SEC
          ? Math.min(buffer.duration, speechEndSec + TRAIL_SAFETY_MARGIN_SEC)
          : buffer.duration;

      if (startTime < ctx.currentTime) startTime = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Speed is already baked into the audio (server-side prosody rate), so the
      // only playbackRate adjustment is a sample-rate safety net: some WebViews
      // don't resample the decoded 24kHz Edge mp3 to the context rate, so the
      // buffer would play back at the context rate and shift pitch. The ratio is
      // 1 on spec-compliant engines (and when the context is forced to 24kHz).
      source.playbackRate.value = buffer.sampleRate / ctx.sampleRate;
      source.connect(gain);
      const batchCtxStart = startTime;
      source.start(batchCtxStart);
      const wallDur = playMediaDur;
      source.stop(batchCtxStart + wallDur);
      sources.push(source);
      lastSource = source;

      const { perMark, startSec } = this.#partitionBatch(batch, boundaries);
      for (let i = 0; i < batch.length; i++) {
        markEntries.push({
          mark: batch[i]!,
          boundaries: perMark[i]!,
          batchCtxStart,
          markCtxStart: batchCtxStart + (startSec[i] ?? 0),
        });
      }
      startTime = batchCtxStart + wallDur;
    }

    this.#sources = sources;

    return new Promise<TTSMessageEvent>((resolve) => {
      let settled = false;
      let abortHandler: (() => void) | null = null;
      const finish = (evt: TTSMessageEvent) => {
        if (settled) return;
        settled = true;
        this.#stopWordTracking();
        if (abortHandler) signal.removeEventListener('abort', abortHandler);
        resolve(evt);
      };

      abortHandler = () => {
        this.#cancelSources();
        finish({ code: 'error', message: 'Aborted' });
      };
      if (signal.aborted) {
        this.#cancelSources();
        finish({ code: 'error', message: 'Aborted' });
        return;
      }
      signal.addEventListener('abort', abortHandler);

      if (!lastSource || markEntries.length === 0) {
        finish(
          pendingError
            ? { code: 'error', message: pendingError }
            : { code: 'end', message: 'Chunk finished' },
        );
        return;
      }

      this.#isPlaying = true;
      lastSource.onended = () => finish({ code: 'end', message: 'Chunk finished' });
      this.#startTracking(ctx, markEntries);
    });
  }

  // Group a paragraph's sentence-marks into requests of up to BATCH_MAX_CHARS
  // characters. Consecutive marks are merged until adding the next would exceed
  // the budget; a single over-long mark stands alone. A batch never mixes
  // languages so each Edge request has one voice/lang.
  #buildBatches(marks: TTSMark[], startup = false): TTSMark[][] {
    const batches: TTSMark[][] = [];
    let current: TTSMark[] = [];
    let currentLen = 0;
    let currentLang: string | null = null;
    for (const mark of marks) {
      // The hosted Edge service returns HTTP 500 / "No audio was received" for
      // punctuation-only input such as `……`. Normally parseSSMLMarks removes
      // it; keep this client-boundary guard so callbacks or future parsers can
      // never send an unsynthesizable batch and strand auto-advance.
      if (!hasSpeakableText(mark.text)) continue;
      const len = mark.text.length;
      const sameLang = currentLang === null || mark.language === currentLang;
      const maxChars = startup && batches.length === 0 ? STARTUP_BATCH_MAX_CHARS : BATCH_MAX_CHARS;
      if (current.length > 0 && (!sameLang || currentLen + len > maxChars)) {
        batches.push(current);
        current = [];
        currentLen = 0;
        currentLang = null;
      }
      current.push(mark);
      currentLen += len;
      currentLang = mark.language;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  // Split the combined word-boundaries of a batched mp3 back to each sentence
  // mark, so highlighting stays per sentence even though several sentences
  // share one request/mp3. Each boundary word is located in the combined text
  // (sequential search) and assigned to the mark whose character span contains
  // it. `startSec` is when each mark's first word begins in the shared mp3.
  #partitionBatch(batch: TTSMark[], boundaries: TTSWordBoundary[]) {
    const base = batch[0]!.offset;
    const combined = batch.map((m) => m.text).join('');
    const spanEnd = batch.map((m) => m.offset - base + m.text.length);
    const perMark: TTSWordBoundary[][] = batch.map(() => []);
    let searchPos = 0;
    let markIdx = 0;
    for (const boundary of boundaries) {
      let pos = combined.indexOf(boundary.text, searchPos);
      if (pos < 0) {
        pos = searchPos;
      } else {
        searchPos = pos + boundary.text.length;
      }
      while (markIdx < spanEnd.length - 1 && pos >= spanEnd[markIdx]!) markIdx++;
      perMark[markIdx]!.push(boundary);
    }
    const startSec: number[] = [];
    for (let i = 0; i < batch.length; i++) {
      const first = perMark[i]![0];
      startSec[i] = first ? first.offset / TICKS_PER_SECOND : (startSec[i - 1] ?? 0);
    }
    return { perMark, startSec };
  }

  // Drive per-sentence + per-word highlighting from context time across all of
  // the paragraph's scheduled batches. When playback crosses into a new mark,
  // dispatch it (sentence highlight) and hand its words to the controller;
  // within a mark, report the spoken word. Context time naturally accounts for
  // playbackRate and suspend/resume, so no per-element polling is needed.
  #startTracking(ctx: AudioContext, markEntries: MarkEntry[]) {
    this.#stopWordTracking();
    const controller = this.controller;
    if (!controller) return;

    let currentIdx = -1;
    let lastWord = -1;
    const enterMark = (i: number) => {
      currentIdx = i;
      lastWord = -1;
      const entry = markEntries[i]!;
      controller.dispatchSpeakMark(entry.mark);
      // With words the controller highlights word-by-word; with none it draws
      // the sentence highlight suppressed at mark dispatch (see
      // TTSController.prepareSpeakWords).
      controller.prepareSpeakWords(entry.boundaries.map((boundary) => boundary.text));
    };

    // Set up the first mark synchronously so its sentence highlight + word list
    // are ready before the first frame.
    enterMark(0);

    const tick = () => {
      const now = ctx.currentTime;
      let i = currentIdx;
      while (i + 1 < markEntries.length && markEntries[i + 1]!.markCtxStart <= now) i++;
      if (i !== currentIdx) enterMark(i);
      const entry = markEntries[currentIdx]!;
      const mediaWithinBatch = now - entry.batchCtxStart;
      const index = findBoundaryIndexAtTime(entry.boundaries, mediaWithinBatch);
      if (index !== lastWord && index >= 0) {
        lastWord = index;
        controller.dispatchSpeakWord(index);
      }
      this.#wordTrackingRafId = requestAnimationFrame(tick);
    };
    this.#wordTrackingRafId = requestAnimationFrame(tick);
  }

  #stopWordTracking() {
    if (this.#wordTrackingRafId !== null) {
      cancelAnimationFrame(this.#wordTrackingRafId);
      this.#wordTrackingRafId = null;
    }
  }

  #cancelSources() {
    for (const source of this.#sources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // A source that never started (or already stopped) throws; ignore.
      }
    }
    this.#sources = [];
  }

  async pause() {
    if (!this.#isPlaying || !this.#audioContext) return true;
    // Suspending freezes the context clock, so scheduled sources pause in place
    // and resume perfectly aligned — no rewind/fade compensation needed.
    await this.#audioContext.suspend().catch(() => {});
    this.#isPlaying = false;
    return true;
  }

  async resume() {
    if (this.#isPlaying || !this.#audioContext) return true;
    await this.#audioContext.resume().catch(() => {});
    this.#isPlaying = true;
    return true;
  }

  async stop() {
    await this.stopInternal();
  }

  private async stopInternal() {
    this.#stopWordTracking();
    this.#cancelSources();
    this.#isPlaying = false;
  }

  async setRate(rate: number) {
    // The Edge TTS API uses rate in [0.5 .. 2.0].
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
    if (this.#audioContext) {
      await this.#audioContext.close().catch(() => {});
      this.#audioContext = null;
      this.#gainNode = null;
    }
    this.#audioSegmentCache.clear();
    this.initialized = false;
    this.#voices = [];
  }
}
