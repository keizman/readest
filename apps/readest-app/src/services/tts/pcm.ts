// Pure PCM helpers for the Web Audio TTS pipeline.
//
// Decoded MP3 "silence" is dithered ringing (roughly 1e-4 to 1e-3 amplitude),
// not zeros, so speech detection uses an amplitude threshold rather than an
// exact-zero test.

export interface SpeechBounds {
  startSec: number;
  endSec: number;
}

// ~-46 dBFS: above decoder dither/ringing, below any audible speech onset.
const DEFAULT_SILENCE_THRESHOLD = 0.005;
// Pads keep a natural attack/release around the detected speech.
const HEAD_PAD_SEC = 0.02;
const TAIL_PAD_SEC = 0.02;

export const findSpeechBounds = (
  samples: Float32Array,
  sampleRate: number,
  threshold = DEFAULT_SILENCE_THRESHOLD,
): SpeechBounds => {
  if (samples.length === 0 || sampleRate <= 0) {
    return { startSec: 0, endSec: 0 };
  }
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > threshold) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    // All silence: play as-is rather than scheduling a zero-length chunk.
    return { startSec: 0, endSec: samples.length / sampleRate };
  }
  let last = first;
  for (let i = samples.length - 1; i >= first; i--) {
    if (Math.abs(samples[i]!) > threshold) {
      last = i;
      break;
    }
  }
  const startSec = Math.max(0, first / sampleRate - HEAD_PAD_SEC);
  const endSec = Math.min(samples.length / sampleRate, (last + 1) / sampleRate + TAIL_PAD_SEC);
  return { startSec, endSec };
};

export interface SilenceCompressionPlan {
  // Ranges [startSample, endSample) of the source to copy, in order.
  segments: Array<[number, number]>;
  outLength: number;
  // Output-sample index of each input word start, for highlight remapping.
  wordStartsOut: number[];
}

// Fixed replacement pauses at rate-1.0 media seconds. Edge TTS bakes in variable
// comma/clause/sentence silences; the client normalizes them to these lengths.
// EdgeTTSClient divides by the current playback rate when compressing decoded
// buffers (prosody rate shrinks the MP3 timeline).
export const SHORT_PAUSE_SEC = 0.018;
export const LONG_PAUSE_SEC = 0.032;
// Gaps shorter than this are natural coarticulation between words.
export const MIN_COMPRESS_GAP_SEC = 0.015;

export type PauseKind = 'short' | 'long' | 'none';

// Classify the pause that should follow a word from its trailing punctuation.
// Short: comma, colon, semicolon, enumeration comma, dashes, etc.
// Long: sentence enders (. ? ! and CJK equivalents).
export const classifyWordTrailingPause = (wordText: string): PauseKind => {
  const t = wordText.trimEnd();
  if (!t) return 'none';
  if (/[.!?。！？]["'»」』)\]”’]*$/u.test(t)) return 'long';
  if (/[,;:、，；：·•…\u2026\-–—]["'»」』)\]”’]*$/u.test(t)) return 'short';
  return 'none';
};

// Plan a copy that keeps speech continuous but replaces inter-word silence
// (the variable comma/clause/sentence pauses Edge bakes in) with fixed short
// or long lengths based on trailing punctuation, and trims the leading/trailing
// edges to the first/last word. Chunk-boundary gaps are scheduled separately.
// Word starts are remapped to the compressed output timeline so word-highlight
// sync survives the removed samples. All arguments and results are in samples.
export const planSilenceCompression = (
  wordStarts: number[],
  wordEnds: number[],
  wordTexts: string[],
  totalSamples: number,
  leadSamples: number,
  tailSamples: number,
  minGapSamples: number,
  shortPauseSamples: number,
  longPauseSamples: number,
): SilenceCompressionPlan => {
  const n = wordStarts.length;
  if (n === 0) {
    return { segments: [[0, totalSamples]], outLength: totalSamples, wordStartsOut: [] };
  }
  const start = Math.max(0, wordStarts[0]! - leadSamples);
  const end = Math.min(totalSamples, wordEnds[n - 1]! + tailSamples);
  const segments: Array<[number, number]> = [];
  const wordStartsOut = new Array<number>(n);
  let copyStart = start;
  let removed = 0;
  for (let i = 0; i < n; i++) {
    wordStartsOut[i] = Math.max(0, wordStarts[i]! - start - removed);
    const gapStart = Math.min(end, Math.max(start, wordEnds[i]!));
    const gapEnd = i + 1 < n ? Math.min(end, Math.max(start, wordStarts[i + 1]!)) : end;
    const gapLen = gapEnd - gapStart;
    // Only inter-word gaps are Edge punctuation pauses; trailing tail padding is kept.
    if (i + 1 >= n || gapLen <= minGapSamples) continue;
    const kind = classifyWordTrailingPause(wordTexts[i] ?? '');
    if (kind === 'none' && gapLen <= minGapSamples * 4) continue;
    const target = kind === 'long' ? longPauseSamples : shortPauseSamples;
    const keep = Math.min(gapLen, target);
    if (keep >= gapLen) continue;
    const keepHead = Math.ceil(keep / 2);
    segments.push([copyStart, gapStart + keepHead]);
    copyStart = gapEnd - (keep - keepHead);
    removed += gapLen - keep;
  }
  if (copyStart < end) segments.push([copyStart, end]);
  let outLength = 0;
  for (const [s, e] of segments) outLength += Math.max(0, e - s);
  return { segments, outLength, wordStartsOut };
};
