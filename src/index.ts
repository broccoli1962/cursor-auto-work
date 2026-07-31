#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { describeValidationMode, ensureRuntimeDirs, loadConfig, validateConfig } from './config';
import type { ValidationIssue } from './config';
import { collectCursorRules, probeCursorAgent } from './cursorRunner';
import { enableUtf8Console } from './encoding';
import { closeLogger, configureLogger, createLogger } from './logger';
import { formatProbeResult, loadMcpServers, probeMcpServers } from './mcpProbe';
import type { McpProbeResult } from './mcpProbe';
import { buildStepPrompt, loadState } from './memoryManager';
import { Orchestrator, selectPreviewSteps } from './orchestrator';
import { loadRoadmap } from './roadmap';
import type { OrchestratorConfig, ValidationMode } from './types';

const log = createLogger('cli');

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'run', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, flags };
}

function numberFlag(flags: ParsedArgs['flags'], key: string): number | undefined {
  const value = flags[key];
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseValidationFlag(flags: ParsedArgs['flags']): ValidationMode | undefined {
  const value = flags.validation;
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'lint' || normalized === 'compile' || normalized === 'full' || normalized === 'skip') {
    return normalized;
  }
  log.warn(`알 수 없는 --validation '${value}' — 무시합니다.`);
  return undefined;
}

function printHelp(): void {
  process.stdout.write(
    `
Unity & Cursor Headless CLI 오케스트레이터

사용법:
  cursor-auto-work <command> [options]

Commands:
  run              roadmap.json 기준으로 파이프라인을 실행합니다 (기본값)
  preview-prompt   Agent 를 실행하지 않고 Step 프롬프트만 출력합니다 (state 변경 없음)
  init             대상 프로젝트에 docs/spec.md, docs/roadmap.json 템플릿을 생성합니다
  status           state.json 기반 진행 상황을 출력합니다
  doctor           설정/환경을 점검하고 MCP 서버에 실제로 접속해 응답을 확인합니다
  help             이 도움말을 출력합니다

Options:
  --project <path>       TARGET_PROJECT_PATH 를 덮어씁니다
  --from <n>             Step n 부터 (preview: 완료 기록 무시)
  --to <n>               Step n 까지만
  --retries <n>          MAX_RETRIES 덮어쓰기
  --validation <mode>    lint | compile | full | skip (VALIDATION_MODE 덮어쓰기)
  --no-commit            자동 커밋 비활성화
  --debug                로그 레벨을 debug 로 설정
  --no-mcp-probe         MCP 서버 실제 접속 점검을 생략 (doctor, run)
  --mcp-timeout <ms>     MCP 응답 대기 시간 (기본 20000)

검수 모드 (VALIDATION_MODE):
  lint     Git Diff + 컨벤션 린트 (기본값)
  compile  lint + Unity Batchmode 컴파일
  full     lint + 컴파일 + EditMode 테스트 (roadmap step.runTests=true 일 때)
  skip     검수 생략 (diff 수집만)

예시:
  cursor-auto-work run --project D:\\UnityProjects\\MyGame
  cursor-auto-work run --validation full
  cursor-auto-work preview-prompt --to 1
  cursor-auto-work doctor
`.trimStart(),
  );
}

function buildConfig(flags: ParsedArgs['flags']): OrchestratorConfig {
  const overrides: Partial<OrchestratorConfig> = {};

  if (typeof flags.project === 'string') overrides.targetProjectPath = flags.project;
  const retries = numberFlag(flags, 'retries');
  if (retries !== undefined) overrides.maxRetries = retries;
  const validationMode = parseValidationFlag(flags);
  if (validationMode !== undefined) overrides.validationMode = validationMode;
  if (flags['no-commit'] === true) overrides.autoCommit = false;
  if (flags.debug === true) overrides.logLevel = 'debug';

  return loadConfig(overrides);
}

const SPEC_TEMPLATE = `# 프로젝트 기획서

## 1. 개요
- 프로젝트명:
- 장르 / 플랫폼:
- 한 줄 설명:

## 2. 핵심 게임플레이
-

## 3. 기술 스택 및 아키텍처
- Unity 버전:
- 아키텍처 패턴: MVP
- 비동기: UniTask
- 리소스 로딩: Addressables

## 4. 폴더 구조 규약
\`\`\`
Assets/
  Scripts/
    Core/
    Gameplay/
    UI/
  Prefabs/
  Addressables/
\`\`\`

## 5. 완료 기준
-
`;

