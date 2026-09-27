import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  acceptPlannedRoadmap,
  applyProductReview,
  assessProductReview,
  decideAutonomyAction,
  excerptRun,
  extractLessons,
  formatPlanAuthority,
  preservePlaytestExpect,
  rememberLessons,
  parsePlaytestMatch,
  resolveImplementResume,
  shouldRotateImplementSession,
  docsReadyForAutonomy,
  ensureGoalDocs,
  mergePlannedRoadmap,
  parseProductReview,
  resolveAutonomyGoal,
} from './autonomy';
import { loadRoadmap } from './roadmap';
import type { ProductReview } from './autonomy';
import type { Roadmap } from './types';

function roadmap(): Roadmap {
  return {
    project: 'Demo',
    steps: [
      { id: 1, title: '기초', task: '폴더를 만든다', acceptanceCriteria: ['Assets/Scripts/Core 가 있다'], targetFiles: ['Assets/Scripts/Core'] },
      { id: 2, title: '이동', task: '플레이어를 움직인다', acceptanceCriteria: ['PlayerMover 가 있다'], targetFiles: ['Assets/Scripts/Gameplay'] },
    ],
  };
}

function review(partial: Partial<ProductReview> & Pick<ProductReview, 'verdict'>): ProductReview {
  return {
    summary: partial.summary ?? '차이 있음',
    specEdits: partial.specEdits ?? [],
    reopenStepIds: partial.reopenStepIds ?? [],
    updateSteps: partial.updateSteps ?? [],
    addSteps: partial.addSteps ?? [],
    verdict: partial.verdict,
  };
}

describe('resolveAutonomyGoal', () => {
  const ready = docsReadyForAutonomy('x'.repeat(80), roadmap());

  it('stays on without a topic and keeps an existing plan', () => {
    const resolved = resolveAutonomyGoal({
      enabled: true,
      configuredGoal: '',
      fileGoal: '',
      projectName: 'Demo',
      docsReady: ready,
    });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.replan, false);
    assert.match(resolved.goal, /Demo/);
  });

  it('replans when GOAL or a goal file is set', () => {
    assert.equal(
      resolveAutonomyGoal({
        enabled: true,
        configuredGoal: '로그라이크',
        fileGoal: '무시',
        projectName: 'Demo',
        docsReady: ready,
      }).replan,
      true,
    );
    assert.equal(
      resolveAutonomyGoal({
        enabled: true,
        configuredGoal: '',
        fileGoal: '퍼즐',
        projectName: 'Demo',
        docsReady: ready,
      }).goal,
      '퍼즐',
    );
  });

  it('turns off only when autonomy is disabled', () => {
    const resolved = resolveAutonomyGoal({
      enabled: false,
      configuredGoal: '로그라이크',
      fileGoal: '',
      projectName: 'Demo',
      docsReady: ready,
    });
    assert.equal(resolved.enabled, false);
  });

  it('replans when the spec or roadmap is still a placeholder', () => {
    assert.equal(
      resolveAutonomyGoal({
        enabled: true,
        configuredGoal: '',
        fileGoal: '',
        projectName: 'Demo',
        docsReady: false,
      }).replan,
      true,
    );
  });
});

describe('parseProductReview', () => {
  it('reads a fenced verdict', () => {
    const parsed = parseProductReview(
      [
        '검토를 마쳤습니다.',
        '```json',
        JSON.stringify({
          verdict: 'revise',
          summary: '점프가 없다',
          specEdits: ['점프를 핵심 플레이에 넣는다'],
          reopenStepIds: [2],
          addSteps: [{ title: '점프', task: '점프를 구현한다', acceptanceCriteria: ['Jump 메서드가 있다'] }],
        }),
        '```',
      ].join('\n'),
    );
    assert.equal(parsed?.verdict, 'revise');
    assert.equal(parsed?.reopenStepIds[0], 2);
    assert.equal(parsed?.addSteps[0]?.title, '점프');
  });

  it('rejects an unknown verdict', () => {
    assert.equal(parseProductReview('{"verdict":"ok","summary":"x"}'), null);
  });
});

