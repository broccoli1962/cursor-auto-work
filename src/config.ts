import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import { createLogger } from './logger';
import type {
  CommitLanguage,
  LogLevel,
  OrchestratorConfig,
  PromptDelivery,
  UnityInstallMode,
  UnityValidationBackend,
  ValidationMode,
} from './types';

dotenv.config();

const log = createLogger('config');

/** 오케스트레이터가 읽는 환경 변수. 여기 없으면 설정으로 쓰이지 않는다. */
export const KNOWN_ENV_KEYS = [
  'TARGET_PROJECT_PATH',
  'UNITY_PATH',
  'UNITY_CLI_BIN',
  'UNITY_CLI_INSTALL',
  'UNITY_PIPELINE_INSTALL',
  'UNITY_VALIDATION_BACKEND',
  'UNITY_LAUNCH_EDITOR',
  'UNITY_LAUNCH_TIMEOUT_MS',
  'UNITY_STOP_PLAY_MODE',
  'UNITY_RESTORE_PLAY_MODE',
  'CURSOR_AGENT_BIN',
  'CURSOR_MODEL',
  'CURSOR_YOLO',
  'CURSOR_PROMPT_DELIVERY',
  'DISCORD_WEBHOOK_URL',
  'SPEC_PATH',
  'ROADMAP_PATH',
  'STATE_PATH',
  'RUNTIME_DIR',
  'MAX_RETRIES',
  'AGENT_TIMEOUT_MS',
  'UNITY_TIMEOUT_MS',
  'VALIDATION_MODE',
  'INFER_VERIFY',
  'STEP_JUDGE',
  'JUDGE_TIMEOUT_MS',
  'AUTONOMY',
  'AUTONOMY_BUDGET_MS',
  'AUTONOMY_MAX_CYCLES',
  'AUTONOMY_STEPS_PER_CYCLE',
  'AUTONOMY_PLAYTEST',
  'AUTONOMY_PLAYTEST_SETTLE_MS',
  'AUTONOMY_PLAYTEST_RETRIES',
  'AUTONOMY_REVIEW_TIMEOUT_MS',
  'GOAL',
  'GOAL_PATH',
  'AUTONOMY_RESUME_SESSION',
  'AUTONOMY_SESSION_STEPS',
  'RESUME_ON_RETRY',
  'ROLLBACK_ON_FAIL',
  'CREATE_WORK_BRANCH',
  'RULES_MAX_CHARS',
  'SPEC_MAX_CHARS',
  'AUTO_COMMIT',
  'AUTO_PUSH',
  'COMMIT_LANGUAGE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'MAX_ERROR_LINES',
  'LOG_LEVEL',
] as const;

/** CLI 가 직접 읽는 키. 오케스트레이터 설정은 아니지만 지우면 안 된다. */
const PASSTHROUGH_ENV_KEYS = ['CURSOR_API_KEY'] as const;

/** 제거된 키와, 대신 쓸 곳. */
export const REMOVED_ENV_KEYS: Record<string, string> = {
  SKIP_VALIDATION: 'VALIDATION_MODE=skip',
  RUN_UNITY_COMPILE: 'VALIDATION_MODE',
  RUN_UNITY_TESTS: 'VALIDATION_MODE=full 과 roadmap 의 runTests',
  CURSOR_SUBAGENT_MODEL: 'CURSOR_MODEL',
  AUTONOMY_PLAYTEST_INPUT: '로드맵 Step 의 playtest.input',
};

const KNOWN_ENV_KEY_SET = new Set<string>([...KNOWN_ENV_KEYS, ...PASSTHROUGH_ENV_KEYS]);

function looksLikeOrchestratorEnv(key: string): boolean {
  return /^(TARGET_PROJECT_PATH|UNITY_|CURSOR_|DISCORD_WEBHOOK_URL|SPEC_PATH|ROADMAP_PATH|STATE_PATH|RUNTIME_DIR|MAX_RETRIES|MAX_ERROR_LINES|AGENT_TIMEOUT_MS|VALIDATION_MODE|INFER_VERIFY|STEP_JUDGE|JUDGE_|AUTONOMY|GOAL|RESUME_ON_RETRY|ROLLBACK_ON_FAIL|CREATE_WORK_BRANCH|RULES_MAX_CHARS|SPEC_MAX_CHARS|AUTO_COMMIT|AUTO_PUSH|COMMIT_LANGUAGE|GIT_AUTHOR_|LOG_LEVEL)/.test(
    key,
  );
}

