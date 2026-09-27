import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { createLogger } from './logger';
import { ABORT_MESSAGE, abortableSleep, isAbortError, killChildTree, throwIfAborted } from './processKill';
import type { OrchestratorConfig, UnityInstallMode } from './types';

const log = createLogger('unity-cli');

const INSTALL_SCRIPT_WIN =
  "https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1";
const INSTALL_SCRIPT_POSIX = 'https://unity.com/install.sh';

export interface UnityCliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  payload: unknown;
}

export interface ConnectedEditor {
  projectPath: string;
  state: string;
  port?: number;
  pid?: number;
}

export interface UnityCliEnsureResult {
  ok: boolean;
  missing: boolean;
  message: string;
  version?: string;
}

export interface PipelineTestSnapshot {
  done: boolean;
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
}

export function planUnityCliInstall(args: {
  present: boolean;
  mode: UnityInstallMode;
  interactive: boolean;
  confirmed: boolean;
}): 'ready' | 'install' | 'refuse' {
  if (args.present) return 'ready';
  if (args.mode === 'yes') return 'install';
  if (args.mode === 'no') return 'refuse';
  if (args.interactive && args.confirmed) return 'install';
  return 'refuse';
}

export function unityCliMissingHelp(): string {
  const lines = [
    'Unity CLI(`unity`)가 설치되어 있지 않습니다.',
    `Windows: $env:UNITY_CLI_CHANNEL='beta'; irm ${INSTALL_SCRIPT_WIN} | iex`,
    `macOS/Linux: curl -fsSL ${INSTALL_SCRIPT_POSIX} | bash`,
    '또는 Windows: winget install Unity.CLI',
    '설치 후 터미널을 다시 열거나 UNITY_CLI_BIN 에 실행 파일 경로를 지정하세요.',
    '질문 없이 설치하려면 UNITY_CLI_INSTALL=yes 또는 --install-unity-cli 를 사용하세요.',
  ];
  return lines.join('\n');
}

export function parseCliStdout(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // 배너나 진행 로그가 앞에 붙는 경우가 있다.
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.startsWith('{') && !line?.startsWith('[')) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // 다음 줄을 본다.
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** recompile_status 토큰. ok 면 컴파일 종료, fail 이면 실패, wait 면 계속 폴링. */
export function recompilePhase(status: string): 'ok' | 'fail' | 'wait' {
  const normalized = status.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'completed' || normalized === 'up_to_date') return 'ok';
  if (normalized === 'failed' || normalized === 'error') return 'fail';
  return 'wait';
}

export function unwrapCliData(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const rec = payload as Record<string, unknown>;
  if ('data' in rec && (rec.success !== undefined || rec.command !== undefined)) return rec.data;
  return payload;
}

export function cliFailureText(payload: unknown, stderr: string, exitCode: number | null): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const rec = payload as Record<string, unknown>;
    if (rec.success === false || rec.ok === false) {
      if (Array.isArray(rec.errors) && rec.errors.length > 0) return rec.errors.map(String).join('\n');
      if (typeof rec.error === 'string' && rec.error.trim()) return rec.error.trim();
      const err = stderr.trim();
      return err || 'Unity CLI 명령이 실패했습니다.';
    }
  }
  if (exitCode !== 0 && exitCode !== null) {
    const err = stderr.trim();
    return err || `Unity CLI 가 종료했습니다 (exit ${exitCode}).`;
  }
  return undefined;
}

