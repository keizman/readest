import { md5 } from 'js-md5';
import WebSocket from 'isomorphic-ws';
import { randomMd5 } from '@/utils/misc';
import { FIFOCache } from '@/utils/lru';
import { genSSML } from '@/utils/ssml';
import {
  getEdgeTTSAuthHeaders,
  getEdgeTTSBaseUrl,
  getEdgeTTSWsUrl,
  isTauriAppPlatform,
  withEdgeTTSAuthQuery,
} from '@/services/environment';
import { edgeTTSBackends } from '@/libs/edgeTTSBackends';

// Cloudflare Workers expose a global `WebSocketPair` that is not available in
// browsers or Node.js. The Node `ws` package (used transitively via
// `isomorphic-ws`) cannot run on Workers because it relies on
// `http.createConnection`, which the Workers runtime does not implement.
// Detecting Workers lets us use the fetch-based WebSocket upgrade pattern
// (`fetch(..., { headers: { Upgrade: 'websocket' } })`) instead.
const isCloudflareWorkers = () =>
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined';

// The WebSocket returned by a Cloudflare Workers upgrade response must be
// `accept()`ed before use. This minimal interface captures the bits we need
// without pulling in `@cloudflare/workers-types`.
interface AcceptableWebSocket {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

type UpgradeResponse = Response & { webSocket?: AcceptableWebSocket };

const EDGE_SPEECH_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_API_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];

