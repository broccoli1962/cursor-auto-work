import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  editorMatchesProject,
  parseCliStdout,
  parseConnectedEditors,
  parseEditorPlaying,
  parsePipelineInstalled,
  parsePipelineTest,
  parseStatusToken,
  planUnityCliInstall,
  recompilePhase,
  unityCliMissingHelp,
} from './unityCli';

describe('planUnityCliInstall', () => {
  it('keeps an existing CLI', () => {
    assert.equal(planUnityCliInstall({ present: true, mode: 'ask', interactive: false, confirmed: false }), 'ready');
  });

  it('installs when the mode is yes', () => {
    assert.equal(planUnityCliInstall({ present: false, mode: 'yes', interactive: false, confirmed: false }), 'install');
  });

  it('refuses when the mode is no', () => {
    assert.equal(planUnityCliInstall({ present: false, mode: 'no', interactive: true, confirmed: true }), 'refuse');
  });

  it('installs only after an interactive yes', () => {
    assert.equal(planUnityCliInstall({ present: false, mode: 'ask', interactive: true, confirmed: true }), 'install');
    assert.equal(planUnityCliInstall({ present: false, mode: 'ask', interactive: true, confirmed: false }), 'refuse');
    assert.equal(planUnityCliInstall({ present: false, mode: 'ask', interactive: false, confirmed: false }), 'refuse');
  });
});

describe('parseCliStdout', () => {
  it('reads a JSON envelope after a banner line', () => {
    const payload = parseCliStdout('Unity CLI\n{"success":true,"command":"status","data":{"ok":1}}');
    assert.deepEqual(payload, { success: true, command: 'status', data: { ok: 1 } });
  });

  it('ignores text after the JSON object', () => {
    const payload = parseCliStdout('note {"success":true,"data":{"status":"ready"}} trailing');
    assert.deepEqual(payload, { success: true, data: { status: 'ready' } });
  });
});

describe('parseConnectedEditors', () => {
  it('reads project, port, and state from a status envelope', () => {
    const editors = parseConnectedEditors({
      success: true,
      command: 'status',
      data: {
        editors: [
          { port: 7800, state: 'ready', projectPath: 'D:\\Games\\Demo', pid: 42 },
          { port: 7801, state: 'disconnected', projectPath: 'D:\\Games\\Other', pid: 7 },
        ],
      },
    });
    assert.equal(editors.length, 2);
    assert.equal(editorMatchesProject(editors[0]!, 'D:/Games/Demo'), true);
    assert.equal(editors[0]?.port, 7800);
  });
});

describe('recompilePhase', () => {
  it('treats completed and up-to-date as done, and failed as an error', () => {
    assert.equal(recompilePhase('completed'), 'ok');
    assert.equal(recompilePhase('up-to-date'), 'ok');
    assert.equal(recompilePhase('failed'), 'fail');
    assert.equal(recompilePhase('compiling'), 'wait');
  });
});

describe('parseStatusToken', () => {
  it('reads a JSON string payload', () => {
    assert.equal(parseStatusToken({ success: true, command: 'recompile_status', data: '{"status":"up_to_date"}' }), 'up_to_date');
  });
});

describe('parseEditorPlaying', () => {
  it('reads isPlaying from editor_status', () => {
    assert.equal(parseEditorPlaying({ success: true, data: { isPlaying: true, projectPath: 'D:\\Games\\Demo' } }), true);
    assert.equal(parseEditorPlaying({ data: { playMode: 'Stopped' } }), false);
  });
});

describe('parsePipelineInstalled', () => {
  it('reads human and JSON install state', () => {
    assert.equal(parsePipelineInstalled(undefined, 'Pipeline: Installed'), true);
    assert.equal(parsePipelineInstalled({ data: { pipeline: 'Not installed' } }, ''), false);
  });
});

describe('parsePipelineTest', () => {
  it('marks a completed run with failures as done and not ok', () => {
    const parsed = parsePipelineTest({
      success: true,
      data: {
        status: 'completed',
        passed: 2,
        failed: 1,
        total: 3,
        failedTests: [{ name: 'MenuTests.Open', message: 'expected true' }],
      },
    });
    assert.equal(parsed.done, true);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.failures[0]?.name, 'MenuTests.Open');
  });

  it('keeps a running job unfinished', () => {
    const parsed = parsePipelineTest({ data: { status: 'running', passed: 0, failed: 0, total: 4 } });
    assert.equal(parsed.done, false);
  });
});

describe('unityCliMissingHelp', () => {
  it('includes the Windows install script and the opt-in flag', () => {
    const help = unityCliMissingHelp();
    assert.match(help, /install\.ps1/);
    assert.match(help, /--install-unity-cli/);
  });
});