describe('applyProductReview', () => {
  it('stores the feature playtest on a new step', () => {
    const applied = applyProductReview(
      roadmap(),
      [1, 2],
      review({
        verdict: 'revise',
        addSteps: [
          {
            title: '점프',
            task: 'Space 로 점프한다',
            playtest: { input: 'key:Space; wait:400', expect: '발이 땅에서 떨어진다' },
          },
        ],
      }),
    );
    assert.equal(applied.roadmap.steps[2]?.playtest?.input, 'key:Space; wait:400');
    assert.equal(applied.roadmap.steps[2]?.playtest?.expect, '발이 땅에서 떨어진다');
  });

  it('reopens a finished step and appends a new id', () => {
    const applied = applyProductReview(
      roadmap(),
      [1, 2],
      review({
        verdict: 'revise',
        reopenStepIds: [2],
        addSteps: [{ title: '점프', task: '점프를 구현한다' }],
      }),
    );
    assert.deepEqual(applied.completedSteps, [1]);
    assert.deepEqual(applied.reopened, [2]);
    assert.deepEqual(applied.added, [3]);
    assert.equal(applied.roadmap.steps[2]?.task, '점프를 구현한다');
  });

  it('reopens a finished step when its task changes', () => {
    const applied = applyProductReview(
      roadmap(),
      [1],
      review({
        verdict: 'revise',
        updateSteps: [{ id: 1, title: '기초', task: '입력 맵까지 만든다' }],
      }),
    );
    assert.deepEqual(applied.completedSteps, []);
    assert.deepEqual(applied.updated, [1]);
    assert.equal(applied.roadmap.steps[0]?.task, '입력 맵까지 만든다');
  });

  it('leaves a step completed when the patch matches the current task', () => {
    const applied = applyProductReview(
      roadmap(),
      [1],
      review({
        verdict: 'revise',
        updateSteps: [{ id: 1, title: '기초', task: '폴더를 만든다', acceptanceCriteria: ['Assets/Scripts/Core 가 있다'] }],
      }),
    );
    assert.deepEqual(applied.completedSteps, [1]);
    assert.deepEqual(applied.updated, []);
  });
});

describe('assessProductReview', () => {
  it('turns done into revise when the playtest still misses the expected screen', () => {
    const assessed = assessProductReview(review({ verdict: 'done', summary: '끝' }), roadmap(), [1], false, true);
    assert.equal(assessed.review.verdict, 'revise');
    assert.match(assessed.review.summary, /조작 검증/);
  });

  it('turns done into revise when the build failed', () => {
    const assessed = assessProductReview(review({ verdict: 'done', summary: '끝' }), roadmap(), [1], true);
    assert.equal(assessed.review.verdict, 'revise');
    assert.equal(assessed.hasWork, true);
  });

  it('asks for another review when revise has no remaining work', () => {
    const assessed = assessProductReview(review({ verdict: 'revise', summary: '고칠 것' }), roadmap(), [1, 2], false);
    assert.equal(assessed.hasWork, false);
    assert.equal(assessed.issues.length > 0, true);
  });
});

