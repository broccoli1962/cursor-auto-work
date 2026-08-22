export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

const KNOWN_COMMANDS = new Set(['run', 'init', 'status', 'doctor', 'help', 'preview-prompt']);

/**
 * 명령은 첫 인자가 아니어도 된다. `--project X run` 과 `run --project X` 모두 허용.
 * 명령을 생략하면 `run`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;

    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--') && !KNOWN_COMMANDS.has(next)) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }

    if (!flags._extra) flags._extra = token;
  }

  return { command: command ?? 'run', flags };
}
