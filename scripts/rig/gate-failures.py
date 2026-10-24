#!/usr/bin/env python3
"""gate-failures.py <gate.log> <timing-dir> — turn a FAILED merge-gate run into the exact list of things to re-run, one at a time
(gate v2: re-run the failures to tell flakes from real reds; after a fix, re-run ONLY the failed — never the full suite twice).

Writes <timing-dir>/FAILURES.json:
  structural: gate stages that are not re-runnable tests (migrations, regen, stale, merge, lifecycle strip...) — always real
  items:      [{kind, id, cwd, cmd}] each re-runnable alone in a worktree at the gated sha (cwd relative to the repo root)
  unparsed:   failed steps whose individual failures could not be named (e.g. a compile error) — real, needs a human
Sources: the gate verdict lines, the rig-timing shim's captured `just` outputs (just-*.log), run-steps reports (*.json) and the
test selector's group logs (<timing-dir>/test-affected/*.log).
Parsers: cargo test (libtest), cargo nextest, playwright, vitest, node:test (`✖ <name>` / `not ok` — named per test, re-run by
file + `--test-name-pattern`). A FAILED test step (a run-steps report row matching RIG_TEST_STEP_RX) is NEVER silently dropped
because another step's failures parsed: its own output segment (the run-steps frame lines) must contribute >= 1 item, else the
step lands in `unparsed` (measured 2026-10-24: node:test's `✖` lines were not parsed, so a red `npm run test` step vanished
behind a parsed cargo failure). A test step's real cmd/cwd come from its report row.

Config (env; every default is generic — see README.md):
  RIG_CARGO_PKG          cargo package for re-run commands (`-p <pkg>`; nextest lines carry their own) — default: none
  RIG_CARGO_CWD          repo-relative dir cargo runs in — default '.'
  RIG_CARGO_CHECK_CMD    re-run command for a failed C1 cargo-check stage — default 'cargo check [-p pkg] --all-targets'
  RIG_UI_CWD             repo-relative dir the JS test runners run in — default '.'
  RIG_E2E_CMD            playwright re-run, {spec} = `path -g '<describe path + title>$'` (or path:line when the report line
                         carries no title) — default 'npx playwright test {spec} --workers=1'
  RIG_VITEST_CMD         vitest re-run, {file} — default 'npx vitest run {file}'
  RIG_NODE_TEST_CMD      node:test re-run, {file} relative to its cwd — default 'node --test {file}'
  RIG_UI_NODE_TEST_CMD   node:test re-run for files under $RIG_UI_CWD/src/ — default: RIG_NODE_TEST_CMD
                         ({name} = the `--test-name-pattern=<regex-escaped title>` argument, one shell word; without it the
                         pattern is injected right before {file} — node stops parsing test-runner options at the first file)
  RIG_TEST_STEP_RX       a run-steps step matching this is a TEST TIER (named individually, never re-run whole) — default below
  RIG_WRAPPER_STEPS      'cmd=report;cmd=report' — a wrapper step skipped when <report>.json exists (its inner steps are listed)
  RIG_STAGING_RX         regex of staging prefixes to strip from paths (overrides the derived one)
  RIG_STAGING_DIRS       ':'-separated dirs whose direct children are staging/worktree trees (stripped with the child)
  RIG_GATED_SHA, RIG_SRC_REPO   planted-compile-error filter (see the end of this file)
Staging prefixes stripped by default: $RIG_WORKTREE, $RIG_REPO, children of $RIG_STAGING_DIRS, and any `.merge-gate-*` dir (the
kit merge-gate's staging trees)."""
import sys, os, re, json, glob, subprocess, shlex

mg, td = sys.argv[1], sys.argv[2]
E = os.environ.get
CARGO_PKG = E('RIG_CARGO_PKG', '')
CARGO_CWD = E('RIG_CARGO_CWD', '.') or '.'
UI_CWD = E('RIG_UI_CWD', '.') or '.'
E2E_CMD = E('RIG_E2E_CMD', 'npx playwright test {spec} --workers=1')
VITEST_CMD = E('RIG_VITEST_CMD', 'npx vitest run {file}')
NODE_CMD = E('RIG_NODE_TEST_CMD', 'node --test {file}')
UI_NODE_CMD = E('RIG_UI_NODE_TEST_CMD', NODE_CMD)
PKG = f' -p {CARGO_PKG}' if CARGO_PKG else ''
CARGO_CHECK = E('RIG_CARGO_CHECK_CMD', f'cargo check{PKG} --all-targets')

