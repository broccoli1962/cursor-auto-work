import { needsUnity, describeValidationMode } from './config';
import { collectDiff, commitAll, ensureGitRepo, ensureUnityGitignore } from './gitManager';
import { runCursorAgent } from './cursorRunner';
import { createLogger } from './logger';
import {
  appendMemory,
  buildStepMemory,
  buildStepPrompt,
  loadState,
  saveState,
} from './memoryManager';
import { Notifier } from './notifier';
import { loadRoadmap } from './roadmap';
import type {
  AgentRunResult,
  OrchestratorConfig,
  OrchestratorState,
  Roadmap,
  RoadmapStep,
  ValidationMode,
  ValidationReport,
} from './types';
import {
  formatCompileFeedback,
  formatTestFeedback,
  runUnityCompile,
  runUnityTests,
  skippedCompileResult,
  skippedTestResult,
} from './unityValidator';

const log = createLogger('orchestrator');

export interface RunOptions {
  /** 지정한 Step 부터 시작 (state.json 무시) */
  fromStep?: number;
  /** 이 Step 까지만 실행 */
  toStep?: number;
}

export class Orchestrator {
  private readonly config: OrchestratorConfig;

  private readonly roadmap: Roadmap;

  private readonly state: OrchestratorState;

  private readonly notifier: Notifier;

  private gitAvailable = false;

