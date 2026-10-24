/**
 * Defense in depth against stored XSS. The surface app renders text safely,
 * but the same strings reach printed receipts, CSV exports, the audit log
 * and any future integration, so markup is removed at the API boundary.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DANGEROUS_BLOCKS = /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAGS = /<\/?[a-z][^>]*>/gi;
const JS_URL = /\bjavascript\s*:/gi;

export function sanitizeText(value: string): string {
  return value
    .replace(CONTROL, '')
    .replace(DANGEROUS_BLOCKS, '')
    .replace(TAGS, '')
    .replace(JS_URL, '')
    .trim();
}

/** Sanitizes every string in a JSON-like value, leaving other types alone. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)])) as T;
  }
  return value;
}
