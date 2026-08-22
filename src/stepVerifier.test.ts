import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { inScope } from './gitManager';
import {
  formatVerifyFeedback,
  globMatch,
  resolveVerifyScope,
  runVerifyChecks,
  shouldRequireChanges,
} from './stepVerifier';
import type { RoadmapStep } from './types';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  temps.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('globMatch', () => {
  it('matches ** and extension', () => {
    assert.equal(globMatch('Assets/Scripts/UI/MainMenu/A.cs', 'Assets/Scripts/UI/**/*.cs'), true);
    assert.equal(globMatch('Assets/Scripts/UI/A.txt', 'Assets/Scripts/UI/**/*.cs'), false);
  });
});

describe('inScope', () => {
  it('treats directory prefix as inclusive', () => {
    assert.equal(inScope('Assets/Scripts/UI/MainMenu/A.cs', ['Assets/Scripts/UI']), true);
    assert.equal(inScope('Assets/Scripts/Core/A.cs', ['Assets/Scripts/UI']), false);
    assert.equal(inScope('Assets/Scripts/UI', ['Assets/Scripts/UI']), true);
  });
});

describe('runVerifyChecks', () => {
  it('exists / contains / notContains / globMin / jsonField / csNoUnityEngine', () => {
    const root = tempDir();
    write(root, 'Assets/Scripts/UI/MainMenu/MainMenuPresenter.cs', 'namespace Game.UI { public class MainMenuPresenter {} }\n');
    write(root, 'Assets/Scripts/Gameplay/Gameplay.asmdef', '{"name":"Gameplay","references":["Core"]}\n');
    write(root, 'Assets/Scripts/Gameplay/StateMachine/BootState.cs', 'class BootState {}\n');

    const results = runVerifyChecks(root, [
      { type: 'exists', path: 'Assets/Scripts/UI/MainMenu/MainMenuPresenter.cs' },
      { type: 'exists', path: 'Assets/Missing.cs' },
      { type: 'contains', path: 'Assets/Scripts/UI/MainMenu/MainMenuPresenter.cs', pattern: 'class\\s+MainMenuPresenter' },
      { type: 'notContains', glob: 'Assets/Scripts/UI/**/*.cs', pattern: 'Resources\\.Load' },
      { type: 'globMin', glob: 'Assets/Scripts/Gameplay/StateMachine/**/*.cs', min: 1 },
      { type: 'jsonField', path: 'Assets/Scripts/Gameplay/Gameplay.asmdef', field: 'references', contains: 'Core' },
      { type: 'csNoUnityEngine', path: 'Assets/Scripts/UI/MainMenu/MainMenuPresenter.cs' },
    ]);

    assert.deepEqual(
      results.map((item) => item.ok),
      [true, false, true, true, true, true, true],
    );
  });

  it('fails csNoUnityEngine on using UnityEngine', () => {
    const root = tempDir();
    write(root, 'P.cs', 'using UnityEngine;\nclass P {}\n');
    const [result] = runVerifyChecks(root, [{ type: 'csNoUnityEngine', path: 'P.cs' }]);
    assert.equal(result?.ok, false);
  });

  it('formats failed checks for agent feedback', () => {
    const text = formatVerifyFeedback([
      { ok: false, type: 'exists', target: 'A.cs', message: '경로가 없습니다.' },
      { ok: true, type: 'exists', target: 'B.cs', message: '존재함' },
    ]);
    assert.match(text, /\[exists\] A\.cs/);
    assert.doesNotMatch(text, /B\.cs/);
  });
});

describe('verify policy', () => {
  const step: RoadmapStep = {
    id: 1,
    title: 't',
    task: 'do',
    targetFiles: ['Assets/Scripts/UI'],
  };

  it('defaults requireChanges to true unless force-rerun', () => {
    assert.equal(shouldRequireChanges(step, false), true);
    assert.equal(shouldRequireChanges(step, true), false);
    assert.equal(shouldRequireChanges({ ...step, verify: { requireChanges: true } }, true), true);
  });

  it('uses targetFiles as default scope', () => {
    assert.deepEqual(resolveVerifyScope(step), ['Assets/Scripts/UI']);
    assert.equal(resolveVerifyScope({ ...step, verify: { scope: 'all' } }), undefined);
  });
});
