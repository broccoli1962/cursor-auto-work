import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { acquireRunLock, isPidAlive, lockFilePath, readRunLock, RunLockError } from './runLock';

describe('runLock', () => {
  it('isPidAlive sees the current process', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(1_000_000_001), false);
  });

  it('rejects a second lock while the first pid is alive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
    const release = acquireRunLock(dir, 'proj');
    const info = readRunLock(dir);
    assert.equal(info?.pid, process.pid);
    assert.throws(() => acquireRunLock(dir, 'proj'), RunLockError);
    release();
    assert.equal(readRunLock(dir), null);
  });

  it('reclaims a stale lock from a dead pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
    fs.writeFileSync(
      lockFilePath(dir),
      `${JSON.stringify({ pid: 1_000_000_001, startedAt: 'x', project: 'proj' })}\n`,
    );
    const release = acquireRunLock(dir, 'proj');
    assert.equal(readRunLock(dir)?.pid, process.pid);
    release();
  });
});
