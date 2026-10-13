# scripts/rig — the gate v2 merge rig

A long-running loop (`auto-merge.sh`) that lands an integration branch on `main` when the gate passes, while running the expensive
full gate **at most once per batch**. It implements *Landing: gate v2* in `skills/feature-orchestration/SKILL.md`. It was built
and measured in a consumer app, then ported here with every app-specific path and command turned into config.

Run it only where the owner has given a standing "merge when the gate passes". Merging is never the rig's own decision.

## The flow

```
candidate tip (no new commits for RIG_QUIET_SECS)
  ├─ held? MAIN-RED (without MAIN-RED-LIFT) · tip == failed-sha (no blind retry; `echo <sha> > regate` forces one) · already on main
  ├─ 1. PREGATE  rig-pregate.sh, keep-going, exit = number of red checks
  │       P1 structural (merge-gate.mjs --skip-heavy) · P2 hygiene · P3 regen leaves the tree clean · P4 static legs
  │     red → HOLD with the whole list; the full gate never starts
  ├─ 2. RECHECK  (the tip descends from REAL-FAILS.json's sha, i.e. it is a fix)
  │       unparsed/structural entries hold the recheck (a human clears them), except a compile error the green pregate cleared
  │       re-run ONLY the recorded real failures (1 try; an intermittent item recorded with "tries": 3 needs 3/3)
  │       still red → recheck-flake.py names the tests inside red steps → each alone 3× (the flake rule)
  │       + the fix commits' impacted tests (the delta); its reds get the same 3× alone pass
  │     green → MERGE (no second full gate) · red → REAL-FAILS.json advances to this tip, HOLD
  └─ 3. FULL GATE (RIG_GATE_CMD, at most once per batch, through the timing shims)
        green → MERGE
        red   → gate-failures.py names every failure → rerun-failures.sh runs each ALONE 3×
                 all 3/3 green (flakes) → MERGE (tip moved meanwhile: record an empty REAL-FAILS so the next tip is a RECHECK)
                 any real → REAL-FAILS.json + HOLD
```

**Flake rule:** a failure is a flake only if it passes **3 of 3** runs alone on the same sha. Green-then-red (e.g. 2/3) is
*intermittent*: real, recorded with `"tries": 3`, and its recheck must pass 3/3 — a one-try recheck would pass it two times in three.

## Files

| file | role |
|---|---|
| `auto-merge.sh` | the loop above |
| `rig-pregate.sh` | the pregate (`<sha> [<outdir>]`; writes `SUMMARY`, `TIMES`, per-check logs) |
| `rig-worktree.sh` | sourced; `rig_worktree_at <sha> <logdir>` puts the ONE persistent rig worktree at a sha |
| `gate-failures.py` | `<gate.log> <run-dir>` → `FAILURES.json` (structural / named items / unparsed). Parsers: cargo test, nextest, playwright, vitest, node:test, run-steps reports; ignores compile errors planted by mutation batteries (`RIG_GATED_SHA` + `RIG_SRC_REPO`) |
| `rerun-failures.sh` | `<sha> <FAILURES.json> <outdir>` → each item alone `RERUN_TRIES` (default 3) times → `RERUN.json`, `verdicts.tsv`; exit 0 = all flakes |
| `recheck-flake.py` | `<run-dir>` → still-red recheck steps broken into named tests (`recheck-flake/FAILURES.json`); exit 3 = a red step could not be named |
| `gate-timing.py` | `<run-dir>` → `SUMMARY.md`: per-stage and per-recipe durations from the shims' records |
| `rig-timing/{_timed.sh,just,cargo}` | gate-only PATH shims: record every `just`/`cargo` call to `calls.tsv` and keep each top-level `just` call's full output (`just-<n>-<recipe>.log`). They use flags, never env (env leaks into nested `just`) |
| `rig-restart.sh` | restart only the rig process (to load new code) while it holds |
| `rig-test.sh` | sandbox harness for the loop (no app needed) |
| `rerun-test.sh` | sandbox harness for `rerun-failures.sh` |

Things an app may add on its side (not shipped here): a phase-6 / audit dispatcher, a pre-plan dispatcher, build idle/step timing
reports, a drift check between its deployed copy and its source, and brief templates.

## Configuration

