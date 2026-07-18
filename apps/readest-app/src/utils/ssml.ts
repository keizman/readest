import { TTSMark } from '@/services/tts/types';
import { code6392to6391, inferLangFromScript, isSameLang, isValidLang } from './lang';

const cleanTextContent = (text: string) =>
  text.replace(/\r\n/g, '  ').replace(/\r/g, ' ').replace(/\n/g, ' ').trimStart();

const stripSSMLTags = (ssml: string): string => ssml.replace(/<[^>]+>/g, '');

const hasLanguageBearingText = (text: string): boolean => /\p{L}/u.test(text);

export const genSSML = (lang: string, text: string, voice: string, rate: number) => {
  const cleanedText = text.replace(/^<break\b[^>]*>/i, '');
  return `
    <speak version="1.0" xml:lang="${lang}">
      <voice name="${voice}">
        <prosody rate="${rate}" >
            ${cleanedText}
        </prosody>
      </voice>
    </speak>
  `;
};

export const genSSMLRaw = (text: string) => {
  return `
    <speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="-1"/>${text}</speak>
  `;
};

export const parseSSMLLang = (ssml: string, primaryLang?: string): string => {
  let lang = 'en';
  const speakTag = ssml.match(/<speak\b[^>]*>/i)?.[0] ?? '';
  const match = speakTag.match(/xml:lang\s*=\s*"([^"]+)"/);
  if (match && match[1]) {
    const parts = match[1].split('-');
    lang =
      parts.length > 1
        ? `${parts[0]!.toLowerCase()}-${parts[1]!.toUpperCase()}`
        : parts[0]!.toLowerCase();

    lang = code6392to6391(lang) || lang;
    if (!isValidLang(lang)) {
      lang = 'en';
    }
  }
  primaryLang = code6392to6391(primaryLang?.toLowerCase() || '') || primaryLang;
  if (lang === 'en' && primaryLang && !isSameLang(lang, primaryLang)) {
    lang = primaryLang.split('-')[0]!.toLowerCase();
  }
  const ssmlWithoutLangBlocks = ssml.replace(/<lang\b[^>]*>.*?<\/lang>/gis, '');
  const textOutsideLangBlocks = stripSSMLTags(ssmlWithoutLangBlocks);
  const textForScriptInference = hasLanguageBearingText(textOutsideLangBlocks)
    ? ssmlWithoutLangBlocks
    : ssml.replace(/<\/?lang\b[^>]*>/gi, '');
  return inferLangFromScript(textForScriptInference, lang, primaryLang);
};

const normalizeForSpeakability = (text: string): string =>
  text
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Z}/gu, '')
    .trim();

// Chinese web-novel text conventionally renders a dramatic pause as two
// consecutive ellipsis characters ("……"), and sometimes several literal
// periods in a row; other repeated punctuation ("!!!!", "????") shows up too.
// Edge's synthesis appears to render (and take proportionally longer to
// stream back) a baked-in pause per consecutive pause-mark rather than
// treating the run as a single pause, so text that visually reads as one
// trailing-off pause can turn into several stacked seconds of silence /
// synthesis latency. Collapsing runs down to one mark (or the conventional
// 3-dot ellipsis) keeps the same "trails off" meaning without asking Edge to
// render — and us to wait for — multiple pauses back to back.
export const collapseRepeatedPausePunctuation = (text: string): string =>
  text
    .replace(/…{2,}/gu, '…')
    .replace(/\.{4,}/g, '...')
    .replace(/([!?,;:、，。！？；：])\1{2,}/gu, '$1');

/** True when text contains something a speech engine can pronounce. */
export const hasSpeakableText = (text: string): boolean => {
  const trimmed = normalizeForSpeakability(text);
  if (!trimmed) return false;
  if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return false;
  return true;
};

// Edge / self-hosted proxies reject punctuation-only input. Treat these as
// permanent per-utterance failures so the client skips instead of halting.

/** True when the error message indicates empty audio from Edge / a relay. */
export const isEmptyAudioError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const m = error.message.toLowerCase();
  return m.includes('no audio data received') || m.includes('no audio was received');
};

/**
 * True only for *permanent* no-audio outcomes the caller should skip without retry.
 *
 * Upstream Edge / our relays intermittently return empty audio for speakable
 * text (rate limits, blips). Those must stay retryable. Only treat no-audio as
 * permanent when the text itself is unspeakable (punctuation/whitespace), or
 * when no text is provided (legacy single-path callers).
 *
 * After retries are exhausted, callers should still skip the batch via
 * {@link isEmptyAudioError} so a single bad sentence does not kill the session.
 */
