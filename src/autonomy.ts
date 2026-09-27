import fs from 'node:fs';
import path from 'node:path';

import { collectCursorRules } from './cursorRunner';
import { parsePlaytestInput } from './playtest';
import { parseProbe } from './playtestProbe';
import { loadRoadmap } from './roadmap';
import { budgetText } from './textBudget';
import type {
  AutonomyVerdict,
  OrchestratorConfig,
  OrchestratorState,
  Roadmap,
  RoadmapStep,
  StepPlaytest,
} from './types';

/** 시드 문서와 모델이 남긴 자리표시자를 구분하는 표식 */
export const AUTONOMY_PLACEHOLDER = 'autonomy-placeholder';

const MAX_ADD_STEPS = 8;
const MAX_SPEC_EDITS = 8;
const MAX_SUMMARY = 2000;

export interface ReviewStepDraft {
  title: string;
  task: string;
  acceptanceCriteria?: string[];
  targetFiles?: string[];
  runTests?: boolean;
  playtest?: StepPlaytest;
}

export interface ReviewStepPatch extends ReviewStepDraft {
  id: number;
}

export interface ProductReview {
  verdict: AutonomyVerdict;
  summary: string;
  specEdits: string[];
  reopenStepIds: number[];
  updateSteps: ReviewStepPatch[];
  addSteps: ReviewStepDraft[];
}

export interface ReviewAssessment {
  review: ProductReview;
  /** 검토를 한 번 더 시켜야 하는 형식/내용 문제 */
  issues: string[];
  hasWork: boolean;
}

export interface AppliedReview {
  roadmap: Roadmap;
  completedSteps: number[];
  reopened: number[];
  added: number[];
  updated: number[];
}

export interface DocSnapshot {
  spec: string | null;
  roadmap: string | null;
}

export type AutonomyAction = 'done' | 'revise' | 'blocked';

/** GOAL 을 비웠을 때 쓰는 목표. 기획서 본문은 넣지 않아 사이클마다 문장이 바뀌지 않는다. */
export function implicitGoal(projectName: string): string {
  const name = projectName.trim() || '프로젝트';
  return `${name} 의 기획서(docs/spec.md)를 만족할 때까지 개발한다. 구현이 기획과 어긋나거나 기획이 부족하면 기획서를 고치고 다시 개발한다.`;
}

export function docsReadyForAutonomy(specText: string, roadmap: Roadmap | null): boolean {
  if (!roadmap || roadmap.steps.length === 0) return false;
  if (roadmap.steps.every((step) => isPlaceholderStep(step))) return false;
  return !isPlaceholderSpec(specText);
}

/**
 * 자율 사이클은 기본으로 켜져 있다.
 * 주제(CLI, GOAL, 주제 파일)가 있으면 첫 사이클에서 기획을 다시 쓴다.
 * 주제가 없고 기획서·로드맵이 이미 있으면 그 문서를 유지한 채 개발 후 검토만 한다.
 */
export function resolveAutonomyGoal(args: {
  enabled: boolean;
  configuredGoal: string;
  fileGoal: string;
  projectName: string;
  docsReady: boolean;
}): { enabled: boolean; goal: string; replan: boolean } {
  if (!args.enabled) return { enabled: false, goal: '', replan: false };
  const configured = args.configuredGoal.trim();
  if (configured) return { enabled: true, goal: configured, replan: true };
  const fileGoal = args.fileGoal.trim();
  if (fileGoal) return { enabled: true, goal: fileGoal, replan: true };
  return { enabled: true, goal: implicitGoal(args.projectName), replan: !args.docsReady };
}

export function isPlaceholderStep(step: RoadmapStep): boolean {
  return step.task.includes(AUTONOMY_PLACEHOLDER);
}

export function isPlaceholderSpec(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 80 || trimmed.includes(AUTONOMY_PLACEHOLDER);
}

function asStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    items.push(trimmed.slice(0, 500));
    if (items.length >= limit) break;
  }
  return items;
}

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const item of value) {
    const id = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(id) || id < 1) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function asStepDraft(value: unknown): ReviewStepDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.task !== 'string' || rec.task.trim() === '') return null;
  const draft: ReviewStepDraft = {
    title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim().slice(0, 120) : '추가 작업',
    task: rec.task.trim(),
  };
  const criteria = asStringList(rec.acceptanceCriteria, 8);
  const targets = asStringList(rec.targetFiles, 8);
  if (criteria.length > 0) draft.acceptanceCriteria = criteria;
  if (targets.length > 0) draft.targetFiles = targets;
  if (typeof rec.runTests === 'boolean') draft.runTests = rec.runTests;
  const playtest = asStepPlaytest(rec.playtest);
  if (playtest) draft.playtest = playtest;
  return draft;
}

function asStepPlaytest(value: unknown): StepPlaytest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const input = typeof rec.input === 'string' ? rec.input.trim() : '';
  const expect = typeof rec.expect === 'string' ? rec.expect.trim().slice(0, 400) : '';
  if (!input || !expect) return undefined;
  const parsed = parsePlaytestInput(input);
  if (parsed.disabled || parsed.actions.length === 0) return undefined;
  return { input, expect, probe: parseProbe(rec.probe) };
}

