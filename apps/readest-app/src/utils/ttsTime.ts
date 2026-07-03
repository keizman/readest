import { BookProgress } from '@/types/book';

const toSeconds = (minutes?: number) => {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return null;
  return Math.round(minutes * 60);
};

const getSafeRate = (rate?: number) => {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return 1;
  return rate;
};

const applyRate = (seconds: number | null, rate: number) => {
  if (seconds === null) return null;
  return Math.max(0, Math.round(seconds / rate));
};

const CJK_CHARACTER_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;
const SPOKEN_WORD_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/**
 * Estimate spoken wall-clock time from text using conservative audiobook rates.
 * CJK is character-paced (~270 chars/min); other scripts are word-paced
 * (~180 words/min). Keeping the estimate conservative ensures the prefetch
 * buffer does not fall short on weak networks.
 */
export const estimateSpeechDuration = (text: string, rate = 1): number => {
  const safeRate = getSafeRate(rate);
  const cjkCharacters = text.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  const nonCjkText = text.replace(CJK_CHARACTER_PATTERN, ' ');
  const words = nonCjkText.match(SPOKEN_WORD_PATTERN)?.length ?? 0;
  return (cjkCharacters / 4.5 + words / 3) / safeRate;
};

export type TTSTimeEstimate = {
  chapterRemainingSec: number | null;
  bookRemainingSec: number | null;
  finishAtTimestamp: number | null;
};

export const estimateTTSTime = (
  progress: BookProgress | null,
  rate?: number,
  now = Date.now(),
): TTSTimeEstimate => {
  const safeRate = getSafeRate(rate);
  const chapterRemainingBaseSec = toSeconds(progress?.timeinfo?.section);
  const bookRemainingBaseSec = toSeconds(progress?.timeinfo?.total);

  const chapterRemainingSec = applyRate(chapterRemainingBaseSec, safeRate);
  const bookRemainingSec = applyRate(bookRemainingBaseSec, safeRate);

  const finishAtTimestamp =
    bookRemainingSec !== null && bookRemainingSec > 0 ? now + bookRemainingSec * 1000 : null;

  return {
    chapterRemainingSec,
    bookRemainingSec,
    finishAtTimestamp,
  };
};