const EDGE_TTS_VOICES = {
  'af-ZA': ['af-ZA-AdriNeural', 'af-ZA-WillemNeural'],
  'am-ET': ['am-ET-AmehaNeural', 'am-ET-MekdesNeural'],
  'ar-AE': ['ar-AE-FatimaNeural', 'ar-AE-HamdanNeural'],
  'ar-BH': ['ar-BH-AliNeural', 'ar-BH-LailaNeural'],
  'ar-DZ': ['ar-DZ-AminaNeural', 'ar-DZ-IsmaelNeural'],
  'ar-EG': ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural'],
  'ar-IQ': ['ar-IQ-BasselNeural', 'ar-IQ-RanaNeural'],
  'ar-JO': ['ar-JO-SanaNeural', 'ar-JO-TaimNeural'],
  'ar-KW': ['ar-KW-FahedNeural', 'ar-KW-NouraNeural'],
  'ar-LB': ['ar-LB-LaylaNeural', 'ar-LB-RamiNeural'],
  'ar-LY': ['ar-LY-ImanNeural', 'ar-LY-OmarNeural'],
  'ar-MA': ['ar-MA-JamalNeural', 'ar-MA-MounaNeural'],
  'ar-OM': ['ar-OM-AbdullahNeural', 'ar-OM-AyshaNeural'],
  'ar-QA': ['ar-QA-AmalNeural', 'ar-QA-MoazNeural'],
  'ar-SA': ['ar-SA-HamedNeural', 'ar-SA-ZariyahNeural'],
  'ar-SY': ['ar-SY-AmanyNeural', 'ar-SY-LaithNeural'],
  'ar-TN': ['ar-TN-HediNeural', 'ar-TN-ReemNeural'],
  'ar-YE': ['ar-YE-MaryamNeural', 'ar-YE-SalehNeural'],
  'az-AZ': ['az-AZ-BabekNeural', 'az-AZ-BanuNeural'],
  'bg-BG': ['bg-BG-BorislavNeural', 'bg-BG-KalinaNeural'],
  'bn-BD': ['bn-BD-NabanitaNeural', 'bn-BD-PradeepNeural'],
  'bn-IN': ['bn-IN-BashkarNeural', 'bn-IN-TanishaaNeural'],
  'bs-BA': ['bs-BA-GoranNeural', 'bs-BA-VesnaNeural'],
  'ca-ES': ['ca-ES-EnricNeural', 'ca-ES-JoanaNeural'],
  'cs-CZ': ['cs-CZ-AntoninNeural', 'cs-CZ-VlastaNeural'],
  'cy-GB': ['cy-GB-AledNeural', 'cy-GB-NiaNeural'],
  'da-DK': ['da-DK-ChristelNeural', 'da-DK-JeppeNeural'],
  'de-AT': ['de-AT-IngridNeural', 'de-AT-JonasNeural'],
  'de-CH': ['de-CH-JanNeural', 'de-CH-LeniNeural'],
  'de-DE': [
    'de-DE-AmalaNeural',
    'de-DE-ConradNeural',
    'de-DE-FlorianMultilingualNeural',
    'de-DE-KatjaNeural',
    'de-DE-KillianNeural',
    'de-DE-SeraphinaMultilingualNeural',
  ],
  'el-GR': ['el-GR-AthinaNeural', 'el-GR-NestorasNeural'],
  'en-AU': ['en-AU-NatashaNeural', 'en-AU-WilliamNeural'],
  'en-CA': ['en-CA-ClaraNeural', 'en-CA-LiamNeural'],
  'en-GB': [
    'en-GB-LibbyNeural',
    'en-GB-MaisieNeural',
    'en-GB-RyanNeural',
    'en-GB-SoniaNeural',
    'en-GB-ThomasNeural',
  ],
  'en-HK': ['en-HK-SamNeural', 'en-HK-YanNeural'],
  'en-IE': ['en-IE-ConnorNeural', 'en-IE-EmilyNeural'],
  'en-IN': ['en-IN-NeerjaExpressiveNeural', 'en-IN-NeerjaNeural', 'en-IN-PrabhatNeural'],
  'en-KE': ['en-KE-AsiliaNeural', 'en-KE-ChilembaNeural'],
  'en-NG': ['en-NG-AbeoNeural', 'en-NG-EzinneNeural'],
  'en-NZ': ['en-NZ-MitchellNeural', 'en-NZ-MollyNeural'],
  'en-PH': ['en-PH-JamesNeural', 'en-PH-RosaNeural'],
  'en-SG': ['en-SG-LunaNeural', 'en-SG-WayneNeural'],
  'en-TZ': ['en-TZ-ElimuNeural', 'en-TZ-ImaniNeural'],
  'en-US': [
    'en-US-AnaNeural',
    'en-US-AndrewMultilingualNeural',
    'en-US-AndrewNeural',
    'en-US-AriaNeural',
    'en-US-AvaMultilingualNeural',
    'en-US-AvaNeural',
    'en-US-BrianMultilingualNeural',
    'en-US-BrianNeural',
    'en-US-ChristopherNeural',
    'en-US-EmmaMultilingualNeural',
    'en-US-EmmaNeural',
    'en-US-EricNeural',
    'en-US-GuyNeural',
    'en-US-JennyNeural',
    'en-US-MichelleNeural',
    'en-US-RogerNeural',
    'en-US-SteffanNeural',
  ],
  'es-AR': ['es-AR-ElenaNeural', 'es-AR-TomasNeural'],
  'es-BO': ['es-BO-MarceloNeural', 'es-BO-SofiaNeural'],
  'es-CL': ['es-CL-CatalinaNeural', 'es-CL-LorenzoNeural'],
  'es-CO': ['es-CO-GonzaloNeural', 'es-CO-SalomeNeural'],
  'es-CR': ['es-CR-JuanNeural', 'es-CR-MariaNeural'],
  'es-CU': ['es-CU-BelkysNeural', 'es-CU-ManuelNeural'],
  'es-DO': ['es-DO-EmilioNeural', 'es-DO-RamonaNeural'],
  'es-EC': ['es-EC-AndreaNeural', 'es-EC-LuisNeural'],
  'es-ES': ['es-ES-AlvaroNeural', 'es-ES-ElviraNeural', 'es-ES-XimenaNeural'],
  'es-US': ['es-US-AlonsoNeural', 'es-US-PalomaNeural'],
  'et-EE': ['et-EE-AnuNeural', 'et-EE-KertNeural'],
  'fa-IR': ['fa-IR-DilaraNeural', 'fa-IR-FaridNeural'],
  'fi-FI': ['fi-FI-HarriNeural', 'fi-FI-NooraNeural'],
  'fil-PH': ['fil-PH-AngeloNeural', 'fil-PH-BlessicaNeural'],
  'fr-BE': ['fr-BE-CharlineNeural', 'fr-BE-GerardNeural'],
  'fr-CA': ['fr-CA-AntoineNeural', 'fr-CA-JeanNeural', 'fr-CA-SylvieNeural', 'fr-CA-ThierryNeural'],
  'fr-CH': ['fr-CH-ArianeNeural', 'fr-CH-FabriceNeural'],
  'fr-FR': [
    'fr-FR-DeniseNeural',
    'fr-FR-EloiseNeural',
    'fr-FR-HenriNeural',
    'fr-FR-RemyMultilingualNeural',
    'fr-FR-VivienneMultilingualNeural',
  ],
  'ga-IE': ['ga-IE-ColmNeural', 'ga-IE-OrlaNeural'],
  'gl-ES': ['gl-ES-RoiNeural', 'gl-ES-SabelaNeural'],
  'gu-IN': ['gu-IN-DhwaniNeural', 'gu-IN-NiranjanNeural'],
  'he-IL': ['he-IL-AvriNeural', 'he-IL-HilaNeural'],
  'hi-IN': ['hi-IN-MadhurNeural', 'hi-IN-SwaraNeural'],
  'hr-HR': ['hr-HR-GabrijelaNeural', 'hr-HR-SreckoNeural'],
  'hu-HU': ['hu-HU-NoemiNeural', 'hu-HU-TamasNeural'],
  'id-ID': ['id-ID-ArdiNeural', 'id-ID-GadisNeural'],
  'is-IS': ['is-IS-GudrunNeural', 'is-IS-GunnarNeural'],
  'it-IT': [
    'it-IT-DiegoNeural',
    'it-IT-ElsaNeural',
    'it-IT-GiuseppeMultilingualNeural',
    'it-IT-IsabellaNeural',
  ],
  'iu-Cans-CA': ['iu-Cans-CA-SiqiniqNeural', 'iu-Cans-CA-TaqqiqNeural'],
  'iu-Latn-CA': ['iu-Latn-CA-SiqiniqNeural', 'iu-Latn-CA-TaqqiqNeural'],
  'ja-JP': ['ja-JP-KeitaNeural', 'ja-JP-NanamiNeural'],
  'jv-ID': ['jv-ID-DimasNeural', 'jv-ID-SitiNeural'],
  'ka-GE': ['ka-GE-EkaNeural', 'ka-GE-GiorgiNeural'],
  'kk-KZ': ['kk-KZ-AigulNeural', 'kk-KZ-DauletNeural'],
  'km-KH': ['km-KH-PisethNeural', 'km-KH-SreymomNeural'],
  'kn-IN': ['kn-IN-GaganNeural', 'kn-IN-SapnaNeural'],
  'ko-KR': ['ko-KR-HyunsuMultilingualNeural', 'ko-KR-InJoonNeural', 'ko-KR-SunHiNeural'],
  'lo-LA': ['lo-LA-ChanthavongNeural', 'lo-LA-KeomanyNeural'],
  'lt-LT': ['lt-LT-LeonasNeural', 'lt-LT-OnaNeural'],
  'lv-LV': ['lv-LV-EveritaNeural', 'lv-LV-NilsNeural'],
  'mk-MK': ['mk-MK-AleksandarNeural', 'mk-MK-MarijaNeural'],
  'ml-IN': ['ml-IN-MidhunNeural', 'ml-IN-SobhanaNeural'],
  'mn-MN': ['mn-MN-BataaNeural', 'mn-MN-YesuiNeural'],
  'mr-IN': ['mr-IN-AarohiNeural', 'mr-IN-ManoharNeural'],
  'ms-MY': ['ms-MY-OsmanNeural', 'ms-MY-YasminNeural'],
  'mt-MT': ['mt-MT-GraceNeural', 'mt-MT-JosephNeural'],
  'my-MM': ['my-MM-NilarNeural', 'my-MM-ThihaNeural'],
  'nb-NO': ['nb-NO-FinnNeural', 'nb-NO-PernilleNeural'],
  'ne-NP': ['ne-NP-HemkalaNeural', 'ne-NP-SagarNeural'],
  'nl-BE': ['nl-BE-ArnaudNeural', 'nl-BE-DenaNeural'],
  'nl-NL': ['nl-NL-ColetteNeural', 'nl-NL-FennaNeural', 'nl-NL-MaartenNeural'],
  'pl-PL': ['pl-PL-MarekNeural', 'pl-PL-ZofiaNeural'],
  'ps-AF': ['ps-AF-GulNawazNeural', 'ps-AF-LatifaNeural'],
  'pt-BR': ['pt-BR-AntonioNeural', 'pt-BR-FranciscaNeural', 'pt-BR-ThalitaMultilingualNeural'],
  'pt-PT': ['pt-PT-DuarteNeural', 'pt-PT-RaquelNeural'],
  'ro-RO': ['ro-RO-AlinaNeural', 'ro-RO-EmilNeural'],
  'ru-RU': ['ru-RU-DmitryNeural', 'ru-RU-SvetlanaNeural'],
  'si-LK': ['si-LK-SameeraNeural', 'si-LK-ThiliniNeural'],
  'sk-SK': ['sk-SK-LukasNeural', 'sk-SK-ViktoriaNeural'],
  'sl-SI': ['sl-SI-PetraNeural', 'sl-SI-RokNeural'],
  'so-SO': ['so-SO-MuuseNeural', 'so-SO-UbaxNeural'],
  'sq-AL': ['sq-AL-AnilaNeural', 'sq-AL-IlirNeural'],
  'sr-RS': ['sr-RS-NicholasNeural', 'sr-RS-SophieNeural'],
  'su-ID': ['su-ID-JajangNeural', 'su-ID-TutiNeural'],
  'sv-SE': ['sv-SE-MattiasNeural', 'sv-SE-SofieNeural'],
  'sw-KE': ['sw-KE-RafikiNeural', 'sw-KE-ZuriNeural'],
  'sw-TZ': ['sw-TZ-DaudiNeural', 'sw-TZ-RehemaNeural'],
  'ta-IN': ['ta-IN-PallaviNeural', 'ta-IN-ValluvarNeural'],
  'ta-LK': ['ta-LK-KumarNeural', 'ta-LK-SaranyaNeural'],
  'ta-MY': ['ta-MY-KaniNeural', 'ta-MY-SuryaNeural'],
  'ta-SG': ['ta-SG-AnbuNeural', 'ta-SG-VenbaNeural'],
  'te-IN': ['te-IN-MohanNeural', 'te-IN-ShrutiNeural'],
  'th-TH': ['th-TH-NiwatNeural', 'th-TH-PremwadeeNeural'],
  'tr-TR': ['tr-TR-AhmetNeural', 'tr-TR-EmelNeural'],
  'uk-UA': ['uk-UA-OstapNeural', 'uk-UA-PolinaNeural'],
  'ur-IN': ['ur-IN-GulNeural', 'ur-IN-SalmanNeural'],
  'ur-PK': ['ur-PK-AsadNeural', 'ur-PK-UzmaNeural'],
  'uz-UZ': ['uz-UZ-MadinaNeural', 'uz-UZ-SardorNeural'],
  'vi-VN': ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'],
  'zh-CN': [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-XiaoyiNeural',
    'zh-CN-YunjianNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-YunxiaNeural',
    'zh-CN-YunyangNeural',
    'zh-CN-liaoning-XiaobeiNeural',
    'zh-CN-shaanxi-XiaoniNeural',
  ],
  'zh-HK': ['zh-HK-HiuGaaiNeural', 'zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural'],
  'zh-TW': ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural'],
  'zu-ZA': ['zu-ZA-ThandoNeural', 'zu-ZA-ThembaNeural'],
};

