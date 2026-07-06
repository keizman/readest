import { describe, expect, test } from 'vitest';

import {
  LONG_PAUSE_SEC,
  SHORT_PAUSE_SEC,
  classifyWordTrailingPause,
  findSpeechBounds,
  planSilenceCompression,
} from '@/services/tts/pcm';

const SR = 24000;

const makeSignal = (
  leadingSilenceSec: number,
  speechSec: number,
  trailingSilenceSec: number,
  noiseFloor = 0,
) => {
  const total = Math.round((leadingSilenceSec + speechSec + trailingSilenceSec) * SR);
  const samples = new Float32Array(total);
  const speechStart = Math.round(leadingSilenceSec * SR);
  const speechEnd = speechStart + Math.round(speechSec * SR);
  for (let i = 0; i < total; i++) {
    if (i >= speechStart && i < speechEnd) {
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    } else if (noiseFloor > 0) {
      // Deterministic pseudo-noise below the detection threshold, emulating
      // MP3 decoder dither/ringing in "silent" passages.
      samples[i] = noiseFloor * Math.sin((2 * Math.PI * 1731 * i) / SR + i * 0.7);
    }
  }
  return samples;
};

describe('findSpeechBounds', () => {
  test('trims leading and trailing silence with head/tail pads', () => {
    const samples = makeSignal(0.5, 1.0, 0.8);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBeGreaterThan(0.47 - 1e-6);
    expect(startSec).toBeLessThan(0.53);
    expect(endSec).toBeGreaterThan(1.44);
    expect(endSec).toBeLessThan(1.56 + 1e-6);
    expect(endSec).toBeGreaterThan(startSec);
  });

  test('ignores a realistic decoder noise floor in silent passages', () => {
    const samples = makeSignal(0.5, 1.0, 0.8, 0.0008);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBeGreaterThan(0.4);
    expect(startSec).toBeLessThan(0.53);
    expect(endSec).toBeGreaterThan(1.44);
    expect(endSec).toBeLessThan(1.6);
  });

  test('all-silence input returns the full range', () => {
    const samples = new Float32Array(SR); // 1s of zeros
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBe(0);
    expect(endSec).toBeCloseTo(1, 5);
  });

  test('empty input returns zero bounds', () => {
    const { startSec, endSec } = findSpeechBounds(new Float32Array(0), SR);
    expect(startSec).toBe(0);
    expect(endSec).toBe(0);
  });

  test('speech reaching the buffer edges clamps to the buffer', () => {
    const samples = makeSignal(0, 0.5, 0);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBe(0);
    expect(endSec).toBeCloseTo(0.5, 2);
  });
});

describe('classifyWordTrailingPause', () => {
  test('short pauses for comma, colon, and CJK clause punctuation', () => {
    expect(classifyWordTrailingPause('hello,')).toBe('short');
    expect(classifyWordTrailingPause('note:')).toBe('short');
    expect(classifyWordTrailingPause('你好，')).toBe('short');
    expect(classifyWordTrailingPause('注意：')).toBe('short');
    expect(classifyWordTrailingPause('第一、')).toBe('short');
    expect(classifyWordTrailingPause('wait;')).toBe('short');
  });

  test('long pauses for sentence enders', () => {
    expect(classifyWordTrailingPause('done.')).toBe('long');
    expect(classifyWordTrailingPause('really?')).toBe('long');
    expect(classifyWordTrailingPause('stop!')).toBe('long');
    expect(classifyWordTrailingPause('结束。')).toBe('long');
    expect(classifyWordTrailingPause('什么？')).toBe('long');
    expect(classifyWordTrailingPause('停下！')).toBe('long');
  });

  test('no trailing punctuation yields none', () => {
    expect(classifyWordTrailingPause('hello')).toBe('none');
    expect(classifyWordTrailingPause('世界')).toBe('none');
  });
});

