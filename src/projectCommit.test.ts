import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  areaForFile,
  areaLabel,
  buildCommitSubject,
  clusterCommitFiles,
  filterSecretCommitFiles,
  isValidCommitSubject,
} from './projectCommit';
import type { RoadmapStep } from './types';

const step: RoadmapStep = {
  id: 20,
  title: 'Aseprite 카드 아트와 CardView 적용',
  task: '카드를 그린다',
  commitMessage: 'feat: add Aseprite card art and CardView sprites',
};

describe('areaForFile', () => {
  it('maps project paths to commit areas', () => {
    assert.equal(areaForFile('Assets/GameResource/Scripts/Rules/RuleEngine.cs'), 'rules');
    assert.equal(areaForFile('Assets/GameResource/Scripts/Object/UI/Match/CardView.cs'), 'ui');
    assert.equal(areaForFile('Assets/GameResource/Data/Cards/S_A.png'), 'resource');
    assert.equal(areaForFile('Assets/Tests/EditMode/OfficialRulesTests.cs'), 'test');
    assert.equal(areaForFile('server/src/Gateway.cs'), 'server');
    assert.equal(areaForFile('Docs/spec.md'), 'docs');
  });
});

describe('commit subject language', () => {
  it('builds Korean {영역} - {제목} 구현 by default', () => {
    const subject = buildCommitSubject('resource', step, 'ko');
    assert.equal(subject, '리소스 - Aseprite 카드 아트와 CardView 적용 구현');
    assert.equal(isValidCommitSubject(subject, 'ko'), true);
    assert.equal(isValidCommitSubject('feat: add cards', 'ko'), false);
    assert.equal(isValidCommitSubject('룰 - LegalMove를 추가한다', 'ko'), false);
  });

  it('builds English {Area} - {phrase} when language is en', () => {
    const subject = buildCommitSubject('resource', step, 'en');
    assert.equal(subject, 'Resource - Aseprite card art and CardView sprites');
    assert.equal(areaLabel('rules', 'en'), 'Rules');
    assert.equal(isValidCommitSubject(subject, 'en'), true);
  });

  it('keeps an already-valid labeled commitMessage and swaps the area', () => {
    const labeled: RoadmapStep = {
      ...step,
      commitMessage: '룰 - LegalMove Official 합법 수 추가',
    };
    assert.equal(buildCommitSubject('ui', labeled, 'ko'), 'UI - LegalMove Official 합법 수 추가');
  });
});

describe('clusterCommitFiles', () => {
  it('always splits mixed UI and resource files', () => {
    const clusters = clusterCommitFiles(
      [
        'Assets/GameResource/Data/Cards/BACK.png',
        'Assets/GameResource/Scripts/Object/UI/Match/CardView.cs',
      ],
      step,
      'ko',
    );
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0]?.area, 'ui');
    assert.equal(clusters[1]?.area, 'resource');
    assert.equal(clusters[0]?.subject.startsWith('UI - '), true);
    assert.equal(clusters[1]?.subject.startsWith('리소스 - '), true);
  });
});

describe('filterSecretCommitFiles', () => {
  it('drops .env and credentials', () => {
    const { files, skippedSecrets } = filterSecretCommitFiles([
      'Assets/Foo.cs',
      '.env',
      'credentials.json',
    ]);
    assert.deepEqual(files, ['Assets/Foo.cs']);
    assert.equal(skippedSecrets.length, 2);
  });
});
