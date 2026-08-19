#!/usr/bin/env node
// lifecycle-check.mjs — deterministic (no-LLM) gate for the feature-lifecycle
// state machine. Validates the completeness of each phase's artifacts under
// .lifecycle/<feature>/ and reconciles the git diff against the audit ledger.
//
// Usage:
//   node lifecycle-check.mjs --phase <1-8> [--dir <feature-dir>] [--base <ref>]
//   node lifecycle-check.mjs --all       [--dir <feature-dir>] [--base <ref>]
//
// Exit code 0 = phase(s) complete. Non-zero = incomplete, with a precise gap
// list on stderr. Agents may NOT advance to phase N+1 until `--phase N` is 0.
// The pre-push hook runs `--all`.
//
// No external dependencies: pure Node + `git` via child_process.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function opt(name, def = undefined) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const wantAll = args.includes('--all');
// `--wip` — the MID-ROUND push gate. Same nine phases as `--all`, but the phase the branch
// is CURRENTLY WORKING may be in progress. See `runAll` for the frontier rule and why this
// is a separate flag rather than a loosening of `--all`.
const wantWip = args.includes('--wip');
const phaseArg = opt('--phase');
const baseArg = opt('--base'); // resolved after repo is known (default: origin/main if it exists)
let dirArg = opt('--dir');
let repoArg = opt('--repo');
// `--scope <name>` — evaluate only THIS owner's scoped artifacts (plus the UNSCOPED ones,
// which belong to everybody), ignoring other owners'.
//
// WHY. Requiring EVERY matching artifact to converge was right for one owner and wrong for
// three: with concurrent stages sharing one `.lifecycle/<feature>/`, any stage's open round
// blocked every other stage's push — including stages that had not reached that phase at
// all. Observed on this feature twice: a stage-3 push refused first by `DRIFT-stage2-1.md`
// and later by `FIX_ROUND-stage1-2.md`, neither of which stage 3 may edit.
//
// The rule is that a stage gates on its OWN artifacts. Unscoped invocation is unchanged, so
// single-owner lifecycles and the pre-push hook on a finished branch behave exactly as
// before — the flag adds a narrower question, it does not weaken the default one.
//
// UNSCOPED files are deliberately KEPT in a scoped run: `DRIFT-1.md` predates the split and
// is everyone's, so an owner must still gate on it. Only OTHER owners' scopes are dropped.
const scopeArg = opt('--scope');
const SCOPE = typeof scopeArg === 'string' ? scopeArg : null;

// ---------------------------------------------------------------------------
// locate repo + feature dir
// ---------------------------------------------------------------------------
function git(cwd, ...a) {
  // 64 MiB: a regenerated openapi.json alone can produce a multi-MB positional
  // diff; the default 1 MiB maxBuffer throws ENOBUFS on real feature diffs.
  return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}
let repo;
try {
  repo = repoArg ? resolve(repoArg) : git(process.cwd(), 'rev-parse', '--show-toplevel');
} catch {
  fail(`not inside a git repository (cwd=${process.cwd()})`);
}

// ---------------------------------------------------------------------------
// app.config (the de-ziee-ify seam, shared with preflight.sh + merge-gate.mjs).
// A plain KEY=value data file at <repo>/.claude/app.config — READ, never sourced
// (a committed config a gate consumes must not be able to run arbitrary shell).
// The frontend-workspace map, the openapi-spec paths (R2-5 route registry), and
// the clean-tree noise filter (A2) are ziee-specific; each key DEFAULTS to
// ziee's historical hard-coded value, so ziee (whether it sets the key or leaves
// it unset) behaves byte-identically, while a differently-laid-out app supplies
// its own. Same parser semantics as merge-gate.mjs (trim, keep-first-on-dup).
function loadAppConfig(root) {
  const cfg = {};
  try {
    const txt = readFileSync(join(root, '.claude', 'app.config'), 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      if (!(k in cfg)) cfg[k] = line.slice(i + 1).trim();
    }
  } catch { /* no app.config → every key falls back to its ziee default */ }
  return cfg;
}
const APP = loadAppConfig(repo);
// LIFECYCLE_FRONTEND_WORKSPACES: ordered `<path-prefix>:<workspace-label>` pairs
// (space-separated). A changed file whose path starts with a prefix belongs to
// that workspace; FIRST match wins, so list the more-specific prefix first
// (desktop/ui before ui). Default = ziee's two npm workspaces.
function parseFeWorkspaces(spec) {
  return (spec || 'src-app/desktop/ui/:desktop/ui src-app/ui/:ui')
    .split(/\s+/).filter(Boolean)
    .map((pair) => {
      const c = pair.indexOf(':');
      return c === -1 ? null : { prefix: pair.slice(0, c), label: pair.slice(c + 1) };
    })
    .filter((w) => w && w.prefix && w.label);
}
const FE_WORKSPACES = parseFeWorkspaces(APP.LIFECYCLE_FRONTEND_WORKSPACES);
// LIFECYCLE_OPENAPI_SPECS: space-separated openapi.json paths that form the live
// /api route registry the R2-5 e2e route-mock gate validates against. Default =
// ziee's ui + desktop/ui specs.
const OPENAPI_SPECS = (APP.LIFECYCLE_OPENAPI_SPECS
  || 'src-app/ui/openapi/openapi.json src-app/desktop/ui/openapi/openapi.json')
  .split(/\s+/).filter(Boolean);
// LIFECYCLE_CLEAN_TREE_IGNORE: space-separated path substrings whose working-tree
// status entries the A2 clean-tree gate ignores (noisy vendored submodules etc.).
// `.log` scratch files are always ignored on top of this. Default = ziee's
// vendored pgvector submodule.
const CLEAN_TREE_IGNORE = (APP.LIFECYCLE_CLEAN_TREE_IGNORE || 'vendor/pgvector')
  .split(/\s+/).filter(Boolean);
// LIFECYCLE_LIGHT_MAX_LINES: the LIGHT-tier size threshold (added+deleted lines in
// base...HEAD, excluding lifecycle artifacts + generated files). See classifyTier.
// The default is a REVIEW-CAPACITY judgement, not a measurement: two angles
// reading one diff carefully saturate somewhere in the high hundreds of lines,
// past which "one audit round covered it" stops being credible. It is NOT a
// blast-radius judgement — that is what the four signals in classifyTier are
// for, and any one of them forces HEAVY at any size.
//
// Calibration data (all we could measure directly — 3 completed features):
// 1132, 1653 and 10923 changed lines. None qualifies at 800, so on this evidence
// LIGHT is a minority track, and the sample is biased (these features were
// selected for verification because they were interesting, not at random).
// Revisit against the full feature set; that is why it is a config key and not a
// literal.
const LIGHT_MAX_LINES = (() => {
  const n = parseInt(APP.LIFECYCLE_LIGHT_MAX_LINES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 800;
})();

let featureDir;
if (dirArg) {
  featureDir = resolve(dirArg);
} else {
  const lifecycleRoot = join(repo, '.lifecycle');
  if (!existsSync(lifecycleRoot)) fail(`no .lifecycle/ directory in ${repo}`);
  const subs = readdirSync(lifecycleRoot).filter((d) => {
    try { return statSync(join(lifecycleRoot, d)).isDirectory(); } catch { return false; }
  });
  if (subs.length === 0) fail(`.lifecycle/ contains no feature directory`);
  if (subs.length > 1) fail(`.lifecycle/ has multiple features (${subs.join(', ')}); pass --dir`);
  featureDir = join(lifecycleRoot, subs[0]);
}
if (!existsSync(featureDir)) fail(`feature dir not found: ${featureDir}`);

// Resolve the diff base. Worktrees are cut from origin/main, and a stale local
// `main` would inflate the diff with the whole upstream delta — so prefer
// origin/main when it resolves, unless an explicit --base was given.
let baseRef = typeof baseArg === 'string' ? baseArg : null;
if (!baseRef) {
  try { git(repo, 'rev-parse', '--verify', '--quiet', 'origin/main'); baseRef = 'origin/main'; }
  catch { baseRef = 'main'; }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function fail(msg) {
  process.stderr.write(`lifecycle-check: FATAL: ${msg}\n`);
  process.exit(2);
}
function read(name) {
  const p = join(featureDir, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}
function hasSection(text, ...titles) {
  // matches a markdown heading (##..######) whose text contains any title (ci)
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    const m = /^#{2,6}\s+(.*\S)\s*$/.exec(ln);
    if (!m) continue;
    const h = m[1].toLowerCase();
    for (const t of titles) if (h.includes(t.toLowerCase())) return true;
  }
  return false;
}
function glob(prefix) {
  // Returns `DRIFT-1.md` / `DRIFT-stage2-1.md` style files, sorted by numeric index
  // ascending, with the optional `<scope>-` segment captured.
  //
  // WHY THE SCOPE SEGMENT EXISTS. When a feature is split across concurrent owners they
  // need per-owner artifact files or they collide on numbering. The naming that gives them
  // that (`DRIFT-stage2-1.md`) did not match the old `^PREFIX-(\d+)\.md$` pattern **at
  // all**, so those files were invisible here — and because `phase5` read its convergence
  // count from the HIGHEST-numbered match, an unresolved drift in a scoped file left the
  // gate reading some other file and reporting OK. Observed: a `DRIFT-stage2-1.md`
  // declaring `Unresolved drifts: 1` with `--phase 5` exiting 0.
  //
  // Widening the regex alone does NOT fix that — it only makes the files visible while the
  // gate still consults one of them. The fix is in `phase5`, which now requires EVERY
  // matching file to report 0. Both halves are needed; the regex is the cheaper half.
  //
  // Numbering is NOT globally unique once scopes exist: `stage1/DRIFT-5` and
  // `stage3/DRIFT-5` are different rounds of different owners that legitimately share an
  // index. Anything reading a SEQUENCE out of these files (phase 7's decay profile) must
  // therefore group by scope first — see `globScopes`.
  return readdirSync(featureDir)
    .map((f) => {
      const m = new RegExp(`^${prefix}-(?:([a-z0-9]+)-)?(\\d+)\\.md$`).exec(f);
      return m ? { file: f, scope: m[1] ?? '', n: parseInt(m[2], 10) } : null;
    })
    .filter(Boolean)
    // `--scope` narrows to this owner's files + the shared unscoped ones. It is applied HERE,
    // at the ONE place artifacts are enumerated, so every phase inherits it and none can
    // disagree about which files it is judging — the same reason `SLICE_READERS` is one table.
    .filter((e) => SCOPE === null || e.scope === '' || e.scope === SCOPE)
    .sort((a, b) => (a.scope === b.scope ? a.n - b.n : a.scope < b.scope ? -1 : 1));
}

/** The distinct scopes present among `glob(prefix)`'s matches (`''` = unscoped). */
function globScopes(entries) {
  return [...new Set(entries.map((e) => e.scope))];
}

// ---------------------------------------------------------------------------
// parsers for the machine-readable artifact syntax
// ---------------------------------------------------------------------------
// PLAN item:   - **ITEM-3**: description
const RE_ITEM = /^-\s*\*\*(ITEM-[A-Za-z0-9._-]+)\*\*\s*:\s*(.+?)\s*$/;
// AUDIT line:  - **ITEM-3** — verdict: PASS — rationale     (dash may be - or — or :)
const RE_AUDIT = /^-\s*\*\*(ITEM-[A-Za-z0-9._-]+)\*\*.*?verdict\s*:\s*(PASS|CONCERN|BLOCKED)\b(.*)$/i;
// FB-7 plan-coverage: a PLAN item may be DESCOPED (cut this round) instead of
// implemented+tested — but only with recorded human approval, never silently.
// PLAN marker:      - **ITEM-30**: [DESCOPED] <what was cut>
const RE_ITEM_DESCOPED = /\[\s*DESCOPED\b/i;
// DECISIONS approval: - DESCOPED: ITEM-30 — <reason> [approved: <who/how>]
const RE_DECISION_DESCOPE = /^\s*-?\s*DESCOPED\s*:\s*(ITEM-[A-Za-z0-9._-]+)\b(.*)$/i;
const RE_DESCOPE_APPROVED = /\[\s*approved\b|·\s*approved\b|\bhuman[-\s]approved\b|\bapproved\s*:/i;
// TEST line:   - **TEST-2** (tier: integration) [covers: ITEM-1, ITEM-3] file: `x` — asserts: y
const RE_TEST_ID = /\*\*(TEST-[A-Za-z0-9._-]+)\*\*/;
const RE_TEST_TIER = /tier\s*:\s*(unit|integration|e2e)\b/i;
const RE_TEST_COVERS = /covers\s*:\s*([^\]]+)\]/i;
const RE_TEST_FILE = /file\s*:\s*[`"]?([^`"\n]+?)[`"]?\s*(?:—|--|-|asserts)/i;
const RE_TEST_ASSERTS = /asserts\s*:\s*(.+?)\s*$/i;
// Design-invariant binding: PLAN.md `## Invariants` lists non-negotiables lifted
// verbatim from the named design; each must be pinned by an executable acceptance
// test. This is the sufficient anchor a phase gate alone can't be — it stops a
// plan silently reframing the design and still reaching 9/9 (the
// declarative-canvas-plots failure). See FB-15..20 in the skill.
// PLAN INV line:  - **INV-1**: <non-negotiable lifted verbatim from the design>
const RE_INV = /^-\s*\*\*(INV-[A-Za-z0-9._-]+)\*\*\s*:\s*(.+?)\s*$/;
// TEST acceptance/invariant tags:  [acceptance]  and  [invariant: INV-1, INV-2]
const RE_TEST_ACCEPTANCE = /\[\s*acceptance\s*\]/i;
const RE_TEST_INVARIANT = /\[\s*invariant\s*:\s*([^\]]+)\]/i;
// DESIGN_FIDELITY line:  - **INV-1** — fidelity: UPHELD|AT-RISK|DROPPED — <how>
const RE_FIDELITY = /^-\s*\*\*(INV-[A-Za-z0-9._-]+)\*\*.*?fidelity\s*:\s*(UPHELD|AT-RISK|DROPPED)\b(.*)$/i;
// A10 restricted-user tag: a `[negative-perm]` marker on a `tier: e2e` test line
// flags it as the RESTRICTED-USER spec (logs in as a user LACKING the perm and
// asserts the feature UI is ABSENT — not merely 403-on-use).
const RE_TEST_NEGPERM = /\[\s*negative-perm\s*\]/i;
// A10 POSITIVE CONTROL. "The UI is absent for a restricted user" passes
// VACUOUSLY if the page never loaded at all — a blank render, a failed route, a
// 500, a login bounce all satisfy "the affordance is not visible". One real spec
// was confounded exactly this way: it would have passed with the permission gate
// DELETED, because it never established that the restricted user reached the
// subject at all. The negative-perm spec must therefore also assert the SUBJECT
// LOADS for that same user — the control that makes "absent" mean "gated"
// instead of "never rendered". Canonical form is an explicit [positive-control]
// tag; a clear affirmative claim in the `asserts:` prose is also accepted (same
// grammar A9 uses for its deny-path prose).
const RE_TEST_POSCONTROL = /\[\s*positive-control\s*\]/i;
const RE_POSCONTROL_PROSE = new RegExp([
  // "can open the page", "still renders", "does load" — but NOT "still sees NO x"
  /\b(?:can|does|still|successfully)\s+(?:\w+\s+){0,2}(?:open|opens|load|loads|render|renders|reach|reaches|view|views|access|accesses|obtain|obtains|see|sees)\b(?!\s*(?:no|not|none|never|nothing|zero|neither)\b)/.source,
  /\bpage\s+(?:still\s+)?(?:loads|renders)\b/.source,
  /\b(?:loads|renders|is\s+reachable|is\s+visible|is\s+served)\s+for\s+(?:that|the|a|an)\b/.source,
  /\b(?:HTTP\s*)?200\b/.source,
].join('|'), 'i');
// DECISION:    ### DEC-1: question   then **Resolution:** ...  **Basis:** ...
//
// HEADING-LEVEL AGNOSTIC, AND THE TRAILING COLON IS OPTIONAL. This used to be
// `/^#{2,6}\s*(DEC-…)\s*:/` — keyed to a colon that real files do not always write. Measured
// across the live lifecycle population: 1738 headings are `### DEC-N:`, but 29 are
// `## DEC-N` and 15 are `### DEC-N`, both without a colon, because different owners append
// at different times and at different depths. One real file carries 22 of the first shape
// and 8 of the second.
//
// Every heading the matcher cannot see reads as a HOLE once contiguity is checked, so a
// depth/colon-keyed matcher manufactures false positives on correct files. That is worse
// than the defect it hunts: a push gate that rejects a correct file trains people to bypass
// it, and then it is not there on the day a decision genuinely goes unrecorded — the same
// dynamic as the `--all` scaffolding trap.
//
// The risk in the other direction is real and bounded deliberately: a matcher relaxed until
// it matches anything starts counting CITATIONS as records, which inverts the check. So the
// `#` must be at column 0 (excluding indented code and `> ` blockquoted citations), and
// fenced code blocks are stripped before scanning (`### DEC-2` and `# DEC-2:` inside a ```sh
// fence are a shell comment and an example, not declarations). Both halves are pinned by
// selftest scenarios, including a sensitivity control proving the fence case is not passing
// merely because the matcher sees nothing at all.
// TWO MATCHERS, because two different questions are asked of these headings and widening
// one must not widen the other:
//
//   RE_DEC     (narrow, UNCHANGED) — "which entries follow the STRUCTURED decision form?"
//                Those, and only those, must carry a `**Resolution:**` line.
//   RE_DEC_ANY (wide)              — "which ids are ON RECORD?" Drives contiguity only.
//
// Keeping them separate is not tidiness. Widening RE_DEC itself pulled the prose-style
// `## DEC-N — <statement>` records that real owners append into the Resolution requirement,
// and those entries state their decision in the heading and argue it in the body rather than
// in a `**Resolution:**` line. That failed files which pass today — caught only by running
// the old matcher and the new one over the same real file and diffing the verdicts, which is
// the check worth repeating whenever a shared matcher is loosened.
const RE_DEC = /^#{2,6}\s*(DEC-[A-Za-z0-9._-]+)\s*:/;
const RE_DEC_ANY = /^#{1,6}[ \t]*(DEC-[A-Za-z0-9._-]+)\b[ \t]*:?/;

/** A document's lines with fenced code blocks blanked out, so a fence cannot declare
 *  anything. Blanked rather than removed so every line index still maps to the real file. */
function linesOutsideFences(text) {
  const out = [];
  let fence = null; // the opening fence's marker char + length, or null
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(ln);
    if (m) {
      const mark = m[1][0], len = m[1].length;
      if (!fence) { fence = { mark, len }; out.push(''); continue; }
      // a closing fence must use the same char and be at least as long
      if (mark === fence.mark && len >= fence.len) { fence = null; out.push(''); continue; }
    }
    out.push(fence ? '' : ln);
  }
  return out;
}
// DRIFT entry: - **DRIFT-1.2** — verdict: plan-wins — text
const RE_DRIFT = /^-\s*\*\*(DRIFT-[A-Za-z0-9._-]+)\*\*.*?verdict\s*:\s*(plan-wins|impl-wins|none|resolved)\b/i;
// TEST_RESULTS: - **TEST-2**: PASS
const RE_RESULT = /\*\*(TEST-[A-Za-z0-9._-]+)\*\*\s*:?\s*.*?\b(PASS|FAIL|SKIP)\b/i;
// Frontend gate line: `npm run check (ui): PASS` / `npm run check (desktop/ui): PASS`
const RE_UI_CHECK = /npm run check\s*\(\s*([A-Za-z0-9._/\- ]+?)\s*\)\s*:?\s*.*?\b(PASS|FAIL)\b/i;

