import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Base logger for the whole service. Production emits structured JSON
 * (for log aggregation); development pretty-prints for readability.
 * Never log secrets: config values like OPENAI_API_KEY must never be
 * passed to logger.info/error directly, redact paths are set up below
 * as a defense in depth measure in case a full object is logged by mistake.
 */
const baseOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'OPENAI_API_KEY',
      '*.OPENAI_API_KEY',
      'CLAUDE_API_KEY',
      '*.CLAUDE_API_KEY',
      'apiKey',
      '*.apiKey',
      'authorization',
      'req.headers.authorization',
      '*.headers["x-api-key"]',
      'headers["x-api-key"]',
    ],
    censor: '[REDACTED]',
  },
  base: {
    env: config.NODE_ENV,
  },
};

export const logger =
  config.NODE_ENV === 'test'
    ? pino({ ...baseOptions, level: 'silent' })
    : config.NODE_ENV === 'development'
      ? pino({
          ...baseOptions,
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        })
      : pino(baseOptions);

/**
 * Creates a child logger with a bound requestId (and any extra context)
 * so every log line emitted while handling one request can be correlated
 * without threading a requestId string through every function signature.
 */
export function createRequestLogger(
  requestId: string,
  extra: Record<string, unknown> = {},
): pino.Logger {
  return logger.child({ requestId, ...extra });
}
