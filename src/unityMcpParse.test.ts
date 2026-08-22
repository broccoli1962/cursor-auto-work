import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEditorState, unwrapToolResult } from './unityMcp';
import { extractConsoleText, parseCompileErrors, parseMcpTestJob } from './unityValidator';

describe('unwrapToolResult', () => {
  it('parses MCP text content JSON', () => {
    const parsed = unwrapToolResult({
      content: [{ type: 'text', text: '{"job_id":"abc"}' }],
    });
    assert.deepEqual(parsed, { job_id: 'abc' });
  });

  it('throws on isError', () => {
    assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] }), /nope/);
  });
});

describe('parseEditorState', () => {
  it('reads nested advice.ready_for_tools', () => {
    const state = parseEditorState({
      data: { is_compiling: false, is_playing: true, advice: { ready_for_tools: false, recommended_retry_after_ms: 1500 } },
    });
    assert.equal(state.ready, false);
    assert.equal(state.playing, true);
    assert.equal(state.retryMs, 1500);
  });
});

describe('extractConsoleText + parseCompileErrors', () => {
  it('finds CS errors in structured console JSON', () => {
    const text = extractConsoleText({
      messages: [
        { type: 'error', message: "Assets/Foo.cs(12,5): error CS0103: The name 'x' does not exist" },
        { type: 'error', message: 'Unrelated editor error' },
      ],
    });
    const errors = parseCompileErrors(text);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'CS0103');
    assert.equal(errors[0]?.file, 'Assets/Foo.cs');
  });
});

describe('parseMcpTestJob', () => {
  it('maps failed_tests into UnityTestResult', () => {
    const parsed = parseMcpTestJob({
      status: 'complete',
      results: { total: 3, passed: 2, failed: 1 },
      failed_tests: [{ name: 'EventBusTests.Unsub', message: 'expected no invoke' }],
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.passed, 2);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.failures[0]?.name, 'EventBusTests.Unsub');
  });

  it('passes when no failures', () => {
    const parsed = parseMcpTestJob({ status: 'complete', results: { total: 2, passed: 2, failed: 0 } });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.total, 2);
  });
});
