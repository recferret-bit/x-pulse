import pino from 'pino';

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(level = 'info'): Logger {
  const log = pino({ level });
  return {
    info(msg, extra) {
      if (extra) log.info(extra, msg);
      else log.info(msg);
    },
    warn(msg, extra) {
      if (extra) log.warn(extra, msg);
      else log.warn(msg);
    },
    error(msg, extra) {
      if (extra) log.error(extra, msg);
      else log.error(msg);
    },
    debug(msg, extra) {
      if (extra) log.debug(extra, msg);
      else log.debug(msg);
    },
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
