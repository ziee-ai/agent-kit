#!/usr/bin/env bash
# explore-fleet.sh — run N explorers concurrently against ONE stack.
#
# Why: coverage is rate-limited, not ceiling-limited. Measured on ziee, 231 of
# the 267 untouched endpoints were plausibly UI-reachable, at ~0.25 new endpoints
# per ~168s cycle — about 43 hours of single-explorer runtime, and the rate
# decays. A single explorer is one browser taking one action at a time; nothing
# about the problem is serial.
#
# One STACK, N EXPLORERS — deliberately, over N private stacks:
#   - no extra backends, databases or ports to provision;
#   - the shared ledgers make the fleet cooperate. An endpoint one explorer has
#     already reached stops being novel for all of them, so they spread out
#     instead of racing down the same path;
#   - concurrent users on one deployment is a realistic shape, and the
#     interference it produces (one deleting what another is mid-way through) is
#     a bug class a single explorer can never find.
#
# The cost is that they share credentials, so one renaming the admin locks out
# the whole fleet. explore.mjs now detects that and exits 3, and the caller's
# recovery restores access — which is why this refuses to start without an
# identity snapshot to recover from.
#
#   bash explore-fleet.sh [--n 4] [--steps 45]
set -u

N=4; STEPS=45
while [ $# -gt 0 ]; do
  case "$1" in
    --n) N=$2; shift 2;;
    --steps) STEPS=$2; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done

