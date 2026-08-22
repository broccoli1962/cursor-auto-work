import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';

const log = createLogger('lock');

export interface RunLockInfo {
  pid: number;
  startedAt: string;
  project: string;
}

export function lockFilePath(runtimeDir: string): string {
  return path.join(runtimeDir, 'run.lock');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRunLock(runtimeDir: string): RunLockInfo | null {
  const file = lockFilePath(runtimeDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RunLockInfo;
    if (!parsed || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export class RunLockError extends Error {}

/** 같은 대상 프로젝트에 동시 run 을 막는다. 죽은 PID 의 락은 회수한다. */
export function acquireRunLock(runtimeDir: string, project: string): () => void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = lockFilePath(runtimeDir);
  const existing = readRunLock(runtimeDir);

  if (existing && isPidAlive(existing.pid)) {
    throw new RunLockError(
      `다른 run 이 이미 실행 중입니다 (pid ${existing.pid}, ${existing.startedAt}). ` +
        '동시에 같은 프로젝트의 git/state 를 쓰면 안 됩니다. 끝난 뒤 다시 실행하세요.',
    );
  }

  if (existing && !isPidAlive(existing.pid)) {
    log.warn(`죽은 run 락을 회수합니다 (pid ${existing.pid}).`);
  }

  const info: RunLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    project,
  };
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  log.info(`run 락 획득: ${file}`);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = readRunLock(runtimeDir);
      if (current && current.pid !== process.pid) return;
      fs.rmSync(file, { force: true });
    } catch (error) {
      log.debug(`run 락 해제 실패(무시): ${(error as Error).message}`);
    }
  };
}
