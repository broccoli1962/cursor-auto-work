import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import type { LogLevel, OrchestratorConfig } from './types';

dotenv.config();

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

export class ConfigError extends Error {}

export function loadConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const targetProjectPath = path.resolve(
    overrides.targetProjectPath ?? str('TARGET_PROJECT_PATH', process.cwd()),
  );

  const runtimeDir = resolveIn(targetProjectPath, str('RUNTIME_DIR', './runtime'));

  const logLevelRaw = str('LOG_LEVEL', 'info') as LogLevel;
  const logLevel: LogLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw)
    ? logLevelRaw
    : 'info';

  const config: OrchestratorConfig = {
    targetProjectPath,
    unityPath: overrides.unityPath ?? str('UNITY_PATH'),
    cursorAgentBin: overrides.cursorAgentBin ?? str('CURSOR_AGENT_BIN', 'cursor-agent'),
    cursorModel: overrides.cursorModel ?? str('CURSOR_MODEL'),
    cursorYolo: overrides.cursorYolo ?? bool('CURSOR_YOLO', true),

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
    runUnityTests: overrides.runUnityTests ?? bool('RUN_UNITY_TESTS', false),
    autoCommit: overrides.autoCommit ?? bool('AUTO_COMMIT', true),
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

  if (!config.unityPath) {
    issues.push({ fatal: false, message: 'UNITY_PATH 미설정 - Unity 컴파일 검수를 건너뜁니다.' });
  } else if (!fs.existsSync(config.unityPath)) {
    issues.push({
      fatal: true,
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
