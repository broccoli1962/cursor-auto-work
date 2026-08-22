import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ConsoleTail } from './encoding';
import { createLogger } from './logger';
import { killChildTree } from './processKill';
import { budgetText } from './textBudget';
import type {
  AgentRunResult,
  AgentStreamEvent,
  OrchestratorConfig,
  PromptDelivery,
  TokenUsage,
} from './types';

const log = createLogger('cursor');

/** `.cursorrules` / `.cursor/rules/*.mdc` 를 모두 읽어 System Context 로 합친다. */
export function collectCursorRules(projectRoot: string, maxChars = 40_000): string {
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

  return budgetText(chunks.join('\n\n'), maxChars, '규칙 문서');
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
  /** 중단 시 Agent 프로세스 트리를 즉시 종료 */
  signal?: AbortSignal;
  /** 미지정 시 config.cursorYolo */
  yolo?: boolean;
  /** 미지정 시 config.agentTimeoutMs */
  timeoutMs?: number;
}

/** `auto` 가 실제로 선택하는 구체적인 전달 방식 */
type ResolvedDelivery = Exclude<PromptDelivery, 'auto'>;

/**
 * Windows 는 `shell: true` 로 spawn 하면 `cmd.exe /d /s /c "..."` 를 거치므로
 * 명령행 전체가 8191자를 넘는 순간 "명령줄이 너무 깁니다." 로 즉시 실패한다.
 * shell 없이 CreateProcess 를 직접 쓰면 32767자, POSIX 는 인자당 128KB 가 상한이다.
 */
const WINDOWS_SHELL_LIMIT = 8191;
const WINDOWS_PROCESS_LIMIT = 32_767;
const POSIX_ARG_LIMIT = 128 * 1024;
/** 인용부호 이스케이프와 환경변수 확장 여유분 */
const LIMIT_MARGIN = 1_024;

function useShell(): boolean {
  // Windows 에서 agent 는 .cmd / .ps1 런처로 배포되어 shell 경유가 필요하다.
  return process.platform === 'win32';
}

function commandLineBudget(): number {
  if (process.platform !== 'win32') return POSIX_ARG_LIMIT - LIMIT_MARGIN;
  return (useShell() ? WINDOWS_SHELL_LIMIT : WINDOWS_PROCESS_LIMIT) - LIMIT_MARGIN;
}

/** 인자는 따옴표로 감싸이므로 인자당 3자 정도의 오버헤드를 더해 잡는다. */
function estimateCommandLine(bin: string, args: string[]): number {
  return args.reduce((sum, arg) => sum + arg.length + 3, bin.length + 1);
}

/**
 * Node 는 `shell: true` 로 spawn 할 때 인자를 따옴표로 감싸지 않고 공백으로 이어 붙인다.
 * 그대로 두면 공백이 들어간 프롬프트가 여러 인자로 쪼개지므로 직접 인용 처리한다.
 * (CommandLineToArgvW 규칙: 따옴표 앞의 역슬래시는 두 배로 늘린다)
 */
function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()%!,;=]/.test(arg)) return arg;

  let quoted = '"';
  let backslashes = 0;

  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }

  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

function buildArgs(
  options: RunAgentOptions,
  delivery: ResolvedDelivery,
  positionalPrompt: string | null,
): string[] {
  const { config, resumeSessionId } = options;
  const args: string[] = [];

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  // `-p` 는 프롬프트 값을 받는 옵션이 아니라 print(비대화형) 모드 스위치이고,
  // 프롬프트는 위치 인자다. stdin 전달 시에는 위치 인자를 아예 비워 둔다.
  args.push('-p');
  if (delivery !== 'stdin' && positionalPrompt !== null) args.push(positionalPrompt);
  args.push('--output-format', 'stream-json');

  if (config.cursorModel) args.push('--model', config.cursorModel);
  // UnityMCP 도구 호출 및 파일 쓰기를 사람 승인 없이 자율 수행하도록 허용
  if (options.yolo ?? config.cursorYolo) args.push('--force');

  return args;
}

export interface CursorAgentProbe {
  ok: boolean;
  /** `--version` 출력 첫 줄 */
  version?: string;
  error?: string;
}

