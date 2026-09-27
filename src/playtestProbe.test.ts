import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateProbe, parseProbeDump, parseProbeReport } from './playtestProbe';

function sample(
  events: string[],
  y: number,
  extras?: { active?: boolean; text?: string },
): import('./types').ProbeSample {
  return {
    events,
    objects: {
      Player: { found: true, active: true, x: 0, y, z: 0 },
      Menu: { found: true, active: extras?.active ?? false, x: 0, y: 0, z: 0 },
    },
    texts: { Score: { found: true, text: extras?.text ?? '0' } },
    position: { found: true, x: 0, y, z: 0 },
  };
}

describe('evaluateProbe', () => {
  const baseline = sample([], 0);
  const control = sample([], 0);

  it('passes on the peak even if the body has landed', () => {
    const result = evaluateProbe({
      baseline,
      control,
      traces: [sample(['JumpStarted'], 1.4), sample(['JumpStarted', 'Landed'], 0.1)],
      probe: {
        events: ['JumpStarted', 'Landed'],
        position: { object: 'Player', axis: 'y', deltaMin: 1 },
        active: { object: 'Menu', equals: true },
        text: { object: 'Score', contains: '1' },
      },
    });
    assert.equal(
      evaluateProbe({
        baseline,
        control,
        traces: [
          sample(['JumpStarted'], 1.4, { active: true, text: '1' }),
          sample(['JumpStarted', 'Landed'], 0.1, { active: true, text: '1' }),
        ],
        probe: {
          events: ['JumpStarted', 'Landed'],
          position: { object: 'Player', axis: 'y', deltaMin: 1 },
          active: { object: 'Menu', equals: true },
          text: { object: 'Score', contains: '1' },
        },
      }).ok,
      true,
    );
    assert.equal(result.ok, false);
  });

  it('fails when the change already happened before input', () => {
    const result = evaluateProbe({
      baseline,
      control: sample(['JumpStarted', 'Landed'], 1.4, { active: true, text: '1' }),
      traces: [sample(['JumpStarted', 'Landed'], 1.4, { active: true, text: '1' })],
      probe: {
        events: ['Landed'],
        position: { object: 'Player', axis: 'y', deltaMin: 1 },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.note, /입력 전/);
  });
});

describe('pooled objects', () => {
  function pooled(activeId: number | undefined, y: number): import('./types').ProbeSample {
    return {
      events: [],
      objects: {
        Bullet: {
          found: true,
          active: activeId !== undefined,
          x: 0,
          y,
          z: 0,
          instances: [
            { id: 1, active: false, x: 0, y: 0, z: 0 },
            { id: 2, active: activeId === 2, x: 0, y: activeId === 2 ? y : 0, z: 0 },
          ],
        },
      },
      texts: {},
    };
  }

  it('follows one inactive clone after it leaves the pool', () => {
    const result = evaluateProbe({
      baseline: pooled(undefined, 0),
      control: pooled(undefined, 0),
      traces: [pooled(2, 2), pooled(undefined, 0)],
      probe: {
        position: { object: 'Bullet', axis: 'y', deltaMin: 1 },
        active: { object: 'Bullet', equals: true },
      },
    });
    assert.equal(result.ok, true);
  });

  it('keeps every clone of a watched name', () => {
    const sample = parseProbeReport(
      '{"events":"","objects":[{"name":"Bullet","id":1,"found":true,"active":false,"x":0,"y":0,"z":0},{"name":"Bullet","id":2,"found":true,"active":true,"x":0,"y":3,"z":0}],"texts":[]}',
    );
    assert.equal(sample?.objects.Bullet?.instances?.length, 2);
    assert.equal(sample?.objects.Bullet?.instances?.[0]?.active, false);
    assert.equal(sample?.objects.Bullet?.active, true);
    assert.equal(sample?.objects.Bullet?.y, 3);
  });
});

describe('parseProbeDump', () => {
  it('reads the eval dump line', () => {
    const sample = parseProbeDump('banner\ntrue|0|1.5|2|JumpStarted,Landed\n');
    assert.equal(sample?.position?.found, true);
    assert.equal(sample?.position?.y, 1.5);
    assert.deepEqual(sample?.events, ['JumpStarted', 'Landed']);
  });
});
