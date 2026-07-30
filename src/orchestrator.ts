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
  ValidationReport,
} from './types';
import {
  formatCompileFeedback,
  formatTestFeedback,
  runUnityCompile,
  runUnityTests,
} from './unityValidator';

const log = createLogger('orchestrator');

export interface RunOptions {
  /** 지정한 Step 부터 시작 (state.json 무시) */
  fromStep?: number;
  /** 이 Step 까지만 실행 */
  toStep?: number;
  /** Agent 를 실행하지 않고 파이프라인 구성만 점검 */
  dryRun?: boolean;
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

    const steps = this.selectSteps(options);
    if (steps.length === 0) {
      log.info('실행할 Step 이 없습니다. 모든 작업이 이미 완료되었습니다.');
      this.state.status = 'all_completed';
      saveState(this.config, this.state);
      return;
    }

    log.info(
      `파이프라인 시작: ${this.roadmap.project} (실행 대상 ${steps.length}개 / 전체 ${this.roadmap.steps.length}개)`,
    );

    for (const step of steps) {
      if (this.stopRequested) {
        log.warn('중단 요청으로 파이프라인을 종료합니다.');
        break;
      }

      const succeeded = await this.runStep(step, options.dryRun ?? false);
      if (!succeeded) {
        this.state.status = 'needs_human';
        saveState(this.config, this.state);
        log.error(`Step ${step.id} 에서 파이프라인이 중단되었습니다.`);
        return;
      }
    }

    if (!this.stopRequested) {
      this.state.status = 'all_completed';
      this.state.currentStepId = null;
      saveState(this.config, this.state);
      await this.notifier.pipelineDone(
        this.roadmap.project,
        this.state.completedSteps.length,
        this.roadmap.steps.length,
        Date.now() - startedAt,
      );
    }
  }

  private selectSteps(options: RunOptions): RoadmapStep[] {
    let steps = this.roadmap.steps;

    if (options.fromStep !== undefined) {
      steps = steps.filter((step) => step.id >= options.fromStep!);
    } else {
      // 이어하기: 이미 완료된 Step 은 건너뛴다.
      steps = steps.filter((step) => !this.state.completedSteps.includes(step.id));
    }

    if (options.toStep !== undefined) {
      steps = steps.filter((step) => step.id <= options.toStep!);
    }

    return steps;
  }

  /** 한 Step 을 재시도 한도 내에서 수행한다. 성공하면 true. */
  private async runStep(step: RoadmapStep, dryRun: boolean): Promise<boolean> {
    const stepStartedAt = Date.now();
    const total = this.roadmap.steps.length;
    let feedback: string | undefined;

    this.state.currentStepId = step.id;
    this.state.status = 'in_progress';
    saveState(this.config, this.state);

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      this.state.attempts[String(step.id)] = attempt;
      saveState(this.config, this.state);

      await this.notifier.stepStart(step.id, total, step.title, step.task, attempt);

      // 매 시도를 Fresh Context 로 구동 (세션 재사용 없음)
      const prompt = buildStepPrompt({
        config: this.config,
        state: this.state,
        step,
        totalSteps: total,
        feedback,
        attempt,
      });

      if (dryRun) {
        log.info(`[dry-run] Step ${step.id} 프롬프트 (${prompt.length} chars)\n${prompt}`);
        this.markCompleted(step, null, null, attempt);
        return true;
      }

      const agentResult = await this.runAgent(prompt);

      if (agentResult.exitCode !== 0 && agentResult.assistantText.trim() === '') {
        feedback = this.describeAgentFailure(agentResult);
        log.error(`Agent 실행 자체가 실패했습니다: ${feedback}`);
        await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
        continue;
      }

      const report = await this.validate(step);

      if (report.ok) {
        const commitHash = await this.commitStep(step, report);
        this.markCompleted(step, agentResult, report, attempt, commitHash ?? undefined);
        await this.notifier.stepSuccess(
          step.id,
          step.title,
          commitHash,
          report.diff.changedFiles,
          Date.now() - stepStartedAt,
        );
        return true;
      }

      feedback = report.feedback;
      appendMemory(
        this.state,
        buildStepMemory(step, agentResult, report, attempt),
      );
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
        // 스트리밍 원문은 debug 레벨에서만 흘려보낸다.
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
    if (result.timedOut) {
      return `cursor-agent 가 ${this.config.agentTimeoutMs}ms 내에 응답을 마치지 못했습니다. Task 범위를 더 잘게 쪼개세요.`;
    }
    if (result.stderr) return `cursor-agent 실행 오류:\n${result.stderr.slice(-1500)}`;
    return `cursor-agent 가 출력 없이 종료했습니다 (exit code ${result.exitCode}).`;
  }

  /** 컴파일 → 테스트 → Git Diff 3단계 검수 */
  private async validate(step: RoadmapStep): Promise<ValidationReport> {
    await this.notifier.validating(step.id, 'Unity Batchmode 컴파일 검사 중...');
    const compile = await runUnityCompile(this.config);

    const testsEnabled = step.runTests ?? this.config.runUnityTests;
    if (compile.ok && testsEnabled) {
      await this.notifier.validating(step.id, 'Unity EditMode 테스트 실행 중...');
    }
    const tests = compile.ok
      ? await runUnityTests(this.config, testsEnabled)
      : { ok: true, skipped: true, total: 0, passed: 0, failed: 0, failures: [] };

    const diff = await collectDiff(this.config);

    const problems: string[] = [];

    if (!compile.ok) {
      problems.push(formatCompileFeedback(compile, this.config.maxErrorLines));
    }
    if (!tests.ok) {
      problems.push(formatTestFeedback(tests, 10));
    }
    if (compile.ok && this.gitAvailable && !diff.hasChanges) {
      problems.push(
        '작업 후 변경된 파일이 하나도 없습니다. 코드를 채팅으로만 출력했거나 파일 저장에 실패했을 수 있습니다. 실제 파일을 생성/수정하세요.',
      );
    }
    if (diff.violations.length > 0) {
      problems.push(
        `컨벤션 위반이 감지되었습니다:\n${diff.violations.map((item) => `- ${item}`).join('\n')}`,
      );
    }

    const ok = problems.length === 0;
    if (ok) log.info(`Step ${step.id} 검수 통과 (변경 ${diff.changedFiles.length}개 파일)`);

    return { ok, compile, tests, diff, feedback: problems.join('\n\n') };
  }

  private async commitStep(step: RoadmapStep, report: ValidationReport): Promise<string | null> {
    if (!this.config.autoCommit || !this.gitAvailable || !report.diff.hasChanges) return null;

    const subject = step.commitMessage ?? `feat: complete Step ${step.id} - ${step.title}`;
    const body = [
      '',
      `Changed files: ${report.diff.changedFiles.length}`,
      `Compile: ok / Tests: ${report.tests.skipped ? 'skipped' : `${report.tests.passed}/${report.tests.total}`}`,
      '',
      'Automated by cursor-auto-work orchestrator.',
    ].join('\n');

    try {
      return await commitAll(this.config, `${subject}\n${body}`);
    } catch (error) {
      log.error(`커밋 실패: ${(error as Error).message}`);
      return null;
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
