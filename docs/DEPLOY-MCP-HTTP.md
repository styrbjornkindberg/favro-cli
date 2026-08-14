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

- Binds **HTTP only** to `FAVRO_MCP_HOST` (keep it `127.0.0.1` on a shared host; in a
  container `0.0.0.0` is correct — see [Cloud Run / containers](#cloud-run--containers)).
  TLS is terminated in front.
- Two endpoints: **`POST /mcp`** (everything) and **`GET /health`** (unauthenticated,
  returns `{"status":"ok","version":"<running version>"}`). Everything else returns 404/405.
- Stateless apart from a short in-memory cache of resolved org IDs → restart any time, safe.

Environment variables (all optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `FAVRO_MCP_PORT` | `3000` | Listen port |
| `FAVRO_MCP_HOST` | `127.0.0.1` | Bind host — leave on localhost on a shared host; the rule is about co-tenants, not containers, where `0.0.0.0` is correct (the shipped image already sets it) |
| `FAVRO_MCP_ALLOWED_HOSTS` | `127.0.0.1:<port>,localhost:<port>` | `Host`-header allowlist (DNS-rebind protection) — **must include the public subdomain**, see below |
| `FAVRO_MCP_STATE_DIR` | OS temp dir (`$TMPDIR/favro-mcp`) | Where per-user CLI config is stored (see Per-user isolation). Point at a persistent path to keep scope locks across reboots — on a container tmpfs there is no such path, see [Cloud Run / containers](#cloud-run--containers). |

No CLI args. Run the bin, point a reverse proxy at it.

## Per-user isolation

The MCP server spawns the CLI once per request with the caller's credentials. Each user
also gets an **isolated CLI config directory** (`FAVRO_MCP_STATE_DIR/<hash-of-credentials>`),
so per-user state never crosses between users:

- **Scope lock** (`favro scope set`) — each user's collection lock is private to them.
- **Cached `userId`** — `my-cards`, `my-standup`, etc. resolve to the requesting user, not
  whoever connected first.
- **Defaults** (`defaultBoard`, `defaultCollection`).

The server's own `~/.favro/config.json` (if any) is never read or written by MCP requests.
The default base is the OS temp dir, so scope locks reset on reboot — set
`FAVRO_MCP_STATE_DIR` to a persistent path if you want them to survive restarts. The
directory only holds non-secret preferences (no API tokens), named by a salt-free hash of
the credentials.

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
4. Proxy `POST /mcp` through, plus `GET /health` if something upstream probes it; no
   other paths are used.

## Cloud Run / containers

The repo's `Dockerfile` builds this server as a Cloud Run image. Five things differ from
the systemd-behind-your-own-proxy target above, and the second one fails closed.

**`FAVRO_MCP_HOST=0.0.0.0` is correct here, and the image already sets it** — see the
`ENV FAVRO_MCP_HOST` line in `Dockerfile` and the comment above it. The localhost rule in
[Run target](#run-target) guards a plain-HTTP port against everything else on a shared
host. A container's port is reachable only through the platform's front layer, which
terminates TLS, so binding all interfaces satisfies the same requirement. Don't override
it.

**`FAVRO_MCP_ALLOWED_HOSTS` must be set to the platform hostname, and the image does not
set it.** DNS-rebind protection is on unconditionally; with no explicit allowlist
`allowedHosts()` in `src/mcp-http-server.ts` falls back to
`127.0.0.1:<port>,localhost:<port>`, and Cloud Run passes its own `*.run.app` (or mapped
custom domain) `Host` straight through — there is no proxy of yours in the path to
rewrite it. The comparison is exact string equality against the full `Host` header, so
every authenticated request comes back **`403`** with `Invalid Host header: <your-host>`
in the JSON-RPC error body, and nothing succeeds until the variable is set. It is service
config, not image config:

```bash
gcloud run services update favro-mcp \
  --update-env-vars FAVRO_MCP_ALLOWED_HOSTS=favro-mcp-xxxxxxxxxx.a.run.app
```

Use `--update-env-vars`, never `--set-env-vars` — the latter replaces the revision's whole
env-var set instead of merging into it, so it will drop anything else already there.

**Don't set `FAVRO_MCP_PORT` yourself.** Cloud Run injects `$PORT`; the image's `CMD`
already bridges it (`FAVRO_MCP_PORT=${PORT:-8080}`). Setting it yourself makes the server
listen on a port the platform is not routing to. Note that the fallback allowlist above is
built from the bridged value, so with Cloud Run's default `$PORT` it reads
`127.0.0.1:8080,localhost:8080` — neither of which a real request will ever carry.

**`FAVRO_MCP_STATE_DIR` has no equivalent mitigation here.** The container filesystem is
in-memory, so the per-user config dirs are charged against the instance's memory limit,
and "point at a persistent path" has nowhere to point: scope locks are lost on every
instance recycle, not merely on reboot, and with more than one instance they are also
per-instance — the same user can see different scope state depending on which instance
answers. Leave the default and treat `favro scope set` as per-instance rather than
durable.

**Liveness probe.** Point it at `GET /health`, not at the unauthenticated `POST /mcp`
check under [Verify](#verify): that one answers `401` when healthy, so a probe would have
to score `401` as up — and then it cannot tell "enforcing auth" from "auth rejecting
everyone".

```bash
curl -s https://favro-mcp-xxxxxxxxxx.a.run.app/health
# {"status":"ok","version":"<the running version>"}
```

`/health` is answered before the `Host` allowlist runs, so a `200` proves the process is
up and says which version is live — it does **not** prove `FAVRO_MCP_ALLOWED_HOSTS` is
right. Only the authenticated `initialize` call under [Verify](#verify), sent to the real
public hostname, does that.

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