/** CURSOR_AGENT_BIN 이 실제로 실행 가능한지 `--version` 으로 확인한다. */
export function probeCursorAgent(
  config: OrchestratorConfig,
  timeoutMs = 15_000,
): Promise<CursorAgentProbe> {
  return new Promise((resolve) => {
    const child = spawn(config.cursorAgentBin, ['--version'], {
      shell: useShell(),
      windowsHide: true,
    });

    const stdout = new ConsoleTail(4_000);
    const stderr = new ConsoleTail(4_000);
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, error: `${timeoutMs}ms 내에 응답하지 않았습니다.` });
    }, timeoutMs);

    const settle = (probe: CursorAgentProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();

    // 셸 오류 메시지는 여러 줄로 접히는 경우가 있어 한 줄로 눌러 준다.
    const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

    child.on('error', (error) => settle({ ok: false, error: flatten(error.message) }));
    child.on('close', (code) => {
      const version = stdout.toString().trim().split(/\r?\n/)[0]?.trim();
      if (code === 0 && version) return settle({ ok: true, version });
      settle({
        ok: false,
        error: flatten(stderr.toString()) || `exit code ${code}`,
      });
    });
  });
}

export interface CursorAuthProbe {
  ok: boolean;
  checked: boolean;
  detail: string;
}

const AUTH_FAIL = /not (?:logged|signed) in|login required|unauthoriz|401|authentication required|please (?:log|sign) in|no api key/i;

