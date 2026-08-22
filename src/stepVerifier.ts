import fs from 'node:fs';
import path from 'node:path';

import type { CheckResult, RoadmapStep, VerifyCheck, VerifyCheckType } from './types';
import {
  assetGuid,
  findScriptGuid,
  inspectPrefabYaml,
  listAddressableEntries,
  prefabHasContent,
} from './unityAssetInspect';

const SKIP_DIR_NAMES = new Set([
  '.git',
  'library',
  'temp',
  'obj',
  'logs',
  'runtime',
  'node_modules',
  'usersettings',
  'build',
  'builds',
]);

export function shouldRequireChanges(step: RoadmapStep, forceRerun: boolean): boolean {
  if (step.verify?.requireChanges !== undefined) return step.verify.requireChanges;
  return !forceRerun;
}

/** targetFiles 를 기본 범위로 쓰고, verify.scope=all 이면 제한을 푼다. */
export function resolveVerifyScope(step: RoadmapStep): string[] | undefined {
  if (step.verify?.scope === 'all') return undefined;
  if (step.targetFiles && step.targetFiles.length > 0) return step.targetFiles;
  return undefined;
}

export function posixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * `*` = 슬래시 제외, `**` = 경로 전체.
 * 패턴은 posix 기준이다.
 */
export function globMatch(relPath: string, pattern: string): boolean {
  const normalized = posixPath(relPath);
  const pat = posixPath(pattern);
  return globToRegExp(pat).test(normalized);
}

function globToRegExp(glob: string): RegExp {
  let i = 0;
  let out = '^';

  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob[i] === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 2;
      continue;
    }
    const char = glob[i] ?? '';
    if (char === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('[.+$()|{}]'.includes(char)) {
      out += `\\${char}`;
      i += 1;
      continue;
    }
    out += char;
    i += 1;
  }

  return new RegExp(`${out}$`);
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

function resolveUnder(projectRoot: string, rel: string): string {
  const combined = path.resolve(projectRoot, rel);
  const root = path.resolve(projectRoot);
  if (combined !== root && !combined.startsWith(`${root}${path.sep}`)) {
    throw new Error(`프로젝트 밖 경로는 검사할 수 없습니다: ${rel}`);
  }
  return combined;
}

function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

/** projectRoot 기준 posix 상대경로 목록 */
export function listProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.cursorrules') {
        if (entry.isDirectory() && isSkippedDir(entry.name)) continue;
        if (entry.isDirectory() && entry.name === '.git') continue;
      }
      if (entry.isDirectory() && isSkippedDir(entry.name)) continue;

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push(rel.replace(/\\/g, '/'));
    }
  };

  walk(projectRoot, '');
  return files;
}

export function matchGlobFiles(projectRoot: string, glob: string): string[] {
  return listProjectFiles(projectRoot).filter((file) => globMatch(file, glob));
}

function readText(projectRoot: string, rel: string): { ok: true; text: string } | { ok: false; error: string } {
  const abs = resolveUnder(projectRoot, rel);
  if (!fs.existsSync(abs)) return { ok: false, error: '파일이 없습니다.' };
  if (fs.statSync(abs).isDirectory()) return { ok: false, error: '디렉터리입니다. 파일 경로가 필요합니다.' };
  try {
    const raw = fs.readFileSync(abs);
    if (raw.includes(0)) return { ok: false, error: '바이너리 파일은 내용 검사 대상이 아닙니다.' };
    return { ok: true, text: raw.toString('utf8') };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function result(
  type: CheckResult['type'],
  target: string,
  ok: boolean,
  message: string,
): CheckResult {
  return { ok, type, target, message };
}

function asStringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function getJsonField(root: unknown, field: string): unknown {
  const parts = field.split('.').filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function flattenJsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object' && 'reference' in item) {
        const ref = (item as { reference?: unknown }).reference;
        return typeof ref === 'string' ? [ref] : [];
      }
      return [];
    });
  }
  return [];
}

