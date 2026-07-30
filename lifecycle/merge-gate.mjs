#!/usr/bin/env node
// merge-gate.mjs — the MERGE-TIME gate the per-branch lifecycle-check CANNOT be.
//
// WHY THIS EXISTS: the pre-push hook EXEMPTS pushes to `main` (its `ONLY_MAIN`
// guard), so every "collides-with-CURRENT-main" failure — a migration-number
// clash, a stale branch, a dropped desktop regen, a proc-macro variant that only
// fails from a clean tree — is uncatchable by the per-branch gate BY DESIGN.
// This tool codifies the manual merge discipline the orchestrator has been doing
// by hand: staging-merge onto *current* origin/main, then validate.
//
// Usage:
//   node .claude/lifecycle/merge-gate.mjs <branch> [options]
//
// Options:
//   --repo <path>       repo root (default: git toplevel of cwd)
//   --base <ref>        merge target (default: origin/main)
//   --staging <dir>     staging worktree path (default: a fresh temp dir)
//   --skip-heavy        skip the C1 (cargo) + C3 (regen) gates — for fast
//                       deterministic-only runs + the self-test
//   --keep-staging      leave the staging worktree in place (so the validated
//                       merge can be pushed from it); default removes it
//   --no-fetch          do not `git fetch origin main` first (use local base)
//   --max-behind <N>    C4 threshold: block if >N commits behind base
//                       un-rebased (default: env MERGE_GATE_MAX_BEHIND or 150)
//
// Exit 0 = every applicable gate passed. Non-zero = a gate failed (report on
// stdout). No external deps: pure Node + `git`/`node`/`cargo`/`just` via
// child_process.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// arg parsing (mirrors lifecycle-check.mjs)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes(name);
const branch = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--repo'
  && argv[argv.indexOf(a) - 1] !== '--base' && argv[argv.indexOf(a) - 1] !== '--staging'
  && argv[argv.indexOf(a) - 1] !== '--max-behind');

const SKIP_HEAVY = flag('--skip-heavy');
const KEEP_STAGING = flag('--keep-staging');
const NO_FETCH = flag('--no-fetch');
const VERIFY_HEAD = flag('--verify-head'); // fast HEAD-invariants mode (no branch, no build)
const MAX_BEHIND = parseInt(opt('--max-behind', process.env.MERGE_GATE_MAX_BEHIND || '150'), 10);

function die(msg) {
  process.stderr.write(`merge-gate: FATAL: ${msg}\n`);
  process.exit(2);
}
if (!branch && !VERIFY_HEAD) die('usage: merge-gate.mjs <branch> [options]   |   merge-gate.mjs --verify-head [--rev <ref>]');

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git(cwd, ...a) {
  return execFileSync('git', a, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
  }).trim();
}
// git that returns { ok, out } instead of throwing
function gitTry(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}
function isAncestor(cwd, a, b) {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;
}

let repo;
try {
  repo = opt('--repo') ? resolve(opt('--repo')) : git(process.cwd(), 'rev-parse', '--show-toplevel');
} catch {
  die(`not inside a git repository (cwd=${process.cwd()})`);
}