export function isTransientEditorError(text: string): boolean {
  return /ECONNREFUSED|ECONNRESET|connection refused|not connected|no running editor|no editor instance|unreachable|domain reload|socket hang up/i.test(
    text,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function readString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const lower = new Map(Object.entries(rec).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lower.get(key.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function parseStatusToken(payload: unknown): string {
  const data = unwrapCliData(payload);
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseStatusToken(JSON.parse(trimmed) as unknown);
      } catch {
        return trimmed.toLowerCase();
      }
    }
    return trimmed.toLowerCase();
  }
  const rec = asRecord(data);
  if (!rec) return '';
  const status = readString(rec, ['status', 'state']);
  return status ? status.toLowerCase() : '';
}

export function parseConnectedEditors(payload: unknown): ConnectedEditor[] {
  const found: ConnectedEditor[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const rec = value as Record<string, unknown>;
    const project = readString(rec, ['projectPath', 'project_path', 'ProjectPath', 'project']);
    const port = readNumber(rec, ['port', 'Port']);
    const pid = readNumber(rec, ['pid', 'PID', 'processId']);
    const state = readString(rec, ['state', 'status', 'editorState']) ?? '';
    const pathLike = project && /[\\/]/.test(project) ? project : undefined;
    if (pathLike && (port !== undefined || pid !== undefined || state)) {
      found.push({ projectPath: pathLike, state, port, pid });
    }
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(unwrapCliData(payload) ?? payload);

  const deduped: ConnectedEditor[] = [];
  const seen = new Set<string>();
  for (const editor of found) {
    const key = `${normalizeProjectPath(editor.projectPath)}:${editor.port ?? ''}:${editor.pid ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(editor);
  }
  return deduped;
}

export function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replace(/[\\/]+$/, '').toLowerCase();
}

export function editorMatchesProject(editor: ConnectedEditor, projectPath: string): boolean {
  return normalizeProjectPath(editor.projectPath) === normalizeProjectPath(projectPath);
}

export function editorLooksLive(editor: ConnectedEditor): boolean {
  const state = editor.state.toLowerCase();
  if (!state) return true;
  return !/disconnect|offline|stopped|exited|not running/.test(state);
}

export function parseEditorPlaying(payload: unknown): boolean | undefined {
  const visit = (value: unknown): boolean | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    const rec = value as Record<string, unknown>;
    for (const key of ['isPlaying', 'is_playing', 'playing']) {
      const raw = rec[key];
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') {
        const text = raw.toLowerCase();
        if (text === 'true' || text === 'playing') return true;
        if (text === 'false' || text === 'stopped') return false;
      }
    }
    const mode = readString(rec, ['playMode', 'playmode', 'play_mode']);
    if (mode) {
      const text = mode.toLowerCase();
      if (text === 'playing' || text === 'play') return true;
      if (text === 'stopped' || text === 'edit' || text === 'editmode' || text === 'false') return false;
    }
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') {
        const hit = visit(child);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return visit(unwrapCliData(payload) ?? payload);
}

export function parsePipelineInstalled(payload: unknown, rawText: string): boolean | undefined {
  const visit = (value: unknown): boolean | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    const rec = value as Record<string, unknown>;
    if (typeof rec.pipelineInstalled === 'boolean') return rec.pipelineInstalled;
    if (typeof rec.installed === 'boolean' && ('pipeline' in rec || 'packageName' in rec || 'package' in rec)) {
      return rec.installed;
    }
    const pipeline = rec.pipeline ?? rec.Pipeline;
    if (typeof pipeline === 'string') {
      if (/not\s*installed/i.test(pipeline)) return false;
      if (/installed/i.test(pipeline)) return true;
    }
    if (pipeline && typeof pipeline === 'object') {
      const hit = visit(pipeline);
      if (hit !== undefined) return hit;
    }
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') {
        const hit = visit(child);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };

  const structured = visit(unwrapCliData(payload) ?? payload);
  if (structured !== undefined) return structured;
  if (/Pipeline:\s*Not installed/i.test(rawText)) return false;
  if (/Pipeline:\s*Installed/i.test(rawText)) return true;
  return undefined;
}

export function parsePipelineTest(payload: unknown): PipelineTestSnapshot {
  const data = unwrapCliData(payload);
  const root = asRecord(data) ?? {};
  const nested = asRecord(root.data) ?? asRecord(root.results) ?? root;
  const status = parseStatusToken(data);
  const done = [
    'completed',
    'complete',
    'finished',
    'failed',
    'error',
    'cancelled',
    'canceled',
    'succeeded',
    'success',
  ].includes(status);

  const failedRaw =
    nested.failed_tests ?? nested.failedTests ?? nested.failures ?? root.failed_tests ?? root.failedTests;
  const failures: { name: string; message: string }[] = [];
  if (Array.isArray(failedRaw)) {
    for (const item of failedRaw) {
      const row = asRecord(item);
      if (!row) continue;
      failures.push({
        name: String(row.name ?? row.fullname ?? row.fullName ?? '(unnamed)'),
        message: String(row.message ?? row.reason ?? row.error ?? '실패 사유 없음'),
      });
    }
  }

  const passed = Number(nested.passed ?? root.passed ?? 0);
  const failed = Number(nested.failed ?? root.failed ?? failures.length);
  const total = Number(nested.total ?? root.total ?? (Number.isFinite(passed) ? passed : 0) + (Number.isFinite(failed) ? failed : 0));
  const failedCount = Number.isFinite(failed) ? failed : failures.length;
  const ok = done && failures.length === 0 && failedCount === 0 && status !== 'failed' && status !== 'error';

  return {
    done,
    ok,
    total: Number.isFinite(total) ? total : failures.length,
    passed: Number.isFinite(passed) ? passed : 0,
    failed: failedCount,
    failures,
  };
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UNITY_NON_INTERACTIVE: '1',
    UNITY_NO_BANNER: '1',
    UNITY_NO_UPDATE_CHECK: '1',
    UNITY_NO_CONSENT_PROMPT: '1',
    UNITY_NO_PAGER: '1',
  };
}

function prependPath(dir: string): void {
  const current = process.env.PATH ?? '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const normalized = path.normalize(dir).toLowerCase();
  if (parts.some((entry) => path.normalize(entry).toLowerCase() === normalized)) return;
  const next = `${dir}${path.delimiter}${current}`;
  process.env.PATH = next;
  if (process.platform === 'win32') process.env.Path = next;
}

export function unityCliCandidatePaths(): string[] {
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['unity.exe', 'unity.cmd'] : ['unity'];
  const roots = [
    process.env.UNITY_CLI_HOME ? path.join(process.env.UNITY_CLI_HOME, 'bin') : '',
    path.join(home, '.unity', 'bin'),
    path.join(home, '.local', 'bin'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Unity', 'cli') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'unity-cli') : '',
  ].filter(Boolean);

  if (process.platform === 'win32') roots.push(...windowsPathDirs());

  const files: string[] = [];
  for (const root of roots) {
    for (const name of names) files.push(path.join(root, name));
  }
  return files;
}

function windowsPathDirs(): string[] {
  const dirs: string[] = [];
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /Path\s+REG_\w+\s+(.+)/i.exec(out);
      if (!match?.[1]) continue;
      for (const entry of match[1].split(';')) {
        const expanded = entry
          .trim()
          .replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? '');
        if (expanded) dirs.push(expanded);
      }
    } catch {
      // 레지스트리 PATH 가 없으면 후보 경로만 본다.
    }
  }
  return dirs;
}

export async function runUnityCli(
  config: OrchestratorConfig,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; inheritStdio?: boolean } = {},
): Promise<UnityCliRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const bin = config.unityCliBin || 'unity';
  throwIfAborted(options.signal, ABORT_MESSAGE);

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: ABORT_MESSAGE,
        timedOut: false,
        aborted: true,
        payload: undefined,
      });
      return;
    }

    const useShell = process.platform === 'win32' && !path.isAbsolute(bin);
    log.debug(`${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, {
      cwd: config.targetProjectPath,
      env: cliEnvironment(),
      windowsHide: true,
      shell: useShell,
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`Unity CLI 타임아웃 (${timeoutMs}ms)`);
      killChildTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      killChildTree(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (!options.inheritStdio) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      });
    }

    const settle = (exitCode: number | null, spawnError = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const mergedErr = `${stderr}${spawnError}`.trim();
      const payload = options.inheritStdio ? undefined : parseCliStdout(stdout);
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: mergedErr,
        timedOut,
        aborted,
        payload,
      });
    };

    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      settle(null, missing ? `\n${unityCliMissingHelp()}` : `\n[spawn error] ${error.message}`);
    });
    child.on('close', (code) => settle(code));
  });
}

