/**
 * Split a command string into argv tokens, respecting single and double quotes.
 *
 * Exists because two callers need argv WITHOUT a shell, and a shell is exactly
 * what they must not have:
 *
 *  - `favro_run` (`mcp-server.ts`) executes a command line an agent composed.
 *  - `skill edit` (`commands/skill.ts`) spawns `$EDITOR`, which routinely carries
 *    arguments (`code --wait`, `emacsclient -nw`) and, on macOS, routinely lives
 *    at a path containing a space (`/Applications/My Editor.app/…`).
 *
 * A plain `split(/\s+/)` handles the arguments and breaks the spaced path. Going
 * back through `/bin/sh` would handle both and reintroduce #129's injection —
 * an `$EDITOR` of `vi; rm -rf ~` ran. Quote-aware splitting is the non-shell
 * equivalent of what git gets from `sh -c` for `core.editor`.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
