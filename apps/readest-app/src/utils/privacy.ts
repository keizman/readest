import type { SystemSettings } from '@/types/settings';
import type { Book } from '@/types/book';

/**
 * Private-book state is local-only (never synced): a book is "private" when its
 * content hash is listed in `settings.privateBookHashes`. Opening a private book
 * masks its content until the user reveals it; the per-book reveal choice is
 * remembered in `settings.privateBookMaskStates` (hash -> masked), defaulting to
 * masked when no choice has been recorded yet.
 */
export const isBookPrivate = (settings: SystemSettings, hash: string): boolean =>
  (settings.privateBookHashes ?? []).includes(hash);

export const isBookMasked = (settings: SystemSettings, hash: string): boolean => {
  if (!isBookPrivate(settings, hash)) return false;
  const state = settings.privateBookMaskStates?.[hash];
  return state === undefined ? true : state;
};

/** Toggle the private flag for a book, returning a new settings object. */
export const setBookPrivate = (
  settings: SystemSettings,
  hash: string,
  isPrivate: boolean,
): SystemSettings => {
  const hashes = new Set(settings.privateBookHashes ?? []);
  const maskStates = { ...(settings.privateBookMaskStates ?? {}) };
  if (isPrivate) {
    hashes.add(hash);
    if (maskStates[hash] === undefined) maskStates[hash] = true;
  } else {
    hashes.delete(hash);
    delete maskStates[hash];
  }
  return { ...settings, privateBookHashes: [...hashes], privateBookMaskStates: maskStates };
};

/** Remember whether a private book is currently masked, returning new settings. */
export const setBookMasked = (
  settings: SystemSettings,
  hash: string,
  masked: boolean,
): SystemSettings => {
  const maskStates = { ...(settings.privateBookMaskStates ?? {}), [hash]: masked };
  return { ...settings, privateBookMaskStates: maskStates };
};

const ALIAS_MIN = 100_000;
const ALIAS_RANGE = 900_000;

const aliasNumberFromHash = (hash: string): number => {
  // FNV-1a gives a compact, deterministic pseudo-random number without
  // exposing any useful part of the book hash in the displayed alias.
  let value = 0x811c9dc5;
  for (let i = 0; i < hash.length; i++) {
    value ^= hash.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return ALIAS_MIN + ((value >>> 0) % ALIAS_RANGE);
};

const createUniqueAlias = (hash: string, usedAliases: Set<string>): string => {
  let number = aliasNumberFromHash(hash);
  let alias = `Book-${number}`;
  while (usedAliases.has(alias)) {
    number = ALIAS_MIN + ((number - ALIAS_MIN + 1) % ALIAS_RANGE);
    alias = `Book-${number}`;
  }
  return alias;
};

export const isLibraryPrivacyModeEnabled = (settings: SystemSettings): boolean =>
  settings.libraryPrivacyModeEnabled === true;

/** Add/update the local alias cache without changing whether privacy mode is enabled. */
export const ensureBookTitleAliases = (
  settings: SystemSettings,
  books: readonly Pick<Book, 'hash' | 'title'>[],
): SystemSettings => {
  const current = settings.privateBookTitleAliases ?? {};
  const aliases = { ...current };
  const usedAliases = new Set(Object.values(current).map((item) => item.alias));
  let changed = false;

  for (const book of books) {
    const existing = aliases[book.hash];
    if (existing) {
      if (existing.title !== book.title) {
        aliases[book.hash] = { ...existing, title: book.title };
        changed = true;
      }
      continue;
    }
    const alias = createUniqueAlias(book.hash, usedAliases);
    usedAliases.add(alias);
    aliases[book.hash] = { title: book.title, alias };
    changed = true;
  }

  return changed ? { ...settings, privateBookTitleAliases: aliases } : settings;
};

/** Toggle the global privacy mode while preserving cached aliases across off/on cycles. */
export const setLibraryPrivacyMode = (
  settings: SystemSettings,
  enabled: boolean,
  books: readonly Pick<Book, 'hash' | 'title'>[],
): SystemSettings => {
  const withAliases = enabled ? ensureBookTitleAliases(settings, books) : settings;
  if (withAliases.libraryPrivacyModeEnabled === enabled) return withAliases;
  return { ...withAliases, libraryPrivacyModeEnabled: enabled };
};

export const getBookTitleAlias = (settings: SystemSettings, hash: string): string | null => {
  if (!isLibraryPrivacyModeEnabled(settings)) return null;
  return settings.privateBookTitleAliases?.[hash]?.alias ?? null;
};

/** Return a title safe for user-facing UI, with a stable fallback before cache persistence. */
export const getBookDisplayTitle = (
  settings: SystemSettings,
  book: Pick<Book, 'hash' | 'title'>,
): string => {
  if (!isLibraryPrivacyModeEnabled(settings)) return book.title;
  return getBookTitleAlias(settings, book.hash) ?? `Book-${aliasNumberFromHash(book.hash)}`;
};