function parseVerdict(value: unknown): AutonomyVerdict | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'done' || normalized === 'revise' || normalized === 'blocked') return normalized;
  return null;
}

/** 검토 Agent 출력에서 제품 판정 JSON 을 꺼낸다. 형식이 아니면 null. */
export function parseProductReview(text: string): ProductReview | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const blobs: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) blobs.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) blobs.push(trimmed.slice(start, end + 1));

  for (const blob of blobs) {
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      const verdict = parseVerdict(parsed.verdict);
      if (!verdict) continue;
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, MAX_SUMMARY) : '';
      const updateSteps: ReviewStepPatch[] = [];
      if (Array.isArray(parsed.updateSteps)) {
        for (const item of parsed.updateSteps) {
          const draft = asStepDraft(item);
          if (!draft || !item || typeof item !== 'object') continue;
          const id = (item as Record<string, unknown>).id;
          const stepId = typeof id === 'number' ? id : Number(id);
          if (!Number.isInteger(stepId) || stepId < 1) continue;
          updateSteps.push({ ...draft, id: stepId });
        }
      }
      const addSteps: ReviewStepDraft[] = [];
      if (Array.isArray(parsed.addSteps)) {
        for (const item of parsed.addSteps) {
          const draft = asStepDraft(item);
          if (!draft) continue;
          addSteps.push(draft);
          if (addSteps.length >= MAX_ADD_STEPS) break;
        }
      }
      return {
        verdict,
        summary,
        specEdits: asStringList(parsed.specEdits, MAX_SPEC_EDITS),
        reopenStepIds: asIdList(parsed.reopenStepIds),
        updateSteps,
        addSteps,
      };
    } catch {
      // 다음 후보
    }
  }
  return null;
}

function listsEqual(left?: string[], right?: string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function patchChangesStep(step: RoadmapStep, patch: ReviewStepPatch): boolean {
  if (patch.title !== step.title) return true;
  if (patch.task !== step.task) return true;
  if (patch.acceptanceCriteria && !listsEqual(patch.acceptanceCriteria, step.acceptanceCriteria)) return true;
  if (patch.targetFiles && !listsEqual(patch.targetFiles, step.targetFiles)) return true;
  if (patch.runTests !== undefined && patch.runTests !== step.runTests) return true;
  if (patch.playtest) {
    if (patch.playtest.input !== step.playtest?.input || patch.playtest.expect !== step.playtest?.expect) return true;
  }
  return false;
}

/**
 * 검토 JSON 을 현재 로드맵에 맞춰 정리한다.
 * Step 검수가 실패한 사이클은 done 으로 끝내지 않는다.
 */
export function assessProductReview(
  review: ProductReview,
  roadmap: Roadmap,
  completedSteps: number[],
  buildFailed: boolean,
  playtestFailed = false,
): ReviewAssessment {
  const known = new Set(roadmap.steps.map((step) => step.id));
  const completed = new Set(completedSteps);
  const issues: string[] = [];

  const reopenStepIds = review.reopenStepIds.filter((id) => known.has(id) && completed.has(id));
  const updateSteps = review.updateSteps.filter((patch) => {
    const step = roadmap.steps.find((item) => item.id === patch.id);
    return step ? patchChangesStep(step, patch) : false;
  });
  const addSteps = review.addSteps.slice(0, MAX_ADD_STEPS);

  let verdict = review.verdict;
  let summary = review.summary;
  if ((buildFailed || playtestFailed) && verdict === 'done') {
    verdict = 'revise';
    summary = playtestFailed
      ? `조작 검증이 기대 화면과 달라 목표 달성을 보류합니다. ${summary}`.trim()
      : `Step 검수를 통과하지 못해 목표 달성을 보류합니다. ${summary}`.trim();
  }

  const normalized: ProductReview = {
    verdict,
    summary,
    specEdits: review.specEdits,
    reopenStepIds,
    updateSteps,
    addSteps,
  };
  const hasWork = revisionHasWork(normalized, roadmap, completedSteps);
  if (verdict === 'revise' && !hasWork) {
    issues.push(
      'revise 인데 고칠 개발이 없습니다. 끝난 Step 을 reopenStepIds 로 다시 열거나 addSteps 로 새 Step 을 넣으세요.',
    );
  }
  if (verdict !== 'done' && !summary) {
    issues.push('summary 가 비어 있습니다. 목표와 현재 구현의 차이를 한 단락으로 적으세요.');
  }

  return { review: normalized, issues, hasWork };
}

export function revisionHasWork(review: ProductReview, roadmap: Roadmap, completedSteps: number[]): boolean {
  if (review.addSteps.length > 0) return true;
  if (review.reopenStepIds.length > 0) return true;
  if (review.updateSteps.length > 0) return true;
  return roadmap.steps.some((step) => !completedSteps.includes(step.id));
}

/** 시간 예산을 다 썼으면 true. 같은 run 을 다시 실행하면 남은 계획에서 이어간다. */
export function autonomyBudgetSpent(startedAt: number, now: number, budgetMs: number): boolean {
  return now - startedAt >= budgetMs;
}

export function formatBudget(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes}분`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}시간`;
}

