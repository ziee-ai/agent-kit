#!/bin/bash
# rerun-failures.sh <sha> <FAILURES.json> <outdir> — re-run every failed item of a gate ALONE on <sha> (owner 2026-10-12:
# "if it failed, rerun it and see if they are just flaky, if they are, then treat as pass. If not, fix, then rerun only the
# failed"). Each item: run once; if green, twice more — 3/3 green = FLAKY (counts as a pass), any red = REAL. Items run one
# after another, each to the end (keep-going); structural/unparsed entries in FAILURES.json are REAL without a run.
# Writes <outdir>/RERUN.json {sha, flaky:[], real:[], structural:[], unparsed:[]} and <outdir>/rerun-<n>.log per run.
# Exit 0 = every failure was a flake (merge); 1 = at least one real failure (hold; re-run only `real` after the fix).
# INTERMITTENT reds (green at least once, then red) are REAL with "tries": 3 recorded on the item; a RECHECK (RERUN_TRIES=1)
# honours a per-item "tries", so a 2/3 failure must pass 3/3 alone on the fix tip — one lucky green cannot merge it
# (measured: a test went pass/pass/fail alone; a 1-try recheck would have passed it 2 times in 3).
# Config (env): RIG_WORKTREE — the persistent worktree the items run in (required); RIG_WORKTREE_HELPER — a script defining
# rig_worktree_at <sha> <logdir> that puts $W at <sha> with deps installed (default: a plain detached checkout + clean);
# RIG_RUN_WRAPPER — a prefix taking the command as ONE argument, e.g. "sg docker -c" (default "bash -c").
# Part of the kit's merge rig (README.md here); a consumer's wrapper typically adds host thread caps and a docker group.
SHA=${1:?sha}; F=${2:?FAILURES.json}; OUT=${3:?outdir}; mkdir -p "$OUT"
W=${RIG_WORKTREE:?set RIG_WORKTREE to the rig worktree}; WRAP=${RIG_RUN_WRAPPER:-bash -c}
if [ -z "$RIG_RERUN_NO_CHECKOUT" ]; then   # seam: rerun-test.sh
  if [ -n "$RIG_WORKTREE_HELPER" ]; then . "$RIG_WORKTREE_HELPER"; rig_worktree_at "$SHA" "$OUT" || exit 99
  else git -C "$W" checkout -q -f --detach "$SHA" && git -C "$W" clean -fdq || exit 99; fi
fi
python3 - "$F" > "$OUT/items.tsv" <<'E'
import json,sys
d=json.load(open(sys.argv[1]))
for i in d['items']: print('\t'.join([i['kind'], i['id'], i['cwd'], str(i.get('tries') or '-'), i['cmd']]))
E
: > "$OUT/verdicts.tsv"; n=0
while IFS=$'\t' read -r kind id cwd tries cmd; do
  verdict=$([ "${RERUN_TRIES:-3}" = 1 ] && echo GREEN || echo FLAKY)   # one try = a recheck of a fix: green, not a flake
  rt=$tries   # an item already known intermittent keeps its 3 tries in the record
  [ "$tries" = - ] && tries=${RERUN_TRIES:-3}; [ "$tries" -lt "${RERUN_TRIES:-3}" ] && tries=${RERUN_TRIES:-3}
  for t in $(seq 1 $tries); do
    n=$((n+1)); log="$OUT/rerun-$n.log"
    echo "### $kind $id (try $t) $(date +%T) :: (cd $cwd && $cmd)" > "$log"
    (cd "$W/$cwd" && $WRAP "$cmd") >> "$log" 2>&1 < /dev/null; rc=$?
    echo "### rc=$rc $(date +%T)" >> "$log"
    [ $rc = 0 ] || { verdict=REAL; [ $t -gt 1 ] && rt=3; break; }   # green then red = intermittent: its recheck needs 3/3
  done
  [ $verdict = REAL ] || rt=-
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$verdict" "$kind" "$id" "$cwd" "$rt" "$cmd" >> "$OUT/verdicts.tsv"
  echo "$verdict $kind $id"
done < "$OUT/items.tsv"
python3 - "$F" "$OUT" "$SHA" <<'E'
import json,sys,os
f,out,sha=sys.argv[1:4]; d=json.load(open(f))
res={'sha':sha,'flaky':[],'green':[],'real':[],'structural':d['structural'],'unparsed':d['unparsed']}
for l in open(os.path.join(out,'verdicts.tsv')):
    v,kind,id_,cwd,rt,cmd=l.rstrip('\n').split('\t',5)
    it={'kind':kind,'id':id_,'cwd':cwd,'cmd':cmd}
    if v not in ('FLAKY','GREEN') and rt not in ('-','1'): it['tries']=int(rt)
    res[{'FLAKY':'flaky','GREEN':'green'}.get(v,'real')].append(it)
json.dump(res,open(os.path.join(out,'RERUN.json'),'w'),indent=2)
bad=len(res['real'])+len(res['structural'])+len(res['unparsed'])
print(f"RERUN: flaky={len(res['flaky'])} green={len(res['green'])} real={len(res['real'])} structural={len(res['structural'])} unparsed={len(res['unparsed'])}")
sys.exit(1 if bad else 0)
E
