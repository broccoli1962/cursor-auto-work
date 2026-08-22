import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStructuredAgentSummary, summarizeAgentOutput } from './memoryManager';
import { budgetText } from './textBudget';
import { extractUsage } from './cursorRunner';
import { resolveUnityTools, toolNamesFromList } from './unityTools';

describe('parseStructuredAgentSummary', () => {
  it('reads SUMMARY/FILES/NEXT', () => {
    const parsed = parseStructuredAgentSummary(
      'noise\nSUMMARY: MainMenuPresenter 추가\nFILES: Assets/Scripts/UI/MainMenu.cs, Assets/Prefabs/UI/MainMenu.prefab\nNEXT: Addressables 그룹 연결\n',
    );
    assert.ok(parsed);
    assert.equal(parsed?.summary[0], 'MainMenuPresenter 추가');
    assert.match(parsed?.files[0] ?? '', /MainMenu/);
    assert.match(parsed?.next[0] ?? '', /Addressables/);
  });

  it('prefers structured lines in summarizeAgentOutput', () => {
    const lines = summarizeAgentOutput({
      exitCode: 0,
      assistantText: 'I did some work.\nSUMMARY: GameStateMachine 구현 완료\nFILES: Assets/Scripts/Core/GameStateMachine.cs\nNEXT: Menu 상태 연결\n',
      toolCalls: [],
      timedOut: false,
      stderr: '',
      durationMs: 1,
    });
    assert.ok(lines.some((line) => line.includes('GameStateMachine')));
  });
});

describe('budgetText', () => {
  it('keeps head and tail and mentions omitted count', () => {
    const text = `${'A'.repeat(80)}MIDDLE${'B'.repeat(80)}`;
    const out = budgetText(text, 100, '기획서');
    assert.ok(out.startsWith('A'));
    assert.ok(out.endsWith('B'));
    assert.match(out, /생략/);
  });
});

describe('extractUsage', () => {
  it('reads input/output tokens from a result event', () => {
    const usage = extractUsage({
      type: 'result',
      usage: { input_tokens: 120, output_tokens: 40 },
    });
    assert.deepEqual(usage, { inputTokens: 120, outputTokens: 40 });
  });
});

describe('resolveUnityTools', () => {
  it('matches aliases and prefixed names', () => {
    const names = toolNamesFromList({
      tools: [{ name: 'refresh_unity' }, { name: 'mcp_unity_read_console' }, { name: 'run_tests' }],
    });
    const { resolved, missingRequired } = resolveUnityTools(names);
    assert.equal(resolved.refresh, 'refresh_unity');
    assert.equal(resolved.readConsole, 'mcp_unity_read_console');
    assert.equal(resolved.runTests, 'run_tests');
    assert.deepEqual(missingRequired, []);
  });

  it('reports missing required tools', () => {
    const { missingRequired } = resolveUnityTools(['manage_editor']);
    assert.ok(missingRequired.includes('refresh'));
    assert.ok(missingRequired.includes('readConsole'));
  });
});