function checkExists(projectRoot: string, check: VerifyCheck): CheckResult {
  const rel = check.path ?? '';
  const abs = resolveUnder(projectRoot, rel);
  const ok = fs.existsSync(abs);
  return result('exists', rel, ok, ok ? '존재함' : '경로가 없습니다.');
}

function checkNotExists(projectRoot: string, check: VerifyCheck): CheckResult {
  const rel = check.path ?? '';
  const abs = resolveUnder(projectRoot, rel);
  const exists = fs.existsSync(abs);
  return result('notExists', rel, !exists, exists ? '아직 존재합니다.' : '없음');
}

function checkGlobMin(projectRoot: string, check: VerifyCheck): CheckResult {
  const glob = check.glob ?? '';
  const min = check.min ?? 1;
  const matches = matchGlobFiles(projectRoot, glob);
  const ok = matches.length >= min;
  return result(
    'globMin',
    glob,
    ok,
    ok
      ? `${matches.length}개 매칭 (최소 ${min})`
      : `${matches.length}개 매칭, 최소 ${min}개가 필요합니다.`,
  );
}

function checkContains(projectRoot: string, check: VerifyCheck, negate: boolean): CheckResult {
  const type: VerifyCheckType = negate ? 'notContains' : 'contains';
  const pattern = check.pattern ?? '';
  const regex = compilePattern(pattern);
  const target = check.path ?? check.glob ?? '';

  const files = check.path
    ? [check.path]
    : check.glob
      ? matchGlobFiles(projectRoot, check.glob)
      : [];

  if (files.length === 0) {
    if (negate && check.glob) {
      return result(type, target, true, '매칭 파일 없음 (금지 패턴 없음)');
    }
    return result(type, target, false, check.glob ? '글롭과 맞는 파일이 없습니다.' : 'path 또는 glob 이 필요합니다.');
  }

    const hits: string[] = [];
  for (const file of files) {
    const body = readText(projectRoot, file);
    if (!body.ok) return result(type, file, false, body.error);
    if (regex.test(body.text)) hits.push(file);
  }

  if (negate) {
    const ok = hits.length === 0;
    return result(
      type,
      target,
      ok,
      ok ? '금지 패턴 없음' : `금지 패턴이 있습니다: ${hits.slice(0, 8).join(', ')}`,
    );
  }

  const ok = hits.length > 0;
  return result(type, target, ok, ok ? `매칭: ${hits[0]}` : '패턴을 포함한 파일이 없습니다.');
}

function checkJsonField(projectRoot: string, check: VerifyCheck): CheckResult {
  const rel = check.path ?? '';
  const field = check.field ?? '';
  const body = readText(projectRoot, rel);
  if (!body.ok) return result('jsonField', `${rel}#${field}`, false, body.error);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (error) {
    return result('jsonField', rel, false, `JSON 파싱 실패: ${(error as Error).message}`);
  }

  const value = getJsonField(parsed, field);
  const target = `${rel}#${field}`;
  if (value === undefined) return result('jsonField', target, false, '필드가 없습니다.');

  if (check.equals !== undefined) {
    const ok = JSON.stringify(value) === JSON.stringify(check.equals);
    return result('jsonField', target, ok, ok ? 'equals 일치' : `값이 다릅니다: ${JSON.stringify(value)}`);
  }

  const tokens = flattenJsonStrings(value);
  const mustHave = asStringList(check.contains);
  const mustNot = asStringList(check.mustNotContain ?? check.pattern);

  const missing = mustHave.filter((item) => !tokens.some((token) => token.includes(item)));
  const forbidden = mustNot.filter((item) => tokens.some((token) => token.includes(item)));

  if (missing.length > 0) {
    return result('jsonField', target, false, `없음: ${missing.join(', ')}`);
  }
  if (forbidden.length > 0) {
    return result('jsonField', target, false, `있으면 안 됨: ${forbidden.join(', ')}`);
  }

  return result('jsonField', target, true, '필드 조건 충족');
}

