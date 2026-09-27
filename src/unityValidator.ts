import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { ConsoleTail } from './encoding';
import { createLogger } from './logger';
import type {
  CompileError,
  OrchestratorConfig,
  UnityCompileResult,
  UnityTestResult,
} from './types';
import { ABORT_MESSAGE, abortableSleep, isAbortError, killChildTree, throwIfAborted } from './processKill';
import {
  isTransientCliError,
  parseEditorPlaying,
  parsePipelineTest,
  unityCommand,
  waitForRecompile,
} from './unityCli';

const log = createLogger('unity');

/** `Assets/Foo.cs(12,5): error CS0103: ...` 형태의 Unity 컴파일 에러 라인 */
const CS_ERROR_PATTERN = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\):\s*error\s+(?<code>CS\d+):\s*(?<message>.+)$/;
/** 파일 위치 없이 출력되는 에러 (어셈블리 단위 실패 등) */
const BARE_ERROR_PATTERN = /error\s+(?<code>CS\d+):\s*(?<message>.+)$/;

export function parseCompileErrors(logContent: string, limit = 200): CompileError[] {
  const errors: CompileError[] = [];
  const seen = new Set<string>();

  for (const rawLine of logContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes('error CS')) continue;

    const full = CS_ERROR_PATTERN.exec(line);
    if (full?.groups) {
      const key = `${full.groups.file}:${full.groups.line}:${full.groups.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        file: full.groups.file ?? '',
        line: Number(full.groups.line ?? 0),
        code: full.groups.code ?? '',
        message: full.groups.message ?? '',
        raw: line,
      });
    } else {
      const bare = BARE_ERROR_PATTERN.exec(line);
      if (!bare?.groups) continue;
      const key = line;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        file: '(unknown)',
        line: 0,
        code: bare.groups.code ?? '',
        message: bare.groups.message ?? '',
        raw: line,
      });
    }

    if (errors.length >= limit) break;
  }

  return errors;
}

interface SpawnOutcome {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
}

function spawnUnity(
  config: OrchestratorConfig,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, timedOut: false, aborted: true, stderr: ABORT_MESSAGE });
      return;
    }

    log.debug(`${config.unityPath} ${args.join(' ')}`);
    const child = spawn(config.unityPath, args, {
      cwd: config.targetProjectPath,
      windowsHide: true,
    });

    const stderrTail = new ConsoleTail(20_000);
    let spawnErrorMessage = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`Unity 배치모드 타임아웃 (${timeoutMs}ms) - 프로세스를 종료합니다.`);
      killChildTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      log.warn('중단 요청 — 배치모드 Unity 프로세스 트리를 종료합니다.');
      killChildTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => stderrTail.push(chunk));

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        timedOut,
        aborted,
        stderr: `${stderrTail.toString()}${spawnErrorMessage}`.trim(),
      });
    };

    child.on('error', (error) => {
      spawnErrorMessage += `\n[spawn error] ${error.message}`;
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}

function readLogSafely(logPath: string): string {
  if (!fs.existsSync(logPath)) return '';
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    log.warn(`로그 읽기 실패: ${(error as Error).message}`);
    return '';
  }
}

/** 실제로 Unity 를 띄우지 않고 통과 처리할 때 쓰는 컴파일 결과 */
export function skippedCompileResult(
  config: OrchestratorConfig,
  reason: string,
): UnityCompileResult {
  return {
    ok: true,
    errors: [],
    logPath: path.join(config.logsDir, 'unity_build.log'),
    exitCode: null,
    timedOut: false,
    failureReason: reason,
  };
}

/** 테스트를 실행하지 않았음을 나타내는 빈 결과 */
export function skippedTestResult(): UnityTestResult {
  return { ok: true, skipped: true, total: 0, passed: 0, failed: 0, failures: [] };
}

/** UnityMCP read_console 페이로드에서 사람이 읽을 로그 텍스트를 뽑는다. */
export function extractConsoleText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const lines: string[] = [];

  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.includes('error') || value.includes('CS')) lines.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    const message = rec.message ?? rec.msg ?? rec.text ?? rec.condition ?? rec.raw;
    if (typeof message === 'string' && message.trim()) lines.push(message.trim());
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') visit(child);
    }
  };

  visit(payload);
  return lines.length > 0 ? [...new Set(lines)].join('\n') : JSON.stringify(payload);
}

export function parseMcpTestJob(payload: unknown): Omit<UnityTestResult, 'skipped' | 'resultPath'> {
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const data = (rec.data && typeof rec.data === 'object' ? rec.data : rec) as Record<string, unknown>;
  const results = (data.results && typeof data.results === 'object' ? data.results : data) as Record<
    string,
    unknown
  >;

  const failedRaw = data.failed_tests ?? data.failedTests ?? results.failed_tests ?? results.failures;
  const failures: { name: string; message: string }[] = [];
  if (Array.isArray(failedRaw)) {
    for (const item of failedRaw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      failures.push({
        name: String(row.name ?? row.fullname ?? row.fullName ?? '(unnamed)'),
        message: String(row.message ?? row.reason ?? row.error ?? '실패 사유 없음'),
      });
    }
  }

  const passed = Number(results.passed ?? data.passed ?? 0);
  const failed = Number(results.failed ?? data.failed ?? failures.length);
  const total = Number(results.total ?? data.total ?? passed + failed);
  const status = String(data.status ?? rec.status ?? '').toLowerCase();
  const ok = failures.length === 0 && status !== 'failed' && failed === 0;

  return {
    ok,
    total: Number.isFinite(total) ? total : failures.length,
    passed: Number.isFinite(passed) ? passed : 0,
    failed: Number.isFinite(failed) ? failed : failures.length,
    failures,
  };
}

function writeLog(logPath: string, body: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, body, 'utf8');
}

export async function runUnityCompile(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<UnityCompileResult> {
  if (config.unityValidationBackend === 'batch') return runUnityCompileBatch(config, signal);
  return runUnityCompileCli(config, signal);
}

async function stopPlayModeCli(config: OrchestratorConfig, signal?: AbortSignal): Promise<boolean> {
  const status = await unityCommand(config, 'editor_status', [], { timeoutMs: 30_000, signal });
  const playing = parseEditorPlaying(status.payload);
  if (!playing) return false;
  if (!config.unityStopPlayMode) {
    throw new Error(
      'Unity Editor 가 Play Mode 입니다. 검수를 위해 재생을 끄거나 UNITY_STOP_PLAY_MODE=true 로 두세요.',
    );
  }
  log.warn('Play Mode 가 켜져 있어 검수 전에 중지합니다. 검수 후 다시 재생합니다.');
  await unityCommand(config, 'editor_stop', [], { timeoutMs: 30_000, signal });
  return true;
}

async function restorePlayModeCli(
  config: OrchestratorConfig,
  wasPlaying: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!wasPlaying || !config.unityRestorePlayMode) return;
  try {
    await unityCommand(config, 'editor_play', [], { timeoutMs: 30_000, signal });
    log.info('검수 전 Play Mode 를 복구했습니다.');
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn(`Play Mode 복구 실패(무시): ${(error as Error).message}`);
  }
}

async function runUnityCompileCli(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<UnityCompileResult> {
  const logPath = path.join(config.logsDir, 'unity_build.log');
  log.info('Unity CLI 컴파일 검수 시작...');

  try {
    throwIfAborted(signal, ABORT_MESSAGE);
    const wasPlaying = await stopPlayModeCli(config, signal);
    try {
      try {
        await unityCommand(config, 'clear_console', [], { timeoutMs: 30_000, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.debug(`콘솔 clear 실패(무시): ${(error as Error).message}`);
      }

      try {
        await unityCommand(config, 'recompile', [], { timeoutMs: 60_000, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (!isTransientCliError(error)) throw error;
        log.warn(`recompile 호출이 도메인 리로드로 끊겼을 수 있습니다: ${(error as Error).message}`);
      }

      await waitForRecompile(config, config.unityTimeoutMs, signal);
      const logs = await unityCommand(
        config,
        'get_console_logs',
        ['--severity', 'error', '--limit', '200'],
        { timeoutMs: 60_000, signal },
      );
      const text = extractConsoleText(logs.payload ?? logs.stdout);
      writeLog(logPath, text);
      const errors = parseCompileErrors(text);

      if (errors.length > 0) {
        log.warn(`C# 컴파일 에러 ${errors.length}건 감지 (Unity CLI 콘솔)`);
        return { ok: false, errors, logPath, exitCode: 0, timedOut: false };
      }

      log.info('컴파일 검수 통과 (Unity CLI)');
      return { ok: true, errors: [], logPath, exitCode: 0, timedOut: false };
    } finally {
      await restorePlayModeCli(config, wasPlaying, signal);
    }
  } catch (error) {
    const message = (error as Error).message;
    writeLog(logPath, message);
    return {
      ok: false,
      errors: [],
      logPath,
      exitCode: null,
      timedOut: !isAbortError(error) && /내에 끝나지|timeout|타임아웃/i.test(message),
      failureReason: message,
      aborted: isAbortError(error),
    };
  }
}