/**
 * 구현 세션을 고른다.
 * 같은 Step 재시도는 그 시도의 세션을 잇고, 자율 개발의 첫 시도는 이전 Step 세션을 잇는다.
 * 검토·기획 세션은 이 함수를 쓰지 않는다.
 */
export function resolveImplementResume(args: {
  carrySession: boolean;
  resumeOnRetry: boolean;
  attempt: number;
  retrySessionId?: string;
  carriedSessionId?: string;
}): string | undefined {
  if (args.attempt > 1 && args.resumeOnRetry && args.retrySessionId) return args.retrySessionId;
  if (args.attempt === 1 && args.carrySession && args.carriedSessionId) return args.carriedSessionId;
  return undefined;
}

/** 구현 세션이 이 횟수 이상이면 앞부분이 밀리기 전에 세션만 새로 연다. */
export function shouldRotateImplementSession(steps: number, limit: number): boolean {
  return limit > 0 && steps >= limit;
}

export function formatPlanAuthority(
  reviews: { cycle: number; verdict: string; summary: string }[],
  lessons: string[] = [],
): string {
  const lines = [
    '# [PLAN ON DISK] 디스크의 기획서와 로드맵이 이전 대화보다 우선이다',
    '대화에서 정했던 조작이나 설계와 파일이 충돌하면 docs/spec.md 와 docs/roadmap.json 을 따른다.',
    '이미 적힌 playtest.expect 는 더 느슨하게 바꾸지 마라.',
  ];
  const recent = reviews.slice(-3);
  if (recent.length === 0) {
    lines.push('아직 검토로 계획이 바뀐 기록은 없다.');
  } else {
    lines.push('최근 검토가 계획을 바꾼 이유:');
    for (const review of recent) {
      lines.push(`- 사이클 ${review.cycle} ${review.verdict}: ${review.summary}`);
    }
  }
  const kept = lessons.slice(-8);
  if (kept.length > 0) {
    lines.push('구현 중 실패한 시도와 버린 접근 (반복하지 말 것):');
    for (const lesson of kept) lines.push(`- ${lesson}`);
  }
  return lines.join('\n');
}

/** 구현 출력이 남긴 LESSON 줄을 모은다. */
export function extractLessons(text: string): string[] {
  const lessons: string[] = [];
  for (const hit of text.matchAll(/^LESSON:\s*(.+)$/gim)) {
    const value = hit[1]?.trim();
    if (value) lessons.push(value.slice(0, 240));
  }
  return lessons;
}

/** LESSON 줄이 없어도 구현 출력의 끝을 남긴다. */
export function excerptRun(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 40) return undefined;
  return `구현 메모: ${trimmed.slice(-200)}`;
}

export function rememberLessons(existing: string[], added: string[], max = 12): string[] {
  const next = [...existing];
  for (const item of added) {
    if (!next.includes(item)) next.push(item);
  }
  return next.slice(-max);
}

/** 이미 있는 Step 의 expect 는 유지한다. 검토가 기준을 낮추지 못하게 한다. */
export function preservePlaytestExpect(previous: Roadmap, next: Roadmap): Roadmap {
  const prior = new Map(previous.steps.map((step) => [step.id, step]));
  return {
    ...next,
    steps: next.steps.map((step) => {
      const old = prior.get(step.id)?.playtest;
      if (!old?.expect) return step;
      const playtest = step.playtest ?? { ...old };
      return {
        ...step,
        playtest: {
          ...playtest,
          expect: old.expect,
          probe: old.probe ?? playtest.probe,
          history: playtest.history ?? old.history,
          failure: playtest.failure ?? old.failure,
        },
      };
    }),
  };
}

export function parsePlaytestMatch(text: string): { match: boolean; note: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const blobs: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) blobs.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) blobs.push(trimmed.slice(start, end + 1));
  for (const blob of blobs) {
    try {
      const parsed = JSON.parse(blob) as { match?: unknown; changed?: unknown; note?: unknown; phases?: unknown };
      if (typeof parsed.match !== 'boolean') continue;
      const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
      const phases = Array.isArray(parsed.phases)
        ? parsed.phases.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
        : [];
      if (parsed.match === true && parsed.changed === false) {
        return { match: false, note: note || '화면 변화가 없어 기능이 동작한 것으로 보지 않습니다.' };
      }
      if (parsed.match === true) {
        const distinct = new Set(phases.map((item) => item.toLowerCase().replace(/\s+/g, '')));
        if (phases.length < 3 || distinct.size < 3) {
          return {
            match: false,
            note: note || '전·중·후 관찰이 서로 달라야 합니다. 한 장면이 기대와 비슷하다는 이유만으로 통과하지 않습니다.',
          };
        }
      }
      return { match: parsed.match, note };
    } catch {
      // 다음 후보
    }
  }
  return null;
}

