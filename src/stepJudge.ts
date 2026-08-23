import fs from 'node:fs';
import path from 'node:path';

import { runCursorAgent } from './cursorRunner';
import { collectUnifiedDiff } from './gitManager';
import { judgeCriteriaTexts } from './inferVerify';
import { readSpec } from './memoryManager';
import { createLogger } from './logger';
import { ABORT_MESSAGE } from './processKill';
import type {
  CheckResult,
  JudgeCriterionResult,
  JudgeVerdict,
  OrchestratorConfig,
  RoadmapStep,
  StepDelta,
} from './types';

const log = createLogger('judge');
const MAX_EXCERPT_CHARS = 16_000;
const MAX_FILE_LINES = 120;
const TEXT_EXT = new Set([
  '.cs',
  '.json',
  '.asmdef',
  '.asmref',
  '.txt',
  '.md',
  '.xml',
  '.uxml',
  '.uss',
  '.shader',
  '.hlsl',
]);

export interface ParsedJudge {
  ok: boolean;
  reasons: string[];
  criteria: Array<{ index?: number; ok?: boolean; evidence?: string; note?: string }>;
}

export function parseJudgeVerdict(text: string): ParsedJudge | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const blobs: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) blobs.push(fence[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) blobs.push(trimmed.slice(start, end + 1));

  for (const blob of blobs) {
    try {
      const parsed = JSON.parse(blob) as {
        ok?: unknown;
        reasons?: unknown;
        reason?: unknown;
        criteria?: unknown;
      };
      if (typeof parsed.ok !== 'boolean') continue;
      const reasons = Array.isArray(parsed.reasons)
        ? parsed.reasons.map((item) => String(item))
        : parsed.reason
          ? [String(parsed.reason)]
          : [];
      const criteria = Array.isArray(parsed.criteria)
        ? parsed.criteria.filter((item) => item && typeof item === 'object')
        : [];
      return { ok: parsed.ok, reasons, criteria };
    } catch {
      // 다음 후보
    }
  }

  return null;
}

