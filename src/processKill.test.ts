import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import { waitUntilEditorReady } from './unityMcp';
import type { McpRpcSession } from './mcpProbe';
import { runCursorAgent } from './cursorRunner';
import {
  ABORT_MESSAGE,
  abortableSleep,
  isAbortError,
  killChildTree,
  throwIfAborted,
} from './processKill';
import type { OrchestratorConfig } from './types';

function stubConfig(): OrchestratorConfig {
  return {
    targetProjectPath: process.cwd(),
    unityPath: '',
    cursorAgentBin: 'this-binary-must-not-spawn',
    cursorModel: '',
    cursorYolo: false,
    promptDelivery: 'stdin',
    validationMode: 'lint',
    unityValidationBackend: 'mcp',
    unityLaunchEditor: false,
    unityLaunchTimeoutMs: 1_000,
    unityStopPlayMode: true,
    unityRestorePlayMode: false,
    discordWebhookUrl: '',
    specPath: '',
    roadmapPath: '',
    statePath: '',
    runtimeDir: process.cwd(),
    logsDir: process.cwd(),
    maxRetries: 1,
    agentTimeoutMs: 5_000,
    unityTimeoutMs: 5_000,
    inferVerify: true,
    stepJudge: true,
    judgeTimeoutMs: 5_000,
    resumeOnRetry: false,
    rollbackOnFail: false,
    createWorkBranch: false,
    rulesMaxChars: 4_000,
    specMaxChars: 4_000,
    autoCommit: false,
    autoPush: false,
    commitLanguage: 'ko',
    gitAuthorName: '',
    gitAuthorEmail: '',
    maxErrorLines: 20,
    logLevel: 'error',
  };
}

describe('processKill helpers', () => {
  it('throwIfAborted throws only after abort', () => {
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    ac.abort();
    assert.throws(() => throwIfAborted(ac.signal), /중단 요청/);
  });

  it('isAbortError recognizes cancel names and Korean abort text', () => {
    assert.equal(isAbortError(new Error(ABORT_MESSAGE)), true);
    assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'CanceledError' })), true);
    assert.equal(isAbortError(new Error('timeout')), false);
  });

  it('abortableSleep rejects when signal aborts', async () => {
    const ac = new AbortController();
    const pending = abortableSleep(30_000, ac.signal);
    ac.abort();
    await assert.rejects(pending, /중단 요청/);
  });

  it('killChildTree ends a long-lived node child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    await abortableSleep(80);
    assert.equal(child.exitCode, null);
    killChildTree(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('자식 프로세스가 종료되지 않았습니다')), 8_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
});

describe('runCursorAgent abort', () => {
  it('does not spawn when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runCursorAgent({
      prompt: 'must not run',
      config: stubConfig(),
      signal: ac.signal,
    });
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
  });
});

describe('waitUntilEditorReady abort', () => {
  it('stops polling when aborted', async () => {
    const ac = new AbortController();
    const session: McpRpcSession = {
      request: async () => ({ data: { is_compiling: true, advice: { ready_for_tools: false } } }),
      notify: async () => undefined,
      close: async () => undefined,
    };

    setTimeout(() => ac.abort(), 40);
    const started = Date.now();
    await assert.rejects(() => waitUntilEditorReady(session, 30_000, ac.signal), /중단 요청/);
    assert.ok(Date.now() - started < 5_000);
  });
});
