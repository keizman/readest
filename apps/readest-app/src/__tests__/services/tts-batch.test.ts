import { describe, expect, test } from 'vitest';

import {
  BATCH_MAX_CHARS,
  STARTUP_BATCH_MAX_CHARS,
  buildBatches,
  endsAtPunctuation,
  markSpeechEndSec,
  partitionBatch,
  shouldCollectMoreParagraphs,
} from '@/services/tts/ttsBatch';
import { TTSMark } from '@/services/tts/types';

const mark = (name: string, text: string, language = 'en', offset = 0): TTSMark => ({
  name,
  text,
  language,
  offset,
});

describe('buildBatches', () => {
  test('merges marks under the normal char budget', () => {
    const batches = buildBatches([mark('0', 'a'.repeat(50)), mark('1', 'b'.repeat(50))]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.text).join('').length).toBe(100);
  });

  test('keeps growing past 120 chars until trailing punctuation', () => {
    const batches = buildBatches([mark('0', 'a'.repeat(80)), mark('1', 'b'.repeat(80))]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.text).join('').length).toBe(160);
  });

  test('closes a batch once it reaches 120 chars at punctuation', () => {
    const batches = buildBatches([
      mark('0', `${'a'.repeat(119)},`),
      mark('1', 'Next sentence.'),
      mark('2', 'Another one.'),
    ]);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((m) => m.text).join('').length).toBe(120);
    expect(endsAtPunctuation(batches[0]!.map((m) => m.text).join(''))).toBe(true);
  });

  test('uses a smaller first batch on startup', () => {
    const batches = buildBatches(
      [mark('0', 'a'.repeat(30)), mark('1', 'b'.repeat(30)), mark('2', 'c'.repeat(30))],
      true,
    );
    expect(batches[0]!.map((m) => m.text).join('').length).toBeLessThanOrEqual(
      STARTUP_BATCH_MAX_CHARS,
    );
    expect(BATCH_MAX_CHARS).toBe(120);
  });

  test('startup peels the first batch then requires 120+ chars for later requests', () => {
    const marks = Array.from({ length: 4 }, (_, i) =>
      mark(String(i), `${'句'.repeat(48)}。`, 'zh'),
    );
    const batches = buildBatches(marks, true);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((m) => m.text).join('').length).toBeLessThanOrEqual(
      STARTUP_BATCH_MAX_CHARS + 10,
    );
    expect(batches[1]!.map((m) => m.text).join('').length).toBeGreaterThanOrEqual(BATCH_MAX_CHARS);
  });

  test('never mixes languages in one batch', () => {
    const batches = buildBatches([mark('0', 'hello', 'en'), mark('1', 'bonjour', 'fr')]);
    expect(batches).toHaveLength(2);
  });

  test('skips punctuation-only marks', () => {
    const batches = buildBatches([mark('0', '……', 'zh')]);
    expect(batches).toHaveLength(0);
  });

  test('merges short paragraphs when batching across marks', () => {
    const paraA = mark('0', '短段落一。', 'zh');
    const paraB = mark('1', '短段落二。', 'zh');
    const paraC = mark('2', `${'中'.repeat(118)}。`, 'zh');
    const batches = buildBatches([paraA, paraB, paraC]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.text).join('').length).toBeGreaterThanOrEqual(BATCH_MAX_CHARS);
  });
});

describe('shouldCollectMoreParagraphs', () => {
  test('keeps collecting while the trailing batch is under 120 chars', () => {
    const batches = buildBatches([mark('0', 'a'.repeat(48))]);
    expect(shouldCollectMoreParagraphs(batches, false)).toBe(true);
  });

  test('stops once the trailing batch closes at punctuation with 120+ chars', () => {
    const batches = buildBatches([mark('0', `${'a'.repeat(119)},`)]);
    expect(shouldCollectMoreParagraphs(batches, false)).toBe(false);
  });

  test('startup keeps collecting after the fast-start batch', () => {
    const batches = buildBatches([mark('0', 'a'.repeat(30))], true);
    expect(shouldCollectMoreParagraphs(batches, true)).toBe(true);
  });

  test('startup keeps collecting while post-startup batches stay under 120 chars', () => {
    const marks = Array.from({ length: 3 }, (_, i) =>
      mark(String(i), `${'段'.repeat(48)}。`, 'zh'),
    );
    const batches = buildBatches(marks, true);
    expect(shouldCollectMoreParagraphs(batches, true)).toBe(true);
  });
});

describe('markSpeechEndSec', () => {
  test('ends at the last word boundary instead of the next mark start', () => {
    const boundaries = [{ offset: 10_000_000, duration: 5_000_000, text: 'done.' }];
    expect(markSpeechEndSec(boundaries, 2.5, 0.01)).toBeCloseTo(1.51, 2);
  });
});

describe('partitionBatch', () => {
  test('assigns combined boundaries back to each mark', () => {
    const batch = [mark('0', 'Hello world', 'en', 0), mark('1', 'Bye now', 'en', 11)];
    const { perMark, startSec } = partitionBatch(batch, [
      { offset: 1_000_000, duration: 4_000_000, text: 'Hello' },
      { offset: 6_000_000, duration: 4_000_000, text: 'world' },
      { offset: 16_000_000, duration: 4_000_000, text: 'Bye' },
      { offset: 21_000_000, duration: 4_000_000, text: 'now' },
    ]);
    expect(perMark[0]!.map((b) => b.text)).toEqual(['Hello', 'world']);
    expect(perMark[1]!.map((b) => b.text)).toEqual(['Bye', 'now']);
    expect(startSec[0]).toBeCloseTo(0.1, 5);
    expect(startSec[1]).toBeCloseTo(1.6, 5);
  });
});