export function buildPlaytestMatchPrompt(shot: {
  input?: string;
  expect?: string;
  beforePath?: string;
  midPath?: string;
  afterPath?: string;
  imagePath?: string;
  note: string;
}): string {
  const images = [shot.beforePath, shot.midPath, shot.afterPath, shot.imagePath].filter(
    (item, index, list): item is string => Boolean(item) && list.indexOf(item) === index,
  );
  return [
    '# [PLAYTEST MATCH] 기대 화면만 판정',
    '파일을 수정하지 마라. 셸과 Unity CLI 를 호출하지 마라.',
    '입력 후 화면이 기대 문장과 맞으면 match true 다. 빈 화면, 다른 동작, 입력이 안 먹은 장면은 false 다.',
    shot.input ? `조작: ${shot.input}` : '조작 없음',
    'before, mid, after 세 장을 순서대로 봐라. 한 장만 기대와 비슷하다고 match true 를 내지 마라.',
    '기대가 움직임이면 중간과 마지막이 달라야 한다. 세 장이 거의 같으면 match false, changed false.',
    'changed 는 화면에 보이는 변화가 있을 때만 true.',
    shot.expect ? `기대: ${shot.expect}` : '기대 문장 없음',
    `캡처 메모: ${shot.note}`,
    images.length > 0 ? `이미지를 읽어라:\n${images.map((item) => `- ${item}`).join('\n')}` : '이미지 없음',
    '마지막에 JSON 만 출력하라.',
    'phases 는 기대 문장을 베끼지 말고, 각 장면에서 실제로 보인 위치·자세·숫자만 적어라.',
    '{ "match": false, "changed": true, "phases": ["입력 전 관찰", "중간 관찰", "입력 후 관찰"], "note": "세 장면의 차이와 기대의 불일치" }',
  ].join('\n');
}

export function decideAutonomyAction(args: {
  verdict: AutonomyVerdict;
  hasWork: boolean;
  unresolvedIssues: boolean;
  cycle: number;
  maxCycles: number;
}): AutonomyAction {
  if (args.verdict === 'blocked') return 'blocked';
  if (args.verdict === 'done' && !args.unresolvedIssues) return 'done';
  if (args.cycle >= args.maxCycles) return 'blocked';
  if (args.hasWork && (args.verdict === 'revise' || args.unresolvedIssues)) return 'revise';
  return 'blocked';
}

function cloneStep(step: RoadmapStep): RoadmapStep {
  return {
    ...step,
    acceptanceCriteria: step.acceptanceCriteria ? [...step.acceptanceCriteria] : undefined,
    targetFiles: step.targetFiles ? [...step.targetFiles] : undefined,
    playtest: step.playtest
      ? { ...step.playtest, history: step.playtest.history ? [...step.playtest.history] : undefined }
      : undefined,
    verify: step.verify
      ? { ...step.verify, checks: step.verify.checks ? step.verify.checks.map((check) => ({ ...check })) : undefined }
      : undefined,
  };
}

function applyPatch(step: RoadmapStep, patch: ReviewStepPatch): RoadmapStep {
  return {
    ...cloneStep(step),
    title: patch.title || step.title,
    task: patch.task,
    acceptanceCriteria: patch.acceptanceCriteria ?? step.acceptanceCriteria,
    targetFiles: patch.targetFiles ?? step.targetFiles,
    runTests: patch.runTests ?? step.runTests,
    playtest: patch.playtest ?? step.playtest,
  };
}

/** 검토가 고친 Step 만 반영한다. 완료 Step 의 지시가 바뀌면 다시 연다. */
export function applyProductReview(roadmap: Roadmap, completedSteps: number[], review: ProductReview): AppliedReview {
  const completed = new Set(completedSteps);
  const reopened = new Set<number>(review.reopenStepIds.filter((id) => completed.has(id)));
  const updated: number[] = [];
  const steps = roadmap.steps.map((step) => cloneStep(step));

  for (const patch of review.updateSteps) {
    const index = steps.findIndex((step) => step.id === patch.id);
    const current = steps[index];
    if (!current || !patchChangesStep(current, patch)) continue;
    steps[index] = applyPatch(current, patch);
    updated.push(patch.id);
    if (completed.has(patch.id)) reopened.add(patch.id);
  }

  let nextId = steps.reduce((max, step) => Math.max(max, step.id), 0);
  const added: number[] = [];
  for (const draft of review.addSteps) {
    nextId += 1;
    steps.push({
      id: nextId,
      title: draft.title,
      task: draft.task,
      acceptanceCriteria: draft.acceptanceCriteria,
      targetFiles: draft.targetFiles,
      runTests: draft.runTests,
      playtest: draft.playtest,
    });
    added.push(nextId);
  }

  steps.sort((a, b) => a.id - b.id);
  const nextCompleted = completedSteps.filter((id) => steps.some((step) => step.id === id) && !reopened.has(id));

  const locked = preservePlaytestExpect(roadmap, { project: roadmap.project, description: roadmap.description, steps });
  return {
    roadmap: locked,
    completedSteps: nextCompleted,
    reopened: [...reopened].sort((a, b) => a - b),
    added,
    updated,
  };
}

