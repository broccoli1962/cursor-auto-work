import { spawn, type ChildProcess } from 'node:child_process';

export const ABORT_MESSAGE = '중단 요청으로 작업을 중단했습니다.';

/** Windows 는 shell:true 로 뜬 cmd 트리까지 같이 끊는다. Unity Editor 는 건드리지 않는다. */
export function killChildTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  child.kill('SIGKILL');
}

export function throwIfAborted(signal?: AbortSignal, message = ABORT_MESSAGE): void {
  if (signal?.aborted) throw new Error(message);
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as { name?: string; message?: string; code?: string };
  if (rec.name === 'AbortError' || rec.name === 'CanceledError' || rec.code === 'ERR_CANCELED') {
    return true;
  }
  return typeof rec.message === 'string' && rec.message.includes('중단 요청');
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(ABORT_MESSAGE));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
