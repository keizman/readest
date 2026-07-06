import { TTSWordBoundary } from '@/libs/edgeTTS';
import { TTSMark } from './types';
import { hasSpeakableText } from '@/utils/ssml';

const TICKS_PER_SECOND = 10_000_000;

// Group consecutive sentence-marks into one Edge request. After the fast-start
// batch, each request waits for at least this many characters and then extends
// through the next trailing punctuation so Edge handles pauses server-side.
export const BATCH_MAX_CHARS = 120;
// First playback uses a smaller budget so one short sentence synthesizes fast.
// Kept large enough that the first inter-batch boundary does not land seconds
// into playback (a 40-char peel at 3.0x outruns background prefetch).
export const STARTUP_BATCH_MAX_CHARS = 80;

// Trailing punctuation that ends a batch once BATCH_MAX_CHARS is met.
const TRAILING_PUNCTUATION_RE = /[,.!?;:、，；：·•…\u2026\-–—。！？]["'»」』)\]""']*$/u;

export const endsAtPunctuation = (text: string): boolean =>
  TRAILING_PUNCTUATION_RE.test(text.trimEnd());

const combinedText = (marks: TTSMark[]) => marks.map((m) => m.text).join('');

const appendMarks = (batches: TTSMark[][], marks: TTSMark[], startup: boolean): void => {
  if (marks.length === 0) return;
  batches.push(...buildBatches(marks, startup));
};

// Peel the latency-sensitive first batch, then batch the remainder at >=120.
const peelStartupBatch = (marks: TTSMark[]): { first: TTSMark[]; rest: TTSMark[] } => {
  const speakable = marks.filter((m) => hasSpeakableText(m.text));
  if (speakable.length === 0) return { first: [], rest: [] };

  const first: TTSMark[] = [];
  let len = 0;
  let i = 0;
  for (; i < speakable.length; i++) {
    const mark = speakable[i]!;
    const markLen = mark.text.length;
    if (first.length > 0 && len + markLen > STARTUP_BATCH_MAX_CHARS) break;
    first.push(mark);
    len += markLen;
  }
  return { first, rest: speakable.slice(i) };
};

// True when any post-startup batch is still under BATCH_MAX_CHARS (except EOF).
export const shouldCollectMoreParagraphs = (batches: TTSMark[][], startup: boolean): boolean => {
  if (batches.length === 0) return false;

  const startIdx = startup && batches.length > 0 ? 1 : 0;
  for (let i = startIdx; i < batches.length; i++) {
    const text = combinedText(batches[i]!);
    if (text.length < BATCH_MAX_CHARS) return true;
    if (!endsAtPunctuation(text)) return true;
  }

  const last = batches[batches.length - 1]!;
  const lastText = combinedText(last);
  if (lastText.length < BATCH_MAX_CHARS) return true;
  if (!endsAtPunctuation(lastText)) return true;
  return false;
};

export const buildBatches = (marks: TTSMark[], startup = false): TTSMark[][] => {
  const speakable = marks.filter((m) => hasSpeakableText(m.text));
  if (speakable.length === 0) return [];

  if (startup) {
    const { first, rest } = peelStartupBatch(speakable);
    const batches: TTSMark[][] = [];
    if (first.length > 0) batches.push(first);
    appendMarks(batches, rest, false);
    return batches;
  }

  const batches: TTSMark[][] = [];
  let current: TTSMark[] = [];
  let currentLen = 0;
  let currentLang: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    batches.push(current);
    current = [];
    currentLen = 0;
    currentLang = null;
  };

  for (const mark of speakable) {
    const len = mark.text.length;
    const sameLang = currentLang === null || mark.language === currentLang;

    if (current.length > 0 && !sameLang) {
      flush();
    }

    if (
      current.length > 0 &&
      currentLen >= BATCH_MAX_CHARS &&
      endsAtPunctuation(combinedText(current))
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
  const combined = batch.map((m) => m.text).join('');
  // `offset` is local to one parsed SSML paragraph and resets to zero when a
  // batch crosses into the next foliate paragraph. The Edge payload, however,
  // is exactly the concatenation above, so cumulative text lengths are the only
  // stable coordinate system across both sentence and paragraph boundaries.
  let combinedOffset = 0;
  const spanEnd = batch.map((mark) => (combinedOffset += mark.text.length));
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

// End of spoken content for a mark (excludes Edge's baked inter-sentence tail).
export const markSpeechEndSec = (
  perMarkBoundaries: TTSWordBoundary[],
  sliceEndSec: number,
  trailingKeepSec: number,
): number => {
  if (perMarkBoundaries.length === 0) return sliceEndSec;
  const last = perMarkBoundaries[perMarkBoundaries.length - 1]!;
  return Math.min(sliceEndSec, (last.offset + last.duration) / TICKS_PER_SECOND + trailingKeepSec);
};

export const rebaseBoundaries = (
  boundaries: TTSWordBoundary[],
  baseSec: number,
): TTSWordBoundary[] => {
  const baseTick = Math.round(baseSec * TICKS_PER_SECOND);
  return boundaries.map((b) => ({ ...b, offset: b.offset - baseTick }));
};
