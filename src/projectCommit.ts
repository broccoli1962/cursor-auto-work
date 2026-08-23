import type { CommitLanguage, RoadmapStep } from './types';

export const COMMIT_AREA_IDS = [
  'data',
  'rules',
  'system',
  'test',
  'server',
  'ui',
  'popup',
  'fx',
  'resource',
  'docs',
  'skill',
  'submodule',
] as const;

export type CommitAreaId = (typeof COMMIT_AREA_IDS)[number];

const AREA_LABEL: Record<CommitLanguage, Record<CommitAreaId, string>> = {
  ko: {
    data: '데이터',
    rules: '룰',
    system: '시스템',
    test: '테스트',
    server: '서버',
    ui: 'UI',
    popup: '팝업',
    fx: '연출',
    resource: '리소스',
    docs: '문서',
    skill: '스킬',
    submodule: '서브모듈',
  },
  en: {
    data: 'Data',
    rules: 'Rules',
    system: 'System',
    test: 'Test',
    server: 'Server',
    ui: 'UI',
    popup: 'Popup',
    fx: 'FX',
    resource: 'Resource',
    docs: 'Docs',
    skill: 'Skill',
    submodule: 'Submodule',
  },
};

export interface CommitCluster {
  area: CommitAreaId;
  files: string[];
  subject: string;
}

const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|secrets?\.json|.*\.pem|.*\.p12|id_rsa)$/i;
const LABELED_SUBJECT = /^([가-힣A-Za-z0-9]+)\s+-\s+(.+)$/;
const KO_SENTENCE_END = /(한다|합니다|됩니다)\.?$/;
const EN_SENTENCE_END = /\b(is|are|was|were|does|do)\b|[.]$/i;
const CONV_COMMIT = /^(?:feat|fix|docs|chore|test|refactor|style|perf)\s*:\s*(?:add\s+)?(.+)$/i;

export function areaLabel(area: CommitAreaId, language: CommitLanguage): string {
  return AREA_LABEL[language][area];
}

export function isSecretCommitPath(relPath: string): boolean {
  return SECRET_FILE.test(relPath.replace(/\\/g, '/'));
}

export function filterSecretCommitFiles(files: string[]): {
  files: string[];
  skippedSecrets: string[];
} {
  const kept: string[] = [];
  const skippedSecrets: string[] = [];
  for (const file of files) {
    if (isSecretCommitPath(file)) skippedSecrets.push(file);
    else kept.push(file);
  }
  return { files: kept, skippedSecrets };
}

export function areaForFile(relPath: string): CommitAreaId {
  const file = relPath.replace(/\\/g, '/');

  if (/(^|\/)\.cursor\/(skills|rules)\//.test(file)) return 'skill';
  if (/(^|\/)Docs\/|\.md$/i.test(file) && !/(^|\/)Assets\//.test(file)) return 'docs';
  if (/(^|\/)Tests\//.test(file)) return 'test';
  if (/^server\//.test(file)) return 'server';
  if (/(^|\/)Scripts\/Rules\/|Game\.Rules/.test(file)) return 'rules';
  if (/(^|\/)Object\/UI\/Popup|(^|\/)Popup\//.test(file)) return 'popup';
  if (/(^|\/)Object\/UI\/|(^|\/)Prefab\/UI\//.test(file)) return 'ui';
  if (/\.(png|jpe?g|gif|webp|tga|psd|aseprite|wav|mp3|ogg|fbx)$/i.test(file)) return 'resource';
  if (/(^|\/)Data\/Cards\//.test(file)) return 'resource';
  if (/(^|\/)Data\/|(^|\/)AddressableAssetsData\//.test(file)) return 'data';
  if (/(^|\/)submodules?\//.test(file)) return 'submodule';
  return 'system';
}

function isSentenceEnd(phrase: string, language: CommitLanguage): boolean {
  const trimmed = phrase.trim();
  return language === 'ko' ? KO_SENTENCE_END.test(trimmed) : EN_SENTENCE_END.test(trimmed);
}

function changePhrase(step: RoadmapStep, language: CommitLanguage): string {
  const existing = step.commitMessage?.trim() ?? '';
  const labeled = existing.match(LABELED_SUBJECT);
  if (labeled?.[2] && !isSentenceEnd(labeled[2], language)) return labeled[2].trim();

  if (language === 'en') {
    const conventional = existing.match(CONV_COMMIT);
    if (conventional?.[1]) return conventional[1].trim();
  }

  const why = step.title.replace(/\s+/g, ' ').trim();
  if (language === 'ko') {
    return /(추가|구현|반영|정리|수정)$/.test(why) ? why : `${why} 구현`;
  }
  return /(add|added|implement|implemented|fix|fixed|update|updated)$/i.test(why)
    ? why
    : `${why} implemented`;
}

export function buildCommitSubject(
  area: CommitAreaId,
  step: RoadmapStep,
  language: CommitLanguage,
): string {
  return `${areaLabel(area, language)} - ${changePhrase(step, language)}`;
}

export function isValidCommitSubject(subject: string, language: CommitLanguage): boolean {
  const first = subject.trim().split(/\r?\n/, 1)[0] ?? '';
  if (!LABELED_SUBJECT.test(first)) return false;
  if (isSentenceEnd(first, language)) return false;
  if (/^(feat|fix|docs|chore|test|refactor|style|perf)[!:(]/i.test(first)) return false;
  return true;
}

/** 관심사별로 묶어 데이터 → 로직 → UI → 리소스 순으로 커밋한다. */
export function clusterCommitFiles(
  files: string[],
  step: RoadmapStep,
  language: CommitLanguage,
): CommitCluster[] {
  const buckets = new Map<CommitAreaId, string[]>();
  for (const file of files) {
    const area = areaForFile(file);
    const list = buckets.get(area) ?? [];
    list.push(file);
    buckets.set(area, list);
  }

  return COMMIT_AREA_IDS.filter((area) => buckets.has(area)).map((area) => ({
    area,
    files: buckets.get(area) ?? [],
    subject: buildCommitSubject(area, step, language),
  }));
}