// ---------------------------------------------------------------------------
// app.config (the de-ziee-ify seam) — a plain KEY=value data file at
// <repo>/.claude/app.config. The app-specific gates (C1 clean-build, C2
// migration-collision, C3 regen-parity) read their ziee-vs-other paths from it
// and SKIP when their key is unset, so this same gate runs unchanged across
// ziee and any future app. The app-agnostic gates (C4 stale-branch,
// staging-merge, P2 completeness, C5 lifecycle-strip) need no config.
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
      // keep the FIRST occurrence of a duplicate key (matches preflight.sh's
      // grep|head -1, so both consumers of this file agree).
      if (!(k in cfg)) cfg[k] = line.slice(i + 1).trim();
    }
  } catch { /* no app.config → every app-specific gate SKIPs */ }
  return cfg;
}
const APP = loadAppConfig(repo);
// C2 / --verify-head. A COMMA-SEPARATED list of roots, because migrations are
// not necessarily one flat directory: this app keeps them per-module under
// src/modules/<mod>/migrations/. Every root is scanned recursively and the
// numeric prefixes share ONE namespace (they all apply to the same database),
// which is exactly what the collision check needs.
const MIGRATION_ROOTS = (APP.MERGE_MIGRATIONS_DIR || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CARGO_PACKAGE = APP.MERGE_CARGO_PACKAGE || null;         // C1
const CARGO_DESKTOP_PACKAGE = APP.MERGE_CARGO_DESKTOP_PACKAGE || null; // C1 (optional)
const DESKTOP_TOUCH_PREFIX = APP.MERGE_DESKTOP_TOUCH_PREFIX || null;   // C1 (optional)
const REGEN_CMD = APP.MERGE_REGEN_CMD || null;                 // C3
const GENERATED = (APP.MERGE_GENERATED || '').split(/\s+/).filter(Boolean); // C3
// staging PROVISIONING (see provisionStaging below)
const STAGING_SUBMODULES = (APP.MERGE_STAGING_SUBMODULES || '1').trim() !== '0';
const STAGING_COPY_FILES = (APP.MERGE_STAGING_COPY_FILES || '').split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// --verify-head — the fast subset safe to run in a pre-push hook on a push to
// main. Operates on ONE ref's committed tree (default HEAD): no staging merge,
// no build, no worktree. Asserts the two invariants that MUST hold for anything
// landing on main — (C5) no `.lifecycle/` process artifacts leaked, and (C2) no
// duplicate migration NUMBER prefixes — the "collides-with-main" class the
// per-branch gate cannot see (the hook exempts main by design).
// ---------------------------------------------------------------------------
if (VERIFY_HEAD) {
  const rev = opt('--rev') && opt('--rev') !== true ? opt('--rev') : 'HEAD';
  if (!gitTry(repo, 'rev-parse', '--verify', '--quiet', rev).ok) die(`rev not found: ${rev}`);
  const problems = [];

  // C5: `.lifecycle/` must be absent from the committed tree.
  const lc = gitTry(repo, 'ls-tree', '-r', '--name-only', rev, '--', '.lifecycle');
  if (lc.ok && lc.out.trim())
    problems.push(`C5: ${rev} still carries .lifecycle/ process artifacts (${lc.out.trim().split(/\r?\n/).length} file(s)) — strip them (git rm -r .lifecycle) before landing on main.`);

  // C2: no duplicate migration number prefixes in the committed tree.
  // Skipped when MERGE_MIGRATIONS_DIR is unset (app has no migrations dir).
  if (MIGRATION_ROOTS.length) {
    const ml = gitTry(repo, 'ls-tree', '-r', '--name-only', rev, '--', ...MIGRATION_ROOTS);
    if (ml.ok) {
      const byNum = new Map();
      for (const line of ml.out.split(/\r?\n/)) {
        const m = /(?:^|\/)(\d{6,})_[^/]*\.sql$/.exec(line.trim());
        if (!m) continue;
        (byNum.get(m[1]) || byNum.set(m[1], []).get(m[1])).push(line.trim());
      }
      // A configured root that matches NOTHING means the gate is checking thin
      // air. This is not a pass: MERGE_MIGRATIONS_DIR pointed at a flat
      // `server/migrations` for months after the migrations moved per-module,
      // so every landing reported "C2 PASS — no migrations dir" while checking
      // 106 real migration files not at all.
      if (byNum.size === 0)
        problems.push(`C2: MERGE_MIGRATIONS_DIR (${MIGRATION_ROOTS.join(', ')}) matched no migration files in ${rev} — the collision check is misconfigured, not clean.`);
      for (const [num, files] of byNum) {
        if (files.length > 1) problems.push(`C2: duplicate migration number ${num}: ${files.join(', ')} — renumber one above the other before landing on main.`);
      }
    }
  }

  if (problems.length) {
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    process.stderr.write('merge-gate --verify-head: FAIL — the above MUST be fixed before pushing to main.\n');
    process.exit(1);
  }
  process.stdout.write(`merge-gate --verify-head: OK (${rev}) — no .lifecycle/ leak, no duplicate migration prefixes.\n`);
  process.exit(0);
}

// Resolve base. Prefer origin/main (freshly fetched) unless overridden.
let base = opt('--base');
if (!base) {
  if (!NO_FETCH) {
    const f = gitTry(repo, 'fetch', '--quiet', 'origin', 'main');
    if (!f.ok) process.stderr.write('merge-gate: warning: `git fetch origin main` failed; using local ref.\n');
  }
  base = gitTry(repo, 'rev-parse', '--verify', '--quiet', 'origin/main').ok ? 'origin/main' : 'main';
}
if (!gitTry(repo, 'rev-parse', '--verify', '--quiet', base).ok) die(`base ref not found: ${base}`);
if (!gitTry(repo, 'rev-parse', '--verify', '--quiet', branch).ok) die(`branch ref not found: ${branch}`);

// ---------------------------------------------------------------------------
// STALE-REF GUARD — the gate must never silently grade the wrong commit.
//
// A BARE branch name resolves to the LOCAL ref, which can be arbitrarily far
// behind its remote. Observed in practice: `merge-gate.mjs feat/agent-core`
// graded a local branch **430 commits behind** `origin/feat/agent-core` and
// reported a confident FAIL — 11 file conflicts and "66 commits behind main" —
// none of which existed on the real branch. Every downstream number (merge-base,
// C4's behind-count, the conflict list, C3's regen diff) was computed against
// that stale tree, so the verdict was not merely wrong, it was wrong in the
// direction that BLOCKS a good merge and would have sent someone off to resolve
// eleven imaginary conflicts.
//
// This checks the STATE (is the ref I am about to grade the current tip?) rather
// than the SYNTAX (does it look like a remote ref?). A name-shaped check would
// miss the case that actually bit: the argument was spelled perfectly.
if (!branch.startsWith('origin/') && !branch.startsWith('refs/remotes/')) {
  const remoteRef = `origin/${branch}`;
  if (!NO_FETCH) {
    // The gate already fetches origin/main; without this the REMOTE side of the
    // comparison could itself be stale and the guard would under-report.
    gitTry(repo, 'fetch', '--quiet', 'origin', branch);
  }
  if (gitTry(repo, 'rev-parse', '--verify', '--quiet', remoteRef).ok) {
    const localSha = git(repo, 'rev-parse', branch);
    const remoteSha = git(repo, 'rev-parse', remoteRef);
    if (localSha !== remoteSha) {
      const behind = Number(git(repo, 'rev-list', '--count', `${branch}..${remoteRef}`)) || 0;
      const ahead = Number(git(repo, 'rev-list', '--count', `${remoteRef}..${branch}`)) || 0;
      if (behind > 0) {
        // Behind or diverged: refuse. Grading a stale tree produces a verdict
        // about code nobody is trying to land.
        die(
          `refusing to grade a STALE ref.\n` +
          `  '${branch}' is ${behind} commit(s) behind ${remoteRef}` +
          (ahead ? ` and ${ahead} ahead (DIVERGED)` : '') + `.\n` +
          `  local  ${localSha.slice(0, 10)}\n` +
          `  remote ${remoteSha.slice(0, 10)}\n` +
          `  Every gate result would describe the stale tree, not what you are landing.\n` +
          `  Fix: re-run against '${remoteRef}', or update the local branch\n` +
          `       (git update-ref refs/heads/${branch} ${remoteRef}).`,
        );
      }
      // AHEAD-only is legitimate: gating work that is committed but not yet
      // pushed is a normal pre-push check. Say so rather than failing.
      process.stderr.write(
        `merge-gate: note: '${branch}' is ${ahead} commit(s) ahead of ${remoteRef} ` +
        `(unpushed work is being graded).\n`,
      );
    }
  }
}

const mergeBase = git(repo, 'merge-base', base, branch);

// ---------------------------------------------------------------------------
// migration helpers (C2 / P3)
// ---------------------------------------------------------------------------
// filename `00000000000135_create_x.sql` → number "00000000000135"
// (MIGRATIONS_DIR is resolved from app.config near the top; null ⇒ no migrations.)
function migsAt(ref) {
  if (!MIGRATION_ROOTS.length) return new Map();
  // list migration files present in <ref>'s tree; tolerant of a root being absent
  const r = gitTry(repo, 'ls-tree', '-r', '--name-only', ref, '--', ...MIGRATION_ROOTS);
  if (!r.ok) return new Map();
  const m = new Map();
  for (const line of r.out.split(/\r?\n/)) {
    const mm = /(?:^|\/)(\d{6,})_[^/]*\.sql$/.exec(line.trim());
    if (mm) m.set(mm[1], line.trim());
  }
  return m; // number -> path
}

// ---------------------------------------------------------------------------
// gate runner
// ---------------------------------------------------------------------------
const results = []; // { id, name, status: 'PASS'|'FAIL'|'SKIP', detail }
function record(id, name, status, detail = '') {
  results.push({ id, name, status, detail });
}

// ===========================================================================
// C4 — stale-branch / rebase gate (deterministic, pre-merge)
// The 31-session root cause: a branch forked long ago, never re-based current
// main, then collides at merge. Block if the branch is far behind AND has not
// merged/rebased the current base.
// ===========================================================================
function gateC4() {
  const behind = parseInt(git(repo, 'rev-list', '--count', `${branch}..${base}`), 10);
  if (isAncestor(repo, base, branch)) {
    record('C4', 'stale-branch', 'PASS', `branch already contains ${base} (up to date)`);
    return;
  }
  if (behind > MAX_BEHIND) {
    record('C4', 'stale-branch', 'FAIL',
      `branch is ${behind} commits behind ${base} and has NOT rebased/merged it (> ${MAX_BEHIND}). ` +
      `Rebase or merge current ${base} into ${branch} first, then re-run.`);
  } else {
    record('C4', 'stale-branch', 'PASS', `${behind} commit(s) behind ${base} (<= ${MAX_BEHIND})`);
  }
}

// ===========================================================================
// C2 — migration-collision gate (deterministic, pre-merge)
// After merge, no two migrations may share a number prefix, and every migration
// the BRANCH added must sort after main's max-at-fork (else it renumbers-needs).
// ===========================================================================
function gateC2() {
  if (!MIGRATION_ROOTS.length) { record('C2', 'migration-collision', 'SKIP', 'MERGE_MIGRATIONS_DIR unset (no migrations dir configured)'); return; }
  const atMergeBase = migsAt(mergeBase);
  const atBase = migsAt(base);
  const atBranch = migsAt(branch);
  if (atBranch.size === 0 && atBase.size === 0) {
    // Configured but matching nothing on EITHER side is a misconfiguration, not
    // a clean tree — see the note in verifyHead. Reporting PASS here is how this
    // gate silently stopped checking anything when migrations moved per-module.
    record('C2', 'migration-collision', 'FAIL',
      `MERGE_MIGRATIONS_DIR (${MIGRATION_ROOTS.join(', ')}) matched no migration files on main or branch — fix the configured root(s); a gate that checks nothing must not report PASS`);
    return;
  }
  const nums = (m) => [...m.keys()];
  const maxOf = (arr) => arr.reduce((a, b) => (a > b ? a : b), '');
  const mainMaxAtBase = maxOf(nums(atMergeBase));
  const branchAdded = nums(atBranch).filter((n) => !atMergeBase.has(n));
  const mainAddedSinceFork = nums(atBase).filter((n) => !atMergeBase.has(n));

  const problems = [];
  for (const n of branchAdded) {
    if (mainMaxAtBase && n <= mainMaxAtBase) {
      problems.push(`branch migration ${n} (${atBranch.get(n)}) is <= main's max-at-fork ${mainMaxAtBase} — renumber above main`);
    }
    if (atBase.has(n) && atBase.get(n) !== atBranch.get(n)) {
      problems.push(`migration number ${n} exists on BOTH main (${atBase.get(n)}) and branch (${atBranch.get(n)}) — duplicate prefix after merge`);
    }
    if (mainAddedSinceFork.includes(n)) {
      problems.push(`migration number ${n} was added by BOTH main and the branch since fork — collision, renumber the branch's`);
    }
  }
  // duplicate-prefix scan across the would-be-merged set (branch ∪ main)
  const merged = new Map([...atBase]);
  for (const n of branchAdded) {
    if (merged.has(n) && merged.get(n) !== atBranch.get(n)) {
      problems.push(`post-merge duplicate migration prefix ${n}: ${merged.get(n)} vs ${atBranch.get(n)}`);
    }
    merged.set(n, atBranch.get(n));
  }
  if (problems.length) record('C2', 'migration-collision', 'FAIL', problems.join('; '));
  else record('C2', 'migration-collision', 'PASS',
    branchAdded.length ? `${branchAdded.length} branch migration(s), all > main max ${mainMaxAtBase || '(none)'}` : 'no branch migrations');
}

// ===========================================================================
// staging merge + P2 (merge-completeness) + C5 (lifecycle strip)
// ===========================================================================
let staging = opt('--staging') ? resolve(opt('--staging')) : null;
let stagingCreated = false;

function makeStaging() {
  if (!staging) {
    // Default the staging tree BESIDE THE REPO, not into the system temp dir.
    //
    // Two reasons, both measured rather than stylistic:
    //
    // 1. BUILD CACHE. sccache only shares a compiled object between two trees
    //    when their paths normalise to the same key, which needs SCCACHE_BASEDIR
    //    to be a COMMON ANCESTOR of both. Worktrees live beside the repo; a
    //    staging tree in /tmp sits outside any sane basedir, so every gate run
    //    re-compiled the entire native surface from scratch — aws-lc-sys alone
    //    is ~1500 C files. Observed C/C++ hit rate with the split layout: 28%,
    //    against 61% for Rust.
    // 2. SIZE. /tmp is often a small shared tmpfs; a full staging checkout plus
    //    its target/ dir is tens of GB and does not belong there.
    //
    // Still overridable: --staging <dir> wins, and TMPDIR is honoured if set, so
    // a CI runner that wants the old behaviour keeps it.
    const preferred = process.env.TMPDIR || join(repo, '..');
    let root = preferred;
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      root = tmpdir(); // unwritable parent (read-only checkout, odd CI layout)
    }
    staging = mkdtempSync(join(root, '.merge-gate-'));
  }
  // create a detached worktree at base, then merge the branch
  const add = gitTry(repo, 'worktree', 'add', '--detach', staging, base);
  if (!add.ok) die(`could not create staging worktree at ${staging}: ${add.out}`);
  stagingCreated = true;
}

