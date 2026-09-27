import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from './logger';
import { abortableSleep, isAbortError } from './processKill';
import type { OrchestratorConfig } from './types';
import { unityCommand, unwrapCliData } from './unityCli';
import {
  clearProbeLog,
  compilePlaytestLogIfNew,
  ensurePlaytestLog,
  evaluateProbe,
  readProbeSample,
} from './playtestProbe';
import type { PlaytestProbe } from './types';

const log = createLogger('playtest');

export interface PlaytestShot {
  ok: boolean;
  /** 입력 이후 화면. 입력이 없으면 재생 직후 화면 */
  imagePath?: string;
  beforePath?: string;
  midPath?: string;
  afterPath?: string;
  note: string;
  stepId?: number;
  stepTitle?: string;
  /** 이번 Step 이 지정한 조작. 없으면 키/마우스를 넣지 않았다 */
  input?: string;
  /** 입력 후 화면에서 보여야 하는 결과 */
  expect?: string;
  /** 기대 화면 판정. false 이면 그 Step 을 완료로 두지 않는다 */
  matched?: boolean;
  /** probe 측정 결과. 있으면 화면 설명보다 이 값이 합격이다 */
  probeOk?: boolean;
  probeNote?: string;
}

export type PlaytestAction =
  | { type: 'wait'; ms: number }
  | { type: 'key'; key: string; action: 'down' | 'up' | 'press' }
  | { type: 'pointer'; x: number; y: number; action: 'move' | 'down' | 'up' | 'click'; button: 'left' | 'right' | 'middle' };

/** 전·중·후 파일이 모두 거의 같으면 false. 파일을 못 읽으면 undefined. */
export function shotShowsChange(paths: { beforePath?: string; midPath?: string; afterPath?: string }): boolean | undefined {
  if (!paths.beforePath || !paths.afterPath) return undefined;
  if (!fs.existsSync(paths.beforePath) || !fs.existsSync(paths.afterPath)) return undefined;
  const before = fs.readFileSync(paths.beforePath);
  const after = fs.readFileSync(paths.afterPath);
  if (framesChanged(before, after)) return true;
  if (paths.midPath && fs.existsSync(paths.midPath)) {
    return framesChanged(before, fs.readFileSync(paths.midPath));
  }
  return false;
}

/** 입력 전후 PNG 가 거의 같으면 false. 변화가 없으면 기능이 동작한 것으로 보지 않는다. */
export function framesChanged(before: Buffer, after: Buffer): boolean {
  if (before.length === 0 || after.length === 0) return true;
  const limit = Math.min(before.length, after.length);
  if (Math.abs(before.length - after.length) > limit * 0.01) return true;
  const step = Math.max(1, Math.floor(limit / 4000));
  let seen = 0;
  let diff = 0;
  for (let i = 0; i < limit; i += step) {
    seen += 1;
    if (before[i] !== after[i]) diff += 1;
  }
  return seen > 0 && diff / seen > 0.02;
}

const MAX_ACTIONS = 24;
const MAX_WAIT_MS = 5_000;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export function playtestRelPath(cycle: number, phase: 'before' | 'mid' | 'after' = 'after'): string {
  return `Logs/playtest/cycle-${cycle}-${phase}.png`;
}

/** `none`/`off` 이면 입력을 넣지 않는다. 그 외에는 `click:x,y`, `key:Name[:down|up|press]`, `move:x,y`, `wait:ms`. */
export function parsePlaytestInput(script: string): { disabled: boolean; actions: PlaytestAction[]; errors: string[] } {
  const trimmed = script.trim();
  if (!trimmed || /^(none|off|false)$/i.test(trimmed)) {
    return { disabled: true, actions: [], errors: [] };
  }

  const actions: PlaytestAction[] = [];
  const errors: string[] = [];
  const parts = trimmed.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    if (actions.length >= MAX_ACTIONS) {
      errors.push(`입력은 ${MAX_ACTIONS}개까지만 실행합니다.`);
      break;
    }
    const [head, ...rest] = part.split(':').map((item) => item.trim());
    const kind = head?.toLowerCase();
    if (kind === 'wait') {
      const ms = Number(rest[0]);
      if (!Number.isFinite(ms) || ms < 0) {
        errors.push(`wait 시간이 잘못되었습니다: ${part}`);
        continue;
      }
      actions.push({ type: 'wait', ms: Math.min(MAX_WAIT_MS, Math.floor(ms)) });
      continue;
    }
    if (kind === 'key') {
      const key = rest[0] ?? '';
      const action = (rest[1] || 'press').toLowerCase();
      if (!KEY_NAME.test(key) || (action !== 'down' && action !== 'up' && action !== 'press')) {
        errors.push(`key 형식이 잘못되었습니다: ${part}`);
        continue;
      }
      actions.push({ type: 'key', key, action });
      continue;
    }
    if (kind === 'click' || kind === 'move' || kind === 'pointer') {
      const coords = (rest[0] ?? '').split(',');
      const x = Number(coords[0]);
      const y = Number(coords[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096) {
        errors.push(`좌표가 잘못되었습니다: ${part}`);
        continue;
      }
      const action = kind === 'move' ? 'move' : kind === 'click' ? 'click' : (rest[1] || 'click').toLowerCase();
      const rawButton = kind === 'pointer' ? rest[2] : rest[1];
      const button = (rawButton || 'left').toLowerCase();
      if (action !== 'move' && action !== 'down' && action !== 'up' && action !== 'click') {
        errors.push(`포인터 동작이 잘못되었습니다: ${part}`);
        continue;
      }
      if (button !== 'left' && button !== 'right' && button !== 'middle') {
        errors.push(`마우스 버튼이 잘못되었습니다: ${part}`);
        continue;
      }
      actions.push({
        type: 'pointer',
        x: Math.round(x),
        y: Math.round(y),
        action,
        button,
      });
      continue;
    }
    errors.push(`알 수 없는 입력입니다: ${part}`);
  }

  return { disabled: false, actions, errors };
}

