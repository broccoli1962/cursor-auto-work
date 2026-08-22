import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadRoadmap, RoadmapError } from './roadmap';

describe('loadRoadmap', () => {
  it('loads the sample roadmap without verify blocks', () => {
    const roadmap = loadRoadmap(path.join(__dirname, '..', 'docs', 'roadmap.json'));
    assert.equal(roadmap.steps.length, 5);
    assert.equal(
      roadmap.steps.every((step) => step.verify === undefined),
      true,
    );
    assert.ok((roadmap.steps[0]?.targetFiles?.length ?? 0) > 0);
    assert.ok((roadmap.steps[0]?.acceptanceCriteria?.length ?? 0) > 0);
  });

  it('rejects invalid check type', () => {
    const file = path.join(os.tmpdir(), `roadmap-bad-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        project: 't',
        steps: [{ id: 1, task: 'x', verify: { checks: [{ type: 'magic', path: 'A.cs' }] } }],
      }),
    );
    try {
      assert.throws(() => loadRoadmap(file), RoadmapError);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
