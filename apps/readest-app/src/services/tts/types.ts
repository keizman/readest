export type TTSGranularity = 'sentence' | 'word';

export type TTSHighlightGranularity = 'word' | 'sentence';

export type TTSMediaMetadataMode = 'sentence' | 'paragraph' | 'chapter';

export type TTSHighlightOptions = {
  style: 'highlight' | 'underline' | 'strikethrough' | 'squiggly' | 'outline';
  color: string;
};

export type TTSVoice = {
  id: string;
  name: string;
  lang: string;
  disabled?: boolean;
};

export type TTSVoicesGroup = {
  id: string;
  name: string;
  voices: TTSVoice[];
  disabled?: boolean;
};

export type TTSMark = {
  offset: number;
  name: string;
  text: string;
  language: string;
  // Foliate range captured while the TTS iterator points at this mark's
  // paragraph. Required when marks span multiple paragraphs in one batch.
  range?: Range;
};
