import fs from 'node:fs';
import path from 'node:path';

import type { PlaytestProbe, ProbeInstance, ProbeSample } from './types';
import type { OrchestratorConfig } from './types';
import { unityCommand, unwrapCliData } from './unityCli';
import { waitForRecompile } from './unityCli';

export const PLAYTEST_LOG_REL = 'Assets/CursorAutoWork/PlaytestLog.cs';

const PLAYTEST_LOG_SOURCE = `using System.Collections.Generic;
using UnityEngine;

namespace CursorAutoWork
{
    public static class PlaytestLog
    {
        public static readonly List<string> Events = new List<string>();

        public static void Mark(string name)
        {
            if (!string.IsNullOrEmpty(name)) Events.Add(name);
        }

        public static void Clear()
        {
            Events.Clear();
        }
    }
}
`;

export function ensurePlaytestLog(projectRoot: string): boolean {
  const file = path.join(projectRoot, PLAYTEST_LOG_REL);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === PLAYTEST_LOG_SOURCE) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLAYTEST_LOG_SOURCE, 'utf8');
  return true;
}

export function safeProbeObject(name: string): string | undefined {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_ ]{1,64}$/.test(trimmed)) return undefined;
  return trimmed;
}

function parsePositionCheck(raw: unknown): PlaytestProbe['position'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const pos = raw as Record<string, unknown>;
  const objectName = typeof pos.object === 'string' ? safeProbeObject(pos.object) : undefined;
  const axis = pos.axis === 'x' || pos.axis === 'y' || pos.axis === 'z' ? pos.axis : undefined;
  if (!objectName || !axis) return undefined;
  const check: NonNullable<PlaytestProbe['position']> = { object: objectName, axis };
  if (typeof pos.deltaMin === 'number' && Number.isFinite(pos.deltaMin)) check.deltaMin = pos.deltaMin;
  if (typeof pos.deltaMax === 'number' && Number.isFinite(pos.deltaMax)) check.deltaMax = pos.deltaMax;
  return check;
}

function parseActiveCheck(raw: unknown): { object: string; equals: boolean } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const objectName = typeof rec.object === 'string' ? safeProbeObject(rec.object) : undefined;
  if (!objectName || typeof rec.equals !== 'boolean') return undefined;
  return { object: objectName, equals: rec.equals };
}

function parseTextCheck(raw: unknown): { object: string; contains: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const objectName = typeof rec.object === 'string' ? safeProbeObject(rec.object) : undefined;
  const contains = typeof rec.contains === 'string' ? rec.contains.trim() : '';
  if (!objectName || !contains) return undefined;
  return { object: objectName, contains: contains.slice(0, 80) };
}

export function parseProbe(raw: unknown): PlaytestProbe | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const probe: PlaytestProbe = {};
  if (Array.isArray(rec.events)) {
    const events = rec.events
      .filter((item): item is string => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(item.trim()))
      .map((item) => item.trim())
      .slice(0, 8);
    if (events.length > 0) probe.events = events;
  }
  const position = parsePositionCheck(rec.position);
  if (position) probe.position = position;
  if (Array.isArray(rec.positions)) {
    const positions = rec.positions.map(parsePositionCheck).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (positions.length > 0) probe.positions = positions.slice(0, 4);
  }
  const active = parseActiveCheck(rec.active);
  if (active) probe.active = active;
  if (Array.isArray(rec.actives)) {
    const actives = rec.actives.map(parseActiveCheck).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (actives.length > 0) probe.actives = actives.slice(0, 4);
  }
  const text = parseTextCheck(rec.text);
  if (text) probe.text = text;
  if (Array.isArray(rec.texts)) {
    const texts = rec.texts.map(parseTextCheck).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (texts.length > 0) probe.texts = texts.slice(0, 4);
  }
  if (!probe.events?.length && !probe.position && !probe.positions?.length && !probe.active && !probe.actives?.length && !probe.text && !probe.texts?.length) {
    return undefined;
  }
  return probe;
}

export function probeWatchList(probe: PlaytestProbe): { objects: string[]; texts: string[] } {
  const objects = new Set<string>();
  const texts = new Set<string>();
  for (const check of [probe.position, ...(probe.positions ?? [])]) {
    if (check) objects.add(check.object);
  }
  for (const check of [probe.active, ...(probe.actives ?? [])]) {
    if (check) objects.add(check.object);
  }
  for (const check of [probe.text, ...(probe.texts ?? [])]) {
    if (check) texts.add(check.object);
  }
  return { objects: [...objects], texts: [...texts] };
}