def _staging_rx():
    if E('RIG_STAGING_RX'): return re.compile(E('RIG_STAGING_RX'))
    alts = []
    # longest first: the rig's own worktree must be stripped WHOLE, before a parent dir's generic form leaves half of it behind
    for p in sorted({p.rstrip('/') for p in (E('RIG_WORKTREE'), E('RIG_REPO')) if p}, key=len, reverse=True):
        alts.append(re.escape(p))
    for d in [d.rstrip('/') for d in E('RIG_STAGING_DIRS', '').split(':') if d]:
        alts.append(re.escape(d) + r'/[^/\s]+')
    alts.append(r'(?<![^\s\'"(=])/(?:[^\s\'"]*/)?\.merge-gate-[^/\s]+')
    return re.compile('(' + '|'.join(alts) + ')/')
STAGE_RX = _staging_rx()
def rel(p): return STAGE_RX.sub('', p)
def under(p, d): return d == '.' or p.startswith(d.rstrip('/') + '/')
def from_cwd(p, d): return p if d == '.' else p[len(d.rstrip('/')) + 1:]

out = {'structural': [], 'items': [], 'unparsed': []}
seen = set()
def add(kind, id_, cwd, cmd):
    if (kind, id_) in seen: return
    seen.add((kind, id_)); out['items'].append({'kind': kind, 'id': id_, 'cwd': cwd, 'cmd': cmd})

verdict = open(mg, errors='replace').read()
failed_stages = re.findall(r'^\s+✗\s+(\S+)\s+(\S+)\s+FAIL — (.*)$', verdict, re.M)
for sid, name, detail in failed_stages:
    if sid in ('C7', 'C9'): continue
    if sid == 'C1': add('cargo-check', 'C1 cargo check', CARGO_CWD, CARGO_CHECK); continue
    out['structural'].append(f'{sid} {name}: {detail[:300]}')

texts = []
for f in glob.glob(os.path.join(td, 'just-*.log')) + glob.glob(os.path.join(td, 'test-affected', '*.log')):
    texts.append(open(f, errors='replace').read())

# ---- node:test named failures ----
# default/spec reporter summary: `test at <file>:<line>:<col>` (blank lines allowed) then `✖ <name> (…ms)` — the name comes out
# exact and re-runnable (`--test-name-pattern`); the TAP reporter: `not ok <n> - <name>` then `  location: '<file>:<line>'`
# in the same YAML block. Both name the SAME run's failures in different framing.
TEST_AT_RX = re.compile(r'^\s*test at\s+(\S+?):\d+:\d+\s*$')
NODE_FAIL_RX = re.compile(r'^\s*✖\s+(.+) \(\d+(?:\.\d+)?ms\)\s*$')
NOT_OK_RX = re.compile(r'^\s*not ok\s+\d+\s*-\s*(.+?)\s*$')
NODE_LOC_RX = re.compile(r"^\s+location: '([^']+\.(?:[cm]?[jt]sx?|mjs|cjs))(?::\d+:\d+)?'")
NODE_FILE_RX = re.compile(r'\.(?:test|spec|check)\.(?:[cm]?[jt]sx?|mjs|cjs)$')

def parse_nodes(txt):
    """(file, name) pairs of a node:test run's failures, both reporter shapes, plus every `location:` file seen (the whole-file
    fallback for a failure the run never NAMED — the older `location:`-only form)."""
    lines = txt.splitlines()
    pairs, locs = [], []
    for i, line in enumerate(lines):
        m = TEST_AT_RX.match(line)
        if not m: continue
        for j in range(i + 1, min(len(lines), i + 4)):
            if not lines[j].strip(): continue
            n = NODE_FAIL_RX.match(lines[j].strip())
            if n: pairs.append((m.group(1), n.group(1)))
            break
    for i, line in enumerate(lines):
        m = NOT_OK_RX.match(line)
        if not m: continue
        for j in range(i + 1, min(len(lines), i + 12)):
            if lines[j].strip() == '...': break
            lm = NODE_LOC_RX.match(lines[j])
            if lm:
                pairs.append((lm.group(1), m.group(1))); locs.append(lm.group(1)); break
    for line in lines:
        lm = NODE_LOC_RX.match(line)
        if lm: locs.append(lm.group(1))
    return pairs, locs

