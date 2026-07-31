import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from './types';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

let currentLevel: LogLevel = 'info';
let fileStream: fs.WriteStream | null = null;

export function configureLogger(level: LogLevel, logFilePath?: string): void {
  currentLevel = level;
  if (logFilePath) {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fileStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
  }
}

function write(level: LogLevel, scope: string, message: string): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;

  const timestamp = new Date().toISOString();
  const plain = `[${timestamp}] [${level.toUpperCase()}] [${scope}] ${message}`;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${COLOR[level]}${plain}${RESET}\n`);
  fileStream?.write(`${plain}\n`);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string) => write('debug', scope, message),
    info: (message: string) => write('info', scope, message),
    warn: (message: string) => write('warn', scope, message),
    error: (message: string) => write('error', scope, message),
    /** Agent 스트림처럼 이미 포맷된 출력을 그대로 흘려보낼 때 사용 */
    raw: (chunk: string) => {
      process.stdout.write(chunk);
      fileStream?.write(chunk);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function closeLogger(): void {
  fileStream?.end();
  fileStream = null;
}
