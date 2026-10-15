#!/bin/bash
# gate-failures-e2e-test.sh — gate-failures.py names a playwright failure for a re-run by FILE + exact TITLE (-g), so a fix that
# shifts the test's line still re-runs it; a report line without a title falls back to file:line. Exit 0 = pass.
set -u
H=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/run/test-affected"; : > "$T/mg.log"
cat > "$T/run/test-affected/e2e.log" <<'LOG'
  1) [chromium] › tests/e2e/shop/cart.spec.ts:42:3 › Cart › removes (the last) item at 390
  2) [chromium] › tests/e2e/shop/pay.spec.ts:7:1 ›
LOG
python3 "$H/gate-failures.py" "$T/mg.log" "$T/run" > "$T/out" 2>&1
fail=0
python3 - "$T/run/FAILURES.json" <<'PY' || fail=1
import json, sys
items = {i['id']: i['cmd'] for i in json.load(open(sys.argv[1]))['items']}
checks = [
  ('titled failure re-runs by file + exact -g title (describe path + title, escaped, end-anchored)',
   items.get('tests/e2e/shop/cart.spec.ts:42') == "npx playwright test tests/e2e/shop/cart.spec.ts -g 'Cart\\ removes\\ \\(the\\ last\\)\\ item\\ at\\ 390$' --workers=1"),
  ('titled failure keeps the file:line id', 'tests/e2e/shop/cart.spec.ts:42' in items),
  ('untitled failure falls back to file:line', items.get('tests/e2e/shop/pay.spec.ts:7') == 'npx playwright test tests/e2e/shop/pay.spec.ts:7 --workers=1'),
]
bad = 0
for name, ok in checks:
    print(('PASS ' if ok else 'FAIL ') + name); bad |= (not ok)
sys.exit(1 if bad else 0)
PY
J="$T/run/FAILURES.json"
[ $fail = 0 ] || { echo "--- FAILURES.json"; cat "$J"; echo "--- out"; cat "$T/out"; }
exit $fail