export const isNoAudioSynthesisError = (error: unknown, text?: string): boolean => {
  if (!(error instanceof Error)) return false;
  const m = error.message.toLowerCase();
  if (isEmptyAudioError(error)) {
    if (text !== undefined) return !hasSpeakableText(text);
    return true;
  }
  if (text && !hasSpeakableText(text) && /edge tts http request failed: 5/.test(m)) {
    return true;
  }
  return false;
};

export const parseSSMLMarks = (ssml: string, primaryLang?: string) => {
  const defaultLang = parseSSMLLang(ssml, primaryLang) || 'en';
  ssml = ssml.replace(/<speak[^>]*>/i, '').replace(/<\/speak>/i, '');

  let plainText = '';
  const marks: TTSMark[] = [];

  let activeMark: string | null = null;
  let currentLang = defaultLang;
  const langStack: string[] = [];

  const tagRegex = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(ssml)) !== null) {
    if (match[4]) {
      const rawText = match[4];
      const text = cleanTextContent(rawText);
      if (text && activeMark && hasSpeakableText(text)) {
        const offset = plainText.length;
        plainText += text;
        marks.push({
          offset,
          name: activeMark,
          text,
          language: inferLangFromScript(text, currentLang, defaultLang) || currentLang,
        });
      } else {
        plainText += cleanTextContent(rawText);
      }
    } else {
      const isEnd = match[1] === '/';
      const tagName = match[2];
      const attr = match[3];

      if (tagName === 'mark' && !isEnd) {
        const nameMatch = attr?.match(/name="([^"]+)"/);
        if (nameMatch) {
          activeMark = nameMatch[1]!;
        }
      } else if (tagName === 'lang') {
        if (!isEnd) {
          langStack.push(currentLang);
          const langMatch = attr?.match(/xml:lang="([^"]+)"/);
          if (langMatch) {
            currentLang = langMatch[1]!;
          }
        } else {
          currentLang = langStack.pop() ?? defaultLang;
        }
      }
    }
  }

  return { plainText, marks };
};

export const findSSMLMark = (charIndex: number, marks: TTSMark[]) => {
  let left = 0;
  let right = marks.length - 1;
  let result: TTSMark | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const mark = marks[mid]!;

    if (mark.offset <= charIndex) {
      result = mark;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
};

export const filterSSMLWithLang = (
  ssml: string,
  targetLang: string,
  primaryLang?: string,
): string => {
  const mainLang = parseSSMLLang(ssml, primaryLang);

  // Normalize target language
  const normalizedTarget = code6392to6391(targetLang.toLowerCase()) || targetLang.toLowerCase();

  // Check if target matches main language
  if (isSameLang(normalizedTarget, mainLang)) {
    // Remove all <lang> blocks that don't match the main language
    return ssml.replace(/<lang\s+xml:lang="([^"]+)"[^>]*>.*?<\/lang>/gs, (match, langAttr) => {
      const blockLang = code6392to6391(langAttr.toLowerCase()) || langAttr.toLowerCase();
      // If the lang block matches the main language, keep it as is
      if (isSameLang(blockLang, mainLang)) {
        return match;
      }
      // Otherwise remove the entire block
      return '';
    });
  }

  // Check if target matches any <lang> block
  const langBlocks: Array<{ match: string; lang: string; content: string }> = [];
  const langBlockRegex = /<lang\s+xml:lang="([^"]+)"[^>]*>(.*?)<\/lang>/gs;
  let match: RegExpExecArray | null;

  const tempRegex = new RegExp(langBlockRegex.source, langBlockRegex.flags);
  while ((match = tempRegex.exec(ssml)) !== null) {
    const blockLang = code6392to6391(match[1]!.toLowerCase()) || match[1]!.toLowerCase();
    if (isSameLang(blockLang, normalizedTarget)) {
      langBlocks.push({
        match: match[0]!,
        lang: match[1]!,
        content: match[2]!,
      });
    }
  }

  if (langBlocks.length > 0) {
    const speakOpenMatch = ssml.match(/<speak[^>]*>/i);
    const speakCloseMatch = ssml.match(/<\/speak>/i);

    if (!speakOpenMatch || !speakCloseMatch) {
      return ssml;
    }

    const combinedContent = langBlocks.map((block) => block.match).join('');
    return `${speakOpenMatch[0]}${combinedContent}${speakCloseMatch[0]}`;
  }

  return ssml;
};
