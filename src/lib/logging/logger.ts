import 'server-only';

import { getRequestContext } from './context';
import { redact } from './redact';

/**
 * Centralised server-side logger.
 *
 * Everything passes through `redact()` before serialisation. That is not a
 * convention a caller can opt out of — there is no path from `log.info(...)` to
 * output that skips it — which is the only arrangement that survives contact
 * with a codebase that will grow for years.
 *
 * Deployed environments emit one JSON object per line for Vercel's log
 * ingestion. Development emits something a human can read at 2am.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function configuredLevel(): LogLevel {
  const raw = process.env['LOG_LEVEL']?.toLowerCase();
  if (raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

// NOT named useJson: the react-hooks lint rule treats any function whose name
// begins with "use" as a React Hook and rejects calls from non-component code.
function emitAsJson(): boolean {
  // Vercel sets NODE_ENV=production for Preview and Production alike.
  return process.env['NODE_ENV'] === 'production' || process.env['LOG_FORMAT'] === 'json';
}

export type LogFields = Record<string, unknown>;

interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

/** Overridable so tests can assert on exactly what would be written. */
let sink: (level: LogLevel, line: string) => void = (level, line) => {
  // warn and error to stderr so they survive stdout redirection.
  if (level === 'error' || level === 'warn') console.error(line);
  else console.info(line);
};

export function setLogSink(fn: (level: LogLevel, line: string) => void): () => void {
  const previous = sink;
  sink = fn;
  return () => {
    sink = previous;
  };
}

const ESC = '\u001B'; // ANSI escape as a code point, so the source stays plain text
const DEV_COLOURS: Record<LogLevel, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
};
const RESET = `${ESC}[0m`;

function formatDev(record: LogRecord): string {
  const { level, time, message, ...rest } = record;
  const head = `${DEV_COLOURS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${time.slice(11, 23)} ${message}`;
  const extras = Object.entries(rest).filter(([, v]) => v !== undefined);
  if (extras.length === 0) return head;
  return `${head}\n${extras.map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}`;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;

  const context = getRequestContext();

  // The message is redacted too. A caller writing
  // log.error(`connect failed: ${url}`) has made a mistake, but it must not be
  // a mistake that puts a credential into a log aggregator.
  const record: LogRecord = {
    level,
    time: new Date().toISOString(),
    message: String(redact(message)),
    ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context?.userId !== undefined ? { userId: context.userId } : {}),
    ...(context?.companyId !== undefined ? { companyId: context.companyId } : {}),
    ...(fields ? (redact(fields) as LogFields) : {}),
  };

  sink(level, emitAsJson() ? JSON.stringify(record) : formatDev(record));
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Fields merged into every line from the returned logger. */
  child(bound: LogFields): Logger;
}

function createLogger(bound: LogFields = {}): Logger {
  const withBound = (fields?: LogFields): LogFields | undefined =>
    Object.keys(bound).length === 0 ? fields : { ...bound, ...fields };

  return {
    debug: (m, f) => {
      emit('debug', m, withBound(f));
    },
    info: (m, f) => {
      emit('info', m, withBound(f));
    },
    warn: (m, f) => {
      emit('warn', m, withBound(f));
    },
    error: (m, f) => {
      emit('error', m, withBound(f));
    },
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

export const log: Logger = createLogger();
