#!/usr/bin/env python3
"""recheck-flake.py <RUN> — the gate's flake rule for reds that APPEAR or PERSIST in a RECHECK (a recheck runs each item once, so a load flake
there could only ever come out REAL — measured: a test that was green alone 3/3 came out REAL).
Reads <RUN>/recheck/{items.tsv,verdicts.tsv,rerun-N.log} (RERUN_TRIES=1: item i <-> rerun-i.log). For every REAL item:
  - a test item (rust/vitest/node/e2e) is carried as-is;
  - a STEP item is broken down into the named tests its rerun log reports (gate-failures.py parsers); a red step whose failures
    cannot be named stays REAL (listed under 'unparsed').
Writes <RUN>/recheck-flake/FAILURES.json for rerun-failures.sh (3 tries each). Exit 0 = every REAL item decomposed; 3 = some could
not be (the caller must treat the recheck as red)."""
import sys, os, json, subprocess, shutil
# the failure parser: RIG_GATE_FAILURES_PY, default the gate-failures.py next to this script
GF = os.environ.get('RIG_GATE_FAILURES_PY') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gate-failures.py')
run = sys.argv[1]
rc_dir = os.path.join(run, 'recheck'); out = os.path.join(run, 'recheck-flake'); os.makedirs(out, exist_ok=True)
verd = [l.rstrip('\n').split('\t') for l in open(os.path.join(rc_dir, 'verdicts.tsv')) if l.strip()]
items, unparsed = [], []
work = os.path.join(out, 'parse'); os.makedirs(work, exist_ok=True)
for i, v in enumerate(verd, 1):
    # rerun-failures.sh writes 6 columns (verdict kind id cwd tries cmd); a 5-column row (no tries) is accepted too
    verdict, kind, id_, cwd = v[:4]
    tries, cmd = (v[4], v[5]) if len(v) >= 6 else ('-', v[4])
    if verdict != 'REAL':
        continue
    if kind != 'step':
        it = {'kind': kind, 'id': id_, 'cwd': cwd, 'cmd': cmd}
        if tries not in ('-', '1', ''): it['tries'] = int(tries)
        items.append(it); continue
    log = os.path.join(rc_dir, f'rerun-{i}.log')
    one = os.path.join(work, f'step-{i}'); os.makedirs(one, exist_ok=True)
    if os.path.exists(log): shutil.copy(log, os.path.join(one, 'just-1-recheck.log'))
    empty = os.path.join(one, 'mg-empty.log'); open(empty, 'w').close()
    subprocess.run([sys.executable, GF, empty, one], capture_output=True, text=True)
    try: named = json.load(open(os.path.join(one, 'FAILURES.json')))['items']
    except Exception: named = []
    named = [n for n in named if n['kind'] != 'step']
    if not named: unparsed.append(f'{id_} (rerun-{i}.log): red, but no individual failing test could be named')
    for n in named:
        if (n['kind'], n['id']) not in {(x['kind'], x['id']) for x in items}: items.append(n)
json.dump({'structural': [], 'unparsed': unparsed, 'items': items}, open(os.path.join(out, 'FAILURES.json'), 'w'), indent=2)
print(f'recheck-flake: {len(items)} named test(s) to rerun alone 3x; {len(unparsed)} undecomposable red step(s)')
for x in items: print('  ITEM', x['kind'], x['id'][:140])
for u in unparsed: print('  UNPARSED', u[:160])
sys.exit(3 if unparsed else 0)
