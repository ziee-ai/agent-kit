#!/usr/bin/env node
// Surface cheap deterministic findings AT EDIT TIME, in the agent's own loop.
//
// WHY THIS EXISTS — the strongest effect in the guardrail research, and it is
// about placement, not rigor. Facebook deployed the SAME static analysis with the
// SAME false-positive rate two ways: as a nightly batch with issues assigned to
// developers ("almost none of them were acted on" — ~0% fix rate), and surfaced at
// diff time during review of the change (>70% fix rate). Same analysis, same FPs,
// 70-point swing. (Distefano, Fähndrich, Logozzo & O'Hearn, CACM 62(8), 2019.)
//
// Our equivalent of "nightly batch" is phase 6/8: a lint violation written now is
// reported hours later, often to a DIFFERENT agent, after the code is committed —
// where fixing it costs a gate iteration. Reported here, the agent that wrote the
// line fixes it in the same breath, and no human is ever involved. This REDUCES
// human input; it does not add any.
//
// Design constraints (all four are load-bearing — do not relax one for coverage):
//   • FAST — file-scoped, and every scanner runs CONCURRENTLY, so wall time is the
//     slowest single scanner, not their sum. Never the 33s full `npm run check`.
//   • FAIL-OPEN — a broken linter must never block an edit. Any error exits 0
//     silently. This hook is an accelerator, not a gate; phase 8 remains the gate.
//   • QUIET ON SUCCESS — output only when there is something to fix, so it does
//     not become noise the agent learns to skip.
//   • FILE-SCOPED — only lines naming the edited file are reported. A neighbour's
//     pre-existing violation is not this edit's problem, and reporting it is the
//     fastest way to teach an agent to ignore the hook.
//
// LATENCY BUDGET — measured, not assumed. All numbers are wall-clock, warm, on a
// real worktree, scanner pointed at ONE edited file's directory.
//
//   ADMITTED                                    REJECTED
//   store-actions --check         31 ms         check:design-spec           164 ms
//   rustfmt --check (Rust arm)    29-  55 ms    check:gallery-seed-reg      170 ms
//   biome lint (single file)     103- 171 ms    check:gallery-coverage      213 ms
//   settings-field               207- 212 ms    check:testid-registry       282 ms
//   tooltip-placement            211- 221 ms    check:gallery-crawl         298 ms
//   lint-icon-action                  225 ms    check:override-registry     301 ms
//   lint-native-scroll           225- 229 ms    gallery:check-fixtures      306 ms
//   hardcoded-colors             226- 250 ms    check:overlay-registry      368 ms
//   adjacent-inline              229- 256 ms    lint-hooks             1617-1775 ms
//   logical-direction (existing)1272-1399 ms    check:kit-manifest         2041 ms
//                                               check:state-matrix         2678 ms
//
// TWO cut criteria, and the second rejects more than the first:
//   1. ≤ 500 ms per newly-added scanner.
//   2. FILE-SCOPED — the scanner must be able to produce a finding that NAMES the
//      edited file. Every `check:*` above fails this even when it is fast: they
//      compare a GENERATED artifact (testIds.generated.ts, DESIGN_SYSTEM.md, a
//      gallery registry) against the tree and report drift in THAT file. Nothing
//      they emit can survive the file-scoped filter, so admitting them would cost
//      latency for structurally-unreportable findings. They stay in phase 8.
//   `lint-hooks` fails criterion 1 outright: it rebuilds a global ~300-proxy /
//   ~1800-action store-proxy registry on every invocation regardless of --root, so
//   --root buys nothing.
//
// `logical-direction` sits above the 500 ms line but is pre-existing and
// inherently branch-scoped (it shells out to `git diff` over the whole branch), so
// it sets the wall-clock tail. Concurrency is what pays for the additions:
//
//   before: 4 scanners, sequential  →  1893-1954 ms   (measured, cwd = repo root)
//   after:  9 scanners, concurrent  →  1298-1524 ms
//   the 6 non-git scanners as one concurrent batch: 261 ms
//
// i.e. 2.25x the scanner coverage for ~32% LESS wall time. Anything newly admitted
// fits inside the logical-direction tail and is therefore free.
//
// Wire as a PostToolUse hook on Write|Edit. Reads the hook JSON on stdin.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync as fsReadFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const OUT = (context) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }));
  process.exit(0);
};
const QUIET = () => process.exit(0);

