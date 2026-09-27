import fs from 'node:fs';

import { parseProbe } from './playtestProbe';
import type { Roadmap, RoadmapStep, StepPlaytest, VerifyCheck, VerifyCheckType, VerifyScope, VerifySpec } from './types';

export class RoadmapError extends Error {}

function asStringArray(value: unknown, field: string, stepId: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RoadmapError(`Step ${stepId}: '${field}' 는 문자열 배열이어야 합니다.`);
  }
  return value as string[];
}

const VERIFY_TYPES = new Set<VerifyCheckType>([
  'exists',
  'notExists',
  'globMin',
  'contains',
  'notContains',
  'jsonField',
  'csNoUnityEngine',
  'prefab',
  'addressable',
]);

function asStringOrList(value: unknown, field: string, stepId: number): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  throw new RoadmapError(`Step ${stepId}: '${field}' 는 문자열 또는 문자열 배열이어야 합니다.`);
}

function parseCheck(raw: unknown, stepId: number, index: number): VerifyCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoadmapError(`Step ${stepId}: verify.checks[${index}] 는 객체여야 합니다.`);
  }

  const rec = raw as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== 'string' || !VERIFY_TYPES.has(type as VerifyCheckType)) {
    throw new RoadmapError(
      `Step ${stepId}: verify.checks[${index}].type 이 유효하지 않습니다 (${String(type)}).`,
    );
  }

  const check: VerifyCheck = { type: type as VerifyCheckType };

  if (rec.path !== undefined) {
    if (typeof rec.path !== 'string' || rec.path.trim() === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].path 는 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.path = rec.path.trim();
  }

  if (rec.glob !== undefined) {
    if (typeof rec.glob !== 'string' || rec.glob.trim() === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].glob 는 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.glob = rec.glob.trim();
  }

  if (rec.min !== undefined) {
    if (typeof rec.min !== 'number' || !Number.isFinite(rec.min) || rec.min < 1) {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].min 은 1 이상 숫자여야 합니다.`);
    }
    check.min = rec.min;
  }

  if (rec.pattern !== undefined) {
    if (typeof rec.pattern !== 'string' || rec.pattern === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].pattern 은 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.pattern = rec.pattern;
  }

  if (rec.field !== undefined) {
    if (typeof rec.field !== 'string' || rec.field.trim() === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].field 는 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.field = rec.field.trim();
  }

  if (rec.contains !== undefined) {
    check.contains = asStringOrList(rec.contains, `verify.checks[${index}].contains`, stepId);
  }
  if (rec.mustNotContain !== undefined) {
    check.mustNotContain = asStringOrList(rec.mustNotContain, `verify.checks[${index}].mustNotContain`, stepId);
  }
  if (rec.equals !== undefined) check.equals = rec.equals;

  if (rec.group !== undefined) {
    if (typeof rec.group !== 'string' || rec.group.trim() === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].group 는 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.group = rec.group.trim();
  }
  if (rec.address !== undefined) {
    if (typeof rec.address !== 'string' || rec.address.trim() === '') {
      throw new RoadmapError(`Step ${stepId}: verify.checks[${index}].address 는 비어 있지 않은 문자열이어야 합니다.`);
    }
    check.address = rec.address.trim();
  }

  if (check.type === 'exists' || check.type === 'notExists' || check.type === 'csNoUnityEngine') {
    if (!check.path) throw new RoadmapError(`Step ${stepId}: ${check.type} 체크는 path 가 필요합니다.`);
  }
  if (check.type === 'globMin') {
    if (!check.glob) throw new RoadmapError(`Step ${stepId}: globMin 체크는 glob 이 필요합니다.`);
  }
  if (check.type === 'contains' || check.type === 'notContains') {
    if (!check.pattern) throw new RoadmapError(`Step ${stepId}: ${check.type} 체크는 pattern 이 필요합니다.`);
    if (!check.path && !check.glob) {
      throw new RoadmapError(`Step ${stepId}: ${check.type} 체크는 path 또는 glob 이 필요합니다.`);
    }
  }
  if (check.type === 'jsonField') {
    if (!check.path || !check.field) {
      throw new RoadmapError(`Step ${stepId}: jsonField 체크는 path 와 field 가 필요합니다.`);
    }
  }
  if (check.type === 'prefab') {
    if (!check.path && !check.glob) {
      throw new RoadmapError(`Step ${stepId}: prefab 체크는 path 또는 glob 이 필요합니다.`);
    }
  }
  if (check.type === 'addressable') {
    if (!check.address && !check.pattern && !check.contains && !check.path && !check.group) {
      throw new RoadmapError(
        `Step ${stepId}: addressable 체크는 address, group, path 중 하나 이상이 필요합니다.`,
      );
    }
  }

  return check;
}

function parseStepPlaytest(raw: unknown, stepId: number): StepPlaytest | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoadmapError(`Step ${stepId}: 'playtest' 는 객체여야 합니다.`);
  }
  const rec = raw as Record<string, unknown>;
  const input = typeof rec.input === 'string' ? rec.input.trim() : '';
  const expect = typeof rec.expect === 'string' ? rec.expect.trim() : '';
  if (!input || !expect) {
    throw new RoadmapError(`Step ${stepId}: playtest 는 input 과 expect 문자열이 모두 필요합니다.`);
  }
  const failure = typeof rec.failure === 'string' && rec.failure.trim() ? rec.failure.trim() : undefined;
  const history = Array.isArray(rec.history)
    ? rec.history.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(-8)
    : undefined;
  return { input, expect, probe: parseProbe(rec.probe), failure, history: history && history.length > 0 ? history : undefined };
}

function parseVerify(raw: unknown, stepId: number): VerifySpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoadmapError(`Step ${stepId}: 'verify' 는 객체여야 합니다.`);
  }

  const rec = raw as Record<string, unknown>;
  const spec: VerifySpec = {};

  if (rec.scope !== undefined) {
    if (rec.scope !== 'targetFiles' && rec.scope !== 'all') {
      throw new RoadmapError(`Step ${stepId}: verify.scope 는 targetFiles 또는 all 이어야 합니다.`);
    }
    spec.scope = rec.scope as VerifyScope;
  }

  if (rec.requireChanges !== undefined) {
    if (typeof rec.requireChanges !== 'boolean') {
      throw new RoadmapError(`Step ${stepId}: verify.requireChanges 는 boolean 이어야 합니다.`);
    }
    spec.requireChanges = rec.requireChanges;
  }

  if (rec.mcp !== undefined) spec.mcp = asStringArray(rec.mcp, 'verify.mcp', stepId);

  if (rec.checks !== undefined) {
    if (!Array.isArray(rec.checks)) {
      throw new RoadmapError(`Step ${stepId}: verify.checks 는 배열이어야 합니다.`);
    }
    spec.checks = rec.checks.map((item, index) => parseCheck(item, stepId, index));
  }

  return spec;
}

export function loadRoadmap(roadmapPath: string): Roadmap {
  if (!fs.existsSync(roadmapPath)) {
    throw new RoadmapError(`roadmap.json 을 찾을 수 없습니다: ${roadmapPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(roadmapPath, 'utf8'));
  } catch (error) {
    throw new RoadmapError(`roadmap.json 파싱 실패: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new RoadmapError('roadmap.json 최상위는 객체여야 합니다.');
  }

  const record = parsed as Record<string, unknown>;
  const rawSteps = record.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new RoadmapError("roadmap.json 에 'steps' 배열이 비어 있습니다.");
  }

  const seenIds = new Set<number>();
  const steps: RoadmapStep[] = rawSteps.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new RoadmapError(`steps[${index}] 는 객체여야 합니다.`);
    }
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === 'number' ? step.id : index + 1;

    if (seenIds.has(id)) throw new RoadmapError(`Step id 가 중복되었습니다: ${id}`);
    seenIds.add(id);

    if (typeof step.task !== 'string' || step.task.trim() === '') {
      throw new RoadmapError(`Step ${id}: 'task' 는 비어 있지 않은 문자열이어야 합니다.`);
    }

    return {
      id,
      title: typeof step.title === 'string' && step.title ? step.title : `Step ${id}`,
      task: step.task.trim(),
      acceptanceCriteria: asStringArray(step.acceptanceCriteria, 'acceptanceCriteria', id),
      targetFiles: asStringArray(step.targetFiles, 'targetFiles', id),
      verify: parseVerify(step.verify, id),
      runTests: typeof step.runTests === 'boolean' ? step.runTests : undefined,
      commitMessage: typeof step.commitMessage === 'string' ? step.commitMessage : undefined,
      playtest: parseStepPlaytest(step.playtest, id),
    };
  });

  steps.sort((a, b) => a.id - b.id);

  return {
    project: typeof record.project === 'string' && record.project ? record.project : 'Unity Project',
    description: typeof record.description === 'string' ? record.description : undefined,
    steps,
  };
}
