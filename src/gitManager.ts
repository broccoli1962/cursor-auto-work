import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { createLogger } from './logger';
import { killChildTree } from './processKill';
import type { GitDiffResult, OrchestratorConfig } from './types';

const log = createLogger('git');

/** execFile maxBuffer 대신 spawn 으로 흘려 읽는다. 본문은 자르지 않는다. */
const STDERR_TAIL_BYTES = 16_000;

class GitCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stdout: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = 'GitCommandError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function pushTail(chunks: Buffer[], chunk: Buffer, cap: number): number {
  chunks.push(chunk);
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > cap && chunks.length > 1) {
    total -= chunks[0]!.length;
    chunks.shift();
  }
  return total;
}

function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      pushTail(errChunks, chunk, STDERR_TAIL_BYTES);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        reject(
          new GitCommandError(
            `git ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim() || 'no output'}`,
            stdout,
            stderr,
            code,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** 한 줄씩 콜백. false 를 반환하면 프로세스를 끊고 성공으로 끝낸다. */
function runGitLines(
  cwd: string,
  args: string[],
  onLine: (line: string) => boolean | void,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let pending = '';
    let stopped = false;
    const errChunks: Buffer[] = [];

    const feed = (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      let idx = pending.indexOf('\n');
      while (idx !== -1) {
        const line = pending.slice(0, idx).replace(/\r$/, '');
        pending = pending.slice(idx + 1);
        if (onLine(line) === false) {
          stopped = true;
          killChildTree(child);
          return;
        }
        idx = pending.indexOf('\n');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => feed(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      pushTail(errChunks, chunk, STDERR_TAIL_BYTES);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stopped && pending) {
        const line = pending.replace(/\r$/, '');
        pending = '';
        if (onLine(line) === false) stopped = true;
      }
      if (code !== 0 && !stopped) {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        reject(
          new GitCommandError(
            `git ${args.join(' ')} failed (${code}): ${stderr.trim() || 'no output'}`,
            '',
            stderr,
            code,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

/** 커밋 전에 걸러내야 할 컨벤션 위반 패턴 (git diff + 라인 형식) */
const CONVENTION_RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /^\+.*\bDebug\.Log(?:Warning|Error|Format)?\s*\(/, message: 'Debug.Log 계열 호출이 추가되었습니다.' },
  { pattern: /^\+.*\bconsole\.log\s*\(/, message: 'console.log 호출이 추가되었습니다.' },
  { pattern: /^\+.*\/\/\s*(?:TODO|FIXME|HACK)\b/i, message: 'TODO/FIXME/HACK 주석이 추가되었습니다.' },
  { pattern: /^\+.*<<<<<<<\s/, message: '머지 충돌 마커가 남아 있습니다.' },
];

async function git(
  config: OrchestratorConfig,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return runGit(config.targetProjectPath, args, { env });
}

function fileStartsWithNul(absolute: string): boolean {
  const fd = fs.openSync(absolute, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

async function forEachFileLine(
  absolute: string,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  const stream = fs.createReadStream(absolute, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (onLine(line) === false) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function isGitRepo(config: OrchestratorConfig): Promise<boolean> {
  try {
    const out = await git(config, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export async function ensureGitRepo(config: OrchestratorConfig): Promise<boolean> {
  if (await isGitRepo(config)) return true;
  log.warn('Git 저장소가 아닙니다. 자동 커밋 기능이 비활성화됩니다.');
  return false;
}

/** 린트/커밋 대상에서 제외할 바이너리·에셋 확장자 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tga',
  '.psd',
  '.tif',
  '.tiff',
  '.exr',
  '.hdr',
  '.fbx',
  '.obj',
  '.blend',
  '.dae',
  '.glb',
  '.gltf',
  '.mp3',
  '.wav',
  '.ogg',
  '.aiff',
  '.mp4',
  '.mov',
  '.avi',
  '.unitypackage',
  '.dll',
  '.so',
  '.dylib',
  '.zip',
  '.7z',
  '.rar',
  '.pdf',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
]);

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** prefix 와 같거나 그 하위 경로이면 true. scope 가 비면 전부 포함. */
export function inScope(filePath: string, scope?: string[]): boolean {
  if (!scope || scope.length === 0) return true;
  const normalized = normalizeRepoPath(filePath);
  return scope.some((prefix) => {
    const base = normalizeRepoPath(prefix).replace(/\/$/, '');
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

export function filterScoped(files: string[], scope?: string[]): string[] {
  return files.filter((file) => inScope(file, scope));
}

export interface WorkingTreeSnapshot {
  /** posix 상대경로 → 내용 해시. 삭제된 tracked 파일은 null */
  hashes: Record<string, string | null>;
}

function hashPath(absolute: string): string | null {
  try {
    if (!fs.existsSync(absolute)) return null;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) return `dir:${stat.mtimeMs}:${stat.ino ?? 0}`;
    return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch {
    return null;
  }
}

function skipLintFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('.meta') || normalized.includes('/Logs/')) return true;
  return BINARY_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function recordViolation(file: string, line: string, violations: string[]): void {
  if (skipLintFile(file)) return;
  for (const rule of CONVENTION_RULES) {
    if (!rule.pattern.test(line)) continue;
    const entry = `${file}: ${rule.message}`;
    if (!violations.includes(entry)) violations.push(entry);
  }
}

const TRIVIAL_LINE = /^\s*(?:\/\/.*|\/\*|\*\/|\*.*|#(?:region|endregion)\b.*|using\s+[\w.]+;\s*)?$/;

/** unified diff 의 +/- 한 줄이 공백·주석·using 뿐인지 */
export function isTrivialDiffLine(line: string): boolean {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return true;
  if (!(line.startsWith('+') || line.startsWith('-'))) return true;
  return TRIVIAL_LINE.test(line.slice(1));
}

export function diffHasMeaningfulEdits(diffText: string): boolean {
  if (/^Binary files /m.test(diffText)) return true;
  for (const line of diffText.split(/\r?\n/)) {
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      if (!isTrivialDiffLine(line)) return true;
    }
  }
  return false;
}

async function fileHasMeaningfulContent(projectRoot: string, relativePath: string): Promise<boolean> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.endsWith('.meta') || normalized.includes('/Logs/')) return false;
  if (BINARY_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return true;
  const absolute = path.join(projectRoot, relativePath);
  try {
    if (fileStartsWithNul(absolute)) return true;
    let found = false;
    await forEachFileLine(absolute, (line) => {
      if (!TRIVIAL_LINE.test(line)) {
        found = true;
        return false;
      }
    });
    return found;
  } catch {
    return false;
  }
}

/** 범위 변경이 주석/공백/using 뿐이면 false */
export async function hasMeaningfulEdits(
  config: OrchestratorConfig,
  files: string[],
): Promise<boolean> {
  if (files.length === 0) return false;
  const untracked = await listUntrackedFiles(config);
  const tracked = files.filter((file) => !untracked.has(normalizeRepoPath(file)));
  const fresh = files.filter((file) => untracked.has(normalizeRepoPath(file)));

  for (const file of fresh) {
    if (await fileHasMeaningfulContent(config.targetProjectPath, file)) return true;
  }
  if (tracked.length === 0) return false;

  let found = false;
  const onLine = (line: string): boolean | void => {
    if (line.startsWith('Binary files ')) {
      found = true;
      return false;
    }
    if (
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---') &&
      !isTrivialDiffLine(line)
    ) {
      found = true;
      return false;
    }
  };
  await gitLinesWithPathspecs(config, ['diff', 'HEAD', '--unified=0'], tracked, onLine).catch(() =>
    gitLinesWithPathspecs(config, ['diff', '--unified=0'], tracked, onLine),
  );
  return found;
}

function createDiffScanner(violations: string[]) {
  let currentFile = '';
  let insertions = 0;
  let deletions = 0;
  return {
    line(text: string): void {
      if (text.startsWith('+++ b/')) {
        currentFile = text.slice(6);
        return;
      }
      if (text.startsWith('+') && !text.startsWith('+++')) {
        insertions += 1;
        recordViolation(currentFile, text, violations);
      }
      if (text.startsWith('-') && !text.startsWith('---')) {
        deletions += 1;
      }
    },
    result(): { insertions: number; deletions: number } {
      return { insertions, deletions };
    },
  };
}

/** untracked 파일 본문을 diff + 라인 형식으로 검사한다 (index 를 건드리지 않음). */
async function scanUntrackedFile(
  projectRoot: string,
  relativePath: string,
  violations: string[],
): Promise<number> {
  if (skipLintFile(relativePath)) return 0;

  const absolute = path.join(projectRoot, relativePath);
  try {
    if (fileStartsWithNul(absolute)) {
      log.debug(`바이너리 untracked 파일 린트 생략: ${relativePath}`);
      return 0;
    }
    let count = 0;
    await forEachFileLine(absolute, (body) => {
      recordViolation(relativePath, `+${body}`, violations);
      count += 1;
    });
    return count;
  } catch (error) {
    log.debug(`untracked 파일 읽기 실패(무시): ${relativePath} — ${(error as Error).message}`);
    return 0;
  }
}

const emptyDiff = (): GitDiffResult => ({
  hasChanges: false,
  changedFiles: [],
  insertions: 0,
  deletions: 0,
  violations: [],
});

async function listGitLines(config: OrchestratorConfig, args: string[]): Promise<string[]> {
  const lines: string[] = [];
  await runGitLines(config.targetProjectPath, args, (line) => {
    const normalized = normalizeRepoPath(line.trim());
    if (normalized) lines.push(normalized);
  });
  return lines;
}

export async function listWorkingTreeFiles(config: OrchestratorConfig): Promise<string[]> {
  if (!(await isGitRepo(config))) return [];

  const nameOnly = await listGitLines(config, ['diff', 'HEAD', '--name-only']).catch(() =>
    listGitLines(config, ['diff', '--name-only']),
  );
  const untracked = await listGitLines(config, ['ls-files', '--others', '--exclude-standard']).catch(
    () => [],
  );
  return [...new Set([...nameOnly, ...untracked])];
}

async function listUntrackedFiles(config: OrchestratorConfig): Promise<Set<string>> {
  if (!(await isGitRepo(config))) return new Set();
  const raw = await listGitLines(config, ['ls-files', '--others', '--exclude-standard']).catch(() => []);
  return new Set(raw);
}

const GIT_PATHSPEC_CHUNK = 64;

async function gitLinesWithPathspecs(
  config: OrchestratorConfig,
  args: string[],
  files: string[],
  onLine: (line: string) => boolean | void,
): Promise<void> {
  if (files.length === 0) return;
  let stop = false;
  const wrapped = (line: string): boolean | void => {
    if (stop) return;
    if (onLine(line) === false) {
      stop = true;
      return false;
    }
  };
  for (let i = 0; i < files.length; i += GIT_PATHSPEC_CHUNK) {
    if (stop) return;
    const slice = files.slice(i, i + GIT_PATHSPEC_CHUNK);
    await runGitLines(config.targetProjectPath, [...args, '--', ...slice], wrapped);
  }
}

const MAX_UNIFIED_DIFF_CHARS = 20_000;

/** 판정 Agent 용 unified diff. index 는 건드리지 않는다. */
export async function collectUnifiedDiff(
  config: OrchestratorConfig,
  files: string[],
): Promise<string> {
  if (files.length === 0 || !(await isGitRepo(config))) return '';
  const untracked = await listUntrackedFiles(config);
  const tracked = files.filter((file) => !untracked.has(normalizeRepoPath(file)));
  const fresh = files.filter((file) => untracked.has(normalizeRepoPath(file)));
  const parts: string[] = [];

  if (tracked.length > 0) {
    const diffLines: string[] = [];
    let used = 0;
    const onLine = (line: string): boolean | void => {
      if (used >= MAX_UNIFIED_DIFF_CHARS) return false;
      diffLines.push(line);
      used += line.length + 1;
      if (used >= MAX_UNIFIED_DIFF_CHARS) return false;
    };
    await gitLinesWithPathspecs(config, ['diff', 'HEAD', '--unified=3'], tracked, onLine).catch(() =>
      gitLinesWithPathspecs(config, ['diff', '--unified=3'], tracked, onLine),
    );
    if (diffLines.length > 0) parts.push(diffLines.join('\n'));
  }

  for (const file of fresh.slice(0, 8)) {
    if (skipLintFile(file)) {
      parts.push(`--- /dev/null\n+++ b/${file}\n(untracked binary)`);
      continue;
    }
    try {
      const body = fs.readFileSync(path.join(config.targetProjectPath, file), 'utf8');
      const preview = body.split(/\r?\n/).slice(0, 80).map((line) => `+${line}`).join('\n');
      parts.push(`--- /dev/null\n+++ b/${file}\n${preview}`);
    } catch {
      parts.push(`--- /dev/null\n+++ b/${file}\n(untracked, unread)`);
    }
  }

  const joined = parts.join('\n');
  return joined.length > MAX_UNIFIED_DIFF_CHARS
    ? `${joined.slice(0, MAX_UNIFIED_DIFF_CHARS)}\n... (diff truncated)`
    : joined;
}

/** 지정 파일만 컨벤션 린트한다. Git index 는 수정하지 않는다. */
export async function lintChangedFiles(
  config: OrchestratorConfig,
  files: string[],
): Promise<Pick<GitDiffResult, 'insertions' | 'deletions' | 'violations'>> {
  const violations: string[] = [];
  let insertions = 0;
  let deletions = 0;
  if (files.length === 0) return { insertions, deletions, violations };

  const untracked = await listUntrackedFiles(config);
  const tracked = files.filter((file) => !untracked.has(normalizeRepoPath(file)));
  const fresh = files.filter((file) => untracked.has(normalizeRepoPath(file)));

  if (tracked.length > 0) {
    const scanner = createDiffScanner(violations);
    await gitLinesWithPathspecs(config, ['diff', 'HEAD', '--unified=0'], tracked, (line) => {
      scanner.line(line);
    }).catch(() =>
      gitLinesWithPathspecs(config, ['diff', '--unified=0'], tracked, (line) => {
        scanner.line(line);
      }),
    );
    const counted = scanner.result();
    insertions += counted.insertions;
    deletions += counted.deletions;
  }

  for (const file of fresh) {
    insertions += await scanUntrackedFile(config.targetProjectPath, file, violations);
  }

  return { insertions, deletions, violations };
}

export async function snapshotWorkingTree(config: OrchestratorConfig): Promise<WorkingTreeSnapshot> {
  const files = await listWorkingTreeFiles(config);
  const hashes: Record<string, string | null> = {};
  for (const file of files) {
    const rel = normalizeRepoPath(file);
    hashes[rel] = hashPath(path.join(config.targetProjectPath, rel));
  }
  return { hashes };
}

/**
 * 스냅샷 이후 내용이 달라진 파일만 모은다.
 * 시작 당시 dirty 였고 그대로인 파일은 제외한다.
 */
export async function diffSinceSnapshot(
  config: OrchestratorConfig,
  snapshot: WorkingTreeSnapshot,
  scope?: string[],
): Promise<GitDiffResult> {
  if (!(await isGitRepo(config))) return emptyDiff();

  const currentFiles = new Set((await listWorkingTreeFiles(config)).map(normalizeRepoPath));
  const candidates = new Set([...Object.keys(snapshot.hashes), ...currentFiles]);
  const changed: string[] = [];

  for (const file of candidates) {
    if (!inScope(file, scope)) continue;
    const absolute = path.join(config.targetProjectPath, file);
    const currentHash = fs.existsSync(absolute) ? hashPath(absolute) : null;
    const hadPrev = Object.prototype.hasOwnProperty.call(snapshot.hashes, file);

    if (!hadPrev) {
      if (currentFiles.has(file) || currentHash !== null) changed.push(file);
      continue;
    }

    if (snapshot.hashes[file] !== currentHash) changed.push(file);
  }

  changed.sort();
  const lint = await lintChangedFiles(config, changed);
  return {
    hasChanges: changed.length > 0,
    changedFiles: changed,
    insertions: lint.insertions,
    deletions: lint.deletions,
    violations: lint.violations,
  };
}

/**
 * 워킹 트리 변경사항을 수집하고 컨벤션 위반을 정적 검사한다.
 * Git index 를 수정하지 않는다 — tracked 는 `git diff HEAD`, untracked 는 파일 직접 읽기.
 */
export async function collectDiff(config: OrchestratorConfig): Promise<GitDiffResult> {
  const changedFiles = await listWorkingTreeFiles(config);
  if (changedFiles.length === 0) return emptyDiff();

  const lint = await lintChangedFiles(config, changedFiles);
  return {
    hasChanges: true,
    changedFiles,
    insertions: lint.insertions,
    deletions: lint.deletions,
    violations: lint.violations,
  };
}

export async function commitAll(
  config: OrchestratorConfig,
  message: string,
  files: string[],
): Promise<string | null> {
  if (!(await isGitRepo(config))) return null;

  if (files.length === 0) {
    log.warn('커밋할 파일 목록이 비어 있습니다.');
    return null;
  }

  const args = ['commit', '-m', message];
  const env = { ...process.env };
  if (config.gitAuthorName) env.GIT_AUTHOR_NAME = config.gitAuthorName;
  if (config.gitAuthorEmail) env.GIT_AUTHOR_EMAIL = config.gitAuthorEmail;
  if (config.gitAuthorName) env.GIT_COMMITTER_NAME = config.gitAuthorName;
  if (config.gitAuthorEmail) env.GIT_COMMITTER_EMAIL = config.gitAuthorEmail;

  await git(config, ['restore', '--staged', '--', '.']).catch(() => undefined);

  for (let i = 0; i < files.length; i += GIT_PATHSPEC_CHUNK) {
    await git(config, ['add', '--', ...files.slice(i, i + GIT_PATHSPEC_CHUNK)]);
  }
  try {
    await git(config, args, env);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string };
    const combined = `${execError.stdout ?? ''}\n${execError.stderr ?? ''}`;
    if (combined.includes('nothing to commit')) {
      log.warn('커밋할 변경사항이 없습니다.');
      return null;
    }
    throw error;
  }

  const hash = (await git(config, ['rev-parse', '--short', 'HEAD'])).trim();
  log.info(`커밋 완료: ${hash} - ${message.split('\n')[0]}`);
  return hash;
}

/** force push 없이 현재 브랜치를 origin 에 올린다 (`-u origin HEAD`). */
export async function pushCurrentBranch(config: OrchestratorConfig): Promise<string> {
  const branch = await currentGitBranch(config);
  if (!branch || branch === 'HEAD') {
    throw new Error('현재 브랜치를 확인할 수 없어 푸시하지 않았습니다.');
  }

  await git(config, ['push', '-u', 'origin', 'HEAD']);
  const summary = `${branch} → origin`;
  log.info(`푸시 완료: ${summary}`);
  return summary;
}

const UNITY_IGNORE_PATTERNS = [
  '[Ll]ibrary/',
  '[Tt]emp/',
  '[Oo]bj/',
  '[Bb]uild/',
  '[Bb]uilds/',
  '[Ll]ogs/',
  '[Uu]ser[Ss]ettings/',
  'runtime/',
  '*.csproj',
  '*.sln',
];

function normalizeIgnoreKey(line: string): string {
  const folded = line.trim().replace(/\[([A-Za-z])([A-Za-z])\]/g, (_all, a: string, b: string) => {
    return a.toLowerCase() === b.toLowerCase() ? a.toLowerCase() : `${a}${b}`;
  });
  return folded.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase().replace(/\/+$/, '');
}

/** 기존 .gitignore 에 없는 Unity 규칙만 골라낸다. Library/ 와 [Ll]ibrary/ 는 같은 것으로 본다. */
export function missingGitignorePatterns(existing: string): string[] {
  const keys = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .map(normalizeIgnoreKey),
  );
  return UNITY_IGNORE_PATTERNS.filter((pattern) => !keys.has(normalizeIgnoreKey(pattern)));
}

/** 대상 프로젝트 .gitignore 를 만들거나, 빠진 Unity 규칙만 덧붙인다. */
export function ensureUnityGitignore(config: OrchestratorConfig): void {
  const gitignorePath = path.join(config.targetProjectPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${UNITY_IGNORE_PATTERNS.join('\n')}\n`, 'utf8');
    log.info('.gitignore 를 생성했습니다 (Unity 기본 규칙).');
    return;
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const missing = missingGitignorePatterns(existing);
  if (missing.length === 0) return;

  const prefix = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${prefix}\n# cursor-auto-work\n${missing.join('\n')}\n`, 'utf8');
  log.info(`.gitignore 에 Unity 규칙 ${missing.length}개를 추가했습니다: ${missing.join(', ')}`);
}

/** 시작 당시 dirty 가 아닌 파일만 자동 커밋 대상으로 고른다. */
export function selectCommitFiles(
  snapshot: WorkingTreeSnapshot,
  changedFiles: string[],
): { files: string[]; skippedDirty: string[] } {
  const files: string[] = [];
  const skippedDirty: string[] = [];
  for (const file of changedFiles) {
    const rel = normalizeRepoPath(file);
    if (Object.prototype.hasOwnProperty.call(snapshot.hashes, rel)) skippedDirty.push(rel);
    else files.push(rel);
  }
  return { files, skippedDirty };
}

/** 이번 Step 이 만든 변경만 되돌린다. 시작 당시 dirty 파일은 건드리지 않는다. */
export async function restoreFilesSinceSnapshot(
  config: OrchestratorConfig,
  snapshot: WorkingTreeSnapshot,
  files: string[],
): Promise<string[]> {
  if (!(await isGitRepo(config))) return [];
  const untracked = await listUntrackedFiles(config);
  const restored: string[] = [];

  for (const file of files) {
    const rel = normalizeRepoPath(file);
    if (Object.prototype.hasOwnProperty.call(snapshot.hashes, rel)) continue;

    const absolute = path.join(config.targetProjectPath, rel);
    if (untracked.has(rel)) {
      try {
        if (fs.existsSync(absolute)) fs.rmSync(absolute, { force: true });
        restored.push(rel);
      } catch (error) {
        log.warn(`롤백 삭제 실패 ${rel}: ${(error as Error).message}`);
      }
      continue;
    }

    try {
      await git(config, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel]).catch(() =>
        git(config, ['checkout', 'HEAD', '--', rel]),
      );
      restored.push(rel);
    } catch (error) {
      log.warn(`롤백 복원 실패 ${rel}: ${(error as Error).message}`);
    }
  }

  return restored;
}

export async function currentGitBranch(config: OrchestratorConfig): Promise<string | null> {
  if (!(await isGitRepo(config))) return null;
  try {
    const name = (await git(config, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** 이미 auto-work/* 에 있으면 유지하고, 아니면 새 작업 브랜치를 만든다. */
export async function ensureWorkBranch(config: OrchestratorConfig): Promise<string | null> {
  if (!config.createWorkBranch || !(await isGitRepo(config))) return null;
  const current = await currentGitBranch(config);
  if (current && current.startsWith('auto-work/')) {
    log.info(`작업 브랜치 유지: ${current}`);
    return current;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `auto-work/${stamp}`;
  await git(config, ['checkout', '-b', name]);
  log.info(`작업 브랜치 생성: ${name} (이전: ${current ?? 'unknown'})`);
  return name;
}
