/**
 * 오케스트레이터 전역 타입 정의.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 검수 파이프라인 프리셋.
 * - `lint`    : Git Diff + 컨벤션 린트
 * - `compile` : lint + Unity Editor(MCP) 컴파일 (기본값)
 * - `full`    : lint + 컴파일 + EditMode 테스트 (roadmap step.runTests=true 일 때)
 * - `skip`    : 검수 생략 (diff 수집만, 실패 없음)
 */
export type ValidationMode = 'lint' | 'compile' | 'full' | 'skip';

/** compile/full 에서 Unity 를 검사하는 채널 */
export type UnityValidationBackend = 'mcp' | 'batch';

/**
 * 프롬프트를 agent CLI 에 전달하는 방식.
 * - `argv`  : 명령행 인자로 전달 (Windows cmd.exe 는 8191자 상한)
 * - `stdin` : 표준 입력으로 전달 (길이 제한 없음)
 * - `file`  : 파일로 저장하고 그 경로를 읽으라고 지시
 * - `auto`  : 명령행 상한을 넘지 않으면 argv, 넘으면 stdin (실패 시 file 폴백)
 */
export type PromptDelivery = 'auto' | 'argv' | 'stdin' | 'file';

export interface OrchestratorConfig {
  /** Unity 프로젝트 루트 (Assets/, ProjectSettings/ 위치) */
  targetProjectPath: string;
  /** Unity Editor 실행 파일 경로 */
  unityPath: string;
  /** agent CLI 실행 커맨드 (공식 Cursor CLI) */
  cursorAgentBin: string;
  /** 사용할 모델 (빈 값이면 CLI 기본값) */
  cursorModel: string;
  /** MCP/파일쓰기 자동 승인 여부 */
  cursorYolo: boolean;
  /** 프롬프트 전달 방식 */
  promptDelivery: PromptDelivery;
  /** 검수 파이프라인 프리셋 */
  validationMode: ValidationMode;
  /** compile/full 검수 채널. 기본 mcp (에디터 유지). batch 는 에디터를 종료함 */
  unityValidationBackend: UnityValidationBackend;
  /** 인스턴스가 없으면 UNITY_PATH 로 에디터를 띄운다 */
  unityLaunchEditor: boolean;
  /** 에디터 기동/접속 대기 (ms) */
  unityLaunchTimeoutMs: number;
  /** 검수 전 Play Mode 중지 */
  unityStopPlayMode: boolean;
  /** 검수 후 원래 Play Mode 복구 */
  unityRestorePlayMode: boolean;

  discordWebhookUrl: string;

  /** 절대 경로로 정규화된 경로들 */
  specPath: string;
  roadmapPath: string;
  statePath: string;
  runtimeDir: string;
  logsDir: string;

  maxRetries: number;
  agentTimeoutMs: number;
  unityTimeoutMs: number;
  /** targetFiles/완료 조건에서 verify 를 추론 */
  inferVerify: boolean;
  /** acceptanceCriteria 판정 Agent */
  stepJudge: boolean;
  judgeTimeoutMs: number;
  /** 검수 실패 재시도 시 직전 세션 resume */
  resumeOnRetry: boolean;
  /** 재시도 소진 시 이번 Step delta 만 되돌림 (시작 당시 dirty 는 유지) */
  rollbackOnFail: boolean;
  /** run 시작 시 auto-work/* 작업 브랜치 생성 */
  createWorkBranch: boolean;
  /** 규칙 문서 예산 (초과 시 중간 생략 + 경고) */
  rulesMaxChars: number;
  /** 기획서 예산 (초과 시 중간 생략 + 경고) */
  specMaxChars: number;
  autoCommit: boolean;
  gitAuthorName: string;
  gitAuthorEmail: string;
  maxErrorLines: number;
  logLevel: LogLevel;
}

/** roadmap.json 의 단일 Step 정의 */
export interface RoadmapStep {
  id: number;
  title: string;
  /** Agent 에게 전달할 실제 작업 지시문 */
  task: string;
  /** 완료 판정 기준 (프롬프트에 함께 주입) */
  acceptanceCriteria?: string[];
  /** 이 Step 에서 주로 다룰 파일/디렉터리 — verify/린트/커밋 범위 기본값 */
  targetFiles?: string[];
  /** 기계 판정 계약. 문장형 acceptanceCriteria 와 별개로 디스크를 검사한다. */
  verify?: VerifySpec;
  /** VALIDATION_MODE=full 일 때 이 Step 에서 EditMode 테스트 실행 */
  runTests?: boolean;
  /** 이 Step 전용 커밋 메시지 (미지정 시 기본 포맷) */
  commitMessage?: string;
}

/** 린트·requireChanges·커밋에 쓰는 경로 범위 */
export type VerifyScope = 'targetFiles' | 'all';

export type VerifyCheckType =
  | 'exists'
  | 'notExists'
  | 'globMin'
  | 'contains'
  | 'notContains'
  | 'jsonField'
  | 'csNoUnityEngine'
  | 'prefab'
  | 'addressable';

