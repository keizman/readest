import { AppService } from '@/types/system';
import {
  EDGE_TTS_API_KEY_HEADER,
  READEST_EDGE_TTS_API_KEY,
  READEST_EDGE_TTS_BASE_URL,
  READEST_EDGE_TTS_BASE_URLS,
  READEST_NODE_BASE_URL,
  READEST_WEB_BASE_URL,
} from './constants';
import { getRuntimeConfig } from './runtimeConfig';

declare global {
  interface Window {
    __READEST_CLI_ACCESS?: boolean;
  }
}

export const isTauriAppPlatform = () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';
export const isWebAppPlatform = () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'web';
export const hasCli = () => window.__READEST_CLI_ACCESS === true;
export const isPWA = () => window.matchMedia('(display-mode: standalone)').matches;
export const getBaseUrl = () =>
  getRuntimeConfig()?.apiBaseUrl ??
  process.env['API_BASE_URL'] ??
  process.env['NEXT_PUBLIC_API_BASE_URL'] ??
  READEST_WEB_BASE_URL;
export const getNodeBaseUrl = () =>
  process.env['NEXT_PUBLIC_NODE_BASE_URL'] ?? READEST_NODE_BASE_URL;

// WebSocket path for self-hosted Edge TTS (Edge read-aloud protocol).
export const EDGE_TTS_WS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';

const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Normalize a TTS base entry to an absolute HTTP(S) origin.
 * Accepts:
 *   - full URL:  http://1.2.3.4:57880  /  https://tts.example.com
 *   - bare host: 1.2.3.4:57880  /  tts.example.com:57880  (http:// assumed)
 *   - ws/wss URL: converted back to http/https base (path stripped)
 */
export const normalizeEdgeTTSBaseUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    // URL.origin drops non-default ports correctly; keep trailing-slash free.
    return parsed.origin;
  } catch {
    return trimmed;
  }
};

// Convert an HTTP(S) base URL to its Edge read-aloud WebSocket URL.
export const toEdgeTTSWsUrl = (baseUrl: string): string => {
  const parsed = new URL(normalizeEdgeTTSBaseUrl(baseUrl));
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = EDGE_TTS_WS_PATH;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
};

// Base URL of the self-hosted Edge TTS server (HTTPS fallback path).
// Override: NEXT_PUBLIC_EDGE_TTS_BASE_URL; else first entry of the pool.
export const getEdgeTTSBaseUrl = () =>
  normalizeEdgeTTSBaseUrl(
    process.env['NEXT_PUBLIC_EDGE_TTS_BASE_URL'] ??
      getEdgeTTSBaseUrls()[0] ??
      READEST_EDGE_TTS_BASE_URL,
  );

export const getEdgeTTSWsUrl = (): string => {
  const explicit = process.env['NEXT_PUBLIC_EDGE_TTS_WS_URL'];
  if (explicit) return explicit;
  return toEdgeTTSWsUrl(getEdgeTTSBaseUrl());
};

// Full set of interchangeable self-hosted Edge TTS HTTP base URLs.
// Supports any count (1..N). Precedence:
//   1. NEXT_PUBLIC_EDGE_TTS_BASE_URLS (comma-separated)
//   2. NEXT_PUBLIC_EDGE_TTS_BASE_URL  (single, back-compat)
//   3. READEST_EDGE_TTS_BASE_URLS     (constants.ts — default edit point)
export const getEdgeTTSBaseUrls = (): string[] => {
  const explicitList = process.env['NEXT_PUBLIC_EDGE_TTS_BASE_URLS'];
  const raw = explicitList
    ? splitCsv(explicitList)
    : process.env['NEXT_PUBLIC_EDGE_TTS_BASE_URL']
      ? [process.env['NEXT_PUBLIC_EDGE_TTS_BASE_URL'] as string]
      : [...READEST_EDGE_TTS_BASE_URLS];
  return Array.from(new Set(raw.map(normalizeEdgeTTSBaseUrl).filter(Boolean)));
};

