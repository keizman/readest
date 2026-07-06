import { describe, expect, test } from 'vitest';

import {
  BATCH_MAX_CHARS,
  STARTUP_BATCH_MAX_CHARS,
  buildBatches,
  endsAtPunctuation,
  partitionBatch,
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

  test('never mixes languages in one batch', () => {
    const batches = buildBatches([mark('0', 'hello', 'en'), mark('1', 'bonjour', 'fr')]);
    expect(batches).toHaveLength(2);
  });

  test('skips punctuation-only marks', () => {
    const batches = buildBatches([mark('0', '……', 'zh')]);
    expect(batches).toHaveLength(0);
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
