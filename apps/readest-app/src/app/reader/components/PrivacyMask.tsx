import clsx from 'clsx';
import React from 'react';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import type { Insets } from '@/types/misc';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { isBookPrivate, isBookMasked, setBookMasked } from '@/utils/privacy';

interface PrivacyMaskProps {
  bookHash: string;
  gridInsets: Insets;
}

/**
 * Reader overlay for books the user marked "private" (see utils/privacy.ts).
 *
 * The mask is a solid theme-background layer sitting above the book content but
 * below the reader chrome (header/footer/TTS bar use z >= 40, the mask uses a
 * low z and is pointer-events-none), so it hides the text without blocking page
 * turns or any controls. The reveal toggle is remembered per book.
 */
const PrivacyMask: React.FC<PrivacyMaskProps> = ({ bookHash, gridInsets }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const iconSize = useResponsiveSize(20);

  if (!isBookPrivate(settings, bookHash)) return null;
  const masked = isBookMasked(settings, bookHash);

  const toggleMask = async () => {
    const current = useSettingsStore.getState().settings;
    const next = setBookMasked(current, bookHash, !isBookMasked(current, bookHash));
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  return (
    <>
      {masked && (
        <div
          className={clsx('bg-base-100 pointer-events-none absolute inset-0 z-[5]')}
          aria-hidden
        />
      )}
      <button
        onClick={toggleMask}
        className={clsx(
          'text-base-content bg-base-100/70 absolute right-2 z-50 rounded-full p-1.5',
          'shadow transition-transform duration-200 hover:scale-105',
        )}
        style={{ top: `${gridInsets.top + 48}px` }}
        title={masked ? _('Show Content') : _('Hide Content')}
        aria-label={masked ? _('Show Content') : _('Hide Content')}
      >
        {masked ? <MdVisibilityOff size={iconSize} /> : <MdVisibility size={iconSize} />}
      </button>
    </>
  );
};

export default PrivacyMask;
