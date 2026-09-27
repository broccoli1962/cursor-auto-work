import { needsUnity, describeValidationMode } from './config';
import {
  collectDiff,
  commitAll,
  pushCurrentBranch,
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
  buildContinuedStepPrompt,
  buildStepPrompt,
  loadState,
  saveState,
} from './memoryManager';
import { Notifier } from './notifier';
import { clusterCommitFiles, filterSecretCommitFiles } from './projectCommit';
import {
  acceptPlannedRoadmap,
  applyProductReview,
  assessProductReview,
  autonomyBudgetSpent,
  buildPlanPrompt,
  buildPlaytestFollowUpPrompt,
  excerptRun,
  extractLessons,
  rememberLessons,
  buildPlaytestMatchPrompt,
  parsePlaytestMatch,
  resolveImplementResume,
  shouldRotateImplementSession,
  buildProductReviewPrompt,
  buildReviseSpecPrompt,
  captureDocs,
  decideAutonomyAction,
  formatBudget,
  isPlaceholderSpec,
  parseProductReview,
  readDoc,
  restoreDocs,
  writeDoc,
  writeRoadmapFile,
} from './autonomy';
import { capturePlaytest, shotShowsChange, type PlaytestShot } from './playtest';
import type { ProductReview, ReviewAssessment } from './autonomy';
import { loadRoadmap, RoadmapError } from './roadmap';
import {
  formatVerifyFeedback,
  requireChangesResult,
  resolveVerifyScope,
  runVerifyChecks,
  shouldRequireChanges,
} from './stepVerifier';
import type {
  AgentRunResult,
  AutonomyState,
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

export interface AutonomousRunOptions extends RunOptions {
  goal: string;
  maxCycles?: number;
  /** 첫 사이클에서 기획서와 로드맵을 다시 쓴다. 기존 문서만으로 검토할 때는 false */
  replan?: boolean;
}

type StepBatchResult = 'done' | 'empty' | 'needs_human' | 'paused';
type StepExhausted = 'human' | 'defer';

export class Orchestrator {
  private readonly config: OrchestratorConfig;

  private roadmap: Roadmap;

  private readonly state: OrchestratorState;

  private readonly notifier: Notifier;

  private gitAvailable = false;

  private stopRequested = false;

  private forceRerun = false;

  /** 이번 자율 사이클에서 실행한 Step. 조작 검증은 그중 기능 시나리오가 있는 Step 만 쓴다 */
  private lastCycleStepIds: number[] = [];

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

  needsHuman(): boolean {
    return this.state.status === 'needs_human';
  }

  async run(options: RunOptions = {}): Promise<void> {
    const startedAt = Date.now();
    await this.prepareRun(options);
    const result = await this.executeSteps(options, 'human');
    if (result === 'paused') {
      this.logUsage();
      return;
    }
    await this.finishClassic(result, startedAt);
  }

  /**
   * 주제를 받아 기획서를 쓰고, Step 을 개발하고, 결과를 검토한 뒤
   * 기획과 로드맵을 고치고 다시 개발한다.
   */
  async runAutonomous(options: AutonomousRunOptions): Promise<void> {
    const startedAt = Date.now();
    await this.prepareRun(options);
    const maxCycles = Math.max(1, options.maxCycles ?? this.config.autonomyMaxCycles);
    this.ensureAutonomy(options.goal, maxCycles, options.replan === true);
    const autonomy = this.state.autonomy;
    if (!autonomy) return;

    const last = autonomy.reviews[autonomy.reviews.length - 1];
    if (last?.verdict === 'done') {
      log.info('이 목표는 이미 달성했습니다. 다시 진행하려면 목표 문장을 바꾸거나 state.json 의 autonomy 를 지우세요.');
      return;
    }
    if (last?.verdict === 'blocked' && autonomy.cycle >= autonomy.maxCycles) {
      log.error(
        `자율 개발이 사이클 ${autonomy.cycle}/${autonomy.maxCycles} 에서 멈췄습니다. AUTONOMY_MAX_CYCLES 또는 --cycles 를 늘리거나 기획서를 직접 고친 뒤 다시 실행하세요.`,
      );
      this.state.status = 'needs_human';
      saveState(this.config, this.state);
      return;
    }

    log.info(
      `자율 개발 시작: ${autonomy.goal} (예산 ${formatBudget(this.config.autonomyBudgetMs)}, 최대 ${autonomy.maxCycles}사이클, 사이클당 Step ${this.config.autonomyStepsPerCycle}개, 화면 검증 ${this.config.playtest ? '활성' : '꺼짐'})`,
    );

    while (this.state.autonomy && this.state.autonomy.cycle <= this.state.autonomy.maxCycles) {
      if (autonomyBudgetSpent(startedAt, Date.now(), this.config.autonomyBudgetMs)) {
        this.pausePipeline(
          `자율 개발 시간 예산 ${formatBudget(this.config.autonomyBudgetMs)} 을 썼습니다. 같은 설정으로 run 하면 남은 계획에서 이어갑니다.`,
        );
        this.logUsage();
        return;
      }
      if (this.stopRequested) {
        this.pausePipeline('자율 사이클 시작 전 중단 요청');
        this.logUsage();
        return;
      }

      const cycle = this.state.autonomy.cycle;
      log.info(`자율 사이클 ${cycle}/${this.state.autonomy.maxCycles}`);
      await this.notifier.autonomyCycle(cycle, this.state.autonomy.maxCycles, this.state.autonomy.goal);

      if (!this.state.autonomy.planned) {
        const planned = await this.planFromGoal(this.state.autonomy.goal);
        if (this.stopRequested) {
          this.pausePipeline('기획 작성 중 중단 요청');
          this.logUsage();
          return;
        }
        if (!planned) {
          await this.blockAutonomy('기획서와 로드맵을 만들지 못했습니다.');
          return;
        }
        this.state.autonomy.planned = true;
        saveState(this.config, this.state);
      }

      const batch = await this.executeSteps(
        {
          fromStep: options.fromStep,
          toStep: options.toStep,
          forceRerun: options.forceRerun,
          maxSteps: this.config.autonomyStepsPerCycle,
        },
        'defer',
      );
      if (batch === 'paused') {
        this.logUsage();
        return;
      }

      let playtest = await this.lookAtGame(cycle);
      if (this.stopRequested) {
        this.pausePipeline('화면 검증 중 중단 요청');
        this.logUsage();
        return;
      }
      if (playtest?.input && playtest.expect) {
        const canFix = Boolean(this.state.autonomy.implementSessionId && this.config.autonomyResumeSession);
        const attempts = canFix ? this.config.playtestRetries : 1;
        playtest = { ...playtest, matched: false };
        for (let fix = 1; fix <= attempts; fix += 1) {
          const judged = await this.judgePlaytestExpect(playtest);
          if (this.stopRequested) {
            this.pausePipeline('기대 화면 판정 중 중단 요청');
            this.logUsage();
            return;
          }
          if (judged.match) {
            playtest = { ...playtest, matched: true };
            log.info(`Step ${playtest.stepId ?? '-'} 조작이 기대 화면과 맞습니다.`);
            break;
          }
          playtest = {
            ...playtest,
            matched: false,
            note: `${playtest.note}\n기대와 다름 (${fix}/${attempts}): ${judged.note}`,
          };
          if (!canFix) break;
          log.info(`기대 화면과 다릅니다. 구현 세션이 다시 고칩니다 (${fix}/${attempts}).`);
          const adjusted = await this.adjustPlaytestInSession(playtest);
          if (this.stopRequested) {
            this.pausePipeline('화면 확인 후 수정 중 중단 요청');
            this.logUsage();
            return;
          }
          if (!adjusted) break;
          const nextShot = await this.lookAtGame(cycle);
          if (this.stopRequested) {
            this.pausePipeline('조작을 다시 넣는 중 중단 요청');
            this.logUsage();
            return;
          }
          if (!nextShot) break;
          playtest = nextShot;
        }
      }

      const playtestFailed = Boolean(playtest?.input && playtest.expect && playtest.matched === false);
      if (playtest?.matched && playtest.stepId) this.clearPlaytestFailure(playtest.stepId);
      if (playtestFailed && playtest?.stepId) {
        this.reopenUnprovenStep(playtest.stepId, playtest.note);
        if (autonomyBudgetSpent(startedAt, Date.now(), this.config.autonomyBudgetMs)) {
          this.pausePipeline(
            `Step ${playtest.stepId} 기대 화면을 맞추기 전에 시간 예산이 끝났습니다. 다음 run 이 같은 Step 부터 이어갑니다.`,
          );
          this.logUsage();
          return;
        }
        log.info(`Step ${playtest.stepId} 기대 화면이 아니어서 같은 Step 을 계속합니다. expect 는 유지합니다.`);
        continue;
      }

      const assessed = await this.reviewProduct(
        this.state.autonomy.goal,
        batch === 'needs_human',
        playtest,
        playtestFailed,
      );
      if (this.stopRequested) {
        this.pausePipeline('제품 검토 중 중단 요청');
        this.logUsage();
        return;
      }
      if (!assessed) {
        await this.blockAutonomy('목표 대비 검토 결과를 받지 못했습니다.');
        return;
      }

      const action = decideAutonomyAction({
        verdict: assessed.review.verdict,
        hasWork: assessed.hasWork,
        unresolvedIssues: assessed.issues.length > 0,
        cycle,
        maxCycles: this.state.autonomy.maxCycles,
      });
      this.rememberReview(action === 'revise' ? 'revise' : action, assessed.review.summary);
      log.info(`사이클 ${cycle} 검토: ${action} — ${assessed.review.summary || '(요약 없음)'}`);
      await this.notifier.autonomyReview(cycle, action, assessed.review.summary);

      if (action === 'done') {
        await this.completeAutonomy(startedAt);
        return;
      }
      if (action === 'blocked') {
        await this.blockAutonomy(
          assessed.review.summary || assessed.issues.join('\n') || '자율 개발을 더 진행할 수 없습니다.',
        );
        return;
      }

      const applied = applyProductReview(this.roadmap, this.state.completedSteps, assessed.review);
      this.roadmap = applied.roadmap;
      this.state.completedSteps = applied.completedSteps;
      writeRoadmapFile(this.config.roadmapPath, applied.roadmap);
      saveState(this.config, this.state);
      log.info(
        `로드맵 수정: 다시 연 Step [${applied.reopened.join(', ') || '-'}], 고친 Step [${applied.updated.join(', ') || '-'}], 추가 [${applied.added.join(', ') || '-'}]`,
      );

      const revised = await this.reviseSpec(this.state.autonomy.goal, assessed.review);
      if (this.stopRequested) {
        this.pausePipeline('기획서 수정 중 중단 요청');
        this.logUsage();
        return;
      }
      if (!revised) {
        await this.blockAutonomy('검토 결과를 기획서에 반영하지 못했습니다.');
        return;
      }

      this.state.autonomy.cycle += 1;
      this.state.status = 'in_progress';
      saveState(this.config, this.state);
    }

    await this.blockAutonomy('자율 개발 사이클 한도에 도달했습니다.');
  }

  private async prepareRun(options: RunOptions): Promise<void> {
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
  }

  private async executeSteps(
    options: RunOptions & { maxSteps?: number },
    onExhausted: StepExhausted,
  ): Promise<StepBatchResult> {
    this.lastCycleStepIds = [];
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
      if (onExhausted === 'human' && this.isAllStepsCompleted()) {
        this.state.status = 'all_completed';
        this.state.currentStepId = null;
      }
      saveState(this.config, this.state);
      return 'empty';
    }

    const limit = options.maxSteps;
    log.info(
      limit
        ? `파이프라인 시작: ${this.roadmap.project} (이번 사이클 ${Math.min(limit, steps.length)}개 / 대기 ${steps.length}개)`
        : `파이프라인 시작: ${this.roadmap.project} (실행 대상 ${steps.length}개 / 전체 ${this.roadmap.steps.length}개)`,
    );

    let finished = 0;
    for (const step of steps) {
      this.lastCycleStepIds.push(step.id);
      if (this.stopRequested) {
        this.pausePipeline('Step 시작 전 중단 요청');
        return 'paused';
      }

      const succeeded = await this.runStep(step, onExhausted);
      if (!succeeded) {
        if (this.stopRequested) {
          this.pausePipeline(`Step ${step.id} 처리 중 중단 요청`);
          return 'paused';
        }
        if (onExhausted === 'human') {
          this.state.status = 'needs_human';
          saveState(this.config, this.state);
          log.error(`Step ${step.id} 에서 파이프라인이 중단되었습니다.`);
        } else {
          log.warn(`Step ${step.id} 가 검수를 넘기지 못했습니다. 기획 검토로 넘깁니다.`);
          saveState(this.config, this.state);
        }
        return 'needs_human';
      }
      finished += 1;
      if (limit !== undefined && finished >= limit) {
        log.info(`Step ${finished}개를 마쳤습니다. 계획과 화면을 다시 봅니다.`);
        return 'done';
      }
    }

    if (this.stopRequested) {
      this.pausePipeline('파이프라인 마지막 Step 완료 후 중단 요청');
      return 'paused';
    }

    return 'done';
  }

  private async finishClassic(result: StepBatchResult, startedAt: number): Promise<void> {
    this.logUsage();
    if (result === 'empty' || result === 'needs_human') return;

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
      return;
    }

    this.state.status = 'idle';
    saveState(this.config, this.state);
    log.info(
      `실행 범위 Step 완료 (${this.state.completedSteps.length}/${this.roadmap.steps.length} 전체 완료)`,
    );
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
  private async runStep(step: RoadmapStep, onExhausted: StepExhausted = 'human'): Promise<boolean> {
    const stepStartedAt = Date.now();
    const total = this.roadmap.steps.length;
    let feedback: string | undefined;

    this.state.currentStepId = step.id;
    this.state.status = 'in_progress';
    saveState(this.config, this.state);

    const baseline = await snapshotWorkingTree(this.config);
    let lastSessionId: string | undefined;
    let droppedResume = false;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.stopRequested) {
        log.warn(`Step ${step.id} — 중단 요청으로 재시도를 멈춥니다.`);
        return false;
      }

      this.state.attempts[String(step.id)] = attempt;
      saveState(this.config, this.state);

      await this.notifier.stepStart(step.id, total, step.title, step.task, attempt);

      const carrySession = onExhausted === 'defer' && this.config.autonomyResumeSession;
      if (carrySession && attempt === 1) {
        this.rotateImplementSessionIfNeeded();
        this.bumpImplementSessionSteps();
      }
      const resume = resolveImplementResume({
        carrySession,
        resumeOnRetry: this.config.resumeOnRetry,
        attempt,
        retrySessionId: lastSessionId,
        carriedSessionId: this.state.autonomy?.implementSessionId,
      });
      const promptArgs = {
        config: this.config,
        state: this.state,
        step,
        totalSteps: total,
        feedback,
        attempt,
      };
      const prompt = resume && attempt === 1 ? buildContinuedStepPrompt(promptArgs) : buildStepPrompt(promptArgs);
      if (resume && attempt === 1) log.info(`Step ${step.id} 구현 세션을 이어 갑니다.`);

      const agentResult = await this.runAgent(prompt, resume);
      lastSessionId = agentResult.sessionId ?? lastSessionId;
      if (carrySession) this.rememberImplementSession(lastSessionId);
      this.absorbLessons(agentResult.assistantText);
      this.recordUsage(agentResult.usage);

      if (agentResult.aborted || this.stopRequested) {
        appendMemory(this.state, buildStepMemory(step, agentResult, null, attempt));
        this.state.lastError = '사용자 중단 (Ctrl+C)';
        saveState(this.config, this.state);
        return false;
      }

      const emptyResume = Boolean(resume && agentResult.assistantText.trim().length === 0);
      if ((agentResult.exitCode !== 0 || agentResult.timedOut || emptyResume) && resume && !droppedResume) {
        droppedResume = true;
        log.warn('구현 세션을 열지 못했습니다. 기획서와 로드맵으로 새 세션을 엽니다.');
        lastSessionId = undefined;
        if (this.state.autonomy) delete this.state.autonomy.implementSessionId;
        saveState(this.config, this.state);
        attempt -= 1;
        continue;
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
      this.recordFact(`Step ${step.id} 검수 실패: ${feedback.split('\n')[0] ?? feedback}`);
      appendMemory(this.state, buildStepMemory(step, agentResult, report, attempt));
      this.state.lastError = feedback;
      saveState(this.config, this.state);

      if (attempt < this.config.maxRetries) {
        await this.notifier.stepRetry(step.id, attempt, this.config.maxRetries, feedback);
        log.warn(`Step ${step.id} 재시도 준비 (${attempt}/${this.config.maxRetries})`);
      }
    }

    const reason = feedback ?? '알 수 없는 사유로 검수를 통과하지 못했습니다.';
    if (onExhausted === 'human') {
      await this.notifier.humanNeeded(step.id, step.title, reason);
    }
    await this.rollbackFailedStep(step, baseline);
    return false;
  }

  private rotateImplementSessionIfNeeded(): void {
    const autonomy = this.state.autonomy;
    if (!autonomy?.implementSessionId) return;
    const used = autonomy.implementSessionSteps ?? 0;
    if (!shouldRotateImplementSession(used, this.config.autonomySessionSteps)) return;
    log.info(
      `구현 세션이 ${used} Step 을 지나 새 세션으로 넘어갑니다. 최근 검토 이유가 다음 프롬프트에 들어갑니다.`,
    );
    delete autonomy.implementSessionId;
    autonomy.implementSessionSteps = 0;
    saveState(this.config, this.state);
  }

  private rememberImplementSession(sessionId?: string): void {
    if (!sessionId || !this.state.autonomy || !this.config.autonomyResumeSession) return;
    if (this.state.autonomy.implementSessionId === sessionId) return;
    this.state.autonomy.implementSessionId = sessionId;
    saveState(this.config, this.state);
  }

  private recordFact(line: string): void {
    if (!this.state.autonomy) return;
    const trimmed = line.trim().slice(0, 240);
    if (!trimmed) return;
    this.state.autonomy.lessons = rememberLessons(this.state.autonomy.lessons ?? [], [trimmed]);
    saveState(this.config, this.state);
  }

  private absorbLessons(text: string): void {
    if (!this.state.autonomy) return;
    const found = extractLessons(text);
    const excerpt = excerptRun(text);
    if (excerpt) found.push(excerpt);
    if (found.length === 0) return;
    this.state.autonomy.lessons = rememberLessons(this.state.autonomy.lessons ?? [], found);
    saveState(this.config, this.state);
  }

  private bumpImplementSessionSteps(): void {
    const autonomy = this.state.autonomy;
    if (!autonomy) return;
    autonomy.implementSessionSteps = (autonomy.implementSessionSteps ?? 0) + 1;
    saveState(this.config, this.state);
  }

  private async judgePlaytestExpect(shot: PlaytestShot): Promise<{ match: boolean; note: string }> {
    if (shot.probeOk !== undefined) {
      return { match: shot.probeOk, note: shot.probeNote ?? '' };
    }
    if (!shot.expect) return { match: true, note: '' };
    if (shotShowsChange(shot) === false) {
      return {
        match: false,
        note: '입력 전·중·후 화면이 거의 같습니다. 위치, 높이, 착지처럼 기대가 말한 변화가 보이지 않습니다.',
      };
    }
    const result = await this.runAgent(buildPlaytestMatchPrompt(shot), undefined, {
      yolo: false,
      timeoutMs: this.config.judgeTimeoutMs,
    });
    this.recordUsage(result.usage);
    if (result.aborted || this.stopRequested) return { match: false, note: '판정 중단' };
    const parsed = parsePlaytestMatch(result.assistantText);
    if (!parsed) {
      return { match: false, note: '기대 화면 판정을 JSON 으로 읽지 못했습니다.' };
    }
    return parsed;
  }

  /** 화면을 본 구현 세션이 기능이나 그 Step 의 조작을 바로 고친다. 검토는 이 세션을 쓰지 않는다. */
  private async adjustPlaytestInSession(shot: PlaytestShot): Promise<boolean> {
    const sessionId = this.state.autonomy?.implementSessionId;
    if (!sessionId || !shot.input) return false;
    log.info(`Step ${shot.stepId ?? '-'} 화면을 구현 세션에 돌려주고 바로 수정합니다.`);
    const result = await this.runAgent(
      buildPlaytestFollowUpPrompt({ roadmapPath: this.config.roadmapPath, shot }),
      sessionId,
      { yolo: true },
    );
    this.rememberImplementSession(result.sessionId ?? sessionId);
    this.absorbLessons(result.assistantText);
    this.recordUsage(result.usage);
    if (result.aborted || this.stopRequested || result.exitCode !== 0 || result.timedOut) {
      log.warn('화면 확인 후 수정을 마치지 못했습니다. 방금 찍은 화면으로 검토합니다.');
      return false;
    }
    try {
      this.roadmap = loadRoadmap(this.config.roadmapPath);
    } catch (error) {
      if (error instanceof RoadmapError) {
        log.warn(`조작 수정 뒤 로드맵을 읽지 못했습니다: ${error.message}`);
      } else {
        throw error;
      }
    }
    return true;
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

  private async runAgent(
    prompt: string,
    resumeSessionId?: string,
    options?: { yolo?: boolean; timeoutMs?: number },
  ): Promise<AgentRunResult> {
    let streamed = 0;
    return runCursorAgent({
      prompt,
      config: this.config,
      resumeSessionId,
      signal: this.runAbort.signal,
      yolo: options?.yolo,
      timeoutMs: options?.timeoutMs,
      onText: (text) => {
        streamed += text.length;
        if (this.config.logLevel === 'debug') process.stdout.write(text);
      },
      onToolCall: (tool) => {
        if (tool.includes('unity')) log.info(`Unity CLI 호출: ${tool}`);
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
          : 'Unity CLI 컴파일 검사 중...',
      );
      compile = await runUnityCompile(this.config, this.runAbort.signal);

      if (compile.ok && this.shouldRunTests(step)) {
        await this.notifier.validating(
          step.id,
          this.config.unityValidationBackend === 'batch'
            ? 'Unity Batchmode EditMode 테스트 실행 중...'
            : 'Unity CLI EditMode 테스트 실행 중...',
        );
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

    const secrets = filterSecretCommitFiles(selected.files);
    if (secrets.skippedSecrets.length > 0) {
      log.warn(`시크릿이라 커밋에서 제외합니다: ${secrets.skippedSecrets.join(', ')}`);
    }
    if (secrets.files.length === 0) return noCommit;

    const clusters = clusterCommitFiles(secrets.files, step, this.config.commitLanguage);

    try {
      const hashes: string[] = [];
      for (const cluster of clusters) {
        const hash = await commitAll(this.config, cluster.subject, cluster.files);
        if (!hash) {
          return {
            hash: hashes[0] ?? null,
            failed: true,
            feedback:
              'Git 커밋에 실패했습니다. 커밋할 변경사항이 없거나 git add/commit 이 거부되었습니다. ' +
              '워킹 트리 상태와 git 설정을 확인하세요.',
          };
        }
        hashes.push(hash);
      }

      let pushNote = '';
      if (this.config.autoPush) {
        try {
          pushNote = await pushCurrentBranch(this.config);
        } catch (error) {
          const message = (error as Error).message;
          log.error(`푸시 실패: ${message}`);
          return {
            hash: hashes.join(', '),
            failed: true,
            feedback: `Git 푸시 실패:\n${message}`,
          };
        }
      }

      if (pushNote) log.info(`Step ${step.id} 커밋+푸시: ${hashes.join(', ')} (${pushNote})`);
      return { hash: hashes.join(', '), failed: false, feedback: '' };
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

  private ensureAutonomy(goal: string, maxCycles: number, replan: boolean): void {
    const previous = this.state.autonomy;
    if (!previous || previous.goal !== goal) {
      const fresh: AutonomyState = { goal, cycle: 1, maxCycles, planned: !replan, reviews: [] };
      this.state.autonomy = fresh;
      saveState(this.config, this.state);
      log.info(
        replan
          ? '새 목표로 기획서와 로드맵을 다시 작성합니다.'
          : '기존 기획서와 로드맵으로 개발한 뒤 검토합니다.',
      );
      return;
    }

    previous.maxCycles = maxCycles;
    if (previous.cycle < 1) previous.cycle = 1;
    saveState(this.config, this.state);
  }

  private rememberReview(verdict: 'done' | 'revise' | 'blocked', summary: string): void {
    const autonomy = this.state.autonomy;
    if (!autonomy) return;
    autonomy.reviews.push({
      cycle: autonomy.cycle,
      verdict,
      summary: summary.slice(0, 2000),
      at: new Date().toISOString(),
    });
    if (autonomy.reviews.length > 8) autonomy.reviews.splice(0, autonomy.reviews.length - 8);
    saveState(this.config, this.state);
  }

  private async blockAutonomy(reason: string): Promise<void> {
    this.state.status = 'needs_human';
    this.state.lastError = reason;
    saveState(this.config, this.state);
    this.logUsage();
    log.error(reason);
    await this.notifier.autonomyBlocked(this.state.autonomy?.cycle ?? 0, reason);
  }

  private async completeAutonomy(startedAt: number): Promise<void> {
    const goal = this.state.autonomy?.goal ?? '';
    const summary = this.state.autonomy?.reviews[this.state.autonomy.reviews.length - 1]?.summary ?? '';
    this.state.currentStepId = null;
    this.state.status = this.isAllStepsCompleted() ? 'all_completed' : 'idle';
    delete this.state.lastError;
    saveState(this.config, this.state);
    this.logUsage();
    log.info(`자율 개발 목표를 달성했습니다: ${goal}`);
    if (!this.isAllStepsCompleted()) {
      log.info('로드맵에 남은 Step 이 있습니다. goal 없이 run 을 실행하면 그 Step 을 이어서 개발합니다.');
    }
    await this.notifier.autonomyDone(
      goal,
      summary,
      this.state.completedSteps.length,
      this.roadmap.steps.length,
      Date.now() - startedAt,
    );
  }

  private async planFromGoal(goal: string): Promise<boolean> {
    const snapshot = captureDocs(this.config.specPath, this.config.roadmapPath);
    let feedback = '';

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.stopRequested) return false;
      if (attempt > 1) restoreDocs(this.config.specPath, this.config.roadmapPath, snapshot);

      log.info(`기획 작성 ${attempt}/${this.config.maxRetries}`);
      const result = await this.runAgent(
        buildPlanPrompt({ config: this.config, state: this.state, goal, feedback: feedback || undefined }),
        undefined,
        { yolo: true },
      );
      this.recordUsage(result.usage);
      if (result.aborted || this.stopRequested) {
        restoreDocs(this.config.specPath, this.config.roadmapPath, snapshot);
        return false;
      }
      if (result.exitCode !== 0 || result.timedOut) {
        feedback = this.describeAgentFailure(result);
        continue;
      }

      const accepted = acceptPlannedRoadmap({
        roadmapPath: this.config.roadmapPath,
        previous: this.roadmap,
        completedIds: this.state.completedSteps,
      });
      if (!accepted.ok) {
        feedback = accepted.reason;
        log.warn(feedback);
        continue;
      }

      const spec = readDoc(this.config.specPath);
      if (isPlaceholderSpec(spec)) {
        feedback = '기획서가 자리표시자이거나 너무 짧습니다. 플레이와 완료 기준을 채워 다시 쓰세요.';
        log.warn(feedback);
        continue;
      }

      writeRoadmapFile(this.config.roadmapPath, accepted.roadmap);
      this.roadmap = accepted.roadmap;
      log.info(`기획 반영: Step ${accepted.roadmap.steps.length}개`);
      return true;
    }

    restoreDocs(this.config.specPath, this.config.roadmapPath, snapshot);
    return false;
  }

  private async reviseSpec(goal: string, review: ProductReview): Promise<boolean> {
    const structural =
      review.specEdits.length > 0 ||
      review.addSteps.length > 0 ||
      review.reopenStepIds.length > 0 ||
      review.updateSteps.length > 0;
    if (!structural) return true;

    const specBefore = readDoc(this.config.specPath);
    let feedback = '';

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.stopRequested) return false;
      if (attempt > 1) {
        writeDoc(this.config.specPath, specBefore);
        writeRoadmapFile(this.config.roadmapPath, this.roadmap);
      }

      log.info(`기획서 수정 ${attempt}/${this.config.maxRetries}`);
      const result = await this.runAgent(
        buildReviseSpecPrompt({
          config: this.config,
          goal,
          review,
          roadmap: this.roadmap,
          completedIds: this.state.completedSteps,
          feedback: feedback || undefined,
        }),
        undefined,
        { yolo: true },
      );
      this.recordUsage(result.usage);
      writeRoadmapFile(this.config.roadmapPath, this.roadmap);
      if (result.aborted || this.stopRequested) return false;
      if (result.exitCode !== 0 || result.timedOut) {
        feedback = this.describeAgentFailure(result);
        continue;
      }

      const spec = readDoc(this.config.specPath);
      if (isPlaceholderSpec(spec)) {
        feedback = '기획서가 비었거나 자리표시자가 남아 있습니다.';
        log.warn(feedback);
        continue;
      }
      if (spec.trim() === specBefore.trim()) {
        feedback = '기획서 파일이 바뀌지 않았습니다. 검토에서 요구한 내용을 반영하세요.';
        log.warn(feedback);
        continue;
      }
      log.info('기획서를 검토 결과에 맞게 고쳤습니다.');
      return true;
    }

    writeDoc(this.config.specPath, specBefore);
    writeRoadmapFile(this.config.roadmapPath, this.roadmap);
    return false;
  }

  private async lookAtGame(cycle: number): Promise<PlaytestShot | undefined> {
    if (!this.config.playtest) return undefined;
    if (!needsUnity(this.config) || this.config.unityValidationBackend !== 'cli') {
      log.info('화면 검증은 compile/full 과 Unity CLI 채널에서만 실행합니다.');
      return undefined;
    }
    const step = this.stepForPlaytest();
    const script = step?.playtest?.input ?? 'none';
    log.info(
      step?.playtest
        ? `Step ${step.id} 기능 검증: ${step.playtest.input} → ${step.playtest.expect}`
        : '이번 Step 에는 조작 검증이 없어 키와 마우스를 넣지 않습니다.',
    );
    try {
      const shot = await capturePlaytest(this.config, cycle, this.runAbort.signal, script, step?.playtest?.probe);
      return {
        ...shot,
        stepId: step?.id,
        stepTitle: step?.title,
        input: step?.playtest?.input,
        expect: step?.playtest?.expect,
      };
    } catch (error) {
      if (this.stopRequested) return undefined;
      const note = `화면 검증 실패: ${(error as Error).message}`;
      log.warn(note);
      return { ok: false, note, probeOk: false, probeNote: note };
    }
  }

  private stepForPlaytest(): RoadmapStep | undefined {
    const ids = this.lastCycleStepIds;
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const step = this.roadmap.steps.find((item) => item.id === ids[index]);
      if (step?.playtest?.input) return step;
    }
    const last = ids[ids.length - 1];
    return this.roadmap.steps.find((item) => item.id === last);
  }

  private reopenUnprovenStep(stepId: number, reason: string): void {
    this.state.completedSteps = this.state.completedSteps.filter((id) => id !== stepId);
    const failure = reason.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 500);
    this.state.lastError = failure;
    const step = this.roadmap.steps.find((item) => item.id === stepId);
    if (step?.playtest) {
      const history = [...(step.playtest.history ?? []), failure].slice(-8);
      step.playtest = { ...step.playtest, failure, history };
      writeRoadmapFile(this.config.roadmapPath, this.roadmap);
    }
    saveState(this.config, this.state);
    this.recordFact(`Step ${stepId} 측정 실패: ${failure}`);
    log.warn(`Step ${stepId} 조작 검증이 기대와 달라 완료를 취소했습니다.`);
  }

  private clearPlaytestFailure(stepId: number): void {
    const step = this.roadmap.steps.find((item) => item.id === stepId);
    if (!step?.playtest?.failure) return;
    step.playtest = { ...step.playtest, failure: undefined };
    writeRoadmapFile(this.config.roadmapPath, this.roadmap);
  }

  private async reviewProduct(
    goal: string,
    buildFailed: boolean,
    playtest?: PlaytestShot,
    playtestFailed = false,
  ): Promise<ReviewAssessment | null> {
    let feedback = '';
    let last: ReviewAssessment | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.stopRequested) return null;
      log.info(`목표 검토 ${attempt}/${this.config.maxRetries}`);
      const result = await this.runAgent(
        buildProductReviewPrompt({
          config: this.config,
          state: this.state,
          goal,
          buildFailed,
          feedback: feedback || undefined,
          playtest,
        }),
        undefined,
        { yolo: false, timeoutMs: this.config.autonomyReviewTimeoutMs },
      );
      this.recordUsage(result.usage);
      if (result.aborted || this.stopRequested) return null;
      if (result.exitCode !== 0 || result.timedOut) {
        feedback = this.describeAgentFailure(result);
        continue;
      }

      const parsed = parseProductReview(result.assistantText);
      if (!parsed) {
        const tail = result.assistantText.trim().slice(-500);
        feedback = '검토 결과를 JSON 으로 해석하지 못했습니다. verdict 와 summary 를 포함한 JSON 만 출력하세요.';
        if (tail) feedback += `\n출력 끝:\n${tail}`;
        log.warn(feedback.split('\n')[0] ?? feedback);
        continue;
      }

      last = assessProductReview(parsed, this.roadmap, this.state.completedSteps, buildFailed, playtestFailed);
      if (last.issues.length > 0 && attempt < this.config.maxRetries) {
        feedback = last.issues.join('\n');
        log.warn(feedback);
        continue;
      }
      return last;
    }

    return last;
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