function runAgentSubcommand(
  config: OrchestratorConfig,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.cursorAgentBin, args, {
      shell: useShell(),
      windowsHide: true,
    });
    const stdout = new ConsoleTail(6_000);
    const stderr = new ConsoleTail(6_000);
    const timer = setTimeout(() => {
      killChildTree(child);
      resolve({ code: null, stdout: stdout.toString(), stderr: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** `--version` 외에 status/whoami 로 로그인 여부를 본다. 없는 서브커맨드는 건너뛴다. */
export async function probeCursorAuth(
  config: OrchestratorConfig,
  timeoutMs = 12_000,
): Promise<CursorAuthProbe> {
  for (const args of [['status'], ['whoami'], ['account']]) {
    const result = await runAgentSubcommand(config, args, timeoutMs);
    const combined = `${result.stdout}\n${result.stderr}`;
    if (/unknown command|no such command|unrecognized/i.test(combined)) continue;
    if (result.stderr === 'timeout') continue;
    if (AUTH_FAIL.test(combined) || (result.code !== 0 && result.code !== null && AUTH_FAIL.test(combined))) {
      return { ok: false, checked: true, detail: combined.replace(/\s+/g, ' ').trim().slice(0, 240) };
    }
    if (result.code === 0) {
      const line = result.stdout.trim().split(/\r?\n/)[0]?.trim() || '인증 확인됨';
      return { ok: true, checked: true, detail: line.slice(0, 200) };
    }
    if (AUTH_FAIL.test(combined)) {
      return { ok: false, checked: true, detail: combined.replace(/\s+/g, ' ').trim().slice(0, 240) };
    }
  }

  return {
    ok: true,
    checked: false,
    detail: 'status/whoami 를 지원하지 않아 인증은 실행 시점에 확인됩니다.',
  };
}

const PROMPT_DIR_NAME = 'prompts';
const KEEP_PROMPT_FILES = 3;

/** 프롬프트 본문을 runtime/prompts 에 저장하고 경로를 돌려준다. */
function writePromptFile(config: OrchestratorConfig, prompt: string): string {
  const dir = path.join(config.runtimeDir, PROMPT_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `prompt-${stamp}.md`);
  fs.writeFileSync(filePath, prompt, 'utf8');

  try {
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('prompt-') && name.endsWith('.md'))
      .sort()
      .slice(0, -KEEP_PROMPT_FILES);
    for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
  } catch (error) {
    log.debug(`프롬프트 파일 정리 실패(무시): ${(error as Error).message}`);
  }

  return filePath;
}

/**
 * 파일 전달 모드에서 명령행에 실리는 지시문.
 * cmd.exe 가 인자를 쪼개지 않도록 반드시 한 줄로 유지한다.
 */
function fileModeInstruction(promptPath: string): string {
  return (
    `이번 작업의 전체 지시문은 ${promptPath} 파일에 들어 있다. ` +
    '다른 작업을 시작하기 전에 이 파일을 처음부터 끝까지 읽고, 그 안의 모든 지침을 그대로 수행하라. ' +
    '파일 내용을 요약하거나 건너뛰지 말 것.'
  );
}

interface SpawnPlan {
  delivery: ResolvedDelivery;
  args: string[];
  /** stdin 으로 흘려보낼 프롬프트 (stdin 모드에서만 존재) */
  stdinPayload: string | null;
}

function buildPlan(options: RunAgentOptions, delivery: ResolvedDelivery): SpawnPlan {
  const { config, prompt } = options;

  if (delivery === 'stdin') {
    return { delivery, args: buildArgs(options, delivery, null), stdinPayload: prompt };
  }

  if (delivery === 'file') {
    const promptPath = writePromptFile(config, prompt);
    log.info(`프롬프트를 파일로 전달합니다: ${promptPath}`);
    return {
      delivery,
      args: buildArgs(options, delivery, fileModeInstruction(promptPath)),
      stdinPayload: null,
    };
  }

  return { delivery, args: buildArgs(options, delivery, prompt), stdinPayload: null };
}

/**
 * cmd.exe 는 인용부호 안에 있어도 줄바꿈을 명령 구분자로 취급한다.
 * 따라서 여러 줄 프롬프트를 명령행 인자로 넘기면 길이와 무관하게 뒷부분이 잘려 나간다.
 */
function argvBreaksPrompt(prompt: string): boolean {
  return useShell() && /[\r\n]/.test(prompt);
}

/**
 * 설정값과 프롬프트 모양을 보고 실제 전달 방식을 정한다.
 * `auto` 는 명령행에 안전하게 실릴 때만 argv 를 쓰고, 그 외에는 stdin 을 쓴다.
 */
function resolveDelivery(options: RunAgentOptions): ResolvedDelivery {
  const configured = options.config.promptDelivery;

  if (configured === 'argv' && argvBreaksPrompt(options.prompt)) {
    log.warn(
      'CURSOR_PROMPT_DELIVERY=argv 이지만 프롬프트에 줄바꿈이 있어 Windows 셸이 인자를 쪼갤 수 있습니다.',
    );
  }
  if (configured !== 'auto') return configured;

  if (argvBreaksPrompt(options.prompt)) {
    log.debug('여러 줄 프롬프트는 Windows 명령행에서 잘리므로 stdin 으로 전달합니다.');
    return 'stdin';
  }

  const argvPlan = buildArgs(options, 'argv', options.prompt);
  const estimated = estimateCommandLine(options.config.cursorAgentBin, argvPlan);
  const budget = commandLineBudget();

  if (estimated <= budget) return 'argv';

  log.info(
    `프롬프트가 명령행 상한을 초과합니다 (약 ${estimated}자 > ${budget}자). stdin 으로 전달합니다.`,
  );
  return 'stdin';
}

/** NDJSON 이벤트에서 토큰 사용량을 읽는다. 한 실행에서는 마지막 값을 쓴다. */
export function extractUsage(event: AgentStreamEvent): TokenUsage | null {
  const rec = event as Record<string, unknown>;
  const nested =
    rec.usage ??
    rec.token_usage ??
    (rec.message && typeof rec.message === 'object'
      ? (rec.message as Record<string, unknown>).usage
      : undefined) ??
    (rec.result && typeof rec.result === 'object'
      ? (rec.result as Record<string, unknown>).usage
      : undefined);
  if (!nested || typeof nested !== 'object') return null;
  const usage = nested as Record<string, unknown>;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0);
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? 0);
  if (input > 0 || output > 0) {
    return {
      inputTokens: Number.isFinite(input) ? input : 0,
      outputTokens: Number.isFinite(output) ? output : 0,
    };
  }
  if (total > 0) return { inputTokens: total, outputTokens: 0 };
  return null;
}

/** NDJSON 이벤트에서 사람이 읽을 수 있는 텍스트를 추출한다. */
export function extractText(event: AgentStreamEvent): string {
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
 * 단일 전달 방식으로 agent 를 한 번 실행한다.
 * NDJSON 스트림을 소비하고, 프로세스가 idle/exit 될 때까지 대기한다.
 */
function emptyAborted(startedAt: number, stderr = ''): AgentRunResult {
  return {
    exitCode: null,
    assistantText: '',
    toolCalls: [],
    timedOut: false,
    aborted: true,
    stderr,
    durationMs: Date.now() - startedAt,
  };
}

function runOnce(options: RunAgentOptions, plan: SpawnPlan): Promise<AgentRunResult> {
  const { config, signal } = options;
  const { args } = plan;
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? config.agentTimeoutMs;

  if (signal?.aborted) return Promise.resolve(emptyAborted(startedAt, '이미 중단된 실행입니다.'));

  log.info(
    `agent 실행 (${options.resumeSessionId ? `resume:${options.resumeSessionId}` : 'fresh context'}, prompt=${plan.delivery}) - prompt ${options.prompt.length} chars`,
  );
  log.debug(`args: ${args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' ')}`);

  const spawnArgs = useShell() ? args.map(quoteForWindowsShell) : args;

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn(config.cursorAgentBin, spawnArgs, {
      cwd: config.targetProjectPath,
      env: { ...process.env },
      // Windows 에서 .cmd / .ps1 형태로 배포되는 경우가 있어 shell 경유 실행
      shell: useShell(),
      windowsHide: true,
    });

    const assistantChunks: string[] = [];
    const toolCalls: string[] = [];
    // 자식 프로세스(특히 cmd.exe)는 로컬 코드페이지로 stderr 를 내보내므로
    // 바이트를 모았다가 마지막에 한 번만 디코딩한다.
    const stderrTail = new ConsoleTail(20_000);
    let spawnErrorMessage = '';
    let sessionId: string | undefined;
    let usage: TokenUsage | undefined;
    let buffer = '';
    let timedOut = false;
    let settled = false;

    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`Agent 타임아웃 (${timeoutMs}ms) - 프로세스를 종료합니다.`);
      killChildTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      log.warn('중단 요청 — Agent 프로세스 트리를 종료합니다.');
      killChildTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const handleEvent = (event: AgentStreamEvent): void => {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
      const nextUsage = extractUsage(event);
      if (nextUsage) usage = nextUsage;

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

    child.stderr.on('data', (chunk: Buffer) => stderrTail.push(chunk));

    // stdin 을 열어 둔 채로 두면 CLI 가 입력을 기다릴 수 있으므로 항상 명시적으로 닫는다.
    child.stdin.on('error', (error: Error) => {
      spawnErrorMessage += `\n[stdin error] ${error.message}`;
    });
    if (plan.stdinPayload !== null) child.stdin.write(plan.stdinPayload, 'utf8');
    child.stdin.end();

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) consumeLine(buffer);

      const result: AgentRunResult = {
        exitCode,
        assistantText: assistantChunks.join(''),
        toolCalls,
        sessionId,
        timedOut,
        aborted,
        stderr: `${stderrTail.toString()}${spawnErrorMessage}`.trim(),
        durationMs: Date.now() - startedAt,
        usage,
      };
      const usageLabel = usage
        ? `, tokens=${usage.inputTokens}+${usage.outputTokens}`
        : '';
      log.info(
        `agent 종료 (code=${exitCode}, ${Math.round(result.durationMs / 1000)}s, tools=${toolCalls.length}${usageLabel})`,
      );
      resolve(result);
    };

    child.on('error', (error) => {
      spawnErrorMessage += `\n[spawn error] ${error.message}`;
      log.error(`agent 실행 실패: ${error.message}`);
      settle(null);
    });

    child.on('close', (code) => settle(code));
  });
}