function parsePlanItems() {
  const t = read('PLAN.md');
  if (t == null) return null;
  const items = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_ITEM.exec(ln);
    if (m && m[2].trim()) items.set(m[1], m[2].trim());
  }
  return items;
}
function parseTests() {
  const t = read('TESTS.md');
  if (t == null) return null;
  const tests = [];
  for (const ln of t.split(/\r?\n/)) {
    const idm = RE_TEST_ID.exec(ln);
    if (!idm || !/^\s*-\s/.test(ln)) continue;
    const tier = (RE_TEST_TIER.exec(ln) || [])[1];
    const coversRaw = (RE_TEST_COVERS.exec(ln) || [])[1] || '';
    const covers = coversRaw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^ITEM-/.test(s));
    const file = (RE_TEST_FILE.exec(ln) || [])[1];
    const asserts = (RE_TEST_ASSERTS.exec(ln) || [])[1];
    const negPerm = RE_TEST_NEGPERM.test(ln);
    const posControl = RE_TEST_POSCONTROL.test(ln) || RE_POSCONTROL_PROSE.test(asserts || '');
    const acceptance = RE_TEST_ACCEPTANCE.test(ln);
    const invRaw = (RE_TEST_INVARIANT.exec(ln) || [])[1] || '';
    const invariants = invRaw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^INV-/.test(s));
    tests.push({ id: idm[1], tier, covers, file: file && file.trim(), asserts: asserts && asserts.trim(), negPerm, posControl, acceptance, invariants, line: ln });
  }
  return tests;
}
// PLAN.md `## Invariants` → Map(INV-N → text). Empty map when PLAN.md is absent.
function parseInvariants() {
  const t = read('PLAN.md');
  if (t == null) return new Map();
  const inv = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_INV.exec(ln);
    if (m && m[2].trim()) inv.set(m[1], m[2].trim());
  }
  return inv;
}
// DESIGN_FIDELITY.md → Map(INV-N → UPHELD|AT-RISK|DROPPED). null when file absent.
function parseFidelity() {
  const t = read('DESIGN_FIDELITY.md');
  if (t == null) return null;
  const verdicts = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_FIDELITY.exec(ln);
    if (m) verdicts.set(m[1], m[2].toUpperCase());
  }
  return verdicts;
}
// FB-7: PLAN items explicitly marked [DESCOPED] (cut from this round's build).
function parseDescopedPlanItems() {
  const t = read('PLAN.md');
  if (t == null) return new Set();
  const s = new Set();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_ITEM.exec(ln);
    if (m && RE_ITEM_DESCOPED.test(ln)) s.add(m[1]);
  }
  return s;
}
// FB-7: descope dispositions recorded in DECISIONS.md, split by whether they
// carry a human-approval token ([approved: …] / · approved / human-approved).
function parseApprovedDescopes() {
  const t = read('DECISIONS.md') || '';
  const approved = new Set(), unapproved = new Set();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_DECISION_DESCOPE.exec(ln);
    if (m) (RE_DESCOPE_APPROVED.test(m[2]) ? approved : unapproved).add(m[1]);
  }
  return { approved, unapproved };
}

