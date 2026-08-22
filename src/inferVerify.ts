import type { CheckResult, JudgeVerdict, RoadmapStep, VerifyCheck } from './types';

const FILE_EXT = /\.(cs|asmdef|asmref|json|prefab|asset|unity|uxml|uss|shader|hlsl|txt|xml|md)$/i;
const ASSET_PATH = /Assets\/[A-Za-z0-9_./{}-]+/g;
const QUOTED = /['"`]([^'"`\n]{2,80})['"`]/g;
const IDENTIFIER = /\b(I[A-Z][A-Za-z0-9]{2,}|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+)\b/g;

const STOP_QUOTES = new Set([
  'true',
  'false',
  'null',
  'this',
  'void',
  'string',
  'class',
  'public',
  'private',
  'static',
  'return',
  'ok',
  'todo',
]);

const FORBIDDEN: { when: RegExp; pattern: string }[] = [
  { when: /Resources\s*\.\s*Load|Resources\.Load/, pattern: 'Resources\\.Load' },
  { when: /IEnumerator|코루틴/, pattern: 'IEnumerator' },
  { when: /Debug\s*\.\s*Log\s*\(/, pattern: 'Debug\\.Log\\s*\\(' },
];

const NEGATIVE = /사용하지\s*않|쓰지\s*말|하지\s*말|금지|없이\s*구현|코루틴은\s*사용하지/;

export function expandBraces(input: string): string[] {
  const match = /\{([^{}]+)\}/.exec(input);
  const body = match?.[1];
  if (!match || match.index === undefined || !body) return [input];
  const parts = body.split(',').map((part) => part.trim()).filter(Boolean);
  const results: string[] = [];
  for (const part of parts) {
    const next = `${input.slice(0, match.index)}${part}${input.slice(match.index + match[0].length)}`;
    results.push(...expandBraces(next));
  }
  return results.length > 0 ? results : [input];
}

export function looksLikeDir(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return !FILE_EXT.test(normalized);
}

function checkKey(check: VerifyCheck): string {
  return JSON.stringify({
    type: check.type,
    path: check.path,
    glob: check.glob,
    min: check.min,
    pattern: check.pattern,
    field: check.field,
    contains: check.contains,
    mustNotContain: check.mustNotContain,
    equals: check.equals,
    group: check.group,
    address: check.address,
  });
}

export function mergeVerifyChecks(inferred: VerifyCheck[], explicit: VerifyCheck[]): VerifyCheck[] {
  const seen = new Set<string>();
  const out: VerifyCheck[] = [];
  for (const check of [...explicit, ...inferred]) {
    const key = checkKey(check);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

function addCheck(acc: VerifyCheck[], seen: Set<string>, check: VerifyCheck): void {
  const key = checkKey(check);
  if (seen.has(key)) return;
  seen.add(key);
  acc.push(check);
}

function addExists(acc: VerifyCheck[], seen: Set<string>, rawPath: string): void {
  for (const item of expandBraces(rawPath.replace(/\\/g, '/'))) {
    const path = item.replace(/\/+$/, '');
    if (!path.startsWith('Assets/') && !path.includes('/')) continue;
    addCheck(acc, seen, { type: 'exists', path });
  }
}

function contentAnchor(step: RoadmapStep): Pick<VerifyCheck, 'path' | 'glob'> | undefined {
  const files = (step.targetFiles ?? [])
    .flatMap((item) => expandBraces(item.replace(/\\/g, '/')))
    .filter((item) => FILE_EXT.test(item));
  if (files.length === 1) return { path: files[0] };
  const dirs = (step.targetFiles ?? [])
    .flatMap((item) => expandBraces(item.replace(/\\/g, '/')))
    .map((item) => item.replace(/\/+$/, ''))
    .filter((item) => looksLikeDir(item));
  if (dirs.length === 1) return { glob: `${dirs[0]}/**/*.cs` };
  if (dirs.length > 1) return { glob: `${dirs[0]}/**/*.cs` };
  if (files.length > 1) return { path: files[0] };
  return undefined;
}

function addPattern(
  acc: VerifyCheck[],
  seen: Set<string>,
  type: 'contains' | 'notContains',
  pattern: string,
  anchor: Pick<VerifyCheck, 'path' | 'glob'> | undefined,
): void {
  if (!anchor) return;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  addCheck(acc, seen, { type, pattern: escaped, ...anchor });
}

function extractQuoted(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const value = (match[1] ?? '').trim();
    if (value.length < 2 || STOP_QUOTES.has(value.toLowerCase())) continue;
    if (value.startsWith('Assets/')) continue;
    out.push(value);
  }
  return [...new Set(out)];
}

function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/0건|발생하지|없어야|실패하지\s*않/.test(line)) continue;
    for (const match of line.matchAll(IDENTIFIER)) {
      const value = match[1] ?? '';
      if (value.length < 4 || /Exception$/.test(value)) continue;
      out.add(value);
    }
  }
  return [...out];
}

function addContentChecks(acc: VerifyCheck[], seen: Set<string>, step: RoadmapStep, text: string): void {
  const anchor = contentAnchor(step);
  if (!anchor) return;

  for (const quoted of extractQuoted(text)) {
    if (isAddressableQuote(text, quoted)) continue;
    addPattern(acc, seen, 'contains', quoted, anchor);
  }
  for (const ident of extractIdentifiers(text)) {
    addPattern(acc, seen, 'contains', ident, anchor);
  }

  if (NEGATIVE.test(text)) {
    for (const rule of FORBIDDEN) {
      if (rule.when.test(text)) {
        addCheck(acc, seen, { type: 'notContains', pattern: rule.pattern, ...anchor });
      }
    }
  }
}

/** 로드맵을 고치지 않고 targetFiles + 본문에서 존재/내용 검사를 만든다. */
export function inferVerifyChecks(step: RoadmapStep): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const seen = new Set<string>();
  const targets = step.targetFiles ?? [];

  for (const target of targets) {
    addExists(checks, seen, target);
  }

  const text = [step.task, ...(step.acceptanceCriteria ?? [])].join('\n');
  for (const match of text.matchAll(ASSET_PATH)) {
    const raw = (match[0] ?? '').replace(/[,.;:)]+$/, '');
    if (raw.length < 10) continue;
    addExists(checks, seen, raw);
  }

  if (/\basmdef\b/i.test(text)) {
    for (const target of targets) {
      const dir = target.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!looksLikeDir(dir)) continue;
      addCheck(checks, seen, { type: 'globMin', glob: `${dir}/**/*.asmdef`, min: 1 });
    }
  }

  addContentChecks(checks, seen, step, text);
  addPrefabAndAddressableChecks(checks, seen, step, text);
  return checks;
}

function isAddressableQuote(text: string, value: string): boolean {
  if (!/Addressable/i.test(text)) return false;
  if (value.includes('/')) return true;
  return new RegExp(`그룹\\s*['"\`]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text);
}

function addPrefabAndAddressableChecks(
  acc: VerifyCheck[],
  seen: Set<string>,
  step: RoadmapStep,
  text: string,
): void {
  const prefabPaths = new Set<string>();
  const consider = [
    ...(step.targetFiles ?? []),
    ...[...text.matchAll(ASSET_PATH)].map((match) => (match[0] ?? '').replace(/[,.;:)]+$/, '')),
  ];

  for (const raw of consider) {
    for (const item of expandBraces(raw.replace(/\\/g, '/'))) {
      const path = item.replace(/\/+$/, '');
      if (/\.prefab$/i.test(path)) prefabPaths.add(path);
    }
  }

  const viewScripts = extractIdentifiers(text).filter((name) => /View$/.test(name));
  for (const prefabPath of prefabPaths) {
    addCheck(acc, seen, {
      type: 'prefab',
      path: prefabPath,
      contains: viewScripts.length > 0 ? viewScripts : undefined,
    });
  }

  if (prefabPaths.size === 0 && /프리팹|prefab/i.test(text)) {
    for (const target of step.targetFiles ?? []) {
      const dir = target.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!looksLikeDir(dir)) continue;
      if (!/prefab/i.test(dir)) continue;
      addCheck(acc, seen, { type: 'prefab', glob: `${dir}/**/*.prefab`, min: 1 });
    }
  }

  if (!/Addressable/i.test(text)) return;

  const groups = [...text.matchAll(/(?:Addressables?\s*)?그룹\s*['"`]([^'"`]+)['"`]/gi)].map(
    (match) => match[1]?.trim() ?? '',
  );
  const addresses = [
    ...[...text.matchAll(/(?:주소|address)\s*['"`]([^'"`]+)['"`]/gi)].map((match) => match[1]?.trim() ?? ''),
    ...extractQuoted(text).filter((value) => value.includes('/')),
  ].filter(Boolean);

  const group = groups[0];
  const address = addresses[0];
  const prefabPath = [...prefabPaths][0];
  if (!group && !address && !prefabPath) return;

  addCheck(acc, seen, {
    type: 'addressable',
    group: group || undefined,
    address: address || undefined,
    path: prefabPath,
  });
}

export function hasJudgableContract(step: RoadmapStep, inferred: VerifyCheck[]): boolean {
  if ((step.acceptanceCriteria?.length ?? 0) > 0) return true;
  if ((step.targetFiles?.length ?? 0) > 0) return true;
  if (inferred.some((check) => check.type === 'exists' || check.type === 'contains' || check.type === 'prefab' || check.type === 'addressable')) {
    return true;
  }
  return /Assets\//.test(step.task);
}

export function contractResult(step: RoadmapStep, inferred: VerifyCheck[]): CheckResult {
  const ok = hasJudgableContract(step, inferred);
  return {
    ok,
    type: 'requireContract',
    target: `Step ${step.id}`,
    message: ok
      ? '완료 조건 또는 대상 경로가 있어 판정할 수 있습니다.'
      : 'acceptanceCriteria, targetFiles, 본문의 Assets 경로가 없습니다. 완료 계약을 추가하세요.',
  };
}

export function judgeCriteriaTexts(step: RoadmapStep): string[] {
  if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) return step.acceptanceCriteria;
  const task = step.task.trim();
  return task ? [task] : [step.title];
}

export function meaningfulChangesResult(ok: boolean, filesLabel: string): CheckResult {
  return {
    ok,
    type: 'requireMeaningfulChanges',
    target: filesLabel,
    message: ok
      ? '범위 내 변경에 코드/에셋 내용이 있습니다.'
      : '범위 내 변경이 주석·공백·using 뿐입니다. 완료 조건에 해당하는 구현이 없습니다.',
  };
}

export function skippedJudgeResult(reason: string): JudgeVerdict {
  return { ok: true, skipped: true, reasons: [reason], raw: '', durationMs: 0 };
}
