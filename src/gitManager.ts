import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from './logger';
import type { GitDiffResult, OrchestratorConfig } from './types';

const execFileAsync = promisify(execFile);
const log = createLogger('git');

/** 커밋 전에 걸러내야 할 컨벤션 위반 패턴 */
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

/**
 * 워킹 트리의 변경사항을 수집하고 컨벤션 위반을 정적 검사한다.
 * untracked 파일도 포함하기 위해 intent-to-add 를 먼저 적용한다.
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

  try {
    await git(config, ['add', '--intent-to-add', '--all']);
  } catch (error) {
    log.debug(`intent-to-add 실패(무시): ${(error as Error).message}`);
  }

  const nameOnly = await git(config, ['diff', 'HEAD', '--name-only']).catch(() =>
    git(config, ['diff', '--name-only']),
  );
  const changedFiles = nameOnly
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (changedFiles.length === 0) return empty;

  const diffText = await git(config, ['diff', 'HEAD', '--unified=0']).catch(() =>
    git(config, ['diff', '--unified=0']),
  );

  let insertions = 0;
  let deletions = 0;
  const violations: string[] = [];
  let currentFile = '';

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) insertions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;

    // .meta / 생성 산출물은 컨벤션 검사 대상에서 제외
    if (currentFile.endsWith('.meta') || currentFile.includes('/Logs/')) continue;

    for (const rule of CONVENTION_RULES) {
      if (rule.pattern.test(line)) {
        const entry = `${currentFile}: ${rule.message}`;
        if (!violations.includes(entry)) violations.push(entry);
      }
    }
  }

  return { hasChanges: true, changedFiles, insertions, deletions, violations };
}

export async function commitAll(
  config: OrchestratorConfig,
  message: string,
): Promise<string | null> {
  if (!(await isGitRepo(config))) return null;

  const args = ['commit', '-m', message];
  const env = { ...process.env };
  if (config.gitAuthorName) env.GIT_AUTHOR_NAME = config.gitAuthorName;
  if (config.gitAuthorEmail) env.GIT_AUTHOR_EMAIL = config.gitAuthorEmail;
  if (config.gitAuthorName) env.GIT_COMMITTER_NAME = config.gitAuthorName;
  if (config.gitAuthorEmail) env.GIT_COMMITTER_EMAIL = config.gitAuthorEmail;

  await git(config, ['add', '--all']);
  try {
    await execFileAsync('git', args, {
      cwd: config.targetProjectPath,
      env,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = (error as { stdout?: string; stderr?: string }).stdout ?? '';
    if (stderr.includes('nothing to commit')) {
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
