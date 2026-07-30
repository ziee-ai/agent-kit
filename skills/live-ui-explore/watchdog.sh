#!/usr/bin/env bash
# watchdog.sh — check on a running explore-loop every N minutes.
#
# Written against the failure modes this rig ACTUALLY hit, not imagined ones:
#
#  1. Loop dead / stack down — the predecessor spent 6 cycles SKIPping because
#     its worktree had been deleted out from under it.
#  2. Progress stalled — cycles logged but steps~0, or no new cycle in a long
#     time (a wedged browser, a hung model call).
#  3. Coverage collapse — every cycle re-treading the same 2-3 routes. Measured
#     over 304 runs: /knowledge 158 visits vs /settings/assistants 14.
#  4. A finding class dominating — this is the important one. Overnight, 458 of
#     ~600 findings were ONE class (`interaction-failed`) and every one was a
#     harness bug on buttons that click in 29-67 ms by hand. Volume looked like
#     signal. So: if any single kind exceeds a share of the total, say so
#     loudly, because the prior probability that it is the harness is high.
#  5. Stale build — auditing a commit older than origin/main.
#
# It reports; it does not restart anything. An automatic restart would have
# masked (1) rather than surfacing it.
#
#   bash watchdog.sh              # one check, prints a report
#   bash watchdog.sh --loop 20    # re-check every 20 minutes
set -u

STATE=${STATE:-/data/pbya/ziee/tmp/live-ui-explore}
RIG=${RIG:-/data/pbya/ziee/tmp/live-rig-wt}
BASE=${EXPLORE_URL:-http://127.0.0.1:1520}
REPORT="$STATE/WATCHDOG.md"
EVERY=0
[ "${1:-}" = "--loop" ] && EVERY=${2:-20}

check() {
  local ts; ts=$(date '+%F %T')
  local alerts=0
  {
    echo "## $ts"
    echo

    # 1. is anything alive
    local nloop nexp
    nloop=$(ps -eo args | grep -c '[b]ash explore-loop.sh')
    nexp=$(ps -eo args | grep -c '[e]xplore.mjs')
    if [ "$nloop" -eq 0 ]; then
      echo "- 🔴 **LOOP NOT RUNNING** (no explore-loop.sh process)"; alerts=$((alerts+1))
    else
      echo "- loop: $nloop process(es), explorer $( [ "$nexp" -gt 0 ] && echo 'mid-cycle' || echo 'between cycles')"
    fi

    # 2. stack reachable
    local root api
    root=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/" 2>/dev/null)
    api=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/api/health" 2>/dev/null)
    if [ "$root" != "200" ] || [ "$api" != "200" ]; then
      echo "- 🔴 **STACK UNHEALTHY** root=$root api=$api"; alerts=$((alerts+1))
    fi

    # 3. progress
    local last_line last_epoch now_epoch age cycles
    cycles=$(grep -c '^' "$STATE/cycles.log" 2>/dev/null || echo 0)
    last_line=$(tail -1 "$STATE/cycles.log" 2>/dev/null)
    if [ -n "$last_line" ]; then
      last_epoch=$(date -d "$(echo "$last_line" | cut -d' ' -f1-2)" +%s 2>/dev/null || echo 0)
      now_epoch=$(date +%s); age=$(( (now_epoch - last_epoch) / 60 ))
      echo "- cycles: $cycles, last $age min ago"
      [ "$age" -gt 25 ] && { echo "- 🔴 **NO NEW CYCLE for ${age} min** — likely wedged"; alerts=$((alerts+1)); }
      echo "$last_line" | grep -qE 'steps=[0-5] ' && { echo "- 🟠 last cycle did almost no steps: \`$last_line\`"; alerts=$((alerts+1)); }
    else
      echo "- 🟠 no cycles logged yet"
    fi

    # 4. stale build
    local want have behind
    want=$(git -C "$RIG" rev-parse --short HEAD 2>/dev/null)
    have=$(cat "$RIG/.rig-build-stamp" 2>/dev/null)
    [ "$want" != "$have" ] && { echo "- 🟠 build stamp $have != worktree $want"; alerts=$((alerts+1)); }
    git -C "$RIG" fetch origin main -q 2>/dev/null
    behind=$(git -C "$RIG" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    [ "${behind:-0}" -gt 0 ] && echo "- 🟠 auditing a build ${behind} commit(s) behind origin/main"

    # 5 + 6. finding mix and coverage
    python3 - "$STATE" <<'PY'
import json, os, sys, collections, glob
st = sys.argv[1]
seen = {}
try: seen = json.load(open(os.path.join(st, 'seen.json')))
except Exception: pass
total = sum(v['count'] for v in seen.values()) or 0
if total:
    by = collections.Counter()
    for v in seen.values(): by[v['kind']] += v['count']
    top, n = by.most_common(1)[0]
    share = n / total
    print(f"- findings: {total} occurrences across {len(seen)} distinct")
    for k, c in by.most_common(5):
        print(f"    - {c:5d}  {k}")
    if share > 0.5 and total >= 20:
        print(f"- 🔴 **ONE CLASS IS {share:.0%} OF ALL FINDINGS: `{top}`** — that ratio was a HARNESS BUG")
        print("      both times it happened. Hand-probe the reported control before believing it.")
else:
    print("- findings: none yet")

# coverage spread this session
runs = sorted(glob.glob(os.path.join(st, 'run-*', 'result.json')))[-12:]
urls = [len(json.load(open(r)).get('urlsVisited', [])) for r in runs if os.path.exists(r)]
if urls:
    avg = sum(urls) / len(urls)
    print(f"- coverage: {avg:.1f} distinct URLs/cycle over last {len(urls)} cycles (min {min(urls)}, max {max(urls)})")
    if avg < 4:
        print("- 🟠 coverage is narrow — it is circling a small area rather than sweeping")
try:
    cov = json.load(open(os.path.join(st, 'coverage.json')))
    never = [k for k, v in cov.items() if v == 0]
    if never: print(f"- {len(never)} discovered route(s) never yet visited: {', '.join(sorted(never)[:6])}")
except Exception: pass
PY
    # 7. ENDPOINT coverage — the honest measure. Route coverage is a weak proxy:
    # a page renders without any write firing, which is exactly how the
    # predecessor rig looked like it covered the app while touching almost none
    # of it. Writes are where the bugs are, so report methods separately.
    node "$(dirname "${BASH_SOURCE[0]}")/api-coverage.mjs" 2>/dev/null \
      | sed -n '3,12p' | sed 's/^/  /' || echo "  (api coverage unavailable)"

    echo
    [ "$alerts" -gt 0 ] && echo "**$alerts alert(s)**" || echo "_healthy_"
    echo
  } >> "$REPORT"
  tail -30 "$REPORT"
}

if [ "$EVERY" -gt 0 ]; then
  while true; do check; sleep $((EVERY * 60)); done
else
  check
fi
