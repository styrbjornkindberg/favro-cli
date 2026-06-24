# Favro MCP HTTP Server — Deployment Spec

What the `favro-mcp-http` server is, what it needs, and the app-specific constraints
for fronting it with TLS. Assumes you already know how to run a Node process, write a
unit file, and configure a reverse proxy.

## What it is

A Node HTTP service exposing the Favro CLI to AI clients (Claude, Cursor) over the
MCP **Streamable-HTTP** transport. Ships in the `@square-moon/favro-cli` package as the
`favro-mcp-http` bin (also `node dist/mcp-http-server.js`). Requires Node 20+.

## Get the build

Clone and build from GitHub:

```bash
git clone https://github.com/styrbjornkindberg/favro-cli.git
cd favro-cli
npm ci
npm run build
```

This produces `dist/`. Run the server with `node dist/mcp-http-server.js` or
`npm run mcp:http`. To put the `favro-mcp-http` command on PATH, `npm link` (or
`npm install -g .`) from the repo root.

## No secrets on the server

The service stores **nothing**. Every request carries the caller's own Favro
credentials as HTTP Basic auth, which pass straight through to Favro's API. There is no
config file, no env-based API key, no per-user state to provision. Don't put Favro
credentials in the environment or unit file.

## Run target

- Binds **HTTP only** to `FAVRO_MCP_HOST` (keep it `127.0.0.1`). TLS is terminated in front.
- Single endpoint: **`POST /mcp`**. Everything else returns 404/405.
- Stateless apart from a short in-memory cache of resolved org IDs → restart any time, safe.

Environment variables (all optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `FAVRO_MCP_PORT` | `3000` | Listen port |
| `FAVRO_MCP_HOST` | `127.0.0.1` | Bind host — leave on localhost |
| `FAVRO_MCP_ALLOWED_HOSTS` | `127.0.0.1:<port>,localhost:<port>` | `Host`-header allowlist (DNS-rebind protection) — **must include the public subdomain**, see below |

No CLI args. Run the bin, point a reverse proxy at it.

## TLS / reverse proxy — app-specific constraints

1. **TLS is mandatory.** Credentials (email + API token) travel in request headers on
   every call. Never expose the plain HTTP port off-box.
2. **Forward the original `Host` header.** The server has DNS-rebind protection on. It
   rejects any request whose `Host` is not in `FAVRO_MCP_ALLOWED_HOSTS`. A proxy that
   forwards the public host (`favro-mcp.company.com`) is the normal case — so set
   `FAVRO_MCP_ALLOWED_HOSTS=favro-mcp.company.com`. (If your proxy instead rewrites Host
   to `127.0.0.1:3000`, the default allowlist already covers it.)
3. **Don't buffer the response.** Responses can stream (SSE). Disable proxy response
   buffering and use a generous read timeout (nginx: `proxy_buffering off;`,
   `proxy_read_timeout 300s;`). Caddy's `reverse_proxy` is fine as-is.
4. Proxy only `POST /mcp` through; no other paths are used.

## Verify

```bash
# Unauthenticated → 401 (service is up, auth enforced)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://favro-mcp.company.com/mcp -d '{}'

# Full check with real Favro creds → valid initialize response
curl -s -X POST https://favro-mcp.company.com/mcp \
  -H "X-Favro-Email: you@company.com" \
  -H "X-Favro-Token: YOUR_API_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}},"id":1}'
```

Note the `Accept: application/json, text/event-stream` header — the Streamable-HTTP
transport requires it; omitting it returns 406.

## Authentication detail (for debugging client issues)

- Credentials: `X-Favro-Email` + `X-Favro-Token` headers (the same email + token a user
  enters in `favro auth login`), or equivalently `Authorization: Basic base64(email:apiToken)`.
  If both are present, the `X-Favro-*` headers win.
- `organizationId` is auto-resolved from those credentials and cached. If a user's
  account belongs to **multiple** orgs, the server returns `400` listing the org IDs and
  the client must add header `X-Favro-Organization-Id: <orgId>`.
- Failure modes: missing/malformed auth → `401`; bad credentials → `401`; multi-org with
  no header → `400`; Favro API unreachable → `502`. All as JSON-RPC error bodies.

## End-user client config

Distribute this; each user fills in their own email and API token — no encoding step:

```json
{
  "mcpServers": {
    "favro": {
      "type": "http",
      "url": "https://favro-mcp.company.com/mcp",
      "headers": {
        "X-Favro-Email": "<YOUR_EMAIL>",
        "X-Favro-Token": "<YOUR_API_TOKEN>"
      }
    }
  }
}
```

Users in multiple Favro organizations also add `"X-Favro-Organization-Id": "<orgId>"`.
(`Authorization: Basic base64(email:apiToken)` is accepted as an alternative.)

## Updating

The server tracks **git release tags** (`vMAJOR.MINOR.PATCH`), not `main`. Manual bump
to the latest release:

```bash
cd favro-cli
git fetch --tags
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -n1)"
npm ci
npm run build
```

Then restart the process. No migration, no state to preserve.

### Auto-update

`scripts/update.sh` does the above and restarts the service. It is a no-op when already
on the latest tag, so schedule it however you like (cron, systemd timer — your call on
cadence). Set `FAVRO_RESTART_CMD` to your restart command:

```bash
FAVRO_RESTART_CMD="sudo systemctl restart favro-mcp" /path/to/favro-cli/scripts/update.sh
```

It checks out the highest `v*` tag, runs `npm ci && npm run build`, then runs your
restart command. Without `FAVRO_RESTART_CMD` it builds but leaves the running process on
the old code (logs a warning).

### Cutting a release (maintainer)

A new release only reaches servers once it is **tagged**:

```bash
# bump "version" in package.json, commit, then:
git tag vX.Y.Z
git push origin main --tags
```

Servers pick it up on their next `update.sh` run.
