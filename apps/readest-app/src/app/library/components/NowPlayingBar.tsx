import clsx from 'clsx';
import React from 'react';
import { useRouter } from 'next/navigation';
import { MdClose, MdPlayArrow, MdPause, MdMenuBook } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useNowPlayingStore } from '@/store/nowPlayingStore';
import { stopDetachedTTS } from '@/app/reader/hooks/useTTSControl';
import { navigateToReader } from '@/utils/nav';

/**
 * "Now playing" / continue-listening bar shown at the top of the library. It
 * reflects the active TTS session (see store/nowPlayingStore.ts) so the user can
 * jump back to the book and resume playback after returning to the shelf.
 */
const NowPlayingBar: React.FC = () => {
  const _ = useTranslation();
  const router = useRouter();
  const iconSize = useResponsiveSize(20);
  const nowPlaying = useNowPlayingStore((s) => s.nowPlaying);
  const requestResume = useNowPlayingStore((s) => s.requestResume);
  const clearNowPlaying = useNowPlayingStore((s) => s.clearNowPlaying);

  if (!nowPlaying) return null;

  const percent = Math.round(Math.max(0, Math.min(1, nowPlaying.fraction)) * 100);

  const handleOpen = () => {
    requestResume(nowPlaying.bookId);
    navigateToReader(router, [nowPlaying.bookId]);
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopDetachedTTS();
    clearNowPlaying();
  };

  return (
    <div className='px-4 pt-2'>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        role='button'
        tabIndex={0}
        onClick={handleOpen}
        aria-label={_('Resume listening')}
        className={clsx(
          'bg-base-100 border-base-300 flex items-center gap-3 rounded-xl border p-2 shadow-sm',
          'cursor-pointer transition-transform duration-200 hover:scale-[1.01]',
        )}
      >
        <div className='bg-base-300 relative h-12 w-9 shrink-0 overflow-hidden rounded'>
          {nowPlaying.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={nowPlaying.coverImageUrl}
              alt={nowPlaying.title}
              className='h-full w-full object-cover'
            />
          ) : (
            <div className='text-base-content/40 flex h-full w-full items-center justify-center'>
              <MdMenuBook size={iconSize} />
            </div>
          )}
        </div>
        <div className='min-w-0 flex-grow'>
          <div className='truncate text-sm font-medium'>{nowPlaying.title}</div>
          {nowPlaying.author && (
            <div className='text-base-content/60 truncate text-xs'>{nowPlaying.author}</div>
          )}
          <div className='mt-1 flex items-center gap-2'>
            <progress
              className='progress progress-success h-1 flex-grow'
              value={percent}
              max='100'
            />
            <span className='text-base-content/60 shrink-0 text-xs tabular-nums'>{percent}%</span>
          </div>
        </div>
        <div className='text-base-content/80 flex h-9 w-9 shrink-0 items-center justify-center'>
          {nowPlaying.isPlaying ? <MdPause size={iconSize} /> : <MdPlayArrow size={iconSize} />}
        </div>
        <button
          onClick={handleDismiss}
          className='text-base-content/50 hover:bg-base-300 flex h-8 w-8 shrink-0 items-center justify-center rounded-full'
          aria-label={_('Dismiss')}
          title={_('Dismiss')}
        >
          <MdClose size={iconSize} />
        </button>
      </div>
    </div>
  );
};

export default NowPlayingBar;