/**
 * Unity 를 배치모드로 기동해 C# 스크립트를 컴파일한다.
 * 에디터를 끄므로 열린 에디터 검수와 함께 쓰지 말 것. UNITY_VALIDATION_BACKEND=batch 전용.
 */
async function runUnityCompileBatch(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<UnityCompileResult> {
  const logPath = path.join(config.logsDir, 'unity_build.log');
  fs.mkdirSync(config.logsDir, { recursive: true });
  if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });

  if (!config.unityPath) {
    return skippedCompileResult(config, 'UNITY_PATH 미설정으로 컴파일 검수를 건너뛰었습니다.');
  }

  log.info('Unity Batchmode 컴파일 검수 시작...');
  const outcome = await spawnUnity(
    config,
    [
      '-batchmode',
      '-quit',
      '-nographics',
      '-projectPath',
      config.targetProjectPath,
      '-logFile',
      logPath,
    ],
    config.unityTimeoutMs,
    signal,
  );

  const content = readLogSafely(logPath);
  const errors = parseCompileErrors(content);

  if (outcome.aborted) {
    return {
      ok: false,
      errors,
      logPath,
      exitCode: outcome.exitCode,
      timedOut: false,
      failureReason: ABORT_MESSAGE,
      aborted: true,
    };
  }

  if (outcome.timedOut) {
    return {
      ok: false,
      errors,
      logPath,
      exitCode: outcome.exitCode,
      timedOut: true,
      failureReason: `Unity 배치모드가 ${config.unityTimeoutMs}ms 내에 종료되지 않았습니다.`,
    };
  }

  if (errors.length > 0) {
    log.warn(`C# 컴파일 에러 ${errors.length}건 감지`);
    return { ok: false, errors, logPath, exitCode: outcome.exitCode, timedOut: false };
  }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      errors,
      logPath,
      exitCode: outcome.exitCode,
      timedOut: false,
      failureReason:
        outcome.stderr ||
        `Unity 가 비정상 종료했습니다 (exit code ${outcome.exitCode}). 라이선스/에디터 잠금 여부를 확인하세요.`,
    };
  }

  log.info('컴파일 검수 통과');
  return { ok: true, errors: [], logPath, exitCode: outcome.exitCode, timedOut: false };
}