// A whole-hook watchdog on top of the per-scanner timeouts: whatever happens, the
// agent's edit loop is never held longer than this.
const OVERALL_MS = 12000;
const PER_CHECK_MS = 8000;

let raw = '';
try { raw = readAllStdin(); } catch { QUIET(); }
function readAllStdin() {
  try { return fsReadFileSync(0, 'utf8'); } catch { return ''; }
}

let file = null;
try {
  const j = JSON.parse(raw || '{}');
  file = j?.tool_response?.filePath || j?.tool_input?.file_path || null;
} catch { QUIET(); }
if (!file) QUIET();

if (/[\\/](node_modules|dist|\.vite|target)[\\/]/.test(file)) QUIET();
const ext = extname(file);
if (!['.ts', '.tsx', '.rs'].includes(ext)) QUIET();

const abs = resolve(file);
if (!existsSync(abs)) QUIET();
const targetDir = dirname(abs);
try { if (!statSync(targetDir).isDirectory()) QUIET(); } catch { QUIET(); }

// ---------------------------------------------------------------------------
// concurrent runner — every scanner is an independent process; wall time is the
// slowest one, not the sum.
// ---------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    let done = false;
    const finish = (rc, out) => { if (!done) { done = true; res({ rc, out }); } };
    try {
      const child = execFile(cmd, args, {
        encoding: 'utf8', timeout: PER_CHECK_MS, maxBuffer: 8 * 1024 * 1024, ...opts,
      }, (err, stdout, stderr) => finish(err ? (err.code ?? 1) : 0, `${stdout || ''}${stderr || ''}`));
      child.on('error', () => finish(0, '')); // fail-open: a missing binary is not a finding
    } catch { finish(0, ''); }
  });
}

/** Keep only output lines that name the edited file — the FILE-SCOPED rule. */
const mineOnly = (out) => out
  .split('\n')
  .filter((l) => l.includes(abs) || l.includes(file) || l.includes(basename(file)));

const findings = [];
const push = (hint, lines) => {
  // Dedupe: some scanners are given overlapping --root dirs (a store folder is
  // reachable from both the edited file's dir and its parent), so the same
  // violation can be printed twice.
  const uniq = [...new Set(lines.map((l) => l.trim()))].filter(Boolean);
  if (uniq.length) findings.push(`• ${hint}\n${uniq.slice(0, 6).map((l) => `    ${l}`).join('\n')}`);
};

