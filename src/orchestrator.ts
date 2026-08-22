import { needsUnity, describeValidationMode } from './config';
import {
  collectDiff,
  commitAll,
  diffSinceSnapshot,
  ensureGitRepo,
  ensureUnityGitignore,
  ensureWorkBranch,
  hasMeaningfulEdits,
  restoreFilesSinceSnapshot,
  selectCommitFiles,
  snapshotWorkingTree,
} from './gitManager';
import {
  contractResult,
  inferVerifyChecks,
  meaningfulChangesResult,
  mergeVerifyChecks,
  skippedJudgeResult,
} from './inferVerify';
import { formatJudgeFeedback, runStepJudge } from './stepJudge';
import type { WorkingTreeSnapshot } from './gitManager';
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
import {
  formatVerifyFeedback,
  requireChangesResult,
  resolveVerifyScope,
  runVerifyChecks,
  shouldRequireChanges,
} from './stepVerifier';
import type {
  AgentRunResult,
  OrchestratorConfig,
  OrchestratorState,
  Roadmap,
  GitDiffResult,
  RoadmapStep,
  TokenUsage,
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
  /** 이 Step id 이상만 대상. 완료된 Step 은 --force-rerun 없이 건너뛴다. */
  fromStep?: number;
  /** 이 Step 까지만 실행 */
  toStep?: number;
  /** 완료된 Step 도 다시 실행 */
  forceRerun?: boolean;
}

export class Orchestrator {
  private readonly config: OrchestratorConfig;

  private readonly roadmap: Roadmap;

  private readonly state: OrchestratorState;

  private readonly notifier: Notifier;

  private gitAvailable = false;

  private stopRequested = false;

  private forceRerun = false;