const GLOBAL_FLAGS = ['--non-interactive', '--no-banner', '--format', 'json'];

export async function unityCommand(
  config: OrchestratorConfig,
  name: string,
  commandArgs: string[] = [],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<UnityCliRunResult> {
  const result = await runUnityCli(
    config,
    [
      ...GLOBAL_FLAGS,
      'command',
      name,
      '--project-path',
      config.targetProjectPath,
      ...commandArgs,
    ],
    options,
  );
  if (result.aborted) throw new Error(ABORT_MESSAGE);
  if (result.timedOut) {
    throw new Error(`unity command ${name} 이 ${options.timeoutMs ?? 60_000}ms 내에 끝나지 않았습니다.`);
  }
  if (result.exitCode === null) {
    throw new Error(result.stderr || `unity command ${name} 프로세스를 시작하지 못했습니다.`);
  }
  const failure = cliFailureText(result.payload, result.stderr, result.exitCode);
  if (failure && !isTransientEditorError(`${failure}\n${result.stderr}`)) {
    throw new Error(failure);
  }
  if (failure && isTransientEditorError(failure)) {
    throw Object.assign(new Error(failure), { transient: true });
  }
  return result;
}

export function isTransientCliError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return isTransientEditorError(message) || Boolean((error as { transient?: boolean }).transient);
}

async function probeVersion(config: OrchestratorConfig): Promise<string | undefined> {
  const result = await runUnityCli(config, ['--version'], { timeoutMs: 20_000 });
  if (result.aborted) throw new Error(ABORT_MESSAGE);
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/not recognized|ENOENT|아닙니다|No such file/i.test(item));
  if (!line || result.exitCode !== 0) return undefined;
  return line;
}