// ---------------------------------------------------------------------------
// staging PROVISIONING — `git worktree add` materializes the TRACKED tree only:
//   (a) submodule working trees are left EMPTY (only the gitlink dir exists), so
//       any crate/package sourced from a submodule is missing → C1 dies with
//       `failed to read <submodule>/.../Cargo.toml` and C3's regen dies with it;
//   (b) gitignored per-machine config (a dev.yaml the codegen needs) is absent
//       by definition → C3's regen dies with `no config file found`.
// Both are PROVISIONING gaps, not check failures: the gate reports a red C1/C3
// for a condition that does not exist on the branch. Fix both here, generically:
//   • submodules — `git submodule update --init --recursive` whenever the merged
//     tree HAS a .gitmodules (opt out per app with MERGE_STAGING_SUBMODULES=0);
//   • gitignored-but-required files — each app DECLARES its own repo-relative
//     paths in MERGE_STAGING_COPY_FILES (space-separated) and they are copied
//     from the live repo into staging. NOTHING app-specific is baked in here;
//     an app that declares none copies none.
// Run AFTER the merge so submodules check out the MERGED gitlink, not base's.
// Fail-SOFT but LOUD: a missing/failed item prints a warning and continues, so
// the gate that needed it fails for its REAL reason — never silently skipped.
// ---------------------------------------------------------------------------
function stagingNote(msg) { process.stdout.write(`  · staging: ${msg}\n`); }
function stagingWarn(msg) { process.stdout.write(`  ! staging: ${msg}\n`); }

