#!/usr/bin/env bash
# explore-loop.sh — run live-ui-explore continuously.
#
# Each cycle:
#   1. Verify the stack is serving THIS worktree's build (a health check alone
#      would happily pass against a stale or foreign server).
#   2. Explore, then append findings to the rolling ledger.
#
# STATE IS DELIBERATELY NOT RESET (RESET_DB=1 restores the old behaviour).
# A real deployment runs for years without a wipe, and the bugs that only appear
# after long accumulation — unbounded growth, orphaned rows, stale references,
# lists that stop paginating, quotas — are invisible to a rig that starts clean
# every cycle. So the database accumulates across cycles, on purpose.
#
# The one thing that cannot be allowed to accumulate is a LOCKOUT: the explorer
# will eventually change the admin password, and a rig that cannot log in stops
# being a rig. Two layers handle that without wiping app data:
#   - explore.mjs remembers every password it types and retries them, which is
#     what a real user who changed their own password would do;
#   - `recover_credentials` below resets ONLY the admin password hash, touching
#     no other row, and logs loudly when it fires. Accumulated projects, chats,
#     settings and knowledge bases survive.
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
# Read the database name FROM THE CONFIG the backend is actually started with.
# Hardcoding a guess here meant every "restore" for 150+ cycles dropped and
# recreated a database the app never opened — a no-op that read as a safety net.
DB=${DB_NAME:-$(python3 -c "
import re,sys
try: s=open('$CONFIG').read()
except Exception: print('postgres'); sys.exit()
m=re.search(r'  external:\n((?:    .*\n)+)', s)
b=m.group(1) if m else ''
d=re.search(r'database:\s*\"([^\"]+)\"', b)
print(d.group(1) if d else 'postgres')
" 2>/dev/null || echo postgres)}
PRISTINE=${PRISTINE_DB:-ziee_live_pristine}
USER_=${RIG_USER:-admin}
PASS=${RIG_PASS:-password123}

mkdir -p "$STATE"
CYCLES="$STATE/cycles.log"
LEDGER="$STATE/FINDINGS_LEDGER.md"
cycle=$(( $(grep -c '^' "$CYCLES" 2>/dev/null || echo 0) + 1 ))

note() { echo "$(date '+%F %T') $*" >> "$CYCLES"; }

restore_db() {
  # Only when explicitly asked (RESET_DB=1). Default is to accumulate.
  # Refuse if the template is not a clone of the database the app actually uses.
  # The previous version dropped and recreated a DIFFERENT database for 150+
  # cycles and reported success every time — a no-op that read as a safety net.
  if ! docker exec "$PG" psql -U postgres -tAc \
       "select 1 from pg_database where datname='$PRISTINE'" 2>/dev/null | grep -q 1; then
    echo "restore_db: no template '$PRISTINE' — refusing (a silent no-op is worse than an error)" >&2
    return 1
  fi
  docker exec "$PG" psql -U postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB','$PRISTINE') AND pid<>pg_backend_pid();" >/dev/null 2>&1
  docker exec "$PG" psql -U postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || return 1
  docker exec "$PG" psql -U postgres -c "CREATE DATABASE $DB WITH TEMPLATE $PRISTINE OWNER postgres;" >/dev/null 2>&1 || return 1
  return 0
}

# Restore ACCESS without restoring STATE — the minimum intervention that keeps a
# no-reset rig usable over long runs.
#
# It restores the USERNAME as well as the password hash, and finds the row by
# PRIMARY KEY. Both details are load-bearing, learned the hard way: the real
# lockout was not a password change at all — the explorer renamed the admin
# account, through the normal profile UI, to
#     admin' OR '1'='1; DROP TABLE users;--
# (the injection did not execute; tables were intact — it is a missing username
# validation, now filed as a defect). A recovery keyed on `username='admin'`
# matches nothing once the username is what changed, so it must key on the id.
#
# The identity comes from a snapshot captured while login was VERIFIED working,
# not from a pristine database — the pristine here is a clone of a database this
# deployment never opened (see the DB= note above).
IDENTITY=${IDENTITY_FILE:-/data/pbya/ziee/tmp/live-ui-explore/admin-identity.txt}
recover_credentials() {
  [ -f "$IDENTITY" ] || return 1
  local uid uname hash
  IFS='|' read -r uid uname hash < "$IDENTITY"
  [ -z "$uid" ] || [ -z "$uname" ] || [ -z "$hash" ] && return 1
  docker exec "$PG" psql -U postgres -d "$DB" -c \
    "UPDATE users SET username='$uname', password_hash='$hash', is_active=true WHERE id='$uid';" \
    >/dev/null 2>&1 || return 1
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

  if [ "${RESET_DB:-0}" = "1" ]; then
    restore_db || { note "cycle=$cycle SKIP db-restore-failed"; sleep "$INTERVAL"; continue; }
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

  # Locked out by its own password change? Restore ACCESS only — never state.
  if grep -q "authentication failed" "$out.stdout" 2>/dev/null || \
     grep -q "locked-out" "$out/result.json" 2>/dev/null; then
    if recover_credentials; then
      note "cycle=$cycle CREDENTIAL-RECOVERY admin password reset (app data untouched)"
    else
      note "cycle=$cycle CREDENTIAL-RECOVERY FAILED — rig is locked out"
    fi
  fi

  cycle=$((cycle+1))
  sleep "$INTERVAL"
done