interface NUnitCase {
  '@_name'?: string;
  '@_fullname'?: string;
  '@_result'?: string;
  failure?: { message?: string | { '#text'?: string }; 'stack-trace'?: string };
}

function collectTestCases(node: unknown, acc: NUnitCase[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectTestCases(child, acc));
    return;
  }
  const record = node as Record<string, unknown>;
  if (record['test-case']) {
    const cases = record['test-case'];
    if (Array.isArray(cases)) acc.push(...(cases as NUnitCase[]));
    else acc.push(cases as NUnitCase);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectTestCases(value, acc);
  }
}

export function parseNUnitResults(xml: string): Omit<UnityTestResult, 'skipped' | 'resultPath'> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml) as unknown;

  const cases: NUnitCase[] = [];
  collectTestCases(parsed, cases);

  const failures: { name: string; message: string }[] = [];
  let passed = 0;

  for (const testCase of cases) {
    const result = (testCase['@_result'] ?? '').toLowerCase();
    if (result === 'passed') {
      passed += 1;
      continue;
    }
    if (result === 'failed' || result === 'error') {
      const rawMessage = testCase.failure?.message;
      const message =
        typeof rawMessage === 'string' ? rawMessage : (rawMessage?.['#text'] ?? '실패 사유 없음');
      failures.push({
        name: testCase['@_fullname'] ?? testCase['@_name'] ?? '(unnamed)',
        message: String(message).trim(),
      });
    }
  }

  return {
    ok: failures.length === 0,
    total: cases.length,
    passed,
    failed: failures.length,
    failures,
  };
}