// ---------------------------------------------------------------------------
// helpers shared by both arms
// ---------------------------------------------------------------------------
function walkUpFor(from, rel) {
  let d = from;
  for (let hops = 0; hops < 24; hops++) {
    const c = join(d, rel);
    if (existsSync(c)) return c;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
function gitSync(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch { return null; }
}

// ===========================================================================
// TypeScript / TSX arm
// ===========================================================================
async function tsArm() {
  // Locate the workspace root (the dir with package.json) by walking up.
  let wsRoot = targetDir;
  while (wsRoot !== dirname(wsRoot) && !existsSync(join(wsRoot, 'package.json'))) wsRoot = dirname(wsRoot);
  if (!existsSync(join(wsRoot, 'package.json'))) return;

  // The shared design linters live in the sdk submodule. An UNINITIALISED
  // submodule is an empty dir that still passes existsSync, so probe for the
  // lint dir itself, not its parent — and degrade silently rather than reporting
  // a phantom failure. (staleness-check.mjs S1 is what turns that condition into
  // an explicit, diagnosed finding; here it is only a reason to stay quiet.)
  const lintDir = [
    resolve(wsRoot, '..', '..', 'sdk', 'packages', 'config', 'src', 'lint'),
    walkUpFor(wsRoot, join('sdk', 'packages', 'config', 'src', 'lint')),
  ].find((p) => p && existsSync(p)) || null;

  // App-local scanners live next to the workspace, in <wsRoot>/scripts.
  const scriptsDir = existsSync(join(wsRoot, 'scripts')) ? join(wsRoot, 'scripts') : null;

  const jobs = [];

  // --- shared design linters (sdk), pointed at the edited file's DIRECTORY ---
  // `advisory: true` = the scanner reports and exits 0 by design (it guards a
  // rule with a live backlog). We pass its `--gate` flag AND read its output
  // regardless of exit code, so an advisory rule still reaches the agent that is
  // adding a NEW violation — without depending on the flag being honoured. The
  // FILE-SCOPED filter is what keeps the backlog out: only lines naming the file
  // just edited survive.
  const SDK_CHECKS = [
    ['hardcoded-colors.mjs', 'hardcoded color — use a semantic token', [`--root=${targetDir}`], false],
    ['logical-direction.mjs', 'physical direction property — use ps/pe, ms/me, start/end', [`--root=${targetDir}`], false],
    ['settings-field.mjs', 'settings/form layout — compose Field, not raw flex-gap', [`--root=${targetDir}`], false],
    ['adjacent-inline.mjs', 'adjacent inline elements with no gap utility', [`--root=${targetDir}`], false],
    ['tooltip-placement.mjs', 'tooltip side differs among peer buttons in one group', [`--root=${targetDir}`, '--gate'], true],
    // --check is mandatory: without it this scanner GENERATES actions.gen.ts.
    // A hook must never mutate the tree behind the agent's back.
    ['store-actions.mjs', 'store folder convention (state.ts + index.ts + glob-registered actions/)',
      [`--root=${targetDir}`, `--root=${dirname(targetDir)}`, '--check'], false],
  ];
  // --- app-local scanners (<wsRoot>/scripts) ---
  const APP_CHECKS = [
    ['lint-icon-action.mjs', 'icon-bearing control uses a non-conventional action glyph', [`--root=${targetDir}`], false],
    ['lint-native-scroll.mjs', 'raw native-scroll site — use the kit scroll primitive', [`--root=${targetDir}`, '--gate'], true],
  ];

  for (const [dir, list] of [[lintDir, SDK_CHECKS], [scriptsDir, APP_CHECKS]]) {
    if (!dir) continue;
    for (const [script, hint, args, advisory] of list) {
      const p = join(dir, script);
      if (!existsSync(p)) continue;
      jobs.push(run(process.execPath, [p, ...args], { cwd: wsRoot }).then(({ rc, out }) => {
        if (rc !== 0 || advisory) push(hint, mineOnly(out));
      }));
    }
  }

  // --- biome, on the SINGLE edited file ---
  // Invoked through the resolved binary rather than `npx`, which costs ~300ms of
  // pure resolution overhead for a check biome itself completes in <25ms.
  const biome = walkUpFor(wsRoot, join('node_modules', '.bin', 'biome'))
    || walkUpFor(wsRoot, join('node_modules', '.bin', 'biome.cmd'));
  if (biome) {
    jobs.push(run(biome, ['lint', '--colors=off', '--max-diagnostics=20', abs], { cwd: wsRoot })
      .then(({ rc, out }) => {
        if (rc !== 0) push('biome lint (repo rule set, incl. the noRestrictedImports guardrail)', mineOnly(out));
      }));
  }

  await Promise.all(jobs);
}

// ===========================================================================
// Rust arm
// ===========================================================================
// WHAT IS ACTUALLY FAST ENOUGH IN RUST — measured on this repo:
//   • `cargo check`/`cargo clippy` on the server crate: minutes. Not a candidate.
//   • `clippy-driver` on ONE file in isolation: 49-169 ms, but it cannot resolve a
//     crate module's imports (`use crate::…`, `use serde_json::…`) — a real module
//     produced 9 hard `unresolved import` errors and zero usable lints. Not viable
//     per-file without the crate's dependency graph, i.e. without cargo.
//   • `rustfmt --check` on ONE file: 29-55 ms warm, no cargo, no target dir, no
//     lock contention with a concurrent build. This is the whole Rust arm.
//
// AND IT MUST BE DIFF-SCOPED. 84 of a 120-file sample of this repo's server
// sources already fail `rustfmt --check` at HEAD. Reporting those on every edit
// would be ~70% noise on lines the agent never touched — precisely the training
// signal that makes an agent ignore a hook. So rustfmt hunks are intersected with
// the lines this working tree actually changed vs HEAD; an untracked (brand-new)
// file has no baseline, so all of its hunks are reported.
function editionFor(startDir) {
  let d = startDir;
  for (let hops = 0; hops < 24; hops++) {
    const c = join(d, 'Cargo.toml');
    if (existsSync(c)) {
      try {
        const m = fsReadFileSync(c, 'utf8').match(/^\s*edition\s*=\s*"(\d{4})"/m);
        if (m) return m[1];
      } catch { /* fall through */ }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return '2021';
}

/** Line ranges changed in the working tree vs HEAD; null = no baseline (report all). */
function changedRanges() {
  const top = gitSync(['rev-parse', '--show-toplevel'], targetDir);
  if (!top) return null;
  const repo = top.trim();
  if (gitSync(['ls-files', '--error-unmatch', '--', abs], repo) === null) return null; // untracked
  const diff = gitSync(['diff', '-U0', 'HEAD', '--', abs], repo);
  if (diff === null) return null;
  const ranges = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges; // [] = tracked and identical to HEAD ⇒ nothing this edit owns
}

/** Parse `rustfmt --check` output into hunks with their span in the ORIGINAL file. */
function rustfmtHunks(out) {
  const hunks = [];
  const lines = out.split('\n');
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^Diff in (.+):(\d+):$/);
    if (m) {
      if (cur) hunks.push(cur);
      cur = { file: m[1], start: Number(m[2]), origLines: 0, body: [] };
      continue;
    }
    if (!cur) continue;
    if (!l.startsWith('+')) cur.origLines++; // context and '-' lines exist in the original
    cur.body.push(l);
  }
  if (cur) hunks.push(cur);
  return hunks.map((h) => ({ ...h, end: h.start + Math.max(h.origLines - 1, 0) }));
}

async function rustArm() {
  const edition = editionFor(targetDir);
  const { rc, out } = await run('rustfmt', ['--check', '--color=never', '--edition', edition, abs]);
  if (rc === 0 || !out.trim()) return;

  const hunks = rustfmtHunks(out).filter((h) => resolve(h.file) === abs);
  if (!hunks.length) return;

  const ranges = changedRanges();
  const relevant = ranges === null
    ? hunks
    : hunks.filter((h) => ranges.some(([a, b]) => h.start <= b && h.end >= a));
  if (!relevant.length) return;

  const detail = relevant.slice(0, 3).map((h) => {
    const preview = h.body.filter((l) => l.startsWith('-') || l.startsWith('+')).slice(0, 4);
    return `    ${basename(file)}:${h.start}\n${preview.map((l) => `      ${l}`).join('\n')}`;
  }).join('\n');
  findings.push(`• rustfmt: the lines you touched are not formatted (edition ${edition}) — run \`rustfmt ${file}\`\n${detail}`);
}

// ---------------------------------------------------------------------------
// main — fail-open around everything.
// ---------------------------------------------------------------------------
const watchdog = new Promise((res) => setTimeout(res, OVERALL_MS).unref?.());
try {
  await Promise.race([ext === '.rs' ? rustArm() : tsArm(), watchdog]);
} catch { QUIET(); }

if (!findings.length) QUIET();
OUT(`Lint findings in the file you just edited (${file}) — fix them now, while the change is in front of you. These are the same checks phase 8 runs; catching them here costs well under a second instead of a gate iteration.\n\n${findings.join('\n')}`);