export function extractCapturePath(payload: unknown): string | undefined {
  const data = unwrapCliData(payload);
  const records: Record<string, unknown>[] = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) records.push(data as Record<string, unknown>);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) records.push(payload as Record<string, unknown>);

  for (const rec of records) {
    for (const key of ['path', 'savePath', 'save_path', 'output', 'file', 'screenshotPath']) {
      const value = rec[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function existingShot(projectRoot: string, rel: string, reported?: string): string | undefined {
  const candidates = [reported, rel].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return undefined;
}

async function captureFrame(
  config: OrchestratorConfig,
  rel: string,
  source: 'screen' | 'camera',
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await unityCommand(
    config,
    'capture_game_view',
    ['--source', source, '--save_path', rel, '--width', '1280', '--height', '720'],
    { timeoutMs: 60_000, signal },
  );
  return existingShot(config.targetProjectPath, rel, extractCapturePath(result.payload));
}

async function grabFrame(
  config: OrchestratorConfig,
  rel: string,
  signal?: AbortSignal,
): Promise<{ path?: string; note: string }> {
  try {
    const screen = await captureFrame(config, rel, 'screen', signal);
    if (screen) return { path: screen, note: '' };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const note = `화면 합성 캡처 실패: ${(error as Error).message}`;
    log.warn(note);
    try {
      const camera = await captureFrame(config, rel, 'camera', signal);
      if (camera) return { path: camera, note: `${note} 카메라 렌더로 다시 찍었습니다.` };
    } catch (cameraError) {
      if (isAbortError(cameraError)) throw cameraError;
      return { note: `${note} 카메라 캡처 실패: ${(cameraError as Error).message}` };
    }
    return { note };
  }
  return { note: 'Game 뷰 캡처 파일이 생성되지 않았습니다.' };
}

async function runPlaytestInputs(
  config: OrchestratorConfig,
  inputScript: string,
  signal: AbortSignal | undefined,
  onMid?: () => Promise<void>,
  onSample?: () => Promise<void>,
): Promise<string> {
  const parsed = parsePlaytestInput(inputScript);
  if (parsed.disabled) return '키/마우스 입력 없이 화면만 찍습니다.';
  if (parsed.actions.length === 0) {
    return parsed.errors.join(' ') || '실행할 키/마우스 입력이 없습니다.';
  }

  const done: string[] = [];
  const midAt = Math.max(1, Math.floor(parsed.actions.length / 2));
  for (let index = 0; index < parsed.actions.length; index += 1) {
    const action = parsed.actions[index];
    if (!action) continue;
    if (action.type === 'wait') {
      if (action.ms > 0) await abortableSleep(action.ms, signal);
      done.push(`wait ${action.ms}ms`);
      if (onMid && index + 1 === midAt) await onMid();
      if (onSample) await onSample();
      continue;
    }
    try {
      if (action.type === 'key') {
        await unityCommand(config, 'simulate_key', ['--key', action.key, '--action', action.action], {
          timeoutMs: 15_000,
          signal,
        });
        done.push(`key ${action.key} ${action.action}`);
      } else {
        await unityCommand(
          config,
          'simulate_pointer',
          ['--x', String(action.x), '--y', String(action.y), '--action', action.action, '--button', action.button],
          { timeoutMs: 15_000, signal },
        );
        done.push(`pointer ${action.button} ${action.action} ${action.x},${action.y}`);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = (error as Error).message;
      done.push(`실패(${message})`);
      log.warn(`입력 주입 실패: ${message}`);
      break;
    }
    await abortableSleep(80, signal);
    if (onMid && index + 1 === midAt) await onMid();
    if (onSample) await onSample();
  }

  const problems = parsed.errors.length > 0 ? ` 무시: ${parsed.errors.join(' / ')}` : '';
  return `입력: ${done.join(' → ')}.${problems} Input System 패키지가 켜져 있어야 게임에 전달됩니다.`;
}

/**
 * Play Mode 에 들어간 뒤, 스크립트대로 키와 마우스를 넣고 Game 뷰를 전/후로 남긴다.
 * 입력은 OS 커서가 아니라 에디터 안의 Input System 으로 들어간다.
 * 끝나면 재생을 끈다. 다음 컴파일 검수가 Edit Mode 를 쓰기 때문이다.
 */
export async function capturePlaytest(
  config: OrchestratorConfig,
  cycle: number,
  signal: AbortSignal | undefined,
  inputScript: string,
  probe?: PlaytestProbe,
): Promise<PlaytestShot> {
  const beforeRel = playtestRelPath(cycle, 'before');
  const afterRel = playtestRelPath(cycle, 'after');
  fs.mkdirSync(path.dirname(path.join(config.targetProjectPath, beforeRel)), { recursive: true });

  let started = false;
  try {
    const wroteLog = ensurePlaytestLog(config.targetProjectPath);
    await compilePlaytestLogIfNew(config, wroteLog, signal);
    await unityCommand(config, 'editor_play', [], { timeoutMs: 30_000, signal });
    started = true;
    if (config.playtestSettleMs > 0) await abortableSleep(config.playtestSettleMs, signal);

    const parsed = parsePlaytestInput(inputScript);
    if (parsed.disabled) {
      const frame = await grabFrame(config, afterRel, signal);
      const note = ['이 Step 에는 기능 조작이 없어 키와 마우스를 넣지 않았다.', frame.note].filter(Boolean).join(' ');
      if (!frame.path) return { ok: false, note };
      log.info(`플레이 화면 저장: ${frame.path}`);
      return { ok: true, imagePath: frame.path, note };
    }

    let probeOk: boolean | undefined;
    let probeNote: string | undefined;
    let beforeSample: Awaited<ReturnType<typeof readProbeSample>> | undefined;
    let controlSample: Awaited<ReturnType<typeof readProbeSample>> | undefined;
    if (probe) {
      try {
        await clearProbeLog(config, signal);
        beforeSample = await readProbeSample(config, probe, signal);
        await abortableSleep(200, signal);
        controlSample = await readProbeSample(config, probe, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        probeOk = false;
        probeNote = `probe 초기화 실패: ${(error as Error).message}`;
      }
    } else {
      probeOk = false;
      probeNote = 'probe 가 없습니다. events, position, active, text 중 하나가 있어야 통과합니다.';
    }

    const before = await grabFrame(config, beforeRel, signal);
    const midRel = playtestRelPath(cycle, 'mid');
    let midPath: string | undefined;
    const traces: Awaited<ReturnType<typeof readProbeSample>>[] = [];
    const inputNote = await runPlaytestInputs(config, inputScript, signal, async () => {
      const mid = await grabFrame(config, midRel, signal);
      midPath = mid.path;
    }, async () => {
      if (!probe || probeOk === false) return;
      try {
        traces.push(await readProbeSample(config, probe, signal));
      } catch (error) {
        if (isAbortError(error)) throw error;
        probeOk = false;
        probeNote = `probe 표본 실패: ${(error as Error).message}`;
      }
    });
    if (config.playtestSettleMs > 0) await abortableSleep(Math.min(config.playtestSettleMs, 1_000), signal);
    const after = await grabFrame(config, afterRel, signal);
    if (probe && beforeSample && controlSample && probeOk !== false) {
      try {
        traces.push(await readProbeSample(config, probe, signal));
        const judged = evaluateProbe({ baseline: beforeSample, control: controlSample, traces, probe });
        probeOk = judged.ok;
        probeNote = judged.note;
      } catch (error) {
        if (isAbortError(error)) throw error;
        probeOk = false;
        probeNote = `probe 읽기 실패: ${(error as Error).message}`;
      }
    }

    const imagePath = after.path ?? before.path;
    const notes = [before.note, inputNote, probeNote, after.note].filter(Boolean);
    if (!imagePath) {
      return {
        ok: false,
        probeOk,
        probeNote,
        note: notes.join(' ') || 'Game 뷰 캡처 파일이 생성되지 않았습니다.',
      };
    }
    log.info(`플레이 화면 저장: ${imagePath}`);
    return {
      ok: true,
      imagePath,
      beforePath: before.path,
      midPath,
      afterPath: after.path,
      probeOk,
      probeNote,
      note: notes.join(' ') || 'Play Mode 에서 입력을 넣고 Game 뷰를 캡처했습니다.',
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { ok: false, note: `Play Mode 진입 실패: ${(error as Error).message}` };
  } finally {
    if (started) {
      try {
        await unityCommand(config, 'editor_stop', [], { timeoutMs: 30_000, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.warn(`Play Mode 종료 실패(무시): ${(error as Error).message}`);
      }
    }
  }
}