const ROADMAP_TEMPLATE = {
  project: 'My Unity Game',
  description: 'docs/spec.md 기반 단계별 자동화 로드맵',
  steps: [
    {
      id: 1,
      title: '프로젝트 기반 구조 설정',
      task: 'Assets/Scripts 하위에 Core, Gameplay, UI 폴더와 각 폴더의 asmdef 를 생성하고, 프로젝트 전역에서 사용할 상수/열거형을 정의하는 Core/Constants.cs 를 작성한다.',
      acceptanceCriteria: [
        'Assets/Scripts/Core, Gameplay, UI 폴더가 존재한다',
        '각 폴더에 asmdef 가 있고 순환 참조가 없다',
        '컴파일 에러가 없다',
      ],
      targetFiles: ['Assets/Scripts/Core', 'Assets/Scripts/Gameplay', 'Assets/Scripts/UI'],
    },
    {
      id: 2,
      title: '게임 상태 관리 시스템 구현',
      task: 'MVP 패턴에 따라 GameStateMachine 과 IGameState 인터페이스를 구현하고, Boot/Menu/Play/Result 상태를 등록한다. 상태 전환은 UniTask 기반 비동기로 처리한다.',
      acceptanceCriteria: [
        'IGameState 를 구현한 4개 상태 클래스가 존재한다',
        'GameStateMachine 이 UniTask 로 전환을 처리한다',
        '컴파일 에러가 없다',
      ],
      runTests: false,
    },
  ],
};

function commandInit(config: OrchestratorConfig): void {
  const docsDir = path.dirname(config.specPath);
  fs.mkdirSync(docsDir, { recursive: true });

  if (fs.existsSync(config.specPath)) {
    log.warn(`이미 존재하여 건너뜁니다: ${config.specPath}`);
  } else {
    fs.writeFileSync(config.specPath, SPEC_TEMPLATE, 'utf8');
    log.info(`생성됨: ${config.specPath}`);
  }

  if (fs.existsSync(config.roadmapPath)) {
    log.warn(`이미 존재하여 건너뜁니다: ${config.roadmapPath}`);
  } else {
    fs.mkdirSync(path.dirname(config.roadmapPath), { recursive: true });
    fs.writeFileSync(
      config.roadmapPath,
      `${JSON.stringify(ROADMAP_TEMPLATE, null, 2)}\n`,
      'utf8',
    );
    log.info(`생성됨: ${config.roadmapPath}`);
  }

  ensureRuntimeDirs(config);
  log.info('초기화 완료. docs/spec.md 와 docs/roadmap.json 을 채운 뒤 `run` 을 실행하세요.');
}

