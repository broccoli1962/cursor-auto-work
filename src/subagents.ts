import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';
import type { OrchestratorConfig } from './types';

const log = createLogger('subagent');

/**
 * Subagent 모델 관리.
 *
 * cursor-agent CLI 에는 subagent 모델을 지정하는 플래그가 없다.
 * 유일한 제어 지점은 `.cursor/agents/*.md` frontmatter 의 `model` 필드이므로,
 * CURSOR_SUBAGENT_MODEL 값을 실행 전에 그 파일들에 반영한다.
 */

/** model 필드를 지우고 부모 모델을 상속시키라는 뜻의 특수값 */
export const OMIT_MODEL = 'omit';

const AGENT_DIR = path.join('.cursor', 'agents');
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

export interface SubagentSyncResult {
  /** 실제로 model 필드가 바뀐 파일 (프로젝트 상대경로) */
  updated: string[];
  /** 이미 원하는 값이라 손대지 않은 파일 */
  unchanged: string[];
  /** frontmatter 가 없어 건너뛴 파일 */
  skipped: string[];
}

function listAgentFiles(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listAgentFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
  return found.sort();
}

export interface SubagentInfo {
  /** 프로젝트 상대경로 */
  file: string;
  name: string;
  /** frontmatter 에 적힌 model 값 (없으면 undefined = 부모 모델 상속) */
  model?: string;
}

/** 대상 프로젝트에 정의된 subagent 목록과 각자의 모델 설정을 읽어온다. */
export function listSubagents(config: OrchestratorConfig): SubagentInfo[] {
  const dir = path.join(config.targetProjectPath, AGENT_DIR);

  return listAgentFiles(dir).map((file) => {
    const relative = path.relative(config.targetProjectPath, file).replace(/\\/g, '/');
    let front = '';
    try {
      front = FRONTMATTER.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
    } catch {
      front = '';
    }

    const read = (key: string): string | undefined =>
      new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim();

    return {
      file: relative,
      name: read('name') ?? path.basename(file, '.md'),
      model: read('model'),
    };
  });
}

/**
 * frontmatter 의 `model` 값을 교체한다.
 * 변경이 필요 없으면 null 을 돌려준다.
 */
export function rewriteModelField(source: string, model: string): string | null {
  const match = FRONTMATTER.exec(source);
  if (!match) return null;

  const eol = /\r\n/.test(match[0]) ? '\r\n' : '\n';
  const lines = (match[1] ?? '').split(/\r?\n/);
  const index = lines.findIndex((line) => /^model\s*:/.test(line));

  if (model === OMIT_MODEL) {
    if (index < 0) return null;
    lines.splice(index, 1);
  } else {
    const desired = `model: ${model}`;
    if (index >= 0) {
      if (lines[index]?.trim() === desired) return null;
      lines[index] = desired;
    } else {
      lines.push(desired);
    }
  }

  const body = source.slice(match[0].length);
  return `---${eol}${lines.join(eol)}${eol}---${body}`;
}

/**
 * 대상 프로젝트의 subagent 정의에 설정된 모델을 반영한다.
 * CURSOR_SUBAGENT_MODEL 이 비어 있으면 아무것도 하지 않는다.
 */
export function applySubagentModel(config: OrchestratorConfig): SubagentSyncResult | null {
  const model = config.cursorSubagentModel;
  if (!model) return null;

  const dir = path.join(config.targetProjectPath, AGENT_DIR);
  const files = listAgentFiles(dir);

  if (files.length === 0) {
    log.warn(
      `${AGENT_DIR} 에 subagent 정의가 없어 CURSOR_SUBAGENT_MODEL=${model} 을 적용할 대상이 없습니다. ` +
        '내장 subagent(explore/bash/browser)의 모델은 CLI 에서 지정할 수 없습니다.',
    );
    return { updated: [], unchanged: [], skipped: [] };
  }

  const result: SubagentSyncResult = { updated: [], unchanged: [], skipped: [] };

  for (const file of files) {
    const relative = path.relative(config.targetProjectPath, file).replace(/\\/g, '/');
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      log.warn(`subagent 정의를 읽지 못했습니다 (${relative}): ${(error as Error).message}`);
      result.skipped.push(relative);
      continue;
    }

    if (!FRONTMATTER.test(source)) {
      log.warn(`frontmatter 가 없어 건너뜁니다: ${relative}`);
      result.skipped.push(relative);
      continue;
    }

    const next = rewriteModelField(source, model);
    if (next === null) {
      result.unchanged.push(relative);
      continue;
    }

    fs.writeFileSync(file, next, 'utf8');
    result.updated.push(relative);
  }

  if (result.updated.length > 0) {
    const target = model === OMIT_MODEL ? '부모 모델 상속(model 필드 제거)' : model;
    log.info(`subagent 모델을 ${target} 로 갱신했습니다: ${result.updated.join(', ')}`);
  } else {
    log.debug(`subagent 모델이 이미 ${model} 입니다 (${files.length}개 파일).`);
  }

  return result;
}
