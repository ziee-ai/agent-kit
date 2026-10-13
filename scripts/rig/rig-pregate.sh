#!/bin/bash
# rig-pregate.sh <sha> [<outdir>] — the CHEAP checks, run BEFORE the hours-long merge gate. Measured in a consumer app: every
# non-test failure (migration collision, clippy, size limits, stale generated files, conflict markers, a re-serialized shared JSON)
# surfaced only after 1-3 h of gate time, one per cycle; these checks find all of them in well under an hour, ALL AT ONCE
# (keep-going: every check runs to the end; exit = number of failed checks; $OUT/SUMMARY lists each with its rc).
#
#   P1 structural   $RIG_STRUCTURAL_CMD <branch> (default: the kit's merge-gate.mjs --skip-heavy: stale, migrations, merge, ...)
#   P2 hygiene      conflict markers, parentless commits, submodule pins == origin/main, shared JSON re-serialized
#   P3 regen        $RIG_REGEN_CMD must leave the tree CLEAN (stale generated files) — skipped, loudly, when unset
#   P4 static legs  $RIG_STATIC_CMD: every static check, keep-going (writes {out}/SUMMARY) — skipped, loudly, when unset
#   P5 fast unit    $RIG_UNIT_CMD: the app's in-process unit tests (no servers, no browser; e.g. `cargo test --lib`) — they
#                   include spec<->code drift pins and run in about a minute, where the full gate reaches them ~50 min in
#                   (measured: a permission-matrix drift). Skipped, loudly, when unset.
#
# Runs in the persistent rig worktree (rig-worktree.sh) detached at <sha>; nothing is pushed. Config: env, then $RIG_STATE/rig.env;
# see README.md. In RIG_REGEN_CMD / RIG_STATIC_CMD, {wt} = the rig worktree and {out} = this check's output dir.
RIG_BIN=${RIG_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
[ -n "${RIG_STATE:-}" ] || { echo "rig-pregate: RIG_STATE is required" >&2; exit 99; }
[ -f "$RIG_STATE/rig.env" ] && . "$RIG_STATE/rig.env"
[ -n "${RIG_REPO:-}" ] || { echo "rig-pregate: RIG_REPO is required" >&2; exit 99; }
RIG_KIT=${RIG_KIT:-$(cd "$RIG_BIN/../.." && pwd)}; WRAP=${RIG_RUN_WRAPPER:-bash -c}; MAIN=${RIG_MAIN_BRANCH:-main}
SHA=${1:?sha}; OUT=${2:-$RIG_STATE/pregate/$(date +%m%d-%H%M)}; mkdir -p "$OUT"; : > "$OUT/SUMMARY"
W=${RIG_WORKTREE:-$RIG_STATE/rig-wt}; BR=${RIG_BRANCH:-$(git -C "$RIG_REPO" rev-parse --abbrev-ref HEAD)}
STRUCT=${RIG_STRUCTURAL_CMD-node $RIG_KIT/lifecycle/merge-gate.mjs}
fail=0
res() { echo "$1 rc=$2${3:+ — $3}" | tee -a "$OUT/SUMMARY"; [ "$2" = 0 ] || fail=$((fail+1)); }
sub() { local c=${1//\{wt\}/$W}; echo "${c//\{out\}/$2}"; }
echo "pregate $SHA start $(date +%T)" > "$OUT/TIMES"

# --- the persistent rig worktree at <sha> (shared with rerun-failures.sh) ---
. "${RIG_WORKTREE_HELPER:-$RIG_BIN/rig-worktree.sh}"; rig_worktree_at "$SHA" "$OUT" || { res P0-worktree 1 "see $OUT"; exit 99; }

# --- P1 structural (the gate's own cheap stages, from the primary — it builds its own staging) ---
if [ -n "$STRUCT" ]; then
  (cd "$RIG_REPO" && $STRUCT "$BR" ${RIG_STRUCTURAL_ARGS---skip-heavy}) > "$OUT/P1-structural.log" 2>&1
  grep -q 'merge-gate: OK' "$OUT/P1-structural.log"; r=$?
  res P1-structural $r "$(grep -E '^\s+✗' "$OUT/P1-structural.log" | head -3 | tr -s ' ' | tr '\n' ';')"
else echo "P1-structural SKIPPED (RIG_STRUCTURAL_CMD empty)" | tee -a "$OUT/SUMMARY"; fi
echo "P1 done $(date +%T)" >> "$OUT/TIMES"

# --- P2 hygiene (generic git checks on origin/main...<sha>) ---
CH=$(git diff --name-only "origin/$MAIN...HEAD")
m=$(echo "$CH" | grep -v '^$' | xargs -r grep -lE '^(<<<<<<<|>>>>>>>) |^=======$' 2>/dev/null | grep -vE "${RIG_MARKER_EXEMPT_RX:-\.(md|txt)$}" | head -5)
res P2-conflict-markers $([ -z "$m" ] && echo 0 || echo 1) "$m"
p=$(git rev-list --parents "origin/$MAIN..HEAD" | awk 'NF<2{print $1}' | head -3)
res P2-parentless-commits $([ -z "$p" ] && echo 0 || echo 1) "$p"
# a submodule pin that moved needs the owner's go: echo <sha> > $RIG_STATE/PIN-OK
pins=""; for sm in $(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null | awk '{print $2}'); do
  a=$(git ls-tree HEAD "$sm" | awk '{print $3}'); b=$(git ls-tree "origin/$MAIN" "$sm" | awk '{print $3}'); [ "$a" = "$b" ] || pins="$pins $sm:${b:0:8}->${a:0:8}"; done
if [ -n "$pins" ] && [ "$(cat "$RIG_STATE/PIN-OK" 2>/dev/null)" != "$SHA" ]; then res P2-submodule-pins 1 "pin moved:$pins (approved? echo $SHA > $RIG_STATE/PIN-OK)"; else res P2-submodule-pins 0 "$pins"; fi
# a whole-file rewrite of a shared JSON (re-indent / re-sort / re-escape) shows as many changed lines that mostly vanish under -w;
# flag a file (matching RIG_RESERIALIZE_RX) where the plain diff is > RIG_RESERIALIZE_MIN lines and the -w diff is under half of it.
rs=""; for f in $(echo "$CH" | grep -E "${RIG_RESERIALIZE_RX:-\.json$}"); do
  [ -f "$f" ] || continue
  a=$(git diff --numstat "origin/$MAIN...HEAD" -- "$f" | awk '{print $1+$2}'); b=$(git diff -w --numstat "origin/$MAIN...HEAD" -- "$f" | awk '{print $1+$2}')
  [ "${a:-0}" -gt "${RIG_RESERIALIZE_MIN:-200}" ] && [ $(( ${b:-0} * 2 )) -lt "${a:-0}" ] && rs="$rs $f($a/-w:$b)"
done
res P2-json-reserialized $([ -z "$rs" ] && echo 0 || echo 1) "$rs"
echo "P2 done $(date +%T)" >> "$OUT/TIMES"

# --- P3 regen leaves the tree clean ---
if [ -n "${RIG_REGEN_CMD:-}" ]; then
  $WRAP "$(sub "$RIG_REGEN_CMD" "$OUT")" > "$OUT/P3-regen.log" 2>&1 || res P3-regen-cmd 1 "$OUT/P3-regen.log"
  # a file whose ONLY change is a generator timestamp is not stale content
  d=$(for f in $(git status --porcelain | grep -v '^??' | awk '{print $2}'); do
    git diff -U0 -- "$f" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | grep -qvE "${RIG_REGEN_IGNORE_RX:-\"?generated_at\"?|[Gg]enerated[ _]?(at|on)?:}" && echo "$f"; done | head -20)
  res P3-regen-clean $([ -z "$d" ] && echo 0 || echo 1) "$(echo "$d" | tr '\n' ' ')"
  git diff > "$OUT/P3-regen.diff"; git checkout -q -f "$SHA" && git clean -fdq
else echo "P3-regen SKIPPED — RIG_REGEN_CMD not configured; stale generated files are NOT checked" | tee -a "$OUT/SUMMARY"; fi
echo "P3 done $(date +%T)" >> "$OUT/TIMES"

# --- P4 every static leg, keep-going ---
if [ -n "${RIG_STATIC_CMD:-}" ]; then
  mkdir -p "$OUT/static"; $WRAP "$(sub "$RIG_STATIC_CMD" "$OUT/static")" > "$OUT/P4-static.log" 2>&1; r=$?
  res P4-static-legs $r "$(grep -E 'rc=[1-9]' "$OUT/static/SUMMARY" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
  git checkout -q -f "$SHA" && git clean -fdq
else echo "P4-static SKIPPED — RIG_STATIC_CMD not configured; no static legs ran" | tee -a "$OUT/SUMMARY"; fi
echo "P4 done $(date +%T)" >> "$OUT/TIMES"

# --- P5 fast in-process unit tests ---
if [ -n "${RIG_UNIT_CMD:-}" ]; then
  $WRAP "$(sub "$RIG_UNIT_CMD" "$OUT")" > "$OUT/P5-unit.log" 2>&1; r=$?
  res P5-unit $r "$(grep -E '^test [^ ]+ \.\.\. FAILED|^\s*(FAIL|✗|not ok)\b' "$OUT/P5-unit.log" | head -5 | tr -s ' ' | tr '\n' ';')"
  git checkout -q -f "$SHA" && git clean -fdq
else echo "P5-unit SKIPPED — RIG_UNIT_CMD not configured; no unit tests ran in the pregate" | tee -a "$OUT/SUMMARY"; fi
echo "P5 done $(date +%T)" >> "$OUT/TIMES"

echo "PREGATE-FAILED=$fail" | tee -a "$OUT/SUMMARY"; echo "end $(date +%T)" >> "$OUT/TIMES"
exit $fail