function checkPrefab(projectRoot: string, check: VerifyCheck): CheckResult {
  const files = check.path
    ? [check.path]
    : check.glob
      ? matchGlobFiles(projectRoot, check.glob)
      : [];
  const min = check.min ?? 1;
  const wanted = asStringList(check.contains);
  const target = check.path ?? check.glob ?? '(prefab)';

  if (files.length === 0) {
    return result('prefab', target, false, '프리팹 파일이 없습니다.');
  }
  if (files.length < min) {
    return result('prefab', target, false, `${files.length}개 매칭, 최소 ${min}개가 필요합니다.`);
  }

  const missingScripts: string[] = [];
  const empty: string[] = [];

  for (const file of files) {
    const body = readText(projectRoot, file);
    if (!body.ok) return result('prefab', file, false, body.error);
    const info = inspectPrefabYaml(body.text);
    if (!prefabHasContent(info)) {
      empty.push(
        `${file} (GameObject ${info.gameObjects}, MonoBehaviour ${info.monoBehaviours}, RectTransform ${info.rectTransforms})`,
      );
      continue;
    }
    for (const name of wanted) {
      const guid = findScriptGuid(projectRoot, name);
      const hasGuid = guid ? info.scriptGuids.includes(guid) : false;
      const hasName = info.names.some((item) => item === name || item.includes(name));
      if (!hasGuid && !hasName) missingScripts.push(`${file} ← ${name}`);
    }
  }

  if (empty.length > 0) {
    return result('prefab', target, false, `빈 프리팹(GameObject+Transform 만 있거나 내용 없음): ${empty.join(', ')}`);
  }
  if (missingScripts.length > 0) {
    return result('prefab', target, false, `스크립트/오브젝트가 프리팹에 없습니다: ${missingScripts.join(', ')}`);
  }
  return result('prefab', target, true, `프리팹 ${files.length}개 내용 확인`);
}

function checkAddressable(projectRoot: string, check: VerifyCheck): CheckResult {
  const address = (check.address ?? check.pattern ?? '').trim();
  const group = (check.group ?? '').trim();
  const target = [group && `group=${group}`, address && `address=${address}`, check.path]
    .filter(Boolean)
    .join(' ');
  const entries = listAddressableEntries(projectRoot);

  if (entries.length === 0) {
    return result('addressable', target || '(addressable)', false, 'AddressableAssetsData 그룹 항목을 찾지 못했습니다.');
  }

  const inGroup = group ? entries.filter((entry) => entry.group === group) : entries;
  if (group && inGroup.length === 0) {
    const names = [...new Set(entries.map((entry) => entry.group))].join(', ');
    return result('addressable', target, false, `그룹 '${group}' 이 없습니다 (발견: ${names || '없음'}).`);
  }

  const matched = address
    ? inGroup.filter((entry) => entry.address === address || entry.address.includes(address))
    : inGroup;

  if (address && matched.length === 0) {
    const sample = inGroup
      .map((entry) => entry.address)
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    return result(
      'addressable',
      target,
      false,
      `주소 '${address}' 가 ${group ? `그룹 '${group}'` : 'Addressables'} 에 없습니다.${sample ? ` (예: ${sample})` : ''}`,
    );
  }

  if (check.path) {
    const guid = assetGuid(projectRoot, check.path);
    if (!guid) {
      return result('addressable', target, false, `${check.path}.meta 의 guid 를 읽지 못했습니다.`);
    }
    const byGuid = matched.filter((entry) => entry.guid === guid);
    if (byGuid.length === 0) {
      return result(
        'addressable',
        target,
        false,
        `${check.path} (guid ${guid.slice(0, 8)}…) 가 해당 주소/그룹에 등록되어 있지 않습니다.`,
      );
    }
  }

  return result('addressable', target || '(addressable)', true, 'Addressables 등록 확인');
}

