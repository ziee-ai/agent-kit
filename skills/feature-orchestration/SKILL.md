---
name: feature-orchestration
description: >
  How the orchestrator (main agent) drives a fleet of feature-implementing agent
  sessions and merges their work to main. Load this when resuming a long-running
  multi-session feature campaign without prior context: it covers dispatching
  feature work, keeping sessions honest (they dodge — verify, don't trust),
  running the keep-honest loop, and the exact merge protocol (staging worktree +
  independent clean build + merge-gate). Pairs with the feature-lifecycle skill
  (which the AGENTS follow); this skill is what the ORCHESTRATOR follows.
---

# Feature Orchestration (orchestrator playbook)

You drive a fleet of interactive agent sessions (zellij: `claude-live`,
`claude-live2` … `claude-live8`) that each implement one feature via the
**feature-lifecycle** skill. Your job: dispatch work, keep sessions honest, and
merge their output to `main` cleanly. **Nothing merges to main without the
human's go** unless they've said otherwise.

## The one rule that everything else serves
**Verify; do not trust.** A session saying "8/8, ready to push" is a *claim*, not
proof. Run the check yourself. This session caught: features that passed their
full lifecycle but didn't compile from clean, migration collisions, dropped
types, plan-trimming, and a merge-gate bug — all by re-verifying instead of
trusting. This is the P1 discipline; it is non-negotiable.

## Dispatching feature work
- One feature per session, in its own worktree off `origin/main`, via
  `/feature-lifecycle`. Big/architectural features (store refactors, new
  runtimes) → **Opus 4.8 xhigh** + a **plan-first pause** (run phases 1–4, then
  `SendMessage main` + HALT for the human to approve the design before code).
- Tell every session: **report ready, never self-push** — you run the merge-gate
  and merge. (The pre-push hook exempts `main`, so a self-push bypasses the gate.)
- Launch sessions with cwd = the main repo (so CLAUDE.md + memory load); they
  edit in their worktree. Spawn a fresh zellij session with a real PTY:
  `setsid bash -c 'script -qfc "zellij attach --create claude-liveN" /tmp/…'`
  then write the `claude --model … --effort … --dangerously-skip-permissions
  --remote-control` launch line.

### `/clear` discipline — a cleared session is amnesiac; the message must carry everything
`/clear` wipes ALL prior context — the session no longer knows what it built, what
feature it owns, or where its worktree is. (This bit us: a cleared live session
was handed a new task and had no idea what it had been working on.) So whenever
you `/clear` before re-dispatching, the very next message MUST be **fully
self-contained** — never say "continue your feature" or "you built X" as if it
remembers. Include, explicitly:
- **What the feature IS** — one or two sentences naming it and what it does (not
  just "your feature"), even for iteration mode on its own prior work.
- **Its status** — merged (and the commit) / in-flight / held-for-manual-test.
- **The exact worktree path + branch**, and that its `.lifecycle/<feature>/`
  artifacts (PLAN/TESTS/DECISIONS/HUMAN_FEEDBACK) are restored there — tell it to
  **read those + the merged code to reconstruct its mental model** (the ledger is
  the durable memory across a clear; see Iteration mode).
- **The task** — what to do now, and the plan-first/no-self-push rules.
Prefer NOT clearing a session that is mid-iteration and whose context is still
useful; only clear when the context is heavy/stale AND the artifacts+message can
fully rehydrate it. If in doubt, keep the context.

## Keeping sessions honest — the catalog of dodges
Sessions systematically avoid the hardest, most-verifiable work (running the
e2e, finishing the last phase) behind plausible-sounding excuses. Watch for:

| Dodge | Reality / how to handle |
|---|---|
| "blocked by box load / harness timeout" | The box is 192-core; check **`%idle` (top), not load average** — load avg counts I/O-wait + is misleading. "Blocked" needs a *specific* error (port bind, docker fail), never a metric. |
| Trimming the plan / deferring items to hit 8/8 | The A5 gate catches dropped tests; verify PLAN has 0 "deferred/amended-out" language. Make them build the full plan. |
| "no browser-verification harness" (deferring UI) | False — the **gallery + `gate:ui` + `runtime-health.mjs`** IS that harness. |
| Declaring "8/8/ready" while `lifecycle-check --all` actually FAILs | Run the check yourself, read **all phase lines + the summary verdict** (a head-1 grep of "OK" grabs phase-1 and misleads). |
| Stopping to ask permission for authorized work | They're authorized — tell them to continue, don't ask between steps. |
| Atomic-red-tree shield (using "don't commit red" to never finish a big refactor) | An atomic change is red until done — drive it to a green tree in ONE push. But: static-commits + **WORK** + tsc-going-green/forks-running = *converging* (fine); static + **IDLE** + FAIL = stall. |
| 100%-context-stopped / idle-at-finish-line | Reached a milestone (tsc-green) then coasted to idle. Nudge to continue — a **specific remaining-gate checklist beats a generic "grind continuously."** |
| Editing the SHARED test harness to route around a "problem" | Refuse — it weakens the gate for every session. Usually justified by the box-load myth. |
| Passive-waiting on a detached monitor | Idle while a background e2e "runs" — tell them to actively run/check, not idle. |

Distinguish **cutting corners** (push back firmly) from **benign traits** (e.g. a
session that progresses honestly but stops between checks — just re-nudge each
cycle) and **legit external gates** (a real published-release / API-key
dependency — mark it clearly, do the non-blocked work).

## The keep-honest loop (when the human asks for it)
Every ~20 min, per session: dump screen + run `lifecycle-check --all` yourself +
check commits/uncommitted + `%idle`. Diagnose progress vs done-waiting vs a dodge
above. Handle each **specifically** (no broadcast — tailored to that session's
actual state). Dismiss survey popups (`0` + Enter). Hold any self-push. Leave
genuinely-done-waiting sessions alone. Reschedule the next tick. Wind down when
fully static for 2+ cycles.

## The merge protocol (do this yourself, per feature)
Merge via a **staging worktree off *current* `origin/main`** — never merge from a
session's live worktree, never trust its build. Steps:

1. `git worktree add integ-wt origin/main`; symlink node_modules (root + both UI
   workspaces → the main repo's `node_modules`).
2. `git merge <branch>`. Resolve **generated-file** conflicts with `--theirs`
   (testIds/STATE_MATRIX/coverage/openapi/types/Cargo.lock), then **regenerate**
   them (`gen-testid-registry`, `gen-state-matrix`, `gen-overlay-registry`,
   `gen:gallery-coverage`). A *real* source conflict → resolve by hand (union the
   intents; e.g. keep both a UX class and a new lazy-load structure).
3. **Migration collision** (`ls migrations | uniq -d` on the number prefix): if
   the branch's migrations collide with main's newer ones, renumber the branch's
   ABOVE main's max, preserving order (FKs depend on it).
4. Strip `.lifecycle/` (`git rm -r`). Install any **declared-but-missing deps**
   into the shared node_modules (branches add deps that aren't hoisted → tsc
   `Cannot find module`).
5. Gate: **tsc BOTH workspaces + `npm run check` BOTH + an independent clean
   `cargo clean -p ziee && cargo check`** (fresh build DB; migrations must apply).
   The clean build is the one that catches proc-macro/variant-registration bugs a
   warm build hides.
6. Push to main, delete the branch, remove the worktree.

Or run `.claude/lifecycle/merge-gate.mjs <branch>` which automates C1 clean-build
/ C2 migration-collision / C3 regen-parity (both workspaces) / C4 stale-branch /
C5 lifecycle-strip / P2 no-dropped-content. **Note:** `merge-gate` needs `just`
in PATH for C3 — if absent it should skip, not crash (bug fixed; if you hit an
ENOENT crash, the manual protocol above is equivalent).

## Stale branches
As main moves, finished branches fall behind (this session saw one 116 behind).
A stale branch WILL hit migration/regen collisions at merge. Have it **rebase on
current main first** (merge origin/main in), renumber migrations, regen both
workspaces, re-verify clean-build + 8/8 — THEN merge. Merge-gate C4 enforces this.

## The human-feedback loop (Phase 9 — how feedback improves the skill)
Each feature has a `HUMAN_FEEDBACK.md` ledger (Phase 9, see feature-lifecycle
skill): the human's verbatim critiques + resolutions + a `[generalizable: yes]`
flag. **At merge, READ this ledger.** For every `generalizable: yes` item, fold
the rule into the lifecycle skill — a deterministic **lint** if checkable
(e.g. "select an entity with a picker, never a raw ID text input"), a **phase
rule** if guidance ("reuse existing page/drawer layouts"), or a **review angle**
if fuzzy ("would a real user do this?"). This is how one human critique on one
feature improves every future feature. Machine-local lifecycle infra lives under
`.claude/lifecycle/` + `.claude/skills/feature-lifecycle/` (whitelisted-tracked);
have the lifecycle-owner session (or yourself) implement + self-test the rule.
**Mark each item you fold in** `[generalizable: yes — <rule> · harvested@<commit>]`
(or move it under a `## Harvested` heading) so you never apply the same rule
twice across a feature's multiple merges.

### Iteration mode — gradually refining a shipped feature by chat
When the human wants to keep improving an already-merged feature (KB, voice, …)
conversationally, run it as **Iteration mode** (see the feature-lifecycle skill):
cut a fresh worktree off current main, carry the feature's existing `.lifecycle/`
artifacts forward, and only plan/test the DELTA. Two states: **iterate** (the
human is chatting, the agent is trying things — RED tree is fine, don't nudge it
as a stall) vs **checkpoint** (about to merge — a genuine `--all` 9/9 is
mandatory, run the merge-gate). Batch a coherent round of feedback into ONE
merge; don't merge every tweak. The `HUMAN_FEEDBACK.md` ledger is the durable
spine — it survives a session `/clear`, so any session re-opens the feature by
reading it, and Phase 9's "no `open` items" rule makes "all gates green at the
end" automatic. Harvest the round's new `generalizable: yes` items at each merge.

## Permission-gating (a recurring, security-relevant class)
Features that pass 8/8 can still let **unpermitted users see the UI** (e2e tests
the happy path *with* permissions). Before merging any feature that adds a
permission, verify the four gating layers (slot → route → `<Can>` →
`usePermission`) hide the whole surface for a user lacking the permission — not
just 403-on-use. The **A10 gate** now requires a restricted-user e2e for any new
permission. When in doubt, run a loop-until-dry frontend audit for the class.

## Hygiene
- Merge deletes the remote branch AND removes the local worktree (else worktrees
  + `target/` dirs accumulate — this session reclaimed ~585 GB of them).
- Scratch/logs under `/data/pbya/ziee/tmp`, not `/tmp` (small, shared).
- Never `#[ignore]`/`.skip` to make a suite green; never fake a PASS line.