  private runAbort = new AbortController();

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.roadmap = loadRoadmap(config.roadmapPath);
    this.state = loadState(config, this.roadmap.project);
    this.notifier = new Notifier(config, this.roadmap.project);
  }

  /** Ctrl+C 등으로 실행 중인 Agent/검수를 즉시 끊고 파이프라인을 일시 중지한다. */
  requestStop(): void {
    if (this.stopRequested) {
      log.warn('중단이 반복되어 프로세스를 종료합니다.');
      process.exit(130);
    }
    this.stopRequested = true;
    this.runAbort.abort();
    log.warn('중단 요청 — 실행 중인 Agent/검수 연결을 끊습니다. Unity Editor 는 유지합니다.');
  }

  wasAborted(): boolean {
    return this.stopRequested;
  }

  async run(options: RunOptions = {}): Promise<void> {
    const startedAt = Date.now();
    this.stopRequested = false;
    this.runAbort = new AbortController();
    this.forceRerun = options.forceRerun === true;
    this.gitAvailable = await ensureGitRepo(this.config);
    if (this.gitAvailable) {
      ensureUnityGitignore(this.config);
      const branch = await ensureWorkBranch(this.config);
      if (branch) this.state.workBranch = branch;
    }

    if (this.config.validationMode === 'skip') {
      log.warn('VALIDATION_MODE=skip - 검수 없이 Step 을 통과 처리합니다 (커밋 본문에만 기록).');
    } else {
      log.info(`검수 모드: ${this.config.validationMode} (${describeValidationMode(this.config)})`);
    }

    const steps = selectRunnableSteps(this.roadmap, this.state, options);
    if (!options.forceRerun && this.state.completedSteps.length > 0) {
      const skipped = this.roadmap.steps.filter(
        (step) =>
          this.state.completedSteps.includes(step.id) &&
          (options.fromStep === undefined || step.id >= options.fromStep) &&
          (options.toStep === undefined || step.id <= options.toStep),
      );
      if (skipped.length > 0) {
        log.info(
          `완료된 Step ${skipped.map((step) => step.id).join(', ')} 는 건너뜁니다. 다시 실행하려면 --force-rerun`,
        );
      }
    }
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
        this.logUsage();
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

    this.logUsage();

    if (this.isAllStepsCompleted()) {
      this.state.status = 'all_completed';
      this.state.currentStepId = null;
      saveState(this.config, this.state);
      await this.notifier.pipelineDone(
        this.roadmap.project,
        this.state.completedSteps.length,
        this.roadmap.steps.length,
        Date.now() - startedAt,
        this.state.usage,
      );
    } else {
      this.state.status = 'idle';
      saveState(this.config, this.state);
      log.info(
        `실행 범위 Step 완료 (${this.state.completedSteps.length}/${this.roadmap.steps.length} 전체 완료)`,
      );
    }
  }

  private logUsage(): void {
    const usage = this.state.usage;
    if (!usage || usage.runs === 0) return;
    log.info(
      `토큰 합계: in ${usage.inputTokens} / out ${usage.outputTokens} (${usage.runs}회 Agent 실행)`,
    );
  }

  private isAllStepsCompleted(): boolean {
    return this.roadmap.steps.every((step) => this.state.completedSteps.includes(step.id));
  }

  private pausePipeline(reason: string): void {
    this.state.status = 'paused';
    saveState(this.config, this.state);
    log.warn(`${reason} — 파이프라인을 일시 중지했습니다 (status=paused).`);
  }

  /** 한 Step 을 재시도 한도 내에서 수행한다. 성공하면 true. */
  private async runStep(step: RoadmapStep): Promise<boolean> {
    const stepStartedAt = Date.now();
    const total = this.roadmap.steps.length;
    let feedback: string | undefined;

    this.state.currentStepId = step.id;
    this.state.status = 'in_progress';
    saveState(this.config, this.state);

    const baseline = await snapshotWorkingTree(this.config);
    let lastSessionId: string | undefined;

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

      const resume =
        this.config.resumeOnRetry && attempt > 1 && lastSessionId ? lastSessionId : undefined;
      const agentResult = await this.runAgent(prompt, resume);
      lastSessionId = agentResult.sessionId ?? lastSessionId;
      this.recordUsage(agentResult.usage);

      if (agentResult.aborted || this.stopRequested) {
        appendMemory(this.state, buildStepMemory(step, agentResult, null, attempt));
        this.state.lastError = '사용자 중단 (Ctrl+C)';
        saveState(this.config, this.state);
        return false;
      }

      if (agentResult.exitCode !== 0 || agentResult.timedOut) {
        feedback = this.describeAgentFailure(agentResult);
        appendMemory(this.state, buildStepMemory(step, agentResult, null, attempt));
        this.state.lastError = feedback;
        saveState(this.config, this.state);
        log.error(`Agent 실행이 실패했습니다: ${feedback.split('\n')[0]}`);
        await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
        continue;
      }

      const report = await this.validate(step, baseline);

      if (this.stopRequested || report.compile.aborted || report.tests.aborted || report.judge.aborted) {
        appendMemory(this.state, buildStepMemory(step, agentResult, report, attempt));
        this.state.lastError = '사용자 중단 (Ctrl+C)';
        saveState(this.config, this.state);
        return false;
      }

      if (report.ok) {
        const commitResult = await this.commitStep(step, report, baseline);
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
          report.delta.changedFiles,
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
    await this.rollbackFailedStep(step, baseline);
    return false;
  }

  private recordUsage(usage?: TokenUsage): void {
    if (!usage) return;
    if (!this.state.usage) this.state.usage = { inputTokens: 0, outputTokens: 0, runs: 0 };
    this.state.usage.inputTokens += usage.inputTokens;
    this.state.usage.outputTokens += usage.outputTokens;
    this.state.usage.runs += 1;
  }

  private async rollbackFailedStep(step: RoadmapStep, baseline: WorkingTreeSnapshot): Promise<void> {
    if (!this.config.rollbackOnFail || !this.gitAvailable || this.stopRequested) return;
    const latest = await diffSinceSnapshot(this.config, baseline, resolveVerifyScope(step));
    const restored = await restoreFilesSinceSnapshot(this.config, baseline, latest.changedFiles);
    if (restored.length > 0) {
      log.warn(`Step ${step.id} 실패 롤백 (${restored.length}개): ${restored.slice(0, 8).join(', ')}`);
    }
  }

  private async runAgent(prompt: string, resumeSessionId?: string): Promise<AgentRunResult> {
    let streamed = 0;
    return runCursorAgent({
      prompt,
      config: this.config,
      resumeSessionId,
      signal: this.runAbort.signal,
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
      delta: { hasChanges: diff.hasChanges, changedFiles: diff.changedFiles },
      checks: [],
      judge: skippedJudgeResult('VALIDATION_MODE=skip'),
      feedback: '',
    };
  }

  private lintProblems(diff: GitDiffResult): string[] {
    if (diff.violations.length === 0) return [];
    return [
      `린트/컨벤션 위반이 감지되었습니다:\n${diff.violations.map((item) => `- ${item}`).join('\n')}`,
    ];
  }

  private shouldRunUnityCompile(): boolean {
    return needsUnity(this.config);
  }

  private shouldRunTests(step: RoadmapStep): boolean {
    return this.config.validationMode === 'full' && step.runTests === true;
  }

  /** 추론/명시 Verify → 린트 → 컴파일 → 테스트 → 판정 Agent (AND) */
  private async validate(step: RoadmapStep, baseline: WorkingTreeSnapshot): Promise<ValidationReport> {
    if (this.config.validationMode === 'skip') return this.skipValidation(step);

    const scope = resolveVerifyScope(step);
    const scopeLabel = scope ? scope.join(', ') : '(전체)';

    await this.notifier.validating(step.id, 'Verify / Git Diff 린트 검사 중...');
    const diff = await diffSinceSnapshot(this.config, baseline, scope);
    const delta = { hasChanges: diff.hasChanges, changedFiles: diff.changedFiles };

    const inferred = this.config.inferVerify ? inferVerifyChecks(step) : [];
    const merged = mergeVerifyChecks(inferred, step.verify?.checks ?? []);
    const checks = runVerifyChecks(this.config.targetProjectPath, merged);
    checks.push(contractResult(step, inferred));
    const requireChanges = shouldRequireChanges(step, this.forceRerun);
    if (requireChanges) {
      checks.push(requireChangesResult(delta.hasChanges, scopeLabel));
      if (delta.hasChanges) {
        const meaningful = await hasMeaningfulEdits(this.config, diff.changedFiles);
        checks.push(meaningfulChangesResult(meaningful, scopeLabel));
      }
    }

    const problems: string[] = [];
    const verifyFeedback = formatVerifyFeedback(checks);
    if (verifyFeedback) problems.push(verifyFeedback);
    problems.push(...this.lintProblems(diff));

    let compile = skippedCompileResult(
      this.config,
      `VALIDATION_MODE=${this.config.validationMode} — Unity 컴파일 검수를 건너뛰었습니다.`,
    );
    let tests = skippedTestResult();
    let judge = skippedJudgeResult('앞 단계 실패 또는 판정 생략');

    const cheapOk = problems.length === 0;
    if (cheapOk && this.shouldRunUnityCompile()) {
      await this.notifier.validating(
        step.id,
        this.config.unityValidationBackend === 'batch'
          ? 'Unity Batchmode 컴파일 검사 중...'
          : 'Unity Editor(MCP) 컴파일 검사 중...',
      );
      compile = await runUnityCompile(this.config, this.runAbort.signal);

      if (compile.ok && this.shouldRunTests(step)) {
        await this.notifier.validating(step.id, 'Unity Editor(MCP) EditMode 테스트 실행 중...');
        tests = await runUnityTests(this.config, true, this.runAbort.signal);
      }
    }

    if (this.shouldRunUnityCompile() && !compile.ok) {
      problems.push(formatCompileFeedback(compile, this.config.maxErrorLines));
    }
    if (this.shouldRunUnityCompile() && !tests.ok && !tests.skipped) {
      problems.push(formatTestFeedback(tests, 10));
    }

    if (problems.length === 0 && this.config.stepJudge && !this.stopRequested) {
      await this.notifier.validating(step.id, '완료 조건 판정 중...');
      judge = await runStepJudge({
        config: this.config,
        step,
        delta,
        checks,
        signal: this.runAbort.signal,
      });
      const judgeFeedback = formatJudgeFeedback(judge);
      if (judgeFeedback) problems.push(judgeFeedback);
    }

    const ok = problems.length === 0;
    if (ok) {
      const compileLabel = this.shouldRunUnityCompile() ? '컴파일 ok' : '컴파일 생략';
      const testLabel =
        this.shouldRunTests(step) && !tests.skipped ? `테스트 ${tests.passed}/${tests.total}` : '테스트 생략';
      const checkLabel = `${checks.filter((item) => item.ok).length}/${checks.length}`;
      const judgeLabel = judge.skipped ? '판정 생략' : '판정 ok';
      log.info(
        `Step ${step.id} 검수 통과 (verify ${checkLabel}, 린트 ok, ${compileLabel}, ${testLabel}, ${judgeLabel}, delta ${diff.changedFiles.length}개)`,
      );
    }

    return { ok, skipped: false, compile, tests, diff, delta, checks, judge, feedback: problems.join('\n\n') };
  }

  private compileSummary(mode: ValidationMode, report: ValidationReport): string {
    if (report.skipped || mode === 'lint' || mode === 'skip') return 'skipped';
    return report.compile.ok ? 'ok' : 'failed';
  }

  private async commitStep(
    step: RoadmapStep,
    report: ValidationReport,
    baseline: WorkingTreeSnapshot,
  ): Promise<{ hash: string | null; failed: boolean; feedback: string }> {
    const noCommit = { hash: null as string | null, failed: false, feedback: '' };

    if (!this.config.autoCommit || !this.gitAvailable || !report.delta.hasChanges) return noCommit;

    const selected = selectCommitFiles(baseline, report.delta.changedFiles);
    if (selected.skippedDirty.length > 0) {
      log.warn(
        `시작 당시 dirty 파일이라 커밋에서 제외합니다: ${selected.skippedDirty.slice(0, 8).join(', ')}`,
      );
    }
    if (selected.files.length === 0) return noCommit;

    const subject = step.commitMessage ?? `feat: complete Step ${step.id} - ${step.title}`;
    const testSummary = report.tests.skipped
      ? 'skipped'
      : `${report.tests.passed}/${report.tests.total}`;
    const compileSummary = this.compileSummary(this.config.validationMode, report);
    const lintSummary = report.skipped ? 'skipped' : report.diff.violations.length === 0 ? 'ok' : 'failed';
    const verifySummary = report.skipped
      ? 'skipped'
      : `${report.checks.filter((item) => item.ok).length}/${report.checks.length}`;
    const judgeSummary = report.skipped || report.judge.skipped ? 'skipped' : report.judge.ok ? 'ok' : 'failed';
    const body = [
      '',
      `Validation: ${this.config.validationMode}`,
      `Changed files: ${report.delta.changedFiles.length}`,
      `Verify: ${verifySummary} / Lint: ${lintSummary} / Compile: ${compileSummary} / Tests: ${testSummary} / Judge: ${judgeSummary}`,
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
        selected.files,
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
    delete this.state.attempts[String(step.id)];
    this.state.status = 'completed';
    delete this.state.lastError;
    saveState(this.config, this.state);
  }
}

/** 완료 Step 은 forceRerun 없이 건너뛴다. --from 은 하한만 바꾼다. */
export function selectRunnableSteps(
  roadmap: Roadmap,
  state: OrchestratorState,
  options: RunOptions = {},
): RoadmapStep[] {
  let steps = roadmap.steps;

  if (options.fromStep !== undefined) {
    steps = steps.filter((step) => step.id >= options.fromStep!);
  }
  if (options.toStep !== undefined) {
    steps = steps.filter((step) => step.id <= options.toStep!);
  }
  if (!options.forceRerun) {
    steps = steps.filter((step) => !state.completedSteps.includes(step.id));
  }

  return steps;
}

/** preview-prompt 용 — state 를 변경하지 않고 Step 목록을 고른다. */
export function selectPreviewSteps(
  roadmap: Roadmap,
  state: OrchestratorState,
  fromStep?: number,
  toStep?: number,
  forceRerun?: boolean,
): RoadmapStep[] {
  return selectRunnableSteps(roadmap, state, { fromStep, toStep, forceRerun });
}
