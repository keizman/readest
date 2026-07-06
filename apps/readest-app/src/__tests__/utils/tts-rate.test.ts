import { describe, expect, it } from 'vitest';
import { TTS_RATE_OPTIONS } from '@/utils/ttsRate';

describe('TTS rate options', () => {
  it('includes the requested high-speed quarter-step options through 3.5x', () => {
    expect(TTS_RATE_OPTIONS).toEqual([
      0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5,
    ]);
  });
});