Every script reads env vars; `auto-merge.sh`, `rig-pregate.sh` and `rig-restart.sh` then source **`$RIG_STATE/rig.env`** if it
exists. rig.env is sourced *after* the environment, so its plain assignments win; write `: "${X:=value}"` for a default that the
environment may override. `auto-merge.sh` exports the resolved config to every child (pregate, rerun, parser).

**Required** (the scripts exit 2 — the pregate exits 99 — with a clear message when unset):

| variable | meaning |
|---|---|
| `RIG_REPO` | the app's primary clone, checked out on the integration branch; the loop runs there |
| `RIG_STATE` | the state dir: `runs/`, `REAL-FAILS.json`, `failed-sha`, logs, `rig.env` |

**Paths and loop:**

| variable | default | meaning |
|---|---|---|
| `RIG_BIN` | this directory | where the rig scripts live |
| `RIG_KIT` | `$RIG_BIN/../..` | the agent-kit root (for `lifecycle/merge-gate.mjs`) |
| `RIG_WORKTREE` | `$RIG_STATE/rig-wt` | the persistent rig worktree (pregate, reruns, delta run here) |
| `RIG_WORKTREE_HELPER` | `$RIG_BIN/rig-worktree.sh` | script defining `rig_worktree_at` (rerun-failures.sh alone: unset = plain checkout) |
| `RIG_TRASH` | `$RIG_STATE/trash` | where consumed files are moved (nothing is deleted) |
| `RIG_SCRATCH` | `$RIG_STATE/scratch` | throwaway merge worktrees |
| `RIG_BRANCH` | current branch of `RIG_REPO` | the integration branch |
| `RIG_MAIN_BRANCH` | `main` | the branch merged into |
| `RIG_QUIET_SECS` / `RIG_HOLD_SECS` / `RIG_IDLE_SECS` | `60` / `120` / `300` | quiet wait before gating; sleep while held; sleep when nothing to merge |
| `RIG_MAX_ATTEMPTS` | `200` | loop iterations before giving up (`auto-merge.done`) |
| `RIG_RUN_WRAPPER` | `bash -c` | prefix that runs an app command given as ONE argument (e.g. `sg docker -c`, or a script that sets host thread caps) |

**Steps (each overridable; the harness overrides them with fakes):**

| variable | default | called as |
|---|---|---|
| `RIG_PREGATE_CMD` | `bash $RIG_BIN/rig-pregate.sh` | `<sha> <outdir>`; non-zero = red; reads `<outdir>/SUMMARY`, `TIMES` |
| `RIG_GATE_CMD` | `node $RIG_KIT/lifecycle/merge-gate.mjs` | `<branch>` from `RIG_REPO`; green = rc 0 **and** `merge-gate: OK` in its output |
| `RIG_RERUN_CMD` | `bash $RIG_BIN/rerun-failures.sh` | `<sha> <FAILURES.json> <outdir>` |
| `RIG_FAILURES_CMD` | `python3 $RIG_BIN/gate-failures.py` | `<gate.log> <run-dir>` |
| `RIG_RECHECK_FLAKE_CMD` | `python3 $RIG_BIN/recheck-flake.py` | `<run-dir>` |
| `RIG_TIMING_CMD` | `python3 $RIG_BIN/gate-timing.py` | `<run-dir>` |
| `RIG_TIMING_PATH` | `$RIG_BIN/rig-timing` | prepended to PATH for the gate and the delta; empty = no shims |
| `RIG_REAL_JUST` / `RIG_REAL_CARGO` | next on PATH after the shims | the real binaries behind the shims |
| `RIG_DELTA_CMD` | unset | `<failed-sha> <tip> <outdir>`: the fix commits' impacted tests, a whole command of your own |
| `RIG_DELTA_TEST_CMD` | unset | a command string run in the rig worktree at the tip via `RIG_RUN_WRAPPER`; `{base}` = the failed sha |

With **neither delta variable set**, the delta step is **SKIPPED** and says so: a `WARNING: DELTA SKIPPED` line in the log, a
`delta/SKIPPED` file, and the merge message states it. It is never silently green.

The gate and delta run with `RIG_TIMING_DIR` (the run dir), `RUN_STEPS_REPORT_DIR` (gate: the run dir, for `scripts/run-steps.mjs`
reports), `RIG_TEST_LOG_DIR` (`<run>/test-affected`, where the parser looks for test-runner group logs) and `RIG_TEST_REPORT`
(`<run>/test-affected/LAST_RUN.md`). An app's test selector should write its per-group logs into `$RIG_TEST_LOG_DIR`.

