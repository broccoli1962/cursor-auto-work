import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';
import type { AgentRunResult, AgentStreamEvent, OrchestratorConfig } from './types';

const log = createLogger('cursor');

/** `.cursorrules` / `.cursor/rules/*.mdc` 를 모두 읽어 System Context 로 합친다. */
export function collectCursorRules(projectRoot: string, maxChars = 12_000): string {
  const chunks: string[] = [];

  const legacy = path.join(projectRoot, '.cursorrules');
  if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) {
    chunks.push(`### .cursorrules\n${fs.readFileSync(legacy, 'utf8').trim()}`);
  }

  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
    const files = fs
      .readdirSync(rulesDir)
      .filter((f) => f.endsWith('.mdc') || f.endsWith('.md'))
      .sort();
    for (const file of files) {
      const body = fs.readFileSync(path.join(rulesDir, file), 'utf8').trim();
      if (body) chunks.push(`### .cursor/rules/${file}\n${body}`);
    }
  }

  const agentsMd = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMd) && fs.statSync(agentsMd).isFile()) {
    chunks.push(`### AGENTS.md\n${fs.readFileSync(agentsMd, 'utf8').trim()}`);
  }

  if (chunks.length === 0) return '';

  const joined = chunks.join('\n\n');
  return joined.length > maxChars
    ? `${joined.slice(0, maxChars)}\n\n[...규칙 문서가 길어 일부 생략됨...]`
    : joined;
}

export interface RunAgentOptions {
  prompt: string;
  config: OrchestratorConfig;
  /** 이어서 진행할 세션 ID. 미지정 시 Fresh Context 로 새 세션이 열린다. */
  resumeSessionId?: string;
  /** 스트림에서 텍스트 델타가 들어올 때마다 호출 */
  onText?: (text: string) => void;
  /** 도구 호출 감지 시 호출 */
  onToolCall?: (toolName: string) => void;
}

function buildArgs(options: RunAgentOptions): string[] {
  const { config, prompt, resumeSessionId } = options;
  const args: string[] = [];

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  args.push('-p', prompt);
  args.push('--output-format', 'stream-json');

  if (config.cursorModel) args.push('--model', config.cursorModel);
  // UnityMCP 도구 호출 및 파일 쓰기를 사람 승인 없이 자율 수행하도록 허용
  if (config.cursorYolo) args.push('--force');

  return args;
}

/** NDJSON 이벤트에서 사람이 읽을 수 있는 텍스트를 추출한다. */
function extractText(event: AgentStreamEvent): string {
  const fromContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const rec = part as Record<string, unknown>;
            if (typeof rec.text === 'string') return rec.text;
          }
          return '';
        })
        .join('');
    }
    if (content && typeof content === 'object') {
      const rec = content as Record<string, unknown>;
      if (typeof rec.text === 'string') return rec.text;
      if (rec.content !== undefined) return fromContent(rec.content);
    }
    return '';
  };

  if (typeof event.text === 'string') return event.text;
  if (event.delta !== undefined) {
    const delta = fromContent(event.delta);
    if (delta) return delta;
  }
  if (event.message !== undefined) {
    const message = fromContent(event.message);
    if (message) return message;
  }
  if (event.content !== undefined) return fromContent(event.content);
  return '';
}

/** 이벤트에서 도구 이름을 추출한다 (mcp_unityMCP_* 등). */
function extractToolName(event: AgentStreamEvent): string | null {
  const candidates: unknown[] = [
    event.tool_name,
    event.toolName,
    event.name,
    (event.tool as Record<string, unknown> | undefined)?.name,
  ];

  const typeStr = `${event.type ?? ''}${event.subtype ?? ''}`.toLowerCase();
  const looksLikeTool = typeStr.includes('tool');

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      if (looksLikeTool || candidate.startsWith('mcp_')) return candidate;
    }
  }
  return null;
}

/**
 * cursor-agent 를 spawn 하여 NDJSON 스트림을 소비하고, 프로세스가 idle/exit 될 때까지 대기한다.
 */
export function runCursorAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { config } = options;
  const args = buildArgs(options);
  const startedAt = Date.now();

  log.info(
    `cursor-agent 실행 (${options.resumeSessionId ? `resume:${options.resumeSessionId}` : 'fresh context'}) - prompt ${options.prompt.length} chars`,
  );
  log.debug(`args: ${args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' ')}`);

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn(config.cursorAgentBin, args, {
      cwd: config.targetProjectPath,
      env: { ...process.env },
      // Windows 에서 .cmd / .ps1 형태로 배포되는 경우가 있어 shell 경유 실행
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    const assistantChunks: string[] = [];
    const toolCalls: string[] = [];
    let stderr = '';
    let sessionId: string | undefined;
    let buffer = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`Agent 타임아웃 (${config.agentTimeoutMs}ms) - 프로세스를 종료합니다.`);
      child.kill('SIGKILL');
    }, config.agentTimeoutMs);

    const handleEvent = (event: AgentStreamEvent): void => {
      if (typeof event.session_id === 'string') sessionId = event.session_id;

      const toolName = extractToolName(event);
      if (toolName) {
        toolCalls.push(toolName);
        options.onToolCall?.(toolName);
        log.debug(`tool call: ${toolName}`);
      }

      const type = (event.type ?? '').toLowerCase();
      if (type === 'result' || type === 'done' || type === 'exit') {
        log.debug(`stream terminal event: ${type}/${event.subtype ?? ''}`);
      }

      const isAssistant =
        event.role === 'assistant' || type.includes('assistant') || type === 'text' || type === 'result';

      const text = extractText(event);
      if (text && isAssistant) {
        assistantChunks.push(text);
        options.onText?.(text);
      }
    };

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        // stream-json 이 아닌 평문 출력도 유실 없이 보존
        assistantChunks.push(`${trimmed}\n`);
        options.onText?.(`${trimmed}\n`);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as AgentStreamEvent | AgentStreamEvent[];
        if (Array.isArray(parsed)) parsed.forEach(handleEvent);
        else handleEvent(parsed);
      } catch {
        log.debug(`NDJSON 파싱 실패(무시): ${trimmed.slice(0, 200)}`);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) consumeLine(buffer);

      const result: AgentRunResult = {
        exitCode,
        assistantText: assistantChunks.join(''),
        toolCalls,
        sessionId,
        timedOut,
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
      };
      log.info(
        `cursor-agent 종료 (code=${exitCode}, ${Math.round(result.durationMs / 1000)}s, tools=${toolCalls.length})`,
      );
      resolve(result);
    };

    child.on('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`;
      log.error(`cursor-agent 실행 실패: ${error.message}`);
      settle(null);
    });

    child.on('close', (code) => settle(code));
  });
}