STATE=${STATE:-/data/pbya/ziee/tmp/live-ui-explore}
RIG=${RIG:-/data/pbya/ziee/tmp/live-rig-wt}
BASE=${EXPLORE_URL:-http://127.0.0.1:1520}
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDENTITY=${IDENTITY_FILE:-$STATE/admin-identity.txt}
PG=${PG_CONTAINER:-ziee-showcase-pg}
DB=${DB_NAME:-ziee_rig}
USER_=${RIG_USER:-admin}
PASS=${RIG_PASS:-password123}

[ -f "$IDENTITY" ] || { echo "fleet: no identity snapshot at $IDENTITY — refusing to start."; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/api/health")" = "200" ] || {
  echo "fleet: stack not healthy at $BASE"; exit 1; }

mkdir -p "$STATE"
echo "fleet: $N explorers, $STEPS steps each, against $BASE"

# Restore ACCESS to the id-keyed account, under a name that is actually FREE.
#
# The original version renamed it back to the snapshot's username unconditionally.
# That worked 17 times and then wedged the fleet for seven hours: the explorer had
# renamed its own account AND registered a new user called 'admin', so the restore
# collided with the UNIQUE INDEX on users.username and failed on every attempt.
# It failed SILENTLY, because the caller only logged on success — every liveness
# check passed while nothing was explored.
#
# So: walk candidate names until one is free, keyed on the account id (never on a
# username, which is the mutable thing), and publish the winner so the next cycle
# logs in with it. Deleting the impostor would be the other option; it is not
# taken, because destroying app state is exactly what this rig exists not to do.
recover() {
  local uid uname hash cand out
  IFS='|' read -r uid uname hash < "$IDENTITY"
  if [ -z "${uid:-}" ] || [ -z "${hash:-}" ]; then
    echo "$(date '+%F %T') RECOVERY-FAILED: identity file $IDENTITY is unusable" >> "$STATE/fleet.log"
    return 1
  fi
  for cand in "$uname" "${uname}_rig1" "${uname}_rig2" "${uname}_rig3" "${uname}_rig$$"; do
    # Free if nobody else holds it (the account itself may already hold it).
    local taken
    taken=$(docker exec "$PG" psql -U postgres -d "$DB" -tAc \
      "SELECT count(*) FROM users WHERE username='$cand' AND id<>'$uid';" 2>/dev/null)
    [ "${taken:-1}" = "0" ] || continue
    out=$(docker exec "$PG" psql -U postgres -d "$DB" -c \
      "UPDATE users SET username='$cand', password_hash='$hash', is_active=true WHERE id='$uid';" 2>&1)
    if printf '%s' "$out" | grep -q 'UPDATE 1'; then
      printf '%s' "$cand" > "$STATE/rig-user.txt"      # next cycle logs in as this
      echo "$(date '+%F %T') CREDENTIAL-RECOVERY as '$cand'" >> "$STATE/fleet.log"
      return 0
    fi
    echo "$(date '+%F %T') RECOVERY-ATTEMPT '$cand' failed: $(printf '%s' "$out" | head -1)" >> "$STATE/fleet.log"
  done
  echo "$(date '+%F %T') RECOVERY-FAILED: no free username for account $uid — fleet is locked out" >> "$STATE/fleet.log"
  return 1
}

# One worker: explore, then loop. Each has its own OUT dir but SHARES the
# ledgers, which is what makes the fleet divide the work rather than duplicate it.
worker() {
  local id=$1
  while true; do
    local out="$STATE/fleet$id-$(date +%Y%m%d-%H%M%S)"
    # Read the username fresh each cycle: recovery may have had to move the
    # account to a different name, and a value captured at fleet start would send
    # every worker back to a login that can no longer succeed.
    local user_="$USER_"
    [ -s "$STATE/rig-user.txt" ] && user_=$(cat "$STATE/rig-user.txt")
    # Concrete routes the app declares, so the explorer can be told which whole
    # SCREENS it has never opened — the constraint that actually gated coverage.
    local routes=""
    [ -s /data/pbya/ziee/tmp/declared-routes.txt ] && routes=$(cat /data/pbya/ziee/tmp/declared-routes.txt)
    ( cd "$RIG/src-app/ui" && timeout 3600 node "$SKILL/explore.mjs" \
        --url="$BASE" --user="$user_" --password="$PASS" \
        --unvisited-routes="$routes" \
        --steps="$STEPS" --out="$out" ) > "$out.stdout" 2>&1
    local rc=$?
    echo "$(date '+%F %T') worker=$id rc=$rc out=$out" >> "$STATE/fleet.log"
    # Fold this run's findings into the deduped ledger. Omitting this is how the
    # fleet threw away 12,956 findings over four days - including 1,965 server-5xx
    # and 26 uncaught-exception - while every status check reported "no new HIGH
    # findings", because the ledger could not change. Shared script, so the two
    # runners cannot drift apart again.
    node "$SKILL/merge-findings.mjs" "$out" --state "$STATE" >> "$STATE/fleet.log" 2>&1
    # exit 3 is explore.mjs's locked-out signal. Recover ONCE, serialised by a
    # crude lock so four workers do not all rewrite the same row at once.
    if [ "$rc" = "3" ]; then
      # Break a STALE lock. A worker killed between mkdir and rmdir would
      # otherwise wedge every future recovery forever — the same silent-permanent
      # -wedge shape as the collision bug above, and not worth leaving latent.
      # Recovery takes ~1s, so anything older than 120s is abandoned.
      if [ -d "$STATE/.recover.lock" ] && \
         [ $(( $(date +%s) - $(stat -c %Y "$STATE/.recover.lock" 2>/dev/null || date +%s) )) -gt 120 ]; then
        echo "$(date '+%F %T') breaking stale recover lock" >> "$STATE/fleet.log"
        rmdir "$STATE/.recover.lock" 2>/dev/null
      fi
      if mkdir "$STATE/.recover.lock" 2>/dev/null; then
        recover || true          # recover() logs its own outcome, success or failure
        sleep 5; rmdir "$STATE/.recover.lock" 2>/dev/null
      else
        sleep 20   # another worker is recovering; wait it out
      fi
    fi
    sleep 5
  done
}

# Stop cleanly on TERM/INT: let the current cycles finish rather than killing
# browsers out from under them. A SIGKILLed worker throws mid-Playwright-call and
# loses the whole cycle's ledger merge, which is why restarts used to cost three
# partial cycles each. Give them a grace period, then insist.
STOPPING=0
shutdown() {
  STOPPING=1
  echo "fleet: stopping — letting in-flight cycles finish (up to 90s)" >&2
  for p in $(jobs -p); do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 90); do
    pgrep -P $$ >/dev/null 2>&1 || break
    sleep 1
  done
  for p in $(jobs -p); do kill -KILL "$p" 2>/dev/null; done
  exit 0
}
trap shutdown TERM INT

for i in $(seq 1 "$N"); do
  worker "$i" &
  echo "  worker $i started (pid $!)"
  sleep 3    # stagger, so N browsers do not cold-start into the same instant
done
wait