/**
 * Generates the Sec-MS-GEC token value.
 * This function generates a token value based on the current time in Windows file time format
 * adjusted for clock skew, and rounded down to the nearest 5 minutes. The token is then hashed
 * using SHA256 and returned as an uppercased hex digest.
 *
 * @returns The generated Sec-MS-GEC token value.
 * @see https://github.com/rany2/edge-tts/issues/290#issuecomment-2464956570
 */
const WIN_EPOCH_OFFSET = 11644473600; // Windows epoch offset in seconds (1601 to 1970)
const S_TO_NS = 1000000000; // Seconds to nanoseconds conversion
const generateSecMsGec = async () => {
  let ticks = Math.floor(Date.now() / 1000);
  // Switch to Windows file time epoch (1601-01-01 00:00:00 UTC)
  ticks += WIN_EPOCH_OFFSET;
  // Round down to the nearest 5 minutes (300 seconds)
  ticks -= ticks % 300;
  // Convert the ticks to 100-nanosecond intervals (Windows file time format)
  ticks *= S_TO_NS / 100;
  // Create the string to hash by concatenating the ticks and the trusted client token
  const strToHash = `${ticks.toFixed(0)}${EDGE_API_TOKEN}`;
  // Compute the SHA256 hash and return the uppercased hex digest
  const encoder = new TextEncoder();
  const data = encoder.encode(strToHash);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
};

const generateMuid = () => {
  // Generate 16 random bytes (32 hex characters)
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);

  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
};

const genVoiceList = (voices: Record<string, string[]>) => {
  return Object.entries(voices).flatMap(([lang, voices]) => {
    return voices.map((id) => {
      const name = id.replace(`${lang}-`, '').replace('Neural', '');
      return { name, id, lang };
    });
  });
};

export interface EdgeTTSPayload {
  lang: string;
  text: string;
  voice: string;
  rate: number;
  pitch: number;
}

// A word boundary reported by the Edge TTS service via `audio.metadata`
// frames. Offsets and durations are in 100-nanosecond ticks relative to the
// start of the audio stream; `text` is the verbatim span of the input text.
export interface TTSWordBoundary {
  offset: number;
  duration: number;
  text: string;
}

interface AudioMetadataEntry {
  Type?: string;
  Data?: {
    Offset?: number;
    Duration?: number;
    text?: { Text?: string };
  };
}

export const parseAudioMetadataBody = (body: string): TTSWordBoundary[] => {
  try {
    const parsed = JSON.parse(body) as { Metadata?: AudioMetadataEntry[] };
    const boundaries: TTSWordBoundary[] = [];
    for (const entry of parsed.Metadata ?? []) {
      if (entry.Type !== 'WordBoundary') continue;
      const offset = entry.Data?.Offset;
      const text = entry.Data?.text?.Text;
      if (typeof offset !== 'number' || typeof text !== 'string' || !text) continue;
      boundaries.push({ offset, duration: entry.Data?.Duration ?? 0, text });
    }
    return boundaries;
  } catch {
    return [];
  }
};

export interface EdgeSpeechAudio {
  response: Response;
  boundaries: TTSWordBoundary[];
}

// Response header used to carry word boundaries through the authenticated
// HTTPS proxy route (`/api/tts/edge`), which streams only the audio body.
export const WORD_BOUNDARIES_HEADER = 'X-TTS-Word-Boundaries';
export const TTS_ACCEPT_ENCODING_HEADER = 'X-TTS-Accept-Encoding';
export const TTS_ACCEPT_ENCODING_VALUE = 'gzip';

// HTTP header values must be ASCII, but boundary `text` can be any script
// (em-dashes, CJK, accents). Percent-encode the JSON so the header stays
// ASCII-safe across Node, browsers, and Cloudflare Workers.
export const serializeWordBoundaries = (boundaries: TTSWordBoundary[]): string =>
  encodeURIComponent(JSON.stringify(boundaries));

export const parseWordBoundariesHeader = (value: string | null): TTSWordBoundary[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b: unknown): b is TTSWordBoundary =>
        !!b &&
        typeof (b as TTSWordBoundary).offset === 'number' &&
        typeof (b as TTSWordBoundary).duration === 'number' &&
        typeof (b as TTSWordBoundary).text === 'string',
    );
  } catch {
    return [];
  }
};

export const hashTTSPayload = (payload: EdgeTTSPayload): string => {
  const base = JSON.stringify(payload);
  return md5(base);
};

