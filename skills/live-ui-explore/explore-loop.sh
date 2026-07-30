#!/usr/bin/env bash
# explore-loop.sh — run live-ui-explore continuously.
#
# Each cycle:
#   1. RESTORE a pristine database. Non-negotiable: the explorer is supposed to
#      delete things and change settings, so without a restore, cycle 2 explores
#      a wrecked app and by cycle 20 it has changed the admin password and locked
#      itself out. The predecessor never needed this because it never mutated
#      anything — which was precisely its defect.
#   2. Restart the backend against the fresh DB.
#   3. Verify the stack is serving THIS worktree's build before auditing (a
#      health check alone would happily pass against a stale or foreign server).
#   4. Explore, then append findings to the rolling ledger.
#
# State lives in $STATE so the loop survives restarts.
set -u

RIG=${RIG:-/data/pbya/ziee/tmp/live-rig-wt}
BASE=${EXPLORE_URL:-http://127.0.0.1:1520}
BACKEND_PORT=${BACKEND_PORT:-29500}
CONFIG=${RIG_CONFIG:-/data/pbya/ziee/tmp/live-rig-config.yaml}
STATE=${STATE:-/data/pbya/ziee/tmp/live-ui-explore}
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/explore.mjs"
STEPS=${STEPS:-45}
INTERVAL=${INTERVAL:-45}
PG=${PG_CONTAINER:-ziee-showcase-pg}
DB=${DB_NAME:-ziee_live_view}
PRISTINE=${PRISTINE_DB:-ziee_live_pristine}
USER_=${RIG_USER:-admin}
PASS=${RIG_PASS:-password123}

mkdir -p "$STATE"
CYCLES="$STATE/cycles.log"
LEDGER="$STATE/FINDINGS_LEDGER.md"
cycle=$(( $(grep -c '^' "$CYCLES" 2>/dev/null || echo 0) + 1 ))

note() { echo "$(date '+%F %T') $*" >> "$CYCLES"; }

restore_db() {
  # Kill connections, then clone the pristine template. ~22 MB, so seconds.
  docker exec "$PG" psql -U postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB','$PRISTINE') AND pid<>pg_backend_pid();" >/dev/null 2>&1
  docker exec "$PG" psql -U postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || return 1
  docker exec "$PG" psql -U postgres -c "CREATE DATABASE $DB WITH TEMPLATE $PRISTINE OWNER postgres;" >/dev/null 2>&1 || return 1
  return 0
}

start_backend() {
  # Kill ONLY the process holding our backend port. A pattern-based pkill on
  # "target/debug/ziee" would take down any other ziee binary on the box — and a
  # `-f` pattern can also match the killer's own command line (that self-match
  # bit this session four separate times).
  for pid in $(fuser -n tcp "$BACKEND_PORT" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$'); do
    kill -9 "$pid" 2>/dev/null
  done
  sleep 3
  ( cd "$RIG/src-app/server" && CONFIG_FILE="$CONFIG" setsid nohup ../target/debug/ziee \
      > /data/pbya/ziee/tmp/rig-server.log 2>&1 < /dev/null & )
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$BACKEND_PORT/api/health")" = "200" ] && return 0
    sleep 4
  done
  return 1
}

while true; do
  ts=$(date '+%F %T')

  # --- FRESHNESS: never audit a build that is not this worktree's HEAD. A
  # stale-build audit reports defects already fixed and misses new ones.
  want=$(git -C "$RIG" rev-parse --short HEAD 2>/dev/null)
  have=$(cat "$RIG/.rig-build-stamp" 2>/dev/null)
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    note "cycle=$cycle SKIP stale-build served=$have worktree=$want"
    sleep "$INTERVAL"; continue
  fi
  git -C "$RIG" fetch origin main -q 2>/dev/null
  behind=$(git -C "$RIG" rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ]; then
    note "cycle=$cycle STALE-BRANCH auditing=$want behind=$behind — findings describe an OLD build"
  fi

  if ! restore_db; then
    note "cycle=$cycle SKIP db-restore-failed"
    sleep "$INTERVAL"; continue
  fi
  if ! start_backend; then
    note "cycle=$cycle SKIP backend-did-not-start"
    sleep "$INTERVAL"; continue
  fi
  root=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/" 2>/dev/null)
  if [ "$root" != "200" ]; then
    note "cycle=$cycle SKIP rig-unhealthy root=$root"
    sleep "$INTERVAL"; continue
  fi

  out="$STATE/run-$(date +%Y%m%d-%H%M%S)"
  ( cd "$RIG/src-app/ui" && timeout 3600 node "$SKILL" \
      --url="$BASE" --user="$USER_" --password="$PASS" \
      --steps="$STEPS" --out="$out" ) > "$out.stdout" 2>&1
  rc=$?

  if [ -f "$out/result.json" ]; then
    read -r n hi md urls st <<<"$(python3 - "$out/result.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); f=d.get('findings',[])
print(len(f),
      sum(1 for x in f if x['severity']=='HIGH'),
      sum(1 for x in f if x['severity']=='MEDIUM'),
      len(d.get('urlsVisited',[])), d.get('stepsTaken',0))
PY
)"
    note "cycle=$cycle rc=$rc steps=$st urls=$urls findings=$n HIGH=$hi MED=$md out=$out"
    # Rolling ledger, DEDUPED across cycles by fingerprint. Without this an
    # unattended overnight run writes the same finding hundreds of times and the
    # ledger becomes unreadable — the volume looks like signal but is one bug.
    # Keeps MEDIUM too (cycle 1 had zero HIGHs but real MEDIUMs), and records a
    # seen-count so a recurring finding is visibly recurring rather than louder.
    python3 - "$out/result.json" "$LEDGER" "$cycle" "$STATE/seen.json" <<'PY'
import json,sys,os
res, ledger, c, seenpath = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.load(open(res))
seen = json.load(open(seenpath)) if os.path.exists(seenpath) else {}
new = []
for f in d.get('findings', []):
    if f.get('verifiedBy') != 'detector':      # model-vision-only stays out of the ledger
        continue
    if f['severity'] not in ('HIGH', 'MEDIUM'):
        continue
    fp = f.get('fingerprint') or f"{f['kind']}|{f['detail'][:120]}"
    if fp in seen:
        seen[fp]['count'] += 1
        seen[fp]['lastCycle'] = c
        continue
    seen[fp] = {'count': 1, 'firstCycle': c, 'lastCycle': c,
                'kind': f['kind'], 'severity': f['severity']}
    new.append(f)
json.dump(seen, open(seenpath, 'w'), indent=1)
if new:
    with open(ledger, 'a') as led:
        for f in new:
            led.write(f"\n## {f['severity']} · {f['kind']}  _(new in cycle {c})_\n"
                      f"- url: `{f.get('url')}`\n- action: `{json.dumps(f.get('action'))}`\n"
                      f"- shot: `{f.get('shot')}`\n\n{f['detail']}\n")
print(f"ledger: +{len(new)} new, {len(seen)} distinct total")
PY
  else
    note "cycle=$cycle rc=$rc NO-OUTPUT (see $out.stdout)"
  fi

  cycle=$((cycle+1))
  sleep "$INTERVAL"
done