**Merge and post-merge:**

| variable | default | meaning |
|---|---|---|
| `RIG_MERGE_TITLE` | `merge: <branch>` | first line of the merge commit (the body says how it was verified) |
| `RIG_MERGE_TRAILER` | empty | appended paragraph, e.g. a `Co-Authored-By:` line |
| `RIG_POST_MERGE_HOOK` | unset | run in the merge worktree (at the new main, after the push) with that path as `$1`, e.g. re-record a ratchet baseline and push it; failure is logged to `post-merge-hook.log`, never retried |
| `RIG_POST_MERGE_HOOK_NOW` | unset | `=1`: run the hook once on the current main and exit (after a manual push) |
| `RIG_POST_MERGE_CLEAN_CMD` | unset | run from `RIG_REPO` after a merge, e.g. remove merged worktrees (`post-merge-clean.log`) |
| `RIG_POST_MERGE_CLEAN` | `1` | `0` disables the clean command |

**Pregate:**

| variable | default | meaning |
|---|---|---|
| `RIG_STRUCTURAL_CMD` | `node $RIG_KIT/lifecycle/merge-gate.mjs` | P1, run from `RIG_REPO` as `<branch> $RIG_STRUCTURAL_ARGS`; green = `merge-gate: OK`; empty = skipped |
| `RIG_STRUCTURAL_ARGS` | `--skip-heavy` | |
| `RIG_MARKER_EXEMPT_RX` | `\.(md\|txt)$` | P2 conflict markers: files exempt |
| `RIG_RESERIALIZE_RX` | `\.json$` | P2: which changed files are checked for a whole-file re-serialization |
| `RIG_RESERIALIZE_MIN` | `200` | P2: changed-line floor (flagged when the `-w` diff is under half of it) |
| `RIG_REGEN_CMD` | unset (P3 skipped, loudly) | P3: regenerate every generated file in the worktree; the tree must stay clean |
| `RIG_REGEN_IGNORE_RX` | `"?generated_at"?\|[Gg]enerated[ _]?(at\|on)?:` | P3: a diff whose only changed lines match is a timestamp, not stale content |
| `RIG_STATIC_CMD` | unset (P4 skipped, loudly) | P4: every static check, keep-going; writes `{out}/SUMMARY` lines `<leg> rc=<n>` |

In `RIG_REGEN_CMD` / `RIG_STATIC_CMD`, `{wt}` is the rig worktree and `{out}` the check's output dir; both run in the worktree
through `RIG_RUN_WRAPPER`. P2 also refuses a moved submodule pin unless `$RIG_STATE/PIN-OK` holds the sha (owner-approved).

**Rig worktree (`rig-worktree.sh`):**

| variable | default | meaning |
|---|---|---|
| `RIG_WORKTREE_INIT_CMD` | unset | run once when the worktree is first created (e.g. the app's worktree bring-up) |
| `RIG_DEPS_CMD` | `npm install --no-audit --no-fund` | run when the lockfile changed or the deps dir is missing; empty = never |
| `RIG_DEPS_LOCKFILE` / `RIG_DEPS_DIR` | `package-lock.json` / `node_modules` | |

**Failure parser (`gate-failures.py`):**

| variable | default | meaning |
|---|---|---|
| `RIG_CARGO_PKG` | none | `-p <pkg>` in cargo re-run commands (nextest lines name their own crate) |
| `RIG_CARGO_CWD` | `.` | repo-relative dir cargo runs in |
| `RIG_CARGO_CHECK_CMD` | `cargo check [-p pkg] --all-targets` | re-run of a failed C1 stage |
| `RIG_UI_CWD` | `.` | repo-relative dir the JS runners run in |
| `RIG_E2E_CMD` | `npx playwright test {spec} --workers=1` | `{spec}` = `path:line` (wrap it in your e2e lock if you have one) |
| `RIG_VITEST_CMD` | `npx vitest run {file}` | |
| `RIG_NODE_TEST_CMD` | `node --test {file}` | |
| `RIG_UI_NODE_TEST_CMD` | `RIG_NODE_TEST_CMD` | for node tests under `$RIG_UI_CWD/src/` (e.g. with a TS loader) |
| `RIG_TEST_STEP_RX` | test tiers (`test-unit`, `vitest run`, `cargo test`, …) | a failed run-steps step matching it is named test by test, never re-run whole |
| `RIG_WRAPPER_STEPS` | empty | `cmd=report;…`: a wrapper step skipped when `<report>.json` lists its inner steps |
| `RIG_STAGING_RX` | derived | regex of staging prefixes to strip from paths |
| `RIG_STAGING_DIRS` | empty | `:`-separated dirs whose children are staging/worktree trees |

By default the parser strips `$RIG_WORKTREE`, `$RIG_REPO` and any `.merge-gate-*` staging dir, the longest prefix first, so the
rig's own worktree is stripped whole.

`rerun-failures.sh` reads `RIG_WORKTREE` (required), `RIG_WORKTREE_HELPER`, `RIG_RUN_WRAPPER`, `RERUN_TRIES`, and the test seam
`RIG_RERUN_NO_CHECKOUT`. `rig-restart.sh` reads `RIG_STATE`, `RIG_BIN`, `RIG_AUTO_MERGE` (default `$RIG_BIN/auto-merge.sh`).

## What the app supplies

- **The gate command.** The kit's `lifecycle/merge-gate.mjs` (its C7/C9 stages come from the app's `.claude/app.config`); make
  those commands keep-going (`scripts/run-steps.mjs`, `cargo test --no-fail-fast`), or the gate hides every failure after the first.