const EVIDENCE_REL = /(?:Assets|server|Packages|Docs|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/i;

/** `server/src/Program.cs:17` 처럼 줄 번호가 붙어 있어도 상대 경로만 꺼낸다. */
export function extractEvidenceRelPath(evidence: string): string | null {
  const stripped = evidence.trim().replace(/\\/g, '/').replace(/:\d+(?::\d+)?\s*$/, '');
  const match = stripped.match(EVIDENCE_REL);
  return match?.[0]?.replace(/\\/g, '/') ?? null;
}

function looksLikePathEvidence(evidence: string): boolean {
  return extractEvidenceRelPath(evidence) !== null;
}

function compileCriterion(text: string): boolean {
  return /컴파일|compile error|CS\d{4}/i.test(text);
}

function evidenceFileExists(projectRoot: string | undefined, evidence: string): boolean {
  if (!projectRoot) return true;
  const rel = extractEvidenceRelPath(evidence);
  if (!rel) return false;
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, rel.replace(/\//g, path.sep));
  const inside = path.relative(root, absolute);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return false;
  return fs.existsSync(absolute);
}

export function finalizeJudgeVerdict(
  parsed: ParsedJudge | null,
  expected: string[],
  projectRoot?: string,
): { ok: boolean; reasons: string[]; criteria: JudgeCriterionResult[] } {
  if (!parsed) {
    return {
      ok: false,
      reasons: ['판정 결과를 JSON 으로 해석하지 못했습니다.'],
      criteria: [],
    };
  }

  if (!Array.isArray(parsed.criteria) || parsed.criteria.length !== expected.length) {
    return {
      ok: false,
      reasons: [
        `판정이 완료 조건 ${expected.length}개를 항목별로 평가하지 않았습니다 (받은 항목 ${parsed.criteria?.length ?? 0}개).`,
        ...parsed.reasons,
      ],
      criteria: [],
    };
  }

  const criteria: JudgeCriterionResult[] = expected.map((text, index) => {
    const row = parsed.criteria[index] ?? {};
    return {
      index,
      text,
      ok: row.ok === true,
      evidence: String(row.evidence ?? '').trim(),
      note: String(row.note ?? '').trim(),
    };
  });

  const reasons = [...parsed.reasons];
  let allOk = parsed.ok === true;

  for (const row of criteria) {
    if (!row.ok) {
      allOk = false;
      reasons.push(`조건 ${row.index + 1} 실패: ${row.note || row.text}`);
      continue;
    }
    if (compileCriterion(row.text)) continue;
    if (!looksLikePathEvidence(row.evidence)) {
      allOk = false;
      reasons.push(`조건 ${row.index + 1}: 파일 경로 근거가 없습니다. (${row.text})`);
      continue;
    }
    if (!evidenceFileExists(projectRoot, row.evidence)) {
      allOk = false;
      reasons.push(`조건 ${row.index + 1}: evidence 경로가 디스크에 없습니다. (${row.evidence})`);
    }
  }

  if (parsed.ok === true && !allOk) {
    reasons.unshift('판정이 ok 라고 했으나 항목별 근거가 부족하거나 실패한 조건이 있습니다.');
  }

  return { ok: allOk, reasons: [...new Set(reasons)], criteria };
}

function excerptFiles(projectRoot: string, files: string[]): string {
  let used = 0;
  const parts: string[] = [];
  const unique = [...new Set(files.map((file) => file.replace(/\\/g, '/')))];

  for (const rel of unique.slice(0, 16)) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      parts.push(`### ${rel}\n(바이너리/비텍스트 — 경로만 기록)`);
      continue;
    }
    const absolute = path.join(projectRoot, rel);
    if (!fs.existsSync(absolute)) {
      parts.push(`### ${rel}\n(없음)`);
      continue;
    }
    if (!fs.statSync(absolute).isFile()) continue;

    let body = '';
    try {
      body = fs.readFileSync(absolute, 'utf8');
    } catch {
      parts.push(`### ${rel}\n(읽기 실패)`);
      continue;
    }
    const lines = body.split(/\r?\n/).slice(0, MAX_FILE_LINES).join('\n');
    const chunk = `### ${rel}\n${lines}`;
    if (used + chunk.length > MAX_EXCERPT_CHARS) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join('\n\n');
}

function collectExcerptTargets(step: RoadmapStep, delta: StepDelta): string[] {
  return [...(step.targetFiles ?? []), ...delta.changedFiles];
}

export function buildJudgePrompt(args: {
  step: RoadmapStep;
  delta: StepDelta;
  checks: CheckResult[];
  projectRoot: string;
  unifiedDiff?: string;
  spec?: string;
}): string {
  const expected = judgeCriteriaTexts(args.step);
  const criteria = expected.map((item, index) => `${index + 1}. ${item}`).join('\n');

  const checkLines =
    args.checks.length > 0
      ? args.checks.map((item) => `- [${item.ok ? 'ok' : 'fail'}] ${item.type} ${item.target} — ${item.message}`).join('\n')
      : '- (기계 체크 없음)';

  const files =
    args.delta.changedFiles.length > 0 ? args.delta.changedFiles.map((file) => `- ${file}`).join('\n') : '- (변경 파일 없음)';

  const excerpts = excerptFiles(args.projectRoot, collectExcerptTargets(args.step, args.delta));
  const criteriaJson = expected
    .map((_, index) => `    {"index": ${index}, "ok": false, "evidence": "Assets/.../File.cs:줄", "note": "근거"}`)
    .join(',\n');

  return [
    '너는 구현을 하지 않는 검수자다. 파일을 읽기만 하고 쓰거나 고치거나 Unity/MCP 를 호출하지 마라.',
    '완료 조건을 **하나씩** 평가하라. 한 조건이라도 근거가 없으면 전체 실패다.',
    '규칙·수치·프로토콜의 정본은 기획서다. 조건 문장이 짧거나 이상하면 기획서 해당 절을 따른다.',
    '로드맵과 기획서가 충돌하면 기획서를 우선한다. 기획서에 없는 추측은 실패다.',
    '컴파일 성공, 파일 존재, "잘 작성됨" 만으로는 통과가 아니다.',
    '주석·이름만 바꾼 변경, 다른 파일만 수정, 스텁/빈 메서드, 추측성 런타임 성공은 실패다.',
    'evidence 에는 실제 구현 파일 경로를 넣어라. 기획서 경로만으로는 통과가 아니다.',
    '컴파일 0건 조건만 기계 체크 통과를 evidence 로 쓸 수 있다.',
    '',
    `Step ${args.step.id}: ${args.step.title}`,
    '',
    '## Task',
    args.step.task,
    '',
    '## 완료 조건 (이 순서·개수 그대로 평가)',
    criteria,
    '',
    '## 기획서 (판정 정본)',
    args.spec?.trim() || '(기획서 없음 — 완료 조건과 코드만으로 판정)',
    '',
    '## 이미 통과한 기계 체크',
    checkLines,
    '',
    '## 이번 Step 변경 파일',
    files,
    '',
    '## unified diff',
    args.unifiedDiff?.trim() || '(diff 없음)',
    '',
    '## 대상/변경 파일 발췌',
    excerpts || '(발췌 없음)',
    '',
    '마지막에 JSON 만 출력하라.',
    '{',
    `  "ok": false,`,
    `  "reasons": ["한 줄 요약"],`,
    `  "criteria": [`,
    criteriaJson,
    `  ]`,
    '}',
    `criteria 길이는 반드시 ${expected.length} 이어야 한다.`,
  ].join('\n');
}

export function formatJudgeFeedback(verdict: JudgeVerdict): string {
  if (verdict.skipped || verdict.ok) return '';
  const reasons =
    verdict.reasons.length > 0
      ? verdict.reasons.map((item) => `- ${item}`).join('\n')
      : '- 판정이 실패했지만 사유가 비어 있습니다.';
  return `완료 조건 판정 실패:\n${reasons}`;
}

export async function runStepJudge(args: {
  config: OrchestratorConfig;
  step: RoadmapStep;
  delta: StepDelta;
  checks: CheckResult[];
  signal?: AbortSignal;
}): Promise<JudgeVerdict> {
  const startedAt = Date.now();
  const expected = judgeCriteriaTexts(args.step);
  if (args.signal?.aborted) {
    return { ok: false, skipped: false, reasons: [ABORT_MESSAGE], raw: '', aborted: true, durationMs: 0 };
  }

  const unifiedDiff = await collectUnifiedDiff(args.config, args.delta.changedFiles).catch(() => '');
  const prompt = buildJudgePrompt({
    step: args.step,
    delta: args.delta,
    checks: args.checks,
    projectRoot: args.config.targetProjectPath,
    unifiedDiff,
    spec: readSpec(args.config),
  });

  log.info(`Step ${args.step.id} 완료 조건 판정 시작 (${expected.length}개 조건)`);
  const result = await runCursorAgent({
    prompt,
    config: args.config,
    signal: args.signal,
    yolo: false,
    timeoutMs: args.config.judgeTimeoutMs,
  });

  if (result.aborted || args.signal?.aborted) {
    return {
      ok: false,
      skipped: false,
      reasons: [ABORT_MESSAGE],
      raw: result.assistantText,
      aborted: true,
      durationMs: result.durationMs,
    };
  }

  const parsed = parseJudgeVerdict(result.assistantText);
  const finalized = finalizeJudgeVerdict(parsed, expected, args.config.targetProjectPath);
  if (!parsed) {
    const hint = result.stderr.slice(-400) || result.assistantText.trim().slice(-400) || '출력 없음';
    finalized.reasons.push(hint);
  }

  log.info(`Step ${args.step.id} 판정 ${finalized.ok ? '통과' : '실패'} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  return {
    ok: finalized.ok,
    skipped: false,
    reasons: finalized.reasons,
    criteria: finalized.criteria,
    raw: result.assistantText,
    durationMs: Date.now() - startedAt,
  };
}
