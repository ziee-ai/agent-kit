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
const phaseArg = opt('--phase');
const baseArg = opt('--base'); // resolved after repo is known (default: origin/main if it exists)
let dirArg = opt('--dir');
let repoArg = opt('--repo');

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
  // returns DRIFT-1.md style files sorted by their numeric index ascending
  return readdirSync(featureDir)
    .map((f) => {
      const m = new RegExp(`^${prefix}-(\\d+)\\.md$`).exec(f);
      return m ? { file: f, n: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
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
// A10 restricted-user tag: a `[negative-perm]` marker on a `tier: e2e` test line
// flags it as the RESTRICTED-USER spec (logs in as a user LACKING the perm and
// asserts the feature UI is ABSENT — not merely 403-on-use).
const RE_TEST_NEGPERM = /\[\s*negative-perm\s*\]/i;
// DECISION:    ### DEC-1: question   then **Resolution:** ...  **Basis:** ...
const RE_DEC = /^#{2,6}\s*(DEC-[A-Za-z0-9._-]+)\s*:/;
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
    tests.push({ id: idm[1], tier, covers, file: file && file.trim(), asserts: asserts && asserts.trim(), negPerm, line: ln });
  }
  return tests;
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
// Map a set of paths → the frontend npm workspaces they touch.
// `src-app/ui/**` → "ui"; `src-app/desktop/ui/**` → "desktop/ui".
function frontendWorkspacesOf(paths) {
  const ws = new Set();
  for (const p of paths) {
    if (RE_GENERATED_FE.test(p)) continue;
    if (/^src-app\/desktop\/ui\//.test(p)) ws.add('desktop/ui');
    else if (/^src-app\/ui\//.test(p)) ws.add('ui');
  }
  return ws;
}
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
    for (const m of ln.matchAll(/src-app\/[A-Za-z0-9._\-\/]+/g)) paths.push(m[0]);
  }
  return frontendWorkspacesOf(paths);
}
// Frontend workspaces touched by the real diff (empty if not implemented yet).
function diffFrontendWorkspaces() {
  try { return frontendWorkspacesOf(changedFilePaths()); } catch { return new Set(); }
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
    if (/(^|\/)vendor\/pgvector(\/|$)/.test(path)) return false;   // noisy submodule
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
const ANGLE_MIN = 10;
const COVERAGE_MIN_ANGLES = 3;

// ---------------------------------------------------------------------------
// A1-A9 — the hardening checks (see LIFECYCLE_HARDENING_MASTER.md)
// ---------------------------------------------------------------------------
// A1: reject >1 .lifecycle feature dir even under an explicit --dir (a second
// feature dir sneaks onto the branch → the pre-push `--all` gate validates the
// wrong one → silent push-doom).
function checkA1() {
  const root = join(repo, '.lifecycle');
  if (!existsSync(root)) return [];
  let subs = [];
  try { subs = readdirSync(root).filter((d) => { try { return statSync(join(root, d)).isDirectory(); } catch { return false; } }); }
  catch { return []; }
  if (subs.length > 1) return [`A1: .lifecycle/ has ${subs.length} feature dirs (${subs.join(', ')}) — a branch may carry exactly ONE. Remove the stray(s) before pushing.`];
  return [];
}

// A3: diff-added test skips/ignores. Only genuine platform-incompatibility is a
// legit skip, and that MUST be a #[cfg(target_os=...)] gate — never #[ignore]/.skip.
const RE_SKIP = /#\[\s*ignore\b|(?:^|[^\w.])(?:test|it|describe|context)\.(?:skip|only)\s*\(|(?:^|[^\w])x(?:it|describe)\s*\(/;
function checkA3() {
  const g = [];
  for (const a of diffAddedLines()) {
    if (RE_SKIP.test(a.text))
      g.push(`A3: ${a.file}:${a.ln}: diff ADDS a test skip/ignore/only ("${a.text.trim().slice(0, 70)}") — no #[ignore]/.skip to go green; a real platform gate is #[cfg(target_os=...)].`);
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

// A7: boot/runtime canary result line — a UI diff must record that the runtime-
// health/gate:ui pass ran (a non-booting app or a root ErrorBoundary crash is
// otherwise invisible; "green e2e" can ship a non-rendering app).
const RE_BOOT_CANARY = /(?:gate:ui|boot[ -]?canary|runtime[ -]?health)\s*\(\s*([A-Za-z0-9._/\- ]+?)\s*\)\s*:?\s*.*?\b(PASS|FAIL)\b/i;

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
  if (negPermE2eTests(tests).length > 0) return [];
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
  const files = [
    join(repo, 'src-app/ui/openapi/openapi.json'),
    join(repo, 'src-app/desktop/ui/openapi/openapi.json'),
  ];
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
  if (!routes) return []; // no openapi.json (non-ziee fixture) → nothing to check
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
  return { present: true, gaps: g };
}

function phase2() {
  const g = [];
  const t = read('PLAN_AUDIT.md');
  if (t == null) return { present: false, gaps: ['PLAN_AUDIT.md missing'] };
  const items = parsePlanItems();
  if (!items) return { present: true, gaps: ['PLAN.md missing/empty — cannot audit'] };
  for (const dim of [['breakage'], ['pattern conformance', 'pattern'], ['migration'], ['openapi']]) {
    if (!hasSection(t, ...dim)) g.push(`PLAN_AUDIT.md: missing dimension section "${dim[0]}"`);
  }
  const verdicts = new Map();
  for (const ln of t.split(/\r?\n/)) {
    const m = RE_AUDIT.exec(ln);
    if (m) verdicts.set(m[1], m[2].toUpperCase());
  }
  for (const id of items.keys()) {
    if (!verdicts.has(id)) g.push(`PLAN_AUDIT.md: ${id} has no verdict line (- **${id}** — verdict: PASS|CONCERN|BLOCKED — ...)`);
    else if (verdicts.get(id) === 'BLOCKED') g.push(`PLAN_AUDIT.md: ${id} verdict is BLOCKED — resolve before proceeding`);
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
  for (const x of checkA5()) g.push(x); // A5 shrink-guard
  for (const x of checkA10Enumeration()) g.push(x); // A10 restricted-user e2e must be enumerated
  return { present: true, gaps: g };
}

function phase4() {
  const g = [];
  const t = read('DECISIONS.md');
  if (t == null) return { present: false, gaps: ['DECISIONS.md missing'] };
  const decs = [];
  const lines = t.split(/\r?\n/);
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
  if (decs.length === 0) g.push('DECISIONS.md: no `### DEC-N: ...` entries parsed');
  for (const d of decs) if (!d.res) g.push(`DECISIONS.md: ${d.id} has no "**Resolution:**" line`);
  // forbidden markers anywhere
  lines.forEach((ln, i) => {
    if (FORBIDDEN_DECISION.test(ln)) g.push(`DECISIONS.md:${i + 1}: forbidden unresolved marker (TBD/TODO/ASK/???): "${ln.trim()}"`);
  });
  return { present: true, gaps: g };
}

function phase5() {
  const g = [];
  const drifts = glob('DRIFT');
  if (drifts.length === 0) return { present: false, gaps: ['no DRIFT-<n>.md files (implement + drift loop not started)'] };
  // every drift file must declare its unresolved count; the highest round must be 0
  for (const d of drifts) {
    const t = read(d.file);
    if (!/\*\*\s*unresolved drifts\s*:?\s*\*\*\s*\d+/i.test(t) && !/^\s*unresolved drifts\s*:\s*\d+/im.test(t))
      g.push(`${d.file}: missing "**Unresolved drifts:** <N>" summary line`);
    // each drift entry needs a recognized verdict
    for (const ln of t.split(/\r?\n/)) {
      if (/^\s*-\s*\*\*DRIFT-/.test(ln) && !RE_DRIFT.test(ln))
        g.push(`${d.file}: drift entry missing verdict (plan-wins|impl-wins|none|resolved): "${ln.trim().slice(0, 80)}"`);
    }
  }
  const last = drifts[drifts.length - 1];
  const lt = read(last.file);
  const m = /unresolved drifts\s*:?\s*\*{0,2}\s*(\d+)/i.exec(lt);
  if (!m) g.push(`${last.file}: cannot read unresolved-drift count`);
  else if (parseInt(m[1], 10) !== 0) g.push(`${last.file}: convergence not reached — ${m[1]} unresolved drift(s) in the final round`);
  return { present: true, gaps: g };
}

function phase6() {
  const g = [];
  const ledger = parseLedger();
  const cov = parseCoverage();
  if (ledger == null && cov == null) return { present: false, gaps: ['LEDGER.jsonl and AUDIT_COVERAGE.tsv missing (blind audit not started)'] };
  if (ledger == null) g.push('LEDGER.jsonl missing');
  if (cov == null) g.push('AUDIT_COVERAGE.tsv missing');
  if (ledger) {
    const bad = ledger.filter((r) => r.__parse_error);
    for (const b of bad) g.push(`LEDGER.jsonl:${b.__parse_error}: not valid JSON`);
    const angles = new Set(ledger.filter((r) => r.angle).map((r) => String(r.angle).toLowerCase()));
    if (angles.size < ANGLE_MIN) g.push(`LEDGER.jsonl: only ${angles.size} distinct angles; need >= ${ANGLE_MIN}`);
  }
  if (cov) {
    const hunks = diffHunks();
    if (hunks.length === 0) g.push(`no diff hunks found for ${baseRef}...HEAD (nothing implemented, or wrong --base)`);
    for (const h of hunks) {
      const matching = cov.filter((r) => r.file === h.file && r.start <= h.end && r.end >= h.start);
      const angleUnion = new Set();
      for (const r of matching) r.angles.forEach((a) => angleUnion.add(a));
      if (angleUnion.size < COVERAGE_MIN_ANGLES)
        g.push(`AUDIT_COVERAGE.tsv: hunk ${h.file}:${h.start}-${h.end} reviewed by ${angleUnion.size} angle(s) [${[...angleUnion].join(',') || 'none'}]; need >= ${COVERAGE_MIN_ANGLES}`);
    }
  }
  return { present: true, gaps: g };
}

function phase7() {
  const g = [];
  const rounds = glob('FIX_ROUND');
  if (rounds.length === 0) return { present: false, gaps: ['no FIX_ROUND-<n>.md files (fix/re-audit loop not started)'] };
  const last = rounds[rounds.length - 1];
  const lt = read(last.file);
  const m = /new confirmed findings\s*:?\s*\*{0,2}\s*(\d+)/i.exec(lt);
  if (!m) g.push(`${last.file}: missing "**New confirmed findings:** <N>" summary line`);
  else if (parseInt(m[1], 10) !== 0) g.push(`${last.file}: fix loop not converged — ${m[1]} new confirmed finding(s) in the final round`);
  return { present: true, gaps: g };
}

function phase8() {
  const g = [];
  const t = read('TEST_RESULTS.md');
  if (t == null) return { present: false, gaps: ['TEST_RESULTS.md missing'] };
  // A2: clean working tree — no uncommitted load-bearing files at phase 8.
  const dirty = dirtyWorkingTree();
  if (dirty.length)
    g.push(`A2: working tree not clean at phase 8 — uncommitted/untracked: ${dirty.slice(0, 10).map((l) => l.slice(3)).join(', ')}${dirty.length > 10 ? ', …' : ''}. Commit or remove before declaring done (load-bearing files must be on the branch).`);
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
    // A7: boot/runtime canary — require a recorded gate:ui/runtime-health/boot-canary PASS per FE workspace.
    const canary = new Map();
    for (const ln of t.split(/\r?\n/)) { const m = RE_BOOT_CANARY.exec(ln); if (m) canary.set(m[1].trim().toLowerCase(), m[2].toUpperCase()); }
    for (const w of feWs) {
      const v = canary.get(w.toLowerCase());
      if (!v) g.push(`A7: TEST_RESULTS.md: no boot/runtime canary line for "${w}" — record "gate:ui (${w}): PASS" (runtime-health boot + console-error + ErrorBoundary vs the REAL prod build, BEFORE specs). A green e2e can still ship a non-booting app or a root crash on an un-exercised path.`);
      else if (v !== 'PASS') g.push(`A7: TEST_RESULTS.md: "gate:ui (${w})" is ${v}, not PASS.`);
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

function report(results) {
  let anyFail = false;
  for (const r of results) {
    const status = !r.present ? 'PENDING' : r.gaps.length === 0 ? 'OK' : 'FAIL';
    const glyph = status === 'OK' ? '✓' : status === 'PENDING' ? '·' : '✗';
    process.stdout.write(`  ${glyph} phase ${r.n} ${r.name.padEnd(16)} ${status}\n`);
    if (r.gaps.length) {
      for (const gap of r.gaps) process.stdout.write(`      - ${gap}\n`);
      if (r.present) anyFail = true;
    }
  }
  return anyFail;
}

process.stdout.write(`lifecycle-check  feature=${featureDir.replace(repo + '/', '')}  base=${baseRef}\n`);

if (wantAll) {
  const results = [];
  const glob = checkA1(); // A1 runs globally, regardless of --dir
  if (glob.length) results.push({ n: 0, name: 'GLOBAL', present: true, gaps: glob });
  for (let n = 1; n <= 9; n++) results.push(runOne(n));
  const anyFail = report(results);
  // contiguity: no completed (present & OK) phase may sit above a PENDING one
  let sawPending = false;
  let gap = false;
  for (const r of results) {
    if (!r.present) { sawPending = true; continue; }
    if (r.present && sawPending) { gap = true; process.stdout.write(`  ! phase ${r.n} ${r.name} has artifacts but an earlier phase is PENDING (gate skipped)\n`); }
  }
  if (anyFail || gap) {
    process.stderr.write('lifecycle-check: FAIL — resolve the gaps above before pushing.\n');
    process.exit(1);
  }
  const highest = results.filter((r) => r.present).map((r) => r.n).pop() || 0;
  process.stdout.write(`lifecycle-check: OK — phases 1..${highest} complete (${highest}/9).\n`);
  process.exit(0);
}

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

fail('specify --phase <1-8> or --all');