export type EDGE_TTS_PROTOCOL = 'wss' | 'https';

// Concurrent self-hosted WS synthesis requests one relay can absorb without
// degrading (preload + playback share these slots). This is the *per-backend*
// budget; the effective pool-wide limit scales with the number of configured
// relays (see getEdgeTTSWsMaxConcurrent). Kept exported under the historical
// name so the startup preload / tests still read a stable single-relay value.
export const TTS_WS_MAX_CONCURRENT = 4;

// Pool-wide max concurrent self-hosted WS requests. The round-robin balancer
// (edgeTTSBackends) spreads simultaneous requests across every healthy relay,
// so N backends can safely keep N * per-backend requests in flight. With three
// relays this is 6, which is what "unlocks" the deep look-ahead pipeline that
// was previously bottlenecked at a single relay's budget. Falls back to one
// relay's budget when only a single URL is configured (or the pool is empty,
// e.g. bing-direct, where the WS slot gate is not used at all).
export const getEdgeTTSWsMaxConcurrent = (): number =>
  TTS_WS_MAX_CONCURRENT * Math.max(1, edgeTTSBackends.getBackendUrls().length);

// Backstop for a synthesis request that never resolves because the socket
// closes/hangs without ever delivering a close or error event (observed with
// some reverse proxies on connection reset). Without this, a single dropped
// connection could wedge playback forever instead of retrying. See #4954.
const WS_REQUEST_TIMEOUT_MS = 15000;

// Playback-critical fetches (the sentence about to be scheduled) must not
// queue behind background paragraph prefetch for the same WS concurrency
// slots, or an in-progress paragraph stalls waiting on unrelated lookahead
// work. 'high' priority requests jump the wait queue; prefetch stays 'low'.
export type WsSlotPriority = 'high' | 'low';

const wsAbortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

// 'self-hosted' connects to getEdgeTTSWsUrl(); 'bing' hits Microsoft directly.
export type EdgeTTSWsTarget = 'self-hosted' | 'bing';

export type EdgeSpeechTTSOptions = {
  protocol?: EDGE_TTS_PROTOCOL;
  wsTarget?: EdgeTTSWsTarget;
};

// Edge's MP3 bitrate varies by voice/service path and is commonly higher than
// the optimistic 48 kbit/s estimate. Keep a hard byte cap large enough for a
// real multi-minute lookahead at 2x+ speed without evicting future chunks as
// soon as the current chapter warms.
export const TTS_AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Edge TTS SSML prosody rate silently caps here; higher values have no effect.
export const EDGE_TTS_MAX_RATE = 2.0;

export const getTTSAudioCacheBytes = (): number => EdgeSpeechTTS.getAudioCacheBytes();

export const hasTTSPrefetchCapacity = (): boolean =>
  EdgeSpeechTTS.getAudioCacheBytes() < TTS_AUDIO_CACHE_MAX_BYTES;

export const isTTSPayloadCached = (payload: EdgeTTSPayload): boolean =>
  EdgeSpeechTTS.isPayloadCached(payload);

export class EdgeSpeechTTS {
  static voices = genVoiceList(EDGE_TTS_VOICES);
  private static audioCacheBytes = 0;

  static getAudioCacheBytes(): number {
    return EdgeSpeechTTS.audioCacheBytes;
  }

  static isPayloadCached(payload: EdgeTTSPayload): boolean {
    const cacheKey = hashTTSPayload(payload);
    return EdgeSpeechTTS.audioCache.has(cacheKey) || EdgeSpeechTTS.inflight.has(cacheKey);
  }
  private static onAudioCacheEvict = (key: string, blob: Blob) => {
    EdgeSpeechTTS.audioCacheBytes = Math.max(0, EdgeSpeechTTS.audioCacheBytes - blob.size);
    EdgeSpeechTTS.boundariesCache.delete(key);
  };
  // Entry caps sized well above what TTS_AUDIO_CACHE_MAX_BYTES can hold
  // (~500 typical batches at 32 MB), so the byte cap — which
  // hasTTSPrefetchCapacity() gates prefetch on — is the effective limit and
  // the deep look-ahead can genuinely fill the cache instead of churning
  // against an entry-count ceiling.
  private static audioCache = new FIFOCache<string, Blob>(2000, EdgeSpeechTTS.onAudioCacheEvict);
  private static boundariesCache = new FIFOCache<string, TTSWordBoundary[]>(2000);
  private static trimAudioCache = () => {
    while (
      EdgeSpeechTTS.audioCacheBytes > TTS_AUDIO_CACHE_MAX_BYTES &&
      EdgeSpeechTTS.audioCache.size() > 0
    ) {
      const entries = EdgeSpeechTTS.audioCache.entries();
      const oldest = entries[entries.length - 1];
      if (!oldest) break;
      EdgeSpeechTTS.audioCache.delete(oldest[0]);
    }
  };
  // In-flight fetches keyed by payload hash. The LRU dedupes storage, not
  // requests: the playback scheduler and the preload paths race for the same
  // sentences at every paragraph start, and without this map each racer opens
  // its own WSS connection for the same audio.
  private static inflight = new Map<
    string,
    { promise: Promise<{ blob: Blob; boundaries: TTSWordBoundary[] }> }
  >();
  // Self-hosted HTTPS TTS cannot absorb concurrent synthesis; serialize network
  // fetches so preload, playback, and lookahead share one in-flight request.
  private static httpsRequestQueue: Promise<unknown> = Promise.resolve();
  private static wsInFlight = 0;
  private static wsLowInFlight = 0;
  private static wsWaiters: Array<{
    wake: () => boolean;
    priority: WsSlotPriority;
    cacheKey?: string;
  }> = [];

