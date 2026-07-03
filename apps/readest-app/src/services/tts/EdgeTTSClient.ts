import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { EdgeSpeechTTS, EdgeTTSPayload, EDGE_TTS_PROTOCOL, TTSWordBoundary } from '@/libs/edgeTTS';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { findBoundaryIndexAtTime } from './wordHighlight';

// Short volume ramp applied at the end of each Edge segment. A single <audio>
// element is reused for every sentence, so each boundary tears down and
// reassigns audio.src — which clicks/pops ("电波"/静电) whenever the waveform
// isn't sitting at a zero sample. Fading the element volume to zero before the
// cut removes that step discontinuity. The fade runs inside the segment's
// trailing silence, so it's inaudible and never clips speech. rAF-driven, but
// the audio's natural `onended` is a safe fallback if frames stall (e.g. the
// app is backgrounded), so playback always advances and volume is restored.
const SEGMENT_FADE_OUT_MS = 60;

// Edge word-boundary offsets/durations are in 100-nanosecond ticks.
const TICKS_PER_SECOND = 10_000_000;
// End a segment once playback passes the last word (plus a small margin so the
// final word isn't clipped) whenever the trailing silence is long enough to be
// worth trimming.
const TRAIL_SAFETY_MARGIN_SEC = 0.12;
const MIN_TRAILING_SILENCE_SEC = 0.25;

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
  #audioElement: HTMLAudioElement | null = null;
  #isPlaying = false;
  #pausedAt = 0;
  #startedAt = 0;
  #fadeCompensation: number | null = null;
  #wordTrackingRafId: number | null = null;
  #fadeRafId: number | null = null;

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
    return { lang, text, voice: voiceId, rate: 1.0, pitch: this.#pitch } as EdgeTTSPayload;
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

  async *speak(ssml: string, signal: AbortSignal, preload = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      // Preload by batch (not per mark) so the cached payloads are keyed on the
      // exact combined text that playback will request — otherwise the cache
      // would miss and playback would re-fetch mid-play. First couple of
      // batches immediately, the rest in the background.
      const batches = this.#buildBatches(marks);
      const maxImmediate = 2;
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
    // Reuse the same Audio element inside the ssml session
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
    }
    const audio = this.#audioElement;
    audio.setAttribute('x-webkit-airplay', 'deny');
    audio.preload = 'auto';

    const batches = this.#buildBatches(marks);
    for (const batch of batches) {
      const firstMark = batch[0]!;
      const batchText = batch.map((m) => m.text).join('');
      let abortHandler: null | (() => void) = null;
      try {
        const voiceLang = firstMark.language;
        const voiceId = await this.getVoiceIdFromLang(voiceLang);
        this.#speakingLang = voiceLang;
        const audioResult = await this.#edgeTTS?.createAudio(
          this.getPayload(voiceLang, batchText, voiceId),
        );
        const audioUrl = audioResult?.url;
        const boundaries = audioResult?.boundaries ?? [];
        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          break;
        }

        yield {
          code: 'boundary',
          message: `Start chunk: ${firstMark.name}`,
          mark: firstMark.name,
        } as TTSMessageEvent;

        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            this.#stopWordTracking();
            audio.onended = null;
            audio.onerror = null;
            audio.src = '';
          };
          let resolved = false;
          const handleEnded = () => {
            if (resolved) return;
            resolved = true;
            cleanUp();
            resolve({ code: 'end', message: `Chunk finished: ${firstMark.name}` });
          };

          abortHandler = () => {
            cleanUp();
            resolve({ code: 'error', message: 'Aborted' });
          };
          if (signal.aborted) {
            abortHandler();
            return;
          } else {
            signal.addEventListener('abort', abortHandler);
          }
          audio.onended = handleEnded;
          audio.onerror = (e) => {
            cleanUp();
            console.warn('Audio playback error:', e);
            resolve({ code: 'error', message: 'Audio playback error' });
          };
          this.#isPlaying = true;
          audio.src = audioUrl || '';
          this.#startBatchTracking(audio, batch, boundaries, handleEnded);
          if (!this.appService?.isLinuxApp) {
            audio.playbackRate = this.#rate;
          }
          audio
            .play()
            .then(() => {
              if (this.appService?.isLinuxApp) {
                audio.playbackRate = this.#rate;
              }
            })
            .catch((err) => {
              cleanUp();
              console.error('Failed to play audio:', err);
              resolve({ code: 'error', message: 'Playback failed: ' + err.message });
            });
        });
        yield result;
      } catch (error) {
        if (error instanceof Error && error.message === 'No audio data received.') {
          console.warn('No audio data received for:', batchText);
          yield { code: 'end', message: `Chunk finished: ${firstMark.name}` } as TTSMessageEvent;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn('TTS error for mark:', batchText, message);
        yield { code: 'error', message } as TTSMessageEvent;
        break;
      } finally {
        if (abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
    await this.stopInternal();
  }

  // Group a paragraph's sentence-marks into requests of up to BATCH_MAX_CHARS
  // characters. Consecutive marks are merged until adding the next would exceed
  // the budget; a single over-long mark stands alone. A batch never mixes
  // languages so each Edge request has one voice/lang.
  #buildBatches(marks: TTSMark[]): TTSMark[][] {
    const batches: TTSMark[][] = [];
    let current: TTSMark[] = [];
    let currentLen = 0;
    let currentLang: string | null = null;
    for (const mark of marks) {
      const len = mark.text.length;
      const sameLang = currentLang === null || mark.language === currentLang;
      if (current.length > 0 && (!sameLang || currentLen + len > BATCH_MAX_CHARS)) {
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

  // Follow playback time against the word-boundary metadata of the current
  // batch and drive per-sentence highlighting: when playback crosses into a new
  // mark, dispatch that mark (sentence highlight) and hand its words to the
  // controller; within a mark, report the spoken word. Word offsets are in
  // media time, so audio.playbackRate and pause/resume (including the resume
  // rewind on iOS) are handled naturally by polling audio.currentTime.
  #startBatchTracking(
    audio: HTMLAudioElement,
    batch: TTSMark[],
    boundaries: TTSWordBoundary[],
    onSpeechEnd?: () => void,
  ) {
    this.#stopWordTracking();
    const controller = this.controller;
    if (!controller) return;

    const { perMark, startSec } = this.#partitionBatch(batch, boundaries);
    let currentMark = -1;
    let lastWord = -1;
    const enterMark = (i: number) => {
      currentMark = i;
      lastWord = -1;
      controller.dispatchSpeakMark(batch[i]!);
      // With words the controller highlights word-by-word; with none it draws
      // the sentence highlight suppressed at mark dispatch (see
      // TTSController.prepareSpeakWords).
      controller.prepareSpeakWords(perMark[i]!.map((boundary) => boundary.text));
    };

    // Set up the first mark synchronously so its sentence highlight + word list
    // are ready before the first frame (matches the single-sentence path and
    // lets callers observe prepareSpeakWords without waiting for a frame).
    enterMark(0);
    if (!boundaries.length) return;

    // Each Edge mp3 carries trailing silence after the last word. Stacked with
    // the next segment's turnaround it becomes an over-long pause at every
    // batch/paragraph break. The last word boundary tells us when speech ends,
    // so once playback passes it (plus a small safety margin so the final word
    // isn't clipped) we finish the segment early and let playback advance to
    // the preloaded next one — roughly halving the gap.
    const lastBoundary = boundaries[boundaries.length - 1]!;
    const speechEndSec = (lastBoundary.offset + lastBoundary.duration) / TICKS_PER_SECOND;
    let endedEarly = false;

    const tick = () => {
      const currentTime = audio.currentTime;
      let mark = currentMark;
      while (mark + 1 < batch.length && startSec[mark + 1]! <= currentTime) mark++;
      if (mark !== currentMark) enterMark(mark);
      const index = findBoundaryIndexAtTime(perMark[currentMark]!, currentTime);
      if (index !== lastWord && index >= 0) {
        lastWord = index;
        controller.dispatchSpeakWord(index);
      }
      if (!endedEarly && onSpeechEnd && Number.isFinite(audio.duration)) {
        const trailingSilence = audio.duration - speechEndSec;
        if (
          trailingSilence > MIN_TRAILING_SILENCE_SEC &&
          currentTime >= speechEndSec + TRAIL_SAFETY_MARGIN_SEC
        ) {
          endedEarly = true;
          // Fade to silence before ending: onSpeechEnd runs cleanUp() which
          // sets audio.src = '', and clearing a source that isn't at a zero
          // sample clicks/pops at the segment boundary. We're already inside
          // the trailing silence, so the ramp is inaudible and never clips the
          // final word. Returning here stops the tick loop (no reschedule); the
          // fade drives the segment end via onSpeechEnd.
          this.#fadeVolume(audio, audio.volume, 0, SEGMENT_FADE_OUT_MS, onSpeechEnd);
          return;
        }
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
    if (this.#fadeRafId !== null) {
      cancelAnimationFrame(this.#fadeRafId);
      this.#fadeRafId = null;
    }
    // Restore full volume for the next (reused) segment, and so an interrupted
    // fade can never leave playback muted.
    if (this.#audioElement) this.#audioElement.volume = 1;
  }

  // Linear ramp of the element volume, used to smooth segment boundaries. A
  // single in-flight fade at a time; starting a new one cancels the previous.
  #fadeVolume(
    audio: HTMLAudioElement,
    from: number,
    to: number,
    durationMs: number,
    onDone?: () => void,
  ) {
    if (this.#fadeRafId !== null) {
      cancelAnimationFrame(this.#fadeRafId);
      this.#fadeRafId = null;
    }
    const start = performance.now();
    audio.volume = from;
    const step = () => {
      const t = durationMs > 0 ? Math.min(1, (performance.now() - start) / durationMs) : 1;
      audio.volume = from + (to - from) * t;
      if (t < 1) {
        this.#fadeRafId = requestAnimationFrame(step);
      } else {
        this.#fadeRafId = null;
        audio.volume = to;
        onDone?.();
      }
    };
    this.#fadeRafId = requestAnimationFrame(step);
  }

  async pause() {
    if (!this.#isPlaying || !this.#audioElement) return true;
    this.#pausedAt = this.#audioElement.currentTime - this.#startedAt;
    await this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  #getFadeCompensation() {
    if (this.#fadeCompensation !== null) return this.#fadeCompensation;

    const userAgent = navigator.userAgent;
    const isSafari = /Safari/.test(userAgent) && !/Chrome/.test(userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    if (isSafari || isIOS) {
      this.#fadeCompensation = 0.2;
    } else {
      this.#fadeCompensation = 0.0;
    }

    return this.#fadeCompensation;
  }

  async resume() {
    if (this.#isPlaying || !this.#audioElement) return true;
    const fadeCompensation = this.#getFadeCompensation();
    this.#audioElement.currentTime = Math.max(0, this.#audioElement.currentTime - fadeCompensation);
    await this.#audioElement.play();
    this.#isPlaying = true;
    this.#startedAt = this.#audioElement.currentTime - this.#pausedAt;
    return true;
  }

  async stop() {
    await this.stopInternal();
  }

  private async stopInternal() {
    this.#stopWordTracking();
    this.#isPlaying = false;
    this.#pausedAt = 0;
    this.#startedAt = 0;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
      if (this.#audioElement?.onended) {
        this.#audioElement.onended(new Event('stopped'));
      }
      this.#audioElement.src = '';
    }
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
    this.initialized = false;
    this.#audioElement = null;
    this.#voices = [];
  }
}