def name_arg(name):
    """`--test-name-pattern=…` as ONE shell word: the name regex-escaped (node matches it as a RegExp) and shell-quoted."""
    return '--test-name-pattern=' + shlex.quote(re.escape(name))
def tmpl_cmd(tmpl, file, name):
    """a re-run from a RIG_*_CMD template. With {name} the pattern substitutes it; without, the pattern is injected right before
    {file} — node stops parsing test-runner options at the FIRST positional file (an option after a file does not filter)."""
    if name is None: return tmpl.replace('{file}', file)
    pat = name_arg(name)
    if '{name}' in tmpl: return tmpl.replace('{file}', file).replace('{name}', pat)
    return tmpl.replace('{file}', f'{pat} {file}')
def node_target(p):
    """(file, cwd) for a node:test path as the runner printed it. RIG_UI_CWD declares the JS runners' cwd and a runner prints its
    file arguments as it received them (relative to its own cwd), so `plugins/x.test.ts` belongs under that cwd (same contract as
    the vitest parser); a fully-qualified/staging path is stripped first."""
    p = rel(p)
    if UI_CWD == '.': return p, '.'
    if under(p, UI_CWD): return from_cwd(p, UI_CWD), UI_CWD
    return p, UI_CWD
def node_tmpl(p):
    """the RIG_*_CMD template for a UI-relative node:test path (the src/ rule, as before)."""
    if UI_CWD != '.': return UI_NODE_CMD if under(p, UI_CWD + '/src') else NODE_CMD
    return UI_NODE_CMD if under(p, 'src') else NODE_CMD
def step_node_cwd_cmd(p, name, step):
    """(cwd, cmd) for a node:test failure inside a run-steps step: the step's OWN command (its flags are load-bearing — TS
    loaders, strip-types, concurrency), the file list cut to the failing file, --test-name-pattern before the first file; cwd =
    the step's cwd (repo-relative). Without a node command in the report row the templates are the fallback."""
    cwd = rel((step.get('cwd') or '.') + '/').rstrip('/') or '.'
    toks = []
    try: toks = shlex.split(step.get('cmd', ''))
    except Exception: pass
    first = next((i for i, t in enumerate(toks) if NODE_FILE_RX.search(t)), None)
    if first is None: return cwd, tmpl_cmd(node_tmpl(p), p, name)
    flags = ' '.join(shlex.quote(t) for t in toks[:first])
    if name is None: return cwd, f'{flags} {shlex.quote(p)}'
    return cwd, f'{flags} {name_arg(name)} {shlex.quote(p)}'