/** 명령행 길이 초과처럼 프롬프트 전달 자체가 거부된 정황을 찾는다. */
function looksLikeCommandLineOverflow(stderr: string): boolean {
  return /명령줄이 너무|command line is too long|E2BIG|ENAMETOOLONG|Argument list too long/i.test(
    stderr,
  );
}

/**
 * agent 를 실행한다.
 * `auto` 모드에서 stdin 전달이 즉시 실패하면 파일 전달로 한 번 더 시도한다.
 */
export async function runCursorAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  if (options.signal?.aborted) return emptyAborted(Date.now(), '이미 중단된 실행입니다.');

  const delivery = resolveDelivery(options);
  const result = await runOnce(options, buildPlan(options, delivery));
  if (result.aborted) return result;

  const failedWithoutOutput =
    !result.timedOut && result.exitCode !== 0 && result.assistantText.trim() === '';

  if (looksLikeCommandLineOverflow(result.stderr)) {
    log.error(
      '명령행 길이 제한으로 agent 가 프롬프트를 받지 못했습니다. CURSOR_PROMPT_DELIVERY=file 로 강제할 수 있습니다.',
    );
  }

  const canFallback =
    options.config.promptDelivery === 'auto' && delivery === 'stdin' && failedWithoutOutput;

  if (!canFallback) return result;

  log.warn('stdin 프롬프트 전달이 실패했습니다. 파일 전달 방식으로 다시 시도합니다.');
  return runOnce(options, buildPlan(options, 'file'));
}