describe('playtest match and session rotation', () => {
  it('rejects a match that reports no visible change', () => {
    assert.deepEqual(parsePlaytestMatch('{"match":true,"changed":false,"note":"그대로다"}'), {
      match: false,
      note: '그대로다',
    });
  });

  it('reads a match verdict', () => {
    assert.deepEqual(parsePlaytestMatch('```json\n{"match":false,"note":"발이 붙어 있다"}\n```'), {
      match: false,
      note: '발이 붙어 있다',
    });
  });

  it('rotates only after the step limit', () => {
    assert.equal(shouldRotateImplementSession(3, 4), false);
    assert.equal(shouldRotateImplementSession(4, 4), true);
  });

  it('keeps a lesson and refuses a looser expect', () => {
    assert.deepEqual(extractLessons('LESSON: Space 는 UI 가 먹는다'), ['Space 는 UI 가 먹는다']);
    const note = excerptRun(`${'시도했다. '.repeat(20)}그래서 그 키는 버렸다.`);
    assert.match(note ?? '', /구현 메모/);
    assert.deepEqual(rememberLessons(['a'], ['a', 'b']), ['a', 'b']);
    const previous = roadmap();
    previous.steps[1] = {
      ...previous.steps[1],
      playtest: { input: 'key:Space', expect: '발이 땅에서 떨어진다', history: ['첫 실패'] },
    };
    const next = roadmap();
    next.steps[1] = {
      ...next.steps[1],
      playtest: { input: 'key:Space', expect: '아무거나 움직이면 된다' },
    };
    const locked = preservePlaytestExpect(previous, next);
    assert.equal(locked.steps[1]?.playtest?.expect, '발이 땅에서 떨어진다');
    assert.deepEqual(locked.steps[1]?.playtest?.history, ['첫 실패']);
  });

  it('rejects a match whose three observations are the same', () => {
    const parsed = parsePlaytestMatch(
      '{"match":true,"changed":true,"phases":["떠 있다","떠 있다","떠 있다"],"note":"같다"}',
    );
    assert.equal(parsed?.match, false);
  });

  it('puts the latest review ahead of the old chat', () => {
    const text = formatPlanAuthority([{ cycle: 2, verdict: 'revise', summary: '점프가 약하다' }]);
    assert.match(text, /디스크의 기획서와 로드맵이 이전 대화보다 우선/);
    assert.match(text, /점프가 약하다/);
  });
});

describe('resolveImplementResume', () => {
  it('carries the implementation session into the next step', () => {
    assert.equal(
      resolveImplementResume({
        carrySession: true,
        resumeOnRetry: true,
        attempt: 1,
        carriedSessionId: 'sess-1',
      }),
      'sess-1',
    );
  });

  it('prefers the retry session over the carried one', () => {
    assert.equal(
      resolveImplementResume({
        carrySession: true,
        resumeOnRetry: true,
        attempt: 2,
        retrySessionId: 'sess-retry',
        carriedSessionId: 'sess-1',
      }),
      'sess-retry',
    );
  });

  it('starts fresh when carrying is off', () => {
    assert.equal(
      resolveImplementResume({
        carrySession: false,
        resumeOnRetry: true,
        attempt: 1,
        carriedSessionId: 'sess-1',
      }),
      undefined,
    );
  });
});

describe('decideAutonomyAction', () => {
  it('stops at the cycle cap even if the review wants another pass', () => {
    assert.equal(
      decideAutonomyAction({ verdict: 'revise', hasWork: true, unresolvedIssues: false, cycle: 3, maxCycles: 3 }),
      'blocked',
    );
  });

  it('accepts done when the review is well formed', () => {
    assert.equal(
      decideAutonomyAction({ verdict: 'done', hasWork: false, unresolvedIssues: false, cycle: 1, maxCycles: 3 }),
      'done',
    );
  });
});

describe('mergePlannedRoadmap', () => {
  it('keeps the body of a completed step when the planner reuses its id', () => {
    const next: Roadmap = {
      project: 'Demo',
      steps: [
        { id: 1, title: '덮어씀', task: '다른 작업', acceptanceCriteria: ['바뀜'] },
        { id: 3, title: '전투', task: '전투를 만든다' },
      ],
    };
    const merged = mergePlannedRoadmap(roadmap(), next, [1]);
    assert.equal(merged.steps.find((step) => step.id === 1)?.task, '폴더를 만든다');
    assert.equal(merged.steps.find((step) => step.id === 3)?.title, '전투');
    assert.equal(merged.steps.some((step) => step.id === 2), false);
  });
});

describe('ensureGoalDocs', () => {
  it('writes a roadmap the loader accepts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-'));
    const specPath = path.join(dir, 'docs', 'spec.md');
    const roadmapPath = path.join(dir, 'docs', 'roadmap.json');
    ensureGoalDocs({ specPath, roadmapPath, goal: '한 판짜리 로그라이크', projectName: 'Demo' });
    const loaded = loadRoadmap(roadmapPath);
    assert.equal(loaded.steps.length, 1);
    const accepted = acceptPlannedRoadmap({ roadmapPath, previous: loaded, completedIds: [] });
    assert.equal(accepted.ok, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
