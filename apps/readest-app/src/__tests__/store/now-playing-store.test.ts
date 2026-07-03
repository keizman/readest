import { describe, test, expect, beforeEach } from 'vitest';
import { useNowPlayingStore, NowPlayingInfo } from '@/store/nowPlayingStore';

const sample = (overrides: Partial<NowPlayingInfo> = {}): NowPlayingInfo => ({
  bookHash: 'hash-1',
  bookId: 'hash-1',
  title: 'Book One',
  author: 'Author',
  coverImageUrl: 'cover.png',
  fraction: 0.25,
  isPlaying: true,
  ...overrides,
});

beforeEach(() => {
  useNowPlayingStore.setState({ nowPlaying: null, resumeRequestBookId: null });
});

describe('nowPlayingStore', () => {
  test('setNowPlaying stores the session', () => {
    useNowPlayingStore.getState().setNowPlaying(sample());
    expect(useNowPlayingStore.getState().nowPlaying).toEqual(sample());
  });

  test('updateNowPlaying patches an existing session', () => {
    useNowPlayingStore.getState().setNowPlaying(sample());
    useNowPlayingStore.getState().updateNowPlaying({ isPlaying: false, fraction: 0.5 });
    expect(useNowPlayingStore.getState().nowPlaying).toMatchObject({
      isPlaying: false,
      fraction: 0.5,
      bookId: 'hash-1',
    });
  });

  test('updateNowPlaying is a no-op when there is no session', () => {
    useNowPlayingStore.getState().updateNowPlaying({ isPlaying: false });
    expect(useNowPlayingStore.getState().nowPlaying).toBeNull();
  });

  test('clearNowPlaying removes the session', () => {
    useNowPlayingStore.getState().setNowPlaying(sample());
    useNowPlayingStore.getState().clearNowPlaying();
    expect(useNowPlayingStore.getState().nowPlaying).toBeNull();
  });

  test('consumeResume returns true once for the matching book, then clears', () => {
    useNowPlayingStore.getState().requestResume('hash-1');
    expect(useNowPlayingStore.getState().consumeResume('hash-1')).toBe(true);
    // Consumed — a second call returns false.
    expect(useNowPlayingStore.getState().consumeResume('hash-1')).toBe(false);
    expect(useNowPlayingStore.getState().resumeRequestBookId).toBeNull();
  });

  test('consumeResume returns false for a non-matching book and keeps the request', () => {
    useNowPlayingStore.getState().requestResume('hash-1');
    expect(useNowPlayingStore.getState().consumeResume('other')).toBe(false);
    expect(useNowPlayingStore.getState().resumeRequestBookId).toBe('hash-1');
  });
});
