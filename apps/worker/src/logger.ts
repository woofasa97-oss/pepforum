/**
 * Structured JSON logs (one object per line) for Render's log stream.
 * Never log secrets, emails, note text or other personal content — counts and
 * opaque ids only.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = console.log): Logger {
  const write = (level: Level, message: string, fields: Record<string, unknown> = {}) => {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, message, ...base, ...fields }));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