function commandStatus(config: OrchestratorConfig): void {
  const roadmap = loadRoadmap(config.roadmapPath);
  const state = loadState(config, roadmap.project);

  const lines: string[] = [
    '',
    `프로젝트: ${roadmap.project}`,
    `상태: ${state.status}`,
    `진행: ${state.completedSteps.length}/${roadmap.steps.length} Step 완료`,
    '',
  ];

  for (const step of roadmap.steps) {
    const done = state.completedSteps.includes(step.id);
    const current = state.currentStepId === step.id && !done;
    const paused = state.status === 'paused' && state.currentStepId === step.id;
    const attempts = state.attempts[String(step.id)];
    const mark = done ? '[x]' : paused ? '[~]' : current ? '[>]' : '[ ]';
    const suffix = attempts ? ` (시도 ${attempts}회)` : '';
    lines.push(`  ${mark} Step ${step.id}: ${step.title}${suffix}`);
  }

  if (state.lastError) {
    lines.push('', `최근 실패 사유:\n${state.lastError.split('\n').slice(0, 10).join('\n')}`);
  }
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

function commandPreviewPrompt(config: OrchestratorConfig, flags: ParsedArgs['flags']): void {
  const roadmap = loadRoadmap(config.roadmapPath);
  const state = loadState(config, roadmap.project);
  const steps = selectPreviewSteps(
    roadmap,
    state,
    numberFlag(flags, 'from'),
    numberFlag(flags, 'to'),
  );

  if (steps.length === 0) {
    log.info('출력할 Step 이 없습니다.');
    return;
  }

  for (const step of steps) {
    const prompt = buildStepPrompt({
      config,
      state,
      step,
      totalSteps: roadmap.steps.length,
      attempt: 1,
    });
    process.stdout.write(`\n=== [preview] Step ${step.id}: ${step.title} (${prompt.length} chars) ===\n`);
    process.stdout.write(`${prompt}\n`);
  }
}

function mcpIssues(results: McpProbeResult[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (results.length === 0) {
    issues.push({
      fatal: false,
      message:
        'mcp.json 에 등록된 MCP 서버가 없습니다 - Agent 가 Unity Editor 를 직접 조작할 수 없습니다.',
    });
    return issues;
  }

  for (const result of results) {
    if (result.skipped) continue;
    if (!result.ok) {
      issues.push({
        fatal: false,
        message: `MCP '${result.name}' 응답 없음: ${result.error ?? '알 수 없는 실패'}`,
      });
    } else if (result.warning) {
      issues.push({ fatal: false, message: `MCP '${result.name}': ${result.warning}` });
    }
  }

  return issues;
}

async function commandDoctor(
  config: OrchestratorConfig,
  flags: ParsedArgs['flags'],
): Promise<number> {
  const issues = validateConfig(config);
  const rules = collectCursorRules(config.targetProjectPath);
  const servers = loadMcpServers(config.targetProjectPath);
  const skipProbe = flags['no-mcp-probe'] === true;

  const agentProbe = await probeCursorAgent(config);
  if (!agentProbe.ok) {
    issues.push({
      fatal: true,
      message: `agent CLI 를 실행할 수 없습니다 (CURSOR_AGENT_BIN=${config.cursorAgentBin}): ${agentProbe.error}`,
    });
  }

  const lines = [
    '',
    '=== 환경 점검 ===',
    `대상 프로젝트   : ${config.targetProjectPath}`,
    `Unity 실행 파일 : ${config.unityPath || '(미설정)'}`,
    `agent (CLI)     : ${config.cursorAgentBin}${config.cursorYolo ? ' (--force 자동 승인)' : ''}`,
    `  └ 실행 확인   : ${agentProbe.ok ? agentProbe.version : `실패 - ${agentProbe.error}`}`,
    `모델            : ${config.cursorModel || '(CLI 기본값)'}`,
    `프롬프트 전달   : ${config.promptDelivery}`,
    `검수 모드       : ${config.validationMode} (${describeValidationMode(config)})`,
    `자동 커밋       : ${config.autoCommit ? '활성' : '비활성'}`,
    `기획서          : ${config.specPath}`,
    `로드맵          : ${config.roadmapPath}`,
    `상태 파일       : ${config.statePath}`,
    `규칙 주입       : ${rules ? `${rules.length} chars` : '없음'}`,
    `MCP 등록        : ${servers.length > 0 ? servers.map((s) => `${s.name}(${s.scope})`).join(', ') : '없음'}`,
    `Discord 알림    : ${config.discordWebhookUrl ? '활성' : '비활성'}`,
    `최대 재시도     : ${config.maxRetries}`,
    '',
  ];

  if (skipProbe) {
    lines.push('=== MCP 연결 점검 ===', '  (--no-mcp-probe 로 건너뜀)', '');
  } else {
    const timeoutMs = numberFlag(flags, 'mcp-timeout') ?? 20_000;
    lines.push('=== MCP 연결 점검 (initialize + tools/list 실제 호출) ===');
    const results = await probeMcpServers(config.targetProjectPath, timeoutMs);
    if (results.length === 0) lines.push('  등록된 서버 없음');
    for (const result of results) lines.push(...formatProbeResult(result));
    lines.push('');
    issues.push(...mcpIssues(results));
  }

  if (issues.length === 0) {
    lines.push('문제 없음. `run` 을 실행할 수 있습니다.', '');
  } else {
    lines.push('=== 발견된 이슈 ===');
    for (const issue of issues) {
      lines.push(`  ${issue.fatal ? '[FATAL]' : '[WARN] '} ${issue.message}`);
    }
    lines.push('');
  }

  process.stdout.write(lines.join('\n'));
  return issues.some((issue) => issue.fatal) ? 1 : 0;
}

async function commandRun(config: OrchestratorConfig, flags: ParsedArgs['flags']): Promise<number> {
  const issues = validateConfig(config);
  for (const issue of issues) {
    if (issue.fatal) log.error(issue.message);
    else log.warn(issue.message);
  }
  if (issues.some((issue) => issue.fatal)) {
    log.error('치명적 설정 문제로 실행을 중단합니다. `doctor` 명령으로 확인하세요.');
    return 1;
  }

  if (flags['no-mcp-probe'] !== true) {
    const results = await probeMcpServers(
      config.targetProjectPath,
      numberFlag(flags, 'mcp-timeout') ?? 20_000,
    );
    for (const result of results) {
      if (result.skipped) continue;
      if (!result.ok) log.warn(`MCP '${result.name}' 응답 없음: ${result.error}`);
      else if (result.warning) log.warn(`MCP '${result.name}': ${result.warning}`);
      else log.info(`MCP '${result.name}' 정상 (도구 ${result.toolCount ?? 0}개)`);
    }
  }

  const orchestrator = new Orchestrator(config);

  const onSignal = () => orchestrator.requestStop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await orchestrator.run({
      fromStep: numberFlag(flags, 'from'),
      toStep: numberFlag(flags, 'to'),
    });
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function main(): Promise<void> {
  enableUtf8Console();
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'help' || flags.help === true) {
    printHelp();
    return;
  }

  const config = buildConfig(flags);
  ensureRuntimeDirs(config);
  configureLogger(config.logLevel, path.join(config.runtimeDir, 'orchestrator.log'));

  switch (command) {
    case 'init':
      commandInit(config);
      break;
    case 'status':
      commandStatus(config);
      break;
    case 'preview-prompt':
      commandPreviewPrompt(config, flags);
      break;
    case 'doctor':
      process.exitCode = await commandDoctor(config, flags);
      break;
    case 'run':
      process.exitCode = await commandRun(config, flags);
      break;
    default:
      log.error(`알 수 없는 명령: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    log.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  })
  .finally(() => closeLogger());
