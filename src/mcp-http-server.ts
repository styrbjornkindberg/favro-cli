#!/usr/bin/env node
/**
 * Favro MCP HTTP Server
 *
 * Streamable-HTTP transport for hosting the favro CLI on a shared server.
 * Each request authenticates with the caller's own Favro credentials, so a
 * single deployment serves many users without storing any secrets.
 *
 * Auth (per request):
 *   Authorization: Basic base64(email:apiToken)
 *   X-Favro-Organization-Id: <orgId>   (optional — auto-resolved otherwise)
 *
 * The organizationId is resolved exactly like `favro auth login`: the server
 * calls GET /organizations with the supplied credentials and uses the single
 * org, or requires the header when the account belongs to several. Resolved
 * ids are cached in memory per credential for a short TTL.
 *
 * Credentials are forwarded to the CLI child process via FAVRO_* env vars.
 * A fresh McpServer + stateless transport is created per request, so no
 * credential ever crosses request boundaries.
 *
 * SECURITY: Basic credentials travel in a header — this server MUST sit behind
 * TLS. Bind it to localhost (default) and terminate TLS at a reverse proxy
 * (nginx/caddy). See the hosting docs.
 *
 * Env:
 *   FAVRO_MCP_PORT           listen port (default 3000)
 *   FAVRO_MCP_HOST           bind host (default 127.0.0.1)
 *   FAVRO_MCP_ALLOWED_HOSTS  comma-separated Host allowlist for DNS-rebind
 *                            protection (default 127.0.0.1:<port>,localhost:<port>)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import FavroHttpClient from './lib/http-client';
import { createMcpServer } from './mcp-server';

const MCP_PATH = '/mcp';
const ORG_CACHE_TTL_MS = 10 * 60 * 1000;

interface Creds {
  email: string;
  token: string;
}

/** Collapse a possibly-array header to a trimmed string. */
function headerStr(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return (v ?? '').trim();
}

/**
 * Resolve credentials from a request. Two equivalent forms are accepted:
 *   1. X-Favro-Email + X-Favro-Token headers (simplest to distribute)
 *   2. Authorization: Basic base64(email:apiToken)  (standard HTTP Basic)
 * Returns null when neither yields a complete email + token pair.
 */
export function parseCreds(req: IncomingMessage): Creds | null {
  const email = headerStr(req.headers['x-favro-email']);
  const token = headerStr(req.headers['x-favro-token']);
  if (email && token) return { email, token };
  return parseBasicAuth(req);
}

/** Parsed Basic-auth credentials, or null when the header is missing/malformed. */
function parseBasicAuth(req: IncomingMessage): Creds | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const email = decoded.slice(0, idx);
  const token = decoded.slice(idx + 1);
  if (!email || !token) return null;
  return { email, token };
}

interface OrgCacheEntry {
  orgId: string;
  expires: number;
}
const orgCache = new Map<string, OrgCacheEntry>();

function credKey(creds: Creds): string {
  return createHash('sha256').update(`${creds.email}:${creds.token}`).digest('hex');
}

/**
 * Per-user config directory, isolated by credential. The CLI reads/writes its
 * config (scope lock, cached userId, defaults) here via FAVRO_CONFIG_DIR, so
 * one user's `scope set` or userId cache never leaks into another's requests.
 * Path is derived from a hash — no credentials appear in it.
 *
 * Base dir defaults to the OS temp dir (cleared on reboot — scope locks reset).
 * Set FAVRO_MCP_STATE_DIR to a persistent path to keep them across restarts.
 */
export function configDirFor(creds: Creds): string {
  const base = process.env.FAVRO_MCP_STATE_DIR || path.join(os.tmpdir(), 'favro-mcp');
  return path.join(base, credKey(creds));
}

type OrgResult =
  | { orgId: string }
  | { error: { status: number; message: string } };