describe('planSilenceCompression', () => {
  const sumSegments = (segments: Array<[number, number]>) =>
    segments.reduce((acc, [s, e]) => acc + (e - s), 0);
  const shortKeep = Math.round(SHORT_PAUSE_SEC * SR);
  const longKeep = Math.round(LONG_PAUSE_SEC * SR);
  const minGap = Math.round(0.015 * SR);
  const lead = Math.round(0.02 * SR);
  const tail = Math.round(0.02 * SR);
  const word0Start = Math.round(0.1 * SR);
  const word0End = Math.round(0.2 * SR);
  const word1Start = Math.round(0.45 * SR);
  const word1End = Math.round(0.55 * SR);
  const total = Math.round(1.0 * SR);

  test('empty word list keeps the whole buffer', () => {
    const plan = planSilenceCompression([], [], [], total, lead, tail, minGap, shortKeep, longKeep);
    expect(plan.segments).toEqual([[0, total]]);
    expect(plan.outLength).toBe(total);
    expect(plan.wordStartsOut).toEqual([]);
  });

  test('shrinks a long comma gap to the short pause and remaps later word starts', () => {
    const bakedGap = word1Start - word0End;
    const plan = planSilenceCompression(
      [word0Start, word1Start],
      [word0End, word1End],
      ['hello,', 'world'],
      total,
      lead,
      tail,
      minGap,
      shortKeep,
      longKeep,
    );
    const trimmedEnd = word1End + tail;
    const trimmedStart = word0Start - lead;
    expect(sumSegments(plan.segments)).toBe(plan.outLength);
    expect(plan.outLength).toBe(trimmedEnd - trimmedStart - (bakedGap - shortKeep));
    expect(plan.wordStartsOut[0]).toBe(word0Start - trimmedStart);
    expect(plan.wordStartsOut[1]).toBe(word1Start - trimmedStart - (bakedGap - shortKeep));
    const gapAfterCompression =
      plan.wordStartsOut[1]! - (plan.wordStartsOut[0]! + (word0End - word0Start));
    expect(gapAfterCompression).toBe(shortKeep);
  });

  test('removes the pause after a period within the chunk', () => {
    const bakedGap = word1Start - word0End;
    const plan = planSilenceCompression(
      [word0Start, word1Start],
      [word0End, word1End],
      ['done.', 'Next'],
      total,
      lead,
      tail,
      minGap,
      shortKeep,
      longKeep,
    );
    const gapAfterCompression =
      plan.wordStartsOut[1]! - (plan.wordStartsOut[0]! + (word0End - word0Start));
    expect(gapAfterCompression).toBe(0);
    expect(bakedGap).toBeGreaterThan(0);
  });

  test('removes inter-mark gaps when sentenceEndWordIndices is set', () => {
    const bakedGap = word1Start - word0End;
    const plan = planSilenceCompression(
      [word0Start, word1Start],
      [word0End, word1End],
      ['First', 'Second'],
      total,
      lead,
      tail,
      minGap,
      shortKeep,
      longKeep,
      new Set([0]),
    );
    const gapAfterCompression =
      plan.wordStartsOut[1]! - (plan.wordStartsOut[0]! + (word0End - word0Start));
    expect(gapAfterCompression).toBe(0);
    expect(bakedGap).toBeGreaterThan(0);
  });

  test('leaves natural short gaps untouched', () => {
    const nearWord1Start = word0End + Math.round(0.01 * SR);
    const nearWord1End = nearWord1Start + (word1End - word1Start);
    const plan = planSilenceCompression(
      [word0Start, nearWord1Start],
      [word0End, nearWord1End],
      ['one', 'two'],
      total,
      lead,
      tail,
      minGap,
      shortKeep,
      longKeep,
    );
    const trimmedEnd = nearWord1End + tail;
    const trimmedStart = word0Start - lead;
    expect(plan.segments).toEqual([[trimmedStart, trimmedEnd]]);
    expect(plan.outLength).toBe(trimmedEnd - trimmedStart);
    expect(plan.wordStartsOut).toEqual([word0Start - trimmedStart, nearWord1Start - trimmedStart]);
  });

  test('caps the trailing edge past the last word', () => {
    const plan = planSilenceCompression(
      [word0Start],
      [word0End],
      ['word'],
      total * 5,
      lead,
      tail,
      minGap,
      shortKeep,
      longKeep,
    );
    expect(plan.segments).toEqual([[word0Start - lead, word0End + tail]]);
    expect(plan.outLength).toBe(word0End + tail - (word0Start - lead));
  });
});
