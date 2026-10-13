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
echo "recheck-flake-test: $f failed"; exit $f
