/**
 * 오케스트레이터 전역 타입 정의.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 검수 파이프라인 프리셋.
 * - `lint`    : Git Diff + 컨벤션 린트
 * - `compile` : lint + Unity Batchmode 컴파일
 * - `full`    : lint + 컴파일 + EditMode 테스트 (roadmap step.runTests=true 일 때)
 * - `skip`    : 검수 생략 (diff 수집만, 실패 없음)
 */
export type ValidationMode = 'lint' | 'compile' | 'full' | 'skip';

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
  /** 이 Step 에서 주로 다룰 파일/디렉터리 힌트 */
  targetFiles?: string[];
  /** VALIDATION_MODE=full 일 때 이 Step 에서 EditMode 테스트 실행 */
  runTests?: boolean;
  /** 이 Step 전용 커밋 메시지 (미지정 시 기본 포맷) */
  commitMessage?: string;
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
  /** stderr 원문 (에러 진단용) */
  stderr: string;
  durationMs: number;
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