function checkCsNoUnityEngine(projectRoot: string, check: VerifyCheck): CheckResult {
  const rel = check.path ?? '';
  const body = readText(projectRoot, rel);
  if (!body.ok) return result('csNoUnityEngine', rel, false, body.error);

  const lines = body.text.split(/\r?\n/);
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*using\s+UnityEngine\b/.test(line) || /\bUnityEngine\./.test(line)) {
      hits.push(`${i + 1}`);
    }
  }

  const ok = hits.length === 0;
  return result(
    'csNoUnityEngine',
    rel,
    ok,
    ok ? 'UnityEngine 참조 없음' : `UnityEngine 참조 (줄 ${hits.slice(0, 6).join(', ')})`,
  );
}

export function runVerifyChecks(projectRoot: string, checks: VerifyCheck[]): CheckResult[] {
  return checks.map((check) => {
    try {
      switch (check.type) {
        case 'exists':
          return checkExists(projectRoot, check);
        case 'notExists':
          return checkNotExists(projectRoot, check);
        case 'globMin':
          return checkGlobMin(projectRoot, check);
        case 'contains':
          return checkContains(projectRoot, check, false);
        case 'notContains':
          return checkContains(projectRoot, check, true);
        case 'jsonField':
          return checkJsonField(projectRoot, check);
        case 'csNoUnityEngine':
          return checkCsNoUnityEngine(projectRoot, check);
        case 'prefab':
          return checkPrefab(projectRoot, check);
        case 'addressable':
          return checkAddressable(projectRoot, check);
        default:
          return result(check.type, check.path ?? check.glob ?? '', false, `알 수 없는 체크 타입: ${check.type}`);
      }
    } catch (error) {
      return result(
        check.type,
        check.path ?? check.glob ?? '',
        false,
        (error as Error).message,
      );
    }
  });
}

export function formatVerifyFeedback(results: CheckResult[]): string {
  const failed = results.filter((item) => !item.ok);
  if (failed.length === 0) return '';
  const lines = failed.map((item) => `- [${item.type}] ${item.target} — ${item.message}`);
  return `Verify 체크 실패 (${failed.length}건):\n${lines.join('\n')}`;
}

export function formatVerifyForPrompt(checks: VerifyCheck[]): string {
  if (checks.length === 0) return '';
  const lines = checks.map((check) => {
    const bits = [`${check.type}`];
    if (check.path) bits.push(check.path);
    if (check.glob) bits.push(check.glob);
    if (check.min !== undefined) bits.push(`min=${check.min}`);
    if (check.pattern) bits.push(`/${check.pattern}/`);
    if (check.field) bits.push(`#${check.field}`);
    if (check.contains !== undefined) bits.push(`contains=${JSON.stringify(check.contains)}`);
    if (check.mustNotContain !== undefined) bits.push(`mustNot=${JSON.stringify(check.mustNotContain)}`);
    if (check.equals !== undefined) bits.push(`equals=${JSON.stringify(check.equals)}`);
    if (check.group) bits.push(`group=${check.group}`);
    if (check.address) bits.push(`address=${check.address}`);
    return `- ${bits.join(' ')}`;
  });
  return [
    '## 기계 검증 (Verify) — 오케스트레이터가 파일로 직접 확인한다',
    'targetFiles/완료 조건에서 추론한 항목과 로드맵 verify.checks 를 포함한다.',
    '채팅에만 코드를 쓰지 말고 아래를 실제로 만족시킬 것.',
    ...lines,
  ].join('\n');
}

export function requireChangesResult(hasChanges: boolean, filesLabel: string): CheckResult {
  return result(
    'requireChanges',
    filesLabel,
    hasChanges,
    hasChanges
      ? '이번 Step 시작 이후 범위 내 변경이 있습니다.'
      : '이번 Step 시작 이후 범위 내 변경이 없습니다. Agent 가 대상 경로에 파일을 쓰지 못했거나, 이전 잔여 변경만 있습니다.',
  );
}
