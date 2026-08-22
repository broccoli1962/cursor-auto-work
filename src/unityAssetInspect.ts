import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'library', 'temp', 'obj', 'logs', 'runtime', 'node_modules', 'usersettings']);

function walkFiles(projectRoot: string, match: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        walk(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        continue;
      }
      const fileRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (match(fileRel.replace(/\\/g, '/'))) out.push(fileRel.replace(/\\/g, '/'));
    }
  };
  walk(projectRoot, '');
  return out;
}

const GUID_RE = /\bguid:\s*([a-f0-9]{32})\b/i;
const SCRIPT_GUID_RE = /m_Script:\s*\{[^}]*guid:\s*([a-f0-9]{32})/gi;
const NAME_RE = /^\s*m_Name:\s*(.+)$/gm;
const GROUP_NAME_RE = /^\s*m_GroupName:\s*(.+)$/m;

export interface PrefabInspection {
  gameObjects: number;
  monoBehaviours: number;
  rectTransforms: number;
  canvases: number;
  transforms: number;
  names: string[];
  scriptGuids: string[];
}

export interface AddressableEntry {
  group: string;
  address: string;
  guid: string;
  groupFile: string;
}

export function inspectPrefabYaml(yaml: string): PrefabInspection {
  const names = [...yaml.matchAll(NAME_RE)]
    .map((match) => (match[1] ?? '').trim())
    .filter((name) => name && name !== '{fileID: 0}');
  const scriptGuids = [...yaml.matchAll(SCRIPT_GUID_RE)].map((match) => (match[1] ?? '').toLowerCase());

  return {
    gameObjects: countYamlClass(yaml, 'GameObject'),
    monoBehaviours: countYamlClass(yaml, 'MonoBehaviour'),
    rectTransforms: countYamlClass(yaml, 'RectTransform'),
    canvases: countYamlClass(yaml, 'Canvas'),
    transforms: countYamlClass(yaml, 'Transform'),
    names: [...new Set(names)],
    scriptGuids: [...new Set(scriptGuids)],
  };
}

function countYamlClass(yaml: string, className: string): number {
  const re = new RegExp(`^${className}:\\s*$`, 'gm');
  return yaml.match(re)?.length ?? 0;
}

export function prefabHasContent(info: PrefabInspection): boolean {
  return info.gameObjects >= 1 && (info.monoBehaviours >= 1 || info.rectTransforms >= 1 || info.canvases >= 1);
}

export function readMetaGuid(metaText: string): string | undefined {
  return GUID_RE.exec(metaText)?.[1]?.toLowerCase();
}

export function findScriptGuid(projectRoot: string, className: string): string | undefined {
  const metas = walkFiles(projectRoot, (rel) => rel.endsWith(`/${className}.cs.meta`) || rel === `${className}.cs.meta`);
  for (const rel of metas) {
    try {
      const guid = readMetaGuid(fs.readFileSync(path.join(projectRoot, rel), 'utf8'));
      if (guid) return guid;
    } catch {
      // 다음 후보
    }
  }
  return undefined;
}

export function parseAddressableGroupYaml(yaml: string, groupFile: string): AddressableEntry[] {
  if (!/m_SerializeEntries|m_Address:|AddressableAssetGroup/i.test(yaml)) return [];

  const group =
    GROUP_NAME_RE.exec(yaml)?.[1]?.trim() ||
    /^\s*m_Name:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ||
    path.basename(groupFile, path.extname(groupFile));

  const serial = yaml.split(/m_SerializeEntries\s*:/)[1] ?? yaml;
  const chunks = serial.split(/\n\s*-\s*m_GUID\s*:/);
  const entries: AddressableEntry[] = [];

  for (const chunk of chunks.slice(1)) {
    const guid = /^\s*([a-f0-9]{32})/i.exec(chunk)?.[1]?.toLowerCase() ?? '';
    const address = /m_Address\s*:\s*(.+)/.exec(chunk)?.[1]?.trim() ?? '';
    if (!address && !guid) continue;
    entries.push({ group, address, guid, groupFile });
  }

  return entries;
}

export function listAddressableEntries(projectRoot: string): AddressableEntry[] {
  const files = walkFiles(
    projectRoot,
    (rel) => rel.startsWith('Assets/AddressableAssetsData/') && rel.endsWith('.asset'),
  );
  const entries: AddressableEntry[] = [];
  for (const rel of files) {
    try {
      const yaml = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
      entries.push(...parseAddressableGroupYaml(yaml, rel));
    } catch {
      // 손상된 그룹은 건너뜀
    }
  }
  return entries;
}

export function assetGuid(projectRoot: string, assetRel: string): string | undefined {
  const meta = `${assetRel.replace(/\\/g, '/')}.meta`;
  try {
    return readMetaGuid(fs.readFileSync(path.join(projectRoot, meta), 'utf8'));
  } catch {
    return undefined;
  }
}
