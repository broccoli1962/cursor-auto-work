import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { autonomyBudgetSpent, formatBudget } from './autonomy';
import { extractCapturePath, framesChanged, parsePlaytestInput, playtestRelPath } from './playtest';

describe('autonomy budget', () => {
  it('stops once the elapsed time reaches the budget', () => {
    assert.equal(autonomyBudgetSpent(1_000, 5_000, 4_000), true);
    assert.equal(autonomyBudgetSpent(1_000, 4_999, 4_000), false);
  });

  it('formats multi-hour budgets in hours', () => {
    assert.equal(formatBudget(4 * 60 * 60 * 1000), '4시간');
    assert.equal(formatBudget(90 * 60 * 1000), '90분');
  });
});

describe('extractCapturePath', () => {
  it('reads a path from a CLI data envelope', () => {
    const payload = { success: true, command: 'capture_game_view', data: { path: 'Logs/playtest/cycle-1.png' } };
    assert.equal(extractCapturePath(payload), 'Logs/playtest/cycle-1.png');
  });

  it('builds a before/after path per cycle', () => {
    assert.equal(playtestRelPath(3, 'before'), 'Logs/playtest/cycle-3-before.png');
    assert.equal(playtestRelPath(3), 'Logs/playtest/cycle-3-after.png');
  });
});

describe('framesChanged', () => {
  it('rejects identical frames and accepts a visible difference', () => {
    const still = Buffer.alloc(8000, 1);
    assert.equal(framesChanged(still, Buffer.from(still)), false);
    const moved = Buffer.from(still);
    for (let i = 0; i < moved.length; i += 10) moved[i] = 9;
    assert.equal(framesChanged(still, moved), true);
  });
});

describe('parsePlaytestInput', () => {
  it('turns a script into key, click, and wait actions', () => {
    const parsed = parsePlaytestInput('click:640,360; key:W:down; wait:400; key:W:up; move:10,20');
    assert.equal(parsed.disabled, false);
    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(parsed.actions, [
      { type: 'pointer', x: 640, y: 360, action: 'click', button: 'left' },
      { type: 'key', key: 'W', action: 'down' },
      { type: 'wait', ms: 400 },
      { type: 'key', key: 'W', action: 'up' },
      { type: 'pointer', x: 10, y: 20, action: 'move', button: 'left' },
    ]);
  });

  it('disables input when the script is none', () => {
    assert.equal(parsePlaytestInput('none').disabled, true);
    assert.equal(parsePlaytestInput('off').actions.length, 0);
  });

  it('keeps valid actions and reports a bad token', () => {
    const parsed = parsePlaytestInput('key:Space; key:has space; click:-1,2');
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0]?.type, 'key');
    assert.equal(parsed.errors.length, 2);
  });
});
