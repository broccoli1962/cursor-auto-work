import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { createLogger } from './logger';
import type {
  CompileError,
  OrchestratorConfig,
  UnityCompileResult,
  UnityTestResult,
} from './types';

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
  stderr: string;
}

function spawnUnity(
  config: OrchestratorConfig,
  args: string[],
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    log.debug(`${config.unityPath} ${args.join(' ')}`);
    const child = spawn(config.unityPath, args, {
      cwd: config.targetProjectPath,
      windowsHide: true,
    });

    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`Unity 배치모드 타임아웃 (${timeoutMs}ms) - 프로세스를 종료합니다.`);
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stderr: stderr.trim() });
    };

    child.on('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`;
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

/**
 * Unity 를 배치모드로 기동해 C# 스크립트를 컴파일하고 unity_build.log 에서 에러를 파싱한다.
 * Unity 는 컴파일 에러가 있어도 exit code 0 을 반환하는 경우가 있어 로그 파싱을 1차 판정 근거로 삼는다.
 */
export async function runUnityCompile(config: OrchestratorConfig): Promise<UnityCompileResult> {
  const logPath = path.join(config.logsDir, 'unity_build.log');
  fs.mkdirSync(config.logsDir, { recursive: true });
  if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });

  if (!config.unityPath) {
    return {
      ok: true,
      errors: [],
      logPath,
      exitCode: null,
      timedOut: false,
      failureReason: 'UNITY_PATH 미설정으로 컴파일 검수를 건너뛰었습니다.',
    };
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
  );

  const content = readLogSafely(logPath);
  const errors = parseCompileErrors(content);

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

/** Unity Test Runner(EditMode)를 실행하고 NUnit XML 결과를 파싱한다. */
export async function runUnityTests(
  config: OrchestratorConfig,
  enabled: boolean,
): Promise<UnityTestResult> {
  const empty: UnityTestResult = {
    ok: true,
    skipped: true,
    total: 0,
    passed: 0,
    failed: 0,
    failures: [],
  };

  if (!enabled || !config.unityPath) return empty;

  const resultPath = path.join(config.logsDir, 'unity_test_results.xml');
  const logPath = path.join(config.logsDir, 'unity_test.log');
  if (fs.existsSync(resultPath)) fs.rmSync(resultPath, { force: true });

  log.info('Unity EditMode 테스트 실행...');
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
  );

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
