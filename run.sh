#!/usr/bin/env bash
# Build, deploy, and restart the 9router user service with the Claude classifier compat patch.
#
# Why this script exists:
#   The cli build script (cli/scripts/build-cli.js) writes the Next.js
#   standalone bundle AND its static assets into
#     ./.next-cli-build/standalone/9router/.next-cli-build/  (the nested
#     build) and into  ./cli/app/.next-cli-build/  (the cli package).
#
#   But the systemd service runs from
#     /home/ron/Documents/Projects/9router/.next-cli-build/standalone/9router
#   and reads its `distDir: ./.next-cli-build` from there, so the live
#   service bundle under that path needs to contain the static assets too.
#   Without them, /_next/static/* returns 404 and the dashboard renders
#   unstyled / missing assets.
#
# This script does:
#   1. cd cli && node scripts/build-cli.js   (Next.js build + bundle copy)
#   2. copy cli/app/.next-cli-build/static → <service>/.next-cli-build/static
#   3. systemctl --user restart 9router.service
#   4. wait for service to be reachable
#   5. GET /api/settings and print claudeClassifierCompat
#   6. curl -I /_next/static/chunks/main-app-*.js as a smoke test
#   7. print quick health
#
# Idempotent. Re-run safely.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ron/Documents/Projects/9router}"
SERVICE_ROOT="${SERVICE_ROOT:-$REPO_ROOT/.next-cli-build/standalone/9router}"
CLI_APP_DIR="${CLI_APP_DIR:-$REPO_ROOT/cli/app}"
SERVICE_STATIC_DIR="${SERVICE_STATIC_DIR:-$SERVICE_ROOT/.next-cli-build/static}"
CLI_STATIC_DIR="${CLI_STATIC_DIR:-$CLI_APP_DIR/.next-cli-build/static}"
PORT="${PORT:-20128}"
BASE_URL="${BASE_URL:-http://127.0.0.1:$PORT}"

log() { printf '\033[1;34m[run.sh]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run.sh]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[run.sh]\033[0m %s\n' "$*" >&2; }

# Sanity
[ -d "$REPO_ROOT" ] || { err "REPO_ROOT not found: $REPO_ROOT"; exit 1; }
[ -d "$SERVICE_ROOT" ] || { err "SERVICE_ROOT not found: $SERVICE_ROOT"; exit 1; }
[ -d "$CLI_APP_DIR" ] || { err "CLI_APP_DIR not found: $CLI_APP_DIR"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { err "systemctl not found"; exit 1; }
command -v node >/dev/null 2>&1 || { err "node not found"; exit 1; }

log "1/5 Building CLI bundle (Next.js + cli scripts)..."
(
  cd "$REPO_ROOT/cli"
  if [ ! -d node_modules ]; then
    log "  installing cli devDependencies (esbuild etc.)"
    npm install
  fi
  node scripts/build-cli.js
)

log "2/5 Syncing static assets into live service bundle..."
if [ -d "$CLI_STATIC_DIR" ]; then
  mkdir -p "$SERVICE_STATIC_DIR"
  # rsync would be ideal; cp -r is universally available
  cp -r "$CLI_STATIC_DIR"/. "$SERVICE_STATIC_DIR"/
  log "  copied: $CLI_STATIC_DIR → $SERVICE_STATIC_DIR"
else
  warn "  no static dir at $CLI_STATIC_DIR (build may have failed)"
  exit 1
fi

log "3/5 Restarting 9router user service..."
systemctl --user restart 9router.service

log "4/5 Waiting for service on $BASE_URL (max 30s)..."
ready=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE_URL/api/settings" 2>/dev/null; then
    ready=1
    log "  ready in ${i}s"
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || { err "service did not become reachable in 30s"; systemctl --user status 9router.service --no-pager | head -20; exit 1; }

log "5/5 Smoke tests..."
set +e
SET=$(curl -sf "$BASE_URL/api/settings")
echo "  GET /api/settings → claudeClassifierCompat=$(echo "$SET" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("claudeClassifierCompat","?"))')"

CHUNK=$(curl -sI "$BASE_URL/_next/static/chunks/" 2>/dev/null | head -1)
echo "  HEAD /_next/static/chunks/ → ${CHUNK:-<unreachable>}"

echo
log "  quick classifier replay (always):"
python3 - <<PY
import json, urllib.request
from pathlib import Path
body = json.loads(Path("/tmp/exact-classifier-body.json").read_text()) if Path("/tmp/exact-classifier-body.json").exists() else None
if not body:
    print("    (no /tmp/exact-classifier-body.json — skipping replay)")
else:
    try:
        req = urllib.request.Request("$BASE_URL/api/settings", data=json.dumps({"claudeClassifierCompat":"always"}).encode(), headers={"Content-Type":"application/json"}, method="PATCH")
        urllib.request.urlopen(req).read()
        req = urllib.request.Request("$BASE_URL/v1/messages", data=json.dumps(body).encode(), headers={"Content-Type":"application/json","anthropic-version":"2023-06-01","Accept":"application/json"}, method="POST")
        text = urllib.request.urlopen(req, timeout=120).read().decode("utf-8","ignore")
        obj = json.loads(text)
        types = [b.get("type") for b in obj.get("content", [])]
        print("    response.type =", obj.get("type"))
        print("    content types =", types)
        print("    thinking blocks =", sum(1 for t in types if t == "thinking"))
    except Exception as e:
        print("    replay error:", e)
PY
set -e

log "Done."
echo
log "Next steps:"
log "  - open $BASE_URL/dashboard/token-saver in a browser to see the new control"
log "  - cli menu: 9router → Settings → 'Claude Classifier Compat: cycle'"
