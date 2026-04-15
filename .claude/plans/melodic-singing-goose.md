# Plan: Add MCP Server to favro-cli

## Context

Claude Desktop (and other MCP clients) run in a sandbox and can't invoke shell commands directly. By embedding an MCP server in favro-cli, any MCP client gets full access to the CLI's capabilities through two simple tools: `favro_help` and `favro_run`. Because `favro_run` shells out to the real `favro` binary, every existing and future CLI command is automatically available — zero duplication.

## Architecture

```
Claude Desktop / MCP Client
        │ (stdio JSON-RPC)
        ▼
  src/mcp-server.ts          ← new file, ~120 lines
  ┌─────────────────────┐
  │  McpServer           │
  │  ├─ favro_help tool  │  → runs `favro --help` or `favro <cmd> --help`
  │  └─ favro_run tool   │  → runs `favro <command...>` via child_process
  └─────────────────────┘
        │ (spawns)
        ▼
  dist/cli.js (existing CLI)
```

Key insight: the MCP server doesn't import or duplicate CLI logic. It shells out to `favro` using `child_process.execFile`, capturing stdout/stderr. As the CLI grows, the MCP server grows automatically.

## Dependencies

- `@modelcontextprotocol/server` — MCP SDK (high-level McpServer + StdioServerTransport)
- `zod` (v4) — required by MCP SDK for tool input schemas

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/mcp-server.ts` | **Create** | MCP server with 2 tools |
| `package.json` | **Edit** | Add deps + `bin.favro-mcp` + `mcp` script |
| `tsconfig.json` | No change | Already covers `src/**/*` |

## Task Breakdown

### Task 1: Add dependencies
- `npm install @modelcontextprotocol/server zod`
- **Verify:** `node -e "require('@modelcontextprotocol/server')"`

### Task 2: Create `src/mcp-server.ts`

The server exposes two tools:

**`favro_help`** — Get CLI help text
- Input: `{ command?: string }` (optional subcommand like `"cards list"`)
- Runs: `favro --help` or `favro <command> --help`
- Returns: help text as content

**`favro_run`** — Execute any CLI command
- Input: `{ command: string }` (the full command string after `favro`, e.g. `"cards list --board abc123 --json"`)
- Runs: `favro <command>` via `child_process.execFile` with shell
- Returns: stdout as content, stderr appended if non-empty
- Timeout: 60s default
- Captures exit code, returns `isError: true` on non-zero

Structure (~120 lines):
```typescript
#!/usr/bin/env node
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const server = new McpServer(
  { name: 'favro-mcp', version: '2.0.1' },
  { instructions: 'Favro CLI MCP server. Use favro_help to discover commands, favro_run to execute them.' }
);

// Resolve the favro binary path (same package)
const favroBin = require.resolve('../dist/cli.js');

server.tool('favro_help', { command: z.string().optional().describe('Subcommand to get help for, e.g. "cards list"') },
  async ({ command }) => {
    const args = command ? [...command.split(/\s+/), '--help'] : ['--help'];
    const { stdout, stderr } = await execFileAsync('node', [favroBin, ...args], { timeout: 15000 });
    return { content: [{ type: 'text', text: stdout || stderr }] };
  }
);

server.tool('favro_run', { command: z.string().describe('Command to run, e.g. "cards list --board abc123 --json"') },
  async ({ command }) => {
    const args = command.split(/\s+/);
    try {
      const { stdout, stderr } = await execFileAsync('node', [favroBin, ...args], { timeout: 60000 });
      let text = stdout;
      if (stderr) text += '\n--- stderr ---\n' + stderr;
      return { content: [{ type: 'text', text: text || '(no output)' }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Task 3: Wire up package.json

Add to `bin`:
```json
"favro-mcp": "dist/mcp-server.js"
```

Add script:
```json
"mcp": "node dist/mcp-server.js"
```

### Task 4: Build and verify

1. `npm run build` — confirm `dist/mcp-server.js` is generated
2. Test help tool: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp-server.js` — should list 2 tools
3. Manual smoke test: configure in Claude Desktop config and verify tools appear

### Task 5: Add tests

- Unit test for the MCP server startup (tools/list returns 2 tools)
- Integration test: send tools/call for favro_help, verify help text returned
- Integration test: send tools/call for favro_run with a safe read command

## Verification

1. **Build passes:** `npm run build` exits 0
2. **Tools listed:** JSON-RPC `tools/list` returns `favro_help` and `favro_run`
3. **Help works:** `favro_help` with no args returns main help text
4. **Help subcommand:** `favro_help` with `command: "cards"` returns cards help
5. **Run works:** `favro_run` with `command: "auth check"` returns auth status (or expected error)
6. **Error handling:** `favro_run` with invalid command returns `isError: true`
7. **Existing tests pass:** `npm test` still green

## Claude Desktop Configuration

After install, users add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "favro": {
      "command": "favro-mcp"
    }
  }
}
```

Or with npx:
```json
{
  "mcpServers": {
    "favro": {
      "command": "npx",
      "args": ["@square-moon/favro-cli", "mcp"]
    }
  }
}
```