function provisionStaging() {
  // (a) submodules
  if (existsSync(join(staging, '.gitmodules'))) {
    if (!STAGING_SUBMODULES) {
      stagingNote('submodule checkout SKIPPED (MERGE_STAGING_SUBMODULES=0)');
    } else {
      const s = gitTry(staging, 'submodule', 'update', '--init', '--recursive');
      if (s.ok) stagingNote('submodules checked out (git submodule update --init --recursive)');
      else stagingWarn('`git submodule update --init --recursive` FAILED — any gate needing submodule sources (C1/C3) will fail for THAT reason:\n'
        + s.out.trim().split(/\n/).slice(-6).map((l) => `      ${l}`).join('\n'));
    }
  }
  // (b) app-declared gitignored-but-required files
  for (const rel of STAGING_COPY_FILES) {
    if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) {
      stagingWarn(`MERGE_STAGING_COPY_FILES entry "${rel}" is not a safe repo-relative path — NOT copied`);
      continue;
    }
    // Only UNTRACKED (gitignored, per-machine) files belong here. A TRACKED path
    // already has its authoritative MERGED content in staging; copying the live
    // working-tree version over it would substitute unreviewed content and could
    // MASK a real C1/C3 failure. Refuse, loudly.
    if (gitTry(staging, 'ls-files', '--error-unmatch', '--', rel).ok) {
      stagingWarn(`MERGE_STAGING_COPY_FILES: "${rel}" is TRACKED by git — NOT copied. `
        + 'The merged tree already holds the authoritative version; declare only gitignored per-machine files here.');
      continue;
    }
    const src = join(repo, rel);
    const dst = join(staging, rel);
    if (!existsSync(src)) {
      stagingWarn(`MERGE_STAGING_COPY_FILES: "${rel}" is ABSENT from ${repo} — NOT copied. `
        + 'A gate needing it will fail for that reason; create it in the repo (e.g. via preflight) and re-run.');
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
      stagingNote(`copied gitignored "${rel}" into staging`);
    } catch (e) {
      stagingWarn(`could not copy "${rel}" into staging: ${e.message}`);
    }
  }
}

