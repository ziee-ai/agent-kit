#!/usr/bin/env python3
"""gate-timing.py <timing-dir> — per-stage + per-recipe durations of one merge-gate run (written by the rig-timing shims).
Stages come from calls.tsv (every just/cargo call the gate made, with depth); recipes inside a top-level just call come from the
JUST_VERBOSE+JUST_TIMESTAMP log ('===> running recipe' followed by '[HH:MM:SS]' lines): a recipe's duration = next recipe's first
timestamp - its first timestamp (the last one ends at the call's end). Also lifts test-affected's 'MERGE GATE …: <secs>' lines and
e2e-lock WAITING lines."""
import sys, os, re, glob
from datetime import datetime, timedelta
d = sys.argv[1]
def t(s): return datetime.strptime(s, '%H:%M:%S')
def secs(a, b):
    x = (t(b) - t(a)).total_seconds()
    return x + 86400 if x < 0 else x
def fmt(s): s = int(s); return f'{s//3600}h{s%3600//60:02d}m{s%60:02d}s' if s >= 3600 else f'{s//60}m{s%60:02d}s'
g = open(os.path.join(d, 'gate.txt')).read() if os.path.exists(os.path.join(d, 'gate.txt')) else ''
print(f'# merge-gate timing — {os.path.basename(d)}\n')
m = re.findall(r'^(\d\d:\d\d:\d\d) gate (start|end)(.*)$', g, re.M)
if len(m) == 2: print(f'Total gate wall time: **{fmt(secs(m[0][0], m[1][0]))}** ({m[0][0]} -> {m[1][0]}{m[1][2]})\n')
rows = [l.rstrip('\n').split('\t') for l in open(os.path.join(d, 'calls.tsv'))] if os.path.exists(os.path.join(d, 'calls.tsv')) else []
print('## Top-level calls (the gate stages: C3 regen, C1 cargo, C7 merge-checks, C9 test-affected-merged)\n')
print('| start | end | duration | rc | tool | args |\n|---|---|---|---|---|---|')
for r in rows:
    if len(r) >= 8 and r[4] == '0': print(f'| {r[0]} | {r[1]} | {fmt(float(r[2]))} | {r[3]} | {r[5]} | `{r[7][:90]}` |')
print('\n## Nested calls over 30 s (depth >= 1)\n')
print('| start | duration | rc | tool | args |\n|---|---|---|---|---|')
for r in sorted([r for r in rows if len(r) >= 8 and r[4] != '0' and float(r[2]) >= 30], key=lambda r: -float(r[2])):
    print(f'| {r[0]} | {fmt(float(r[2]))} | {r[3]} | {r[5]} | `{r[7][:90]}` |')
for f in sorted(glob.glob(os.path.join(d, 'just-*.log')), key=lambda p: int(re.search(r'just-(\d+)-', p).group(1))):
    txt = open(f, errors='replace').read().splitlines()
    call = re.sub(r'^just-\d+-|\.log$', '', os.path.basename(f))
    end = next((r[1] for r in rows if len(r) >= 8 and r[4] == '0' and r[5] == 'just' and r[7].split()[:1] == [call]), None)
    recs, cur = [], None
    for l in txt:
        mm = re.match(r'^===> running recipe `([^`]+)`', l)
        if mm: cur = [mm.group(1), None]; recs.append(cur); continue
        ts = re.match(r'^\[(\d\d:\d\d:\d\d)\]', l)
        if ts and cur is not None and cur[1] is None: cur[1] = ts.group(1)
    recs = [r for r in recs if r[1]]
    print(f'\n## Recipes inside `just {call}` ({len(recs)} with commands)\n')
    print('| recipe | start | duration |\n|---|---|---|')
    out = []
    for i, (name, st) in enumerate(recs):
        nx = recs[i + 1][1] if i + 1 < len(recs) else end
        out.append((name, st, secs(st, nx) if nx else None))
    for name, st, du in sorted(out, key=lambda x: -(x[2] or 0)):
        print(f'| {name} | {st} | {fmt(du) if du is not None else "?"} |')
    mg = [l.strip() for l in txt if 'MERGE GATE' in l]
    wt = [l.strip() for l in txt if 'WAITING' in l]
    if mg: print('\nSelector lines:\n' + '\n'.join(f'- `{l[:200]}`' for l in mg))
    if wt: print(f'\ne2e-lock waits: {len(wt)} line(s); first: `{wt[0][:200]}`')
