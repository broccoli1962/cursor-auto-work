import path from 'node:path';

import { ensureLiveEditor } from './editorGate';
import { createLogger } from './logger';
import {
  findUnityMcpEntry,
  openMcpSession,
  readUnityInstances,
  type McpRpcSession,
} from './mcpProbe';
import { ABORT_MESSAGE, abortableSleep, isAbortError, throwIfAborted } from './processKill';
import type { OrchestratorConfig } from './types';
import {
  formatMissingUnityTools,
  resolveUnityTools,
  toolNamesFromList,
  type UnityToolRole,
} from './unityTools';

const log = createLogger('unity-mcp');
const EDITOR_STATE_URI = 'mcpforunity://editor/state';
const sessionTools = new WeakMap<McpRpcSession, Partial<Record<UnityToolRole, string>>>();

export interface EditorState {
  ready: boolean;
  compiling: boolean;
  playing: boolean;
  retryMs: number;
}

export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const rec = result as { isError?: boolean; content?: unknown };
  if (rec.isError) {
    throw new Error(toolText(rec.content) || 'UnityMCP tools/call 이 에러를 반환했습니다.');
  }
  const text = toolText(rec.content);
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toolText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function resourceText(result: unknown): unknown {
  const rec = result as { contents?: { text?: string }[] };
  const text = rec?.contents?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function parseEditorState(raw: unknown): EditorState {
  const root = asRecord(raw) ?? {};
  const data = asRecord(root.data) ?? root;
  const advice = asRecord(data.advice) ?? asRecord(root.advice);
  const retry = Number(advice?.recommended_retry_after_ms ?? data.recommended_retry_after_ms ?? 2000);
  return {
    ready: Boolean(advice?.ready_for_tools ?? data.ready_for_tools ?? data.readyForTools ?? true),
    compiling: Boolean(data.is_compiling ?? data.isCompiling),
    playing: Boolean(data.is_playing ?? data.isPlaying ?? data.playmode),
    retryMs: Number.isFinite(retry) && retry > 0 ? retry : 2000,
  };
}

export async function callUnityTool(
  session: McpRpcSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await session.request('tools/call', { name, arguments: args });
  return unwrapToolResult(result);
}

export async function callUnityRole(
  session: McpRpcSession,
  role: UnityToolRole,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const name = sessionTools.get(session)?.[role];
  if (!name) {
    throw new Error(`UnityMCP 도구 '${role}' 을 이 서버에서 찾지 못했습니다.`);
  }
  return callUnityTool(session, name, args);
}

async function readEditorState(session: McpRpcSession): Promise<EditorState> {
  const raw = await session.request('resources/read', { uri: EDITOR_STATE_URI });
  return parseEditorState(resourceText(raw));
}

export async function waitUntilEditorReady(
  session: McpRpcSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal, ABORT_MESSAGE);
    try {
      const state = await readEditorState(session);
      if (state.ready && !state.compiling) return;
      await abortableSleep(state.retryMs, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(signal, ABORT_MESSAGE);
      await abortableSleep(2000, signal);
    }
  }
  throw new Error(`Unity Editor 가 ${timeoutMs}ms 내에 도구 사용 가능 상태로 돌아오지 않았습니다.`);
}

async function bindSessionTools(session: McpRpcSession): Promise<string[]> {
  const listed = await session.request('tools/list');
  const names = toolNamesFromList(listed);
  const { resolved, missingRequired } = resolveUnityTools(names);
  if (missingRequired.length > 0) {
    throw new Error(formatMissingUnityTools(missingRequired, names));
  }
  sessionTools.set(session, resolved);
  return names;
}