  private stopRequested = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.roadmap = loadRoadmap(config.roadmapPath);
    this.state = loadState(config, this.roadmap.project);
    this.notifier = new Notifier(config, this.roadmap.project);
  }

  /** Ctrl+C 등으로 현재 Step 종료 후 안전하게 멈추도록 요청한다. */
  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    log.warn('중단 요청 수신 - 현재 Step 을 마치는 대로 종료합니다.');
  }

  async run(options: RunOptions = {}): Promise<void> {
    const startedAt = Date.now();
    this.gitAvailable = await ensureGitRepo(this.config);
    if (this.gitAvailable) ensureUnityGitignore(this.config);

    if (this.config.validationMode === 'skip') {
      log.warn('VALIDATION_MODE=skip - 검수 없이 Step 을 통과 처리합니다 (커밋 본문에만 기록).');
    } else {
      log.info(`검수 모드: ${this.config.validationMode} (${describeValidationMode(this.config)})`);
    }

    const steps = this.selectSteps(options);
    if (steps.length === 0) {
      log.info('실행할 Step 이 없습니다. 모든 작업이 이미 완료되었습니다.');
      if (this.isAllStepsCompleted()) {
        this.state.status = 'all_completed';
        this.state.currentStepId = null;
      }
      saveState(this.config, this.state);
      return;
    }

    log.info(
      `파이프라인 시작: ${this.roadmap.project} (실행 대상 ${steps.length}개 / 전체 ${this.roadmap.steps.length}개)`,
    );

    for (const step of steps) {
      if (this.stopRequested) {
        this.pausePipeline('Step 시작 전 중단 요청');
        return;
      }

      const succeeded = await this.runStep(step);
      if (!succeeded) {
        if (this.stopRequested) {
          this.pausePipeline(`Step ${step.id} 처리 중 중단 요청`);
          return;
        }
        this.state.status = 'needs_human';
        saveState(this.config, this.state);
        log.error(`Step ${step.id} 에서 파이프라인이 중단되었습니다.`);
        return;
      }
    }

    if (this.stopRequested) {
      this.pausePipeline('파이프라인 마지막 Step 완료 후 중단 요청');
      return;
    }

    if (this.isAllStepsCompleted()) {
      this.state.status = 'all_completed';
      this.state.currentStepId = null;
      saveState(this.config, this.state);
      await this.notifier.pipelineDone(
        this.roadmap.project,
        this.state.completedSteps.length,
        this.roadmap.steps.length,
        Date.now() - startedAt,
      );
    } else {
      this.state.status = 'idle';
      saveState(this.config, this.state);
      log.info(
        `실행 범위 Step 완료 (${this.state.completedSteps.length}/${this.roadmap.steps.length} 전체 완료)`,
      );
    }
  }

  private isAllStepsCompleted(): boolean {
    return this.roadmap.steps.every((step) => this.state.completedSteps.includes(step.id));
  }

  private pausePipeline(reason: string): void {
    this.state.status = 'paused';
    saveState(this.config, this.state);
    log.warn(`${reason} — 파이프라인을 일시 중지했습니다 (status=paused).`);
  }

  private selectSteps(options: RunOptions): RoadmapStep[] {
    let steps = this.roadmap.steps;

    if (options.fromStep !== undefined) {
      steps = steps.filter((step) => step.id >= options.fromStep!);
    } else {
      steps = steps.filter((step) => !this.state.completedSteps.includes(step.id));
    }

    if (options.toStep !== undefined) {
      steps = steps.filter((step) => step.id <= options.toStep!);
    }

    return steps;
  }

  /** 한 Step 을 재시도 한도 내에서 수행한다. 성공하면 true. */
  private async runStep(step: RoadmapStep): Promise<boolean> {
    const stepStartedAt = Date.now();
    const total = this.roadmap.steps.length;
    let feedback: string | undefined;

    this.state.currentStepId = step.id;
    this.state.status = 'in_progress';
    saveState(this.config, this.state);

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.stopRequested) {
        log.warn(`Step ${step.id} — 중단 요청으로 재시도를 멈춥니다.`);
        return false;
      }

      this.state.attempts[String(step.id)] = attempt;
      saveState(this.config, this.state);

      await this.notifier.stepStart(step.id, total, step.title, step.task, attempt);

      const prompt = buildStepPrompt({
        config: this.config,
        state: this.state,
        step,
        totalSteps: total,
        feedback,
        attempt,
      });

      const agentResult = await this.runAgent(prompt);

      if (agentResult.exitCode !== 0 || agentResult.timedOut) {
        feedback = this.describeAgentFailure(agentResult);
        appendMemory(this.state, buildStepMemory(step, agentResult, null, attempt));
        this.state.lastError = feedback;
        saveState(this.config, this.state);
        log.error(`Agent 실행이 실패했습니다: ${feedback.split('\n')[0]}`);
        await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
        continue;
      }

      const report = await this.validate(step);

      if (report.ok) {
        const commitResult = await this.commitStep(step, report);
        if (commitResult.failed) {
          feedback = commitResult.feedback;
          appendMemory(this.state, buildStepMemory(step, agentResult, report, attempt));
          this.state.lastError = feedback;
          saveState(this.config, this.state);
          if (attempt < this.config.maxRetries) {
            await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
            log.warn(`Step ${step.id} 커밋 실패 — 재시도 준비 (${attempt}/${this.config.maxRetries})`);
          }
          continue;
        }

        this.markCompleted(step, agentResult, report, attempt, commitResult.hash ?? undefined);
        await this.notifier.stepSuccess(
          step.id,
          step.title,
          commitResult.hash,
          report.diff.changedFiles,
          Date.now() - stepStartedAt,
        );
        return true;
      }

      feedback = report.feedback;
      appendMemory(this.state, buildStepMemory(step, agentResult, report, attempt));
      this.state.lastError = feedback;
      saveState(this.config, this.state);

      if (attempt < this.config.maxRetries) {
        await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
        log.warn(`Step ${step.id} 재시도 준비 (${attempt}/${this.config.maxRetries})`);
      }
    }

    await this.notifier.humanNeeded(
      step.id,
      step.title,
      feedback ?? '알 수 없는 사유로 검수를 통과하지 못했습니다.',
    );
    return false;
  }

  private async runAgent(prompt: string): Promise<AgentRunResult> {
    let streamed = 0;
    return runCursorAgent({
      prompt,
      config: this.config,
      onText: (text) => {
        streamed += text.length;
        if (this.config.logLevel === 'debug') process.stdout.write(text);
      },
      onToolCall: (tool) => {
        if (tool.includes('unity')) log.info(`UnityMCP 도구 호출: ${tool}`);
      },
    }).then((result) => {
      log.debug(`스트리밍 수신 텍스트 ${streamed} chars`);
      return result;
    });
  }

  private describeAgentFailure(result: AgentRunResult): string {
    const parts: string[] = [];

    if (result.timedOut) {
      parts.push(
        `agent CLI 가 ${this.config.agentTimeoutMs}ms 내에 응답을 마치지 못했습니다. Task 범위를 더 잘게 쪼개세요.`,
      );
    } else if (result.exitCode !== 0) {
      parts.push(`agent CLI 가 비정상 종료했습니다 (exit code ${result.exitCode}).`);
    }

    if (result.stderr) parts.push(`agent CLI 실행 오류:\n${result.stderr.slice(-1500)}`);

    const text = result.assistantText.trim();
    if (text) parts.push(`부분 출력:\n${text.slice(-1500)}`);

    if (parts.length === 0) {
      return `agent CLI 가 출력 없이 종료했습니다 (exit code ${result.exitCode}).`;
    }

    return parts.join('\n\n');
  }

  /** VALIDATION_MODE=skip 일 때의 검수 대체 경로. */
  private async skipValidation(step: RoadmapStep): Promise<ValidationReport> {
    await this.notifier.validating(step.id, '검수 생략 (VALIDATION_MODE=skip)');

    const diff = await collectDiff(this.config);
    log.info(
      `Step ${step.id} 검수 없이 통과 (VALIDATION_MODE=skip, 변경 ${diff.changedFiles.length}개 파일)`,
    );

    return {
      ok: true,
      skipped: true,
      compile: skippedCompileResult(this.config, 'VALIDATION_MODE=skip 로 컴파일 검수를 건너뛰었습니다.'),
      tests: skippedTestResult(),
      diff,
      feedback: '',
    };
  }

  private lintProblems(diff: Awaited<ReturnType<typeof collectDiff>>): string[] {
    const problems: string[] = [];

    if (!diff.hasChanges) {
      problems.push(
        '변경된 파일이 하나도 없습니다. Agent 가 파일을 쓰지 못했거나 작업이 완료되지 않았습니다. CURSOR_YOLO=true 및 대상 경로 쓰기 권한을 확인하세요.',
      );
    }

    if (diff.violations.length > 0) {
      problems.push(
        `린트/컨벤션 위반이 감지되었습니다:\n${diff.violations.map((item) => `- ${item}`).join('\n')}`,
      );
    }

    return problems;
  }

  private shouldRunUnityCompile(): boolean {
    return needsUnity(this.config);
  }

  private shouldRunTests(step: RoadmapStep): boolean {
    return this.config.validationMode === 'full' && step.runTests === true;
  }

  /** Git Diff 린트 → (선택) 컴파일 → (선택) 테스트 순서로 검수 */
  private async validate(step: RoadmapStep): Promise<ValidationReport> {
    if (this.config.validationMode === 'skip') return this.skipValidation(step);

    await this.notifier.validating(step.id, 'Git Diff 린트 검사 중...');
    const diff = await collectDiff(this.config);

    let compile = skippedCompileResult(
      this.config,
      `VALIDATION_MODE=${this.config.validationMode} — Unity 컴파일 검수를 건너뛰었습니다.`,
    );
    let tests = skippedTestResult();

    if (this.shouldRunUnityCompile()) {
      await this.notifier.validating(step.id, 'Unity Batchmode 컴파일 검사 중...');
      compile = await runUnityCompile(this.config);

      if (compile.ok && this.shouldRunTests(step)) {
        await this.notifier.validating(step.id, 'Unity EditMode 테스트 실행 중...');
        tests = await runUnityTests(this.config, true);
      }
    }

    const problems: string[] = [...this.lintProblems(diff)];

    if (this.shouldRunUnityCompile() && !compile.ok) {
      problems.push(formatCompileFeedback(compile, this.config.maxErrorLines));
    }
    if (this.shouldRunUnityCompile() && !tests.ok && !tests.skipped) {
      problems.push(formatTestFeedback(tests, 10));
    }

    const ok = problems.length === 0;
    if (ok) {
      const compileLabel = this.shouldRunUnityCompile() ? '컴파일 ok' : '컴파일 생략';
      const testLabel =
        this.shouldRunTests(step) && !tests.skipped ? `테스트 ${tests.passed}/${tests.total}` : '테스트 생략';
      log.info(
        `Step ${step.id} 검수 통과 (린트 ok, ${compileLabel}, ${testLabel}, 변경 ${diff.changedFiles.length}개 파일)`,
      );
    }

    return { ok, skipped: false, compile, tests, diff, feedback: problems.join('\n\n') };
  }

  private compileSummary(mode: ValidationMode, report: ValidationReport): string {
    if (report.skipped || mode === 'lint' || mode === 'skip') return 'skipped';
    return report.compile.ok ? 'ok' : 'failed';
  }

  private async commitStep(
    step: RoadmapStep,
    report: ValidationReport,
  ): Promise<{ hash: string | null; failed: boolean; feedback: string }> {
    const noCommit = { hash: null as string | null, failed: false, feedback: '' };

    if (!this.config.autoCommit || !this.gitAvailable || !report.diff.hasChanges) return noCommit;

    const subject = step.commitMessage ?? `feat: complete Step ${step.id} - ${step.title}`;
    const testSummary = report.tests.skipped
      ? 'skipped'
      : `${report.tests.passed}/${report.tests.total}`;
    const compileSummary = this.compileSummary(this.config.validationMode, report);
    const lintSummary = report.skipped ? 'skipped' : report.diff.violations.length === 0 ? 'ok' : 'failed';
    const body = [
      '',
      `Validation: ${this.config.validationMode}`,
      `Changed files: ${report.diff.changedFiles.length}`,
      `Lint: ${lintSummary} / Compile: ${compileSummary} / Tests: ${testSummary}`,
      ...(report.skipped
        ? [
            '',
            'NOTE: validation skipped (VALIDATION_MODE=skip).',
            'No lint, compile, or test checks were performed.',
          ]
        : []),
      '',
      'Automated by cursor-auto-work orchestrator.',
    ].join('\n');

    try {
      const hash = await commitAll(
        this.config,
        `${subject}\n${body}`,
        report.diff.changedFiles,
      );
      if (hash) return { hash, failed: false, feedback: '' };

      return {
        hash: null,
        failed: true,
        feedback:
          'Git 커밋에 실패했습니다. 커밋할 변경사항이 없거나 git add/commit 이 거부되었습니다. ' +
          '워킹 트리 상태와 git 설정을 확인하세요.',
      };
    } catch (error) {
      const message = (error as Error).message;
      log.error(`커밋 실패: ${message}`);
      return {
        hash: null,
        failed: true,
        feedback: `Git 커밋 실패:\n${message}`,
      };
    }
  }

  private markCompleted(
    step: RoadmapStep,
    agentResult: AgentRunResult | null,
    report: ValidationReport | null,
    attempts: number,
    commitHash?: string,
  ): void {
    if (agentResult) {
      appendMemory(this.state, buildStepMemory(step, agentResult, report, attempts, commitHash));
    }
    if (!this.state.completedSteps.includes(step.id)) {
      this.state.completedSteps.push(step.id);
      this.state.completedSteps.sort((a, b) => a - b);
    }
    this.state.status = 'completed';
    delete this.state.lastError;
    saveState(this.config, this.state);
  }
}

/** preview-prompt 용 — state 를 변경하지 않고 Step 목록을 고른다. */
export function selectPreviewSteps(
  roadmap: Roadmap,
  state: OrchestratorState,
  fromStep?: number,
  toStep?: number,
): RoadmapStep[] {
  let steps = roadmap.steps;

  if (fromStep !== undefined) {
    steps = steps.filter((step) => step.id >= fromStep);
  } else {
    steps = steps.filter((step) => !state.completedSteps.includes(step.id));
  }

  if (toStep !== undefined) {
    steps = steps.filter((step) => step.id <= toStep);
  }

  return steps;
}
