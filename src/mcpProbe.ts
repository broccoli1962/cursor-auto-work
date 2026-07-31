import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import axios from 'axios';

import { decodeConsole } from './encoding';
import { createLogger } from './logger';

const log = createLogger('mcp');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'cursor-auto-work-doctor', version: '0.1.0' };
const UNITY_INSTANCES_URI = 'mcpforunity://instances';

export type McpTransport = 'http' | 'stdio';
export type McpScope = 'project' | 'global';

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  def: McpServerDef;
  /** 이 항목을 정의한 mcp.json 경로 */
  source: string;
}

export interface McpProbeResult {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  /** initialize + tools/list 까지 실제로 성공했는지 */
  ok: boolean;
  /** disabled 로 표시되어 점검을 건너뛴 경우 */
  skipped: boolean;
  /** 서버가 보고한 이름/버전 */
  serverInfo?: string;
  toolCount?: number;
  durationMs: number;
  error?: string;
  /** UnityMCP 에 붙어 있는 Editor 인스턴스 (예: AutoRpg@30a4666de7d51ef1) */
  unityInstances?: string[];
  /** 연결은 되었지만 주의가 필요한 상태 */
  warning?: string;
}

function readMcpFile(file: string, scope: McpScope): McpServerEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, McpServerDef>;
      servers?: Record<string, McpServerDef>;
    };
    const servers = parsed.mcpServers ?? parsed.servers ?? {};
    return Object.entries(servers).map(([name, raw]) => {
      const def = raw ?? {};
      return {
        name,
        scope,
        transport: def.url ? ('http' as const) : ('stdio' as const),
        def,
        source: file,
      };
    });
  } catch (error) {
    log.warn(`${file} 파싱 실패: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Cursor 와 동일하게 전역(`~/.cursor/mcp.json`) + 프로젝트(`.cursor/mcp.json`) 를 병합한다.
 * 이름이 겹치면 프로젝트 설정이 우선한다.
 */
export function loadMcpServers(projectRoot: string): McpServerEntry[] {
  const merged = new Map<string, McpServerEntry>();
  const globalPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  const projectPath = path.join(projectRoot, '.cursor', 'mcp.json');

  for (const entry of readMcpFile(globalPath, 'global')) merged.set(entry.name, entry);
  for (const entry of readMcpFile(projectPath, 'project')) merged.set(entry.name, entry);

  return [...merged.values()];
}

/** 프롬프트 주입용 - 활성화된 MCP 서버 이름 목록. */
export function listMcpServerNames(projectRoot: string): string[] {
  return loadMcpServers(projectRoot)
    .filter((entry) => !entry.def.disabled)
    .map((entry) => entry.name);
}

interface RpcSession {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; message?: unknown };
    return `RPC ${String(rec.code ?? '?')}: ${String(rec.message ?? 'unknown error')}`;
  }
  return 'unknown RPC error';
}

/** Streamable HTTP 응답은 순수 JSON 이거나 SSE(`data: {...}`) 프레임이다. 둘 다 처리한다. */
function extractRpcPayloads(raw: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  const push = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') payloads.push(parsed as Record<string, unknown>);
    } catch {
      // SSE 주석/빈 프레임은 무시
    }
  };

  if (/^\s*(event|data):/m.test(raw)) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) push(trimmed.slice(5));
    }
  } else {
    push(raw);
  }

  return payloads;
}

class HttpRpcSession implements RpcSession {
  private sessionId = '';

  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs: number,
  ) {}

  private async post(body: unknown): Promise<{ status: number; raw: string }> {
    const response = await axios.post(this.url, JSON.stringify(body), {
      timeout: this.timeoutMs,
      responseType: 'text',
      transformResponse: [(data: unknown) => data],
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
    });

    const sessionId = response.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId;

    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    return { status: response.status, raw };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const { status, raw } = await this.post({ jsonrpc: '2.0', id, method, params });
    if (status >= 400) {
      throw new Error(`HTTP ${status}${raw ? ` - ${raw.trim().slice(0, 200)}` : ''}`);
    }

    const match = extractRpcPayloads(raw).find((payload) => payload.id === id);
    if (!match) throw new Error(`${method} 응답을 해석할 수 없습니다 (HTTP ${status})`);
    if (match.error) throw new Error(rpcErrorMessage(match.error));
    return match.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await axios.delete(this.url, {
        timeout: 3000,
        validateStatus: () => true,
        headers: { 'Mcp-Session-Id': this.sessionId },
      });
    } catch {
      // 세션 정리는 실패해도 점검 결과에 영향을 주지 않는다
    }
  }
}

class StdioRpcSession implements RpcSession {
  private readonly child: ChildProcessWithoutNullStreams;

  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private nextId = 1;

  private buffer = '';

  private stderrChunks: Buffer[] = [];

  private stderrBytes = 0;

  private exitReason: string | null = null;

  constructor(
    def: McpServerDef,
    cwd: string,
    private readonly timeoutMs: number,
  ) {
    if (!def.command) throw new Error('command 가 정의되어 있지 않습니다');

    this.child = spawn(def.command, def.args ?? [], {
      cwd: def.cwd ?? cwd,
      env: { ...process.env, ...(def.env ?? {}) },
      // Windows 에서 npx/uvx 가 .cmd 로 배포되므로 shell 경유 실행
      shell: process.platform === 'win32',
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
      this.stderrBytes += chunk.length;
      while (this.stderrBytes > 4000 && this.stderrChunks.length > 1) {
        this.stderrBytes -= this.stderrChunks.shift()?.length ?? 0;
      }
    });

    this.child.on('error', (error) => this.fail(`프로세스 실행 실패: ${error.message}`));
    this.child.on('close', (code) => this.fail(`프로세스가 코드 ${code} 로 종료됨${this.stderrTail()}`));
  }

  private stderrTail(): string {
    if (this.stderrChunks.length === 0) return '';
    const tail = decodeConsole(Buffer.concat(this.stderrChunks))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' / ');
    return tail ? ` - ${tail}` : '';
  }

  private fail(reason: string): void {
    this.exitReason = reason;
    for (const [, handlers] of this.pending) handlers.reject(new Error(reason));
    this.pending.clear();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof payload.id !== 'number') continue;
      const handlers = this.pending.get(payload.id);
      if (!handlers) continue;
      this.pending.delete(payload.id);
      if (payload.error) handlers.reject(new Error(rpcErrorMessage(payload.error)));
      else handlers.resolve(payload.result);
    }
  }

  private write(message: unknown): void {
    if (this.exitReason) throw new Error(this.exitReason);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 응답 타임아웃 (${this.timeoutMs}ms)${this.stderrTail()}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      this.write({ jsonrpc: '2.0', method, params });
    } catch {
      // 알림 실패는 이어지는 request 에서 잡힌다
    }
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.child.removeAllListeners('close');
    if (this.child.exitCode !== null) return;
    // stdin 종료가 MCP stdio 서버의 정상 종료 신호다. 응답이 없으면 강제 종료한다.
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function isUnityServer(entry: McpServerEntry, serverName: string): boolean {
  const haystack = `${entry.name} ${serverName} ${entry.def.url ?? ''} ${entry.def.command ?? ''}`;
  return haystack.toLowerCase().includes('unity');
}

/** UnityMCP 는 서버가 살아 있어도 Editor 가 안 붙어 있으면 도구 호출이 실패한다. 인스턴스까지 확인한다. */
async function readUnityInstances(session: RpcSession): Promise<string[]> {
  const response = (await session.request('resources/read', { uri: UNITY_INSTANCES_URI })) as {
    contents?: { text?: string }[];
  };

  const text = response?.contents?.[0]?.text;
  if (!text) return [];

  const parsed = JSON.parse(text) as { instances?: { id?: string; name?: string }[] };
  return (parsed.instances ?? []).map((instance) => instance.id ?? instance.name ?? 'unknown');
}

/**
 * MCP 서버에 실제로 접속해 `initialize` → `tools/list` 핸드셰이크를 수행한다.
 * 설정 파일에 이름이 적혀 있는지가 아니라, 지금 응답하는지를 확인한다.
 */
export async function probeMcpServer(
  entry: McpServerEntry,
  timeoutMs: number,
  projectRoot: string,
): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const base = { name: entry.name, scope: entry.scope, transport: entry.transport };

  if (entry.def.disabled) {
    return { ...base, ok: false, skipped: true, durationMs: 0, error: '설정에서 비활성화됨' };
  }

  let session: RpcSession | null = null;
  try {
    session =
      entry.transport === 'http'
        ? new HttpRpcSession(entry.def.url ?? '', entry.def.headers ?? {}, timeoutMs)
        : new StdioRpcSession(entry.def, projectRoot, timeoutMs);

    const init = (await session.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { serverInfo?: { name?: string; version?: string } };

    await session.notify('notifications/initialized');

    const listed = (await session.request('tools/list')) as { tools?: unknown[] };

    const serverName = init?.serverInfo?.name ?? '';
    const result: McpProbeResult = {
      ...base,
      ok: true,
      skipped: false,
      serverInfo: serverName ? `${serverName} ${init?.serverInfo?.version ?? ''}`.trim() : undefined,
      toolCount: Array.isArray(listed?.tools) ? listed.tools.length : 0,
      durationMs: Date.now() - startedAt,
    };

    if (isUnityServer(entry, serverName)) {
      try {
        const instances = await readUnityInstances(session);
        result.unityInstances = instances;
        if (instances.length === 0) {
          result.warning = 'Unity Editor 가 연결되어 있지 않습니다 - Editor 를 실행해 두세요.';
        }
      } catch (error) {
        result.warning = `Unity 인스턴스 조회 실패: ${(error as Error).message}`;
      }
    }

    return result;
  } catch (error) {
    return {
      ...base,
      ok: false,
      skipped: false,
      durationMs: Date.now() - startedAt,
      error: (error as Error).message,
    };
  } finally {
    await session?.close();
  }
}

export async function probeMcpServers(
  projectRoot: string,
  timeoutMs = 20_000,
): Promise<McpProbeResult[]> {
  const entries = loadMcpServers(projectRoot);
  const results: McpProbeResult[] = [];
  for (const entry of entries) {
    results.push(await probeMcpServer(entry, timeoutMs, projectRoot));
  }
  return results;
}

/** doctor 출력용 한 줄 요약. */
export function formatProbeResult(result: McpProbeResult): string[] {
  const mark = result.skipped ? '[SKIP]' : result.ok ? '[ OK ]' : '[FAIL]';
  const head = `  ${mark} ${result.name} (${result.scope}, ${result.transport})`;

  if (!result.ok) return [`${head} - ${result.error ?? '알 수 없는 실패'}`];

  const details = [
    result.serverInfo,
    `도구 ${result.toolCount ?? 0}개`,
    `${result.durationMs}ms`,
  ].filter(Boolean);

  const lines = [`${head} - ${details.join(' · ')}`];
  if (result.unityInstances && result.unityInstances.length > 0) {
    lines.push(`         Unity 인스턴스: ${result.unityInstances.join(', ')}`);
  }
  if (result.warning) lines.push(`         ! ${result.warning}`);
  return lines;
}