export async function runUnityTests(
  config: OrchestratorConfig,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<UnityTestResult> {
  if (!enabled) return skippedTestResult();
  if (config.unityValidationBackend === 'batch') return runUnityTestsBatch(config, signal);
  return runUnityTestsCli(config, signal);
}

async function runUnityTestsCli(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<UnityTestResult> {
  const resultPath = path.join(config.logsDir, 'unity_test_results.json');
  log.info('Unity CLI EditMode 테스트 실행...');
  const timeoutSec = Math.max(30, Math.ceil(config.unityTimeoutMs / 1000));

  try {
    throwIfAborted(signal, ABORT_MESSAGE);
    const wasPlaying = await stopPlayModeCli(config, signal);
    try {
      const started = await unityCommand(
        config,
        'run_tests',
        ['--mode', 'editor', '--async_tests', 'true', '--timeout', String(timeoutSec)],
        { timeoutMs: 60_000, signal },
      );
      writeLog(resultPath, JSON.stringify(started.payload ?? started.stdout, null, 2));
      const immediate = parsePipelineTest(started.payload);
      if (immediate.done) {
        log.info(`테스트 결과: ${immediate.passed}/${immediate.total} 통과 (Unity CLI)`);
        return { ...immediate, skipped: false, resultPath };
      }

      const deadline = Date.now() + config.unityTimeoutMs;
      let last = immediate;
      while (Date.now() < deadline) {
        throwIfAborted(signal, ABORT_MESSAGE);
        try {
          const polled = await unityCommand(config, 'test_status', [], { timeoutMs: 30_000, signal });
          writeLog(resultPath, JSON.stringify(polled.payload ?? polled.stdout, null, 2));
          last = parsePipelineTest(polled.payload);
          if (last.done) {
            log.info(`테스트 결과: ${last.passed}/${last.total} 통과 (Unity CLI)`);
            return { ...last, skipped: false, resultPath };
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (!isTransientCliError(error)) throw error;
        }
        await abortableSleep(2_000, signal);
      }

      return {
        ok: false,
        skipped: false,
        total: last.total,
        passed: last.passed,
        failed: last.failed,
        failures: last.failures,
        resultPath,
        failureReason: 'EditMode 테스트가 타임아웃되었습니다.',
      };
    } finally {
      await restorePlayModeCli(config, wasPlaying, signal);
    }
  } catch (error) {
    if (isAbortError(error)) {
      await unityCommand(config, 'cancel_tests', [], { timeoutMs: 10_000 }).catch(() => undefined);
    }
    return {
      ok: false,
      skipped: false,
      total: 0,
      passed: 0,
      failed: 0,
      failures: [],
      resultPath,
      failureReason: (error as Error).message,
      aborted: isAbortError(error),
    };
  }
}

/** 배치모드 Test Runner. UNITY_VALIDATION_BACKEND=batch 전용. */
async function runUnityTestsBatch(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<UnityTestResult> {
  const empty = skippedTestResult();
  if (!config.unityPath) return empty;

  const resultPath = path.join(config.logsDir, 'unity_test_results.xml');
  const logPath = path.join(config.logsDir, 'unity_test.log');
  if (fs.existsSync(resultPath)) fs.rmSync(resultPath, { force: true });

  log.info('Unity Batchmode EditMode 테스트 실행...');
  const outcome = await spawnUnity(
    config,
    [
      '-batchmode',
      '-nographics',
      '-projectPath',
      config.targetProjectPath,
      '-runTests',
      '-testPlatform',
      'EditMode',
      '-testResults',
      resultPath,
      '-logFile',
      logPath,
    ],
    config.unityTimeoutMs,
    signal,
  );

  if (outcome.aborted) {
    return {
      ...empty,
      ok: false,
      skipped: false,
      resultPath,
      failureReason: ABORT_MESSAGE,
      aborted: true,
    };
  }

  if (!fs.existsSync(resultPath)) {
    return {
      ...empty,
      ok: false,
      skipped: false,
      resultPath,
      failureReason: outcome.timedOut
        ? 'EditMode 테스트가 타임아웃되었습니다.'
        : `테스트 결과 XML 이 생성되지 않았습니다 (exit code ${outcome.exitCode}).`,
    };
  }

  const parsedResult = parseNUnitResults(fs.readFileSync(resultPath, 'utf8'));
  log.info(`테스트 결과: ${parsedResult.passed}/${parsedResult.total} 통과`);
  return { ...parsedResult, skipped: false, resultPath };
}

/** 실패한 컴파일 결과를 Agent 재지시용 피드백 문자열로 변환한다. */
export function formatCompileFeedback(result: UnityCompileResult, maxLines: number): string {
  if (result.errors.length === 0) {
    return result.failureReason ?? 'Unity 컴파일이 실패했지만 구체적인 에러 라인을 찾지 못했습니다.';
  }

  const lines = result.errors.slice(0, maxLines).map((error, index) => {
    const location = error.line > 0 ? `${error.file}(${error.line})` : error.file;
    return `${index + 1}. ${location}: ${error.code}: ${error.message}`;
  });

  const omitted = result.errors.length - lines.length;
  const suffix = omitted > 0 ? `\n... 외 ${omitted}건 (전체 로그: ${result.logPath})` : '';

  return `C# 컴파일 에러 발생 (총 ${result.errors.length}건):\n${lines.join('\n')}${suffix}`;
}

export function formatTestFeedback(result: UnityTestResult, maxItems: number): string {
  if (result.failureReason) return result.failureReason;
  const items = result.failures
    .slice(0, maxItems)
    .map((failure, index) => `${index + 1}. ${failure.name}\n   → ${failure.message}`);
  return `EditMode 테스트 실패 (${result.failed}/${result.total}):\n${items.join('\n')}`;
}
