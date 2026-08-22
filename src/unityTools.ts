export type UnityToolRole =
  | 'refresh'
  | 'readConsole'
  | 'manageEditor'
  | 'runTests'
  | 'getTestJob'
  | 'setActiveInstance';

export const UNITY_TOOL_ALIASES: Record<UnityToolRole, string[]> = {
  refresh: ['refresh_unity', 'refresh'],
  readConsole: ['read_console', 'get_console'],
  manageEditor: ['manage_editor', 'editor'],
  runTests: ['run_tests', 'run_test'],
  getTestJob: ['get_test_job', 'test_job'],
  setActiveInstance: ['set_active_instance', 'select_instance'],
};

export const REQUIRED_UNITY_TOOLS: UnityToolRole[] = ['refresh', 'readConsole'];

export function toolNamesFromList(listed: unknown): string[] {
  const tools = (listed as { tools?: { name?: unknown }[] } | undefined)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (tool && typeof tool.name === 'string' ? tool.name : ''))
    .filter(Boolean);
}

function matchAlias(available: string[], alias: string): string | undefined {
  const needle = alias.toLowerCase();
  const exact = available.find((name) => name.toLowerCase() === needle);
  if (exact) return exact;
  return available.find((name) => {
    const lower = name.toLowerCase();
    return lower.endsWith(`_${needle}`) || lower.endsWith(`/${needle}`);
  });
}

export function resolveUnityTools(available: string[]): {
  resolved: Partial<Record<UnityToolRole, string>>;
  missingRequired: UnityToolRole[];
} {
  const resolved: Partial<Record<UnityToolRole, string>> = {};
  for (const [role, aliases] of Object.entries(UNITY_TOOL_ALIASES) as [UnityToolRole, string[]][]) {
    for (const alias of aliases) {
      const hit = matchAlias(available, alias);
      if (hit) {
        resolved[role] = hit;
        break;
      }
    }
  }
  return {
    resolved,
    missingRequired: REQUIRED_UNITY_TOOLS.filter((role) => !resolved[role]),
  };
}

export function formatMissingUnityTools(
  missing: UnityToolRole[],
  available: string[],
): string {
  return (
    `UnityMCP 도구가 없습니다: ${missing.join(', ')}. ` +
    `이 서버의 도구: ${available.length > 0 ? available.join(', ') : '(없음)'}. ` +
    'MCP for Unity 버전을 확인하세요.'
  );
}