// WS URLs the load balancer rotates over (any count). Prefer configuring
// HTTP bases (getEdgeTTSBaseUrls) and let this derive ws://.../edge/v1.
// Direct override: NEXT_PUBLIC_EDGE_TTS_WS_URLS / NEXT_PUBLIC_EDGE_TTS_WS_URL.
export const getEdgeTTSWsUrls = (): string[] => {
  const explicitWsList = process.env['NEXT_PUBLIC_EDGE_TTS_WS_URLS'];
  const raw = explicitWsList
    ? splitCsv(explicitWsList)
    : process.env['NEXT_PUBLIC_EDGE_TTS_WS_URL']
      ? [process.env['NEXT_PUBLIC_EDGE_TTS_WS_URL'] as string]
      : getEdgeTTSBaseUrls().map(toEdgeTTSWsUrl);
  // Dedup so a backend is never probed twice in one request.
  return Array.from(new Set(raw.filter(Boolean)));
};

// Shared secret for self-hosted Edge TTS (header X-Readest-TTS-Key).
// Empty string disables sending auth (only useful if server auth is off).
export const getEdgeTTSApiKey = (): string =>
  process.env['NEXT_PUBLIC_EDGE_TTS_API_KEY'] ?? READEST_EDGE_TTS_API_KEY;

export { EDGE_TTS_API_KEY_HEADER };

/** Headers to attach on self-hosted HTTP / WS upgrade requests. */
export const getEdgeTTSAuthHeaders = (): Record<string, string> => {
  const key = getEdgeTTSApiKey();
  if (!key) return {};
  return { [EDGE_TTS_API_KEY_HEADER]: key };
};

/**
 * Append `?key=` for environments that cannot set WebSocket request headers
 * (browser native WebSocket). Safe no-op when key is empty or already present.
 */
export const withEdgeTTSAuthQuery = (wsUrl: string): string => {
  const key = getEdgeTTSApiKey();
  if (!key) return wsUrl;
  try {
    const parsed = new URL(wsUrl);
    if (!parsed.searchParams.has('key')) {
      parsed.searchParams.set('key', key);
    }
    return parsed.toString();
  } catch {
    return wsUrl;
  }
};

export const isMacPlatform = () =>
  typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export const getCommandPaletteShortcut = () => (isMacPlatform() ? '⌘⇧P' : 'Ctrl+Shift+P');

const isWebDevMode = () => process.env['NODE_ENV'] === 'development' && isWebAppPlatform();

// Dev API only in development mode and web platform
// with command `pnpm dev-web`
// for production build or tauri app use the production Web API
export const getAPIBaseUrl = () => (isWebDevMode() ? '/api' : `${getBaseUrl()}/api`);

// For Node.js API that currently not supported in some edge runtimes
export const getNodeAPIBaseUrl = () => (isWebDevMode() ? '/api' : `${getNodeBaseUrl()}/api`);

export interface EnvConfigType {
  getAppService: () => Promise<AppService>;
}

let nativeAppService: AppService | null = null;
const getNativeAppService = async () => {
  if (!nativeAppService) {
    const { NativeAppService } = await import('@/services/nativeAppService');
    nativeAppService = new NativeAppService();
    await nativeAppService.init();
  }
  return nativeAppService;
};

let webAppService: AppService | null = null;
const getWebAppService = async () => {
  if (!webAppService) {
    const { WebAppService } = await import('@/services/webAppService');
    webAppService = new WebAppService();
    await webAppService.init();
  }
  return webAppService;
};

const environmentConfig: EnvConfigType = {
  getAppService: async () => {
    if (isTauriAppPlatform()) {
      return getNativeAppService();
    } else {
      return getWebAppService();
    }
  },
};

/**
 * Synchronously returns the app service if it has already been created by
 * {@link environmentConfig.getAppService}; null before first init. The async
 * getter is preferred everywhere — use this only from synchronous code paths
 * that run well after startup (e.g. capability checks during reader render),
 * where the singleton is guaranteed to exist.
 */
export const getInitializedAppService = (): AppService | null => nativeAppService ?? webAppService;

export default environmentConfig;
