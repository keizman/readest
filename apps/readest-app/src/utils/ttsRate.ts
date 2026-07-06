/** Discrete rates shared by the TTS panel and the full-screen RSVP controls. */
export const TTS_RATE_OPTIONS = [
  0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5,
] as const;

export const TTS_RATE_MIN = TTS_RATE_OPTIONS[0];
export const TTS_RATE_MAX = TTS_RATE_OPTIONS[TTS_RATE_OPTIONS.length - 1]!;