- **Pregate commands:** `RIG_REGEN_CMD` (every generator) and `RIG_STATIC_CMD` (every static leg, keep-going, with a SUMMARY).
- **The delta / impacted-tests command:** `RIG_DELTA_TEST_CMD` (or `RIG_DELTA_CMD`) selecting the tests a set of commits reaches
  from `{base}`.
- **Optional:** `RIG_RUN_WRAPPER` (docker group, thread caps — the kit sets none), `RIG_POST_MERGE_HOOK`,
  `RIG_POST_MERGE_CLEAN_CMD`, `RIG_WORKTREE_INIT_CMD`, and the parser's cwd/command settings.

A minimal `$RIG_STATE/rig.env`:

```bash
RIG_REPO=/srv/app/primary
RIG_RUN_WRAPPER="/srv/app/ops/with-caps.sh"
RIG_REGEN_CMD="just regen"
RIG_STATIC_CMD="bash ops/static-legs.sh {wt} {out}"   # your script: every static leg, keep-going, `<leg> rc=<n>` lines in {out}/SUMMARY
RIG_DELTA_TEST_CMD="node scripts/test-affected.mjs --base {base}"
RIG_CARGO_PKG=app RIG_CARGO_CWD=server RIG_UI_CWD=ui
```

Start it detached: `RIG_STATE=/srv/rig setsid nohup scripts/rig/auto-merge.sh >> /srv/rig/auto-merge.log 2>&1 < /dev/null & disown`.

## Evidence (per run, `$RIG_STATE/runs/<mmdd-HHMM>-<sha>/`)

`pregate/` (SUMMARY, TIMES, logs), `gate.txt`, `mg-auto.log`, `calls.tsv`, `just-<n>-<recipe>.log`, `SUMMARY.md` (timing),
`test-affected/`, `FAILURES.json`, `rerun/` (RERUN.json, verdicts.tsv, rerun-N.log), `recheck/`, `recheck-flake/`, `delta/`.
`$RIG_STATE/REAL-FAILS.json` holds the real failures the next fix tip must clear.

## Testing and changing the rig

```bash
bash scripts/rig/rig-test.sh "$PWD/scripts/rig/auto-merge.sh"   # S0–S12: every decision path; RIG-TEST-FAILED=0
bash scripts/rig/rerun-test.sh scripts/rig/rerun-failures.sh     # the flake rule incl. intermittent tries; 0 failed
```

`rig-test.sh` needs no app: it builds a throwaway bare origin + clone in a mktemp dir (removed on exit; `RIG_TEST_KEEP=1` keeps it),
fakes pregate / gate / rerun / delta, and runs the real loop with this directory's parser, flake pass and timing scripts. Pass a
copy of `auto-merge.sh` to test a change before deploying it.

1. Every scenario PASS.
2. Add a scenario for any new path and show it **fails on the old script and passes on the new one** (two-direction).
3. **Deploy between gates only, by temp file + `mv`. A running bash script must never be edited in place** — bash reads the
   script as it executes, so an in-place write corrupts the running loop. Then `rig-restart.sh` and watch its first real run.
