import { describe, expect, it } from 'vitest';

import {
  ensureBookTitleAliases,
  getBookDisplayTitle,
  getBookTitleAlias,
  isBookMasked,
  isBookPrivate,
  setBookMasked,
  setBookPrivate,
  setLibraryPrivacyMode,
} from '@/utils/privacy';
import { Book } from '@/types/book';
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

  describe('library privacy mode', () => {
    const books = [
      { hash: 'hash-a', title: 'Sensitive A' },
      { hash: 'hash-b', title: 'Sensitive B' },
    ] as Book[];

    it('creates stable local aliases and keeps them when the mode is disabled', () => {
      const enabled = setLibraryPrivacyMode(baseSettings, true, books);
      const aliasA = getBookTitleAlias(enabled, 'hash-a');

      expect(aliasA).toMatch(/^Book-\d{6}$/);
      expect(enabled.privateBookTitleAliases?.['hash-a']?.title).toBe('Sensitive A');
      expect(getBookDisplayTitle(enabled, books[0]!)).toBe(aliasA);

      const disabled = setLibraryPrivacyMode(enabled, false, books);
      expect(getBookDisplayTitle(disabled, books[0]!)).toBe('Sensitive A');
      expect(disabled.privateBookTitleAliases?.['hash-a']?.alias).toBe(aliasA);

      const reenabled = setLibraryPrivacyMode(disabled, true, books);
      expect(getBookDisplayTitle(reenabled, books[0]!)).toBe(aliasA);
    });

    it('adds an alias for a book imported after privacy mode was enabled', () => {
      const enabled = setLibraryPrivacyMode(baseSettings, true, [books[0]!]);
      const updated = ensureBookTitleAliases(enabled, books);

      expect(getBookDisplayTitle(updated, books[1]!)).toMatch(/^Book-\d{6}$/);
      expect(updated.privateBookTitleAliases?.['hash-b']?.title).toBe('Sensitive B');
    });

    it('keeps aliases unique when generated numbers collide', () => {
      const collidingBooks = [
        { hash: 'same', title: 'One' },
        { hash: 'same\0', title: 'Two' },
      ] as Book[];
      const enabled = setLibraryPrivacyMode(baseSettings, true, collidingBooks);
      const aliases = Object.values(enabled.privateBookTitleAliases ?? {}).map(
        (item) => item.alias,
      );

      expect(new Set(aliases).size).toBe(aliases.length);
    });
  });
});
