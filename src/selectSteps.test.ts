import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectRunnableSteps } from './orchestrator';
import type { OrchestratorState, Roadmap } from './types';

const roadmap: Roadmap = {
  project: 't',
  steps: [
    { id: 1, title: 'a', task: 'a' },
    { id: 2, title: 'b', task: 'b' },
    { id: 3, title: 'c', task: 'c' },
  ],
};

function state(completed: number[]): OrchestratorState {
  return {
    project: 't',
    currentStepId: null,
    status: 'idle',
    attempts: {},
    completedSteps: completed,
    memories: [],
    startedAt: '',
    updatedAt: '',
  };
}

describe('selectRunnableSteps', () => {
  it('skips completed steps even with --from', () => {
    const steps = selectRunnableSteps(roadmap, state([1, 2]), { fromStep: 1 });
    assert.deepEqual(
      steps.map((step) => step.id),
      [3],
    );
  });

  it('re-runs completed steps only with forceRerun', () => {
    const steps = selectRunnableSteps(roadmap, state([1, 2]), { fromStep: 2, forceRerun: true });
    assert.deepEqual(
      steps.map((step) => step.id),
      [2, 3],
    );
  });

  it('respects --to on incomplete steps', () => {
    const steps = selectRunnableSteps(roadmap, state([1]), { toStep: 2 });
    assert.deepEqual(
      steps.map((step) => step.id),
      [2],
    );
  });
});
