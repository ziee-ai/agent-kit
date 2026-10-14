#!/bin/bash
# auto-merge.sh — the merge rig: merge the integration branch to main when the gate passes on the CURRENT head. LOOPS until it lands.
# Gate v2 (see README.md in this directory): PREGATE every candidate tip -> FULL gate at most once per batch -> name every failure ->
# re-run each ALONE 3x (3/3 green = flake) -> real failures to $RIG_STATE/REAL-FAILS.json and HOLD -> the next tip that descends
# from that sha is a RECHECK (re-run only the real failures + the fix commits' impacted tests), never a second full gate.
#
# Merging is never this script's own decision: run it only where the owner has given a standing "merge when the gate passes".
# A one-shot "gate then merge" can never merge on a busy branch (HEAD moves while the gate runs) — so it waits for quiet, gates,
# and if HEAD moved goes round again.
#
# Config: env, then $RIG_STATE/rig.env (sourced; its assignments win). REQUIRED: RIG_REPO, RIG_STATE. Every external step is a
# RIG_* command so rig-test.sh can drive each decision path against a throwaway repo; README.md lists every variable + default.
# Deploy a change between gates only, by temp file + mv: a running bash script must never be edited in place.
RIG_BIN=${RIG_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
[ -n "${RIG_STATE:-}" ] || { echo "auto-merge: RIG_STATE is required (the rig state dir: logs, runs/, REAL-FAILS.json)" >&2; exit 2; }
[ -f "$RIG_STATE/rig.env" ] && . "$RIG_STATE/rig.env"
[ -n "${RIG_REPO:-}" ] || { echo "auto-merge: RIG_REPO is required (the app's primary clone, checked out on the integration branch)" >&2; exit 2; }
RIGD=$RIG_STATE; mkdir -p "$RIGD"
RIG_KIT=${RIG_KIT:-$(cd "$RIG_BIN/../.." && pwd)}
export RIG_BIN RIG_STATE RIG_REPO RIG_KIT
export RIG_WORKTREE=${RIG_WORKTREE:-$RIGD/rig-wt}
export RIG_WORKTREE_HELPER=${RIG_WORKTREE_HELPER:-$RIG_BIN/rig-worktree.sh}
export RIG_RUN_WRAPPER=${RIG_RUN_WRAPPER:-bash -c}
TRASH=${RIG_TRASH:-$RIGD/trash}; SCRATCH=${RIG_SCRATCH:-$RIGD/scratch}; mkdir -p "$TRASH" "$SCRATCH"
PREGATE_CMD=${RIG_PREGATE_CMD:-bash $RIG_BIN/rig-pregate.sh}
GATE_CMD=${RIG_GATE_CMD:-node $RIG_KIT/lifecycle/merge-gate.mjs}
RERUN_CMD=${RIG_RERUN_CMD:-bash $RIG_BIN/rerun-failures.sh}
FAILURES_CMD=${RIG_FAILURES_CMD:-python3 $RIG_BIN/gate-failures.py}
RECHECK_FLAKE_CMD=${RIG_RECHECK_FLAKE_CMD:-python3 $RIG_BIN/recheck-flake.py}
TIMING_CMD=${RIG_TIMING_CMD:-python3 $RIG_BIN/gate-timing.py}
TIMING_PATH=${RIG_TIMING_PATH-$RIG_BIN/rig-timing}   # set it EMPTY to run the gate without the timing shims
QUIET=${RIG_QUIET_SECS:-60}; HOLD=${RIG_HOLD_SECS:-120}; IDLE=${RIG_IDLE_SECS:-300}; MAIN=${RIG_MAIN_BRANCH:-main}
cd "$RIG_REPO" || { echo "auto-merge: cannot cd to RIG_REPO=$RIG_REPO" >&2; exit 2; }
BR=${RIG_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
tpath() { [ -n "$TIMING_PATH" ] && echo "$TIMING_PATH:$PATH" || echo "$PATH"; }

# post_merge_hook <worktree at the new main> — the app's optional post-merge step (e.g. re-record a ratchet baseline and push it).
# 0 = done or none configured. Its failure is reported, never retried.
post_merge_hook() {
  [ -n "${RIG_POST_MERGE_HOOK:-}" ] || return 0
  if (cd "$1" && $RIG_POST_MERGE_HOOK "$1") >> "$RIGD/post-merge-hook.log" 2>&1; then echo "  post-merge hook OK"
  else echo "  post-merge hook FAILED (see $RIGD/post-merge-hook.log) — needs a look"; return 1; fi
}
# do_merge "<how it was verified>" — merge $BR into main in a THROWAWAY worktree, push, run the post-merge hooks. 0 = merged;
# 1 = not (push rejected / no worktree). A conflict stops the rig (exit 1, auto-merge.done).
do_merge() {
  local how=$1 MW
  git fetch -q origin
  MW=$(mktemp -d "$SCRATCH/auto-merge-wt.XXXXXX"); rmdir "$MW"
  git worktree add -q --detach "$MW" "origin/$MAIN" 2>/dev/null || { echo "could not create a merge worktree"; return 1; }
  if ! git -C "$MW" merge --no-ff "$BR" -m "${RIG_MERGE_TITLE:-merge: $BR}

$how${RIG_MERGE_TRAILER:+

$RIG_MERGE_TRAILER}" >/dev/null 2>&1; then
    echo "MERGE CONFLICTED — aborting, $MAIN untouched"
    git -C "$MW" merge --abort 2>/dev/null; git worktree remove --force "$MW" 2>/dev/null
    touch "$RIGD/auto-merge.done"; exit 1
  fi
  if git -C "$MW" push -q origin "HEAD:$MAIN"; then
    echo "MERGED AND PUSHED to $MAIN ($(git -C "$MW" rev-parse --short HEAD)) — $how" | head -c 400; echo
    post_merge_hook "$MW"
    if [ "${RIG_POST_MERGE_CLEAN:-1}" = 1 ] && [ -n "${RIG_POST_MERGE_CLEAN_CMD:-}" ]; then
      (cd "$RIG_REPO" && $RIG_POST_MERGE_CLEAN_CMD) >> "$RIGD/post-merge-clean.log" 2>&1 || echo "post-merge clean FAILED (see $RIGD/post-merge-clean.log)"
    fi
    git worktree remove --force "$MW" 2>/dev/null; return 0
  fi
  echo "push to $MAIN REJECTED — $MAIN moved under us; will retry"
  git worktree remove --force "$MW" 2>/dev/null; return 1
}

# One-shot: RIG_POST_MERGE_HOOK_NOW=1 runs the post-merge hook on the CURRENT main and exits (for a manual push that skipped it).
if [ "${RIG_POST_MERGE_HOOK_NOW:-}" = 1 ]; then
  RW=$(mktemp -d "$SCRATCH/auto-merge-hook.XXXXXX"); rmdir "$RW"
  git fetch -q origin "$MAIN" && git worktree add -q --detach "$RW" "origin/$MAIN" && git -C "$RW" submodule update -q --init --recursive
  post_merge_hook "$RW"; rc=$?
  git worktree remove --force "$RW" 2>/dev/null; exit $rc
fi
for attempt in $(seq 1 "${RIG_MAX_ATTEMPTS:-200}"); do
  echo "=== attempt $attempt  $(date +%H:%M) ==="
  # Wait for commits to stop landing: gating a moving tree wastes the gate.
  for i in $(seq 1 40); do
    a=$(git rev-parse HEAD); sleep "$QUIET"; [ "$a" = "$(git rev-parse HEAD)" ] && break
  done
  HEAD_AT=$(git rev-parse HEAD)
  git fetch -q origin "$MAIN" 2>/dev/null
  # MAIN-RED: a red full-suite run on main (written by the app's periodic full run) HOLDS every landing so regressions never stack.
  # The conductor lands the FIX by verifying it in isolation and writing MAIN-RED-LIFT (one landing).
  if [ -f "$RIGD/MAIN-RED" ] && [ ! -f "$RIGD/MAIN-RED-LIFT" ]; then
    [ "${MR_SAID:-}" = 1 ] || echo "$(date +%H:%M) HOLD: $MAIN is RED ($RIGD/MAIN-RED) — no landing until it is green or a fix is lifted ($RIGD/MAIN-RED-LIFT)"
    MR_SAID=1; sleep "$HOLD"; continue
  fi
  MR_SAID=
  # NO BLIND RETRY of a commit that already failed: re-gating an unchanged tree can only fail again. Wait for a new commit.
  # To force ONE re-gate of the same commit: echo <sha> > $RIG_STATE/regate.
  FAILED=$(cat "$RIGD/failed-sha" 2>/dev/null)
  if [ -n "$FAILED" ] && [ "$FAILED" = "$HEAD_AT" ]; then
    if [ "$(cat "$RIGD/regate" 2>/dev/null)" = "$HEAD_AT" ]; then
      mv "$RIGD/regate" "$TRASH/regate.$(date +%s)"; echo "$(date +%H:%M) forced re-gate of ${HEAD_AT:0:7} (regate)"
    else
      [ "${WAITED_ON:-}" = "$HEAD_AT" ] || echo "$(date +%H:%M) HOLD: ${HEAD_AT:0:7} already FAILED the gate — waiting for a new commit (no blind retry)"
      WAITED_ON=$HEAD_AT; sleep "$HOLD"; continue
    fi
  fi
  if git merge-base --is-ancestor "$HEAD_AT" "origin/$MAIN" 2>/dev/null; then
    echo "$(date +%H:%M) nothing to merge — $MAIN already contains ${HEAD_AT:0:7}; waiting"; sleep "$IDLE"; continue
  fi
  # A SUBMODULE COMMIT MUST BE PUSHED BEFORE ITS PIN IS MERGEABLE (a fresh staging clone fails 'not our ref' otherwise). A submodule
  # is usually on a detached HEAD: push the sha to the branch .gitmodules names for it, or skip.
  if [ -f .gitmodules ]; then
    git config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null | while read -r key sm; do
      name=${key#submodule.}; name=${name%.path}
      [ -e "$sm/.git" ] || continue
      smbr=$(git config -f .gitmodules "submodule.$name.branch" 2>/dev/null); [ -n "$smbr" ] || continue
      if ! git -C "$sm" merge-base --is-ancestor HEAD "origin/$smbr" 2>/dev/null; then
        echo "  pushing unpushed $sm commits to $smbr before gating"
        git -C "$sm" push -q origin "HEAD:refs/heads/$smbr" 2>&1 | head -2
      fi
    done
  fi
  git push -q origin "$BR" 2>&1 | head -2
  RUN=$RIGD/runs/$(date +%m%d-%H%M)-${HEAD_AT:0:9}; mkdir -p "$RUN"; RF=$RIGD/REAL-FAILS.json
  # ---- 1. PREGATE (keep-going; red -> hold with the WHOLE list, the full gate never starts) ----
  echo "$(date +%H:%M) pregate on ${HEAD_AT:0:7} ($RUN)"
  if ! $PREGATE_CMD "$HEAD_AT" "$RUN/pregate" > "$RUN/pregate.log" 2>&1; then
    echo "$(date +%H:%M) PREGATE FAILED on ${HEAD_AT:0:7}: $(grep -E 'rc=[1-9]' "$RUN/pregate/SUMMARY" 2>/dev/null | cut -c1-160 | tr '\n' ';')"
    echo "$HEAD_AT" > "$RIGD/failed-sha"; echo "  holding — fix ALL of the above, then commit (pregate re-runs on the new tip)"; continue
  fi
  echo "$(date +%H:%M) pregate green ($(tail -1 "$RUN/pregate/TIMES" 2>/dev/null))"
  RFSHA=$(python3 -c "import json;print(json.load(open('$RF'))['sha'])" 2>/dev/null)
  if [ -n "$RFSHA" ] && [ "$RFSHA" != "$HEAD_AT" ] && git merge-base --is-ancestor "$RFSHA" "$HEAD_AT" 2>/dev/null; then
    # ---- 2. RECHECK: only the real failures + the fix commits' impact (no full gate) ----
    echo "$(date +%H:%M) RECHECK ${HEAD_AT:0:7} against the real failures of ${RFSHA:0:7} (no full gate)"
    # An UNPARSED / structural entry cannot be re-run, so a recheck must not drop it silently. A Rust compile error is cleared by
    # this tip's green pregate (its static legs compile every target); anything else needs a human, who removes the entry from
    # REAL-FAILS.json once it is fixed.
    UNP=$(python3 -c "import json;d=json.load(open('$RF'));print('; '.join(u for u in d.get('unparsed',[])+d.get('structural',[]) if 'could not compile' not in u)[:500])" 2>/dev/null)
    if [ -n "$UNP" ]; then
      echo "$(date +%H:%M) RECHECK HELD — REAL-FAILS has entries a recheck cannot re-run: $UNP"
      echo "$HEAD_AT" > "$RIGD/failed-sha"; echo "  holding — fix them, then remove them from $RF (a human step)"; continue
    fi
    python3 -c "import json;d=json.load(open('$RF'));json.dump({'structural':[],'unparsed':[],'items':d['real']},open('$RUN/recheck-items.json','w'),indent=2)"
    RERUN_TRIES=1 $RERUN_CMD "$HEAD_AT" "$RUN/recheck-items.json" "$RUN/recheck" > "$RUN/recheck.log" 2>&1; r1=$?
    # The flake rule INSIDE a recheck: a recheck runs each item once, so a load flake could only come out REAL. Break every
    # still-red step into its named tests and run those alone 3x; all green -> the recheck counts green. A red step whose failures
    # cannot be named stays REAL (recheck-flake.py exit 3).
    if [ $r1 != 0 ] && [ -f "$RUN/recheck/verdicts.tsv" ]; then
      if $RECHECK_FLAKE_CMD "$RUN" > "$RUN/recheck-flake.out" 2>&1; then
        if $RERUN_CMD "$HEAD_AT" "$RUN/recheck-flake/FAILURES.json" "$RUN/recheck-flake/rerun" > "$RUN/recheck-flake-rerun.log" 2>&1; then
          r1=0; echo "$(date +%H:%M) recheck reds were flakes (every named failure green alone 3/3) — $(head -1 "$RUN/recheck-flake.out")"
        fi
      fi
    fi
    # The fix commits' impacted tests (the delta). RIG_DELTA_CMD <base> <tip> <outdir> is a whole command; RIG_DELTA_TEST_CMD is a
    # command string run in the rig worktree at the tip through RIG_RUN_WRAPPER, '{base}' replaced by the failed sha. Neither set:
    # the delta is SKIPPED and says so, loudly, in the log and in the merge message.
    mkdir -p "$RUN/delta/test-affected"; DELTA_NOTE="the fix commits' impacted tests are green (base ${RFSHA:0:9})"
    if [ -n "${RIG_DELTA_CMD:-}" ]; then
      PATH=$(tpath) RIG_TIMING_DIR=$RUN/delta RIG_TEST_LOG_DIR=$RUN/delta/test-affected RIG_TEST_REPORT=$RUN/delta/test-affected/LAST_RUN.md \
        $RIG_DELTA_CMD "$RFSHA" "$HEAD_AT" "$RUN/delta" > "$RUN/delta/just-1-delta.log" 2>&1; r2=$?
    elif [ -n "${RIG_DELTA_TEST_CMD:-}" ]; then
      ( . "$RIG_WORKTREE_HELPER"; W=$RIG_WORKTREE; rig_worktree_at "$HEAD_AT" "$RUN/delta" && cd "$W" && \
        PATH=$(tpath) RIG_TIMING_DIR=$RUN/delta RIG_TEST_LOG_DIR=$RUN/delta/test-affected RIG_TEST_REPORT=$RUN/delta/test-affected/LAST_RUN.md \
        $RIG_RUN_WRAPPER "${RIG_DELTA_TEST_CMD//\{base\}/$RFSHA}" ) > "$RUN/delta/just-1-delta.log" 2>&1; r2=$?
    else
      r2=0; DELTA_NOTE="the fix-delta step was SKIPPED (no RIG_DELTA_CMD / RIG_DELTA_TEST_CMD configured)"
      echo "$(date +%H:%M) WARNING: DELTA SKIPPED — no RIG_DELTA_CMD / RIG_DELTA_TEST_CMD configured; the fix commits' impacted tests were NOT run" | tee "$RUN/delta/SKIPPED"
    fi
    # The flake rule for the fix's impacted tests too: name the delta's failures, re-run each alone 3x; all 3/3 green = flakes.
    if [ $r2 != 0 ]; then
      : > "$RUN/mg-empty.log"; RIG_GATED_SHA=$HEAD_AT RIG_SRC_REPO=$RIG_REPO $FAILURES_CMD "$RUN/mg-empty.log" "$RUN/delta" > "$RUN/delta/failures.out" 2>&1
      # a red delta that NAMES nothing is not "all flakes" (an empty re-run exits 0): record it UNPARSED so REAL-FAILS holds it
      python3 -c "import json,os;p='$RUN/delta/FAILURES.json';d=json.load(open(p)) if os.path.exists(p) else {'structural':[],'items':[],'unparsed':[]}
if not d['items'] and not d['unparsed'] and not d['structural']: d['unparsed'].append('the fix delta failed but no failure could be named'); json.dump(d,open(p,'w'),indent=2)"
      if [ -f "$RUN/delta/FAILURES.json" ] && $RERUN_CMD "$HEAD_AT" "$RUN/delta/FAILURES.json" "$RUN/delta/rerun" > "$RUN/delta/rerun.log" 2>&1; then
        r2=0; echo "$(date +%H:%M) fix-delta reds were flakes (every named failure green alone 3/3) — $(head -1 "$RUN/delta/failures.out")"
      fi
    fi
    if [ $r1 = 0 ] && [ $r2 = 0 ]; then
      NOW=$(git rev-parse HEAD); [ "$NOW" = "$HEAD_AT" ] || { echo "HEAD moved during the recheck — going round"; continue; }
      if do_merge "Merged on a RECHECK (fix, re-run only the failed): the full gate on ${RFSHA:0:9} failed; on ${HEAD_AT:0:9} pregate is green, every real failure re-ran green alone ($RUN/recheck/RERUN.json) and $DELTA_NOTE."; then
        mv "$RF" "$TRASH/REAL-FAILS.$(date +%s).json"
      fi
      continue
    fi
    python3 - "$RUN" "$HEAD_AT" "$RF" "$r2" <<'E'
import json,sys,os
run,sha,rf,r2=sys.argv[1:5]
still=json.load(open(os.path.join(run,'recheck','RERUN.json')))['real'] if os.path.exists(os.path.join(run,'recheck','RERUN.json')) else json.load(open(rf))['real']
dr=os.path.join(run,'delta','rerun','RERUN.json'); df=os.path.join(run,'delta','FAILURES.json')
if r2 == '0': delta={'items':[],'unparsed':[]}   # green, or every delta red was a 3/3 flake
elif os.path.exists(dr): d=json.load(open(dr)); delta={'items':d['real'],'unparsed':d['unparsed']+d['structural']}   # only the delta reds that stayed red alone
elif os.path.exists(df): delta=json.load(open(df))
else: delta={'items':[],'unparsed':['delta tests did not report']}
real=still+[i for i in delta['items'] if (i['kind'],i['id']) not in {(x['kind'],x['id']) for x in still}]
json.dump({'sha':sha,'real':real,'structural':[],'unparsed':delta.get('unparsed',[])},open(rf,'w'),indent=2)
print(f"still real: {len(still)}; new from the fix delta: {len(real)-len(still)}; unparsed: {len(delta.get('unparsed',[]))}")
E
    echo "$(date +%H:%M) RECHECK RED — $(python3 -c "import json;d=json.load(open('$RF'));print('; '.join(i['kind']+' '+i['id'] for i in d['real'])[:600])")"
    echo "$HEAD_AT" > "$RIGD/failed-sha"; echo "  holding — fix ALL listed, commit; the next recheck re-runs only these"; continue
  fi
  # ---- 3. the FULL gate (once per batch) ----
  echo "$(date +%H:%M) full gate on $BR @ ${HEAD_AT:0:7}"
  echo "$(date +%T) gate start ${HEAD_AT:0:9}" > "$RUN/gate.txt"; mkdir -p "$RUN/test-affected"
  PATH=$(tpath) RIG_TIMING_DIR=$RUN RUN_STEPS_REPORT_DIR=$RUN RIG_TEST_LOG_DIR=$RUN/test-affected RIG_TEST_REPORT=$RUN/test-affected/LAST_RUN.md \
    $GATE_CMD "$BR" > "$RIGD/mg-auto.log" 2>&1
  rc=$?
  echo "$(date +%T) gate end rc=$rc" >> "$RUN/gate.txt"; cp "$RIGD/mg-auto.log" "$RUN/mg-auto.log"
  $TIMING_CMD "$RUN" > "$RUN/SUMMARY.md" 2>&1 || true
  tail -20 "$RIGD/mg-auto.log" | grep -E '^\s+[✓✗!]|^merge-gate' | cut -c1-100
  NOW=$(git rev-parse HEAD)
  if [ $rc -ne 0 ] || ! grep -q "merge-gate: OK" "$RIGD/mg-auto.log"; then
    RIG_GATED_SHA=$HEAD_AT RIG_SRC_REPO=$RIG_REPO $FAILURES_CMD "$RIGD/mg-auto.log" "$RUN" | tee "$RUN/failures.out" | head -1
    echo "$(date +%H:%M) GATE FAILED — re-running every failure ALONE 3x on ${HEAD_AT:0:7} (flakes vs real)"
    if $RERUN_CMD "$HEAD_AT" "$RUN/FAILURES.json" "$RUN/rerun" > "$RUN/rerun.log" 2>&1; then
      if [ "$NOW" != "$HEAD_AT" ]; then
        # only flakes, but the tip moved: record the gated sha with NO real failures, so the new tip gets the cheap RECHECK
        # (pregate + the new commits' impacted tests) instead of a second full gate
        python3 -c "import json;json.dump({'sha':'$HEAD_AT','real':[],'structural':[],'unparsed':[],'note':'flake-only gate; tip moved before merge'},open('$RF','w'),indent=2)"
        echo "$(date +%H:%M) gate red only on flakes but HEAD moved (${HEAD_AT:0:7} -> ${NOW:0:7}) — recorded; the new tip gets a RECHECK, not a full gate"; continue
      fi
      do_merge "Merged on a gate that was red ONLY on flakes: every failure re-ran green 3/3 alone on ${HEAD_AT:0:9} — $(python3 -c "import json;print('; '.join(i['kind']+' '+i['id'] for i in json.load(open('$RUN/rerun/RERUN.json'))['flaky'])[:800])")"
      continue
    fi
    cp "$RUN/rerun/RERUN.json" "$RF" 2>/dev/null || cp "$RUN/FAILURES.json" "$RF"
    echo "$(date +%H:%M) GATE RED (real): $(tail -1 "$RUN/rerun.log")"
    python3 -c "import json;d=json.load(open('$RF'));[print('  REAL',i['kind'],i['id'][:150]) for i in d.get('real',d.get('items',[]))];[print('  STRUCTURAL',s[:150]) for s in d['structural']];[print('  UNPARSED',s[:150]) for s in d['unparsed']]"
    echo "$HEAD_AT" > "$RIGD/failed-sha"
    echo "  holding — fix ALL listed, commit; the next run re-checks only these (no full gate)"; continue
  fi
  [ -f "$RIGD/MAIN-RED-LIFT" ] && mv "$RIGD/MAIN-RED-LIFT" "$TRASH/MAIN-RED-LIFT.$(date +%s)"   # one landing per lift
  if [ "$NOW" != "$HEAD_AT" ]; then
    echo "HEAD MOVED during the gate (${HEAD_AT:0:7} -> ${NOW:0:7}) — not merging this verdict. Going round again."; continue
  fi
  do_merge "Merged on a green merge-gate on the MERGED tree."
  continue
done
echo "gave up after ${RIG_MAX_ATTEMPTS:-200} attempts"; touch "$RIGD/auto-merge.done"; exit 1
