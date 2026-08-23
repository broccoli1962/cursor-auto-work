import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { contractResult, expandBraces, inferVerifyChecks, mergeVerifyChecks } from './inferVerify';
import { diffHasMeaningfulEdits, isTrivialDiffLine } from './gitManager';
import { extractEvidenceRelPath, finalizeJudgeVerdict, parseJudgeVerdict } from './stepJudge';

describe('inferVerifyChecks', () => {
  it('expands braces and adds exists from targetFiles', () => {
    assert.deepEqual(expandBraces('Assets/Scripts/{Core,UI}'), ['Assets/Scripts/Core', 'Assets/Scripts/UI']);
    const checks = inferVerifyChecks({
      id: 1,
      title: 't',
      task: '폴더를 만든다',
      targetFiles: ['Assets/Scripts/Core', 'Assets/Scripts/Gameplay'],
    });
    assert.equal(
      checks.some((check) => check.type === 'exists' && check.path === 'Assets/Scripts/Core'),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'exists' && check.path === 'Assets/Scripts/Gameplay'),
      true,
    );
  });

  it('picks Assets paths from acceptanceCriteria and asmdef globs', () => {
    const checks = inferVerifyChecks({
      id: 1,
      title: 't',
      task: 'asmdef 를 추가한다',
      acceptanceCriteria: ['Assets/Scripts/Core/Constants/GameConstants.cs 가 존재한다'],
      targetFiles: ['Assets/Scripts/Core'],
    });
    assert.equal(
      checks.some((check) => check.path === 'Assets/Scripts/Core/Constants/GameConstants.cs'),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'globMin' && check.glob === 'Assets/Scripts/Core/**/*.asmdef'),
      true,
    );
  });

  it('infers contains from quotes and identifiers, notContains from 코루틴', () => {
    const checks = inferVerifyChecks({
      id: 3,
      title: 'state',
      task: 'GameStateMachine 을 구현한다. 코루틴은 사용하지 않는다.',
      acceptanceCriteria: [
        'IGameState 를 구현한 4개 상태 클래스가 존재한다',
        "Get('move') 가 'move' 를 반환한다",
      ],
      targetFiles: ['Assets/Scripts/Gameplay/StateMachine'],
    });
    assert.equal(
      checks.some((check) => check.type === 'contains' && check.pattern?.includes('IGameState')),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'contains' && check.pattern?.includes('GameStateMachine')),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'contains' && check.pattern === 'move'),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'notContains' && check.pattern?.includes('IEnumerator')),
      true,
    );
  });

  it('fails when the step has no contract', () => {
    const step = { id: 1, title: 'x', task: '작업한다' };
    const inferred = inferVerifyChecks(step);
    assert.equal(contractResult(step, inferred).ok, false);
  });

  it('keeps explicit checks first and dedupes inferred', () => {
    const merged = mergeVerifyChecks(
      [{ type: 'exists', path: 'Assets/A.cs' }],
      [{ type: 'exists', path: 'Assets/A.cs' }, { type: 'contains', path: 'Assets/A.cs', pattern: 'Foo' }],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.type, 'exists');
    assert.equal(merged[1]?.type, 'contains');
  });
});

describe('trivial diff', () => {
  it('treats comment and using lines as trivial', () => {
    assert.equal(isTrivialDiffLine('+  // TODO later'), true);
    assert.equal(isTrivialDiffLine('+using UnityEngine;'), true);
    assert.equal(isTrivialDiffLine('+    public class Foo {}'), false);
  });

  it('rejects comment-only hunks', () => {
    const diff = ['--- a/A.cs', '+++ b/A.cs', '@@ -1 +1 @@', '+// note', '-// old'].join('\n');
    assert.equal(diffHasMeaningfulEdits(diff), false);
    assert.equal(diffHasMeaningfulEdits(`${diff}\n+public class X {}`), true);
  });
});

describe('parseJudgeVerdict', () => {
  it('reads fenced JSON', () => {
    const parsed = parseJudgeVerdict('설명\n```json\n{"ok": false, "reasons": ["키를 안 바꿈"], "criteria": []}\n```\n');
    assert.equal(parsed?.ok, false);
    assert.deepEqual(parsed?.reasons, ['키를 안 바꿈']);
  });

  it('reads last JSON object', () => {
    const parsed = parseJudgeVerdict('noise {"ok": true, "reasons": [], "criteria": []}');
    assert.equal(parsed?.ok, true);
  });

  it('returns null when there is no verdict', () => {
    assert.equal(parseJudgeVerdict('그냥 잘 된 것 같습니다'), null);
  });

  it('rejects ok without per-criterion evidence', () => {
    const parsed = parseJudgeVerdict('{"ok": true, "reasons": [], "criteria": []}');
    const finalized = finalizeJudgeVerdict(parsed, ['IGameState 가 있다']);
    assert.equal(finalized.ok, false);
  });

  it('rejects a criterion that is ok without a file path', () => {
    const parsed = parseJudgeVerdict(
      JSON.stringify({
        ok: true,
        reasons: [],
        criteria: [{ index: 0, ok: true, evidence: '잘 구현됨', note: '' }],
      }),
    );
    const finalized = finalizeJudgeVerdict(parsed, ['IGameState 가 있다']);
    assert.equal(finalized.ok, false);
    assert.equal(finalized.reasons.some((item) => item.includes('파일 경로')), true);
  });

  it('passes when every criterion has path evidence', () => {
    const parsed = parseJudgeVerdict(
      JSON.stringify({
        ok: true,
        reasons: [],
        criteria: [{ index: 0, ok: true, evidence: 'Assets/Scripts/Gameplay/StateMachine/IGameState.cs:3', note: 'interface' }],
      }),
    );
    const finalized = finalizeJudgeVerdict(parsed, ['IGameState 가 있다']);
    assert.equal(finalized.ok, true);
  });

  it('accepts server/ evidence with a line suffix when the file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-ev-'));
    fs.mkdirSync(path.join(dir, 'server', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'src', 'Program.cs'), 'class Program {}\n');
    assert.equal(extractEvidenceRelPath('server/src/Program.cs:17'), 'server/src/Program.cs');
    const parsed = parseJudgeVerdict(
      JSON.stringify({
        ok: true,
        reasons: [],
        criteria: [{ index: 0, ok: true, evidence: 'server/src/Program.cs:17', note: 'gateway' }],
      }),
    );
    const finalized = finalizeJudgeVerdict(parsed, ['server/ 에 게이트웨이가 있다'], dir);
    assert.equal(finalized.ok, true);
  });
});