  private static rejectIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw wsAbortError(signal);
  }

  private static awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    EdgeSpeechTTS.rejectIfAborted(signal);
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const finishResolve = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => finishReject(wsAbortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(finishResolve, finishReject);
    });
  }

  private static promoteWsWaiter(cacheKey: string): void {
    const index = EdgeSpeechTTS.wsWaiters.findIndex(
      (waiter) => waiter.cacheKey === cacheKey && waiter.priority === 'low',
    );
    if (index < 0) return;
    const [entry] = EdgeSpeechTTS.wsWaiters.splice(index, 1);
    if (!entry) return;
    entry.priority = 'high';
    const insertAt = EdgeSpeechTTS.wsWaiters.findIndex((waiter) => waiter.priority === 'low');
    if (insertAt === -1) EdgeSpeechTTS.wsWaiters.push(entry);
    else EdgeSpeechTTS.wsWaiters.splice(insertAt, 0, entry);
  }

  private static enqueueHttpsRequest<T>(fn: () => Promise<T>): Promise<T> {
    const run = EdgeSpeechTTS.httpsRequestQueue.then(fn, fn);
    EdgeSpeechTTS.httpsRequestQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // A playback-critical 'high' request may use every slot, but background
  // 'low' prefetch is capped one below the max so at least one slot is always
  // reserved for the playhead. This guarantees a 'high' request never waits for
  // an in-flight 'low' fetch to finish (it can only ever queue behind other
  // 'high' work) — the deep look-ahead prefetch can no longer occupy every slot
  // and starve the current sentence during a bandwidth squeeze. The cap scales
  // with the pool size: with three relays the pool-wide max is 6, so deep
  // prefetch may run up to 5 fetches in parallel (one slot reserved) instead of
  // the single-relay throttle of one at a time.
  private static wsLowSlotLimit(): number {
    return Math.max(1, getEdgeTTSWsMaxConcurrent() - 1);
  }

  private static canAcquireWsSlot(priority: WsSlotPriority): boolean {
    if (EdgeSpeechTTS.wsInFlight >= getEdgeTTSWsMaxConcurrent()) return false;
    if (priority === 'low' && EdgeSpeechTTS.wsLowInFlight >= EdgeSpeechTTS.wsLowSlotLimit()) {
      return false;
    }
    return true;
  }

  private static markWsSlotAcquired(priority: WsSlotPriority): void {
    EdgeSpeechTTS.wsInFlight++;
    if (priority === 'low') EdgeSpeechTTS.wsLowInFlight++;
  }

  private static acquireWsSlot(
    signal?: AbortSignal,
    priority: WsSlotPriority = 'low',
    cacheKey?: string,
  ): Promise<void> {
    EdgeSpeechTTS.rejectIfAborted(signal);
    if (EdgeSpeechTTS.canAcquireWsSlot(priority)) {
      EdgeSpeechTTS.markWsSlotAcquired(priority);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let aborted = false;
      let entry: {
        wake: () => boolean;
        priority: WsSlotPriority;
        cacheKey?: string;
      } | null = null;
      const onAbort = () => {
        aborted = true;
        if (entry) {
          const index = EdgeSpeechTTS.wsWaiters.indexOf(entry);
          if (index >= 0) EdgeSpeechTTS.wsWaiters.splice(index, 1);
        }
        reject(wsAbortError(signal!));
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        if (aborted) return false;
        EdgeSpeechTTS.markWsSlotAcquired(priority);
        resolve();
        return true;
      };
      entry = { wake, priority, cacheKey };
      const queuedEntry = entry;
      signal?.addEventListener('abort', onAbort, { once: true });
      // 'high' priority (the sentence about to play) jumps ahead of any
      // queued background prefetch so an urgent fetch never waits behind
      // unrelated lookahead work fighting for the same WS slots.
      if (priority === 'high') {
        const insertAt = EdgeSpeechTTS.wsWaiters.findIndex((w) => w.priority === 'low');
        if (insertAt === -1) EdgeSpeechTTS.wsWaiters.push(queuedEntry);
        else EdgeSpeechTTS.wsWaiters.splice(insertAt, 0, queuedEntry);
      } else {
        EdgeSpeechTTS.wsWaiters.push(queuedEntry);
      }
    });
  }

  private static releaseWsSlot(priority: WsSlotPriority): void {
    EdgeSpeechTTS.wsInFlight = Math.max(0, EdgeSpeechTTS.wsInFlight - 1);
    if (priority === 'low') {
      EdgeSpeechTTS.wsLowInFlight = Math.max(0, EdgeSpeechTTS.wsLowInFlight - 1);
    }
    // Wake the highest-priority waiter the reserved-slot rule still admits.
    // Waiters are kept in priority order (high ahead of low), so once the front
    // waiter cannot be admitted — a 'low' waiter while the low-prefetch cap is
    // already met — nothing behind it can be either.
    while (EdgeSpeechTTS.wsWaiters.length > 0) {
      const next = EdgeSpeechTTS.wsWaiters[0]!;
      if (!EdgeSpeechTTS.canAcquireWsSlot(next.priority)) break;
      EdgeSpeechTTS.wsWaiters.shift();
      if (next.wake()) break;
    }
  }

  private static runWithWsSlot<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    priority: WsSlotPriority = 'low',
    cacheKey?: string,
  ): Promise<T> {
    // The consumer signal gates slot acquisition (queued waiters are dropped on
    // abort) but must not tear down a shared inflight fetch once the slot is
    // held — callers detach via awaitWithAbort on the inflight promise instead.
    return EdgeSpeechTTS.acquireWsSlot(signal, priority, cacheKey).then(async () => {
      try {
        return await fn();
      } finally {
        EdgeSpeechTTS.releaseWsSlot(priority);
      }
    });
  }

  private protocol: EDGE_TTS_PROTOCOL = 'wss';
  private wsTarget: EdgeTTSWsTarget = 'self-hosted';

  constructor(options?: EDGE_TTS_PROTOCOL | EdgeSpeechTTSOptions) {
    if (typeof options === 'string') {
      this.protocol = options;
      this.wsTarget = options === 'wss' ? 'self-hosted' : 'bing';
      return;
    }
    this.protocol = options?.protocol ?? 'wss';
    this.wsTarget = options?.wsTarget ?? (this.protocol === 'wss' ? 'self-hosted' : 'bing');
  }

  async #fetchEdgeSpeechHttp({ lang, text, voice, rate }: EdgeTTSPayload): Promise<Response> {
    const url = getEdgeTTSBaseUrl() + '/api/tts/edge';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [TTS_ACCEPT_ENCODING_HEADER]: TTS_ACCEPT_ENCODING_VALUE,
        ...getEdgeTTSAuthHeaders(),
      },
      body: JSON.stringify({
        input: text,
        voice,
        rate,
        lang,
      }),
    });

    if (!response.ok) {
      throw new Error(`Edge TTS HTTP request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  async #fetchEdgeSpeechWs(
    { lang, text, voice, rate }: EdgeTTSPayload,
    signal?: AbortSignal,
    wsUrl?: string,
  ): Promise<EdgeSpeechAudio> {
    EdgeSpeechTTS.rejectIfAborted(signal);
    const connectId = randomMd5();
    const useBingDirect = this.wsTarget === 'bing';
    // `wsUrl` is the balancer-selected self-hosted backend for this attempt;
    // fall back to the single-URL derivation when the caller doesn't pass one
    // (bing direct, or a self-hosted call outside the balancing wrapper).
    const rawUrl =
      wsUrl ??
      (useBingDirect
        ? `${EDGE_SPEECH_URL}?${new URLSearchParams({
            ConnectionId: connectId,
            TrustedClientToken: EDGE_API_TOKEN,
            'Sec-MS-GEC': await generateSecMsGec(),
            'Sec-MS-GEC-Version': `1-${CHROMIUM_FULL_VERSION}`,
          }).toString()}`
        : getEdgeTTSWsUrl());
    // Self-hosted backends require X-Readest-TTS-Key. Tauri/Node can send it
    // as a handshake header; browsers cannot, so also put ?key= on the URL.
    const url = useBingDirect ? rawUrl : withEdgeTTSAuthQuery(rawUrl);
    const date = new Date().toString();
    const baseHeaders: Record<string, string> = useBingDirect
      ? {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
            ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
            ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'Sec-WebSocket-Version': '13',
          Cookie: `muid=${generateMuid()};`,
        }
      : { ...getEdgeTTSAuthHeaders() };
    const configHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      Path: 'speech.config',
      'X-Timestamp': date,
    };
    const contentHeaders = {
      'Content-Type': 'application/ssml+xml',
      Path: 'ssml',
      'X-RequestId': connectId,
      'X-Timestamp': date,
    };
    const configContent = JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: true },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          },
        },
      },
    });

    const genSendContent = (headerObj: Record<string, string>, content: string) => {
      let header = '';
      for (const key of Object.keys(headerObj)) {
        header += `${key}: ${headerObj[key]}\r\n`;
      }
      return `${header}\r\n${content}`;
    };

    const getHeadersAndData = (message: string) => {
      const lines = message.split('\n');
      const headers: Record<string, string> = {};
      let body = '';
      let lineIdx = 0;

      for (lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]!.trim();
        if (!line) break;
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        headers[key] = value;
      }

      for (lineIdx = lineIdx + 1; lineIdx < lines.length; lineIdx++) {
        body += lines[lineIdx] + '\n';
      }

      return { headers, body };
    };

    const ssml = genSSML(lang, text, voice, rate);
    const content = genSendContent(contentHeaders, ssml);
    const config = genSendContent(configHeaders, configContent);

    if (isTauriAppPlatform()) {
      return new Promise(async (resolve, reject) => {
        let settled = false;
        let disconnect: (() => void) | undefined;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: 'resolve' | 'reject', value?: unknown) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          detachAbort?.();
          disconnect?.();
          if (fn === 'resolve') resolve(value as EdgeSpeechAudio);
          else reject(value);
        };
        let detachAbort: (() => void) | undefined;
        if (signal?.aborted) return finish('reject', wsAbortError(signal));
        if (signal) {
          const onAbort = () => finish('reject', wsAbortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal.removeEventListener('abort', onAbort);
        }
        // The connection plugin reports disconnects as a 'Close' message
        // rather than throwing, and a reset mid-stream may deliver neither a
        // 'Close' message nor an error — this timeout is the last resort so a
        // dropped socket retries instead of wedging playback indefinitely.
        timeoutId = setTimeout(
          () => finish('reject', new Error('Edge TTS WebSocket timed out.')),
          WS_REQUEST_TIMEOUT_MS,
        );
        try {
          const TauriWebSocket = (await import('@tauri-apps/plugin-websocket')).default;
          const ws = await TauriWebSocket.connect(url, { headers: baseHeaders });
          disconnect = () => {
            void ws.disconnect();
          };
          let audioData = new ArrayBuffer(0);
          const boundaries: TTSWordBoundary[] = [];
          const messageUnlisten = await ws.addListener((msg) => {
            if (msg.type === 'Text') {
              const { headers, body } = getHeadersAndData(msg.data as string);
              if (headers['Path'] === 'audio.metadata') {
                boundaries.push(...parseAudioMetadataBody(body.trim()));
              } else if (headers['Path'] === 'turn.end') {
                messageUnlisten();
                if (!audioData.byteLength) {
                  return finish('reject', new Error('No audio data received.'));
                }
                finish('resolve', { response: new Response(audioData), boundaries });
              }
            } else if (msg.type === 'Binary') {
              let buffer: ArrayBufferLike;
              if (msg.data instanceof Uint8Array) {
                buffer = msg.data.buffer;
              } else {
                buffer = new Uint8Array(msg.data).buffer;
              }
              const dataView = new DataView(buffer);
              const headerLength = dataView.getInt16(0);
              if (buffer.byteLength > headerLength + 2) {
                const newBody = buffer.slice(2 + headerLength);
                const merged = new Uint8Array(audioData.byteLength + newBody.byteLength);
                merged.set(new Uint8Array(audioData), 0);
                merged.set(new Uint8Array(newBody), audioData.byteLength);
                audioData = merged.buffer;
              }
            } else if (msg.type === 'Close') {
              // The socket reset or the server hung up before turn.end. This
              // was previously silently ignored, which left the promise (and
              // the whole scheduler awaiting it) parked forever whenever a
              // connection dropped mid-synthesis — the "stuck, next sentence
              // never plays" failure. Reject with a retryable error (not the
              // permanent "no audio data" message) so #createAudioDataWithRetry
              // opens a fresh connection instead of hanging.
              if (!audioData.byteLength) {
                finish('reject', new Error('No audio data received.'));
              } else {
                finish(
                  'reject',
                  new Error(`Edge TTS WebSocket closed unexpectedly (code ${msg.data?.code}).`),
                );
              }
            }
          });
          await ws.send(config);
          await ws.send(content);
        } catch (error) {
          finish('reject', new Error(`WebSocket error occurred: ${error}`));
        }
      });
    } else if (isCloudflareWorkers()) {
      // The Workers path backs the HTTPS proxy route. It captures both the
      // audio body and the word boundaries (audio.metadata frames) so the
      // route can forward boundaries via the WORD_BOUNDARIES_HEADER.
      return new Promise<EdgeSpeechAudio>((resolve, reject) => {
        (async () => {
          try {
            // Cloudflare Workers cannot use the `ws` npm package because it
            // relies on `http.createConnection`. Instead, WebSockets are
            // opened by calling `fetch()` with an `Upgrade: websocket`
            // header. The response has status 101 and a `webSocket`
            // property that must be `accept()`ed before sending data.
            const upgradeUrl = url.replace(/^wss:\/\//i, 'https://');
            const upgradeResponse = (await fetch(upgradeUrl, {
              headers: {
                ...baseHeaders,
                Upgrade: 'websocket',
              },
            })) as UpgradeResponse;

            if (upgradeResponse.status !== 101 || !upgradeResponse.webSocket) {
              return reject(
                new Error(`WebSocket upgrade failed with status ${upgradeResponse.status}`),
              );
            }

            const ws = upgradeResponse.webSocket;
            let audioData = new ArrayBuffer(0);
            const boundaries: TTSWordBoundary[] = [];
            let settled = false;
            const timeoutId = setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error('Edge TTS WebSocket timed out.'));
            }, WS_REQUEST_TIMEOUT_MS);
            // Cloudflare Workers deliver binary WebSocket frames as `Blob`,
            // whose conversion to bytes (`blob.arrayBuffer()`) is async.
            // Chain every binary message through this promise so frames are
            // appended in receive order and `turn.end` (or `close`) can
            // await the tail before finalizing the audio payload.
            let pendingBinary: Promise<void> = Promise.resolve();

            const appendBinary = (buffer: ArrayBufferLike) => {
              const dataView = new DataView(buffer);
              const headerLength = dataView.getInt16(0);
              if (buffer.byteLength > headerLength + 2) {
                const newBody = new Uint8Array(buffer).slice(2 + headerLength);
                const merged = new Uint8Array(audioData.byteLength + newBody.byteLength);
                merged.set(new Uint8Array(audioData), 0);
                merged.set(newBody, audioData.byteLength);
                audioData = merged.buffer;
              }
            };

            const enqueueBinary = (getBuffer: () => Promise<ArrayBufferLike> | ArrayBufferLike) => {
              pendingBinary = pendingBinary.then(async () => {
                if (settled) return;
                const buffer = await getBuffer();
                if (settled) return;
                appendBinary(buffer);
              });
            };

            const finalize = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutId);
              if (!audioData.byteLength) {
                reject(new Error('No audio data received.'));
              } else {
                resolve({ response: new Response(audioData), boundaries });
              }
            };
            const failFast = (error: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutId);
              reject(error);
            };

            const onMessage = (event: { data: unknown }) => {
              if (settled) return;
              const data = event.data;
              if (typeof data === 'string') {
                const { headers, body } = getHeadersAndData(data);
                if (headers['Path'] === 'audio.metadata') {
                  boundaries.push(...parseAudioMetadataBody(body.trim()));
                  return;
                }
                if (headers['Path'] === 'turn.end') {
                  // Wait for any in-flight Blob decodes to complete before
                  // deciding whether audio was received.
                  pendingBinary
                    .then(() => {
                      try {
                        ws.close();
                      } catch {
                        // ignore close failures
                      }
                      finalize();
                    })
                    .catch(() => failFast(new Error('No audio data received.')));
                }
                return;
              }
              if (data instanceof ArrayBuffer) {
                enqueueBinary(() => data);
                return;
              }
              if (data instanceof Uint8Array) {
                enqueueBinary(() =>
                  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                );
                return;
              }
              if (typeof Blob !== 'undefined' && data instanceof Blob) {
                // Cloudflare Workers path: convert Blob -> ArrayBuffer asynchronously.
                enqueueBinary(() => (data as Blob).arrayBuffer());
                return;
              }
            };

            ws.addEventListener('message', onMessage);
            ws.addEventListener('close', () => {
              if (settled) return;
              // Drain any pending Blob decodes that may still be in-flight.
              pendingBinary
                .then(() => finalize())
                .catch(() => failFast(new Error('No audio data received.')));
            });
            ws.addEventListener('error', () => {
              failFast(new Error('WebSocket error occurred.'));
            });

            ws.accept();
            ws.send(config);
            ws.send(content);
          } catch (error) {
            reject(
              new Error(
                `WebSocket error occurred: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        })();
      });
    } else {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: 'resolve' | 'reject', value?: unknown) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          detachAbort?.();
          if (fn === 'resolve') resolve(value as EdgeSpeechAudio);
          else reject(value);
        };
        let detachAbort: (() => void) | undefined;
        if (signal?.aborted) return finish('reject', wsAbortError(signal));

        // Some abnormal resets deliver neither a 'close' nor an 'error' event
        // promptly (or at all); this timeout is the backstop so the request
        // always eventually settles and retries instead of wedging playback.
        timeoutId = setTimeout(
          () => finish('reject', new Error('Edge TTS WebSocket timed out.')),
          WS_REQUEST_TIMEOUT_MS,
        );

        // In browsers isomorphic-ws is the native WebSocket, whose second
        // argument is a subprotocol list — passing an options object throws
        // SyntaxError. Custom headers are only supported (and only needed)
        // in Node, where `ws` accepts (url, options).
        const ws =
          typeof window === 'undefined'
            ? new WebSocket(url, { headers: baseHeaders })
            : new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        if (signal) {
          const onAbort = () => {
            try {
              ws.close();
            } catch {
              // ignore close failures
            }
            finish('reject', wsAbortError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal.removeEventListener('abort', onAbort);
        }

        let audioData = new ArrayBuffer(0);
        const boundaries: TTSWordBoundary[] = [];

        ws.addEventListener('open', () => {
          ws.send(config);
          ws.send(content);
        });

        ws.addEventListener('message', (event: WebSocket.MessageEvent) => {
          if (typeof event.data === 'string') {
            const { headers, body } = getHeadersAndData(event.data);
            if (headers['Path'] === 'audio.metadata') {
              boundaries.push(...parseAudioMetadataBody(body.trim()));
            } else if (headers['Path'] === 'turn.end') {
              try {
                ws.close();
              } catch {
                // ignore close failures
              }
              if (!audioData.byteLength) {
                return finish('reject', new Error('No audio data received.'));
              }
              finish('resolve', { response: new Response(audioData), boundaries });
            }
          } else if (event.data instanceof ArrayBuffer) {
            const dataView = new DataView(event.data);
            const headerLength = dataView.getInt16(0);
            if (event.data.byteLength > headerLength + 2) {
              const newBody = event.data.slice(2 + headerLength);
              const merged = new Uint8Array(audioData.byteLength + newBody.byteLength);
              merged.set(new Uint8Array(audioData), 0);
              merged.set(new Uint8Array(newBody), audioData.byteLength);
              audioData = merged.buffer;
            }
          }
        });

        ws.addEventListener('close', () => {
          // A clean-looking close before turn.end (connection reset, proxy
          // idle-kill, server restart) used to be ignored here whenever some
          // audio had already arrived, leaving this promise — and the
          // scheduler awaiting it — parked forever with no further chunks
          // ever scheduled. Always settle: reject with a retryable error
          // (distinct from the permanent "no audio data" case) so the retry
          // path opens a fresh connection instead of stalling playback.
          if (settled) return;
          if (!audioData.byteLength) {
            finish('reject', new Error('No audio data received.'));
          } else {
            finish('reject', new Error('Edge TTS WebSocket closed unexpectedly.'));
          }
        });

        ws.addEventListener('error', () => {
          finish('reject', new Error('WebSocket error occurred.'));
        });
      });
    }
  }

  // Try self-hosted backends in balancer order. Sequential only (no fan-out).
  // One abnormal reply is not enough to stop: we fail over to the next URL,
  // and after a full pass clears / all are benched, the pool resets and we
  // cycle again up to EDGE_TTS_BALANCE_CYCLES before surfacing the error.
  async #fetchEdgeSpeechWsBalanced(
    payload: EdgeTTSPayload,
    signal?: AbortSignal,
  ): Promise<EdgeSpeechAudio> {
    // Bing direct has no pool; keep its self-contained URL/auth handling.
    if (this.wsTarget !== 'self-hosted') {
      return this.#fetchEdgeSpeechWs(payload, signal);
    }

    // Full passes over the pool. Each cycle may reset disables when all
    // backends were benched (see edgeTTSBackends.orderedCandidates).
    const EDGE_TTS_BALANCE_CYCLES = 3;
    let lastError: unknown;

    for (let cycle = 0; cycle < EDGE_TTS_BALANCE_CYCLES; cycle++) {
      const candidates = edgeTTSBackends.orderedCandidates();
      if (candidates.length === 0) {
        // No configured pool — fall back to the single-URL derivation.
        return this.#fetchEdgeSpeechWs(payload, signal);
      }

      for (const url of candidates) {
        EdgeSpeechTTS.rejectIfAborted(signal);
        try {
          const result = await this.#fetchEdgeSpeechWs(payload, signal, url);
          edgeTTSBackends.reportSuccess(url);
          return result;
        } catch (error) {
          // User abort is not a backend fault; no failover / no bench.
          if (signal?.aborted) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          const networkLikely =
            /timed out|timeout|network|failed to fetch|ECONN|ENOTFOUND|offline/i.test(msg);
          edgeTTSBackends.reportFailure(url, { networkLikely });
          lastError = error;
        }
      }

      // Entire pool failed this cycle — wipe disables and try again.
      if (cycle < EDGE_TTS_BALANCE_CYCLES - 1) {
        edgeTTSBackends.resetAll();
      }
    }

    throw lastError ?? new Error('All Edge TTS backends failed.');
  }

  async #fetchEdgeSpeech(payload: EdgeTTSPayload, signal?: AbortSignal): Promise<EdgeSpeechAudio> {
    if (this.protocol === 'https') {
      // The HTTPS proxy streams the audio body and carries word boundaries in
      // the WORD_BOUNDARIES_HEADER response header (see /api/tts/edge route).
      const response = await this.#fetchEdgeSpeechHttp(payload);
      return {
        response,
        boundaries: parseWordBoundariesHeader(response.headers.get(WORD_BOUNDARIES_HEADER)),
      };
    } else {
      return this.#fetchEdgeSpeechWsBalanced(payload, signal);
    }
  }

  async create(payload: EdgeTTSPayload): Promise<Response> {
    return (await this.#fetchEdgeSpeech(payload)).response;
  }

  // Server-side helper for the /api/tts/edge route: returns the audio Response
  // together with the captured word boundaries so the route can forward them.
  async createWithBoundaries(payload: EdgeTTSPayload): Promise<EdgeSpeechAudio> {
    return this.#fetchEdgeSpeech(payload);
  }

  // Fetch (or reuse) the audio blob + boundaries for a payload, deduplicating
  // both stored results (LRU) and in-flight requests (inflight map).
  async #fetchAndCache(
    payload: EdgeTTSPayload,
    signal?: AbortSignal,
    priority: WsSlotPriority = 'low',
  ): Promise<{ blob: Blob; boundaries: TTSWordBoundary[] }> {
    EdgeSpeechTTS.rejectIfAborted(signal);
    const cacheKey = hashTTSPayload(payload);
    const cachedBlob = EdgeSpeechTTS.audioCache.get(cacheKey);
    if (cachedBlob) {
      return { blob: cachedBlob, boundaries: EdgeSpeechTTS.boundariesCache.get(cacheKey) ?? [] };
    }
    const pending = EdgeSpeechTTS.inflight.get(cacheKey);
    if (pending) {
      if (priority === 'high') EdgeSpeechTTS.promoteWsWaiter(cacheKey);
      return EdgeSpeechTTS.awaitWithAbort(pending.promise, signal);
    }
    const fetchFromNetwork = async (): Promise<{ blob: Blob; boundaries: TTSWordBoundary[] }> => {
      const cachedAfterQueue = EdgeSpeechTTS.audioCache.get(cacheKey);
      if (cachedAfterQueue) {
        return {
          blob: cachedAfterQueue,
          boundaries: EdgeSpeechTTS.boundariesCache.get(cacheKey) ?? [],
        };
      }
      const { response, boundaries } = await this.#fetchEdgeSpeech(payload);
      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const previousBlob = EdgeSpeechTTS.audioCache.get(cacheKey);
      if (previousBlob) {
        EdgeSpeechTTS.audioCacheBytes = Math.max(
          0,
          EdgeSpeechTTS.audioCacheBytes - previousBlob.size,
        );
      }
      EdgeSpeechTTS.audioCache.set(cacheKey, blob);
      EdgeSpeechTTS.audioCacheBytes += blob.size;
      EdgeSpeechTTS.boundariesCache.set(cacheKey, boundaries);
      EdgeSpeechTTS.trimAudioCache();
      return { blob, boundaries };
    };
    const promise =
      this.protocol === 'https'
        ? EdgeSpeechTTS.enqueueHttpsRequest(fetchFromNetwork)
        : this.wsTarget === 'self-hosted'
          ? EdgeSpeechTTS.runWithWsSlot(fetchFromNetwork, signal, priority, cacheKey)
          : fetchFromNetwork();
    const entry = { promise };
    EdgeSpeechTTS.inflight.set(cacheKey, entry);
    promise.then(
      () => {
        if (EdgeSpeechTTS.inflight.get(cacheKey) === entry) EdgeSpeechTTS.inflight.delete(cacheKey);
      },
      () => {
        if (EdgeSpeechTTS.inflight.get(cacheKey) === entry) EdgeSpeechTTS.inflight.delete(cacheKey);
      },
    );
    return EdgeSpeechTTS.awaitWithAbort(promise, signal);
  }

  // Audio bytes for Web Audio decoding. The cache keeps a Blob and every call
  // mints a fresh ArrayBuffer copy via blob.arrayBuffer() — WebKit's
  // decodeAudioData detaches its input, so handing out a shared buffer would
  // break replay from cache on Safari. `priority` lets the imminent-playback
  // fetch preempt queued background prefetch for the same WS slots.
  async createAudioData(
    payload: EdgeTTSPayload,
    signal?: AbortSignal,
    priority: WsSlotPriority = 'low',
  ): Promise<{ data: ArrayBuffer; boundaries: TTSWordBoundary[] }> {
    const { blob, boundaries } = await this.#fetchAndCache(payload, signal, priority);
    EdgeSpeechTTS.rejectIfAborted(signal);
    const data = await blob.arrayBuffer();
    EdgeSpeechTTS.rejectIfAborted(signal);
    return { data, boundaries };
  }
}
