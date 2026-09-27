import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';
import { ABORT_MESSAGE, abortableSleep, throwIfAborted } from './processKill';
import type { OrchestratorConfig } from './types';
import {
  detectPipeline,
  editorLooksLive,
  editorMatchesProject,
  installPipelinePackage,
  listConnectedEditors,
  openProjectWithCli,
  promptInstall,
} from './unityCli';

const log = createLogger('editor-gate');

export interface EditorGateResult {
  ok: boolean;
  message: string;
  launched: boolean;
}

let launchedPid: number | undefined;

export function launchedUnityPid(): number | undefined {
  return launchedPid;
}

function launchUnityExecutable(config: OrchestratorConfig): { pid?: number; error?: string } {
  if (!config.unityPath) {
    return { error: 'UNITY_PATH 가 없어 Unity.exe 로 폴백할 수 없습니다.' };
  }
  if (!fs.existsSync(config.unityPath)) {
    return { error: `UNITY_PATH 실행 파일을 찾을 수 없습니다: ${config.unityPath}` };
  }

  log.info(`Unity Editor 기동 (UNITY_PATH): ${config.unityPath}`);
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

async function launchEditor(config: OrchestratorConfig, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  log.info(`Unity Editor 기동: unity open ${config.targetProjectPath}`);
  const opened = await openProjectWithCli(config, signal);
  if (opened.ok) return opened;

  log.warn(`${opened.message} UNITY_PATH 로 다시 띄웁니다.`);
  const fallback = launchUnityExecutable(config);
  if (fallback.error) return { ok: false, message: `${opened.message} ${fallback.error}` };
  return { ok: true, message: 'UNITY_PATH 로 에디터를 띄웠습니다.' };
}

async function ensurePipeline(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const installed = await detectPipeline(config, signal);
  if (installed === true) return { ok: true, message: 'Unity Pipeline 연결됨' };
  if (installed === undefined) {
    log.warn('Pipeline 설치 여부를 확인하지 못했습니다. 컴파일 명령으로 다시 확인합니다.');
    return { ok: true, message: 'Unity Editor 연결됨 (Pipeline 상태 불명)' };
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let confirmed = false;
  if (config.unityPipelineInstall === 'ask' && interactive) {
    confirmed = await promptInstall(
      'Unity Pipeline 패키지(com.unity.pipeline)가 없습니다. `unity pipeline install` 을 실행할까요? [y/N] ',
    );
  }
  const shouldInstall =
    config.unityPipelineInstall === 'yes' || (config.unityPipelineInstall === 'ask' && interactive && confirmed);
  if (!shouldInstall) {
    return {
      ok: false,
      message:
        '열린 에디터에 Unity Pipeline 패키지가 없습니다. 프로젝트를 연 뒤 `unity pipeline install` 을 실행하거나 UNITY_PIPELINE_INSTALL=yes 로 두세요. Unity 6.0 이상이 필요합니다.',
    };
  }

  const install = await installPipelinePackage(config, signal);
  if (!install.ok) return install;
  return { ok: true, message: install.message };
}

/**
 * compile/full(cli) 실행 전 공식 Unity CLI 와 열린 에디터가 준비됐는지 확인한다.
 * 인스턴스가 없고 UNITY_LAUNCH_EDITOR 이면 `unity open` 으로 띄운 뒤 대기한다.
 */
export async function ensureLiveEditor(
  config: OrchestratorConfig,
  signal?: AbortSignal,
): Promise<EditorGateResult> {
  throwIfAborted(signal, ABORT_MESSAGE);
  const waitMs = Math.max(config.unityLaunchTimeoutMs, 10_000);
  const started = Date.now();
  let launched = false;
  let lastError = 'Unity Editor 가 Unity CLI 에 연결되어 있지 않습니다.';

  while (Date.now() - started < waitMs) {
    throwIfAborted(signal, ABORT_MESSAGE);
    let editors: Awaited<ReturnType<typeof listConnectedEditors>> = [];
    try {
      editors = await listConnectedEditors(config, signal);
    } catch (error) {
      lastError = (error as Error).message;
      if (!config.unityLaunchEditor) {
        return { ok: false, message: lastError, launched };
      }
    }

    const live = editors.find(
      (editor) => editorMatchesProject(editor, config.targetProjectPath) && editorLooksLive(editor),
    );
    if (live) {
      const pipeline = await ensurePipeline(config, signal);
      if (!pipeline.ok) return { ok: false, message: pipeline.message, launched };
      const label = live.port ? `${live.projectPath} :${live.port}` : live.projectPath;
      return { ok: true, message: `${pipeline.message} (${label})`, launched };
    }

    if (editors.length > 0) {
      lastError = `열린 에디터가 대상 프로젝트가 아닙니다: ${editors.map((editor) => editor.projectPath).join(', ')}`;
    } else {
      lastError = 'Unity Editor 가 떠 있지 않습니다. 대상 프로젝트를 연 채로 실행하세요.';
    }

    if (!config.unityLaunchEditor) {
      return {
        ok: false,
        message: `${lastError} (자동 기동은 UNITY_LAUNCH_EDITOR=false 로 꺼져 있습니다.)`,
        launched: false,
      };
    }

    if (!launched) {
      const launch = await launchEditor(config, signal);
      if (!launch.ok) return { ok: false, message: `${lastError} ${launch.message}`, launched: false };
      launched = true;
      log.info(`에디터 기동 후 Unity CLI 접속을 기다립니다 (최대 ${Math.round(waitMs / 1000)}초)...`);
    }

    await abortableSleep(3_000, signal);
  }

  return {
    ok: false,
    message: `${lastError} (${Math.round(waitMs / 1000)}초 대기 후에도 인스턴스가 없습니다.)`,
    launched,
  };
}