function gateMergeAndP2C5() {
  makeStaging();
  const m = gitTry(staging, 'merge', '--no-ff', '--no-edit', branch);
  if (!m.ok) {
    // conflicts (or other merge failure) — the orchestrator must resolve, then
    // re-run merge-gate against the resolved worktree (--staging <dir>).
    const conflicts = gitTry(staging, 'diff', '--name-only', '--diff-filter=U').out.trim();
    gitTry(staging, 'merge', '--abort');
    record('MERGE', 'staging-merge', 'FAIL',
      `merging ${branch} onto ${base} has CONFLICTS — resolve them, then re-run against the resolved worktree.` +
      (conflicts ? ` Conflicted: ${conflicts.split(/\n/).join(', ')}` : ''));
    // P2/C5 depend on a merged tree; skip them
    record('P2', 'merge-completeness', 'SKIP', 'merge did not complete');
    record('C5', 'lifecycle-strip', 'SKIP', 'merge did not complete');
    return;
  }
  record('MERGE', 'staging-merge', 'PASS', 'clean 3-way merge');

  // The merged tree is final → provision it (submodules + app-declared
  // gitignored config) BEFORE any gate reads from it.
  provisionStaging();

  // --- P2 merge-completeness: every file the branch added/modified (vs fork)
  // must be present in the merged tree. A clean 3-way merge guarantees this,
  // but assert it as a guard against a mis-scoped base / a bad octopus. This is
  // where hand-resolved merges historically DROP a file (types.ts, a testid).
  const branchFiles = gitTry(repo, 'diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}..${branch}`)
    .out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const dropped = branchFiles.filter((f) => !existsSync(join(staging, f)));
  if (dropped.length) {
    record('P2', 'merge-completeness', 'FAIL',
      `${dropped.length} file(s) the branch added/modified are MISSING from the merge (dropped in conflict resolution): ${dropped.slice(0, 20).join(', ')}`);
  } else {
    record('P2', 'merge-completeness', 'PASS', `all ${branchFiles.length} branch file(s) present in the merge`);
  }

  // --- C5 lifecycle-strip: perform + verify the `.lifecycle/` removal the merge
  // to main REQUIRES (process artifacts must never land on main).
  if (existsSync(join(staging, '.lifecycle'))) {
    const rm = gitTry(staging, 'rm', '-r', '--quiet', '.lifecycle');
    if (!rm.ok) { record('C5', 'lifecycle-strip', 'FAIL', `git rm -r .lifecycle failed: ${rm.out}`); return; }
  }
  if (existsSync(join(staging, '.lifecycle'))) {
    record('C5', 'lifecycle-strip', 'FAIL', '.lifecycle/ still present after strip');
  } else {
    record('C5', 'lifecycle-strip', 'PASS', '.lifecycle/ stripped from the merge');
  }
}

// ===========================================================================
// C3 — full regen from the MERGED backend, both workspaces, no dropped types.
// The recurring bug: desktop/ui/ has a SEPARATE api-client/types.ts that gets
// left stale (or the whole regen dropped) at merge. After regen, the committed
// generated files MUST equal a fresh regen (empty diff) — else a regen was
// dropped and a merged feature's types are missing from a client.
// (Heavy: needs a backend build + build-DB. Skippable.)
// ===========================================================================
// GENERATED + REGEN_CMD are resolved from app.config near the top.
function gateC3() {
  if (SKIP_HEAVY) { record('C3', 'regen-parity', 'SKIP', '--skip-heavy'); return; }
  if (!REGEN_CMD || GENERATED.length === 0) { record('C3', 'regen-parity', 'SKIP', 'MERGE_REGEN_CMD/MERGE_GENERATED unset (no regen configured)'); return; }
  const [regenCmd, ...regenArgs] = REGEN_CMD.split(/\s+/);
  const r = spawnSync(regenCmd, regenArgs, { cwd: staging, encoding: 'utf8', stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
  // A missing binary / spawn failure returns status null + undefined stdout — guard
  // it, else `(r.stdout + r.stderr).split()` throws instead of recording a FAIL.
  if (r.error || r.status === null) {
    record('C3', 'regen-parity', 'FAIL', `${REGEN_CMD} could not run: ${r.error ? r.error.message : 'process did not exit normally'} (is "${regenCmd}" installed?)`);
    return;
  }
  if (r.status !== 0) {
    record('C3', 'regen-parity', 'FAIL', `${REGEN_CMD} failed (exit ${r.status}). Tail:\n${((r.stdout || '') + (r.stderr || '')).split(/\n/).slice(-12).join('\n')}`);
    return;
  }
  // After a correct regen against the merged backend, the committed generated
  // files should be byte-identical → empty diff. A NON-empty diff means the
  // merge shipped stale/dropped generated output for at least one workspace.
  const diff = gitTry(staging, 'diff', '--stat', '--', ...GENERATED).out.trim();
  if (diff) {
    record('C3', 'regen-parity', 'FAIL',
      `committed generated files do NOT match a fresh regen of the merged backend (a regen was dropped for at least one workspace — for ziee, typically desktop/ui):\n${diff}`);
  } else {
    record('C3', 'regen-parity', 'PASS', `all ${GENERATED.length} generated openapi+types file(s) match the merged backend`);
  }
}

// ===========================================================================
// C1 — clean build from the merged tree (the warm-build masking class).
// A warm incremental build can compile against a STALE proc-macro expansion
// (e.g. a codegen'd SSE variant); a genuinely clean build — what the merge/CI
// does — fails. `cargo clean -p ziee && cargo check` from the merged staging
// worktree is the authoritative catch. (Heavy. Skippable.)
// ===========================================================================
function touched(prefix) {
  return gitTry(repo, 'diff', '--name-only', `${mergeBase}..${branch}`)
    .out.split(/\r?\n/).some((f) => f.trim().startsWith(prefix));
}
function gateC1() {
  if (SKIP_HEAVY) { record('C1', 'clean-build', 'SKIP', '--skip-heavy'); return; }
  if (!CARGO_PACKAGE) { record('C1', 'clean-build', 'SKIP', 'MERGE_CARGO_PACKAGE unset (no cargo package configured)'); return; }
  // cargo working dir: MERGE_CARGO_DIR if set, else the ziee-style src-app / src-app/server fallback.
  let cwd;
  if (APP.MERGE_CARGO_DIR) cwd = join(staging, APP.MERGE_CARGO_DIR);
  else cwd = existsSync(join(staging, 'src-app', 'Cargo.toml')) ? join(staging, 'src-app') : join(staging, 'src-app', 'server');
  if (!existsSync(join(cwd, 'Cargo.toml'))) {
    record('C1', 'clean-build', 'SKIP', `no Cargo.toml at ${APP.MERGE_CARGO_DIR || 'src-app'} (cannot run cargo)`);
    return;
  }
  const clean = spawnSync('cargo', ['clean', '-p', CARGO_PACKAGE], { cwd, encoding: 'utf8', stdio: 'pipe' });
  void clean;
  const args = ['check', '-p', CARGO_PACKAGE, '--tests'];
  if (CARGO_DESKTOP_PACKAGE && DESKTOP_TOUCH_PREFIX && touched(DESKTOP_TOUCH_PREFIX)) args.push('-p', CARGO_DESKTOP_PACKAGE);
  const chk = spawnSync('cargo', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
  // guard a missing/failed-to-spawn cargo (status null + undefined stdout).
  if (chk.error || chk.status === null) {
    record('C1', 'clean-build', 'FAIL', `cargo could not run: ${chk.error ? chk.error.message : 'process did not exit normally'} (is cargo installed?)`);
    return;
  }
  if (chk.status !== 0) {
    record('C1', 'clean-build', 'FAIL',
      `cargo clean -p ${CARGO_PACKAGE} && cargo ${args.join(' ')} FAILED from a CLEAN merged tree (warm builds mask this). Tail:\n` +
      ((chk.stdout || '') + (chk.stderr || '')).split(/\n/).filter((l) => /error/i.test(l)).slice(0, 12).join('\n'));
  } else {
    record('C1', 'clean-build', 'PASS', `cargo check clean from the merged tree${CARGO_DESKTOP_PACKAGE && args.includes(CARGO_DESKTOP_PACKAGE) ? ' (+ desktop crate)' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
process.stdout.write(`merge-gate  branch=${branch}  base=${base}  merge-base=${mergeBase.slice(0, 10)}\n`);
try {
  gateC4();
  gateC2();
  gateMergeAndP2C5();
  // C1/C3 only run on a completed merge
  const merged = results.find((r) => r.id === 'MERGE')?.status === 'PASS';
  if (merged) { gateC3(); gateC1(); }
  else { record('C3', 'regen-parity', 'SKIP', 'merge did not complete'); record('C1', 'clean-build', 'SKIP', 'merge did not complete'); }
} finally {
  if (stagingCreated && !KEEP_STAGING) {
    const rm = gitTry(repo, 'worktree', 'remove', '--force', staging);
    // A worktree with POPULATED submodules (which provisionStaging creates) can
    // refuse `worktree remove`; we created this dir, so force-clean it and prune
    // the now-dangling registration rather than leaking a multi-GB staging tree.
    if (!rm.ok) {
      try { rmSync(staging, { recursive: true, force: true }); } catch {}
      gitTry(repo, 'worktree', 'prune');
    }
    try { if (existsSync(staging) && readdirSync(staging).length === 0) rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

let anyFail = false;
for (const r of results) {
  const glyph = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '·' : '✗';
  process.stdout.write(`  ${glyph} ${r.id.padEnd(6)} ${r.name.padEnd(20)} ${r.status}${r.detail ? ` — ${r.detail}` : ''}\n`);
  if (r.status === 'FAIL') anyFail = true;
}
if (KEEP_STAGING && stagingCreated) process.stdout.write(`  staging worktree kept at: ${staging}\n`);
if (anyFail) {
  process.stderr.write('merge-gate: FAIL — do NOT push this merge to main until the gates above are green.\n');
  process.exit(1);
}
process.stdout.write('merge-gate: OK — the merge onto current ' + base + ' is clean.\n');
process.exit(0);