/**
 * 기획 Agent 가 로드맵을 다시 써도, 이미 완료된 Step 본문은 유지한다.
 * 새 작업은 완료 id 와 겹치지 않는 항목만 받는다.
 */
export function mergePlannedRoadmap(previous: Roadmap, next: Roadmap, completedIds: number[]): Roadmap {
  const completed = new Set(completedIds);
  const kept = previous.steps.filter((step) => completed.has(step.id)).map((step) => cloneStep(step));
  const keptIds = new Set(kept.map((step) => step.id));
  const fromNext = next.steps.filter((step) => !keptIds.has(step.id)).map((step) => cloneStep(step));
  let steps = [...kept, ...fromNext].sort((a, b) => a.id - b.id);
  const real = steps.filter((step) => !isPlaceholderStep(step));
  if (real.length > 0) steps = real;
  if (steps.length === 0) steps = previous.steps.map((step) => cloneStep(step));
  return preservePlaytestExpect(previous, {
    project: next.project || previous.project,
    description: next.description ?? previous.description,
    steps,
  });
}

export function incompleteStepCount(roadmap: Roadmap, completedIds: number[]): number {
  const done = new Set(completedIds);
  return roadmap.steps.filter((step) => !done.has(step.id) && !isPlaceholderStep(step)).length;
}

export function ensureGoalDocs(args: {
  specPath: string;
  roadmapPath: string;
  goal: string;
  projectName: string;
}): void {
  fs.mkdirSync(path.dirname(args.specPath), { recursive: true });
  fs.mkdirSync(path.dirname(args.roadmapPath), { recursive: true });

  if (!fs.existsSync(args.specPath)) {
    const spec = [
      `<!-- ${AUTONOMY_PLACEHOLDER} -->`,
      '# 프로젝트 기획서',
      '',
      `목표: ${args.goal}`,
      '',
      '이 문서는 자리표시자입니다. 기획 단계에서 목표에 맞게 다시 작성합니다.',
      '',
    ].join('\n');
    fs.writeFileSync(args.specPath, spec, 'utf8');
  }

  if (!fs.existsSync(args.roadmapPath)) {
    const roadmap: Roadmap = {
      project: args.projectName,
      description: args.goal,
      steps: [
        {
          id: 1,
          title: '목표에 맞는 최소 구조',
          task: `${AUTONOMY_PLACEHOLDER} 목표를 구현하기 위한 자리표시자 Step 입니다. 기획 단계가 이 로드맵을 실제 작업으로 바꿉니다. 목표: ${args.goal}`,
          acceptanceCriteria: ['docs/spec.md 가 목표의 플레이와 완료 기준을 설명한다'],
          targetFiles: ['docs'],
        },
      ],
    };
    writeRoadmapFile(args.roadmapPath, roadmap);
  }
}

export function writeRoadmapFile(roadmapPath: string, roadmap: Roadmap): void {
  fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
  fs.writeFileSync(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`, 'utf8');
}

export function captureDocs(specPath: string, roadmapPath: string): DocSnapshot {
  return {
    spec: fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null,
    roadmap: fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf8') : null,
  };
}

export function restoreDocs(specPath: string, roadmapPath: string, snapshot: DocSnapshot): void {
  if (snapshot.spec === null) {
    if (fs.existsSync(specPath)) fs.rmSync(specPath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, snapshot.spec, 'utf8');
  }
  if (snapshot.roadmap === null) {
    if (fs.existsSync(roadmapPath)) fs.rmSync(roadmapPath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
    fs.writeFileSync(roadmapPath, snapshot.roadmap, 'utf8');
  }
}

export function readDoc(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

export function writeDoc(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** 기획 Agent 가 쓴 로드맵을 읽고, 완료 Step 을 보존한 결과를 돌려준다. 실패 사유가 있으면 ok=false. */
export function acceptPlannedRoadmap(args: {
  roadmapPath: string;
  previous: Roadmap;
  completedIds: number[];
}): { ok: true; roadmap: Roadmap } | { ok: false; reason: string } {
  let next: Roadmap;
  try {
    next = loadRoadmap(args.roadmapPath);
  } catch (error) {
    return { ok: false, reason: `roadmap.json 을 읽지 못했습니다: ${(error as Error).message}` };
  }

  const merged = mergePlannedRoadmap(args.previous, next, args.completedIds);
  if (merged.steps.every((step) => isPlaceholderStep(step))) {
    return { ok: false, reason: '로드맵이 자리표시자 Step 만 있습니다. 구현 가능한 Step 으로 다시 작성하세요.' };
  }
  if (incompleteStepCount(merged, args.completedIds) === 0) {
    return {
      ok: false,
      reason: '완료되지 않은 Step 이 없습니다. 이미 끝난 id 는 유지하고, 더 큰 id 로 새 Step 을 추가하세요.',
    };
  }
  return { ok: true, roadmap: merged };
}

function formatSteps(roadmap: Roadmap, completedIds: number[]): string {
  const done = new Set(completedIds);
  return roadmap.steps
    .map((step) => {
      const mark = done.has(step.id) ? '완료' : '미완';
      const criteria = step.acceptanceCriteria?.map((item) => `  - ${item}`).join('\n') ?? '  - (없음)';
      const play = step.playtest
        ? [
            `조작 검증: ${step.playtest.input}`,
            `화면에서 기대하는 결과: ${step.playtest.expect}`,
            step.playtest.failure ? `지난 실패 (반복하지 말 것): ${step.playtest.failure}` : '',
            step.playtest.history && step.playtest.history.length > 0
              ? `이 기능의 실패 기록:\n${step.playtest.history.slice(-4).map((item) => `- ${item}`).join('\n')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '조작 검증: 없음 (이 Step 은 키/마우스로 기능을 확인하지 않음)';
      return [`Step ${step.id} [${mark}] ${step.title}`, step.task, '완료 조건:', criteria, play].join('\n');
    })
    .join('\n\n');
}

