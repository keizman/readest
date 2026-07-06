import { TTSWordBoundary } from '@/libs/edgeTTS';
import { TTSMark } from './types';
import { hasSpeakableText } from '@/utils/ssml';

const TICKS_PER_SECOND = 10_000_000;

// Group consecutive sentence-marks into one Edge request. After the fast-start
// batch, each request waits for at least this many characters and then extends
// through the next trailing punctuation so Edge handles pauses server-side.
export const BATCH_MAX_CHARS = 120;
// First playback uses a smaller budget so one short sentence synthesizes fast.
export const STARTUP_BATCH_MAX_CHARS = 40;

// Trailing punctuation that ends a batch once BATCH_MAX_CHARS is met.
const TRAILING_PUNCTUATION_RE = /[,.!?;:、，；：·•…\u2026\-–—。！？]["'»」』)\]""']*$/u;

export const endsAtPunctuation = (text: string): boolean =>
  TRAILING_PUNCTUATION_RE.test(text.trimEnd());

export const buildBatches = (marks: TTSMark[], startup = false): TTSMark[][] => {
  const batches: TTSMark[][] = [];
  let current: TTSMark[] = [];
  let currentLen = 0;
  let currentLang: string | null = null;

  const combinedText = () => current.map((m) => m.text).join('');
  const flush = () => {
    if (current.length === 0) return;
    batches.push(current);
    current = [];
    currentLen = 0;
    currentLang = null;
  };

  for (const mark of marks) {
    if (!hasSpeakableText(mark.text)) continue;
    const len = mark.text.length;
    const sameLang = currentLang === null || mark.language === currentLang;

    if (current.length > 0 && !sameLang) {
      flush();
    }

    const isFastStartBatch = startup && batches.length === 0;
    if (isFastStartBatch) {
      if (current.length > 0 && currentLen + len > STARTUP_BATCH_MAX_CHARS) {
        flush();
      }
    } else if (
      current.length > 0 &&
      currentLen >= BATCH_MAX_CHARS &&
      endsAtPunctuation(combinedText())
    ) {
      flush();
    }

    current.push(mark);
    currentLen += len;
    currentLang = mark.language;
  }
  flush();
  return batches;
};

export interface BatchPartition {
  perMark: TTSWordBoundary[][];
  startSec: number[];
}

// Split combined word-boundaries of a batched mp3 back to each sentence mark.
export const partitionBatch = (batch: TTSMark[], boundaries: TTSWordBoundary[]): BatchPartition => {
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
};

export const markSliceRangeSec = (
  batch: TTSMark[],
  startSec: number[],
  markIndex: number,
  bufferDurationSec: number,
): { startSec: number; endSec: number } => {
  const start = startSec[markIndex] ?? 0;
  const end =
    markIndex + 1 < batch.length
      ? (startSec[markIndex + 1] ?? bufferDurationSec)
      : bufferDurationSec;
  return { startSec: start, endSec: Math.min(end, bufferDurationSec) };
};

export const rebaseBoundaries = (
  boundaries: TTSWordBoundary[],
  baseSec: number,
): TTSWordBoundary[] => {
  const baseTick = Math.round(baseSec * TICKS_PER_SECOND);
  return boundaries.map((b) => ({ ...b, offset: b.offset - baseTick }));
};