def parse_tests(txt, step=None):
    found = 0
    binary = 'lib'
    pairs, locs = parse_nodes(txt)
    named = {node_target(f)[0] for f, _ in pairs}
    for line in txt.splitlines():
        # cargo test (libtest): the binary comes from the preceding "Running" line
        m = re.match(r'^\s+Running (unittests src/lib\.rs|tests/(\S+)\.rs)', line)
        if m: binary = 'lib' if m.group(1).startswith('unittests') else m.group(2); continue
        m = re.match(r'^test (\S+) \.\.\. FAILED', line)
        if m:
            sel = '--lib' if binary == 'lib' else f'--test {binary}'
            add('rust', m.group(1), CARGO_CWD, f'cargo test{PKG} {sel} -- --exact {m.group(1)} --test-threads=1'); found += 1; continue
        # cargo nextest: "FAIL [ 1.2s] (3/9) <crate>[::<binary>] <test>"
        # nextest final result: "FAIL [..] (n/N)" or, with --retries, "TRY 3 FAIL [..] ( 505/1993)". An intermediate retry shows
        # "(─────────)" and is not a result. Measured: three "TRY 3 FAIL"s went unnamed and the run read as all-flakes.
        m = re.match(r'^\s+(?:TRY \d+ )?(?:FAIL|SIGSEGV|SIGABRT|TIMEOUT) \[[^\]]*\]\s+(?:\(\s*\d+/\d+\)\s+)?([A-Za-z0-9_-]+)(?:::(\S+))?\s+(\S+)$', line)
        if m:
            sel = '--lib' if not m.group(2) else f'--test {m.group(2)}'
            add('rust', m.group(3), CARGO_CWD, f'cargo test -p {m.group(1)} {sel} -- --exact {m.group(3)} --test-threads=1'); found += 1; continue
        # playwright: "  1) [chromium] › tests/e2e/x.spec.ts:12:3 › title"
        m = re.match(r'^\s+\d+\) \[[\w-]+\] › (\S+?\.spec\.[cm]?[jt]sx?):(\d+):\d+ › ?(.*?)\s*$', line)
        if m:
            spec = from_cwd(rel(m.group(1)), UI_CWD) if under(rel(m.group(1)), UI_CWD) else rel(m.group(1))
            # Re-run by FILE + exact TITLE, not file:line: a fix that adds a line above the test (an import) shifts it, and the
            # recheck's `file:line` then lists NO test. -g matches the describe path + title joined by spaces; escaped and
            # end-anchored it selects that test only (and only the failed case of a parameterised one). The id stays file:line.
            title = ' '.join(x.strip() for x in m.group(3).split(' › ') if x.strip())
            title = re.sub(r'\s+\(\d+(?:\.\d+)?m?s\)$', '', title)
            tgt = f'{spec} -g {shlex.quote(re.escape(title) + "$")}' if title else f'{spec}:{m.group(2)}'
            add('e2e', f'{rel(m.group(1))}:{m.group(2)}', UI_CWD, E2E_CMD.replace('{spec}', tgt)); found += 1; continue
        # vitest: " FAIL  src/x.test.tsx > suite > name"
        m = re.match(r'^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b', line)
        if m:
            f = rel(m.group(1))
            add('vitest', f, UI_CWD, VITEST_CMD.replace('{file}', f)); found += 1; continue
    # named node:test failures — each gets its own re-runnable item (file + exact test name).
    for f, name in pairs:
        p, cwd0 = node_target(f)
        if step:
            cwd, cmd = step_node_cwd_cmd(p, name, step)
        else:
            cwd, cmd = cwd0, tmpl_cmd(node_tmpl(p), p, name)
        add('node', f'{p}:{name}', cwd, cmd); found += 1
    # a node:test file whose failures the run never NAMED (no `test at`/`not ok` pairing here) still yields ONE item, the whole
    # file — never silently dropped.
    for f in locs:
        p = node_target(f)[0]
        if p in named: continue
        if step:
            cwd, cmd = step_node_cwd_cmd(p, None, step)
        else:
            cwd, cmd = node_target(f)[1], tmpl_cmd(node_tmpl(p), p, None)
        add('node', p, cwd, cmd); found += 1
    return found

# ---- failed run-steps steps (C7 legs, C9 halves) — PER-STEP accounting ----
# A wrapper step whose inner steps have their own report is skipped; a FAILED test step must contribute >= 1 named item from its
# own output segment — a red test step is NEVER dropped just because another step's failures parsed. The step's real cmd/cwd
# come from its report row.
reports = {}
for f in glob.glob(os.path.join(td, '*.json')):
    if f.endswith('FAILURES.json'): continue
    try:
        rep = json.load(open(f))
    except Exception:
        continue
    if isinstance(rep, dict) and isinstance(rep.get('results'), list): reports[os.path.basename(f)[:-5]] = rep
WRAPPERS = dict(kv.split('=', 1) for kv in E('RIG_WRAPPER_STEPS', '').split(';') if '=' in kv)
TEST_STEP = re.compile(E('RIG_TEST_STEP_RX', r'test-affected|test-smoke|test-unit|test-integration|vitest run|playwright test|'
                         r'cargo (?:test|nextest)|node --test|npm (?:run )?test|^just test$'))
