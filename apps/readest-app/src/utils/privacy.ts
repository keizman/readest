import { SystemSettings } from '@/types/settings';

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
