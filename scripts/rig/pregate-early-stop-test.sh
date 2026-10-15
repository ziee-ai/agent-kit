#!/bin/bash
# pregate-early-stop-test.sh — rig-pregate.sh writes $OUT/static/STOP when the repo's HEAD moves past the gated sha (a superseded
# pregate fails fast), and never writes it while HEAD stays on the sha. Stubs for every phase; a fake static command waits for STOP.
set -u
H=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git -C "$T" init -q -b main repo && cd "$T/repo" && git commit -q --allow-empty -m a && A=$(git rev-parse HEAD)
git commit -q --allow-empty -m b && B=$(git rev-parse HEAD); git reset -q --hard "$A"
cat > "$T/static.sh" <<'S'
# fake static leg: up to 6 s; if STOP appears, record a superseded skip (a failure) and stop
for i in $(seq 1 12); do [ -e "$1/STOP" ] && { echo "leg SKIPPED-SUPERSEDED" >> "$1/SUMMARY"; exit 1; }; sleep 0.5; done
echo "leg rc=0" >> "$1/SUMMARY"
S
cat > "$T/wt.sh" <<'S'
rig_worktree_at() { cd "$RIG_REPO_WT" && git checkout -q --detach "$1"; }
S
run() { # $1 = case label, $2 = command run in the background to move HEAD (or "true")
  local out="$T/out-$1"; mkdir -p "$out"
  ( sleep 2; eval "$2" ) &
  RIG_REPO="$T/repo" RIG_REPO_WT="$T/repo" RIG_STATE="$T/state" RIG_WORKTREE_HELPER="$T/wt.sh" RIG_STRUCTURAL_CMD=true \
  RIG_STATIC_CMD="bash $T/static.sh {out}" RIG_PREGATE_STOP_POLL=1 RIG_REGEN_CMD= RIG_UNIT_CMD= \
    bash "$H/rig-pregate.sh" "$A" "$out" > "$out.log" 2>&1
  wait
  if [ -e "$out/static/STOP" ]; then echo "STOP"; else echo "none"; fi
}
fail=0
r=$(run moved "git -C $T/repo update-ref refs/heads/main $B && git -C $T/repo checkout -q main")
[ "$r" = STOP ] && echo "PASS HEAD moved past the sha -> STOP written" || { echo "FAIL moved: $r"; fail=1; }
cd "$T/repo" && git checkout -q --detach "$A"
r=$(run stayed true)
[ "$r" = none ] && echo "PASS HEAD stayed on the sha -> no STOP" || { echo "FAIL stayed: $r"; fail=1; }
exit $fail
