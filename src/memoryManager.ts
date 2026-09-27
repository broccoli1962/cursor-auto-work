import fs from 'node:fs';
import path from 'node:path';

import { collectCursorRules } from './cursorRunner';
import { createLogger } from './logger';
import { listMcpServerNames } from './mcpProbe';
import { inferVerifyChecks, mergeVerifyChecks } from './inferVerify';
import { formatVerifyForPrompt } from './stepVerifier';
import { formatPlanAuthority } from './autonomy';
import { budgetText } from './textBudget';
import type {
  AgentRunResult,
  OrchestratorConfig,
  OrchestratorState,
  RoadmapStep,
  StepMemory,
  ValidationReport,
} from './types';

const log = createLogger('memory');

const MAX_MEMORIES_IN_CONTEXT = 5;
const MAX_SUMMARY_LINES = 4;

export function createInitialState(project: string): OrchestratorState {
  const now = new Date().toISOString();
  return {
    project,
    currentStepId: null,
    status: 'idle',
    attempts: {},
    completedSteps: [],
    memories: [],
    startedAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0, runs: 0 },
  };
}

export function loadState(config: OrchestratorConfig, project: string): OrchestratorState {
  if (!fs.existsSync(config.statePath)) return createInitialState(project);
  try {
    const parsed = JSON.parse(fs.readFileSync(config.statePath, 'utf8')) as OrchestratorState;
    return { ...createInitialState(project), ...parsed };
  } catch (error) {
    log.warn(`state.json 파싱 실패, 초기 상태로 시작합니다: ${(error as Error).message}`);
    return createInitialState(project);
  }
}