/**
 * Resolve the organizationId for a set of credentials.
 * Header override wins; otherwise look up the cache, else call Favro's
 * /organizations endpoint (mirroring `favro auth login`).
 */
export async function resolveOrg(creds: Creds, headerOrg: string | undefined): Promise<OrgResult> {
  if (headerOrg) return { orgId: headerOrg };

  const key = credKey(creds);
  const cached = orgCache.get(key);
  if (cached && cached.expires > nowMs()) return { orgId: cached.orgId };

  try {
    const client = new FavroHttpClient({ auth: { token: creds.token, email: creds.email } });
    const resp = await client.get<{ entities?: Array<{ organizationId: string; name: string }> }>('/organizations');
    const orgs = resp.entities ?? [];
    if (orgs.length === 0) {
      return { error: { status: 400, message: 'No organizations found for these credentials.' } };
    }
    if (orgs.length > 1) {
      const list = orgs.map((o) => `${o.name} (${o.organizationId})`).join(', ');
      return {
        error: {
          status: 400,
          message: `Account belongs to multiple organizations — send X-Favro-Organization-Id. Options: ${list}`,
        },
      };
    }
    const orgId = orgs[0].organizationId;
    orgCache.set(key, { orgId, expires: nowMs() + ORG_CACHE_TTL_MS });
    return { orgId };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      return { error: { status: 401, message: 'Invalid Favro credentials.' } };
    }
    return { error: { status: 502, message: 'Failed to resolve organization from Favro API.' } };
  }
}

/** Indirection so tests can run without the Date.now restriction in some envs. */
function nowMs(): number {
  return Date.now();
}

function sendError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

/** Handle a single MCP request: authenticate, resolve org, dispatch to a fresh server. */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const creds = parseCreds(req);
  if (!creds) {
    sendError(
      res,
      401,
      'Missing credentials. Send X-Favro-Email and X-Favro-Token headers, or Authorization: Basic base64(email:apiToken).',
      { 'WWW-Authenticate': 'Basic realm="favro-mcp"' }
    );
    return;
  }

  const headerOrgRaw = req.headers['x-favro-organization-id'];
  const headerOrg = Array.isArray(headerOrgRaw) ? headerOrgRaw[0] : headerOrgRaw;

  const org = await resolveOrg(creds, headerOrg);
  if ('error' in org) {
    const headers: Record<string, string> =
      org.error.status === 401 ? { 'WWW-Authenticate': 'Basic realm="favro-mcp"' } : {};
    sendError(res, org.error.status, org.error.message, headers);
    return;
  }

  const credsEnv: Record<string, string> = {
    FAVRO_EMAIL: creds.email,
    FAVRO_API_KEY: creds.token,
    FAVRO_ORGANIZATION_ID: org.orgId,
    FAVRO_CONFIG_DIR: configDirFor(creds),
  };

  const { server } = createMcpServer({ credsEnv });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: allowedHosts(),
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function allowedHosts(): string[] {
  const explicit = process.env.FAVRO_MCP_ALLOWED_HOSTS;
  if (explicit) return explicit.split(',').map((h) => h.trim()).filter(Boolean);
  const port = process.env.FAVRO_MCP_PORT || '3000';
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function createHttpServer() {
  return createServer((req, res) => {
    if (req.url !== MCP_PATH || req.method !== 'POST') {
      sendError(res, req.url === MCP_PATH ? 405 : 404, `Only POST ${MCP_PATH} is supported.`);
      return;
    }
    handleMcpRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal error.');
      } else {
        res.end();
      }
    });
  });
}

// Only listen when executed directly (not during tests)
if (require.main === module) {
  const port = parseInt(process.env.FAVRO_MCP_PORT || '3000', 10);
  const host = process.env.FAVRO_MCP_HOST || '127.0.0.1';
  createHttpServer().listen(port, host, () => {
    process.stderr.write(`favro-mcp-http listening on http://${host}:${port}${MCP_PATH}\n`);
  });
}
