import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * JSON.stringify that cannot throw.
 *
 * nest-winston puts the thrown object itself into `meta.error`. When that is an
 * axios error it is circular — `ClientRequest.res -> IncomingMessage.req`, and
 * `Agent.sockets -> _httpMessage -> agent` — so a plain JSON.stringify threw
 * *while logging the error*, turning one failure into a second, noisier one and
 * hiding the original message. Cycles become "[Circular]" instead.
 *
 * The output is also capped: an http Agent serialises to tens of kilobytes of
 * socket state that tells you nothing, and it would be written once per failed
 * request.
 */
const MAX_META = 2000;

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  let out: string;
  try {
    out = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
  } catch {
    // Getters that throw, BigInt edge cases, exotic proxies.
    out = String(value);
  }
  if (out === undefined) return '';
  return out.length > MAX_META ? `${out.slice(0, MAX_META)}…[truncated]` : out;
}

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, context, stack, ...meta }) => {
    return `${timestamp} [${context ?? 'App'}] ${level}: ${stack ?? message} ${
      Object.keys(meta).length ? safeStringify(meta) : ''
    }`;
  }),
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json(),
);

const isProd = process.env.NODE_ENV === 'production';

export const winstonConfig: winston.LoggerOptions = {
  level: isProd ? 'info' : 'debug',
  format: isProd ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
    }),
  ],
};

@Module({
  imports: [WinstonModule.forRoot(winstonConfig)],
  exports: [WinstonModule],
})
export class LoggerModule {}