function rememberBin(config: OrchestratorConfig, bin: string): void {
  config.unityCliBin = bin;
  if (path.isAbsolute(bin)) prependPath(path.dirname(bin));
}

async function findInstalledBin(config: OrchestratorConfig): Promise<string | undefined> {
  const configured = config.unityCliBin || 'unity';
  if (path.isAbsolute(configured) && fs.existsSync(configured)) return configured;

  const probed = { ...config, unityCliBin: configured };
  const version = await probeVersion(probed).catch((error) => {
    if (isAbortError(error)) throw error;
    return undefined;
  });
  if (version) return configured;

  for (const candidate of unityCliCandidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    const check = { ...config, unityCliBin: candidate };
    const found = await probeVersion(check).catch(() => undefined);
    if (found) return candidate;
  }
  return undefined;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    return /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

async function installUnityCliBinary(signal?: AbortSignal): Promise<string> {
  log.info('Unity CLI 설치 스크립트를 실행합니다.');
  const timeoutMs = 10 * 60 * 1000;
  if (process.platform === 'win32') {
    const command = `$env:UNITY_CLI_CHANNEL='beta'; irm ${INSTALL_SCRIPT_WIN} | iex`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { stdio: 'inherit', windowsHide: false },
    );
    await waitChild(child, timeoutMs, signal);
    return 'Windows 설치 스크립트';
  }

  const child = spawn('bash', ['-lc', `curl -fsSL ${INSTALL_SCRIPT_POSIX} | bash`], {
    stdio: 'inherit',
    windowsHide: true,
  });
  await waitChild(child, timeoutMs, signal);
  return '설치 스크립트';
}

