#!/usr/bin/env bash
# setup-rig.sh — stand up the target the explorer explores, from scratch.
#
# This closes a reproducibility gap: `explore.mjs` was committed while the thing
# it points at was three loose scripts in a scratch directory with absolute
# paths baked in. A fresh clone got the auditor and nothing to audit.
#
# What it builds:
#   1. a DETACHED worktree pinned to one commit — so a cycle audits exactly one
#      build and cannot drift under itself;
#   2. a config derived from the repo's own dev.example.yaml, pointed at a
#      dedicated database and a non-default port;
#   3. the frontend bundle + the server binary;
#   4. a static+proxy server (serve-rig.mjs) in front of them.
#
#   bash setup-rig.sh [--rev origin/main] [--dir /path/to/rig] [--port 1520]
#                     [--backend-port 29500] [--db-port 54396] [--db ziee_rig]
#
# Re-running is safe: it refreshes the worktree to --rev and rebuilds.
set -euo pipefail

REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || pwd)
# agent-kit is a submodule; the app repo is its parent.
APP_REPO=$(cd "$REPO/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$REPO")

REV=origin/main; DIR=""; PORT=1520; BE_PORT=29500; DB_PORT=54396; DB=ziee_rig
PG_CONTAINER=${PG_CONTAINER:-ziee-showcase-pg}
while [ $# -gt 0 ]; do
  case "$1" in
    --rev) REV=$2; shift 2;;
    --dir) DIR=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --backend-port) BE_PORT=$2; shift 2;;
    --db-port) DB_PORT=$2; shift 2;;
    --db) DB=$2; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
DIR=${DIR:-$(dirname "$APP_REPO")/tmp/live-rig-wt}
CONFIG="$DIR.config.yaml"

say() { printf '\n== %s\n' "$*"; }

say "1/5 worktree at $REV -> $DIR"
git -C "$APP_REPO" fetch -q origin
if [ -d "$DIR" ]; then
  git -C "$DIR" fetch -q origin && git -C "$DIR" checkout -q --detach "$REV"
else
  git -C "$APP_REPO" worktree add -q --detach "$DIR" "$REV"
fi
git -C "$DIR" submodule update --init --recursive --force -q
COMMIT=$(git -C "$DIR" rev-parse --short HEAD)
echo "   at $COMMIT"

say "2/5 database $DB on :$DB_PORT"
if ! docker exec "$PG_CONTAINER" psql -U postgres -tAc "select 1" >/dev/null 2>&1; then
  echo "   !! container '$PG_CONTAINER' is not reachable."
  echo "      Bring a Postgres up on :$DB_PORT first (see CLAUDE.md > Docker Compose),"
  echo "      or set PG_CONTAINER=<name>."
  exit 1
fi
docker exec "$PG_CONTAINER" psql -U postgres -tAc \
  "select 1 from pg_database where datname='$DB'" | grep -q 1 \
  || docker exec "$PG_CONTAINER" psql -U postgres -c "CREATE DATABASE $DB OWNER postgres;" >/dev/null
echo "   ready"

say "3/5 config -> $CONFIG"
# Derived from the repo's own example so it cannot drift from the real schema.
python3 - "$DIR/src-app/server/config/dev.example.yaml" "$CONFIG" "$DB_PORT" "$DB" "$BE_PORT" <<'PY'
import re, secrets, sys
src, out, db_port, db_name, be_port = sys.argv[1:6]
s = open(src).read()
s = re.sub(r'use_embedded:\s*true', 'use_embedded: false', s, count=1)
def ext(m):
    b = m.group(0)
    b = re.sub(r'(host:\s*)"[^"]*"', r'\1"127.0.0.1"', b)
    b = re.sub(r'(port:\s*)\d+', rf'\g<1>{db_port}', b)
    b = re.sub(r'(database:\s*)"[^"]*"', rf'\1"{db_name}"', b)
    return b
s = re.sub(r'  external:\n(?:    .*\n)+', ext, s, count=1)
s = re.sub(r'(server:\n(?:.*\n)*?\s+port:\s*)\d+', rf'\g<1>{be_port}', s, count=1)
# The example ships a placeholder secret the server refuses to boot on.
s = re.sub(r'(secret:\s*)".*"', lambda m: m.group(1) + '"' + secrets.token_urlsafe(36) + '"', s, count=1)
# An audit loop hammers loopback endpoints from one IP; the limiter would 429
# the rig against itself and every finding would be a false 'server error'.
if re.search(r'^rate_limit:', s, re.M):
    s = re.sub(r'(^rate_limit:\n(?:\s+.*\n)*?\s+enabled:\s*)\w+', r'\g<1>false', s, flags=re.M)
else:
    s += "\nrate_limit:\n  enabled: false\n"
open(out, 'w').write(s)
print("   written")
PY

say "4/5 build (frontend, then server — several minutes cold)"
( cd "$DIR" && npm install --silent )
( cd "$DIR/src-app/ui" && VITE_STORE_PREFETCH=off VITE_CLOSURE_PREFETCH=off npx vite build --mode production >/dev/null )
echo "   frontend ok"
( cd "$DIR/src-app/server" && cargo build -p ziee 2>&1 | grep -E '^error|Finished' | tail -1 )
echo "$COMMIT" > "$DIR/.rig-build-stamp"    # explore-loop refuses to audit a stale build
echo "   stamped $COMMIT"

say "5/5 start"
for pid in $(fuser -n tcp "$BE_PORT" "$PORT" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true); do kill -9 "$pid" 2>/dev/null || true; done
( cd "$DIR/src-app/server" && CONFIG_FILE="$CONFIG" setsid nohup ../target/debug/ziee > "$DIR.server.log" 2>&1 < /dev/null & )
setsid nohup node "$(dirname "${BASH_SOURCE[0]}")/serve-rig.mjs" \
  --dist "$DIR/src-app/dist/ui" --backend-port "$BE_PORT" --port "$PORT" > "$DIR.serve.log" 2>&1 < /dev/null &
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)" = "200" ] && break
  sleep 5
done

cat <<EOF

rig up at http://127.0.0.1:$PORT   (commit $COMMIT, db $DB)
  root=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/")  api=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/api/health")

First run needs a user to log in as — create one through the UI, or point the
explorer at existing credentials:

  RIG=$DIR RIG_CONFIG=$CONFIG EXPLORE_URL=http://127.0.0.1:$PORT \\
    bash $(dirname "${BASH_SOURCE[0]}")/explore-loop.sh

  bash $(dirname "${BASH_SOURCE[0]}")/watchdog.sh --loop 20
EOF