export function saveState(config: OrchestratorConfig, state: OrchestratorState): void {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.writeFileSync(config.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export interface StructuredAgentSummary {
  summary: string[];
  files: string[];
  next: string[];
}

function captureLabeledLines(text: string, label: string): string[] {
  const matched: string[] = [];
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, 'gim');
  for (const hit of text.matchAll(pattern)) {
    const value = hit[1]?.trim();
    if (value) matched.push(value);
  }
  return matched;
}

/** 프롬프트 규약 SUMMARY / FILES / NEXT 를 우선 파싱한다. */
export function parseStructuredAgentSummary(text: string): StructuredAgentSummary | null {
  const summary = captureLabeledLines(text, 'SUMMARY');
  const files = captureLabeledLines(text, 'FILES');
  const next = captureLabeledLines(text, 'NEXT');
  if (summary.length === 0 && files.length === 0 && next.length === 0) return null;
  return { summary, files, next };
}

/**
 * Agent 출력에서 노이즈를 제거하고 핵심 문장만 추출한다.
 * SUMMARY/FILES/NEXT 가 있으면 그걸 쓰고, 없으면 한/영 키워드 휴리스틱.
 */
export function summarizeAgentOutput(result: AgentRunResult, maxLines = MAX_SUMMARY_LINES): string[] {
  const structured = parseStructuredAgentSummary(result.assistantText);
  if (structured) {
    const picked = [...structured.summary, ...structured.next].filter(Boolean);
    if (picked.length > 0) return picked.slice(0, maxLines);
  }

  const lines = result.assistantText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*\-#]+/, '').trim())
    .filter((line) => line.length >= 15 && line.length <= 400)
    // 코드 블록/경로 나열/장식 문자열 제외
    .filter((line) => !line.startsWith('```') && !/^[|+\-=_]{3,}$/.test(line));

  if (lines.length === 0) return [];

  const scored = lines.map((line, index) => {
    let score = 0;
    if (/(구현|추가|생성|수정|삭제|리팩터|연결|설정|완료|added|created|implemented|fixed|completed)/i.test(line)) {
      score += 3;
    }
    if (/\.(cs|asmdef|prefab|unity|asset|json)\b/i.test(line)) score += 2;
    if (/(GameObject|Component|Addressable|UniTask|MVP|Presenter|View|Model)/i.test(line)) score += 2;
    // 결론은 대개 뒤쪽에 위치
    score += index / lines.length;
    return { line, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: string[] = [];
  for (const item of scored) {
    if (picked.includes(item.line)) continue;
    picked.push(item.line);
    if (picked.length >= maxLines) break;
  }
  return picked;
}

export function buildStepMemory(
  step: RoadmapStep,
  result: AgentRunResult,
  report: ValidationReport | null,
  attempts: number,
  commitHash?: string,
): StepMemory {
  return {
    stepId: step.id,
    title: step.title,
    status: report?.ok ? 'completed' : 'failed',
    summary: summarizeAgentOutput(result),
    changedFiles: structuredChangedFiles(result, report),
    commitHash,
    attempts,
    finishedAt: new Date().toISOString(),
  };
}

export function appendMemory(state: OrchestratorState, memory: StepMemory): void {
  state.memories = state.memories.filter((item) => item.stepId !== memory.stepId);
  state.memories.push(memory);
}

function structuredChangedFiles(result: AgentRunResult, report: ValidationReport | null): string[] {
  const fromReport = report?.delta.changedFiles ?? report?.diff.changedFiles ?? [];
  if (fromReport.length > 0) return fromReport.slice(0, 12);
  const structured = parseStructuredAgentSummary(result.assistantText);
  if (!structured) return [];
  return structured.files
    .flatMap((line) => line.split(/[,;\s]+/))
    .map((item) => item.trim())
    .filter((item) => item.includes('/') || /\.\w+$/.test(item))
    .slice(0, 12);
}

export function readSpec(config: OrchestratorConfig): string {
  if (!fs.existsSync(config.specPath)) return '';
  const content = fs.readFileSync(config.specPath, 'utf8').trim();
  return budgetText(content, config.specMaxChars, '기획서');
}

function renderMemories(state: OrchestratorState): string {
  const recent = state.memories.slice(-MAX_MEMORIES_IN_CONTEXT);
  if (recent.length === 0) return '(이전 Step 없음 - 프로젝트 초기 상태)';

  return recent
    .map((memory) => {
      const summary =
        memory.summary.length > 0
          ? memory.summary.map((line) => `    - ${line}`).join('\n')
          : '    - (요약 없음)';
      const files =
        memory.changedFiles.length > 0
          ? `    - 변경 파일: ${memory.changedFiles.join(', ')}`
          : '';
      const commit = memory.commitHash ? ` (commit ${memory.commitHash})` : '';
      return `- Step ${memory.stepId} "${memory.title}" [${memory.status}]${commit}\n${summary}\n${files}`.trimEnd();
    })
    .join('\n');
}

function buildOutputContract(config: OrchestratorConfig): string {
  const mode = config.validationMode;
  const lines = [
    '# [OUTPUT CONTRACT] 작업 규약',
    '- 질문하지 말고 끝까지 자율적으로 완료할 것. 확인이 필요하면 가장 합리적인 선택을 하고 그 이유를 남길 것.',
    '- 코드는 실제 파일에 저장할 것. 채팅에만 코드를 출력하는 것은 작업 미완료로 간주한다.',
  ];

  if (mode === 'compile' || mode === 'full') {
    lines.push(
      config.unityValidationBackend === 'batch'
        ? '- 오케스트레이터가 Unity 배치모드로 컴파일 검수를 수행한다. 같은 프로젝트를 연 에디터가 있으면 Library 잠금으로 실패할 수 있다.'
        : '- 오케스트레이터가 열린 Unity Editor 에 공식 Unity CLI 로 컴파일 검수를 수행한다. 에디터를 끄지 말고 C# 컴파일 에러가 없어야 한다.',
    );
  }
  if (mode === 'full') {
    lines.push(
      '- 이 Step 에 runTests 가 설정되어 있으면 EditMode 단위 테스트도 통과해야 한다.',
    );
  }
  if (mode === 'lint') {
    lines.push('- 검수는 Verify 체크와 Git Diff 린트(이번 Step 시작 이후 · 대상 경로)다. C# 은 컴파일 가능하게 작성할 것.');
  }

  lines.push(
    '- targetFiles/완료 조건에서 추론한 파일 존재와 로드맵 verify.checks 를 오케스트레이터가 직접 확인한다.',
    '- 그 다음 별도 판정 Agent 가 완료 조건 충족 여부를 본다. 채팅 설명만으로 완료가 되지 않는다.',
    '- git commit 은 오케스트레이터가 수행하므로 직접 커밋하지 말 것.',
    '- 작업을 마치면 마지막에 다음 형식으로 3줄 이내 요약을 남길 것:',
    '  SUMMARY: <무엇을 구현했는지>',
    '  FILES: <생성/수정한 주요 파일 경로들>',
    '  NEXT: <다음 Step 에서 이어서 할 일>',
    '  LESSON: <이번 시도에서 실패한 이유와 버린 접근. 없으면 생략>',
  );

  return lines.join('\n');
}

export interface BuildPromptArgs {
  config: OrchestratorConfig;
  state: OrchestratorState;
  step: RoadmapStep;
  totalSteps: number;
  /** 재시도인 경우 직전 검수 실패 피드백 */
  feedback?: string;
  attempt: number;
}

/**
 * Fresh Context 용 프롬프트를 조립한다.
 * 순서: 규칙(System) → 프로젝트 상태 → 압축 메모리 → 기획서 → 현재 Task → 산출물 규약
 */
export function buildStepPrompt(args: BuildPromptArgs): string {
  const { config, state, step, totalSteps, feedback, attempt } = args;

  const rules = collectCursorRules(config.targetProjectPath, config.rulesMaxChars);
  const mcpServers = listMcpServerNames(config.targetProjectPath);
  const spec = readSpec(config);

  const sections: string[] = [];

  sections.push(
    [
      '# [SYSTEM CONTEXT] 최우선 준수 지침',
      '너는 Unity 프로젝트를 자율적으로 개발하는 시니어 Unity 엔지니어다.',
      '아래 프로젝트 규칙은 어떤 경우에도 위반하지 말 것. 규칙과 지시가 충돌하면 규칙을 우선한다.',
      '',
      rules || '(프로젝트에 .cursorrules / .cursor/rules 가 없음 - Unity C# 표준 컨벤션을 따를 것)',
    ].join('\n'),
  );

  if (config.unityValidationBackend === 'cli' && (config.validationMode === 'compile' || config.validationMode === 'full')) {
    sections.push(
      [
        '# [TOOLING] Unity CLI',
        'Unity Editor 조작은 Coplay UnityMCP 를 쓰지 않는다. 공식 Unity CLI(`unity`)로 처리한다.',
        `프로젝트 경로: ${config.targetProjectPath}`,
        '에디터는 켜 둔다. 종료하지 말 것.',
        '명령 목록: unity command --project-path "<프로젝트>"',
        '호출 예: unity command <명령> --project-path "<프로젝트>" --format json',
        '프리팹, GameObject, 컴포넌트, Addressables, Play Mode 는 pipeline 명령으로 처리한다.',
        '인자 이름은 `unity command` 가 보여 주는 플래그를 따른다. 필요하면 `unity command <명령> --help`.',
        '사람의 확인을 기다리지 말고 셸로 실행한다.',
      ].join('\n'),
    );
  }

  const otherMcp = mcpServers.filter((name) => !/unity/i.test(name));
  if (otherMcp.length > 0) {
    sections.push(
      [
        '# [TOOLING] 기타 MCP 서버',
        `연결된 MCP: ${otherMcp.join(', ')}`,
        'Unity Editor 조작에는 이 MCP 를 쓰지 않는다.',
      ].join('\n'),
    );
  }

  sections.push(
    [
      '# [PROJECT STATE] 현재 프로젝트 상태',
      `- 프로젝트: ${state.project}`,
      `- 진행: Step ${step.id} / 총 ${totalSteps}`,
      `- 완료된 Step: ${state.completedSteps.length > 0 ? state.completedSteps.join(', ') : '없음'}`,
      `- 현재 시도: ${attempt} / ${config.maxRetries}`,
    ].join('\n'),
  );

  sections.push(['# [MEMORY] 이전 Step 핵심 요약', renderMemories(state)].join('\n'));

  if (spec) {
    sections.push(['# [SPEC] 기획서 (요약 컨텍스트)', spec].join('\n'));
  }

  if (state.autonomy?.goal) {
    sections.push(
      [
        '# [GOAL] 자율 개발 목표',
        state.autonomy.goal,
        '구현 범위는 현재 Task 와 기획서다. 기획서에 있는 내용은 유지한다.',
      ].join('\n'),
    );
    sections.push(formatPlanAuthority(state.autonomy.reviews, state.autonomy.lessons ?? []));
  }

  const taskLines = [`# [CURRENT TASK] Step ${step.id}: ${step.title}`, '', step.task];

  if (step.targetFiles && step.targetFiles.length > 0) {
    taskLines.push('', `주요 작업 대상: ${step.targetFiles.join(', ')}`);
  }

  if (step.playtest) {
    taskLines.push(
      '',
      '## 이 Step 의 조작 검증',
      `오케스트레이터가 Play Mode 에서 다음만 실행한다: ${step.playtest.input}`,
      `입력 후 화면은 이래야 한다: ${step.playtest.expect}`,
      step.playtest.failure ? `지난 실패: ${step.playtest.failure}` : '',
      '다른 기능의 키가 아니라, 이 조작에 이 기능이 반응하게 구현하라.',
      '기능이 일어나면 CursorAutoWork.PlaytestLog.Mark("이벤트이름") 를 호출하라.',
      step.playtest.probe
        ? `합격 측정: ${JSON.stringify(step.playtest.probe)}. 화면 설명만으로는 통과하지 않는다.`
        : 'probe 가 없다. events, position, active, text 중 하나를 playtest.probe 에 넣어라. 없으면 통과하지 않는다.',
    );
  }

  if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
    taskLines.push(
      '',
      '## 완료 조건 (Acceptance Criteria)',
      '완료 조건은 위 기획서를 기준으로 해석한다. 조건 문장이 짧거나 이상하면 기획서 해당 절을 따른다.',
      '로드맵과 기획서가 충돌하면 기획서를 우선한다.',
      ...step.acceptanceCriteria.map((item) => `- ${item}`),
    );
  }

  const inferred = config.inferVerify ? inferVerifyChecks(step) : [];
  const verifyPrompt = formatVerifyForPrompt(mergeVerifyChecks(inferred, step.verify?.checks ?? []));
  if (verifyPrompt) {
    taskLines.push('', verifyPrompt);
  }

  sections.push(taskLines.join('\n'));

  if (feedback) {
    sections.push(
      [
        '# [FEEDBACK] 직전 시도 검수 실패 - 반드시 먼저 해결할 것',
        feedback,
        '',
        '위 문제를 수정하는 것이 이번 시도의 최우선 과제다. 원인을 추정하지 말고 해당 파일을 직접 열어 확인한 뒤 수정하라.',
      ].join('\n'),
    );
  }

  sections.push(buildOutputContract(config));

  return sections.join('\n\n---\n\n');
}

/** 같은 구현 세션을 이어 갈 때. 기획서 전문을 다시 붙이지 않는다. */
export function buildContinuedStepPrompt(args: BuildPromptArgs): string {
  const { config, state, step, feedback, attempt } = args;
  const lines = [
    '# [CONTINUE] 같은 구현 세션',
    '이전 대화의 구현 세션을 이어 간다. 이미 한 작업을 처음부터 다시 하지 마라.',
    '기획서나 규칙이 필요하면 파일을 직접 읽어라.',
    '',
    formatPlanAuthority(state.autonomy?.reviews ?? [], state.autonomy?.lessons ?? []),
    '',
    `# Step ${step.id}: ${step.title}`,
    step.task,
  ];
  if (step.playtest) {
    lines.push(
      '',
      `이 Step 조작: ${step.playtest.input}`,
      `입력 후 화면: ${step.playtest.expect}`,
      step.playtest.failure ? `지난 실패, 같은 이유로 반복하지 말 것: ${step.playtest.failure}` : '',
    );
  }
  if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
    lines.push('', '완료 조건:', ...step.acceptanceCriteria.map((item) => `- ${item}`));
  }
  lines.push('', `시도 ${attempt} / ${config.maxRetries}`);
  if (feedback) {
    lines.push('', '# 이번 시도에서 먼저 고칠 검수 실패', feedback);
  }
  lines.push('', 'git commit 은 하지 마라.');
  return lines.join('\n');
}
