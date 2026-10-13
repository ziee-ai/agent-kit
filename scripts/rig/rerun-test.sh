#!/bin/bash
# rerun-test.sh [rerun-failures.sh] — sandbox test of the flake-rule runner (no repo checkout: RIG_RERUN_NO_CHECKOUT=1).
# Each fake item is a script that reads/increments its own counter and exits per a pass/fail pattern.
# Exit = number of failed checks; prints PASS/FAIL per check.
S=$(realpath "${1:-$(dirname "$0")/rerun-failures.sh}")
SB=$(mktemp -d); trap 'rm -rf -- "$SB"' EXIT
W=$SB/wt; mkdir -p $W; fails=0
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
# item <name> <pattern>: pattern = rc per call, e.g. "0 0 1" (last value repeats)
item() { printf '#!/bin/bash\nc=$(cat %s/%s.n 2>/dev/null || echo 0); echo $((c+1)) > %s/%s.n\nset -- %s; shift $(( c < $# ? c : $#-1 )); exit $1\n' "$SB" "$1" "$SB" "$1" "$2" > $W/$1; chmod +x $W/$1; }
runs() { cat $SB/$1.n 2>/dev/null || echo 0; }
fj() { python3 -c "import json,sys;print(json.dumps({'structural':[],'unparsed':[],'items':[dict(kind='t',id=a.split(':')[0],cwd='.',cmd='./'+a.split(':')[0],**({'tries':int(a.split(':')[1])} if ':' in a else {})) for a in sys.argv[1:]]}))" "$@"; }
rf() { RIG_RERUN_NO_CHECKOUT=1 RIG_WORKTREE=$W "$S" deadbeef "$1" "$2" > "$2.out" 2>&1; }
real_tries() { python3 -c "import json,sys;d=json.load(open('$1/RERUN.json'));print([i.get('tries') for i in d['real'] if i['id']=='$2'])"; }

# R1 gate: green, green, red -> REAL and recorded intermittent (tries 3); deterministic red -> REAL without tries
item inter "0 0 1"; item det "1"; item flake "0"
fj inter det flake > $SB/f1.json; rf $SB/f1.json $SB/r1
grep -q $'^REAL\tt\tinter' $SB/r1/verdicts.tsv && ok "R1 intermittent is REAL" || bad "R1 intermittent not REAL"
[ "$(real_tries $SB/r1 inter)" = "[3]" ] && ok "R1 intermittent recorded tries=3" || bad "R1 intermittent tries=$(real_tries $SB/r1 inter)"
[ "$(real_tries $SB/r1 det)" = "[None]" ] && ok "R1 deterministic red has no tries" || bad "R1 deterministic tries=$(real_tries $SB/r1 det)"
grep -q $'^FLAKY\tt\tflake' $SB/r1/verdicts.tsv && [ "$(runs flake)" = 3 ] && ok "R1 3/3 green = FLAKY" || bad "R1 flake verdict/runs ($(runs flake))"

# R2 recheck (RERUN_TRIES=1) of the RERUN.json real list: the intermittent item runs 3x, a plain item once
python3 -c "import json;d=json.load(open('$SB/r1/RERUN.json'));json.dump({'structural':[],'unparsed':[],'items':d['real']},open('$SB/f2.json','w'))"
item inter "0 0 1"; item det "0"; : > $SB/inter.n; : > $SB/det.n; echo 0 > $SB/inter.n; echo 0 > $SB/det.n
RERUN_TRIES=1 rf $SB/f2.json $SB/r2; rc=$?
[ "$(runs inter)" = 3 ] && ok "R2 intermittent rechecked 3x" || bad "R2 intermittent rechecked $(runs inter)x"
[ "$(runs det)" = 1 ] && ok "R2 plain item rechecked once" || bad "R2 plain item rechecked $(runs det)x"
grep -q $'^REAL\tt\tinter' $SB/r2/verdicts.tsv && [ $rc = 1 ] && ok "R2 intermittent red on recheck holds" || bad "R2 intermittent passed the recheck (rc=$rc)"
[ "$(real_tries $SB/r2 inter)" = "[3]" ] && ok "R2 still-real intermittent keeps tries=3" || bad "R2 tries=$(real_tries $SB/r2 inter)"

# R3 recheck where the intermittent item is now green 3/3 -> GREEN, exit 0
item inter "0"; echo 0 > $SB/inter.n
fj inter:3 > $SB/f3.json; RERUN_TRIES=1 rf $SB/f3.json $SB/r3; rc=$?
[ "$(runs inter)" = 3 ] && grep -q $'^GREEN\tt\tinter' $SB/r3/verdicts.tsv && [ $rc = 0 ] && ok "R3 fixed intermittent green 3/3 -> GREEN" || bad "R3 runs=$(runs inter) rc=$rc"
echo "rerun-test: $fails failed"; exit $fails
