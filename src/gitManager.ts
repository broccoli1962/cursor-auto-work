import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from './logger';
import type { GitDiffResult, OrchestratorConfig } from './types';

const execFileAsync = promisify(execFile);
const log = createLogger('git');

/** 커밋 전에 걸러내야 할 컨벤션 위반 패턴 (git diff + 라인 형식) */
const CONVENTION_RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /^\+.*\bDebug\.Log(?:Warning|Error|Format)?\s*\(/, message: 'Debug.Log 계열 호출이 추가되었습니다.' },
  { pattern: /^\+.*\bconsole\.log\s*\(/, message: 'console.log 호출이 추가되었습니다.' },
  { pattern: /^\+.*\/\/\s*(?:TODO|FIXME|HACK)\b/i, message: 'TODO/FIXME/HACK 주석이 추가되었습니다.' },
  { pattern: /^\+.*<<<<<<<\s/, message: '머지 충돌 마커가 남아 있습니다.' },
];

async function git(config: OrchestratorConfig, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: config.targetProjectPath,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
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

function scanDiffText(diffText: string, violations: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  let currentFile = '';

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      insertions += 1;
      recordViolation(currentFile, line, violations);
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
    }
  }

  return { insertions, deletions };
}

/** untracked 파일 본문을 diff + 라인 형식으로 검사한다 (index 를 건드리지 않음). */
function scanUntrackedFile(
  projectRoot: string,
  relativePath: string,
  violations: string[],
): number {
  if (skipLintFile(relativePath)) return 0;

  const absolute = path.join(projectRoot, relativePath);
  let content: string;
  try {
    const raw = fs.readFileSync(absolute);
    if (raw.includes(0)) {
      log.debug(`바이너리 untracked 파일 린트 생략: ${relativePath}`);
      return 0;
    }
    content = raw.toString('utf8');
  } catch (error) {
    log.debug(`untracked 파일 읽기 실패(무시): ${relativePath} — ${(error as Error).message}`);
    return 0;
  }

  const lines = content.split(/\r?\n/);
  for (const body of lines) {
    recordViolation(relativePath, `+${body}`, violations);
  }
  return lines.length;
}

/**
 * 워킹 트리 변경사항을 수집하고 컨벤션 위반을 정적 검사한다.
 * Git index 를 수정하지 않는다 — tracked 는 `git diff HEAD`, untracked 는 파일 직접 읽기.
 */
export async function collectDiff(config: OrchestratorConfig): Promise<GitDiffResult> {
  const empty: GitDiffResult = {
    hasChanges: false,
    changedFiles: [],
    insertions: 0,
    deletions: 0,
    violations: [],
  };

  if (!(await isGitRepo(config))) return empty;

  const nameOnly = await git(config, ['diff', 'HEAD', '--name-only']).catch(() =>
    git(config, ['diff', '--name-only']),
  );
  const trackedChanged = nameOnly
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const untrackedRaw = await git(config, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
  const untracked = untrackedRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const changedFiles = [...new Set([...trackedChanged, ...untracked])];
  if (changedFiles.length === 0) return empty;

  const violations: string[] = [];
  let insertions = 0;
  let deletions = 0;

  if (trackedChanged.length > 0) {
    const diffText = await git(config, ['diff', 'HEAD', '--unified=0']).catch(() =>
      git(config, ['diff', '--unified=0']),
    );
    const trackedCounts = scanDiffText(diffText, violations);
    insertions += trackedCounts.insertions;
    deletions += trackedCounts.deletions;
  }

  for (const file of untracked) {
    insertions += scanUntrackedFile(config.targetProjectPath, file, violations);
  }

  return { hasChanges: true, changedFiles, insertions, deletions, violations };
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

  await git(config, ['add', '--', ...files]);
  try {
    await execFileAsync('git', args, {
      cwd: config.targetProjectPath,
      env,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
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

/** 대상 프로젝트에 Unity 용 .gitignore 가 없으면 최소 규칙을 만들어 둔다. */
export function ensureUnityGitignore(config: OrchestratorConfig): void {
  const gitignorePath = path.join(config.targetProjectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) return;

  const content = [
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
    '',
  ].join('\n');

  fs.writeFileSync(gitignorePath, content, 'utf8');
  log.info('.gitignore 를 생성했습니다 (Unity 기본 규칙).');
}
