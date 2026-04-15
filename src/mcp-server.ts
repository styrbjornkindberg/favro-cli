#!/usr/bin/env node
/**
 * Favro MCP Server
 *
 * Exposes the favro CLI to Claude Desktop and other MCP clients via stdio.
 * Two tools are registered:
 *   - favro_help: get help text for any command
 *   - favro_run:  execute any CLI command
 *
 * The server shells out to the compiled dist/cli.js binary — no CLI logic
 * is imported. As the CLI grows, the MCP server grows automatically.
 *
 * Usage (Claude Desktop config):
 *   { "mcpServers": { "favro": { "command": "favro-mcp" } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/** Path to the compiled CLI binary, resolved relative to this file's location */
const favroBin = path.resolve(__dirname, 'cli.js');

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Factory that creates and configures the McpServer instance.
 * Exported separately so tests can call it without connecting a transport.
 *
 * Returns the McpServer and a tools map (name → handler) for unit testing.
 */
export function createMcpServer(): { server: McpServer; tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>> } {
  const server = new McpServer({ name: 'favro-mcp', version: '2.0.1' });
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();

  // ─── favro_help ────────────────────────────────────────────────────────────

  async function helpHandler(args: { command?: string }): Promise<ToolResult> {
    const tokens = args.command?.trim() ? args.command.trim().split(/\s+/) : [];
    const execArgs = [...tokens, '--help'];
    try {
      const { stdout, stderr } = await execFileAsync('node', [favroBin, ...execArgs], { timeout: 15_000 });
      return { content: [{ type: 'text', text: stdout || stderr }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }

  server.registerTool(
    'favro_help',
    {
      description:
        'Get help text for the favro CLI or any subcommand. ' +
        'Omit "command" for top-level help, or pass e.g. "cards list" for subcommand help.',
      inputSchema: z.object({
        command: z.string().optional().describe('Subcommand, e.g. "cards list". Omit for top-level help.'),
      }),
    },
    helpHandler as Parameters<McpServer['registerTool']>[2]
  );
  tools.set('favro_help', helpHandler as (args: Record<string, unknown>) => Promise<ToolResult>);

  // ─── favro_run ─────────────────────────────────────────────────────────────

  async function runHandler(args: { command: string }): Promise<ToolResult> {
    const execArgs = args.command.trim().split(/\s+/);
    try {
      const { stdout, stderr } = await execFileAsync('node', [favroBin, ...execArgs], { timeout: 60_000 });
      let text = stdout || '(no output)';
      if (stderr) text += '\n--- stderr ---\n' + stderr;
      return { content: [{ type: 'text', text }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  server.registerTool(
    'favro_run',
    {
      description:
        'Execute any favro CLI command. Pass arguments after "favro", ' +
        'e.g. "cards list --board abc123 --json". The CLI\'s own --dry-run, ' +
        'scope, and confirmation flags control safety.',
      inputSchema: z.object({
        command: z.string().describe('Arguments to pass to favro, e.g. "cards list --board abc123 --json"'),
      }),
    },
    runHandler as Parameters<McpServer['registerTool']>[2]
  );
  tools.set('favro_run', runHandler as (args: Record<string, unknown>) => Promise<ToolResult>);

  return { server, tools };
}

// Only connect to transport when executed directly (not during tests)
if (require.main === module) {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err: unknown) => {
    console.error('favro-mcp: failed to start', err);
    process.exit(1);
  });
}
