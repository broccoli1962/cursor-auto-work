import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  collectUnifiedDiff,
  diffSinceSnapshot,
  ensureUnityGitignore,
  hasMeaningfulEdits,
  lintChangedFiles,
  missingGitignorePatterns,
  restoreFilesSinceSnapshot,
  selectCommitFiles,
  snapshotWorkingTree,
} from './gitManager';
import type { OrchestratorConfig } from './types';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function stub(dir: string): OrchestratorConfig {
  return {
    targetProjectPath: dir,
    unityPath: '',
    unityCliBin: 'unity',
    unityCliInstall: 'ask',
    unityPipelineInstall: 'ask',
    cursorAgentBin: 'agent',
    cursorModel: '',
    cursorYolo: false,
    promptDelivery: 'stdin',
    validationMode: 'lint',
    unityValidationBackend: 'cli',
    unityLaunchEditor: false,
    unityLaunchTimeoutMs: 1000,
    unityStopPlayMode: true,
    unityRestorePlayMode: false,
    discordWebhookUrl: '',
    specPath: '',
    roadmapPath: '',
    statePath: '',
    runtimeDir: dir,
    logsDir: dir,
    maxRetries: 1,
    agentTimeoutMs: 1000,
    unityTimeoutMs: 1000,
    inferVerify: true,
    stepJudge: false,
    judgeTimeoutMs: 1000,
    autonomyEnabled: true,
    goal: '',
    goalPath: '',
    autonomyMaxCycles: 1,
    autonomyBudgetMs: 60_000,
    autonomyStepsPerCycle: 1,
    playtest: false,
    playtestSettleMs: 0,
    playtestRetries: 1,
    autonomyReviewTimeoutMs: 1000,
    resumeOnRetry: false,
    autonomyResumeSession: false,
    autonomySessionSteps: 4,
    rollbackOnFail: true,
    createWorkBranch: false,
    rulesMaxChars: 1000,
    specMaxChars: 1000,
    autoCommit: false,
    autoPush: false,
    commitLanguage: 'ko',
    gitAuthorName: 't',
    gitAuthorEmail: 't@t',
    maxErrorLines: 10,
    logLevel: 'error',
  };
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmgr-'));
  git(dir, ['init']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\n');
  git(dir, ['add', 'tracked.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
  return dir;
}

describe('gitignore complement', () => {
  it('treats Library/ as covering [Ll]ibrary/', () => {
    const missing = missingGitignorePatterns('Library/\nTemp/\n');
    assert.equal(missing.includes('[Ll]ibrary/'), false);
    assert.equal(missing.includes('[Tt]emp/'), false);
    assert.ok(missing.includes('[Oo]bj/'));
  });

  it('appends only missing rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignore-'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Library/\nnode_modules/\n');
    ensureUnityGitignore(stub(dir));
    const body = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(body, /cursor-auto-work/);
    assert.match(body, /\[Oo\]bj\//);
    assert.equal((body.match(/Library/g) ?? []).length, 1);
  });
});

describe('snapshot + commit filter + rollback', () => {
  it('ignores pre-dirty files for commit and restore', async () => {
    const dir = tempRepo();
    const config = stub(dir);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'user\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\nchanged by user\n');

    const baseline = await snapshotWorkingTree(config);
    assert.ok(baseline.hashes['dirty.txt']);
    assert.ok(baseline.hashes['tracked.txt']);

    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'user+agent\n');
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'new\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\nchanged by user\nand agent\n');

    const delta = await diffSinceSnapshot(config, baseline);
    assert.ok(delta.changedFiles.includes('fresh.txt'));
    assert.ok(delta.changedFiles.includes('dirty.txt'));

    const selected = selectCommitFiles(baseline, delta.changedFiles);
    assert.deepEqual(selected.files, ['fresh.txt']);
    assert.ok(selected.skippedDirty.includes('dirty.txt'));
    assert.ok(selected.skippedDirty.includes('tracked.txt'));

    const restored = await restoreFilesSinceSnapshot(config, baseline, delta.changedFiles);
    assert.ok(restored.includes('fresh.txt'));
    assert.equal(fs.existsSync(path.join(dir, 'fresh.txt')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8'), 'user+agent\n');
  });
});

describe('streaming git stdout', () => {
  it('scans a multi-megabyte diff fully without maxBuffer crash', async () => {
    const dir = tempRepo();
    const config = stub(dir);
    const line = `${'x'.repeat(80)}\n`;
    fs.writeFileSync(path.join(dir, 'tracked.txt'), `${line.repeat(40_000)}Debug.Log("hi");\n`);

    const lint = await lintChangedFiles(config, ['tracked.txt']);
    assert.ok(lint.insertions > 0);
    assert.ok(lint.violations.some((item) => item.includes('Debug.Log')));
    assert.equal(await hasMeaningfulEdits(config, ['tracked.txt']), true);

    const unified = await collectUnifiedDiff(config, ['tracked.txt']);
    assert.ok(unified.length > 0);
    assert.ok(unified.length <= 20_200);
    assert.match(unified, /diff truncated|Debug\.Log|xxxx/);
  });

  it('does not treat a comment-only large change as meaningful', async () => {
    const dir = tempRepo();
    const config = stub(dir);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), `hello\n${'// only comment\n'.repeat(40_000)}`);
    assert.equal(await hasMeaningfulEdits(config, ['tracked.txt']), false);
  });
});
