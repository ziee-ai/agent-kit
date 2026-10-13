#!/bin/bash
# rig-test.sh [auto-merge script] — drive every decision path of the merge rig (default: the sibling auto-merge.sh) against a THROWAWAY
# repo (bare origin + clone on an integration branch) with FAKE pregate / gate / rerun / delta commands steered by control files.
# Nothing touches a real repo, origin or rig state: RIG_REPO / RIG_STATE point into the sandbox (a mktemp dir under
# ${RIG_TEST_TMP:-$TMPDIR}, removed on exit unless RIG_TEST_KEEP=1). The REAL gate-failures.py / recheck-flake.py / gate-timing.py
# from this directory run (RIG_BIN = this directory), so the harness also exercises the failure parser. Needs no app.
# Exit = number of failed scenario checks; prints PASS/FAIL per check and RIG-TEST-FAILED=<n>.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RIG=$(realpath "${1:-$HERE/auto-merge.sh}")   # default: the auto-merge.sh next to this harness
for v in $(compgen -v RIG_); do unset "$v"; done   # no inherited rig config leaks into the sandbox runs
SB=$(mktemp -d "${RIG_TEST_TMP:-${TMPDIR:-/tmp}}/rigtest.XXXXXX"); CTL=$SB/ctl; FK=$SB/fake; ST=$SB/state; mkdir -p $CTL $FK $ST
[ "${RIG_TEST_KEEP:-}" = 1 ] || trap 'rm -rf -- "$SB"' EXIT
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=rigtest GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=rigtest GIT_COMMITTER_EMAIL=t@t
git init -q --bare $SB/origin.git
git clone -q $SB/origin.git $SB/primary 2>/dev/null; cd $SB/primary
git config user.email t@t; git config user.name rigtest; git config commit.gpgsign false
echo base > f.txt; git add f.txt; git commit -qm base; git branch -M main; git push -q origin main
git checkout -qb feat/int; echo x > g.txt; git add g.txt; git commit -qm "batch 1"; git push -q -u origin feat/int

cat > $FK/pregate <<EOF
#!/bin/bash
mkdir -p "\$2"; rc=\$(cat $CTL/pregate 2>/dev/null || echo 0); echo "P1-structural rc=\$rc" > "\$2/SUMMARY"; echo "end" > "\$2/TIMES"; exit \$rc
EOF
cat > $FK/gate <<EOF
#!/bin/bash
mode=\$(cat $CTL/gate 2>/dev/null || echo ok)
if [ -f $CTL/gate_move ]; then rm -f $CTL/gate_move; (cd $SB/primary && echo moved >> g.txt && git commit -qam "moved during gate" && git push -q origin feat/int); fi
if [ "\$mode" = ok ]; then echo "  ✓ C9     repo-test            PASS — fake"; echo "merge-gate: OK"; exit 0; fi
mkdir -p "\$RIG_TIMING_DIR/test-affected"
printf '     Running tests/integration_tests.rs (x)\ntest fake::flaky_or_real_test ... FAILED\n' > "\$RIG_TIMING_DIR/test-affected/gate-rust-full-tier.log"
echo "  ✗ C9     repo-test            FAIL — fake red"; echo "merge-gate: FAIL"; exit 1
EOF
cat > $FK/rerun <<EOF
#!/bin/bash
mkdir -p "\$3"; case "\$3" in *recheck-flake*) mode=\$(cat $CTL/rerun_flake 2>/dev/null || echo flaky);; */delta/rerun) mode=\$(cat $CTL/rerun_delta 2>/dev/null || echo real);; *) mode=\$(cat $CTL/rerun 2>/dev/null || echo flaky);; esac
python3 - "\$2" "\$3" "\$1" "\$mode" <<'P'
import json,sys,os
f,out,sha,mode=sys.argv[1:5]; d=json.load(open(f)); items=d['items']
v={'real':'REAL','green':'GREEN','flaky':'FLAKY'}.get(mode,'FLAKY')
with open(os.path.join(out,'verdicts.tsv'),'w') as vt:
    for n,i in enumerate(items,1):
        vt.write('\t'.join([v,i['kind'],i['id'],i['cwd'],str(i.get('tries') or '-'),i['cmd']])+'\n')   # rerun-failures.sh's 6 columns
        open(os.path.join(out,f'rerun-{n}.log'),'w').write('     Running tests/integration_tests.rs (x)\ntest '+i['id']+' ... FAILED\n' if v=='REAL' else 'ok\n')
