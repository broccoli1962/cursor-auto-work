import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import { createLogger } from './logger';
import type { LogLevel, OrchestratorConfig, PromptDelivery, ValidationMode } from './types';

dotenv.config();

const log = createLogger('config');

const DEPRECATED_ENV_KEYS = [
  'SKIP_VALIDATION',
  'RUN_UNITY_COMPILE',
  'RUN_UNITY_TESTS',
  'CURSOR_SUBAGENT_MODEL',
] as const;

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
  for (const key of DEPRECATED_ENV_KEYS) {
    if (str(key)) {
      log.warn(`${key} 은(는) 제거되었습니다. VALIDATION_MODE (lint|compile|full|skip) 를 사용하세요.`);
    }
  }
}

function parseValidationMode(raw: string): ValidationMode {
  const normalized = raw.toLowerCase();
  if (normalized === 'lint' || normalized === 'compile' || normalized === 'full' || normalized === 'skip') {
    return normalized;
  }
  log.warn(`알 수 없는 VALIDATION_MODE='${raw}' — lint 로 대체합니다.`);
  return 'lint';
}

export class ConfigError extends Error {}

export function needsUnity(config: OrchestratorConfig): boolean {
  return config.validationMode === 'compile' || config.validationMode === 'full';
}

export function needsGitValidation(config: OrchestratorConfig): boolean {
  return config.validationMode !== 'skip';
}

export function describeValidationMode(config: OrchestratorConfig): string {
  switch (config.validationMode) {
    case 'skip':
      return '건너뜀 (커밋 본문에만 기록)';
    case 'lint':
      return 'Git Diff 린트';
    case 'compile':
      return 'Git Diff 린트 → Unity 컴파일';
    case 'full':
      return 'Git Diff 린트 → Unity 컴파일 → EditMode 테스트 (step.runTests=true)';
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
    overrides.validationMode ?? parseValidationMode(str('VALIDATION_MODE', 'lint'));

  const config: OrchestratorConfig = {
    targetProjectPath,
    unityPath: overrides.unityPath ?? str('UNITY_PATH'),
    cursorAgentBin: overrides.cursorAgentBin ?? str('CURSOR_AGENT_BIN', 'agent'),
    cursorModel: overrides.cursorModel ?? str('CURSOR_MODEL'),
    cursorYolo: overrides.cursorYolo ?? bool('CURSOR_YOLO', false),
    promptDelivery: overrides.promptDelivery ?? promptDelivery,
    validationMode,

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
    autoCommit: overrides.autoCommit ?? bool('AUTO_COMMIT', false),
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

  const needsUnityPath = needsUnity(config) && config.validationMode !== 'skip';
  if (!config.unityPath) {
    if (needsUnityPath) {
      issues.push({
        fatal: true,
        message: `VALIDATION_MODE=${config.validationMode} 에는 UNITY_PATH 가 필요합니다.`,
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
