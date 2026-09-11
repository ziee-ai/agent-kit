---
name: claude-md-organization
description: >
  How to structure a project's CLAUDE.md so it does not silently tax every turn
  and every subagent. Load this when a CLAUDE.md has grown large (roughly >8-10K
  tokens / >150 lines), when spawning many subagents, or when auditing token/context
  cost. CLAUDE.md is re-sent on EVERY turn AND loaded in full into EVERY subagent's
  context, so its size is a per-turn × per-subagent multiplier — not a one-time load.
  This skill: measure the real floor, classify content (always-needed core vs
  on-demand reference), move domain/reference sections into on-demand skills, and
  verify the reduction. Project-agnostic; apply it to whichever repo's CLAUDE.md you
  are in.
---

# Organizing CLAUDE.md (stop paying for it on every turn and every subagent)

## Why this matters (MEASURED, not stylistic)
`CLAUDE.md` is loaded into the system-prompt region **once at session start** — but
that region is **re-sent on every turn** (as cached input) AND **re-loaded in full
into every subagent you spawn**. Measured on one repo: a **~33K-token / 130KB**
CLAUDE.md meant every native subagent booted with a **73–103K-token floor** before
doing any work, and the same 33K rode every turn of the main session. So CLAUDE.md
size is a **multiplier**: `size × turns × (1 + subagents)`. A bloated CLAUDE.md is
the single most-duplicated token cost in a multi-agent workflow.

Two consequences drive everything below:
- **Every token in CLAUDE.md is paid on every turn.** Reference material that is
  needed 5% of the time is taxed 100% of the time.
- **Subagents inherit it whole** (a native Claude subagent auto-loads project +
  user CLAUDE.md; it cannot be told to skip it short of safe-mode). So fan-out
  multiplies the waste. (A local/free worker also loads it — free there — which is
  a reason to push CLAUDE.md-heavy bulk work onto a free engine and keep the
  expensive native-subagent fan-out thin.)

## The one rule
**CLAUDE.md holds only what is needed on ALMOST EVERY turn. Everything else moves to
an on-demand skill** (loaded only when its trigger fires) **or a doc that is read
when relevant** (not `@import`ed into the always-on context).

## What BELONGS in CLAUDE.md (the always-on core — keep it small)
- Build/run/test entry points the agent needs constantly (the aggregate check, how
  to run the app, where things live).
- Hard invariants and non-negotiable rules that apply to nearly all work (naming,
  "never push to main", security/permission musts).
- The map: where modules live, the monorepo layout, how to find things — pointers,
  not the content.
- A short index of the on-demand skills/docs and WHEN to load each.

## What does NOT belong (move it out)
- **Per-feature / per-module deep docs** (one section per subsystem: memory, sandbox,
  chat, sync, each module's test tiers, migration details). These are needed only
  when working on that subsystem → **each becomes a skill** whose description names
  the trigger, so it loads only then.
- **Long reference tables, enumerations, historical notes, "known issues" logs,
  changelog-style prose.** → a doc read on demand, or a skill.
- **Anything that reads "in case you need it."** If it is conditional, it is
  on-demand by definition.

## Method (apply to the CLAUDE.md you are in)
1. **Measure the floor.** Run `/context` (or wc the file: `wc -mc CLAUDE.md`,
   ~4 chars/token) to get the current token size and see what dominates. Record it —
   this is your before-number.
2. **Classify every section** as **CORE** (needed almost every turn) or **ON-DEMAND**
   (needed only for a specific kind of work). Be honest: most large CLAUDE.md files
   are 70-90% on-demand.
3. **Move each ON-DEMAND cluster to a skill.** Create `skills/<topic>/SKILL.md` with
   a `description` that states the TRIGGER ("Load when working on <subsystem>/<task>").
   The skill body is the moved content, verbatim. The agent auto-loads it only when
   the trigger matches — so that content costs 0 tokens the rest of the time.
4. **Leave a one-line pointer** in CLAUDE.md: "For <subsystem>, load the `<skill>`
   skill." (Pointers are cheap; content is not.)
5. **Do NOT `@import` the moved docs back in.** An `@import` in CLAUDE.md is loaded
   into the always-on context exactly like inline text — it defeats the move. Import
   only the small always-on core (if you split the core across files).
6. **Re-measure.** Run `/context` again; confirm the floor dropped. Confirm nothing
   CORE was lost (the agent can still find how to build/run/test from CLAUDE.md alone).

## Guardrails
- **Never move a rule that must fire unprompted** (a security must, "never push to
  main") into an on-demand skill — a skill that only loads when asked cannot enforce
  an always-on invariant. Those stay in CLAUDE.md.
- **A skill's `description` is the whole game** — it is what the agent sees to decide
  whether to load the skill. Write the trigger precisely; a vague description means
  the skill never loads (content lost) or always loads (no saving).
- **Keep the moves content-preserving.** This is reorganization, not rewriting —
  move sections verbatim so no guidance is lost; the goal is *where* it lives, not
  *what* it says.
- **Verify, don't assume the saving.** The before/after `/context` numbers are the
  proof; a reorg that didn't drop the floor didn't work.

## Related
- Pairs with `feature-orchestration` (its "Context cost" + model-routing sections
  cover the session-level levers; this skill covers the CLAUDE.md-specific one).
- Same principle as deferred tools / on-demand skills generally: **conditional
  content should be loaded conditionally, not carried always.**
