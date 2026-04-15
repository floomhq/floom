/**
 * Minimal structured logger. Stdout only, JSON lines. Consumers (the platform
 * layer, the Floom backend, or a cron job) can pipe and parse at will.
 *
 * Levels: debug | info | warn | error.
 * Debug is suppressed unless FLOOM_LOG_DEBUG=1.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
  if (level === 'debug' && process.env.FLOOM_LOG_DEBUG !== '1') return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
  // We always write to stderr so stdout stays clean for the runApp/deployFromGithub
  // JSON payloads that callers parse.
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