function formatMemories(state: OrchestratorState): string {
  const recent = state.memories.slice(-5);
  if (recent.length === 0) return '(이전 Step 없음)';
  return recent
    .map((memory) => {
      const summary = memory.summary.join(' / ') || '(요약 없음)';
      return `Step ${memory.stepId} ${memory.title} [${memory.status}] ${summary}`;
    })
    .join('\n');
}

export function buildPlanPrompt(args: {
  config: OrchestratorConfig;
  state: OrchestratorState;
  goal: string;
  feedback?: string;
}): string {
  const rules = collectCursorRules(args.config.targetProjectPath, args.config.rulesMaxChars);
  const spec = budgetText(readDoc(args.config.specPath), args.config.specMaxChars, '기획서');
  const roadmap = budgetText(
    formatSteps(loadRoadmapSafe(args.config.roadmapPath, args.state), args.state.completedSteps),
    12_000,
    '로드맵',
  );
  const completed = args.state.completedSteps.length > 0 ? args.state.completedSteps.join(', ') : '없음';

  return [
    '# [PLAN] 기획서와 로드맵만 작성',
    '너는 Unity 게임의 기획 책임자다. 이번 호출에서는 게임을 구현하지 않는다.',
    `수정 가능한 파일은 다음 둘뿐이다.`,
    `- 기획서: ${args.config.specPath}`,
    `- 로드맵: ${args.config.roadmapPath}`,
    'Assets 아래 코드, 프리팹, 씬을 만들거나 수정하지 마라. git commit 도 하지 마라.',
    '',
    '# 목표',
    args.goal,
    '',
    '# 규칙',
    rules || '(프로젝트 규칙 없음. Unity C# 과 MVP 구성을 기준으로 기획한다.)',
    '',
    '# 현재 기획서',
    spec || '(없음)',
    '',
    '# 현재 로드맵',
    roadmap,
    '',
    `# 이미 완료된 Step id: ${completed}`,
    '완료된 Step 의 id, title, task, acceptanceCriteria 는 유지한다. 새 Step 은 기존 최대 id 보다 큰 id 를 쓴다.',
    `${AUTONOMY_PLACEHOLDER} 자리표시자는 남기지 마라.`,
    '',
    '기획서는 목표의 플레이, 규칙, 콘텐츠 범위, 완료 기준을 스스로 결정해 적는다. 사람에게 되묻지 마라.',
    '로드맵 Step 은 한 번의 구현 세션으로 끝나는 크기여야 한다.',
    'acceptanceCriteria 에는 컴파일 에러 0건, 테스트 통과처럼 오케스트레이터가 따로 검사하는 문장을 넣지 마라.',
    '조건은 파일, 심볼, 프리팹, 기획서 절처럼 디스크에서 확인할 수 있는 문장만 적는다.',
    '플레이어가 보고 조작하는 기능 Step 에는 playtest 를 넣어라. input 은 그 기능만 시험하는 조작이고, expect 는 입력 뒤 화면에 보여야 하는 결과다.',
    '예: {"input":"key:Space; wait:400","expect":"점프 후 착지","probe":{"events":["JumpStarted","Landed"],"position":{"object":"Player","axis":"y","deltaMin":1},"text":{"object":"Score","contains":"1"}}}.',
    'probe.position 은 입력 이후 정점이다. 착지해서 원위치가 되어도 공중 정점이 기준을 넘으면 통과한다. 입력 전에 이미 움직이거나 이벤트가 있으면 실패한다.',
    '메뉴는 active.equals, 점수나 버튼 글자는 text.contains 로 넣는다. 여러 대상은 positions, actives, texts 배열이다.',
    '기능이 일어나면 CursorAutoWork.PlaytestLog.Mark("이벤트이름") 를 호출한다. 합격은 probe 이고 expect 문장이 아니다.',
    '폴더 생성이나 데이터 정의처럼 화면으로 확인할 수 없는 Step 에는 playtest 를 넣지 마라. 모든 Step 에 같은 키를 넣지 마라.',
    'roadmap.json 스키마: project, description, steps[].id, title, task, acceptanceCriteria, targetFiles, runTests, playtest.input, playtest.expect.',
    'task 는 비어 있으면 안 된다. verify 블록은 쓰지 마라.',
    '',
    args.feedback
      ? `# 이전 기획 시도가 거절되었다\n${args.feedback}\n위 문제를 고친 기획서와 로드맵을 다시 써라.`
      : '지금 기획서와 로드맵을 목표에 맞게 덮어써라.',
  ].join('\n');
}