function hasEventSequence(events: string[], expected: string[]): boolean {
  let cursor = 0;
  for (const name of expected) {
    const index = events.indexOf(name, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function trackedInstances(sample: ProbeSample, name: string): ProbeInstance[] {
  const state = sample.objects[name];
  if (!state?.found) return [];
  if (state.instances && state.instances.length > 0) return state.instances;
  return [{ id: 0, active: state.active, x: state.x, y: state.y, z: state.z }];
}

function trackedTexts(sample: ProbeSample, name: string): { id: number; text: string }[] {
  const state = sample.texts[name];
  if (!state?.found) return [];
  if (state.instances && state.instances.length > 0) return state.instances;
  return [{ id: 0, text: state.text }];
}

function instanceAxis(sample: ProbeSample, name: string, id: number, axis: 'x' | 'y' | 'z'): number | undefined {
  const inst = trackedInstances(sample, name).find((item) => item.id === id);
  return inst ? inst[axis] : undefined;
}

function collectIds(samples: ProbeSample[], name: string): number[] {
  const ids = new Set<number>();
  for (const sample of samples) {
    for (const inst of trackedInstances(sample, name)) ids.add(inst.id);
  }
  return [...ids];
}

function deltaExtremesFor(
  traces: ProbeSample[],
  name: string,
  id: number,
  axis: 'x' | 'y' | 'z',
  base: number,
): { max: number; min: number } | undefined {
  let max: number | undefined;
  let min: number | undefined;
  for (const sample of traces) {
    const value = instanceAxis(sample, name, id, axis);
    if (value === undefined) continue;
    const delta = value - base;
    max = max === undefined ? delta : Math.max(max, delta);
    min = min === undefined ? delta : Math.min(min, delta);
  }
  if (max === undefined || min === undefined) return undefined;
  return { max, min };
}

function peakDelta(extremes: { max: number; min: number }, check: { deltaMin?: number; deltaMax?: number }): number {
  const negative = (check.deltaMin ?? 0) <= 0 && (check.deltaMax ?? check.deltaMin ?? 0) < 0;
  return negative ? extremes.min : extremes.max;
}

function deltaInRange(delta: number, check: { deltaMin?: number; deltaMax?: number }): boolean {
  if (check.deltaMin === undefined && check.deltaMax === undefined) return false;
  if (check.deltaMin !== undefined && delta < check.deltaMin) return false;
  if (check.deltaMax !== undefined && delta > check.deltaMax) return false;
  return true;
}

/**
 * 입력 전 대조 구간에서 이미 만족하면 실패한다.
 * 위치는 입력 이후 샘플의 정점과 기준값의 차이다. 착지 후 원위치여도 공중 정점이 남는다.
 */
export function evaluateProbe(args: {
  baseline: ProbeSample;
  control: ProbeSample;
  traces: ProbeSample[];
  probe: PlaytestProbe;
}): { ok: boolean; note: string } {
  const { baseline, control, traces, probe } = args;
  const after = traces[traces.length - 1] ?? control;
  const notes: string[] = [];
  let ok = true;
  const positions = [probe.position, ...(probe.positions ?? [])].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const actives = [probe.active, ...(probe.actives ?? [])].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const texts = [probe.text, ...(probe.texts ?? [])].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const expectedEvents = probe.events ?? [];
  if (expectedEvents.length > 0) {
    if (hasEventSequence(control.events, expectedEvents)) {
      ok = false;
      notes.push(`입력 전에 이벤트가 이미 있음: ${control.events.join(', ')}`);
    } else if (!traces.some((sample) => hasEventSequence(sample.events, expectedEvents))) {
      ok = false;
      notes.push(`이벤트 없음: ${expectedEvents.join(', ')} (받은 것: ${after.events.join(', ') || '없음'})`);
    }
  }

  for (const check of positions) {
    const ids = collectIds([baseline, control, ...traces], check.object);
    if (ids.length === 0) {
      ok = false;
      notes.push(`오브젝트 없음: ${check.object}`);
      continue;
    }
    let passed = false;
    let already = false;
    let miss = '';
    let measured = false;
    for (const id of ids) {
      const base = instanceAxis(baseline, check.object, id, check.axis);
      const early = instanceAxis(control, check.object, id, check.axis);
      if (base === undefined || early === undefined) continue;
      const extremes = deltaExtremesFor(traces, check.object, id, check.axis, base);
      if (!extremes) continue;
      measured = true;
      const earlyDelta = early - base;
      const reached = peakDelta(extremes, check);
      if (deltaInRange(earlyDelta, check)) {
        already = true;
        continue;
      }
      if (deltaInRange(reached, check)) {
        passed = true;
        miss = `${check.object}.${check.axis} 정점 변화 ${reached.toFixed(3)}`;
      } else if (!miss) {
        miss = `${check.object}.${check.axis} 정점 변화 ${reached.toFixed(3)}`;
      }
    }
    if (!measured) {
      ok = false;
      notes.push(`오브젝트 없음: ${check.object}`);
    } else if (passed) {
      if (ok) notes.push(miss);
    } else if (miss) {
      ok = false;
      notes.push(miss);
    } else if (already) {
      ok = false;
      notes.push(`입력 전에 이미 ${check.object}.${check.axis} 가 변함`);
    }
  }

  for (const check of actives) {
    const ids = collectIds([control, ...traces], check.object);
    if (ids.length === 0) {
      ok = false;
      notes.push(`오브젝트 없음: ${check.object}`);
      continue;
    }
    let passed = false;
    let already = false;
    let saw = false;
    for (const id of ids) {
      const early = trackedInstances(control, check.object).find((item) => item.id === id);
      const later = traces.some((sample) => {
        const inst = trackedInstances(sample, check.object).find((item) => item.id === id);
        return inst?.active === check.equals;
      });
      if (!early && !later) continue;
      saw = true;
      if (early && early.active === check.equals) {
        already = true;
        continue;
      }
      if (later) passed = true;
    }
    if (!saw) {
      ok = false;
      notes.push(`오브젝트 없음: ${check.object}`);
    } else if (!passed && already) {
      ok = false;
      notes.push(`입력 전에 ${check.object} 활성이 이미 ${String(check.equals)}`);
    } else if (!passed) {
      ok = false;
      notes.push(`${check.object} 활성이 ${String(check.equals)} 가 되지 않음`);
    }
  }

  for (const check of texts) {
    const ids = new Set<number>();
    for (const sample of [control, ...traces]) {
      for (const inst of trackedTexts(sample, check.object)) ids.add(inst.id);
    }
    if (ids.size === 0) {
      ok = false;
      notes.push(`글자 오브젝트 없음: ${check.object}`);
      continue;
    }
    let passed = false;
    let already = false;
    let saw = '';
    for (const id of ids) {
      const early = trackedTexts(control, check.object).find((item) => item.id === id);
      const later = traces
        .map((sample) => trackedTexts(sample, check.object).find((item) => item.id === id)?.text)
        .filter((item): item is string => item !== undefined);
      if (!early && later.length === 0) continue;
      if (early?.text.includes(check.contains)) {
        already = true;
        continue;
      }
      const hit = later.find((item) => item.includes(check.contains));
      if (hit !== undefined) passed = true;
      else if (later.length > 0) saw = later[later.length - 1] ?? '';
    }
    if (!passed && already) {
      ok = false;
      notes.push(`입력 전에 ${check.object} 글자가 이미 '${check.contains}' 를 포함`);
    } else if (!passed) {
      ok = false;
      notes.push(saw ? `${check.object} 글자 '${saw}' 에 '${check.contains}' 없음` : `글자 오브젝트 없음: ${check.object}`);
    }
  }

  if (!probe.events?.length && positions.length === 0 && actives.length === 0 && texts.length === 0) {
    return { ok: false, note: 'probe 에 events, position, active, text 중 하나가 없습니다.' };
  }
  if (ok && notes.length === 0) notes.push('측정 통과');
  return { ok, note: notes.join('; ') };
}

export function parseProbeDump(text: string): ProbeSample | null {
  const match = text.match(/(true|false)\|([-+0-9.eE]+)\|([-+0-9.eE]+)\|([-+0-9.eE]+)\|([^\r\n]*)/);
  if (!match) return null;
  const events = (match[5] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    events,
    objects: {},
    texts: {},
    position: {
      found: match[1] === 'true',
      x: Number(match[2]),
      y: Number(match[3]),
      z: Number(match[4]),
    },
  };
}

export function probeClearCode(): string {
  return 'CursorAutoWork.PlaytestLog.Clear(); return "cleared";';
}

function csharpString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function probeReadCode(objects: string[], texts: string[]): string {
  const objectList = objects.map(csharpString).join(', ');
  const textList = texts.map(csharpString).join(', ');
  return [
    'var all = Resources.FindObjectsOfTypeAll<GameObject>();',
    'var sb = new System.Text.StringBuilder();',
    'sb.Append("{\\"events\\":\\"");',
    'sb.Append(string.Join(",", CursorAutoWork.PlaytestLog.Events).Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""));',
    'sb.Append("\\",\\"objects\\":[");',
    'bool wrote = false;',
    `string[] names = new string[] { ${objectList} };`,
    'for (int i = 0; i < names.Length; i++) {',
    'var chosen = new System.Collections.Generic.List<GameObject>();',
    'for (int n = 0; n < all.Length; n++) {',
    'var go = all[n];',
    'if (go == null || !go.scene.IsValid()) continue;',
    'if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;',
    'string rest = go.name.StartsWith(names[i]) ? go.name.Substring(names[i].Length) : "";',
    'bool nameOk = go.name == names[i] || rest.StartsWith("(Clone)") || rest.StartsWith(" (Clone)");',
    'if (!nameOk) continue;',
    'int id = go.GetInstanceID();',
    'int at = chosen.Count;',
    'for (int k = 0; k < chosen.Count; k++) { if (chosen[k].GetInstanceID() > id) { at = k; break; } }',
    'if (at >= 64) continue;',
    'chosen.Insert(at, go);',
    'if (chosen.Count > 64) chosen.RemoveAt(64);',
    '}',
    'if (chosen.Count == 0) {',
    'if (wrote) sb.Append(",");',
    'wrote = true;',
    'sb.Append("{\\"name\\":\\"").Append(names[i]).Append("\\",\\"found\\":false,\\"active\\":false,\\"x\\":0,\\"y\\":0,\\"z\\":0}");',
    '} else {',
    'for (int m = 0; m < chosen.Count; m++) {',
    'if (wrote) sb.Append(",");',
    'wrote = true;',
    'var item = chosen[m];',
    'bool active = item.activeInHierarchy;',
    'var p = item.transform.position;',
    'sb.Append("{\\"name\\":\\"").Append(names[i]).Append("\\",\\"id\\":").Append(item.GetInstanceID());',
    'sb.Append(",\\"found\\":true,\\"active\\":").Append(active ? "true" : "false");',
    'sb.Append(",\\"x\\":").Append(p.x.ToString(System.Globalization.CultureInfo.InvariantCulture));',
    'sb.Append(",\\"y\\":").Append(p.y.ToString(System.Globalization.CultureInfo.InvariantCulture));',
    'sb.Append(",\\"z\\":").Append(p.z.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append("}");',
    '}',
    '}',
    '}',
    'sb.Append("],\\"texts\\":[");',
    'wrote = false;',
    `string[] labels = new string[] { ${textList} };`,
    'for (int i = 0; i < labels.Length; i++) {',
    'var labelChosen = new System.Collections.Generic.List<GameObject>();',
    'for (int n = 0; n < all.Length; n++) {',
    'var labelGo = all[n];',
    'if (labelGo == null || !labelGo.scene.IsValid()) continue;',
    'if ((labelGo.hideFlags & HideFlags.HideAndDontSave) != 0) continue;',
    'string labelRest = labelGo.name.StartsWith(labels[i]) ? labelGo.name.Substring(labels[i].Length) : "";',
    'bool labelOk = labelGo.name == labels[i] || labelRest.StartsWith("(Clone)") || labelRest.StartsWith(" (Clone)");',
    'if (!labelOk) continue;',
    'int labelId = labelGo.GetInstanceID();',
    'int labelAt = labelChosen.Count;',
    'for (int k = 0; k < labelChosen.Count; k++) { if (labelChosen[k].GetInstanceID() > labelId) { labelAt = k; break; } }',
    'if (labelAt >= 64) continue;',
    'labelChosen.Insert(labelAt, labelGo);',
    'if (labelChosen.Count > 64) labelChosen.RemoveAt(64);',
    '}',
    'if (labelChosen.Count == 0) {',
    'if (wrote) sb.Append(",");',
    'wrote = true;',
    'sb.Append("{\\"name\\":\\"").Append(labels[i]).Append("\\",\\"found\\":false,\\"text\\":\\"\\"}");',
    '} else {',
    'for (int m = 0; m < labelChosen.Count; m++) {',
    'if (wrote) sb.Append(",");',
    'wrote = true;',
    'var labelItem = labelChosen[m];',
    'string value = "";',
    'foreach (var component in labelItem.GetComponents<Component>()) {',
    'if (component == null) continue;',
    'var prop = component.GetType().GetProperty("text");',
    'if (prop != null && prop.PropertyType == typeof(string)) { value = (string)(prop.GetValue(component, null) ?? ""); break; }',
    '}',
    'value = value.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\n", " ").Replace("\\r", " ");',
    'sb.Append("{\\"name\\":\\"").Append(labels[i]).Append("\\",\\"id\\":").Append(labelItem.GetInstanceID());',
    'sb.Append(",\\"found\\":true,\\"text\\":\\"").Append(value).Append("\\"}");',
    '}',
    '}',
    '}',
    'sb.Append("]}");',
    'return sb.ToString();',
  ].join(' ');
}

function readCoord(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function rememberObject(objects: ProbeSample['objects'], item: unknown): void {
  if (!item || typeof item !== 'object') return;
  const rec = item as Record<string, unknown>;
  if (typeof rec.name !== 'string') return;
  const found = rec.found === true;
  const inst: ProbeInstance = {
    id: typeof rec.id === 'number' ? rec.id : 0,
    active: rec.active === true,
    x: readCoord(rec.x),
    y: readCoord(rec.y),
    z: readCoord(rec.z),
  };
  const prev = objects[rec.name];
  if (!found) {
    if (!prev) objects[rec.name] = { found: false, active: false, x: 0, y: 0, z: 0, instances: [] };
    return;
  }
  if (!prev?.found) {
    objects[rec.name] = { found: true, active: inst.active, x: inst.x, y: inst.y, z: inst.z, instances: [inst] };
    return;
  }
  prev.instances = [...(prev.instances ?? []), inst];
  if (inst.active) {
    prev.active = true;
    prev.x = inst.x;
    prev.y = inst.y;
    prev.z = inst.z;
  }
}

function rememberText(texts: ProbeSample['texts'], item: unknown): void {
  if (!item || typeof item !== 'object') return;
  const rec = item as Record<string, unknown>;
  if (typeof rec.name !== 'string') return;
  const found = rec.found === true;
  const text = typeof rec.text === 'string' ? rec.text : '';
  const id = typeof rec.id === 'number' ? rec.id : 0;
  const prev = texts[rec.name];
  if (!found) {
    if (!prev) texts[rec.name] = { found: false, text: '', instances: [] };
    return;
  }
  if (!prev?.found) {
    texts[rec.name] = { found: true, text, instances: [{ id, text }] };
    return;
  }
  prev.instances = [...(prev.instances ?? []), { id, text }];
  if (text) prev.text = text;
}

export function parseProbeReport(text: string): ProbeSample | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      events?: unknown;
      objects?: unknown;
      texts?: unknown;
    };
    const events =
      typeof parsed.events === 'string'
        ? parsed.events.split(',').map((item) => item.trim()).filter(Boolean)
        : [];
    const objects: ProbeSample['objects'] = {};
    if (Array.isArray(parsed.objects)) {
      for (const item of parsed.objects) rememberObject(objects, item);
    }
    const texts: ProbeSample['texts'] = {};
    if (Array.isArray(parsed.texts)) {
      for (const item of parsed.texts) rememberText(texts, item);
    }
    const first = Object.values(objects)[0];
    return {
      events,
      objects,
      texts,
      position: first ? { found: first.found, x: first.x, y: first.y, z: first.z } : undefined,
    };
  } catch {
    return null;
  }
}

function dumpFromPayload(payload: unknown, stdout: string): string {
  const data = unwrapCliData(payload);
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    for (const key of ['result', 'value', 'output', 'text']) {
      if (typeof rec[key] === 'string') return rec[key] as string;
    }
  }
  return stdout;
}

