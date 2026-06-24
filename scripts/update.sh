#!/usr/bin/env bash
#
# Auto-update favro-cli to the latest git release tag, rebuild, and restart the
# MCP HTTP server. Safe to run on a schedule (cron / systemd timer) — it is a
# no-op when already on the latest tag, so frequent runs are cheap.
#
# Config via environment:
#   FAVRO_RESTART_CMD   Command to restart the service after a successful build,
#                       e.g. "sudo systemctl restart favro-mcp". Without it the
#                       new build is staged but the running process keeps the old
#                       code until you restart it manually.
#
# Exit codes: 0 = up to date or updated; non-zero = build/checkout failed.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

git fetch --tags --force --prune origin

# Highest semver release tag (vMAJOR.MINOR.PATCH).
latest="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
if [ -z "$latest" ]; then
  echo "No release tags found; nothing to do."
  exit 0
fi

current="$(git describe --tags --exact-match 2>/dev/null || echo '(none)')"
if [ "$current" = "$latest" ]; then
  echo "Already on $latest."
  exit 0
fi

echo "Updating $current -> $latest"
git checkout --quiet "$latest"
npm ci
npm run build

if [ -n "${FAVRO_RESTART_CMD:-}" ]; then
  echo "Restarting: $FAVRO_RESTART_CMD"
  eval "$FAVRO_RESTART_CMD"
else
  echo "WARNING: FAVRO_RESTART_CMD not set — built $latest but did NOT restart the service."
fi

echo "Now on $latest."