FRAME_RX = re.compile(r'^=== run-steps (\S+) \[(\d+)/(\d+)\] (START|PASS|FAIL)')
def step_text(name, idx):
    """a step's output segment: the run-steps lines between its `[i/N] START` frame and the next frame."""
    for t in texts:
        lines = t.splitlines()
        start = None
        for i, line in enumerate(lines):
            m = FRAME_RX.match(line)
            if not m: continue
            if start is not None:
                if m.group(1) == name and int(m.group(2)) == idx and m.group(4) in ('PASS', 'FAIL'):
                    return '\n'.join(lines[start:i])
                start = None   # a different frame closed our candidate segment without a verdict
            if m.group(4) == 'START' and m.group(1) == name and int(m.group(2)) == idx:
                start = i + 1
    return None
for name, rep in reports.items():
    for n, r in enumerate(rep.get('results', []), 1):
        if r.get('rc') == 0: continue
        if r['cmd'] in WRAPPERS and WRAPPERS[r['cmd']] in reports: continue
        if TEST_STEP.search(r['cmd']):
            idx = r.get('step') or n
            seg = step_text(name, idx)
            c = parse_tests(seg, r) if seg is not None else 0
            if c == 0:
                out['unparsed'].append(f'{name} step {idx}: {r["cmd"]} (rc={r["rc"]}) — failed, but no individual failure could be named')
            continue
        add('step', f'{name}: {r["cmd"]}', rel(r.get('cwd', '.') + '/').rstrip('/') or '.', r['cmd'])

# the remaining texts (just-*/test-affected logs with no matching report — or failures already named in a step's segment,
# deduplicated by (kind, id))
for t in texts:
    parse_tests(t)

# the C7/C9 verdict failed but nothing at all was collected (an old non-keep-going command, or output not captured)
for sid in ('C7', 'C9'):
    if any(s == sid for s, _, _ in failed_stages) and not out['items'] and not out['unparsed']:
        out['unparsed'].append(f'{sid} failed but no individual failure could be collected')
# A compile error is real only if it is in the COMMITTED code. Mutation batteries plant code (e.g. `let mutation_probe_unused = 42;`)
# and compile it on purpose; the timing shim captures those runs too (measured: a planted probe was recorded as "a Rust compile
# error"). With RIG_GATED_SHA set, an error whose every shown source line differs from the gated tree's line is planted and ignored;
# without it (or when no location can be read) every compile error counts. RIG_SRC_REPO = the repo to `git show` from.
ERR_LOC = re.compile(r'^error(?:\[E\d+\])?: (?!could not compile).*\n\s*--> (\S+?):(\d+):\d+\n\s*\|\n\s*\d+\s*\|(.*)$', re.M)
def committed_line(path, n):
    sha = E('RIG_GATED_SHA')
    path = rel(path)
    for cand in dict.fromkeys((path, os.path.normpath(os.path.join(CARGO_CWD, path)))):
        try:
            txt = subprocess.run(['git', 'show', f'{sha}:{cand}'], capture_output=True, text=True, cwd=E('RIG_SRC_REPO', '.')).stdout
        except Exception: txt = ''
        if txt:
            lines = txt.split('\n'); return lines[n - 1] if 0 < n <= len(lines) else None
    return None
def genuine_compile_error(t):
    if not re.search(r'^error(\[E\d+\])?: could not compile', t, re.M): return False
    if not E('RIG_GATED_SHA'): return True
    locs = ERR_LOC.findall(t)
    if not locs: return True
    return any((committed_line(p, int(n)) or '').strip() == code.strip() for p, n, code in locs)
for t in texts:
    if genuine_compile_error(t): out['unparsed'].append('a Rust compile error (could not compile)'); break

json.dump(out, open(os.path.join(td, 'FAILURES.json'), 'w'), indent=2)
print(f"structural={len(out['structural'])} items={len(out['items'])} unparsed={len(out['unparsed'])}")
for s in out['structural']: print('  STRUCTURAL', s[:160])
for i in out['items']: print('  ITEM', i['kind'], i['id'][:140])
for u in out['unparsed']: print('  UNPARSED', u[:160])