export async function readProbeSample(
  config: OrchestratorConfig,
  probe: PlaytestProbe,
  signal?: AbortSignal,
): Promise<ProbeSample> {
  const watch = probeWatchList(probe);
  const result = await unityCommand(
    config,
    'eval',
    ['--code', probeReadCode(watch.objects, watch.texts), '--timeout', '8000'],
    { timeoutMs: 20_000, signal },
  );
  const parsed = parseProbeReport(dumpFromPayload(result.payload, result.stdout)) ?? parseProbeDump(dumpFromPayload(result.payload, result.stdout));
  if (!parsed) {
    throw new Error(`probe 읽기 결과를 해석하지 못했습니다: ${result.stdout.slice(0, 240)}`);
  }
  return parsed;
}

export async function clearProbeLog(config: OrchestratorConfig, signal?: AbortSignal): Promise<void> {
  await unityCommand(config, 'eval', ['--code', probeClearCode(), '--timeout', '8000'], {
    timeoutMs: 20_000,
    signal,
  });
}

export async function compilePlaytestLogIfNew(config: OrchestratorConfig, wrote: boolean, signal?: AbortSignal): Promise<void> {
  if (!wrote) return;
  await unityCommand(config, 'recompile', [], { timeoutMs: 60_000, signal });
  await waitForRecompile(config, Math.min(config.unityTimeoutMs, 180_000), signal);
}