/** roadmap.json verify.checks 의 한 항목 */
export interface VerifyCheck {
  type: VerifyCheckType;
  /** 단일 파일 또는 디렉터리 (exists / jsonField / csNoUnityEngine 등) */
  path?: string;
  /** 글롭 (posix, 예: Assets/Scripts 아래의 *.cs) */
  glob?: string;
  /** globMin 의 최소 매칭 수 */
  min?: number;
  /** contains / notContains / jsonField 패턴 또는 부분 문자열 */
  pattern?: string;
  /** jsonField: 점 구분 경로 (예: references) */
  field?: string;
  /** jsonField: 배열/문자열에 있어야 할 값 */
  contains?: string | string[];
  /** jsonField: 배열/문자열에 있으면 안 되는 값 */
  mustNotContain?: string | string[];
  /** jsonField: 필드 값과 JSON 동일 */
  equals?: unknown;
  /** addressable: 그룹 이름 (예: UI) */
  group?: string;
  /** addressable: 등록 주소 (예: ui/main_menu) */
  address?: string;
}

export interface VerifySpec {
  /** 기본값: targetFiles 가 있으면 그 범위, 없으면 워킹 트리 전체 */
  scope?: VerifyScope;
  /** 기본값: 일반 실행 true, --force-rerun 이면 false */
  requireChanges?: boolean;
  /** 예약. 프리팹/Addressables 는 디스크 YAML 로 검사한다. */
  mcp?: string[];
  checks?: VerifyCheck[];
}

export interface CheckResult {
  ok: boolean;
  type: VerifyCheckType | 'requireChanges' | 'requireMeaningfulChanges' | 'requireContract';
  target: string;
  message: string;
}

export interface JudgeCriterionResult {
  index: number;
  text: string;
  ok: boolean;
  evidence: string;
  note: string;
}

export interface JudgeVerdict {
  ok: boolean;
  skipped: boolean;
  reasons: string[];
  raw: string;
  criteria?: JudgeCriterionResult[];
  aborted?: boolean;
  durationMs: number;
}

export interface StepDelta {
  hasChanges: boolean;
  changedFiles: string[];
}

export interface Roadmap {
  project: string;
  description?: string;
  steps: RoadmapStep[];
}

export type StepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'needs_human'
  | 'paused';

/** 완료된 Step 의 압축 요약 (Fresh Context 주입용) */
export interface StepMemory {
  stepId: number;
  title: string;
  status: StepStatus;
  /** Agent 출력에서 추출한 핵심 요약 문장들 */
  summary: string[];
  /** 이 Step 에서 변경된 파일 목록 (상위 N개) */
  changedFiles: string[];
  commitHash?: string;
  attempts: number;
  finishedAt: string;
}

export interface OrchestratorState {
  project: string;
  currentStepId: number | null;
  status: StepStatus | 'idle' | 'all_completed';
  attempts: Record<string, number>;
  completedSteps: number[];
  memories: StepMemory[];
  lastError?: string;
  startedAt: string;
  updatedAt: string;
  workBranch?: string;
  usage?: UsageTotals;
}

/** agent CLI --output-format stream-json 이벤트의 느슨한 표현 */
export interface AgentStreamEvent {
  type?: string;
  subtype?: string;
  role?: string;
  message?: unknown;
  delta?: unknown;
  text?: string;
  content?: unknown;
  session_id?: string;
  [key: string]: unknown;
}

export interface AgentRunResult {
  /** 프로세스 종료 코드 */
  exitCode: number | null;
  /** Agent 가 출력한 어시스턴트 텍스트 전체 */
  assistantText: string;
  /** 사용된 도구 이름 목록 (UnityMCP 호출 추적용) */
  toolCalls: string[];
  /** CLI 가 보고한 세션 ID */
  sessionId?: string;
  /** 타임아웃으로 강제 종료되었는지 여부 */
  timedOut: boolean;
  /** Ctrl+C 등으로 사용자가 끊었는지 */
  aborted?: boolean;
  /** stderr 원문 (에러 진단용) */
  stderr: string;
  durationMs: number;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals extends TokenUsage {
  runs: number;
}

export interface CompileError {
  file: string;
  line: number;
  code: string;
  message: string;
  raw: string;
}

export interface UnityCompileResult {
  ok: boolean;
  errors: CompileError[];
  /** 파싱 대상 로그 파일 경로 */
  logPath: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 컴파일 에러가 아닌 실행 실패 사유 (Unity 미기동 등) */
  failureReason?: string;
  /** Ctrl+C 등으로 검수를 끊었는지 */
  aborted?: boolean;
}

export interface UnityTestResult {
  ok: boolean;
  skipped: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
  resultPath?: string;
  failureReason?: string;
  aborted?: boolean;
}

export interface GitDiffResult {
  hasChanges: boolean;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  /** 컨벤션 위반 (Debug.Log 잔존 등) */
  violations: string[];
}

export interface ValidationReport {
  ok: boolean;
  /** validationMode=skip 으로 실제 검수 없이 통과 처리된 결과인지 */
  skipped: boolean;
  compile: UnityCompileResult;
  tests: UnityTestResult;
  diff: GitDiffResult;
  /** Step 시작 이후 · scope 안 변경 (커밋 대상) */
  delta: StepDelta;
  /** verify.checks + 추론 체크 + requireChanges 결과 */
  checks: CheckResult[];
  /** 완료 조건 판정 Agent. skip 이거나 앞 단계 실패면 skipped */
  judge: JudgeVerdict;
  /** 실패 시 Agent 에게 재지시할 피드백 본문 */
  feedback: string;
}

export type NotifyLevel = 'start' | 'progress' | 'success' | 'warning' | 'critical' | 'info';

export interface NotifyField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyPayload {
  level: NotifyLevel;
  title: string;
  description?: string;
  fields?: NotifyField[];
  footer?: string;
}