function loadRoadmapSafe(roadmapPath: string, state: OrchestratorState): Roadmap {
  try {
    return loadRoadmap(roadmapPath);
  } catch {
    return { project: state.project, steps: [] };
  }
}

export function buildReviseSpecPrompt(args: {
  config: OrchestratorConfig;
  goal: string;
  review: ProductReview;
  roadmap: Roadmap;
  completedIds: number[];
  feedback?: string;
}): string {
  const spec = budgetText(readDoc(args.config.specPath), args.config.specMaxChars, '기획서');
  const edits = args.review.specEdits.length > 0 ? args.review.specEdits.map((item) => `- ${item}`).join('\n') : '- (항목 없음. 새 Step 에 맞게 해당 절을 보강)';

  return [
    '# [REVISE SPEC] 기획서만 수정',
    '검토 결과에 맞게 기획서를 고친다. 게임 코드는 수정하지 않는다.',
    `기획서 경로: ${args.config.specPath}`,
    `로드맵 파일은 오케스트레이터가 이미 고쳤다. ${args.config.roadmapPath} 는 수정하지 마라.`,
    'git commit 하지 마라.',
    '',
    '# 목표',
    args.goal,
    '',
    '# 검토 요약',
    args.review.summary || '(없음)',
    '',
    '# 기획서에 반영할 수정',
    edits,
    '',
    '# 현재 로드맵',
    formatSteps(args.roadmap, args.completedIds),
    '',
    '# 현재 기획서',
    spec || '(없음)',
    '',
    `${AUTONOMY_PLACEHOLDER} 표식은 제거한다. 목표와 어긋난 완료 기준은 고치고, 이미 맞는 절은 유지한다.`,
    args.feedback ? `\n# 이전 수정이 반영되지 않았다\n${args.feedback}` : '',
  ].join('\n');
}

