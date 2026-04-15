# Plan: SPEC-MCP-001 — Favro MCP Server

## Dependency Graph

```
[T1: Install deps]
       │
       ▼
[T2: Write failing tests]
       │
       ▼
[T3: Implement mcp-server.ts]  ← makes T2 green
       │
       ▼
[T4: Wire package.json]
       │
       ▼
[T5: Build verification]
       │
       ▼
[T6: Commit]
```

All tasks are sequential — each depends on the previous.

---

## Task T1: Install dependencies

**What:** Add `@modelcontextprotocol/server` and `zod` to `package.json` dependencies.

**Files touched:**
- `package.json`
- `package-lock.yaml` / lock file (auto-updated)

**Commands:**
```bash
npm install @modelcontextprotocol/server zod
```

**Acceptance criteria:**
- [ ] Both packages appear in `package.json` `dependencies`
- [ ] `node -e "require('@modelcontextprotocol/server')"` exits 0
- [ ] `node -e "require('zod')"` exits 0

**Verification:** Run the two node -e checks above.

---

## Task T2: Write failing tests (RED)

**What:** Create `src/__tests__/mcp-server.test.ts` with 6 unit tests. All must fail before implementation.

**Files touched:**
- `src/__tests__/mcp-server.test.ts` (new)

**Tests to write:**

| # | Description | Mock setup | Assert |
|---|-------------|-----------|--------|
| 1 | Server exposes exactly 2 tools | — | `tools` array has `favro_help`, `favro_run` |
| 2 | `favro_help` (no args) → `--help` flag | `execFile` returns help text | called with `['--help']` |
| 3 | `favro_help` with `"cards list"` → correct args | `execFile` returns text | called with `['cards', 'list', '--help']` |
| 4 | `favro_run` returns stdout as content | `execFile` returns stdout | content text equals stdout |
| 5 | `favro_run` appends stderr when non-empty | `execFile` returns both | content includes `--- stderr ---` |
| 6 | `favro_run` on failing command → `isError: true` | `execFile` rejects | `result.isError === true` |

**Pattern:** Export a `createMcpServer()` factory from `mcp-server.ts` (separate from the `if require.main` startup block) so tests can call it without spawning a transport.

**Acceptance criteria:**
- [ ] `npm test -- --testPathPattern=mcp-server` shows 6 failing tests (module not found or undefined)
- [ ] No existing tests broken

---

## Task T3: Implement `src/mcp-server.ts` (GREEN)

**What:** Write the MCP server that makes all 6 tests pass.

**Files touched:**
- `src/mcp-server.ts` (new, ~100 lines)

**Structure:**
```typescript
#!/usr/bin/env node
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Exported for testing — does NOT connect to transport
export function createMcpServer(): McpServer { ... }

// Only runs when executed directly
if (require.main === module) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
```

**Binary resolution (from dist/):**
```typescript
const favroBin = path.resolve(__dirname, 'cli.js');
```

**`favro_help` tool:**
- Input: `{ command: z.string().optional() }`
- Splits `command` on whitespace, appends `--help`
- Calls `execFileAsync('node', [favroBin, ...args], { timeout: 15_000 })`
- Returns stdout (falls back to stderr if stdout empty)

**`favro_run` tool:**
- Input: `{ command: z.string() }`
- Splits on whitespace
- Calls `execFileAsync('node', [favroBin, ...args], { timeout: 60_000 })`
- Appends stderr under `--- stderr ---` if non-empty
- On rejection: returns `{ content: [{ type: 'text', text: err.message }], isError: true }`

**Acceptance criteria:**
- [ ] `npm test -- --testPathPattern=mcp-server` → 6 passing
- [ ] `npm test` (full suite) → no regressions

---

## Task T4: Wire `package.json`

**What:** Add `bin` entry and `mcp` script.

**Files touched:**
- `package.json`

**Changes:**
```json
"bin": {
  "favro": "dist/cli.js",
  "favro-mcp": "dist/mcp-server.js"
},
"scripts": {
  "build": "tsc",
  "test": "jest",
  "test:integration": "jest --config jest.integration.config.js",
  "prepack": "npm run build",
  "mcp": "node dist/mcp-server.js"
}
```

**Acceptance criteria:**
- [ ] `cat package.json | node -e "const p=require('/dev/stdin');console.log(p.bin['favro-mcp'])"` prints `dist/mcp-server.js`

---

## Task T5: Build verification

**What:** Compile TypeScript, verify output, smoke-test the binary.

**Commands:**
```bash
npm run build
node -e "require('./dist/mcp-server.js')"   # should not throw on import
```

**Acceptance criteria:**
- [ ] `npm run build` exits 0
- [ ] `dist/mcp-server.js` exists
- [ ] `npm test` (full suite) green

---

## Task T6: Commit

**What:** Single atomic commit covering all changes.

**Commit message:**
```
feat: add MCP server exposing favro_help and favro_run tools

Exposes the CLI to Claude Desktop and other MCP clients via stdio.
The server shells out to the compiled favro binary — no CLI logic
is duplicated. Two tools: favro_help (get help text) and favro_run
(execute any command). As the CLI grows, the MCP server grows automatically.
```

**Files in commit:**
- `SPEC-MCP.md`
- `package.json`
- `src/mcp-server.ts`
- `src/__tests__/mcp-server.test.ts`
- lock file changes
