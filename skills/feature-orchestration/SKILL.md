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

You drive a fleet of worker agents that each implement one feature via the
**feature-lifecycle** skill. Your job: dispatch work, keep workers honest, and
merge their output to `main` cleanly. **Nothing merges to main without the
human's go** unless they've said otherwise.

### Where this sits — the layering (super-epic → epic → feature → worker)
- **Super-epic / epic (>1 interdependent feature, up to 50+ items):** planned by
  the **`epic-lifecycle`** skill FIRST (the DAG in `.lifecycle/<epic>/GRAPH.md`,
  per-item `PLAN.md`, the `RECONCILE.md` contract matrix, a GitHub issue per node).
  This orchestration skill then DRIVES that graph in topological order — one feature
  dispatched per ready (deps-met) node. For a super-epic, the durable STATUS ledger
  + "re-derive from the board after every compaction" rule below is mandatory, not
  optional — you cannot hold 50 items' state in context.
- **Feature:** one node = one worker running `feature-lifecycle` in its own worktree.
- **Worker backend = `dsh-orchestrate`** (`/data/pbya/dsh-orchestrate.sh "<goal>"`,
  launched detached with a hard `timeout`, per-run ledger under `.dsh-orchestration/`).
  Its DRIVING LOOP runs inside dsh (local DeepSeek, free) and dispatches **dsh workers**
  (`/data/pbya/dsh-local.sh`) for implementation + first-line verification; Claude is
  only shelled out to for discrete judgement (`claude --model opus -p`). The run
  reports ready in its ledger; YOU run the merge-gate and merge. **Do NOT dispatch via
  the `bridge-coordinator` agent** (Task/Agent tool): its driving loop runs on Sonnet —
  measured 2026-09-23 in dental, ~200–500K Sonnet tokens per dispatch for conducting
  work dsh does for free. (The older interactive-zellij
  `claude-liveN --remote-control` fleet is **retired** — do not launch it; the rest
  of this doc's "worker/session" guidance now means coordinator/dsh workers.)

## The one rule that everything else serves
**Verify; do not trust.** A session saying "8/8, ready to push" is a *claim*, not
proof. Run the check yourself. This session caught: features that passed their
full lifecycle but didn't compile from clean, migration collisions, dropped
types, plan-trimming, and a merge-gate bug — all by re-verifying instead of
trusting. This is the P1 discipline; it is non-negotiable.

## Dispatching feature work
- One feature per **`dsh-orchestrate`** run, each in its own worktree off
  `origin/main`, running `feature-lifecycle`. The run owns the lifecycle + spawns dsh
  workers; see the script's own brief for the mechanics. Record every run at LAUNCH:
  a queue/board row, the brief in a durable place, the branch pushed.
- Big/architectural features (store refactors, new runtimes) → **plan-first pause**:
  have the coordinator produce phases 1–4 (plan/plan-audit/tests/decisions), then
  **HALT and surface the plan for the human to approve before any code**. Genuine
  architecture judgment on the plan is an **explicit Opus judgment-subagent** call
  (see Model routing) — not the whole coordinator on Opus.
- **`main` is the only gated branch.** Workers may push their work branch and merge
  freely on **feature/epic branches** (node → epic integration branch, etc.) — that's
  normal work. But **never push/merge to `main`**: workers report ready, and YOU run
  the merge-gate + land to `main`. (The pre-push hook exempts `main`, so a self-push
  THERE bypasses the gate — that's the one path that's forbidden.)

### Self-contained briefs — a worker is context-blind by construction
Every dsh worker starts with FRESH context (no memory of prior work), so there is
no "continue your feature" — the brief MUST be fully self-contained. This is the
coordinator's job, but the orchestrator's dispatch to the coordinator follows the
same rule. Every brief states explicitly:
- **What the feature IS** — one or two sentences naming it and what it does.
- **Its status** — merged (+commit) / in-flight / held-for-manual-test.
- **The exact worktree path + branch**, and that its `.lifecycle/<feature>/`
  artifacts (PLAN/TESTS/DECISIONS/HUMAN_FEEDBACK) are there — tell the worker to
  **read those + the code to reconstruct its mental model** (the ledger is the
  durable memory; the worker holds none across dispatches).
- **The task** — what to do now, and the plan-first / no-push-to-`main` rules
  (feature/epic-branch pushes are fine; only `main` is held for you).
(This replaces the old `/clear`-an-interactive-session discipline: dsh workers are
disposable per dispatch, so "self-contained brief" IS the rehydration mechanism.)

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
Every ~20 min, per in-flight coordinator/worktree, check the DURABLE signals (not a
screen — dsh workers have no interactive screen): the worker's `.bc-report-*.md`
verdict + `.bc-dispatch.log`, `git log`/uncommitted in the worktree, `%idle`, and
**`detect-worker-loops.py`** for a stuck worker. Run `lifecycle-check --all`
YOURSELF (don't trust the report). Diagnose progress vs done-waiting vs a dodge
below. Handle each **specifically** (tailored to that worktree's actual state).
Hold any push/merge to `main` (feature/epic-branch pushes are fine). Leave
genuinely-done-waiting work alone. Reschedule the next
tick. Wind down when fully static for 2+ cycles.

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

## Landing: gate v2 (a batch reaches main through ONE full gate)

The full gate takes hours, and a gate that stops at its first red and is re-run after every fix costs one full cycle
per failure. Three owner rules (dental, 2026-10-12) replace that:

1. **Never run the full suite twice.** A batch gets the full gate at most once. When it fails, re-run each failure
   alone; a flake counts as a pass; a real failure is fixed and then **only the failed items** are re-run.
2. **Never stop at the first failure.** Every check and test runs to the end; all failures are gathered and fixed at once.
3. **Catch what you can before the tests.** A cheap pregate runs first.

The loop, per candidate tip of the integration branch:

```
candidate tip (quiet for ~60 s)
 ├─ 1. PREGATE (minutes, keep-going; exit = number of red checks)
 │     structural   merge-gate.mjs --skip-heavy (C4 stale, C2 migrations, staging merge, P2, C5)
 │     hygiene      conflict markers · parentless commits · submodule pins == main · shared JSON re-serialized
 │     regen-clean  the regen + API-schema regen leave the tree clean (timestamp-only diffs ignored)
 │     static legs  every static check (types, lint, clippy, spec lints) to the end
 │   red → HOLD with the whole list; the full gate never starts
 ├─ 2. RECHECK (only when the tip descends from the recorded REAL-FAILS sha — i.e. it is the fix)
 │     re-run ONLY the recorded real failures (1 try; an INTERMITTENT one needs 3/3 alone)
 │     anything still red → broken into named tests → each alone 3× (flake rule)
 │     + the fix commits' impacted tests (the app's test selector with --base <failed sha>)
 │   green → MERGE, no second full gate · red → REAL-FAILS advances to this tip, HOLD
 └─ 3. FULL GATE (at most once per batch), with keep-going check and test commands
       green → MERGE
       red   → name every failure → re-run each ALONE 3×
                all 3/3 green (flakes) → MERGE (tip moved meanwhile? record an EMPTY REAL-FAILS so the next tip is a recheck)
                any real → write REAL-FAILS (sha + items) + HOLD
```

- **Flake rule:** a failure is a flake only if it passes **3 of 3** runs alone on the same sha. 2/3 is real. A real
  failure that passed at least once alone is **intermittent** and is recorded with `"tries": 3`, so its recheck needs
  3/3 again — a one-try recheck would pass a 2-in-3 failure two times in three. *Measured (dental c240):* an auth-store
  test went pass/pass/fail alone; the one-try recheck would have merged it unexamined.
- **Keep-going commands.** `just` dependency lists and `npm` `&&` chains stop at the first red step, so the gate's
  check/test commands must be keep-going variants: a step runner that runs every leg and exits non-zero if any failed
  (`scripts/run-steps.mjs` here), `cargo test --no-fail-fast`, nextest `--no-fail-fast`. Each run writes a per-step
  report (cwd, command, rc, seconds) so the rig can re-run exactly the failed steps. *Measured:* the old gate hid a
  batch's integration reds and warning regressions behind its first red leg; keep-going surfaced all 11 failures of a
  batch in one pass.
- **Name every failure.** Parse the gate's captured output (test runners' failure lines, per-step reports) into
  re-runnable items, each with its own cwd and command. Strip the gate's staging-path prefix before naming a file,
  including a persistent rig worktree's. A failure that cannot be named (a compile error) is real and needs a human.
- **Keep the evidence.** Each run leaves a directory: pregate summary, per-call timing (start, end, seconds, rc) for
  every `just`/`cargo` call the gate made, the named failures, every rerun's verdict and log. A gate's passing output
  is otherwise discarded, and without timing you cannot tell where the hours go.
- **Staging cleanup** removes only the gate's own throwaway staging directories — never a persistent rig worktree.
- **Changing the rig** goes through a sandbox harness that drives the real loop against a throwaway repo with fake
  pregate/gate/rerun commands (every external step overridable by env for this), and every change ships with a
  scenario that **fails on the old script and passes on the new one**. Deploy between gates only, by temp file + `mv`
  (a running bash script must never be edited in place).

Reference implementation: the dental app's `ops/rig/` (loop `auto-merge.sh`, pregate, failure parser, alone-rerunner,
recheck flake pass, timing shims, the two sandbox harnesses) and `docs/MERGE-GATE.md`. This kit ships the portable
pieces: `scripts/run-steps.mjs` (keep-going step runner) and `scripts/rig/rerun-failures.sh` + `rerun-test.sh` (the
flake-rule runner and its harness).

### Repo conventions the gate depends on

- **Generated files never conflict.** Mark every proven-generated file `merge=regen` in `.gitattributes` with the
  driver `git config merge.regen.driver true` (keep one side), and regenerate after every merge; the pregate refuses a
  stale generated file. List a file only after proving it fully derived: blank it, regenerate, byte-identical apart from
  timestamps. Never list a hand-maintained file.
- **Tree-mutating test suites run serially** (`node --test --test-concurrency=1` for mutation batteries — concurrent
  ones overwrite each other's mutations).
- **Wrappers pass flags, never env,** to tools that nested processes also run (an exported `JUST_VERBOSE` from a timing
  wrapper changed the output that a nested test asserted on).

## Epic throughput — no idle levels, no idle runs

- **Land providers at phase 5** and **pre-plan dependents** while providers build (`feature-lifecycle`, `epic-lifecycle`).
- **Relaunch early stops mechanically.** A run that exited without a finish line (`feature-lifecycle`, *The finish
  line*) is relaunched by a tick, not noticed by a human. Read the finish line on the branch's first-parent history.
- **Side runs never take build slots.** Pre-plans and reviews use their own worktree prefix.
- *Measured (dental, five builds):* about half of the wall time was runs not alive; model generation was 51–78% of
  the working time; the tests and builds themselves were 10–20%. Idle time and landing waits were the biggest levers, not test speed.

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

## Model routing — Sonnet orchestrator + Opus only for judgment (MEASURED #1 rate lever)
Opus ≈5× Sonnet, ≈15× Haiku per token, and a measured audit found the biggest
avoidable line-item was **an expensive model doing cheap conducting work** (an
inherited-Opus subagent doing dispatch; the interactive orchestrator on Opus for
every turn). Most orchestration — dispatch, status tracking, the merge protocol,
reading worker verdicts, the keep-honest loop — is **Sonnet-tier**. Reserve Opus
for GENUINE judgment: epic architecture, a hard adjudication, gnarly debugging.

- **Default the orchestrator to Sonnet.** Run the driving loop on Sonnet.
- **Spend Opus as an explicit JUDGMENT SUBAGENT, not by running the whole session
  on Opus.** When a genuinely Opus-worthy decision arrives, spawn a one-shot
  env-stripped `claude --model opus` for THAT decision and take its verdict — the
  same pattern dsh-orchestrate uses for its adversarial finding-verify. This
  buys Opus judgment without paying Opus rates on every dispatch turn.
- **Do NOT flip `/model` mid-session to "use Opus just for the hard turn"** — a
  model switch INVALIDATES the prompt cache (full uncached re-read). Pick one model
  per session; escalate via a subagent instead.
- **Conducting runs on free dsh, not on a Claude model at all** (`dsh-orchestrate`);
  only its adversarial verify shells out to explicit Opus.
- **VALIDATE, don't assume:** the orchestrator's "verify, don't trust" catching is
  its core value (it caught real main-reds). Run one campaign on the Sonnet+Opus-
  judgment structure and confirm with `ccusage` (cost dropped) AND that the
  catch-rate held (it still caught the dodges) before making it the blanket default.

## Context cost — the orchestrator's own bill is the biggest lever (MEASURED)
The orchestrator runs on the expensive model (Opus). Delegating the *work* to
cheap/free workers does NOT move the orchestrator's own per-turn cost — and a
measured 4h sample found **~85% of Opus spend was the long-lived interactive
orchestrator sessions, not the workers** (the worker subagents were $19–24 each;
the orchestrators were $89–174). The dominant component was **cache-WRITE (~60%)**,
not output (~11%): cache-write is billed every time a turn ADDS new content to
context, so the cost is driven by **how much you pull into your own context each
turn**, not by how many workers you spawn. Two rules follow:

- **Keep big content OUT of your own context — delegate inspection.** Never read a
  large file, a full diff, a worker transcript, or a long log into the orchestrator
  directly (each big read is a big cache-write, re-billed as the context grows).
  Dispatch a worker/subagent to read it and return a short verdict/summary; read
  only that. This is the same "read the verdict, not the transcript" discipline the
  worker coordinator uses — it applies to the orchestrator too, and this is where
  the spend now concentrates. (One measured session was adding ~40–60K new tokens
  of context PER TURN, almost all from direct large reads.)
- **Compact while the cache is still WARM, not aggressively early.** Set
  **`autoCompactWindow: 0.75`** — auto-compact at ~75% of the model window (compaction
  is itself a full-context summarization call, cheap only while the cache is warm; too
  early or cold costs MORE, and our measured cache is already warm ~39:1 read:write, so
  aggressive low thresholds are the wrong move). **CHECK and SET this PER-PROJECT** in
  the repo's **`.claude/settings.json`** (`"autoCompactWindow": 0.75`) — NOT the global
  `~/.claude/settings.json` (each project decides; a global value bleeds into unrelated
  sessions). At session start, confirm it's present for this project; add it if missing.
  (A fraction like `0.75` is model-window-relative, so it's correct regardless of
  whether the session is on a 200K or ~1M window; a raw token count would need
  per-model tuning — don't. Do NOT set it near the fixed floor — system prompt + tools
  + `CLAUDE.md` + skills is already ~60–115K tokens; a low threshold would compact on
  almost every turn.) **This is a MINOR lever** — the big wins are model routing (above)
  and not accumulating one giant long-lived session. Also `/compact` manually at natural
  breakpoints (after a feature merges, before switching campaigns), and prefer
  `/clear` + a fresh self-contained message over resuming an hours-old session for
  a NEW task — a long resumed session carries its whole history into every turn.

## The task list must survive compaction — it lives on DISK, not in context
Compaction summarizes context, so **anything you only remember in-context can be
lost** — for a super-epic (>50 items) that is catastrophic: the orchestrator forgets
what's done, what's in flight, and what's next. Rule: **the task list and its live
status are a durable EXTERNAL ledger; your context is disposable.** Never hold "where
I am in the epic" only in your head.

- **Source of truth = the GitHub issue board + the epic's on-disk graph.** One issue
  per epic node (`epic-lifecycle` mandates this); status lives in issue state +
  labels (`blocked-by` edges, `in-progress`/`done`). The DAG + topo order + leaf set
  are in `.lifecycle/<epic>/GRAPH.md`. Together these encode done / ready / blocked /
  next WITHOUT any context.
- **Keep a one-line-per-item STATUS ledger** at `.lifecycle/<epic>/STATUS.md`
  (`ITEM — todo|in-progress(worktree)|in-review|merged|blocked(by X) — <note>`),
  updated as a coordination artifact each time an item changes state, and committed.
  It is the cheap, human- and orchestrator-readable mirror of the board; a worker
  never writes it (you do).
- **RE-DERIVE state after every compaction / `/clear` / resume — do not trust
  memory.** First action of a fresh or just-compacted orchestrator turn: read the
  board (`gh issue list --state open` + closed for the epic) and `GRAPH.md`/
  `STATUS.md`, and reconstruct "done / ready-now (deps met) / blocked / in-flight"
  from THAT. This is cheap (statuses, not the work) and it is the whole reason the
  ledger exists. **Update the board/STATUS the instant an item changes state**, so a
  compaction that lands the next second loses nothing.
- The point of aggressive compaction (above) is only SAFE because of this: you can
  compact freely precisely because the plan and progress are reconstructable from
  disk. If you ever find yourself reluctant to compact "because I'll forget the
  list", that means the ledger is stale — fix the ledger, then compact.

## Hygiene
- Merge deletes the remote branch AND removes the local worktree (else worktrees
  + `target/` dirs accumulate — this session reclaimed ~585 GB of them).
- Scratch/logs under `/data/pbya/ziee/tmp`, not `/tmp` (small, shared).
- Never `#[ignore]`/`.skip` to make a suite green; never fake a PASS line.