export function buildProductReviewPrompt(args: {
  config: OrchestratorConfig;
  state: OrchestratorState;
  goal: string;
  buildFailed: boolean;
  feedback?: string;
  playtest?: {
    ok: boolean;
    imagePath?: string;
    beforePath?: string;
    afterPath?: string;
    note: string;
    stepId?: number;
    stepTitle?: string;
    input?: string;
    expect?: string;
  };
}): string {
  const spec = budgetText(readDoc(args.config.specPath), args.config.specMaxChars, '기획서');
  const roadmap = loadRoadmapSafe(args.config.roadmapPath, args.state);
  const failure = args.buildFailed
    ? args.state.lastError?.slice(-4000) || 'Step 이 재시도 한도 안에서 검수를 통과하지 못했습니다.'
    : '(이번 사이클의 Step 검수는 통과했거나, 실행할 미완 Step 이 없었습니다.)';

  return [
    '# [REVIEW] 목표 대비 제품 검토',
    '너는 읽기 전용 검토자다. 파일을 수정하지 말고, 셸과 Unity CLI 를 호출하지 마라.',
    '로드맵 Step 이 모두 끝났는지만 보지 마라. 목표로 제시된 게임을 기획서대로 만들 수 있는 상태인지 판단한다.',
    '기획이 목표보다 좁거나, 구현이 기획과 다르거나, 화면이 목표와 다르거나, Step 이 같은 이유로 반복 실패하면 verdict 는 revise 다.',
    'revise 이면 남은 계획도 바꿔라. updateSteps 로 다음 Step 지시를 고치거나 addSteps 로 새 작업을 넣어라.',
    '한 사이클은 일부 Step 만 실행한다. 로드맵이 남았다는 이유만으로 실패가 아니다. 화면과 기획이 목표에 맞으면 done 이다.',
    '목표를 더 이상 코드로 좁힐 수 없으면 blocked 다. 사람에게 질문하는 문장은 쓰지 마라.',
    '',
    '# 목표',
    args.goal,
    '',
    `# 사이클 ${args.state.autonomy?.cycle ?? 1} / ${args.state.autonomy?.maxCycles ?? 1}`,
    '',
    '# 기획서',
    spec || '(없음)',
    '',
    '# 로드맵',
    formatSteps(roadmap, args.state.completedSteps),
    '',
    '# 구현 요약',
    formatMemories(args.state),
    '',
    '# 이번 사이클 개발 결과',
    failure,
    '',
    '# 플레이 화면',
    args.playtest
      ? [
          args.playtest.note,
          args.playtest.beforePath ? `입력 전 화면: ${args.playtest.beforePath}` : '',
          args.playtest.afterPath ? `입력 후 화면: ${args.playtest.afterPath}` : '',
          !args.playtest.afterPath && args.playtest.imagePath ? `화면: ${args.playtest.imagePath}` : '',
          args.playtest.stepId ? `이번 검증 Step ${args.playtest.stepId} ${args.playtest.stepTitle ?? ''}` : '',
          args.playtest.input ? `이 Step 의 조작: ${args.playtest.input}` : '이 Step 에는 기능 조작이 없다. 공용 키를 누르는 시험이 아니다.',
          args.playtest.expect ? `입력 후 화면이 이래야 한다: ${args.playtest.expect}` : '',
          'expect 가 있으면 입력 후 화면이 그 문장과 일치하는지가 이 기능의 검증이다. 다르면 revise 다.',
          '플레이어가 보는 기능인데 playtest 가 없으면 updateSteps 나 addSteps 에 그 기능만의 input 과 expect 를 넣어 revise 하라.',
          '입력 주입이 unavailable 이면 Input System 이 없다는 뜻이다. 그 기능의 조작 검증이 필요할 때만 패키지를 넣는 Step 을 추가하라.',
          '관찰을 summary 에 적어라.',
        ]
          .filter(Boolean)
          .join('\n')
      : '(이번 사이클은 화면 캡처를 하지 않았다.)',
    '',
    args.feedback ? `# 이전 검토 JSON 이 거절되었다\n${args.feedback}\n` : '',
    '마지막에 JSON 만 출력하라.',
    '{',
    '  "verdict": "done | revise | blocked",',
    '  "summary": "목표와 현재 구현의 차이",',
    '  "specEdits": ["기획서에서 고칠 문장"],',
    '  "reopenStepIds": [1],',
    '  "updateSteps": [{ "id": 2, "title": "", "task": "", "acceptanceCriteria": [], "targetFiles": [], "playtest": { "input": "key:Space; wait:400", "expect": "화면에 보여야 하는 결과" } }],',
    '  "addSteps": [{ "title": "", "task": "", "acceptanceCriteria": [], "targetFiles": [], "playtest": { "input": "click:640,360", "expect": "버튼이 눌린 상태가 보인다" } }]',
    '}',
    'revise 이면 reopenStepIds, updateSteps, addSteps 중 하나로 다음 개발이 생겨야 한다.',
    '완료 조건에 컴파일 에러 0건이나 테스트 통과를 적지 마라.',
    'Step 검수가 실패한 사이클의 verdict 는 done 이 될 수 없다.',
  ].join('\n');
}

/** 화면을 본 구현 세션이, 검토 세션 전에 기능이나 조작을 바로 고치게 한다. */
export function buildPlaytestFollowUpPrompt(args: {
  roadmapPath: string;
  shot: {
    stepId?: number;
    stepTitle?: string;
    input?: string;
    expect?: string;
    beforePath?: string;
    afterPath?: string;
    imagePath?: string;
    note: string;
  };
}): string {
  const images = [args.shot.beforePath, args.shot.afterPath, args.shot.imagePath].filter(
    (item, index, list): item is string => Boolean(item) && list.indexOf(item) === index,
  );
  return [
    '# [PLAYTEST FOLLOW-UP] 방금 본 화면으로 바로 수정',
    '같은 구현 세션이다. 검토 담당이 아니다. 파일을 고칠 수 있다.',
    '방금 넣은 조작과 화면을 보고, 기능이 기대와 다르면 코드를 고쳐라.',
    '조작이 버튼을 빗나갔거나 잘못된 키면, 그 Step 의 playtest.input 만 바꿔라.',
    `로드맵: ${args.roadmapPath}`,
    args.shot.stepId ? `Step ${args.shot.stepId} ${args.shot.stepTitle ?? ''}` : 'Step 번호가 없다.',
    args.shot.input ? `넣은 조작: ${args.shot.input}` : '이 Step 에는 조작이 없었다.',
    args.shot.expect ? `기대 화면: ${args.shot.expect}` : '기대 화면 문장이 없다.',
    `관찰: ${args.shot.note}`,
    '기대와 다르다는 판정이 위에 있으면, 그 차이를 이번 수정으로 없애라. 한 번 고친 것으로 끝내지 말고 화면 차이를 직접 겨냥하라.',
    images.length > 0 ? `이미지 파일을 읽어라:\n${images.map((item) => `- ${item}`).join('\n')}` : '이미지 파일이 없다.',
    '다른 Step 의 본문은 바꾸지 마라. git commit 하지 마라.',
    '고친 뒤 멈추면 오케스트레이터가 그 조작을 한 번 더 넣는다. expect 문장은 바꾸지 마라.',
    '마지막에 실패한 이유나 버린 접근이 있으면 한 줄로 남겨라: LESSON: ...',
  ].join('\n');
}
