import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyOrchestratorEnv } from './config';

describe('classifyOrchestratorEnv', () => {
  it('flags removed keys and ignores Cursor CLI passthrough', () => {
    const result = classifyOrchestratorEnv([
      'AUTONOMY_PLAYTEST_INPUT',
      'SKIP_VALIDATION',
      'CURSOR_API_KEY',
      'PATH',
      'CURSOR_MODEL',
    ]);
    assert.deepEqual(result.removed.sort(), ['AUTONOMY_PLAYTEST_INPUT', 'SKIP_VALIDATION']);
    assert.deepEqual(result.unknown, []);
  });

  it('flags an orchestrator-looking key that nothing reads', () => {
    const result = classifyOrchestratorEnv(['UNITY_MCP_PORT', 'GOAL']);
    assert.deepEqual(result.unknown, ['UNITY_MCP_PORT']);
  });
});