// ---------------------------------------------------------------------------
// git diff hunk parsing (git diff base...HEAD --unified=0)
// ---------------------------------------------------------------------------
// Exclude the lifecycle artifacts themselves and MECHANICALLY-GENERATED files
// (OpenAPI spec + generated api-client types). Generated output is derived
// deterministically from reviewed source by a golden-tested generator, so it is
// not independently blind-auditable line-by-line — the source hunks
// (handlers/repository/etc.) carry the review. These same excludes make
// generated `ui/` artifacts NOT count as a real frontend touch (see
// `frontendWorkspacesOf` / `changedFilePaths`), so a backend-only feature that
// merely regenerates `openapi.json` + `types.ts` is still classified backend.
const DIFF_EXCLUDES = [
  ':(exclude).lifecycle',
  ':(glob,exclude)**/openapi.json',
  ':(glob,exclude)**/api-client/types.ts',
];
function diffHunks() {
  let out;
  try {
    out = git(repo, 'diff', `${baseRef}...HEAD`, '--unified=0', '--no-color', '--', '.', ...DIFF_EXCLUDES);
  } catch (e) {
    // fall back to two-dot if merge-base form fails
    out = git(repo, 'diff', baseRef, '--unified=0', '--no-color', '--', '.', ...DIFF_EXCLUDES);
  }
  const hunks = [];
  let file = null;
  for (const ln of out.split(/\r?\n/)) {
    const fm = /^\+\+\+ b\/(.+)$/.exec(ln);
    if (fm) { file = fm[1] === '/dev/null' ? null : fm[1]; continue; }
    if (/^--- /.test(ln) || /^diff --git/.test(ln)) continue;
    const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (hm && file) {
      const start = parseInt(hm[1], 10);
      const count = hm[2] === undefined ? 1 : parseInt(hm[2], 10);
      // deletion-only hunk (count 0): anchor at the surrounding new-side line
      const s = count === 0 ? Math.max(start, 1) : start;
      const e = count === 0 ? Math.max(start, 1) : start + count - 1;
      hunks.push({ file, start: s, end: e });
    }
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// touched-area detection (frontend vs backend) — drives the conditional
// frontend gates in phase 3 (test plan) and phase 8 (test results).
// ---------------------------------------------------------------------------
// The list of changed files in `base...HEAD`, with the SAME excludes as
// diffHunks (lifecycle artifacts + mechanically-generated openapi/types), so a
// diff that only regenerates `openapi.json`/`types.ts` reads as backend-only.
function changedFilePaths() {
  let out;
  try {
    out = git(repo, 'diff', `${baseRef}...HEAD`, '--name-only', '--no-color', '--', '.', ...DIFF_EXCLUDES);
  } catch (e) {
    out = git(repo, 'diff', baseRef, '--name-only', '--no-color', '--', '.', ...DIFF_EXCLUDES);
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
// A mechanically-generated frontend artifact never counts as a real UI touch
// (belt-and-suspenders alongside DIFF_EXCLUDES; also used to filter PLAN paths).
const RE_GENERATED_FE = /(?:^|\/)openapi\.json$|(?:^|\/)api-client\/types\.ts$/;
// Map a set of paths → the frontend npm workspaces they touch, per the
// (app.config-driven) FE_WORKSPACES prefix→label map. Default (ziee):
// `src-app/desktop/ui/**` → "desktop/ui"; `src-app/ui/**` → "ui".
function frontendWorkspacesOf(paths) {
  const ws = new Set();
  for (const p of paths) {
    if (RE_GENERATED_FE.test(p)) continue;
    for (const { prefix, label } of FE_WORKSPACES) {
      if (p.startsWith(prefix)) { ws.add(label); break; } // first (most-specific) match wins
    }
  }
  return ws;
}
// Regex matching a configured FE-workspace path token in PLAN.md prose (any
// configured prefix + path chars). Null when no FE workspaces are configured.
const RE_PLAN_FE_PATH = FE_WORKSPACES.length
  ? new RegExp('(?:' + FE_WORKSPACES.map((w) => w.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[A-Za-z0-9._\\-/]*', 'g')
  : null;
// Frontend workspaces named in PLAN.md's "Files to touch" section — used at
// phase 3, when the diff may still be empty (implementation not written yet).
function planFrontendWorkspaces() {
  const t = read('PLAN.md');
  if (t == null) return new Set();
  const lines = t.split(/\r?\n/);
  let inSec = false;
  const paths = [];
  for (const ln of lines) {
    const h = /^#{2,6}\s+(.*\S)\s*$/.exec(ln);
    if (h) { inSec = /files\s*to\s*touch|files-to-touch/i.test(h[1]); continue; }
    if (!inSec) continue;
    if (RE_PLAN_FE_PATH) for (const m of ln.matchAll(RE_PLAN_FE_PATH)) paths.push(m[0]);
  }
  return frontendWorkspacesOf(paths);
}
// Frontend workspaces touched by the real diff (empty if not implemented yet).
function diffFrontendWorkspaces() {
  try { return frontendWorkspacesOf(changedFilePaths()); } catch { return new Set(); }
}

// ---------------------------------------------------------------------------
// TIER — scale gate weight to BLAST RADIUS, not diff size alone.
// ---------------------------------------------------------------------------
// The evidence says the process is not uniformly heavy: across 22 completed
// features the MEDIAN ran ONE fix round and 17 of 22 ran <=3. What it has is an
// unbounded TAIL. But a 3-line auth change and a 900-line generated-registry
// diff currently get identical treatment, which is the wrong axis: what should
// buy extra rounds is how far a mistake can reach, not how many lines moved.
//
// LIGHT = small AND none of the four blast-radius signals:
//   • a new permission        (an authz mistake is unrecoverable + invisible)
//   • a migration             (a schema mistake is not revertible in place)
//   • a new module            (a new seam nothing has exercised yet)
//   • a public API/schema change (every downstream consumer inherits the error)
//
// What LIGHT changes: phase 7 accepts ONE completed audit round instead of
// requiring a re-audit round that finds nothing. What it does NOT change:
// EVERY deterministic hardening check (A1-A10, R2-5, FB-7, the invariant ↔
// acceptance-test binding) runs identically in both tiers. Those are nearly
// free and they are what catch the silent failures — tiering them would trade
// away the cheap half of the value to save none of the cost.
//
// The tier is printed on the header line so nobody has to guess which track
// they are on, or why.
const RE_ADDED_MIGRATION = /(?:^|\/)migrations\/[^/]*\.sql$/;
const RE_ADDED_MODULE = /(?:^|\/)(?:mod\.rs|module\.tsx)$/;
const RE_PUBLIC_API_ARTIFACT = /(?:^|\/)openapi\.json$|(?:^|\/)api-client\/types\.ts$/;
const RE_ROUTE_REGISTRATION = /\.api_route\s*\(/;
// Added+deleted line count over the SAME exclude set the audit uses.
function diffLineCount() {
  let out;
  try { out = git(repo, 'diff', `${baseRef}...HEAD`, '--numstat', '--no-color', '--', '.', ...DIFF_EXCLUDES); }
  catch { try { out = git(repo, 'diff', baseRef, '--numstat', '--no-color', '--', '.', ...DIFF_EXCLUDES); } catch { return null; } }
  let n = 0;
  for (const ln of out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(ln);
    if (!m) continue;
    if (m[1] !== '-') n += parseInt(m[1], 10);
    if (m[2] !== '-') n += parseInt(m[2], 10);
  }
  return n;
}
// Files this branch ADDS (for the migration / new-module signals).
function addedFilePaths() {
  for (const range of [[`${baseRef}...HEAD`], [baseRef]]) {
    try { return git(repo, 'diff', '--diff-filter=A', '--name-only', '--no-color', ...range, '--', '.').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
    catch { /* try the next form */ }
  }
  return null;
}
// Every changed path INCLUDING the generated artifacts (which changedFilePaths
// deliberately excludes) — a regenerated openapi.json IS the public-API signal.
function changedFilePathsWithGenerated() {
  for (const range of [[`${baseRef}...HEAD`], [baseRef]]) {
    try { return git(repo, 'diff', '--name-only', '--no-color', ...range, '--', '.').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
    catch { /* try the next form */ }
  }
  return null;
}
let _tierCache = null;
function classifyTier() {
  if (_tierCache) return _tierCache;
  const heavy = [];
  const lines = diffLineCount();
  if (lines == null) {
    // Base unresolvable → we cannot measure blast radius, so we do not get to
    // relax anything. Default to HEAVY (fail-closed on an unmeasurable diff).
    _tierCache = { tier: 'HEAVY', lines: null, reasons: [`the diff vs '${baseRef}' could not be measured`] };
    return _tierCache;
  }
  if (lines >= LIGHT_MAX_LINES) heavy.push(`${lines} changed lines >= ${LIGHT_MAX_LINES}`);
  if (introducesGatingPerm()) heavy.push('introduces a user-facing permission');
  const added = addedFilePaths() || [];
  const migs = added.filter((p) => RE_ADDED_MIGRATION.test(p));
  if (migs.length) heavy.push(`adds ${migs.length} migration(s)`);
  const mods = added.filter((p) => RE_ADDED_MODULE.test(p));
  if (mods.length) heavy.push(`adds ${mods.length} new module(s)`);
  const changed = changedFilePathsWithGenerated() || [];
  const apiArtifacts = changed.filter((p) => RE_PUBLIC_API_ARTIFACT.test(p));
  const addsRoute = diffAddedLines().some((a) => RE_ROUTE_REGISTRATION.test(a.text));
  if (apiArtifacts.length || addsRoute)
    heavy.push(apiArtifacts.length ? 'changes the public API/schema (openapi.json / api-client types)' : 'registers a new API route');
  _tierCache = heavy.length
    ? { tier: 'HEAVY', lines, reasons: heavy }
    : { tier: 'LIGHT', lines, reasons: [`${lines} changed lines < ${LIGHT_MAX_LINES}; no new permission, migration, module, or public API/schema change`] };
  return _tierCache;
}

function parseCoverage() {
  const t = read('AUDIT_COVERAGE.tsv');
  if (t == null) return null;
  const rows = [];
  for (const ln of t.split(/\r?\n/)) {
    if (!ln.trim() || /^file\b/i.test(ln)) continue; // skip header/blank
    const cols = ln.split('\t');
    if (cols.length < 4) continue;
    const [file, start, end, angles] = cols;
    rows.push({
      file: file.trim(),
      start: parseInt(start, 10),
      end: parseInt(end, 10),
      angles: angles.split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean),
    });
  }
  return rows;
}
function parseLedger() {
  const t = read('LEDGER.jsonl');
  if (t == null) return null;
  const rows = [];
  t.split(/\r?\n/).forEach((ln, i) => {
    if (!ln.trim()) return;
    try { rows.push(JSON.parse(ln)); } catch { rows.push({ __parse_error: i + 1 }); }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// diff-added-lines + git-status helpers (for the A3/A4/A8/A9 content gates)
// ---------------------------------------------------------------------------
// Every ADDED (+) line in base...HEAD (excluding lifecycle + generated files),
// with its file + new-side line number. Used to scan for skip/ignore markers,
// cosmetic-test smells, permission adds without deny-tests, etc.
let _addedCache = null;
function diffAddedLines() {
  if (_addedCache) return _addedCache;
  let out;
  try { out = git(repo, 'diff', `${baseRef}...HEAD`, '--no-color', '-U0', '--', '.', ...DIFF_EXCLUDES); }
  catch { try { out = git(repo, 'diff', baseRef, '--no-color', '-U0', '--', '.', ...DIFF_EXCLUDES); } catch { out = ''; } }
  const added = [];
  let file = null, ln = 0;
  for (const line of out.split(/\r?\n/)) {
    const fm = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fm) { file = fm[1] === '/dev/null' ? null : fm[1]; continue; }
    const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm) { ln = parseInt(hm[1], 10); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) { if (file) added.push({ file, ln, text: line.slice(1) }); ln++; }
    // '-' and '\ No newline' lines don't advance the new-side counter (with -U0
    // there are no context lines).
  }
  _addedCache = added;
  return added;
}
// Working-tree status (porcelain), minus known-noisy entries (the pgvector
// submodule + scratch logs) — for the A2 clean-tree gate.
function dirtyWorkingTree() {
  let out;
  try { out = git(repo, 'status', '--porcelain'); } catch { return []; }
  return out.split(/\r?\n/).map((s) => s.replace(/\r$/, '')).filter((l) => {
    if (!l.trim()) return false;
    const path = l.slice(3);
    if (CLEAN_TREE_IGNORE.some((sub) => path.includes(sub))) return false; // noisy submodule(s), app.config-driven
    if (/\.log$/.test(path)) return false;                          // scratch logs
    return true;
  });
}
// The set of TEST-IDs in a given blob of TESTS.md text.
function testIdsIn(text) {
  const ids = new Set();
  if (!text) return ids;
  for (const ln of text.split(/\r?\n/)) {
    const m = RE_TEST_ID.exec(ln);
    if (m && /^\s*-\s/.test(ln)) ids.add(m[1]);
  }
  return ids;
}
// The TESTS.md path relative to the repo (for git-history lookups).
function testsRelPath() {
  return join(featureDir, 'TESTS.md').replace(repo + '/', '');
}
// TEST-IDs that appeared in ANY earlier committed version of TESTS.md on this
// branch — used by the A5 shrink-guard to detect silently-removed tests.
function priorTestIds() {
  const rel = testsRelPath();
  let commits = [];
  try { commits = git(repo, 'log', '--format=%H', '--', rel).split(/\r?\n/).filter(Boolean); }
  catch { return null; }
  // skip the newest (== current committed) so we compare against strictly-older versions
  const union = new Set();
  let sawAny = false;
  for (const c of commits.slice(1)) {
    let blob = '';
    try { blob = git(repo, 'show', `${c}:${rel}`); } catch { continue; }
    sawAny = true;
    for (const id of testIdsIn(blob)) union.add(id);
  }
  return sawAny ? union : null;
}

// ---------------------------------------------------------------------------
// per-phase validators — each returns { present, gaps: [] }
// ---------------------------------------------------------------------------
const FORBIDDEN_DECISION = /\b(TBD|TODO|ASK)\b|\?\?\?|<\s*(ask|decide|todo)\s*>/i;
// Review breadth. The old rule (>=10 distinct angles, every hunk covered by >=3)
// has no empirical support and cost more than it returned:
//   • Porter/Siy/Votta (IEEE TSE 1997), 88 randomized industrial inspections:
//     yield saturates AT TWO reviewers. 1 is worse than 2; 4 is no better than 2 —
//     larger teams bought effort and elapsed time, not defects.
//   • "Perspective-based reading" IS the >=3-angles idea, and it has been tested
//     for 25 years without replicating: 3 of 8 studies significant, and all three
//     positives come from the originating research network. Every arms-length
//     replication was null, including the two largest (N=223, N=177). A
//     replication by the original authors got perspective p = .655.
//   • Locally: an audit of 22 completed features found the coverage TSV (435 rows,
//     ~79 KB, mechanically generated) caught ZERO defects, while four angles
//     carried 74% of confirmed HIGHs.
// So: run TWO genuinely different angles per round from a fixed roster, and let a
// finding become work only when CORROBORATED or oracle-confirmed (see phase6).
const ANGLE_MIN = 2;
// The required core — these four carry the yield. Conditional angles (authz, db,
// api-contract, concurrency, ux-a11y, perf) are added by change type, not by count.
const ANGLE_CORE = ['correctness', 'tests-quality', 'design-conformance', 'security'];

// ---------------------------------------------------------------------------
// A1-A9 — the hardening checks (see LIFECYCLE_HARDENING_MASTER.md)
// ---------------------------------------------------------------------------
// A1: reject >1 .lifecycle feature dir even under an explicit --dir (a second
// feature dir sneaks onto the branch → the pre-push `--all` gate validates the
// wrong one → silent push-doom).
//
// Counted against `baseRef`, NOT the on-disk listing. A branch cut from a
// long-lived integration branch INHERITS every previously-landed feature's
// committed artifacts, so an on-disk count made A1 unsatisfiable there — and its
// only "remedy" was deleting other features' audit trails to go green, which is
// precisely the destructive act the lifecycle exists to prevent. What A1 means is
// "this BRANCH introduces exactly one feature", so that is what it now measures.
//
// Uncommitted-but-present dirs still count: a dir added on disk would ship on the
// next commit, and A1 is a pre-push guard.
function checkA1() {
  const root = join(repo, '.lifecycle');
  if (!existsSync(root)) return [];
  let subs = [];
  try { subs = readdirSync(root).filter((d) => { try { return statSync(join(root, d)).isDirectory(); } catch { return false; } }); }
  catch { return []; }

  const firstSeg = (p) => {
    const parts = p.split('/').filter(Boolean);
    const i = parts.indexOf('.lifecycle');
    return i >= 0 ? parts[i + 1] : null;
  };

  // The DELETE check must run BEFORE the "<=1 dir" early return below. Deleting
  // the siblings is what LEAVES one dir, so short-circuiting on the count would
  // let the check pass exactly when the damage has been done.
  const gaps = [];
  try {
    const removed = new Set(
      git(repo, 'diff', '--diff-filter=D', '--name-only', `${baseRef}...HEAD`, '--', '.lifecycle')
        .split('\n').map((l) => firstSeg(l.trim())).filter(Boolean),
    );
    // Only a dir with nothing left on disk counts — a branch may legitimately
    // delete or rename individual files inside its OWN feature dir.
    for (const d of [...removed]) if (subs.includes(d)) removed.delete(d);
    if (removed.size) {
      gaps.push(`A1: this branch DELETES ${removed.size} .lifecycle feature dir(s) inherited from ${baseRef} (${[...removed].sort().join(', ')}) — never remove another feature's audit trail to satisfy a gate. Restore them; if a dir is genuinely obsolete, retire it in its own commit with a stated reason.`);
    }
  } catch { /* base unresolvable; the add-side check below reports that */ }

  if (subs.length <= 1) return gaps;

  // Feature dirs this branch ADDS relative to the base.
  let added = null;
  for (const range of [[`${baseRef}...HEAD`], [baseRef]]) {
    try {
      const out = git(repo, 'diff', '--diff-filter=A', '--name-only', ...range, '--', '.lifecycle');
      added = new Set(out.split('\n').map((l) => firstSeg(l.trim())).filter(Boolean));
      break;
    } catch { /* try the next form */ }
  }
  // Base unresolvable (shallow clone, missing ref) → fall back to the strict
  // on-disk rule rather than silently passing.
  if (added == null) {
    return [`A1: .lifecycle/ has ${subs.length} feature dirs (${subs.join(', ')}) and the base ref '${baseRef}' could not be resolved to tell which this branch adds — a branch may carry exactly ONE. Pass --base, or remove the stray(s).`];
  }
  // Plus anything present but untracked — it would ship on the next commit.
  try {
    const st = git(repo, 'status', '--porcelain', '--untracked-files=all', '--', '.lifecycle');
    for (const line of st.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('??')) continue;
      const seg = firstSeg(t.replace(/^\?\?\s*/, ''));
      if (seg) added.add(seg);
    }
  } catch { /* status is advisory here */ }

  if (added.size > 1) {
    gaps.push(`A1: this branch adds ${added.size} .lifecycle feature dirs (${[...added].sort().join(', ')}) relative to ${baseRef} — a branch may carry exactly ONE. Remove the stray(s) before pushing.`);
  }
  return gaps;
}

// A3: diff-added test skips/ignores. Only genuine platform-incompatibility is a
// legit skip, and that MUST be a #[cfg(target_os=...)] gate — never #[ignore]/.skip.
//
// `#[ignore]`, `.only(`, and `xit/xdescribe` are unconditionally wrong: they
// disable a test (or disable every OTHER test) regardless of environment.
const RE_IGNORE_OR_ONLY = /#\[\s*ignore\b|(?:^|[^\w.])(?:test|it|describe|context)\.only\s*\(|(?:^|[^\w])x(?:it|describe)\s*\(/;
//
// `.skip(` is TWO different constructs and only one of them is the offence:
//   test.skip('name', fn)        — UNCONDITIONAL. The test never runs. Flag it.
//   test.skip()                  — same, at runtime. Flag it.
//   test.skip(true, 'why')       — same, dressed as a condition. Flag it.
//   test.skip(!HAS_KEY, 'why')   — a RUNTIME ENVIRONMENT GATE (the framework's
//                                  conditional-skip API). NOT a skip-to-go-green.
// The conditional form is how a spec declares "this needs a real LLM / an API
// key / an external engine". Flagging it forces the author either to evade the
// check (`COND ? describe : describe.skip` — identical behaviour, guardrail
// spelled around it) or to delete the guard, which makes the spec FAIL on every
// box lacking the dependency. Both outcomes are worse than the thing A3 defends
// against. Measured on the consuming repo: 43 conditional env gates vs 8
// unconditional skips — the old rule was 84% false positives.
const RE_SKIP_UNCONDITIONAL = /(?:^|[^\w.])(?:test|it|describe|context)\.skip\s*\(\s*(?:['"`]|true\b|\))/;
function checkA3() {
  const g = [];
  for (const a of diffAddedLines()) {
    if (RE_IGNORE_OR_ONLY.test(a.text))
      g.push(`A3: ${a.file}:${a.ln}: diff ADDS a test skip/ignore/only ("${a.text.trim().slice(0, 70)}") — no #[ignore]/.skip/.only to go green; a real platform gate is #[cfg(target_os=...)].`);
    else if (RE_SKIP_UNCONDITIONAL.test(a.text))
      g.push(`A3: ${a.file}:${a.ln}: diff ADDS an UNCONDITIONAL test skip ("${a.text.trim().slice(0, 70)}") — this test can never run. A runtime dependency gate is \`test.skip(!HAS_DEP, 'why')\`; a platform gate is #[cfg(target_os=...)].`);
  }
  return g;
}

// A4: cosmetic / always-true assertions — a test must assert real behavior.
const RE_COSMETIC = /\bassert!\s*\(\s*true\s*[,)]|\bassert_eq!\s*\(\s*true\s*,\s*true\s*\)|\bassert_eq!\s*\(\s*(\d+)\s*,\s*\1\s*\)|expect\s*\(\s*true\s*\)\s*\.\s*to(?:Be|Equal|BeTruthy)\b|expect\s*\(\s*(\d+)\s*\)\s*\.\s*toBe\s*\(\s*\2\s*\)/;
function checkA4() {
  const g = [];
  for (const a of diffAddedLines()) {
    if (RE_COSMETIC.test(a.text))
      g.push(`A4: ${a.file}:${a.ln}: cosmetic/always-true assertion ("${a.text.trim().slice(0, 70)}") — assert the real behavior, not a tautology.`);
  }
  return g;
}

// A5: TESTS.md shrink-guard — a TEST-ID that existed in an earlier committed
// TESTS.md must not silently vanish (tests removed to make the gate pass).
function checkA5() {
  const cur = read('TESTS.md');
  if (cur == null) return [];
  const prior = priorTestIds();
  if (!prior || prior.size === 0) return [];
  const now = testIdsIn(cur);
  const vanished = [...prior].filter((id) => !now.has(id));
  if (vanished.length)
    return [`A5: TESTS.md dropped ${vanished.length} previously-enumerated test(s) (${vanished.slice(0, 8).join(', ')}) — do not shrink the test plan to pass; re-add or justify each in an amend.`];
  return [];
}

// ---------------------------------------------------------------------------
// A11 — a PASS must be EARNED BY THIS BRANCH.
// ---------------------------------------------------------------------------
// The gap this closes, found the expensive way. Phase 8 verified that a result
// LINE exists for every enumerated TEST-ID and that it reads PASS. It never
// verified that the ID names a test THIS BRANCH ADDED. And `TEST-N` is a
// PER-FEATURE namespace that every lifecycle restarts from 1 — one repo carried
// ~1,900 `TEST-N` citations across other features' directories — so a bare grep
// binds `TEST-22` to a stranger's spec in an unrelated suite. On a real branch
// TEN IDs carried a PASS line that way, and one of them was an `[acceptance]`
// test: a design invariant recorded as PROVEN, by a test that belonged to
// another feature and asserted nothing about this one.
//
// That is worse than a missing test. A missing test is visible; an inherited
// PASS reads as done, and the gate that exists to prevent exactly this signed
// it off 9/9.
//
// THE RULE. A `TEST-N: PASS` line must be BOUND TO SOMETHING THIS BRANCH WROTE.
// Two ways to satisfy it, because real branches legitimately do both:
//
//   · the ID appears in an ADDED line of `git diff <base>...HEAD` — the branch
//     wrote the citation, in the test it names; or
//   · the TESTS.md entry's declared `file:` is itself ADDED or MODIFIED by this
//     branch — the test lives in a file this branch actually worked on, even if
//     the author did not write the ID into a comment.
//
// `.lifecycle/` is excluded from the diff, so citing the ID in the lifecycle
// artifacts — where every ID appears by construction — cannot satisfy either arm.
//
// Both arms fail for the case that motivated this check: an ID whose declared
// file the branch never opened, resolving by bare grep to a stranger's test in
// another feature's directory.
//
// TWO legitimate resolutions, and no third:
//   1. EARN it — bind the ID to a test this branch added (write the test, or add
//      the citation to the test that really asserts the claim) and run it.
//   2. ADMIT it — change the line to `NOT VERIFIED` with the reason. That is an
//      honest gap, and it is DELIBERATELY still not a pass: the all-PASS loop
//      below will keep phase 8 red. A gate that let "nobody ran this" reach 9/9
//      would be the same false certification in a politer font.
//
// It polices PASS only. A FAIL or SKIP line already fails phase 8 on its own and
// is not a false claim of proof.
//
// Scope note: this cannot catch an ID cited on an added line of a test that
// asserts the wrong thing. Nothing mechanical can. What it removes is the
// SILENT case — inheriting a stranger's result without touching a test at all.
function checkA11(results) {
  const tests = parseTests();
  if (!tests || tests.length === 0) return [];
  if (!results || results.size === 0) return [];
  let added;
  try { added = diffAddedLines(); } catch { return []; }
  // No measurable diff (a fresh branch, a shallow clone) ⇒ say nothing rather
  // than fail every ID for an environment fact.
  if (!added || added.length === 0) return [];
  const cited = new Set();
  for (const { text } of added) {
    for (const m of text.matchAll(/\b(TEST-[A-Za-z0-9._-]+)\b/g)) cited.add(m[1]);
  }
  // The second arm: files this branch added or modified (repo-relative).
  let touched = [];
  try { touched = changedFilePaths(); } catch { touched = []; }
  const touchedSet = new Set(touched);
  // The declared path is re-extracted here rather than taken from `parseTests()`:
  // the shared `RE_TEST_FILE` is non-greedy up to a `-`, so it truncates any path
  // containing a hyphen (`src-app/...` → `src`). That is harmless for the
  // presence check phase 3 uses it for, and fatal for a path COMPARISON. The
  // backtick-quoted form is what the artifact grammar specifies, so it is read
  // exactly.
  const declaredPath = new Map();
  for (const ln of (read('TESTS.md') || '').split(/\r?\n/)) {
    const m = /\*\*(TEST-[A-Za-z0-9._-]+)\*\*[\s\S]*?\bfile\s*:\s*`([^`]+)`/.exec(ln);
    if (m) declaredPath.set(m[1], m[2].trim());
  }
  const wroteDeclaredFile = (t) => {
    const f = (declaredPath.get(t.id) || '').trim().replace(/^\.\//, '');
    if (!f) return false;
    if (touchedSet.has(f)) return true;
    // TESTS.md paths are sometimes written relative to a sub-tree (`ui/src/...`
    // for `src-app/ui/src/...`). A SUFFIX match keeps those honest without
    // demanding a spelling the artifact grammar never required — and a suffix
    // still names a real file this branch touched.
    return touched.some((p) => p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`));
  };
  const unearned = tests
    .filter((t) => results.get(t.id) === 'PASS' && !cited.has(t.id) && !wroteDeclaredFile(t))
    .map((t) => ({ id: t.id, acceptance: !!t.acceptance, invariants: t.invariants ?? [] }));
  if (unearned.length === 0) return [];
  const g = [];
  // Acceptance tests are named separately and FIRST: an unearned acceptance PASS
  // is a design invariant recorded as proven by nothing, which is the failure
  // this check was built for.
  for (const u of unearned.filter((u) => u.acceptance)) {
    g.push(
      `A11: acceptance test ${u.id} (design invariant ${u.invariants.join(', ') || '?'}) is recorded PASS but is cited in NO line this branch added — ` +
      `\`TEST-N\` is a per-feature namespace, so a bare grep binds it to another feature's test. A design invariant is recorded as proven by a test that is not this feature's. ` +
      `Bind it to a test this branch added — write it, or point the entry at the file that really asserts the claim — and run it; or change the line to "NOT VERIFIED" with the reason.`,
    );
  }
  const rest = unearned.filter((u) => !u.acceptance).map((u) => u.id);
  if (rest.length) {
    g.push(
      `A11: ${rest.length} TEST-ID(s) are recorded PASS but are cited in NO line this branch added (${rest.slice(0, 12).join(', ')}${rest.length > 12 ? ', …' : ''}) — ` +
      `neither the ID nor its declared \`file:\` was touched by this branch — an inherited PASS from another feature's use of the same \`TEST-N\` namespace. For each: bind it to a test this branch added and RUN that test, or change the line to "NOT VERIFIED" with the reason. Do not leave a PASS nobody earned.`,
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// A7 — boot/runtime canary, BASELINE-CONTROLLED.
// ---------------------------------------------------------------------------
// A UI diff must record that the runtime-health/gate:ui pass ran: a non-booting
// app or a root ErrorBoundary crash is otherwise invisible, and "green e2e" can
// ship a non-rendering app. That part stands.
//
// What changed: A7 used to demand an ABSOLUTE `gate:ui (<ws>): PASS`. On a
// loaded shared box that is a tax on the author for the box's state ("took three
// attempts"), and it is a tax that BUYS a false signal — one recorded PASS
// turned out to be the exit code of a `tail` in a pipeline while the real output
// said `GATE FAILED`. An absolute bar that the environment can move is a bar
// people learn to route around.
//
// So the requirement is now a CONTROLLED comparison: the branch must be no worse
// than its base. Two accepted forms, both still one line:
//   absolute:    `gate:ui (ui): PASS`             — 0 findings cannot be worse
//                                                   than any base; still valid
//   comparative: `gate:ui (ui): branch 3 vs base 5`
//                `gate:ui (ui): branch=3 base=5`  — passes iff branch <= base
// The absolute form keeps every existing artifact valid; the comparative form is
// the relief, and it is what an author on a busy box should record.
const RE_CANARY_LINE = /(?:gate:ui|boot[ -]?canary|runtime[ -]?health)\s*\(\s*([A-Za-z0-9._/\- ]+?)\s*\)\s*:?\s*(.*)$/i;
const RE_CANARY_COMPARATIVE = /branch\s*[=:]?\s*(\d+)[\s\S]*?base\s*[=:]?\s*(\d+)|(\d+)\s*(?:findings?\s*)?(?:vs\.?|versus|against)\s*(?:a\s*)?base\s*(?:of\s*)?(\d+)/i;
const RE_CANARY_ABSOLUTE = /\b(PASS|FAIL)\b/i;
// The false-PASS catch — the part of the old A7 worth keeping. A recorded PASS
// that sits in the same file as pasted output saying the gate FAILED is not a
// result, it is a pipeline bug (`… | tail` returns tail's exit code). Cheap,
// and it caught a real one.
const RE_GATE_FAILED_MARKER = /\bgate\s*(?::|-|—)?\s*failed\b|\bgate:ui\b[^\n]*\bfailed\b|\bnpm run check\b[^\n]*\bfailed\b/i;
// → Map(workspace-label → { ok:boolean, how:string }) parsed from TEST_RESULTS.md
function parseCanaryLines(text) {
  const out = new Map();
  for (const ln of text.split(/\r?\n/)) {
    const m = RE_CANARY_LINE.exec(ln);
    if (!m) continue;
    const ws = m[1].trim().toLowerCase();
    const tail = m[2] || '';
    const cmp = RE_CANARY_COMPARATIVE.exec(tail);
    if (cmp) {
      const branch = parseInt(cmp[1] !== undefined ? cmp[1] : cmp[3], 10);
      const base = parseInt(cmp[2] !== undefined ? cmp[2] : cmp[4], 10);
      out.set(ws, { ok: branch <= base, how: `branch ${branch} vs base ${base}`, comparative: true });
      continue;
    }
    const abs = RE_CANARY_ABSOLUTE.exec(tail);
    if (abs) out.set(ws, { ok: abs[1].toUpperCase() === 'PASS', how: abs[1].toUpperCase(), comparative: false });
  }
  return out;
}

// A8: a diff that adds a built-in MCP server must include BOTH the
// auto_attach_builtin_ids AND is_builtin_server_id edits (else it registers but
// the model never sees the tools).
function checkA8() {
  const added = diffAddedLines();
  const addsBuiltinMcp = added.some((a) => /\bfn\s+\w*_mcp_server_id\s*\(/.test(a.text));
  if (!addsBuiltinMcp) return [];
  const all = added.map((a) => a.text).join('\n');
  const missing = [];
  if (!/auto_attach_builtin_ids/.test(all)) missing.push('auto_attach_builtin_ids');
  if (!/is_builtin_server_id/.test(all)) missing.push('is_builtin_server_id');
  if (missing.length)
    return [`A8: the diff registers a built-in MCP server (a *_mcp_server_id fn) but the mcp/chat_extension/mcp.rs edit(s) ${missing.join(' + ')} are missing — without both, the server registers yet the model never sees its tools.`];
  return [];
}

// A9: a diff that adds a permission must include a test asserting the DENY path.
function checkA9() {
  const added = diffAddedLines();
  const addsPerm = added.some((a) => /const\s+PERMISSION\s*:/.test(a.text) || /PERMISSION\s*:\s*&(?:'static\s+)?str\s*=/.test(a.text));
  if (!addsPerm) return [];
  const all = added.map((a) => a.text).join('\n');
  const tt = read('TESTS.md') || '';
  const hasDeny = /\b403\b|forbidden|denied|\bdeny\b|without[_ ].*perm|requires?_the_.*permission|lacks?[_ ].*perm/i.test(all + '\n' + tt);
  if (!hasDeny)
    return ['A9: the diff adds a permission but no test asserts the DENY path (403/forbidden). A new permission must prove the negative — a user lacking it is refused — not only the allow path. (A9 covers the BACKEND deny; A10 additionally requires the FRONTEND to be proven hidden.)'];
  return [];
}

// A10: FRONTEND authz gate — EXTENDS A9 from the API to the UI. A diff that
// INTRODUCES a user-facing permission (a `X::use` / `X::read` / `X::manage`
// string DEFINED in a modules/*/permissions.rs OR GRANTED in a migration) must
// be matched by a RESTRICTED-USER e2e spec: one that logs in as a user LACKING
// the permission and asserts the feature's UI surfaces are ABSENT — not merely
// that the API returns 403. e2e/8-of-8 test the HAPPY path WITH the permission;
// nothing otherwise forces the "unpermitted user sees no UI" case, which is how
// ungated composers/menu-items/nav-entries shipped past a green lifecycle.
//
// Convention: the spec is tagged `[negative-perm]` on a `(tier: e2e)` TESTS.md
// line. For a new permission BOTH A9 (backend deny) AND A10 (frontend hidden)
// are required.
//
// HONEST LIMIT: this gate only enforces that ONE such e2e exists + passes; it
// CANNOT verify the spec covers EVERY gated surface (a test could assert one
// surface hidden and miss another). The SKILL rule tells authors to walk ALL
// four gating layers (slot → route → <Can> → usePermission) inside that spec.
const RE_GATING_PERM = /["'`][a-z][a-z0-9_]*(?:::[a-z0-9_]+)*::(?:use|read|manage)["'`]/;
// A permission is INTRODUCED where it is DEFINED (a permissions.rs const) or
// GRANTED (a migration) — NOT at a check-site that merely references an existing
// one. Scoping to those two file kinds is what keeps the trigger precise.
const RE_PERM_SRC = /(?:^|\/)modules\/[^/]+\/permissions\.rs$/;
const RE_MIGRATION = /(?:^|\/)migrations\/[^/]+\.sql$/;
function diffIntroducesGatingPerm() {
  for (const a of diffAddedLines()) {
    if (!RE_PERM_SRC.test(a.file) && !RE_MIGRATION.test(a.file)) continue;
    if (RE_GATING_PERM.test(a.text)) return true;
  }
  return false;
}
// Phase-3 runs BEFORE implementation, so the diff may not yet carry the
// permission. Infer the introduction up-front from PLAN.md: its "Files to touch"
// must name a permissions.rs / migration AND the plan must name a gating-perm
// token. The AND keeps this from firing on a backend plan that merely mentions
// an EXISTING perm in prose. (The diff-based check above is authoritative once
// code exists — at --all / phase 8.)
const RE_GATING_PERM_TOKEN = /\b[a-z][a-z0-9_]*(?:::[a-z0-9_]+)*::(?:use|read|manage)\b/;
function planIntroducesGatingPerm() {
  const t = read('PLAN.md');
  if (t == null) return false;
  const touchesPermFile = /modules\/[A-Za-z0-9_]+\/permissions\.rs|migrations\/[^\s`"']+\.sql/.test(t);
  return touchesPermFile && RE_GATING_PERM_TOKEN.test(t);
}
function introducesGatingPerm() {
  return diffIntroducesGatingPerm() || planIntroducesGatingPerm();
}
// The enumerated RESTRICTED-USER e2e specs (tier e2e + [negative-perm] tag).
function negPermE2eTests(tests) {
  return (tests || []).filter((t) => t.tier === 'e2e' && t.negPerm);
}
// A10-enumeration: a gating perm is introduced but no restricted-user e2e is
// enumerated in TESTS.md. Runs at phase 3 AND phase 8.
function checkA10Enumeration() {
  if (!introducesGatingPerm()) return [];
  const tests = parseTests() || [];
  const neg = negPermE2eTests(tests);
  if (neg.length > 0) {
    // The negative alone is confounded: it passes whether the UI is GATED or
    // merely NEVER RENDERED. Require the positive control on the same spec.
    const uncontrolled = neg.filter((t) => !t.posControl);
    if (uncontrolled.length === neg.length)
      return [`A10: the restricted-user e2e (${uncontrolled.map((t) => t.id).join(', ')}) asserts only that the UI is ABSENT — that is a CONFOUNDED test: it passes identically when the page never loaded (a failed route, a login bounce, a render crash), so it would go green with the permission gate DELETED. The same spec must also assert the subject page/resource LOADS for that restricted user. Add a [positive-control] tag and state it in the asserts, e.g. "… the Foo page LOADS for that user and its nav entry/composer/Save button are ABSENT".`];
    return [];
  }
  const misTagged = tests.filter((t) => t.negPerm && t.tier !== 'e2e');
  const hint = misTagged.length
    ? ` (found a [negative-perm] tag on ${misTagged.map((t) => t.id).join(', ')} but not at tier: e2e — a 403/deny test is A9, not A10; the restricted-user proof MUST be an e2e that renders the UI).`
    : '';
  return [`A10: the diff introduces a user-facing permission (a X::use/::read/::manage defined in a modules/*/permissions.rs or granted in a migration) but TESTS.md enumerates no RESTRICTED-USER e2e spec — add a "(tier: e2e) [negative-perm]" test that logs in as a user LACKING the permission and asserts the feature's UI is ABSENT (walk slot → route → <Can> → usePermission), not just 403-on-use. Backend-deny (A9) + frontend-hidden (A10) are BOTH required for a new permission.${hint}`];
}
// A10-passing: at phase 8 the enumerated restricted-user e2e must PASS.
function checkA10Passing(results) {
  if (!introducesGatingPerm()) return [];
  const tests = parseTests() || [];
  const neg = negPermE2eTests(tests);
  if (neg.length === 0) return []; // enumeration gap already reported by checkA10Enumeration
  if (neg.some((t) => results.get(t.id) === 'PASS')) return [];
  const detail = neg.map((t) => `${t.id}=${results.get(t.id) || 'missing'}`).join(', ');
  return [`A10: a user-facing permission is introduced but no RESTRICTED-USER e2e spec is PASS (${detail}) — run the [negative-perm] spec ("npx playwright test <spec> --workers=1") and record PASS in TEST_RESULTS.md. A green happy-path e2e does not prove an unpermitted user sees no UI.`];
}

// R2-5: e2e route-mock staleness. A `page.route('**/api/…')` mock that points at
// a route no live backend registers silently intercepts nothing → the spec
// false-greens (a renamed/removed route poisons every dependent spec). We check
// each STATIC /api/ mock the DIFF adds against the union of both workspaces'
// openapi.json path sets — the canonical live-route registry. Template-literal
// mocks (`${…}`) can't be resolved statically and are skipped.
function openApiApiPaths() {
  // → array of normalized segment-arrays ({param} → '*') for every /api/* path.
  // OPENAPI_SPECS is app.config-driven (default = ziee's ui + desktop/ui specs).
  const files = OPENAPI_SPECS.map((f) => join(repo, f));
  const out = [];
  let anyPresent = false;
  for (const f of files) {
    if (!existsSync(f)) continue;
    anyPresent = true;
    let spec;
    try { spec = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const p of Object.keys(spec.paths || {})) {
      const segs = p.replace(/^\//, '').split('/').filter(Boolean)
        .map((s) => (/^\{.*\}$/.test(s) ? '*' : s));
      if (segs[0] === 'api') out.push(segs);
    }
  }
  return anyPresent ? out : null;
}
function mockMatchesARoute(mockSegs, routes) {
  return routes.some((r) => {
    const n = Math.min(mockSegs.length, r.length);
    for (let i = 0; i < n; i++) {
      if (mockSegs[i] === '*' || r[i] === '*') continue;
      if (mockSegs[i] !== r[i]) return false;
    }
    return true; // one is a wildcard-consistent prefix of the other
  });
}
function checkR2_5() {
  const routes = openApiApiPaths();
  if (!routes) return []; // no openapi.json present (LIFECYCLE_OPENAPI_SPECS absent/unbuilt) → nothing to check
  const g = [];
  const RE_ROUTE = /\.route\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const a of diffAddedLines()) {
    if (!/(^|\/)tests\/e2e\//.test(a.file)) continue;
    let m;
    RE_ROUTE.lastIndex = 0;
    while ((m = RE_ROUTE.exec(a.text))) {
      const raw = m[1];
      if (raw.includes('${')) continue;            // template literal — unresolvable
      const apiIdx = raw.indexOf('/api/');
      if (apiIdx === -1) continue;                 // only gate /api/ mocks
      // static segments from '/api/…' up to the first wildcard/query segment
      const tail = raw.slice(apiIdx + 1).split('?')[0];
      const seg = [];
      for (const s of tail.split('/').filter(Boolean)) {
        if (s.includes('*')) break;                // glob tail — stop the static prefix
        seg.push(s);
      }
      if (seg.length < 2) continue;                // just '/api' — too broad to judge
      if (!mockMatchesARoute(seg, routes))
        g.push(`R2-5: ${a.file}:${a.ln}: e2e route-mock "${raw}" targets /${seg.join('/')} which matches NO live route in openapi.json — a renamed/removed route makes this mock a silent no-op (the spec false-greens). Update the mock to the current route.`);
    }
  }
  return g;
}

function phase1() {
  const g = [];
  const t = read('PLAN.md');
  if (t == null) return { present: false, gaps: ['PLAN.md missing'] };
  if (!hasSection(t, 'item')) g.push('PLAN.md: missing an "Items" section');
  if (!hasSection(t, 'files to touch', 'files-to-touch')) g.push('PLAN.md: missing a "Files to touch" section');
  if (!hasSection(t, 'patterns to follow', 'patterns-to-follow', 'pattern')) g.push('PLAN.md: missing a "Patterns to follow" section');
  const items = parsePlanItems();
  if (!items || items.size === 0) g.push('PLAN.md: no `- **ITEM-N**: description` lines parsed');
  // Design-derivation gate: the plan must be anchored to a NAMED upstream design
  // and lift its non-negotiables verbatim as invariants. Without this a plan can
  // reframe the design into bespoke work and still pass every structural gate
  // (declarative-canvas-plots). The invariants are pinned to acceptance tests at
  // phase 3 and to fidelity verdicts at phase 2.
  if (!hasSection(t, 'design source')) g.push('PLAN.md: missing a "## Design source" section — name the upstream design doc + section(s) this plan realizes (≥1 line). A plan not derived from a named design can silently reframe its intent.');
  if (!hasSection(t, 'invariants')) g.push('PLAN.md: missing an "## Invariants" section — lift the design\'s non-negotiables verbatim as `- **INV-N**: <invariant>` lines.');
  const invs = parseInvariants();
  if (!invs || invs.size === 0) g.push('PLAN.md: the "## Invariants" section has no `- **INV-N**: <non-negotiable lifted verbatim from the design>` lines — enumerate ≥1 invariant; each becomes a fidelity verdict (phase 2) and an executable acceptance test (phase 3).');
  return { present: true, gaps: g };
}

function phase2() {
  const g = [];
  // The plan-audit ACTIVITY is valuable (it produced 120 code-verified CONCERNs
  // across 22 features, several substantive). The separate DOCUMENT was not: it
  // was cited by zero other artifacts. So the per-ITEM verdict grammar is now
  // accepted in PLAN.md itself, and PLAN_AUDIT.md is optional. What is still
  // REFUSED is a BLOCKED verdict left unresolved — that is the part that carried
  // the signal.
  const t = read('PLAN_AUDIT.md') ?? read('PLAN.md');
  if (t == null) return { present: false, gaps: ['neither PLAN_AUDIT.md nor PLAN.md is present — nothing to audit'] };
  const items = parsePlanItems();
  if (!items) return { present: true, gaps: ['PLAN.md missing/empty — cannot audit'] };
  const verdicts = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_AUDIT.exec(ln);
    if (m) verdicts.set(m[1], m[2].toUpperCase());
  }
  if (verdicts.size === 0) g.push('no plan-audit verdicts found — record `- **ITEM-N** — verdict: PASS|CONCERN|BLOCKED — <what you verified in the codebase>` in PLAN.md (or PLAN_AUDIT.md). The audit is a codebase check, not a restatement of the plan.');
  for (const [id, v] of verdicts) {
    if (v === 'BLOCKED') g.push(`${id} verdict is BLOCKED — resolve before proceeding`);
  }
  // DESIGN_FIDELITY is no longer a required self-attestation. Across 22 audited
  // features it recorded 84 UPHELD / 0 DROPPED — it never once fired — and where
  // it mattered it was WRONG: one feature self-certified all six invariants
  // UPHELD while the blind design-conformance auditor found two violated in
  // reachable states. An author's own verdict on whether they honoured the design
  // is the one verdict that carries no information. The invariants still matter:
  // they are declared in PLAN.md (phase 1), proven by [acceptance] tests (phase 3
  // + 8), and judged BLIND by the design-conformance angle (phase 6). If the file
  // is present it is still checked for coherence — a DROPPED invariant is a real
  // signal — but its absence is no longer a gap.
  const invs = parseInvariants();
  const fidelity = parseFidelity();
  if (fidelity != null) {
    for (const id of invs.keys()) {
      if (fidelity.has(id) && fidelity.get(id) === 'DROPPED') g.push(`DESIGN_FIDELITY.md: ${id} fidelity is DROPPED — a plan may not drop a design invariant. Re-scope the plan to uphold it (or renegotiate the invariant with the owner and amend the design + PLAN "## Invariants").`);
    }
    for (const id of fidelity.keys()) {
      if (!invs.has(id)) g.push(`DESIGN_FIDELITY.md: ${id} has a fidelity verdict but is not an INV-N in PLAN.md's "## Invariants".`);
    }
  }
  return { present: true, gaps: g };
}

function phase3() {
  const g = [];
  const items = parsePlanItems();
  const tests = parseTests();
  if (tests == null) return { present: false, gaps: ['TESTS.md missing'] };
  if (!items) return { present: true, gaps: ['PLAN.md missing/empty — cannot map tests'] };
  if (tests.length === 0) g.push('TESTS.md: no `- **TEST-N** (tier: ...) [covers: ITEM-x] file: ... asserts: ...` lines parsed');
  const covered = new Set();
  for (const t of tests) {
    if (!t.tier) g.push(`TESTS.md: ${t.id} missing "(tier: unit|integration|e2e)"`);
    if (!t.file) g.push(`TESTS.md: ${t.id} missing "file: <path>"`);
    if (!t.asserts) g.push(`TESTS.md: ${t.id} missing "asserts: <what>"`);
    if (t.covers.length === 0) g.push(`TESTS.md: ${t.id} missing "[covers: ITEM-x]"`);
    for (const c of t.covers) {
      if (!items.has(c)) g.push(`TESTS.md: ${t.id} covers unknown ${c} (not in PLAN.md)`);
      else covered.add(c);
    }
  }
  // FB-7 plan-coverage gate: every PLAN ITEM must be either (a) covered by an
  // enumerated TEST, or (b) explicitly DESCOPED with recorded human approval in
  // DECISIONS.md. An item that is neither — silently dropped — FAILS. This closes
  // the hole where a "green" feature shipped with planned sub-features absent.
  const descoped = parseDescopedPlanItems();
  const { approved: descApproved } = parseApprovedDescopes();
  for (const id of items.keys()) {
    if (descoped.has(id)) {
      if (!descApproved.has(id))
        g.push(`PLAN.md: ${id} is marked [DESCOPED] but DECISIONS.md has no approved "DESCOPED: ${id} … [approved: …]" disposition — cutting a planned item requires recorded human sign-off, never a silent omission (FB-7 plan-coverage gate).`);
      continue; // a human-approved descope is exempt from test coverage
    }
    if (!covered.has(id)) g.push(`TESTS.md: ${id} is not covered by any TEST (bipartite completeness fails) — implement + cover it, or mark it [DESCOPED] in PLAN.md with an approved DECISIONS.md disposition (FB-7).`);
  }
  // Frontend work MUST enumerate ≥1 e2e-tier test. Detect a frontend touch from
  // the diff OR (when nothing is implemented yet) from PLAN.md's files-to-touch.
  // Generated openapi/types artifacts are filtered out, so a backend-only
  // feature that merely regenerates the client is NOT treated as UI work.
  const fe = new Set([...planFrontendWorkspaces(), ...diffFrontendWorkspaces()]);
  if (fe.size > 0 && !tests.some((t) => t.tier === 'e2e')) {
    g.push(`TESTS.md: frontend workspace(s) {${[...fe].join(', ')}} are touched but no "(tier: e2e)" test is enumerated — UI work requires ≥1 e2e-tier test; an all-unit plan is refused.`);
  }
  // Design-invariant acceptance gate: every PLAN invariant must be pinned by ≥1
  // [acceptance] test tagged [invariant: INV-N]. The phase gates are necessary-
  // not-sufficient; the invariant↔acceptance-test binding is the SUFFICIENT anchor
  // that stops a plan silently reframing the design (declarative-canvas-plots).
  const invs = parseInvariants();
  const invCovered = new Set();
  for (const t of tests) {
    if (t.acceptance && t.invariants.length === 0)
      g.push(`TESTS.md: ${t.id} is tagged [acceptance] but names no [invariant: INV-N] — an acceptance test must pin a specific design invariant.`);
    if (!t.acceptance && t.invariants.length > 0)
      g.push(`TESTS.md: ${t.id} carries [invariant: ${t.invariants.join(', ')}] but is not tagged [acceptance] — the invariant proof must be an [acceptance] test.`);
    for (const iv of t.invariants) {
      if (!invs.has(iv)) g.push(`TESTS.md: ${t.id} names unknown ${iv} (not an INV-N in PLAN.md's "## Invariants").`);
      else if (t.acceptance) invCovered.add(iv);
    }
  }
  for (const id of invs.keys()) {
    if (!invCovered.has(id))
      g.push(`TESTS.md: ${id} has no covering [acceptance] test — every design invariant must be an executable acceptance test. Add e.g. "- **TEST-N** (tier: e2e) [acceptance] [invariant: ${id}] file: \`...\` — asserts: <the invariant holds>".`);
  }
  for (const x of checkA5()) g.push(x); // A5 shrink-guard
  for (const x of checkA10Enumeration()) g.push(x); // A10 restricted-user e2e must be enumerated
  return { present: true, gaps: g };
}

function phase4() {
  const g = [];
  const t = read('DECISIONS.md');
  if (t == null) return { present: false, gaps: ['DECISIONS.md missing'] };
  const decs = [];
  // Fenced code is blanked so an example or a shell comment cannot declare a decision.
  // Indices still align with the real file, so the forbidden-marker line numbers below stay
  // truthful — and a TBD inside a fence is correctly no longer read as an open marker.
  const lines = linesOutsideFences(t);
  // Every id ON RECORD at any heading depth, for the contiguity check below. Separate from
  // `decs`, which holds only the STRUCTURED entries that owe a `**Resolution:**` line.
  const recorded = [];
  for (const ln of lines) {
    const m = RE_DEC_ANY.exec(ln);
    if (m) recorded.push(m[1]);
  }
  for (let i = 0; i < lines.length; i++) {
    const m = RE_DEC.exec(lines[i]);
    if (m) {
      // look ahead for a Resolution before the next DEC heading
      let res = false;
      for (let j = i + 1; j < lines.length && !RE_DEC.test(lines[j]); j++) {
        if (/\*\*\s*resolution\s*:?\s*\*\*/i.test(lines[j]) || /^\s*resolution\s*:/i.test(lines[j])) res = true;
      }
      decs.push({ id: m[1], res });
    }
  }
  // Emptiness is judged on the WIDE set: a file written entirely in the prose-style
  // `## DEC-N — …` form has real records, and reporting "none parsed" for it would be the
  // narrow matcher's blind spot showing through as a bogus gap.
  if (recorded.length === 0) g.push('DECISIONS.md: no `### DEC-N: ...` entries parsed');
  for (const d of decs) if (!d.res) g.push(`DECISIONS.md: ${d.id} has no "**Resolution:**" line`);

  // CONTIGUITY — a decision that was ACTED ON but never written down leaves a hole.
  //
  // Measured live: a decision was approved by a coordinator, an agent was dispatched to
  // build it, it was superseded, and it existed ONLY in coordinator-to-agent messages. The
  // highest recorded decision was 24; the dispatched one was 25. The withdrawing agent had
  // to CREATE it in withdrawn form so the reasoning would be findable. It was the fifth
  // unresolvable reference in one round.
  //
  // A hole is mechanically visible without knowing what the decision SAID, which is what
  // makes this the cheapest check that catches the real case. Its limit is worth stating:
  // a decision dispatched as the NEXT number and never recorded leaves no hole at all — the
  // sequence just stops early, and nothing here can see that. The DEC-N REFERENCE check
  // (every DEC-N cited in a lifecycle artifact resolves to a heading here) is the companion
  // that catches that shape; contiguity catches the interior one.
  //
  // Numeric ids only. `DEC-A1` / `DEC-3b` are a real namespacing convention in existing
  // files in both consumer repos, and reading them as members of the numeric sequence would
  // fail artifacts that are already valid — a gate whose first act is to break every
  // in-flight branch does not get adopted, it gets bypassed.
  //
  // POPULATION. This governs exactly ONE file per invocation: `<featureDir>/DECISIONS.md`
  // (see `read`, which joins featureDir). It never scans a tree, so a `DECISIONS.md` that is
  // not a lifecycle artifact — `docs/analysis-workbench/DECISIONS.md` and friends — is out of
  // scope by construction, not by exclusion. Stated because measuring this rule across a
  // filesystem is easy to confuse with what it enforces: a sweep over every `DECISIONS.md` on
  // disk generates failures in files nobody owns, which is not what this gate does.
  //
  // Measured over the population it DOES govern — the live `.lifecycle/*/DECISIONS.md` set,
  // 81 files — 80 pass and 1 carries genuine holes (an early stage worktree that skipped
  // DEC-23/24; the fuller tree of the same feature records both, so it is the multi-owner
  // shape of exactly the defect this catches). Verified by positive control: the neighbours
  // of every reported hole ARE found by the same matcher in the same file.
  // Asserted on the SET of declared ids, and NOT on their uniqueness. Re-using a DEC-N as a
  // later heading is a widespread, legitimate convention in the live population: corrections,
  // amendments, dispositions and WITHDRAWAL RECORDS are appended as their own headings against
  // the id they annotate (`## DEC-11 CORRECTION — …`, `## DEC-6 NOTE — …`, `### DEC-25 (test
  // correction): …`, `## DEC-25 (stage 1's withdrawal record) — …`). An earlier version of
  // this gate rejected duplicates and so fired on precisely the practice the hole check exists
  // to ENCOURAGE — recording a withdrawn decision rather than renumbering over it.
  //
  // Contiguity-on-the-set is immune to that convention (an annotation re-uses an existing id
  // and can never create a hole); a uniqueness check is not. That asymmetry is the reason only
  // holes are checked.
  const nums = recorded.map((id) => /^DEC-(\d+)$/.exec(id)).filter(Boolean).map((m) => parseInt(m[1], 10));
  if (nums.length) {
    const seen = new Set(nums);
    const max = Math.max(...nums);
    const missing = [];
    for (let n = 1; n <= max; n++) if (!seen.has(n)) missing.push(n);
    if (missing.length)
      g.push(`DECISIONS.md: numbering has ${missing.length} hole(s) — DEC-${missing.join(', DEC-')} ${missing.length === 1 ? 'is' : 'are'} referenced by position but never recorded (highest is DEC-${max}). A decision that was approved and DISPATCHED to an implementer but never written here is exactly this shape, and it is unrecoverable once the conversation that carried it ends: record ${missing.length === 1 ? 'it' : 'them'} — including one that was later withdrawn or superseded, in withdrawn form with the reasoning — or renumber so the sequence is contiguous.`);
  }
  // forbidden markers anywhere
  lines.forEach((ln, i) => {
    if (FORBIDDEN_DECISION.test(ln)) g.push(`DECISIONS.md:${i + 1}: forbidden unresolved marker (TBD/TODO/ASK/???): "${ln.trim()}"`);
  });
  return { present: true, gaps: g };
}

//: The `**Unresolved drifts:** <N>` SUMMARY LINE.
//:
//: ANCHORED TO LINE START, and that anchor is load-bearing. This used to be applied to the
//: whole file text with `.exec`, taking the FIRST match anywhere — so a drift ENTRY that
//: QUOTED the summary phrase decided its own file's verdict. Observed: prose quoting the
//: phrase with a `1`, above a real summary of `0`, made the gate report 1 unresolved.
//:
//: That direction fails SAFE. The mirror is why this is a defect rather than a wart: prose
//: quoting the phrase with a `0`, above a REAL summary of `2`, reported GREEN with genuine
//: unresolved drift. A gate that can be spoofed by prose is the same class of bug as a gate
//: that cannot see a file, and "it happened to fail safe for me" is luck, not design.
//:
//: The optional leading whitespace and list marker keep every existing spelling parsing —
//: `**Unresolved drifts:** 0` and `- **Unresolved drifts:** 0` both match, which the
//: selftest pins as a control so the anchor cannot become too strict and silently stop
//: reading real summary lines (that fails CLOSED, but it breaks every consumer).
//:
//: Prose is now safe because it sits MID-LINE inside a `- **DRIFT-N.M** — …` entry: after
//: the anchor consumes an optional marker, the next token must be `unresolved`, and in an
//: entry it is `DRIFT-…`. A line that genuinely BEGINS with the phrase is still read as a
//: summary, which is the correct reading of a line that looks exactly like one.
const RE_UNRESOLVED_DRIFTS = /^[ \t]*(?:[-*+][ \t]+)?\*{0,2}\s*unresolved\s+drifts\s*\*{0,2}\s*:?\s*\*{0,2}\s*(\d+)/gim;

/** The count from a drift file's summary — its LAST anchored summary line, or null.
 *
 * THE LAST, not the first, and that is the third fix in one bug FAMILY: *the gate reading
 * something other than the file's actual conclusion*.
 *
 *   1. the glob could not SEE scoped files             → widened, and every file is checked
 *   2. prose QUOTING the phrase was read as the count  → anchored to line start
 *   3. an APPENDED round leaves an earlier summary
 *      above the real one, and the first won           → this
 *
 * All three were green-when-red. This one was caught by hand on a real artifact whose final
 * summary said 1 unresolved while an earlier stale `0` sat above it: `--phase 5` exited 0 and
 * certified convergence that did not exist.
 *
 * Drift files are APPEND-HEAVY by design — a round is ADDED, not rewritten — so a file
 * carrying several summary lines is the normal case rather than a malformed one, and the
 * file's conclusion is by construction its last word. Reading the first was never right; it
 * only looked right while files had exactly one.
 */
function unresolvedDriftCount(text) {
  const all = [...String(text || '').matchAll(RE_UNRESOLVED_DRIFTS)];
  return all.length === 0 ? null : parseInt(all[all.length - 1][1], 10);
}

function phase5() {
  const g = [];
  const drifts = glob('DRIFT');
  if (drifts.length === 0) return { present: false, gaps: ['no DRIFT-<n>.md files (implement + drift loop not started)'] };
  // Each drift entry needs a recognized verdict.
  //
  // A second, UNANCHORED presence regex used to run here, demanding the digit sit OUTSIDE
  // the bold (`**Unresolved drifts:** 0`) while the parser below accepts that spelling AND
  // `**Unresolved drifts: 0**`. So a file spelled the second way parsed to a correct 0 and
  // was still rejected as missing its summary line.
  //
  // It was REMOVED rather than realigned, and the measurement is why. Compared across every
  // spelling, the presence check contributed ZERO unique rejections: every file it rejected
  // the parser also rejects (no summary at all; the phrase only as mid-line prose), except
  // the two it rejected WRONGLY — the bold spelling above and `* Unresolved drifts: 0`, a
  // second false negative that was never reported. In the other direction the parser is
  // strictly STRICTER: being unanchored, the presence check ACCEPTED a file whose only
  // occurrence of the phrase was inside a `- **DRIFT-N.M** — …` entry, which the anchored
  // parser correctly refuses. The parser's reject-set therefore strictly CONTAINS it.
  //
  // Two predicates for one property is two things to keep in sync, and this pair had
  // already drifted apart — which is the general reason to prefer deleting a redundant
  // check over teaching it to agree. The `n == null` branch below is now the single place
  // a missing summary line is refused, and it names the same requirement in its message.
  for (const d of drifts) {
    const t = read(d.file);
    for (const ln of t.split(/\r?\n/)) {
      if (/^\s*-\s*\*\*DRIFT-/.test(ln) && !RE_DRIFT.test(ln))
        g.push(`${d.file}: drift entry missing verdict (plan-wins|impl-wins|none|resolved): "${ln.trim().slice(0, 80)}"`);
    }
  }
  // CONVERGENCE — every drift file must report 0, not merely the highest-numbered one.
  //
  // This used to read `drifts[drifts.length - 1]` alone. That was already fragile for a
  // single owner (a resolved later round masked an unresolved earlier one) and became a
  // silent hole the moment a feature was split across concurrent owners: with
  // `DRIFT-stage1-5.md` and `DRIFT-stage3-2.md` side by side there is no meaningful
  // "final round", and whichever sorted last decided the verdict for all of them.
  // Reserved number ranges per owner do NOT fix it — a high-numbered file from one owner
  // masks a low-numbered unresolved one from another, which is the same bug wearing a
  // different convention.
  //
  // Checking ALL of them is the actual fix. It is also strictly correct for the
  // single-owner case: an earlier round left unresolved is unresolved, and the round that
  // followed it says nothing about that.
  for (const d of drifts) {
    const n = unresolvedDriftCount(read(d.file));
    if (n == null) g.push(`${d.file}: cannot read unresolved-drift count (needs a "**Unresolved drifts:** <N>" summary line)`);
    else if (n !== 0)
      g.push(`${d.file}: convergence not reached — ${n} unresolved drift(s). EVERY drift file must report 0; a later or higher-numbered round does not discharge an earlier one, and with concurrent owners there is no "final" round at all.`);
  }
  return { present: true, gaps: g };
}

function phase6() {
  const g = [];
  const ledger = parseLedger();
  if (ledger == null) return { present: false, gaps: ['LEDGER.jsonl missing (blind audit not started)'] };
  const bad = ledger.filter((r) => r.__parse_error);
  for (const b of bad) g.push(`LEDGER.jsonl:${b.__parse_error}: not valid JSON`);

  const angles = new Set(ledger.filter((r) => r.angle).map((r) => String(r.angle).toLowerCase()));
  if (angles.size < ANGLE_MIN) g.push(`LEDGER.jsonl: only ${angles.size} distinct angle(s); need >= ${ANGLE_MIN}. Two is the number the evidence supports — and they must differ in KIND (e.g. one adversarial/security, one contract/interface), not be two rewordings of the same reading.`);

  // At least one of the four angles that actually carry the yield must have run.
  // A roster to select from, not a count to satisfy: naming four angles and
  // running none of them is the failure mode a bare count invites.
  if (angles.size && !ANGLE_CORE.some((c) => [...angles].some((a) => a.includes(c))))
    g.push(`LEDGER.jsonl: none of the core angles ran (${ANGLE_CORE.join(', ')}) — those four carried 74% of confirmed HIGH findings across 22 audited features. Ran instead: ${[...angles].join(', ')}.`);

  // A finding becomes WORK only when corroborated by >=2 angles, oracle-confirmed,
  // or high-severity. The union of angles is a candidate pool, not a work list:
  // an LLM reviewer's per-finding precision is low enough that accumulating every
  // angle's output is what makes the fix loop unbounded. Single-angle findings are
  // kept in the ledger and triaged; they are not a reason to keep looping.
  // Migration-safe: only enforced once a ledger opts in by recording ANY of the
  // corroboration fields. A gate that fails every pre-existing ledger would break
  // in-flight branches to enforce bookkeeping, which is the same trade this whole
  // reform is removing. Ledgers without the fields are accepted; the skill asks
  // for them, and this fires only when they are present but nothing qualifies.
  const usesCorroboration = ledger.some((r) => r.corroborated_by !== undefined || r.oracle_confirmed !== undefined || r.promoted !== undefined);
  if (usesCorroboration) {
    const promoted = ledger.filter(isPromotedFinding);
    if (promoted.length === 0)
      g.push('LEDGER.jsonl: records corroboration fields but no finding qualifies as promoted (corroborated_by >= 2, oracle_confirmed, or severity in {security,data-loss,authz,high}) — the fix loop should work from promoted findings, not the raw union of every angle.');
  }

  // RESOLUTION vocabulary. Opt-in, exactly like corroboration above: a ledger that records
  // no `resolution` anywhere is never failed for lacking one, so every pre-existing file in
  // both consumer repos keeps passing. A row that DOES record one is held to the vocabulary,
  // because the failure mode of a typo here is silent and one-directional — an unrecognised
  // word is not `open`, so the row drops out of the open set and the finding is lost.
  ledger.forEach((r, i) => {
    if (r.__parse_error || r.resolution_state === undefined || r.resolution_state === null || r.resolution_state === '') return;
    const res = resolutionOf(r);
    const line = i + 1;
    if (res !== RESOLUTION_OPEN && !RESOLUTION_CLOSED.includes(res)) {
      g.push(`LEDGER.jsonl:${line}: unknown resolution_state "${r.resolution_state}" — must be one of ${RESOLUTION_OPEN}, ${RESOLUTION_CLOSED.join(', ')}. An unrecognised value is not treated as open, so a typo here silently DELETES a real finding from the open set.`);
      return;
    }
    const need = RESOLUTION_NEEDS_REF[res];
    if (need && !String(r[need] ?? '').trim())
      g.push(`LEDGER.jsonl:${line}: resolution "${res}" requires a \`${need}\` referent (a commit sha, DEC-N, or finding id). ${res === 'superseded'
        ? 'A superseded finding is the dangerous one: it was CORRECT when filed and was inverted by a later change, so it still reads as true and survives re-reading. Without a pointer to what superseded it, the next implementer acts on it and reverts that fix.'
        : 'A bare "fixed" is an unauditable claim — the referent is what lets the next reader confirm it instead of re-verifying the finding from scratch.'}`);
  });
  return { present: true, gaps: g };
}

// ---------------------------------------------------------------------------
// T1 — capture-recapture estimate of the defects REMAINING.
// ---------------------------------------------------------------------------
// The inspection literature never terminates on an observation ("a round found
// 0"); it terminates on an ESTIMATE of what is still in the artifact. With two
// angles per round we already record the one input that estimate needs — the
// OVERLAP between them (`corroborated_by`) — and until now we threw it away.
//
// Two samples ⇒ Lincoln-Petersen: N̂ = n1·n2/m. LP is badly biased upward (and
// undefined) at small m, so we use the CHAPMAN correction, which is
// near-unbiased for small samples and defined at m = 0:
//
//     N̂ = (n1+1)(n2+1)/(m+1) − 1
//
//   n1 = findings angle A reported   n2 = findings angle B reported
//   m  = findings BOTH reported (a row with corroborated_by >= 2)
//
// remaining = N̂ − observed. We then scale by the observed promoted fraction to
// get the quantity the loop actually cares about: estimated remaining PROMOTED
// defects. Terminate when that is < 1 — i.e. the model says there is less than
// one real defect left to find, so another round buys reviewer noise.
//
// ASSUMPTIONS — and they are NOT satisfied here. State them plainly:
//   1. EQUAL CATCHABILITY: every defect is equally likely to be caught. False —
//      defects vary enormously in obviousness, and heterogeneous catchability
//      biases N̂ DOWNWARD (the easy defects are over-represented in the overlap,
//      which inflates m, which shrinks N̂).
//   2. INDEPENDENCE of the two samples. Also false, and worse here than in the
//      human-inspection studies the model comes from: our two "angles" are two
//      PROMPTS TO ONE MODEL. They share weights, training data, and whatever the
//      diff makes salient, so they co-miss the same defects and co-find the same
//      defects. Positive dependence inflates m ⇒ deflates N̂.
//   Both errors point the SAME way: this estimate is biased LOW. It is a floor
//   on remaining defects, not a measurement, and it is why T1 is an ADDITIONAL
//   termination condition (satisfied OR the decay rule) rather than a
//   replacement for one — and why the guard-substitution tripwire and the
//   round cap still apply on top of it.
//
// Small-sample floor: below these counts the estimator's variance swamps its
// value, so we decline to estimate rather than guess. The decay rule then
// decides alone — which is also what happens for any ledger that does not
// record `corroborated_by` at all (every pre-existing one). T1 can only ever
// ADD a way to terminate; it can never fail a branch.
const T1_MIN_OBSERVED = 5;   // distinct findings in the scoped round
const T1_MIN_OVERLAP = 2;    // findings both angles reported
// A finding becomes WORK (see phase 6) when corroborated by >=2 angles,
// oracle-confirmed, or high-severity. One predicate, used by phase 6 and T1.
function isPromotedFinding(r) {
  return r.promoted === true
    || Number(r.corroborated_by) >= 2
    || r.oracle_confirmed === true
    || /^(security|data-loss|authz|high)$/i.test(String(r.severity || ''));
}
// ---------------------------------------------------------------------------
// TRIAGE vs RESOLUTION — two orthogonal axes that were one overloaded field.
// ---------------------------------------------------------------------------
// `status: "confirmed"` answers "is this a REAL finding?" — a TRIAGE verdict, settled once
// at audit time and never revisited. It does NOT answer "is this STILL TRUE?", and nothing
// ever wrote an answer to that second question back. So an open-set derived from the ledger
// over-counts silently, and a stale entry is indistinguishable from a live one.
//
// Three staleness modes were measured on one real stage's tail, all found only by verifying
// each finding against the code before working it:
//   ALREADY FIXED       — 6 of ~20, including the only high-severity item.
//   COUNT OVER-STATED   — one finding claimed five untested branches; three were real, six
//                         had acquired tests between filing and reading.
//   SUPERSEDED          — correct when filed and INVERTED by a later change. This is the one
//                         with teeth: it is still true AS WRITTEN, so it survives re-reading,
//                         and acting on it UNDOES the fix that superseded it.
//
// The fix is a second field, not a wider vocabulary on the first — collapsing them is what
// made "confirmed" ambiguous in the first place. `triage` is the immutable verdict;
// `resolution_state` is the mutable state.
//
// THE NAME IS `resolution_state`, NOT `resolution`, AND THAT IS NOT COSMETIC. `resolution`
// is ALREADY IN USE in real ledgers as a FREE-TEXT prose field ("commit e607672e1: the tools
// picker was removed from…") — 112 rows across 7 files in the two consumer repos. Validating
// a vocabulary on that name would have failed 100% of them. `disposition` (179 rows) is
// likewise taken. The name was chosen by measuring the actual field namespace across 13,799
// real rows rather than by picking the obvious word, which is the only way to know.
//
// The same measurement showed `fix` (337 rows), `round_fixed` (67) and even
// `fixed_in_round_3` (32) already in the wild: the need this field serves is real and people
// had been inventing ad-hoc, mutually-incompatible spellings for it. That is the argument for
// one named field with a checked vocabulary rather than prose.
//
// MIGRATION. Both consumer repos carry hundreds of ledgers written with `status` and no
// resolution state at all. Every reader below falls back `triage ?? status ?? verdict`, and
// an absent `resolution_state` means `open` — so an existing file parses unchanged and keeps
// the exact behaviour it has today. Enforcement is opt-in on the same principle phase 6
// already uses for `corroborated_by`: a ledger that never records a `resolution_state` is
// never failed for lacking one. Only a row that DOES record one is held to the vocabulary.
const RESOLUTION_OPEN = 'open';
const RESOLUTION_CLOSED = ['fixed', 'superseded', 'obsolete', 'wontfix'];
// A closed state whose claim is unauditable without a referent. `superseded` is the sharp
// one — without a pointer to what superseded it, the row reads as a live, still-literally-
// true finding and the next implementer reverts the fix. Requiring the pointer is what makes
// the dangerous state safe to store, rather than a thing to detect afterwards.
const RESOLUTION_NEEDS_REF = { fixed: 'fixed_in', superseded: 'superseded_by' };

/** The immutable triage verdict, honouring the legacy `status`/`verdict` spellings. */
function triageOf(r) {
  return String(r.triage ?? r.status ?? r.verdict ?? '');
}
/** The mutable resolution state. Absent ⇒ `open`, which is what every legacy row means. */
function resolutionOf(r) {
  const v = r.resolution_state;
  return v === undefined || v === null || v === '' ? RESOLUTION_OPEN : String(v).trim().toLowerCase();
}
// A ledger row that records a REAL finding (not one the reviewer withdrew).
function isRejectedFinding(r) {
  return /^\s*(rejected|false[-\s]?positive|dismissed|invalid|not[-\s]a[-\s]bug|no[-\s]finding)/i
    .test(triageOf(r));
}
/** A real finding that is STILL LIVE — the set the fix loop should actually work from. */
function isOpenFinding(r) {
  return !isRejectedFinding(r) && resolutionOf(r) === RESOLUTION_OPEN;
}
// Scope the ledger to the round the estimate is about: the highest explicit
// `round` if the ledger carries one, else the whole file (the phase-6 case).
function scopedLedgerRound() {
  const ledger = parseLedger();
  if (!ledger) return null;
  const rows = ledger.filter((r) => !r.__parse_error);
  const nums = rows.map((r) => Number(r.round)).filter((n) => Number.isFinite(n));
  if (!nums.length) return { rows, round: null, label: 'the whole ledger' };
  const last = Math.max(...nums);
  return { rows: rows.filter((r) => Number(r.round) === last), round: last, label: `round ${last}` };
}
function t1Estimate() {
  const scope = scopedLedgerRound();
  if (!scope) return { ok: false, why: 'LEDGER.jsonl is missing' };
  const found = scope.rows.filter((r) => !isRejectedFinding(r));
  if (!found.some((r) => r.corroborated_by !== undefined))
    return { ok: false, why: `no finding in ${scope.label} records \`corroborated_by\`` };
  const angles = [...new Set(found.map((r) => String(r.angle || '').toLowerCase()).filter(Boolean))];
  if (angles.length !== 2)
    return { ok: false, why: `a two-sample estimate needs exactly 2 angles; ${scope.label} has ${angles.length} (${angles.join(', ') || 'none'})` };
  let m = 0, sA = 0, sB = 0;
  for (const r of found) {
    if (Number(r.corroborated_by) >= 2) m++;
    else if (String(r.angle || '').toLowerCase() === angles[0]) sA++;
    else sB++;
  }
  const observed = m + sA + sB;
  const n1 = m + sA, n2 = m + sB;
  if (observed < T1_MIN_OBSERVED || m < T1_MIN_OVERLAP)
    return { ok: false, why: `${scope.label} has ${observed} finding(s) with ${m} corroborated — below the small-sample floor (>=${T1_MIN_OBSERVED} observed, >=${T1_MIN_OVERLAP} overlapping) at which a two-sample estimate carries information` };
  const nHat = ((n1 + 1) * (n2 + 1)) / (m + 1) - 1;        // Chapman
  const remaining = Math.max(0, nHat - observed);
  const promotedFrac = observed ? found.filter(isPromotedFinding).length / observed : 0;
  const remainingPromoted = remaining * promotedFrac;
  return {
    ok: true, scope: scope.label, angles, n1, n2, m, observed, nHat, remaining, promotedFrac, remainingPromoted,
    satisfied: remainingPromoted < 1,
  };
}
function t1Note(t1) {
  if (!t1.ok) return `T1 (capture-recapture) not estimable — ${t1.why}; the decay rule decides alone.`;
  return `T1 (capture-recapture, ${t1.scope}): n1=${t1.n1} n2=${t1.n2} overlap=${t1.m} → Chapman N̂=${t1.nHat.toFixed(1)} vs ${t1.observed} observed ⇒ ~${t1.remaining.toFixed(1)} defect(s) unfound, ~${t1.remainingPromoted.toFixed(2)} of them promotable. ${t1.satisfied ? 'SATISFIED (< 1).' : 'not satisfied (>= 1).'} Biased LOW — two prompts to one model are not independent samples.`;
}

// ---------------------------------------------------------------------------
// Guard-substitution tripwire — a concentration measure, not another decay test.
// ---------------------------------------------------------------------------
// When most of a round's findings land on ONE test/guard file, the loop has
// stopped auditing the feature and started playing whack-a-mole with a guard.
// The real case: one feature's rounds 13-17 put 46 of 59 findings on a single
// hand-written AST source-guard; round 17 was 21 of 22. The correct action is to
// REPLACE the syntactic guard with a behavioural test — a guard that
// pattern-matches a SEMANTIC property has an unbounded evasion space, so zero
// findings is unreachable by construction and each round just finds another
// spelling.
//
// This is NOT redundant with the decay rule, and the same feature proves it: at
// its round 12 the concentration was 8 of 9 (89%) on that guard while the
// profile was still DECAYING — the decay rule said "converging fine" and the
// abort did not fire for another five rounds. Concentration detects the wrong
// KIND of work; decay only detects the wrong RATE of it.
//
// Opt-in on data presence: needs per-round attribution (`round` + `file` on the
// ledger rows). A ledger without it is not guessed at.
const GUARD_CONCENTRATION = 0.60;
const GUARD_MIN_FINDINGS = 5;   // below this, a "share" is noise
const GUARD_MIN_ROUND = 2;      // round 1 may legitimately concentrate on the new tests
// Only a TEST or GUARD file triggers this. A round concentrating on the one
// source file the feature is building is normal and must not fire.
const RE_GUARD_FILE = /(?:^|\/)tests?\/|[._-](?:test|spec)\.[cm]?[jt]sx?$|_test\.rs$|(?:^|\/)tests\.rs$|guard/i;
function checkGuardSubstitution() {
  const scope = scopedLedgerRound();
  if (!scope || scope.round == null || scope.round < GUARD_MIN_ROUND) return { gaps: [], note: null };
  const found = scope.rows.filter((r) => !isRejectedFinding(r) && r.file);
  if (found.length < GUARD_MIN_FINDINGS) return { gaps: [], note: null };
  const byFile = new Map();
  for (const r of found) byFile.set(String(r.file), (byFile.get(String(r.file)) || 0) + 1);
  const [file, n] = [...byFile.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = n / found.length;
  const pct = Math.round(share * 100);
  if (share < GUARD_CONCENTRATION)
    return { gaps: [], note: `guard-substitution tripwire: silent — ${scope.label}'s top file holds ${n}/${found.length} (${pct}%) findings (${file}), under the ${Math.round(GUARD_CONCENTRATION * 100)}% concentration threshold.` };
  if (!RE_GUARD_FILE.test(file))
    return { gaps: [], note: `guard-substitution tripwire: silent — ${scope.label} is ${pct}% concentrated on ${file}, but that is a SOURCE file, not a test/guard. Concentrating on the code under construction is normal work.` };
  return {
    gaps: [`GUARD-SUB: ${pct}% of ${scope.label}'s confirmed findings (${n}/${found.length}) target ONE test/guard file — \`${file}\`. STOP the loop and escalate: the audit is no longer finding defects in the feature, it is finding evasions of a guard. A guard that pattern-matches a SEMANTIC property has an unbounded evasion space, so 0 findings is unreachable by construction and each round yields another spelling. Replace it with a test that asserts the BEHAVIOUR the guard was standing in for, then restart the loop against the new artifact — do NOT write another predicate.`],
    note: null,
  };
}

// Phase 7 termination. "Repeat until a round yields 0" is UNSOUND: a reviewer
// with a non-zero false-positive rate has a non-zero chance of emitting a
// finding on any round, so the expected number of rounds to a zero-round is
// unbounded. That rule produced a real 17-round run here. The inspection
// literature terminates on an ESTIMATE, never on a single observation, and every
// defect-estimation model assumes a DECREASING detection profile — so a flat or
// rising profile falsifies the model rather than meaning "converging slowly".
//
// Outcomes: converged (0 + a decaying profile) · ABORT (non-decaying → re-scope,
// do NOT keep looping) · CAP (escalate to a human) · still-looping.
const FIX_LOOP_ABORT_MIN_ROUND = 5;  // never abort before this: findings can legitimately ramp late (one feature went 0 -> 15 at round 2)
const FIX_LOOP_ROUND_CAP = 6;
function phase7() {
  const g = [];
  const notes = [];
  const rounds = glob('FIX_ROUND');
  if (rounds.length === 0) return { present: false, gaps: ['no FIX_ROUND-<n>.md files (fix/re-audit loop not started)'] };

  // The widened glob (see `glob`) also matches scoped files like `FIX_ROUND-stage2-1.md`.
  // Unlike phase 5's convergence check, everything below reads a SEQUENCE — the decay
  // profile, the round index, the capture-recapture estimate — and interleaving several
  // owners' rounds into one profile produces a number that describes nobody's work.
  // Refuse by name rather than compute a meaningless verdict. (Deliberately NOT silently
  // fixed by picking one scope: which owner's loop the gate is judging is a decision for
  // whoever split the feature, not for this function.)
  const scopes = globScopes(rounds);
  if (scopes.length > 1) {
    return {
      present: true,
      gaps: [
        `FIX_ROUND files span ${scopes.length} scopes (${scopes.map((s) => s || '<unscoped>').join(', ')}) — phase 7 reads a decay PROFILE, and a capture-recapture estimate stitched from several owners' loops is a number with no referent. RUN PHASE 7 PER-BRANCH: each stage owner runs phases 6/7 on their OWN branch, where only their own scope's files exist, so the estimator always sees one coherent sequence. The multi-scope case only arises AFTER stages merge, and the answer there is a FRESH audit round on the merged tree — not an attempt to reconcile three interleaved loops.`,
      ],
    };
  }

  const profile = [];
  for (const r of rounds) {
    const m = /new confirmed findings\s*:?\s*\*{0,2}\s*(\d+)/i.exec(read(r.file) || '');
    profile.push(m ? parseInt(m[1], 10) : null);
  }
  const last = rounds[rounds.length - 1];
  if (profile[profile.length - 1] == null) {
    g.push(`${last.file}: missing "**New confirmed findings:** <N>" summary line`);
    return { present: true, gaps: g, notes };
  }

  const known = profile.filter((n) => n != null);
  const fr = profile[profile.length - 1];
  const r = profile.length;

  // Guard-substitution tripwire — runs in BOTH tiers and regardless of the
  // profile shape: it is the one signal that says the loop is auditing the
  // wrong artifact, and it fires while the decay rule still reads "converging".
  const guard = checkGuardSubstitution();
  for (const x of guard.gaps) g.push(x);
  if (guard.note) notes.push(guard.note);

  // T1 — the estimate. Recorded on every run so the number is visible whether or
  // not it fires, and so a ledger that cannot support one says why.
  const t1 = t1Estimate();
  notes.push(t1Note(t1));

  // OPEN SET — the count the fix loop should actually work from, printed so the difference
  // between "findings filed" and "findings still live" is visible instead of assumed. This
  // is the whole point of the resolution field: before it, every confirmed row read as open
  // forever, so the remaining-work number silently over-counted and a stale entry looked
  // exactly like a live one. Informational — it never fails a branch.
  const lrows = (parseLedger() || []).filter((r) => !r.__parse_error);
  if (lrows.length) {
    const real = lrows.filter((r) => !isRejectedFinding(r));
    const open = real.filter(isOpenFinding);
    const closed = real.length - open.length;
    if (closed > 0) {
      const by = {};
      for (const r of real) if (!isOpenFinding(r)) by[resolutionOf(r)] = (by[resolutionOf(r)] || 0) + 1;
      notes.push(`open set: ${open.length} of ${real.length} confirmed finding(s) still open (${closed} closed — ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}). Work the OPEN set; a closed row is kept as record, not as remaining work.`);
    } else {
      notes.push(`open set: ${open.length} of ${real.length} confirmed finding(s) still open (none marked resolved). If findings have been fixed since filing, record \`resolution\` on them — an unmarked ledger cannot distinguish a live finding from one that was fixed, over-stated, or superseded by a later change.`);
    }
  }

  // Decay test over the trailing window: the final round must be below the
  // median of what came before. Cheap, and it is the one rule that separates the
  // features that converged legitimately from the one that never could.
  const prior = known.slice(0, -1);
  const median = (a) => { if (!a.length) return Infinity; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const decaying = prior.length < 2 || fr < median(prior);

  // LIGHT track: one completed audit round is the requirement. A change with no
  // blast radius does not earn a re-audit round that finds nothing — that round
  // is pure cost on the 17-of-22 features that were already going to stop here.
  // Only relaxes at exactly one round; a LIGHT feature that chose to keep going
  // has the profile data, so the normal rules judge it.
  const tier = classifyTier();
  if (tier.tier === 'LIGHT' && r === 1) {
    notes.push(`LIGHT track: ONE completed audit round satisfies phase 7 (${fr} finding(s) recorded in ${last.file}; fix them in-round). Every deterministic hardening check still applies.`);
    return { present: true, gaps: g, notes };
  }

  // A flat-or-rising profile at round >= 5 is the ABORT state: it falsifies the
  // decreasing-detection assumption that EVERY defect-estimation model rests on
  // — including T1's. So T1 may NOT rescue it. An estimate computed from a model
  // the data has already contradicted is not evidence; using it here would
  // convert the one outcome the loop gained ("this artifact was not ready for
  // audit") back into a silent pass. T1 may override the round CAP (that is a
  // budget, and an estimate is exactly the right thing to spend it against), but
  // never the ABORT.
  const abortState = r >= FIX_LOOP_ABORT_MIN_ROUND && !decaying;

  if (fr === 0) {
    // Converged. Only flag the shape when there was enough history to judge it.
    if (!decaying && prior.length >= 3 && !(t1.ok && t1.satisfied))
      g.push(`${last.file}: reached 0 findings but the profile did not decay (${known.join(', ')}) — a single zero round is an observation, not an estimate. Confirm the round genuinely re-audited the current diff before treating this as converged.`);
    return { present: true, gaps: g, notes };
  }

  // T1 termination: the estimate says under one promotable defect remains, so
  // another round buys reviewer noise. Additive to the decay rule, never a
  // replacement — see the assumptions above (this number is biased LOW).
  if (t1.ok && t1.satisfied && !abortState) {
    notes.push(`T1 SATISFIED — terminating with ${fr} finding(s) in the final round (profile ${known.join(', ')}): the estimate, not the observation, is the termination criterion. Fix this round's findings; do not run another round to watch it read 0.`);
    return { present: true, gaps: g, notes };
  }
  if (t1.ok && t1.satisfied && abortState)
    notes.push('T1 is SATISFIED but IGNORED: the profile is flat/rising, which falsifies the decreasing-detection model the estimate itself assumes. A non-decaying profile is an ABORT, not a convergence.');

  if (abortState) {
    g.push(`${last.file}: fix loop is NOT CONVERGING and must be ABORTED, not continued — profile (${known.join(', ')}) is flat or rising after ${r} rounds, which falsifies the assumption every defect-estimation model rests on. Do not run another round. Re-scope instead: record the reason the artifact was not ready for audit (commonly a hand-written static-analysis guard standing in for a behavioural test — its evasion space is unbounded, so 0 is unreachable), replace it, and restart the loop against the new artifact.`);
  } else if (r >= FIX_LOOP_ROUND_CAP) {
    g.push(`${last.file}: fix loop hit the ${FIX_LOOP_ROUND_CAP}-round cap with ${fr} finding(s) still open (profile ${known.join(', ')}) — escalate to a human rather than iterating. Past this point the marginal yield is dominated by reviewer false positives.`);
  } else {
    g.push(`${last.file}: fix loop not converged — ${fr} new confirmed finding(s) in the final round`);
  }
  return { present: true, gaps: g, notes };
}

function phase8() {
  const g = [];
  const t = read('TEST_RESULTS.md');
  if (t == null) return { present: false, gaps: ['TEST_RESULTS.md missing'] };
  // A2: clean working tree — no uncommitted load-bearing files at phase 8.
  const dirty = dirtyWorkingTree();
  if (dirty.length)
    // Strip the porcelain status prefix by PATTERN, not a fixed offset: git()
    // trims its output, which eats the leading space of a first line like
    // " M sdk" — a slice(3) then reported the path as "dk" and sent a reader
    // hunting a file that does not exist.
    g.push(`A2: working tree not clean at phase 8 — uncommitted/untracked: ${dirty.slice(0, 10).map((l) => l.replace(/^\s*[MADRCU?!]{1,2}\s+/, '')).join(', ')}${dirty.length > 10 ? ', …' : ''}. Commit or remove before declaring done (load-bearing files must be on the branch).`);
  // A3/A4/A8/A9/A10 + R2-5: diff-content gates.
  for (const x of checkA3()) g.push(x);
  for (const x of checkA4()) g.push(x);
  for (const x of checkA8()) g.push(x);
  for (const x of checkA9()) g.push(x);
  for (const x of checkA10Enumeration()) g.push(x); // A10: restricted-user e2e must be enumerated
  for (const x of checkR2_5()) g.push(x);
  const tests = parseTests();
  if (!tests) return { present: true, gaps: ['TESTS.md missing — cannot verify results'] };
  const results = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_RESULT.exec(ln);
    if (m) results.set(m[1], m[2].toUpperCase());
  }
  for (const x of checkA10Passing(results)) g.push(x); // A10: restricted-user e2e must PASS
  for (const x of checkA11(results)) g.push(x); // A11: a PASS must be earned by THIS branch
  // Every [acceptance] test (a design-invariant proof) must PASS — not merely be
  // enumerated. Named explicitly so a dropped/soft invariant proof is unmissable
  // (redundant with the all-tests-PASS loop, but with a design-fidelity message).
  for (const at of tests.filter((t) => t.acceptance)) {
    const r = results.get(at.id);
    if (r !== 'PASS') g.push(`TEST_RESULTS.md: acceptance test ${at.id} (design invariant ${at.invariants.join(', ') || '?'}) is ${r || 'missing'}, not PASS — a design invariant is unproven; run it and record PASS.`);
  }
  for (const test of tests) {
    const r = results.get(test.id);
    if (!r) g.push(`TEST_RESULTS.md: ${test.id} (from TESTS.md) has no result line`);
    else if (r !== 'PASS') g.push(`TEST_RESULTS.md: ${test.id} is ${r}, not PASS`);
  }
  // Frontend-touching branches: require `npm run check` per touched workspace
  // (that ONE command chains tsc + biome guardrails + lint:colors +
  // lint:settings-field + check:kit-manifest + check:testid-registry +
  // check:design-spec + check:gallery-coverage + check:state-matrix) AND require
  // every enumerated e2e-tier spec to have run green. Backend-only diffs keep
  // just the cargo TEST-ID chain above.
  const feWs = diffFrontendWorkspaces();
  if (feWs.size > 0) {
    const checked = new Map();
    for (const ln of t.split(/\r?\n/)) {
      const m = RE_UI_CHECK.exec(ln);
      if (m) checked.set(m[1].trim().toLowerCase(), m[2].toUpperCase());
    }
    for (const w of feWs) {
      const v = checked.get(w.toLowerCase());
      if (!v) g.push(`TEST_RESULTS.md: frontend workspace "${w}" was touched but no "npm run check (${w}): PASS" line is present (tsc + biome guardrails + lint:colors/settings-field + check:kit-manifest/testid-registry/design-spec/gallery-coverage/state-matrix). A6: the gallery + gate:ui + runtime-health IS the browser-verify harness — "I can't verify in a browser" is NOT a valid gap; run it against the mock-API gallery build.`);
      else if (v !== 'PASS') g.push(`TEST_RESULTS.md: "npm run check (${w})" is ${v}, not PASS.`);
    }
    // A7: boot/runtime canary — baseline-controlled (branch no worse than base).
    const canary = parseCanaryLines(t);
    // Only PASTED OUTPUT can contradict a recorded result. Narrative prose about
    // earlier red runs cannot — and treating it as contradiction PUNISHES HONEST
    // DISCLOSURE: an author who hides four failed attempts passes, one who
    // documents them fails. That is exactly backwards, and it fired on a real
    // branch whose only offence was explaining why the gate had failed before it
    // passed. So scan fenced code blocks only, which is where pasted gate output
    // lives; the `cmd | tail` artifact this catches is always pasted output.
    const contradicted = (() => {
      const lines = t.split(/\r?\n/);
      let inFence = false;
      for (const ln of lines) {
        if (/^\s*```/.test(ln)) { inFence = !inFence; continue; }
        if (inFence && RE_GATE_FAILED_MARKER.test(ln)) return ln;
      }
      return undefined;
    })();
    for (const w of feWs) {
      const v = canary.get(w.toLowerCase());
      if (!v) {
        g.push(`A7: TEST_RESULTS.md: no boot/runtime canary line for "${w}" — record either "gate:ui (${w}): PASS" or the baseline-controlled form "gate:ui (${w}): branch <N> vs base <M>" (branch must be no worse than base). Run runtime-health boot + console-error + ErrorBoundary against the REAL prod build, BEFORE the specs; a green e2e can still ship a non-booting app or a root crash on an un-exercised path.`);
      } else if (!v.ok) {
        g.push(v.comparative
          ? `A7: TEST_RESULTS.md: "gate:ui (${w})" records ${v.how} — the branch is WORSE than its base. A7 is a controlled comparison, not an absolute bar: you do not have to beat a loaded box, but you may not regress against the base you branched from.`
          : `A7: TEST_RESULTS.md: "gate:ui (${w})" is ${v.how}, not PASS. If the absolute gate is unreachable on this box, record the baseline-controlled form instead ("gate:ui (${w}): branch <N> vs base <M>") — measured against the SAME box, back-to-back.`);
      } else if (contradicted && !v.comparative) {
        // The false-PASS catch: a recorded pass contradicted by pasted output in
        // the same file. `cmd | tail` reports tail's exit code, not cmd's.
        //
        // Scoped to the ABSOLUTE form deliberately. "PASS" claims zero findings,
        // so pasted FAILED output flatly contradicts it. A COMPARATIVE line
        // ("branch 3 vs base 5") already ADMITS findings — a gate that exits
        // non-zero on both runs is exactly what that line describes, so firing
        // there would punish the honest record and push authors back onto the
        // absolute form this reform is trying to relieve.
        g.push(`A7: TEST_RESULTS.md records a passing canary for "${w}" (${v.how}) but the SAME file contains gate output reading FAILED: "${contradicted.trim().slice(0, 100)}". A recorded PASS contradicted by its own pasted output is a pipeline artifact, not a result — \`cmd | tail\` exits with tail's status. Re-run the gate capturing the command's OWN exit code (\`set -o pipefail\`, or read \`\${PIPESTATUS[0]}\`) and record what it actually returned.`);
      }
    }
    const e2e = tests.filter((tt) => tt.tier === 'e2e');
    if (e2e.length === 0) {
      g.push('TEST_RESULTS.md: frontend touched but TESTS.md enumerates no e2e-tier test (phase 3 should have blocked this) — enumerate + run the user-visible flow specs.');
    }
    for (const et of e2e) {
      const r = results.get(et.id);
      if (r !== 'PASS') g.push(`TEST_RESULTS.md: e2e spec ${et.id} is ${r || 'missing'}, not PASS — run "npx playwright test <spec> --workers=1".`);
    }
  }
  return { present: true, gaps: g };
}

// Phase 9 — HUMAN_FEEDBACK.md (merge-readiness gate; PENDING until human review).
// The session records every human critique verbatim + its resolution here. The
// gate is PENDING (not fail) while the file is absent — a feature can be 8/8 and
// still awaiting human review. It FAILS once the file exists with an unresolved
// [status: open] item, and requires either ≥1 FB entry or an explicit "no human
// feedback received" statement (so absence is a deliberate claim, not an
// oversight). At merge, the orchestrator reads this file and folds every
// [generalizable: yes] item into the lifecycle skill.
function phase9() {
  const t = read('HUMAN_FEEDBACK.md');
  if (t == null)
    return {
      present: false,
      gaps: [
        'HUMAN_FEEDBACK.md missing — record each human critique + resolution before merge, or state "no human feedback received"',
      ],
    };
  const g = [];
  const RE_FB = /^\s*-\s*\*\*FB-\d+\*\*\s*\[status:\s*(open|resolved|wontfix)\]/i;
  const open = [];
  let count = 0;
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_FB.exec(ln);
    if (m) {
      count++;
      if (m[1].toLowerCase() === 'open') open.push(ln.trim().slice(0, 90));
    }
  }
  if (open.length)
    g.push(
      `HUMAN_FEEDBACK: ${open.length} item(s) still [status: open] — resolve (or mark wontfix with rationale) before merge: ${open[0]}`,
    );
  if (count === 0 && !/no\s+human\s+feedback\s+received/i.test(t))
    g.push(
      'HUMAN_FEEDBACK.md has no FB-N entries and no explicit "no human feedback received" statement — state one or the other',
    );
  return { present: true, gaps: g };
}

const PHASES = [null, phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9];
const PHASE_NAMES = [
  '', 'PLAN', 'PLAN_AUDIT', 'TESTS', 'DECISIONS',
  'IMPLEMENT+DRIFT', 'BLIND_AUDIT', 'FIX_LOOP', 'TEST_RESULTS', 'HUMAN_FEEDBACK',
];

// ---------------------------------------------------------------------------
// runners
// ---------------------------------------------------------------------------
function runOne(n) {
  const r = PHASES[n]();
  return { n, name: PHASE_NAMES[n], ...r };
}

// `exempt` — under `--wip`, the ONE phase the branch is currently working. Its gaps are
// printed in full (they are the author's own worklist) but do not fail the run. Every other
// phase behaves exactly as under `--all`.
function report(results, exempt = null) {
  let anyFail = false;
  for (const r of results) {
    const inProgress = exempt != null && r.n === exempt;
    const status = !r.present ? 'PENDING' : r.gaps.length === 0 ? 'OK' : inProgress ? 'IN-PROGRESS' : 'FAIL';
    const glyph = status === 'OK' ? '✓' : status === 'PENDING' ? '·' : status === 'IN-PROGRESS' ? '~' : '✗';
    process.stdout.write(`  ${glyph} phase ${r.n} ${r.name.padEnd(16)} ${status}\n`);
    // Notes are INFORMATIONAL — the estimate, the tier, the concentration
    // measure. They never fail a phase; they exist so the numbers a gate decided
    // on are visible instead of implicit.
    for (const n of r.notes || []) process.stdout.write(`      · ${n}\n`);
    if (r.gaps.length) {
      for (const gap of r.gaps) process.stdout.write(`      - ${gap}\n`);
      if (r.present && !inProgress) anyFail = true;
    }
  }
  return anyFail;
}

const TIER = classifyTier();
process.stdout.write(`lifecycle-check  feature=${featureDir.replace(repo + '/', '')}  base=${baseRef}  tier=${TIER.tier}\n`);
process.stdout.write(`  tier ${TIER.tier}: ${TIER.reasons.join('; ')}\n`);

// `--all` (whole-feature) and `--wip` (mid-round) share one runner and differ in exactly one
// rule, spelled out at FRONTIER below.
//
// WHY `--wip` EXISTS. The pre-push hook ran `--all` on every push. Contrary to the obvious
// diagnosis, `--all` does NOT demand all nine phases — a PENDING phase never sets the
// failure flag, so a clean tree at phase 5 passes it today. The real blocker is narrower:
// the moment you SCAFFOLD the next phase's artifact (an empty `LEDGER.jsonl` as you begin
// phase 6, a `HUMAN_FEEDBACK.md` stub) that phase becomes `present`, and a present phase
// with gaps is fatal — as is the contiguity rule if the scaffolded phase sits above a
// PENDING one. Writing the first byte of the next phase makes the branch unpushable until
// that phase is finished.
//
// That is why every mid-round push in the last round used `--no-verify`. Those pushes were
// honest and named their failing gates, but a gate that cannot pass teaches people to
// bypass it reflexively, and then it is not there on the day it would have caught
// something. A guard everyone routes around is worse than no guard: it still reads as
// protection. The fix is not to weaken the gate but to let an honest mid-round push pass
// honestly.
//
// `--all` is left BYTE-FOR-BYTE unchanged in behaviour, so the merge path, CI, and the
// orchestrator's pre-merge step keep demanding everything and no existing caller shifts.
function runAll({ wip }) {
  const results = [];
  const glob = checkA1(); // A1 runs globally, regardless of --dir
  if (glob.length) results.push({ n: 0, name: 'GLOBAL', present: true, gaps: glob });
  for (let n = 1; n <= 9; n++) results.push(runOne(n));

  // FRONTIER — the phase the branch is currently working: the top of the CONTIGUOUS run of
  // phases that have artifacts, counting from 1. Deliberately NOT "the lowest phase with
  // gaps", which would make a REGRESSION in an already-completed phase excuse itself: break
  // phase 3 while working at phase 6 and phase 3 would become the frontier and be waived.
  // Presence is progress; gaps are quality. The frontier is read from progress alone, and
  // then quality is demanded of everything below it.
  const phases = results.filter((r) => r.n >= 1);
  let frontier = 0;
  for (const r of phases) { if (!r.present) break; frontier = r.n; }
  // A COMPLETE feature (artifacts for all nine) has no phase left to be "in progress", so
  // the exemption switches itself off and the final push demands everything — the property
  // that must survive this change.
  const exempt = wip && frontier > 0 && frontier < 9 ? frontier : null;

  const anyFail = report(results, exempt);
  // Contiguity: no completed (present & OK) phase may sit above a PENDING one — a phase with
  // artifacts above a hole means a gate was skipped. Under --wip this is only a WARNING: the
  // usual cause mid-round is a scaffolded later-phase file, which is untidy, not unsound.
  // The phases below the frontier are still fully gated, so nothing is waved through.
  let sawPending = false;
  let gap = false;
  for (const r of phases) {
    if (!r.present) { sawPending = true; continue; }
    if (sawPending) {
      gap = true;
      process.stdout.write(`  ${wip ? '·' : '!'} phase ${r.n} ${r.name} has artifacts but an earlier phase is PENDING (gate skipped)${wip ? ' — tolerated under --wip; it must be contiguous before merge' : ''}\n`);
    }
  }
  if (anyFail || (gap && !wip)) {
    process.stderr.write(`lifecycle-check: FAIL — resolve the gaps above before pushing.\n`);
    process.exit(1);
  }
  if (exempt) {
    process.stdout.write(`lifecycle-check: OK (--wip) — phases 1..${exempt - 1} complete, phase ${exempt} ${PHASE_NAMES[exempt]} in progress. A COMPLETE feature is gated on all nine: run --all before merge.\n`);
    process.exit(0);
  }
  const highest = phases.filter((r) => r.present).map((r) => r.n).pop() || 0;
  process.stdout.write(`lifecycle-check: OK — phases 1..${highest} complete (${highest}/9).\n`);
  process.exit(0);
}

if (wantAll || wantWip) runAll({ wip: wantWip && !wantAll });

if (phaseArg) {
  const n = parseInt(phaseArg, 10);
  if (!(n >= 1 && n <= 9)) fail(`--phase must be 1..9 (got ${phaseArg})`);
  const glob = checkA1(); // A1 runs globally, regardless of --dir
  const r = runOne(n);
  const anyFail = report(glob.length ? [{ n: 0, name: 'GLOBAL', present: true, gaps: glob }, r] : [r]);
  if (!r.present) {
    process.stderr.write(`lifecycle-check: phase ${n} ${r.name} PENDING — artifacts not created yet.\n`);
    process.exit(1);
  }
  if (anyFail) {
    process.stderr.write(`lifecycle-check: phase ${n} ${r.name} FAIL.\n`);
    process.exit(1);
  }
  process.stdout.write(`lifecycle-check: phase ${n} ${r.name} OK — you may proceed to phase ${n + 1}.\n`);
  process.exit(0);
}

fail('specify --phase <1-9>, --wip (mid-round push), or --all (whole feature)');
