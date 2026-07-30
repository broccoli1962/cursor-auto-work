import fs from 'node:fs';

import type { Roadmap, RoadmapStep } from './types';

export class RoadmapError extends Error {}

function asStringArray(value: unknown, field: string, stepId: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RoadmapError(`Step ${stepId}: '${field}' 는 문자열 배열이어야 합니다.`);
  }
  return value as string[];
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
      runTests: typeof step.runTests === 'boolean' ? step.runTests : undefined,
      commitMessage: typeof step.commitMessage === 'string' ? step.commitMessage : undefined,
    };
  });

  steps.sort((a, b) => a.id - b.id);

  return {
    project: typeof record.project === 'string' && record.project ? record.project : 'Unity Project',
    description: typeof record.description === 'string' ? record.description : undefined,
    steps,
  };
}
