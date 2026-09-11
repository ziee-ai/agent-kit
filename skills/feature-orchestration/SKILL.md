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
- **Worker backend = the `bridge-coordinator`** (spawned via the Task/Agent tool),
  which dispatches **dsh workers** (`/data/pbya/dsh-local.sh`, local DeepSeek,
  effectively free) for implementation + first-line verification. The coordinator
  reports ready; YOU run the merge-gate and merge. (The older interactive-zellij
  `claude-liveN --remote-control` fleet is **retired** — do not launch it; the rest
  of this doc's "worker/session" guidance now means coordinator/dsh workers.)

## The one rule that everything else serves
**Verify; do not trust.** A session saying "8/8, ready to push" is a *claim*, not
proof. Run the check yourself. This session caught: features that passed their
full lifecycle but didn't compile from clean, migration collisions, dropped
types, plan-trimming, and a merge-gate bug — all by re-verifying instead of
trusting. This is the P1 discipline; it is non-negotiable.

## Dispatching feature work
- One feature per **bridge-coordinator** dispatch (Task/Agent tool), each in its
  own worktree off `origin/main`, running `feature-lifecycle`. The coordinator owns
  the lifecycle + spawns dsh workers; see its own definition for the mechanics.
- Big/architectural features (store refactors, new runtimes) → **plan-first pause**:
  have the coordinator produce phases 1–4 (plan/plan-audit/tests/decisions), then
  **HALT and surface the plan for the human to approve before any code**. Genuine
  architecture judgment on the plan is an **explicit Opus judgment-subagent** call
  (see Model routing) — not the whole coordinator on Opus.
- **Workers report ready, never self-push** — YOU run the merge-gate and merge.
  (The pre-push hook exempts `main`, so a self-push bypasses the gate. This is a
  HARD CONSTRAINT in the coordinator too: workers never merge/push.)

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
- **The task** — what to do now, and the plan-first/no-self-push rules.
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
Hold any self-push. Leave genuinely-done-waiting work alone. Reschedule the next
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
  same pattern the bridge-coordinator uses for its Phase-5 finding-verify. This
  buys Opus judgment without paying Opus rates on every dispatch turn.
- **Do NOT flip `/model` mid-session to "use Opus just for the hard turn"** — a
  model switch INVALIDATES the prompt cache (full uncached re-read). Pick one model
  per session; escalate via a subagent instead.
- **The bridge-coordinator subagent runs `model: sonnet`** for the same reason
  (conducting is Sonnet-tier; its Phase-5 verify is explicit Opus).
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
