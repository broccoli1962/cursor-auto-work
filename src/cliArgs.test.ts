import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs } from './cliArgs';

describe('parseArgs', () => {
  it('accepts flags before the command', () => {
    const parsed = parseArgs(['--project', 'D:\\Game', 'run', '--from', '3']);
    assert.equal(parsed.command, 'run');
    assert.equal(parsed.flags.project, 'D:\\Game');
    assert.equal(parsed.flags.from, '3');
  });

  it('defaults to run when only flags are given', () => {
    const parsed = parseArgs(['--validation', 'lint']);
    assert.equal(parsed.command, 'run');
    assert.equal(parsed.flags.validation, 'lint');
  });

  it('treats boolean flags without consuming the command', () => {
    const parsed = parseArgs(['--debug', 'doctor']);
    assert.equal(parsed.command, 'doctor');
    assert.equal(parsed.flags.debug, true);
  });
});
