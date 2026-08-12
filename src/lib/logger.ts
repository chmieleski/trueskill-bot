import pino from 'pino';
import { env } from '../config/env.js';

const customLevels = {
  verbose: 25,
} as const;

function resolveLevel(): string {
  if (env.logLevel) {
    return env.logLevel;
  }

  return env.isDev ? 'debug' : 'info';
}

export const logger = pino({
  name: 'dbz-wc3-bot',
  level: resolveLevel(),
  customLevels,
  base: {
    env: env.isDev ? 'development' : 'production',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(env.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
            customLevels: 'verbose:25',
            customColors: 'verbose:cyan,info:green,warn:yellow,error:red,debug:blue',
            messageFormat: '{if module}[{module}]{end} {msg}',
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;

/** Child logger scoped to a module (shows as `module` in every line). */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
