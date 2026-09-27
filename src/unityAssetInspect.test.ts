import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { inferVerifyChecks } from './inferVerify';
import { runVerifyChecks } from './stepVerifier';
import { inspectPrefabYaml, parseAddressableGroupYaml, prefabHasContent } from './unityAssetInspect';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  temps.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const EMPTY_PREFAB = `
%YAML 1.1
--- !u!1 &1
GameObject:
  m_Name: Empty
  m_Component:
  - component: {fileID: 2}
--- !u!4 &2
Transform:
  m_GameObject: {fileID: 1}
`.trim();

const UI_PREFAB = `
%YAML 1.1
--- !u!1 &1
GameObject:
  m_Name: MainMenu
  m_Component:
  - component: {fileID: 2}
  - component: {fileID: 3}
--- !u!224 &2
RectTransform:
  m_GameObject: {fileID: 1}
--- !u!114 &3
MonoBehaviour:
  m_GameObject: {fileID: 1}
  m_Script: {fileID: 11500000, guid: aabbccddeeff00112233445566778899, type: 3}
`.trim();

const GROUP_YAML = `
%YAML 1.1
--- !u!114 &11400000
MonoBehaviour:
  m_Name: UI
  m_GroupName: UI
  m_SerializeEntries:
  - m_GUID: 11223344556677889900aabbccddeeff
    m_Address: ui/main_menu
    m_ReadOnly: 0
`.trim();

describe('inspectPrefabYaml', () => {
  it('rejects transform-only prefabs as empty', () => {
    const info = inspectPrefabYaml(EMPTY_PREFAB);
    assert.equal(info.gameObjects, 1);
    assert.equal(prefabHasContent(info), false);
  });

  it('accepts a prefab with RectTransform and MonoBehaviour', () => {
    const info = inspectPrefabYaml(UI_PREFAB);
    assert.equal(info.rectTransforms, 1);
    assert.equal(info.monoBehaviours, 1);
    assert.deepEqual(info.scriptGuids, ['aabbccddeeff00112233445566778899']);
    assert.equal(prefabHasContent(info), true);
  });
});

describe('parseAddressableGroupYaml', () => {
  it('reads group name, address, and guid', () => {
    const entries = parseAddressableGroupYaml(GROUP_YAML, 'Assets/AddressableAssetsData/AssetGroups/UI.asset');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.group, 'UI');
    assert.equal(entries[0]?.address, 'ui/main_menu');
    assert.equal(entries[0]?.guid, '11223344556677889900aabbccddeeff');
  });
});

describe('prefab + addressable verify checks', () => {
  it('fails an empty prefab and a missing address', () => {
    const root = tempDir();
    write(root, 'Assets/Prefabs/UI/Empty.prefab', EMPTY_PREFAB);
    const results = runVerifyChecks(root, [
      { type: 'prefab', path: 'Assets/Prefabs/UI/Empty.prefab' },
      { type: 'addressable', group: 'UI', address: 'ui/main_menu' },
    ]);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[1]?.ok, false);
  });

  it('passes a wired prefab registered in an Addressables group', () => {
    const root = tempDir();
    write(root, 'Assets/Prefabs/UI/MainMenu.prefab', UI_PREFAB);
    write(
      root,
      'Assets/Prefabs/UI/MainMenu.prefab.meta',
      'guid: 11223344556677889900aabbccddeeff\n',
    );
    write(
      root,
      'Assets/Scripts/UI/MainMenu/MainMenuView.cs.meta',
      'guid: aabbccddeeff00112233445566778899\n',
    );
    write(root, 'Assets/AddressableAssetsData/AssetGroups/UI.asset', GROUP_YAML);

    const results = runVerifyChecks(root, [
      { type: 'prefab', path: 'Assets/Prefabs/UI/MainMenu.prefab', contains: ['MainMenuView'] },
      {
        type: 'addressable',
        group: 'UI',
        address: 'ui/main_menu',
        path: 'Assets/Prefabs/UI/MainMenu.prefab',
      },
    ]);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, true);
  });
});

describe('infer prefab/addressable', () => {
  it('infers prefab and addressable checks from the sample Step 4 wording', () => {
    const checks = inferVerifyChecks({
      id: 4,
      title: 'menu',
      task: "Unity CLI 로 MainMenu 프리팹을 생성하고, Addressables 그룹 'UI' 에 'ui/main_menu' 주소로 등록한다.",
      acceptanceCriteria: ['MainMenu 프리팹이 Addressables 그룹 UI 에 등록되어 있다'],
      targetFiles: ['Assets/Prefabs/UI', 'Assets/Prefabs/UI/MainMenu.prefab'],
    });
    assert.equal(
      checks.some((check) => check.type === 'prefab' && check.path === 'Assets/Prefabs/UI/MainMenu.prefab'),
      true,
    );
    assert.equal(
      checks.some((check) => check.type === 'addressable' && check.group === 'UI' && check.address === 'ui/main_menu'),
      true,
    );
  });
});