key={'REAL':'real','GREEN':'green','FLAKY':'flaky'}[v]
res={'sha':sha,'flaky':[],'green':[],'real':[],'structural':d.get('structural',[]),'unparsed':d.get('unparsed',[])}; res[key]=items
json.dump(res,open(out+'/RERUN.json','w'))
sys.exit(1 if v=='REAL' or res['structural'] or res['unparsed'] else 0)
P
EOF
cat > $FK/delta <<EOF
#!/bin/bash
mkdir -p "\$3/test-affected"; rc=\$(cat $CTL/delta 2>/dev/null || echo 0)
[ "\$rc" = 0 ] || printf '     Running tests/integration_tests.rs (x)\ntest fake::delta_test ... FAILED\n' > "\$3/test-affected/gate-rust-full-tier.log"
exit \$rc
EOF
chmod +x $FK/*
# the portable loop's config: the two required vars, the kit's own parser/flake/timing scripts, fakes for every app-side step
RIG_ENV=(RIG_REPO=$SB/primary RIG_STATE=$ST RIG_BIN=$HERE RIG_FAILURES_CMD="python3 $HERE/gate-failures.py" RIG_RECHECK_FLAKE_CMD="python3 $HERE/recheck-flake.py"
  RIG_TIMING_CMD="python3 $HERE/gate-timing.py" RIG_PREGATE_CMD=$FK/pregate RIG_GATE_CMD=$FK/gate RIG_RERUN_CMD=$FK/rerun
  RIG_QUIET_SECS=0 RIG_HOLD_SECS=0 RIG_IDLE_SECS=0 RIG_MAX_ATTEMPTS=1 RIG_POST_MERGE_CLEAN=0)
run_rig() { env "${RIG_ENV[@]}" RIG_DELTA_CMD=$FK/delta bash "$RIG" > $SB/rig-$1.log 2>&1; }
run_rig_nodelta() { env "${RIG_ENV[@]}" bash "$RIG" > $SB/rig-$1.log 2>&1; }
commit() { cd $SB/primary; echo "$1" >> g.txt; git commit -qam "$1"; git push -q origin feat/int; git rev-parse HEAD; }
on_main() { git -C $SB/primary fetch -q origin main; git -C $SB/primary merge-base --is-ancestor "$1" origin/main; }

# S1 pregate red -> hold, no gate, no merge
echo 1 > $CTL/pregate; H=$(git -C $SB/primary rev-parse HEAD); run_rig s1
[ "$(cat $ST/failed-sha 2>/dev/null)" = "$H" ] && ok "S1 pregate red -> failed-sha held" || bad "S1 failed-sha not written"
on_main $H && bad "S1 merged despite red pregate" || ok "S1 not merged"
grep -q 'full gate' $SB/rig-s1.log && bad "S1 ran the full gate after a red pregate" || ok "S1 full gate never started"
# S1b same sha again -> blind-retry hold (no pregate rerun)
run_rig s1b; grep -q 'already FAILED' $SB/rig-s1b.log && ok "S1b same sha held (no blind retry)" || bad "S1b same sha not held"
# S2 new commit, pregate + gate green -> merge
echo 0 > $CTL/pregate; echo ok > $CTL/gate; H=$(commit s2); run_rig s2
on_main $H && ok "S2 green gate merged" || bad "S2 green gate NOT merged ($(tail -2 $SB/rig-s2.log | tr '\n' ' '))"
# S3 gate red only on flakes -> merge without re-gate
echo fail > $CTL/gate; echo flaky > $CTL/rerun; H=$(commit s3); run_rig s3
on_main $H && ok "S3 flake-only red merged" || bad "S3 flake-only red NOT merged ($(tail -3 $SB/rig-s3.log | tr '\n' ' '))"
grep -q 'flaky_or_real_test' $ST/runs/*/FAILURES.json 2>/dev/null && ok "S3 gate-failures named the failing test" || bad "S3 failure not parsed"
# S4 gate red with a real failure -> REAL-FAILS + hold
echo real > $CTL/rerun; H4=$(commit s4); run_rig s4
on_main $H4 && bad "S4 merged a real failure" || ok "S4 real failure not merged"
[ "$(python3 -c "import json;print(json.load(open('$ST/REAL-FAILS.json'))['sha'])" 2>/dev/null)" = "$H4" ] && ok "S4 REAL-FAILS.json recorded" || bad "S4 REAL-FAILS missing"
# S6 fix commit but the failure is still red on recheck -> held, REAL-FAILS moves to the new sha, no full gate
echo real > $CTL/rerun_flake   # S6: the failure is still red ALONE too (recheck-flake rule)
H6=$(commit s6); run_rig s6
grep -q 'RECHECK' $SB/rig-s6.log && ok "S6 recheck path taken (no full gate)" || bad "S6 recheck not taken"
grep -qE '^[0-9:]+ full gate on [^ ]+ @' $SB/rig-s6.log && bad "S6 ran the full gate again" || ok "S6 full gate NOT re-run"
on_main $H6 && bad "S6 merged a still-red recheck" || ok "S6 still-red recheck held"
[ "$(python3 -c "import json;print(json.load(open('$ST/REAL-FAILS.json'))['sha'])" 2>/dev/null)" = "$H6" ] && ok "S6 REAL-FAILS advanced to the new tip" || bad "S6 REAL-FAILS not advanced"
# S5 next fix commit: recheck green + delta green -> merge, REAL-FAILS cleared
echo green > $CTL/rerun; echo flaky > $CTL/rerun_flake; echo 0 > $CTL/delta; H5=$(commit s5); run_rig s5
on_main $H5 && ok "S5 recheck green merged" || bad "S5 recheck green NOT merged ($(tail -3 $SB/rig-s5.log | tr '\n' ' '))"
[ -f $ST/REAL-FAILS.json ] && bad "S5 REAL-FAILS not cleared" || ok "S5 REAL-FAILS cleared"
grep -qE '^[0-9:]+ full gate on [^ ]+ @' $SB/rig-s5.log && bad "S5 ran the full gate" || ok "S5 no full gate"
# S7 recheck green but the fix's own impacted tests red -> held
echo fail > $CTL/gate; echo real > $CTL/rerun; H7=$(commit s7a); run_rig s7a
echo green > $CTL/rerun; echo 1 > $CTL/delta; H7b=$(commit s7b); run_rig s7b
on_main $H7b && bad "S7 merged with a red delta" || ok "S7 red delta held"
grep -q 'fake::delta_test' $ST/REAL-FAILS.json 2>/dev/null && ok "S7 the delta's real failure is in REAL-FAILS" || bad "S7 delta failure not recorded"
grep -q 'fix-delta reds were flakes' $SB/rig-s7b.log && bad "S7 called a real delta red a flake" || ok "S7 delta red stayed real alone"
# S10 recheck green, the fix delta red but every delta failure green alone 3/3 -> flake -> merged, no full gate
rm -f $ST/failed-sha $ST/REAL-FAILS.json
echo fail > $CTL/gate; echo real > $CTL/rerun; echo 0 > $CTL/delta; H10=$(commit s10a); run_rig s10a
echo green > $CTL/rerun; echo 1 > $CTL/delta; echo flaky > $CTL/rerun_delta; H10b=$(commit s10b); run_rig s10b
grep -q 'fix-delta reds were flakes' $SB/rig-s10b.log && ok "S10 delta red re-run alone 3x -> flake" || bad "S10 delta flake pass not taken ($(tail -3 $SB/rig-s10b.log | tr '\n' ' '))"
on_main $H10b && ok "S10 delta-flake recheck merged" || bad "S10 delta-flake recheck NOT merged"
grep -qE '^[0-9:]+ full gate on [^ ]+ @' $SB/rig-s10b.log && bad "S10 ran a full gate" || ok "S10 no full gate"
echo real > $CTL/rerun_delta; echo 0 > $CTL/delta
# S8 gate red only on flakes but the tip MOVES during the gate -> no merge, REAL-FAILS with an empty real list; the next run is a
#    RECHECK (no second full gate) and merges
echo green > $CTL/rerun; echo 0 > $CTL/delta; rm -f $ST/failed-sha $ST/REAL-FAILS.json
echo fail > $CTL/gate; echo flaky > $CTL/rerun; touch $CTL/gate_move; H8=$(commit s8); run_rig s8
on_main $H8 && bad "S8 merged a moved tip" || ok "S8 flake-only + moved tip not merged"
[ "$(python3 -c "import json;d=json.load(open('$ST/REAL-FAILS.json'));print(d['sha'], len(d['real']))" 2>/dev/null)" = "$H8 0" ] && ok "S8 recorded the gated sha with no real failures" || bad "S8 no empty REAL-FAILS record"
echo green > $CTL/rerun; H8b=$(git -C $SB/primary rev-parse HEAD); run_rig s8b
grep -qE '^[0-9:]+ full gate on [^ ]+ @' $SB/rig-s8b.log && bad "S8b ran a second full gate" || ok "S8b no second full gate"
on_main $H8b && ok "S8b recheck merged the moved tip" || bad "S8b moved tip NOT merged ($(tail -3 $SB/rig-s8b.log | tr '\n' ' '))"
# S9 a recheck red that is a FLAKE (green alone 3x) -> merged, no full gate
rm -f $ST/failed-sha $ST/REAL-FAILS.json; echo 0 > $CTL/delta
echo fail > $CTL/gate; echo real > $CTL/rerun; H9=$(commit s9a); run_rig s9a
echo real > $CTL/rerun; echo flaky > $CTL/rerun_flake; H9b=$(commit s9b); run_rig s9b
grep -q 'recheck reds were flakes' $SB/rig-s9b.log && ok "S9 recheck red re-run alone 3x -> flake" || bad "S9 recheck flake pass not taken ($(tail -3 $SB/rig-s9b.log | tr '\n' ' '))"
on_main $H9b && ok "S9 recheck-flake merged" || bad "S9 recheck-flake NOT merged"
grep -qE '^[0-9:]+ full gate on [^ ]+ @' $SB/rig-s9b.log && bad "S9 ran a full gate" || ok "S9 no full gate"
# S9c a recheck red that stays REAL alone 3x -> held
rm -f $ST/failed-sha $ST/REAL-FAILS.json
echo fail > $CTL/gate; echo real > $CTL/rerun; H9c=$(commit s9c); run_rig s9c
echo real > $CTL/rerun; echo real > $CTL/rerun_flake; H9d=$(commit s9d); run_rig s9d
on_main $H9d && bad "S9c merged a recheck red that stayed real" || ok "S9c real recheck red held"
# S11 REAL-FAILS carries an entry a recheck cannot re-run (unparsed) -> the recheck HOLDS instead of dropping it silently;
#     a Rust compile error is the exception: the tip's green pregate clears it -> merged
rm -f $ST/failed-sha $ST/REAL-FAILS.json; echo 0 > $CTL/delta
echo fail > $CTL/gate; echo real > $CTL/rerun; H11=$(commit s11a); run_rig s11a
python3 -c "import json;p='$ST/REAL-FAILS.json';d=json.load(open(p));d['unparsed']=['C9 failed but no individual failure could be collected'];json.dump(d,open(p,'w'))"
echo green > $CTL/rerun; H11b=$(commit s11b); run_rig s11b
grep -q 'RECHECK HELD' $SB/rig-s11b.log && ok "S11 unparsed entry holds the recheck" || bad "S11 unparsed entry dropped ($(tail -2 $SB/rig-s11b.log | tr '\n' ' '))"
on_main $H11b && bad "S11 merged past an unparsed entry" || ok "S11 not merged"
python3 -c "import json;p='$ST/REAL-FAILS.json';d=json.load(open(p));d['unparsed']=['a Rust compile error (could not compile)'];json.dump(d,open(p,'w'))"
H11c=$(commit s11c); run_rig s11c
on_main $H11c && ok "S11 compile-error entry cleared by the green pregate -> merged" || bad "S11 compile-error entry blocked ($(tail -2 $SB/rig-s11c.log | tr '\n' ' '))"
# S12 no delta command configured -> the recheck still decides, but the skip is LOUD (log + merge message), never silently green
rm -f $ST/failed-sha $ST/REAL-FAILS.json; echo 0 > $CTL/delta
echo fail > $CTL/gate; echo real > $CTL/rerun; H12=$(commit s12a); run_rig s12a
echo green > $CTL/rerun; H12b=$(commit s12b); run_rig_nodelta s12b
grep -q 'DELTA SKIPPED' $SB/rig-s12b.log && ok "S12 unconfigured delta logged as SKIPPED" || bad "S12 delta skip not logged ($(tail -2 $SB/rig-s12b.log | tr '\n' ' '))"
on_main $H12b && ok "S12 recheck merged" || bad "S12 recheck NOT merged"
git -C $SB/primary log -1 --format=%B origin/main | grep -q 'SKIPPED' && ok "S12 merge message records the skipped delta" || bad "S12 merge message hides the skipped delta"
# S0 the required config fails fast with a clear message
env -u RIG_REPO RIG_STATE=$SB/empty-state bash "$RIG" > $SB/rig-s0.log 2>&1; rc=$?
[ $rc = 2 ] && grep -q 'RIG_REPO is required' $SB/rig-s0.log && ok "S0 missing RIG_REPO fails fast" || bad "S0 missing RIG_REPO: rc=$rc"
env -u RIG_STATE RIG_REPO=$SB/primary bash "$RIG" > $SB/rig-s0b.log 2>&1; rc=$?
[ $rc = 2 ] && grep -q 'RIG_STATE is required' $SB/rig-s0b.log && ok "S0 missing RIG_STATE fails fast" || bad "S0 missing RIG_STATE: rc=$rc"
[ "${RIG_TEST_KEEP:-}" = 1 ] && echo "sandbox kept: $SB"
echo "RIG-TEST-FAILED=$fails"; exit $fails
