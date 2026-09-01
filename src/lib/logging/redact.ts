/**
 * Redaction.
 *
 * This is the load-bearing part of LedgerLite's logging. It is applied at the
 * logger boundary, not at call sites, because a redaction step that each caller
 * must remember is a redaction step that will eventually be forgotten — and the
 * one time it is forgotten is the one time it mattered.
 *
 * Two independent strategies, because either alone has a blind spot:
 *
 *   BY KEY NAME    catches `{ password: "hunter2" }` even when the value looks
 *                  like nothing in particular.
 *   BY VALUE SHAPE catches a connection string or a JWT that arrived under an
 *                  innocuous key — `{ detail: "postgres://u:pw@host/db" }` — or
 *                  with no key at all, as free text inside an error message.
 *
 * Errors get special handling. A thrown database error frequently embeds the
 * whole connection string in its `message`, and `cause` chains nest arbitrarily
 * deep, so both are walked rather than stringified.
 */

export const REDACTED = '[REDACTED]';

/**
 * Keys whose VALUE is always removed, matched case-insensitively as a substring
 * so `dbPassword`, `X-Auth-Token` and `stripeApiKey` are all covered.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|wd|phrase)?/i,
  /secret/i,
  /token/i,
  /\bauth(oriz|entic)?a?t?i?o?n?\b/i,
  /credential/i,
  /\bcookie\b/i,
  /session[_-]?id/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /\bsalt\b/i,
  /database[_-]?url/i,
  /connection[_-]?string/i,
  /\bdsn\b/i,
  // Financial and identity data specific to this product.
  /\bein\b/i,
  /\btin\b/i,
  /\bssn\b/i,
  /tax[_-]?id/i,
  /account[_-]?number/i,
  /routing[_-]?number/i,
  /\biban\b/i,
  /card[_-]?number/i,
  /\bcvv\b/i,
  // Uploaded receipts and statements: never useful in a log, always sensitive.
  /file[_-]?(content|data|buffer|body)/i,
  /attachment/i,
];

/**
 * Value shapes that are credentials regardless of the key they arrived under.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Connection strings with an inline password.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  // Bearer / Basic authorization headers.
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  // Provider-issued tokens: GitHub, Neon, Vercel, OpenAI, Stripe, Slack, AWS.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bnapi_[A-Za-z0-9]{16,}/,
  /\bnpg_[A-Za-z0-9]{8,}/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4096;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Replace credential-shaped substrings inside free text, preserving the
 * surrounding message. A log line reading
 * "connect failed: [REDACTED] refused" is still useful; dropping the whole
 * message is not.
 */
// Precompiled with the global flag. Rebuilding these per call would allocate a
// RegExp for every string in every log line.
const GLOBAL_VALUE_PATTERNS: readonly RegExp[] = SENSITIVE_VALUE_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`),
);

export function redactString(value: string): string {
  let out = value;
  for (const pattern of GLOBAL_VALUE_PATTERNS) {
    pattern.lastIndex = 0; // global regexes are stateful across calls
    out = out.replace(pattern, REDACTED);
  }
  return out.length > MAX_STRING_LENGTH ? `${out.slice(0, MAX_STRING_LENGTH)}…[truncated]` : out;
}

interface ErrorShape {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
  readonly code?: unknown;
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): ErrorShape {
  // `cause` is walked rather than stringified: a database driver commonly wraps
  // a low-level error carrying the connection string, several levels down.
  const base: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
    code?: unknown;
  } = {
    name: error.name,
    message: redactString(error.message),
  };

  if (typeof error.stack === 'string') base.stack = redactString(error.stack);
  if (error.cause !== undefined) base.cause = redactValue(error.cause, depth + 1, seen);
  if ('code' in error) base.code = redactValue((error as { code: unknown }).code, depth + 1, seen);

  return base;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';

  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return redactError(value, depth, seen);
  }

  if (value instanceof Date) return value.toISOString();

  // Buffers and typed arrays are file contents or raw bytes. Never logged.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth + 1, seen));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…${String(value.length - MAX_ARRAY_ITEMS)} more`]
      : items;
  }

  if (value instanceof Map) {
    return redactValue(Object.fromEntries(value), depth, seen);
  }
  if (value instanceof Set) {
    return redactValue([...value], depth, seen);
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Key match wins outright: the value is not inspected, not truncated, not
      // partially shown. A masked password still leaks its length.
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  }

  // Unreachable: every typeof case is handled above. Returning a marker rather
  // than String(value) so a future type slipping through cannot stringify to
  // "[object Object]" and hide whatever it was carrying.
  return '[Unserializable]';
}

/** Redact anything before it is serialised. Safe on cyclic structures. */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}