export async function withUnityEditor<T>(
  config: OrchestratorConfig,
  fn: (session: McpRpcSession, instances: string[]) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal, ABORT_MESSAGE);
  const entry = findUnityMcpEntry(config.targetProjectPath);
  if (!entry) {
    throw new Error(
      'UnityMCP 가 mcp.json 에 없습니다. 전역 ~/.cursor/mcp.json 또는 프로젝트 .cursor/mcp.json 에 등록하고 에디터를 연 채로 실행하세요.',
    );
  }

  const connect = async (): Promise<{ session: McpRpcSession; instances: string[] }> => {
    const opened = await openMcpSession(
      entry,
      config.unityTimeoutMs,
      config.targetProjectPath,
      'cursor-auto-work-validator',
      signal,
    );
    const session = opened.session;
    try {
      await bindSessionTools(session);
      const instances = await readUnityInstances(session);
      return { session, instances };
    } catch (error) {
      await session.close();
      throw error;
    }
  };

  let { session, instances } = await connect();

  try {
    if (instances.length === 0) {
      await session.close();
      const gate = await ensureLiveEditor(config, signal);
      if (!gate.ok) throw new Error(gate.message);
      ({ session, instances } = await connect());
    }

    if (instances.length === 0) {
      throw new Error(
        'Unity Editor 가 UnityMCP 에 연결되어 있지 않습니다. 대상 프로젝트를 에디터로 연 채로 검수하세요. 배치모드는 에디터를 끄므로 사용하지 않습니다.',
      );
    }

    const leaf = path.basename(config.targetProjectPath);
    const match = instances.find((id) => id.toLowerCase().includes(leaf.toLowerCase()));
    if (match && instances.length > 1) {
      try {
        await callUnityRole(session, 'setActiveInstance', { instance: match });
        log.info(`Unity 인스턴스 선택: ${match}`);
      } catch (error) {
        log.warn(`set_active_instance 실패(무시): ${(error as Error).message}`);
      }
    } else if (instances.length > 1) {
      log.warn(`Unity 인스턴스 ${instances.length}개 — 기본 활성 인스턴스를 사용합니다: ${instances.join(', ')}`);
    }

    return await fn(session, instances);
  } finally {
    await session.close();
  }
}

export async function stopPlayModeIfNeeded(
  session: McpRpcSession,
  config: OrchestratorConfig,
): Promise<boolean> {
  const state = await readEditorState(session).catch(() => null);
  if (!state?.playing) return false;

  if (!config.unityStopPlayMode) {
    throw new Error(
      'Unity Editor 가 Play Mode 입니다. 검수를 위해 재생을 끄거나 UNITY_STOP_PLAY_MODE=true 로 두세요.',
    );
  }

  log.warn('Play Mode 가 켜져 있어 검수 전에 중지합니다. 검수 후 다시 재생합니다.');
  await callUnityRole(session, 'manageEditor', { action: 'stop' });
  return true;
}

export async function restorePlayModeIfNeeded(
  session: McpRpcSession,
  wasPlaying: boolean,
  config: OrchestratorConfig,
): Promise<void> {
  if (!wasPlaying || !config.unityRestorePlayMode) return;
  try {
    await callUnityRole(session, 'manageEditor', { action: 'play' });
    log.info('검수 전 Play Mode 를 복구했습니다.');
  } catch (error) {
    log.warn(`Play Mode 복구 실패(무시): ${(error as Error).message}`);
  }
}

export async function requestLiveCompile(
  session: McpRpcSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, ABORT_MESSAGE);
  try {
    await callUnityRole(session, 'refresh', {
      mode: 'force',
      scope: 'scripts',
      compile: 'request',
      wait_for_ready: true,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAborted(signal, ABORT_MESSAGE);
    log.warn(`refresh(wait_for_ready) 실패 — 폴링으로 재시도: ${(error as Error).message}`);
    await callUnityRole(session, 'refresh', {
      mode: 'force',
      scope: 'all',
      compile: 'request',
    });
    await waitUntilEditorReady(session, timeoutMs, signal);
  }
}

export async function readConsoleErrors(session: McpRpcSession): Promise<unknown> {
  return callUnityRole(session, 'readConsole', {
    action: 'get',
    types: ['error'],
    count: '200',
    format: 'json',
    include_stacktrace: true,
  });
}

export async function clearConsole(session: McpRpcSession): Promise<void> {
  await callUnityRole(session, 'readConsole', { action: 'clear' });
}