/** .env 에 남은 죽은 키와, 접두사만 비슷하고 읽히지 않는 키를 가른다. */
export function classifyOrchestratorEnv(keys: string[]): { removed: string[]; unknown: string[] } {
  const removed: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    if (REMOVED_ENV_KEYS[key]) {
      removed.push(key);
      continue;
    }
    if (!looksLikeOrchestratorEnv(key) || KNOWN_ENV_KEY_SET.has(key)) continue;
    unknown.push(key);
  }
  return { removed, unknown };
}

function str(key: string, fallback = ''): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function num(key: string, fallback: number): number {
  const raw = str(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = str(key).toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** projectRoot 기준 상대경로를 절대경로로 정규화한다. */
function resolveIn(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

function warnDeprecatedEnvVars(): void {
  const present = Object.keys(process.env).filter((key) => str(key));
  const { removed, unknown } = classifyOrchestratorEnv(present);
  for (const key of removed) {
    log.warn(`${key} 은(는) 더 이상 읽지 않습니다. 대신 ${REMOVED_ENV_KEYS[key]} 를 사용하고 .env 에서 이 줄을 지우세요.`);
  }
  for (const key of unknown) {
    log.warn(`${key} 은(는) 오케스트레이터 설정이 아닙니다. .env 에서 지워도 동작이 바뀌지 않습니다.`);
  }
}

function parseCommitLanguage(raw: string): CommitLanguage {
  const normalized = raw.toLowerCase();
  if (normalized === 'en' || normalized === 'english') return 'en';
  if (normalized === 'ko' || normalized === 'kr' || normalized === 'korean' || normalized === '') {
    return 'ko';
  }
  log.warn(`알 수 없는 COMMIT_LANGUAGE='${raw}' — ko 로 대체합니다.`);
  return 'ko';
}

function parseValidationMode(raw: string): ValidationMode {
  const normalized = raw.toLowerCase();
  if (normalized === 'lint' || normalized === 'compile' || normalized === 'full' || normalized === 'skip') {
    return normalized;
  }
  log.warn(`알 수 없는 VALIDATION_MODE='${raw}' — compile 로 대체합니다.`);
  return 'compile';
}

function parseInstallMode(raw: string): UnityInstallMode {
  const normalized = raw.toLowerCase();
  if (normalized === 'yes' || normalized === 'true' || normalized === 'always') return 'yes';
  if (normalized === 'no' || normalized === 'false' || normalized === 'never') return 'no';
  return 'ask';
}

function parseUnityBackend(raw: string): UnityValidationBackend {
  if (raw === 'batch') return 'batch';
  if (raw === 'mcp') {
    log.warn('UNITY_VALIDATION_BACKEND=mcp 는 Coplay UnityMCP 채널입니다. 공식 Unity CLI(cli)로 검수합니다.');
    return 'cli';
  }
  if (raw && raw !== 'cli') {
    log.warn(`알 수 없는 UNITY_VALIDATION_BACKEND='${raw}' — cli 로 대체합니다.`);
  }
  return 'cli';
}

export class ConfigError extends Error {}

export function needsUnity(config: OrchestratorConfig): boolean {
  return config.validationMode === 'compile' || config.validationMode === 'full';
}

export function needsGitValidation(config: OrchestratorConfig): boolean {
  return config.validationMode !== 'skip';
}

function judgeSuffix(config: OrchestratorConfig): string {
  return config.stepJudge ? ' → 완료 조건 판정' : '';
}

export function describeValidationMode(config: OrchestratorConfig): string {
  switch (config.validationMode) {
    case 'skip':
      return '건너뜀 (커밋 본문에만 기록)';
    case 'lint':
      return '추론/명시 Verify + delta 린트' + judgeSuffix(config);
    case 'compile':
      return config.unityValidationBackend === 'batch'
        ? 'Verify + 린트 → 배치모드 컴파일' + judgeSuffix(config)
        : 'Verify + 린트 → Unity CLI 컴파일' + judgeSuffix(config);
    case 'full':
      return config.unityValidationBackend === 'batch'
        ? 'Verify + 린트 → 배치모드 컴파일 → 테스트' + judgeSuffix(config)
        : 'Verify + 린트 → Unity CLI 컴파일 → 테스트' + judgeSuffix(config);
    default:
      return config.validationMode;
  }
}

export function isGitRepoSync(projectRoot: string): boolean {
  try {
    const out = execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export function loadConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  warnDeprecatedEnvVars();

  const targetProjectPath = path.resolve(
    overrides.targetProjectPath ?? str('TARGET_PROJECT_PATH', process.cwd()),
  );

  const runtimeDir = resolveIn(targetProjectPath, str('RUNTIME_DIR', './runtime'));

  const logLevelRaw = str('LOG_LEVEL', 'info') as LogLevel;
  const logLevel: LogLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw)
    ? logLevelRaw
    : 'info';

  const deliveryRaw = str('CURSOR_PROMPT_DELIVERY', 'auto').toLowerCase() as PromptDelivery;
  const promptDelivery: PromptDelivery = ['auto', 'argv', 'stdin', 'file'].includes(deliveryRaw)
    ? deliveryRaw
    : 'auto';

  const validationMode =
    overrides.validationMode ?? parseValidationMode(str('VALIDATION_MODE', 'compile'));

  const backendRaw = str('UNITY_VALIDATION_BACKEND', 'cli').toLowerCase();
  const unityValidationBackend: UnityValidationBackend =
    overrides.unityValidationBackend ?? parseUnityBackend(backendRaw);

  const config: OrchestratorConfig = {
    targetProjectPath,
    unityPath: overrides.unityPath ?? str('UNITY_PATH'),
    unityCliBin: overrides.unityCliBin ?? str('UNITY_CLI_BIN', 'unity'),
    unityCliInstall: overrides.unityCliInstall ?? parseInstallMode(str('UNITY_CLI_INSTALL', 'ask')),
    unityPipelineInstall:
      overrides.unityPipelineInstall ?? parseInstallMode(str('UNITY_PIPELINE_INSTALL', 'ask')),
    cursorAgentBin: overrides.cursorAgentBin ?? str('CURSOR_AGENT_BIN', 'agent'),
    cursorModel: overrides.cursorModel ?? str('CURSOR_MODEL'),
    cursorYolo: overrides.cursorYolo ?? bool('CURSOR_YOLO', true),
    promptDelivery: overrides.promptDelivery ?? promptDelivery,
    validationMode,
    unityValidationBackend,
    unityLaunchEditor: overrides.unityLaunchEditor ?? bool('UNITY_LAUNCH_EDITOR', true),
    unityLaunchTimeoutMs: overrides.unityLaunchTimeoutMs ?? num('UNITY_LAUNCH_TIMEOUT_MS', 3 * 60 * 1000),
    unityStopPlayMode: overrides.unityStopPlayMode ?? bool('UNITY_STOP_PLAY_MODE', true),
    unityRestorePlayMode: overrides.unityRestorePlayMode ?? bool('UNITY_RESTORE_PLAY_MODE', true),

    discordWebhookUrl: overrides.discordWebhookUrl ?? str('DISCORD_WEBHOOK_URL'),

    specPath: resolveIn(targetProjectPath, overrides.specPath ?? str('SPEC_PATH', './docs/spec.md')),
    roadmapPath: resolveIn(
      targetProjectPath,
      overrides.roadmapPath ?? str('ROADMAP_PATH', './docs/roadmap.json'),
    ),
    statePath: resolveIn(
      targetProjectPath,
      overrides.statePath ?? str('STATE_PATH', './runtime/state.json'),
    ),
    runtimeDir,
    logsDir: path.join(targetProjectPath, 'Logs'),

    maxRetries: overrides.maxRetries ?? num('MAX_RETRIES', 3),
    agentTimeoutMs: overrides.agentTimeoutMs ?? num('AGENT_TIMEOUT_MS', 30 * 60 * 1000),
    unityTimeoutMs: overrides.unityTimeoutMs ?? num('UNITY_TIMEOUT_MS', 20 * 60 * 1000),
    inferVerify: overrides.inferVerify ?? bool('INFER_VERIFY', true),
    stepJudge: overrides.stepJudge ?? bool('STEP_JUDGE', true),
    judgeTimeoutMs: overrides.judgeTimeoutMs ?? num('JUDGE_TIMEOUT_MS', 3 * 60 * 1000),
    autonomyEnabled: overrides.autonomyEnabled ?? bool('AUTONOMY', true),
    goal: overrides.goal ?? str('GOAL'),
    goalPath: resolveIn(targetProjectPath, overrides.goalPath ?? str('GOAL_PATH', './docs/goal.md')),
    autonomyMaxCycles: Math.max(1, Math.floor(overrides.autonomyMaxCycles ?? num('AUTONOMY_MAX_CYCLES', 48))),
    autonomyBudgetMs: Math.max(60_000, overrides.autonomyBudgetMs ?? num('AUTONOMY_BUDGET_MS', 4 * 60 * 60 * 1000)),
    autonomyStepsPerCycle: Math.max(
      1,
      Math.floor(overrides.autonomyStepsPerCycle ?? num('AUTONOMY_STEPS_PER_CYCLE', 1)),
    ),
    playtest: overrides.playtest ?? bool('AUTONOMY_PLAYTEST', true),
    playtestSettleMs: Math.max(0, overrides.playtestSettleMs ?? num('AUTONOMY_PLAYTEST_SETTLE_MS', 2_000)),
    playtestRetries: Math.max(1, Math.floor(overrides.playtestRetries ?? num('AUTONOMY_PLAYTEST_RETRIES', 3))),
    autonomyReviewTimeoutMs: Math.max(
      1000,
      overrides.autonomyReviewTimeoutMs ?? num('AUTONOMY_REVIEW_TIMEOUT_MS', 10 * 60 * 1000),
    ),
    resumeOnRetry: overrides.resumeOnRetry ?? bool('RESUME_ON_RETRY', true),
    autonomyResumeSession: overrides.autonomyResumeSession ?? bool('AUTONOMY_RESUME_SESSION', true),
    autonomySessionSteps: Math.max(
      1,
      Math.floor(overrides.autonomySessionSteps ?? num('AUTONOMY_SESSION_STEPS', 4)),
    ),
    rollbackOnFail: overrides.rollbackOnFail ?? bool('ROLLBACK_ON_FAIL', true),
    createWorkBranch: overrides.createWorkBranch ?? bool('CREATE_WORK_BRANCH', true),
    rulesMaxChars: overrides.rulesMaxChars ?? num('RULES_MAX_CHARS', 40_000),
    specMaxChars: overrides.specMaxChars ?? num('SPEC_MAX_CHARS', 20_000),
    autoCommit: overrides.autoCommit ?? bool('AUTO_COMMIT', false),
    autoPush: overrides.autoPush ?? bool('AUTO_PUSH', false),
    commitLanguage: overrides.commitLanguage ?? parseCommitLanguage(str('COMMIT_LANGUAGE', 'ko')),
    gitAuthorName: overrides.gitAuthorName ?? str('GIT_AUTHOR_NAME'),
    gitAuthorEmail: overrides.gitAuthorEmail ?? str('GIT_AUTHOR_EMAIL'),
    maxErrorLines: overrides.maxErrorLines ?? num('MAX_ERROR_LINES', 30),
    logLevel: overrides.logLevel ?? logLevel,
  };

  return config;
}

export interface ValidationIssue {
  fatal: boolean;
  message: string;
}

/**
 * 실행 전 환경을 점검한다.
 * fatal 이슈가 하나라도 있으면 오케스트레이터는 기동하지 않는다.
 */
export function validateConfig(config: OrchestratorConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!fs.existsSync(config.targetProjectPath)) {
    issues.push({
      fatal: true,
      message: `TARGET_PROJECT_PATH 가 존재하지 않습니다: ${config.targetProjectPath}`,
    });
  } else if (!fs.existsSync(path.join(config.targetProjectPath, 'Assets'))) {
    issues.push({
      fatal: false,
      message: `Assets/ 폴더가 없습니다. Unity 프로젝트 루트가 맞는지 확인하세요: ${config.targetProjectPath}`,
    });
  }

  if (config.validationMode === 'skip') {
    issues.push({
      fatal: false,
      message:
        'VALIDATION_MODE=skip - 린트/컴파일/테스트 검수를 모두 건너뜁니다. 커밋 본문에만 검수 생략 사실이 기록됩니다.',
    });
  }

  if (needsGitValidation(config) && !isGitRepoSync(config.targetProjectPath)) {
    issues.push({
      fatal: true,
      message:
        'Git 저장소가 아닙니다. lint/compile/full 검수에는 Git Diff 가 필요합니다. git init 후 실행하거나 VALIDATION_MODE=skip 을 사용하세요.',
    });
  }

  const needsUnityPath =
    needsUnity(config) && config.unityValidationBackend === 'batch';
  if (!config.unityPath) {
    if (needsUnityPath) {
      issues.push({
        fatal: true,
        message: `UNITY_VALIDATION_BACKEND=batch 에는 UNITY_PATH 가 필요합니다.`,
      });
    }
  } else if (!fs.existsSync(config.unityPath)) {
    issues.push({
      fatal: needsUnityPath,
      message: `UNITY_PATH 실행 파일을 찾을 수 없습니다: ${config.unityPath}`,
    });
  }

  if (!fs.existsSync(config.roadmapPath)) {
    issues.push({ fatal: true, message: `roadmap.json 을 찾을 수 없습니다: ${config.roadmapPath}` });
  }

  if (!fs.existsSync(config.specPath)) {
    issues.push({ fatal: false, message: `spec.md 를 찾을 수 없습니다: ${config.specPath}` });
  }

  if (!config.discordWebhookUrl) {
    issues.push({ fatal: false, message: 'DISCORD_WEBHOOK_URL 미설정 - 알림은 콘솔에만 출력됩니다.' });
  }

  if (config.maxRetries < 1) {
    issues.push({ fatal: true, message: 'MAX_RETRIES 는 1 이상이어야 합니다.' });
  }

  return issues;
}

export function ensureRuntimeDirs(config: OrchestratorConfig): void {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
}