function waitChild(child: ReturnType<typeof spawn>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      killChildTree(child);
      finish(new Error(`설치가 ${timeoutMs}ms 내에 끝나지 않았습니다.`));
    }, timeoutMs);
    const onAbort = (): void => {
      killChildTree(child);
      finish(new Error(ABORT_MESSAGE));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Unity CLI 설치가 실패했습니다 (exit ${code ?? 'null'}).`));
    });
  });
}

/**
 * `unity` 가 없으면 설정에 따라 질문하거나 공식 설치 스크립트를 실행한다.
 * 성공 시 config.unityCliBin 을 해석된 경로로 바꾼다.
 */
export async function ensureUnityCli(
  config: OrchestratorConfig,
  options: { required?: boolean; signal?: AbortSignal } = {},
): Promise<UnityCliEnsureResult> {
  throwIfAborted(options.signal, ABORT_MESSAGE);
  const required = options.required === true;
  const existing = await findInstalledBin(config);
  if (existing) {
    rememberBin(config, existing);
    const version = await probeVersion(config).catch(() => undefined);
    const shown = version ?? existing;
    return { ok: true, missing: false, message: `Unity CLI ${shown}`, version: shown };
  }

  if (!required) {
    return { ok: true, missing: true, message: 'Unity CLI 미설치 (이 검수 모드에서는 사용하지 않음)' };
  }

  const interactive = Boolean(input.isTTY && output.isTTY);
  let confirmed = false;
  if (config.unityCliInstall === 'ask' && interactive) {
    confirmed = await askYesNo('Unity CLI(`unity`)가 없습니다. 공식 설치 스크립트를 실행할까요? [y/N] ');
  }
  const action = planUnityCliInstall({
    present: false,
    mode: config.unityCliInstall,
    interactive,
    confirmed,
  });
  if (action !== 'install') {
    return { ok: false, missing: true, message: unityCliMissingHelp() };
  }

  try {
    await installUnityCliBinary(options.signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      ok: false,
      missing: true,
      message: `Unity CLI 설치에 실패했습니다: ${(error as Error).message}\n${unityCliMissingHelp()}`,
    };
  }

  const installed = await findInstalledBin(config);
  if (!installed) {
    return {
      ok: false,
      missing: true,
      message: `설치 스크립트는 끝났지만 이 프로세스에서 unity 를 찾지 못했습니다. 터미널을 다시 연 뒤 다시 실행하거나 UNITY_CLI_BIN 을 지정하세요.\n${unityCliMissingHelp()}`,
    };
  }
  rememberBin(config, installed);
  const version = await probeVersion(config).catch(() => undefined);
  log.info(`Unity CLI 설치됨: ${version ?? installed}`);
  return { ok: true, missing: false, message: `Unity CLI ${version ?? installed}`, version: version ?? installed };
}

export async function listConnectedEditors(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<ConnectedEditor[]> {
  const result = await runUnityCli(
    config,
    [...GLOBAL_FLAGS, 'status'],
    { timeoutMs: 30_000, signal },
  );
  if (result.aborted) throw new Error(ABORT_MESSAGE);
  if (result.timedOut) throw new Error('unity status 가 30초 내에 응답하지 않았습니다.');
  const editors = parseConnectedEditors(result.payload);
  if (editors.length > 0) return editors;
  const listed = await runUnityCli(
    config,
    [...GLOBAL_FLAGS, 'pipeline', 'list', '--project-path', config.targetProjectPath],
    { timeoutMs: 30_000, signal },
  );
  if (listed.aborted) throw new Error(ABORT_MESSAGE);
  return parseConnectedEditors(listed.payload);
}

export async function detectPipeline(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const listed = await runUnityCli(
    config,
    [...GLOBAL_FLAGS, 'pipeline', 'list', '--project-path', config.targetProjectPath],
    { timeoutMs: 30_000, signal },
  );
  if (listed.aborted) throw new Error(ABORT_MESSAGE);
  const fromList = parsePipelineInstalled(listed.payload, `${listed.stdout}\n${listed.stderr}`);
  if (fromList !== undefined) return fromList;

  try {
    await unityCommand(config, 'recompile_status', [], { timeoutMs: 30_000, signal });
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = (error as Error).message;
    if (/unknown command|no such command|command not found|pipeline package|is not installed/i.test(message)) return false;
    return undefined;
  }
}

export async function installPipelinePackage(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  log.info('Unity Pipeline 패키지를 설치합니다 (unity pipeline install).');
  const result = await runUnityCli(
    config,
    ['--non-interactive', '--no-banner', 'pipeline', 'install', '--project-path', config.targetProjectPath],
    { timeoutMs: config.unityTimeoutMs, signal, inheritStdio: true },
  );
  if (result.aborted) return { ok: false, message: ABORT_MESSAGE };
  if (result.timedOut) {
    return { ok: false, message: `unity pipeline install 이 ${config.unityTimeoutMs}ms 내에 끝나지 않았습니다.` };
  }
  if (result.exitCode === 3) {
    return { ok: false, message: 'Unity 계정 인증이 필요합니다. 터미널에서 `unity auth login` 을 실행한 뒤 다시 시도하세요.' };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      message: result.stderr || `unity pipeline install 실패 (exit ${result.exitCode ?? 'null'}).`,
    };
  }
  return { ok: true, message: 'Unity Pipeline 패키지를 설치했습니다.' };
}

export async function promptInstall(question: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  return askYesNo(question);
}

/**
 * `unity open` 으로 프로젝트를 연다.
 * CLI 가 기동 직후 바로 끝나면 성공으로 보고, 20초 넘게 살아 있으면 에디터 프로세스로 간주하고 분리한다.
 */
export function openProjectWithCli(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  throwIfAborted(signal, ABORT_MESSAGE);
  const bin = config.unityCliBin || 'unity';
  return new Promise((resolve) => {
    const child = spawn(bin, ['--non-interactive', '--no-banner', 'open', config.targetProjectPath], {
      cwd: config.targetProjectPath,
      env: cliEnvironment(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: process.platform === 'win32' && !path.isAbsolute(bin),
    });

    let settled = false;
    const finish = (result: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.unref();
      finish({ ok: true, message: 'unity open 이 에디터를 띄우는 중입니다.' });
    }, 20_000);
    const onAbort = (): void => {
      killChildTree(child);
      finish({ ok: false, message: ABORT_MESSAGE });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish({ ok: false, message: error.message }));
    child.on('close', (code) => {
      if (code === 0 || code === null) finish({ ok: true, message: 'unity open 이 반환되었습니다.' });
      else finish({ ok: false, message: `unity open 실패 (exit ${code}).` });
    });
  });
}

export async function waitForRecompile(
  config: OrchestratorConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal, ABORT_MESSAGE);
    try {
      const result = await unityCommand(config, 'recompile_status', [], { timeoutMs: 30_000, signal });
      const phase = recompilePhase(parseStatusToken(result.payload));
      if (phase === 'ok') return;
      if (phase === 'fail') {
        throw new Error(`스크립트 재컴파일이 실패했습니다 (status=${parseStatusToken(result.payload) || 'failed'}).`);
      }
      await abortableSleep(2_000, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!isTransientCliError(error)) throw error;
      await abortableSleep(2_000, signal);
    }
  }
  throw new Error(`스크립트 재컴파일이 ${timeoutMs}ms 내에 끝나지 않았습니다.`);
}
