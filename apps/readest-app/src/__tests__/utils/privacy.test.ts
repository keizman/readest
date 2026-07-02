import { describe, expect, it } from 'vitest';

import { isBookMasked, isBookPrivate, setBookMasked, setBookPrivate } from '@/utils/privacy';
import { SystemSettings } from '@/types/settings';

const baseSettings = {} as SystemSettings;

describe('privacy helpers', () => {
  it('reports a book as private only when listed', () => {
    expect(isBookPrivate(baseSettings, 'a')).toBe(false);
    const s = { ...baseSettings, privateBookHashes: ['a'] };
    expect(isBookPrivate(s, 'a')).toBe(true);
    expect(isBookPrivate(s, 'b')).toBe(false);
  });

  it('defaults a private book to masked when no choice recorded', () => {
    const s = { ...baseSettings, privateBookHashes: ['a'] };
    expect(isBookMasked(s, 'a')).toBe(true);
    expect(isBookMasked(baseSettings, 'a')).toBe(false); // not private -> not masked
  });

  it('remembers an explicit reveal choice', () => {
    const s = setBookMasked({ ...baseSettings, privateBookHashes: ['a'] }, 'a', false);
    expect(isBookMasked(s, 'a')).toBe(false);
    const s2 = setBookMasked(s, 'a', true);
    expect(isBookMasked(s2, 'a')).toBe(true);
  });

  it('marks and unmarks a book private, seeding masked=true on mark', () => {
    const marked = setBookPrivate(baseSettings, 'a', true);
    expect(isBookPrivate(marked, 'a')).toBe(true);
    expect(isBookMasked(marked, 'a')).toBe(true);

    const unmarked = setBookPrivate(marked, 'a', false);
    expect(isBookPrivate(unmarked, 'a')).toBe(false);
    expect(unmarked.privateBookMaskStates?.['a']).toBeUndefined();
  });

  it('does not mutate the input settings', () => {
    const s = { ...baseSettings, privateBookHashes: ['a'] };
    setBookPrivate(s, 'b', true);
    expect(s.privateBookHashes).toEqual(['a']);
  });
});
