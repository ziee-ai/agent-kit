#!/bin/bash
# recheck-flake-test.sh [recheck-flake.py] — the flake pass must re-run the item's REAL command (rerun-failures.sh writes 6 columns:
# verdict kind id cwd tries cmd). Measured: a 5-column reader ran the tries value '-' as the command. Exit = failed checks.
S=$(realpath "${1:-$(dirname "$0")/recheck-flake.py}"); T=$(mktemp -d); trap 'rm -rf -- "$T"' EXIT
mkdir -p $T/recheck; f=0
printf 'REAL\tnode\tscripts/x.test.mjs\tsrc-app/ui\t-\tnode --test scripts/x.test.mjs\nREAL\tvitest\tsrc/y.store.test.ts\tsrc-app/ui\t3\tnpx vitest run src/y.store.test.ts\nREAL\tvitest\tsrc/z.store.test.ts\tsrc-app/ui\tnpx vitest run src/z.store.test.ts\n' > $T/recheck/verdicts.tsv
python3 "$S" "$T" > /dev/null 2>&1
got=$(python3 -c "import json;d=json.load(open('$T/recheck-flake/FAILURES.json'));print('|'.join(i['cmd']+'#'+str(i.get('tries')) for i in d['items']))" 2>/dev/null)
want='node --test scripts/x.test.mjs#None|npx vitest run src/y.store.test.ts#3|npx vitest run src/z.store.test.ts#None'
[ "$got" = "$want" ] && echo "PASS commands + tries read from 6- and 5-column rows" || { echo "FAIL got: $got"; f=1; }
# a red recheck STEP whose rerun log carries node:test `✖` failures is decomposed into NAMED node items (file + exact title)
rm -rf $T/recheck-flake $T/recheck; mkdir -p $T/recheck
printf 'REAL\tstep\tnpm run test\tsrc-app/ui\t-\tnpm run test\n' > $T/recheck/verdicts.tsv
printf 'test at plugins/a.test.ts:365:1\n✖ TEST-3 the REAL tree: the emitted map covers every manifest entry (non-vacuity floor) (10169.017482ms)\n' > $T/recheck/rerun-1.log
python3 "$S" "$T" > /dev/null 2>&1
got2=$(python3 -c "import json;d=json.load(open('$T/recheck-flake/FAILURES.json'));print('|'.join(i['kind']+'#'+i['id'] for i in d['items']))" 2>/dev/null)
case "$got2" in *'node#plugins/a.test.ts:TEST-3 the REAL tree: the emitted map covers every manifest entry (non-vacuity floor)'*) echo "PASS red node step decomposed into a named node item";; *) echo "FAIL node step decomposition: $got2"; f=1;; esac
echo "recheck-flake-test: $f failed"; exit $f
