export const TTS_DIAGNOSTIC_TAG = '[READEST_TTS]';

type DiagnosticValue = string | number | boolean | null | undefined;

const formatValue = (value: DiagnosticValue): string => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value)) : 'nan';
  }
  if (typeof value === 'string') {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
};

const formatFields = (fields?: Record<string, DiagnosticValue>): string => {
  if (!fields) return '';
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

export const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export const elapsedMs = (startedAt: number): number => nowMs() - startedAt;

export const ttsLog = (event: string, fields?: Record<string, DiagnosticValue>): void => {
  console.log(`${TTS_DIAGNOSTIC_TAG} ${event}${formatFields(fields)}`);
};

export const ttsWarn = (
  event: string,
  fields?: Record<string, DiagnosticValue>,
  error?: unknown,
): void => {
  const message = `${TTS_DIAGNOSTIC_TAG} ${event}${formatFields(fields)}`;
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
};
