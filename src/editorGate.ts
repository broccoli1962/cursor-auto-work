import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';
import {
  findUnityMcpEntry,
  openMcpSession,
  readUnityInstances,
  type McpRpcSession,
} from './mcpProbe';
import { ABORT_MESSAGE, abortableSleep, throwIfAborted } from './processKill';
import type { OrchestratorConfig } from './types';
import {
  formatMissingUnityTools,
  resolveUnityTools,
  toolNamesFromList,
  type UnityToolRole,
} from './unityTools';

const log = createLogger('editor-gate');

export interface EditorGateResult {
  ok: boolean;
  message: string;
  instances: string[];
  toolNames: string[];
  tools: Partial<Record<UnityToolRole, string>>;
  launched: boolean;
}

let launchedPid: number | undefined;

export function launchedUnityPid(): number | undefined {
  return launchedPid;
}

export function launchUnityEditor(config: OrchestratorConfig): { pid?: number; error?: string } {
  if (!config.unityPath) {
    return { error: 'UNITY_PATH 가 없어 에디터를 자동 실행할 수 없습니다. 에디터를 연 뒤 다시 실행하세요.' };
  }
  if (!fs.existsSync(config.unityPath)) {
    return { error: `UNITY_PATH 실행 파일을 찾을 수 없습니다: ${config.unityPath}` };
  }

  log.info(`Unity Editor 기동: ${config.unityPath}`);
  try {
    const child = spawn(config.unityPath, ['-projectPath', config.targetProjectPath], {
      cwd: path.dirname(config.unityPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    launchedPid = child.pid;
    return { pid: child.pid };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function inspectEditor(
  config: OrchestratorConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<
  Omit<EditorGateResult, 'launched' | 'ok' | 'message'> & { error?: string; hard?: boolean }
> {
  const entry = findUnityMcpEntry(config.targetProjectPath);
  if (!entry) {
    return {
      instances: [],
      toolNames: [],
      tools: {},
      hard: true,
      error:
        'UnityMCP 가 mcp.json 에 없습니다. 전역 ~/.cursor/mcp.json 또는 프로젝트 .cursor/mcp.json 에 등록하세요.',
    };
  }

  let session: McpRpcSession | null = null;
  try {
    const opened = await openMcpSession(
      entry,
      timeoutMs,
      config.targetProjectPath,
      'cursor-auto-work-gate',
      signal,
    );
    session = opened.session;
    const listed = await session.request('tools/list');
    const toolNames = toolNamesFromList(listed);
    const { resolved, missingRequired } = resolveUnityTools(toolNames);
    const instances = await readUnityInstances(session).catch(() => []);
    if (missingRequired.length > 0) {
      return {
        instances,
        toolNames,
        tools: resolved,
        hard: true,
        error: formatMissingUnityTools(missingRequired, toolNames),
      };
    }
    return { instances, toolNames, tools: resolved };
  } catch (error) {
    return {
      instances: [],
      toolNames: [],
      tools: {},
      error: `UnityMCP 에 연결하지 못했습니다: ${(error as Error).message}`,
    };
  } finally {
    await session?.close();
  }
}

/**
 * compile/full(mcp) 실행 전 에디터+UnityMCP 가 살아 있는지 확인한다.
 * 인스턴스가 없고 UNITY_LAUNCH_EDITOR 이면 에디터를 띄운 뒤 대기한다.
 */
export async function ensureLiveEditor(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<EditorGateResult> {
  throwIfAborted(signal, ABORT_MESSAGE);
  const waitMs = Math.max(config.unityLaunchTimeoutMs, 10_000);
  const started = Date.now();
  let launched = false;
  let lastError = '';

  while (Date.now() - started < waitMs) {
    throwIfAborted(signal, ABORT_MESSAGE);
    const inspect = await inspectEditor(config, Math.min(20_000, waitMs), signal);
    if (inspect.hard && inspect.error) {
      return {
        ok: false,
        message: inspect.error,
        instances: inspect.instances,
        toolNames: inspect.toolNames,
        tools: inspect.tools,
        launched,
      };
    }

    if (inspect.instances.length > 0 && !inspect.error) {
      return {
        ok: true,
        message: `Unity Editor 연결됨 (${inspect.instances.join(', ')})`,
        instances: inspect.instances,
        toolNames: inspect.toolNames,
        tools: inspect.tools,
        launched,
      };
    }

    lastError =
      inspect.error ??
      'Unity Editor 가 UnityMCP 에 연결되어 있지 않습니다. 대상 프로젝트를 에디터로 연 채로 실행하세요.';

    if (!config.unityLaunchEditor) {
      return {
        ok: false,
        message: `${lastError} (자동 기동은 UNITY_LAUNCH_EDITOR=false 로 꺼져 있습니다.)`,
        instances: inspect.instances,
        toolNames: inspect.toolNames,
        tools: inspect.tools,
        launched: false,
      };
    }

    if (config.unityLaunchEditor && !launched) {
      const launch = launchUnityEditor(config);
      if (launch.error) {
        return {
          ok: false,
          message: `${lastError} ${launch.error}`,
          instances: inspect.instances,
          toolNames: inspect.toolNames,
          tools: inspect.tools,
          launched: false,
        };
      }
      launched = true;
      log.info(`에디터 기동 후 UnityMCP 접속을 기다립니다 (최대 ${Math.round(waitMs / 1000)}초)...`);
    }

    await abortableSleep(3000, signal);
  }

  return {
    ok: false,
    message: `${lastError} (${Math.round(waitMs / 1000)}초 대기 후에도 인스턴스가 없습니다.)`,
    instances: [],
    toolNames: [],
    tools: {},
    launched,
  };
}
