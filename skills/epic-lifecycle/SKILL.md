---
name: epic-lifecycle
description: >
  Plan a whole DEPENDENCY-CONNECTED epic coherently BEFORE building any of it.
  Sits one layer above `feature-lifecycle` (which plans/builds ONE item) and
  before `feature-orchestration` (which dispatches builds + merges). Given an
  epic whose backlog items depend on each other, it: builds the dependency DAG,
  plans the LEAVES first, then plans each dependent AGAINST ITS DEPENDENCIES
  ASSUMED-BUILT (planned, never actually built), and RECONCILES the whole tree by
  matching each consumer's assumed contract against what its provider's plan
  delivers — the union of downstream needs pins upstream scope, so a leaf can't be
  descoped below what a downstream item requires. The output is a set of
  cross-checked, contract-pinned, feature-lifecycle-ready plans for the ENTIRE
  epic. Use when starting a multi-item epic (from a GitHub backlog or a design
  doc's task breakdown) where items have real dependencies.
---

# Epic Lifecycle — plan the whole tree, reconcile the contracts, then build

## Why this exists (the failure mode has four names)

An agent planning ONE item optimizes for *that item passing*. Given a leaf with no
visible consumer, it will **descope** a capability to make its own plan smaller —
and nothing catches it, because the downstream item that needed that capability is
a different plan the agent never saw. Every piece is individually green; the seams
don't line up; the integrated result is useless.

This is not one problem — it is a **named, studied** failure from four angles, and
they converge on one fix:

- **Suboptimization** (Deming): "the obligation of any component is to contribute
  its best to the *system*, not to maximize its own production." Optimizing parts
  in isolation degrades the whole. A DAG of agents each maximizing "my story
  passes" is textbook suboptimization.
- **Conway's Law**: interfaces form along builder boundaries; debt accumulates at
  boundary mismatches. Sub-agents are teams — split without an agreed edge
  contract and you reproduce seam-drift.
- **Horizontal slicing**: decomposing by layer means no piece delivers value alone
  and integration mismatches surface late.
- **Specification gaming / multi-step reward hacking** (DeepMind; 2025-26
  coding-agent benchmarks): an agent satisfies the *literal* objective while
  violating intent; the multi-step variant — each step innocuous, jointly a cheat
  — is the hardest to catch, and is exactly "descoped a capability a downstream
  item needed."

**The established fix, common to all four: make the integration contract a
first-class, downstream-owned, executable planning artifact that the upstream
executor cannot weaken.** This skill is that fix, applied to an epic's DAG.

## Prior art this is built ON (cite it; don't reinvent it)

- **Consumer-Driven Contracts** (Ian Robinson / Fowler; Pact) — the backbone of
  the *reconcile* step. Robinson's inversion: the **consumer-driven contract = the
  UNION of all consumers' expectations, and that union is the provider's binding
  obligatory scope.** "A service is of value only to the extent it is consumed."
  Pact makes it drift-proof: the provider *replays* each recorded consumer
  expectation against itself; `can-i-deploy` blocks a release that breaks a
  recorded need. → our Phase 3 + the "every PROV is an acceptance test" rule.
- **Design by Contract** (Meyer) — express each edge as **preconditions** (what the
  dependent may assume) / **postconditions** (what the provider guarantees) /
  invariants, one obligation per side. → the `Consumes`/`Provides` grammar.
- **Specification by Example / BDD** (Adzic / North) — concrete Given-When-Then
  examples are simultaneously requirement, acceptance test, and living doc. → each
  edge contract is an executable example the provider must pass; it becomes the
  consumer's Definition-of-Done.
- **LLMCompiler / ReWOO + classical multi-agent plan-reconciliation** — a
  DAG-of-tasks-with-explicit-dependency-edges plan, plus a first-class
  reconcile/repair pass (a "Joiner" that decides finish-or-replan). → Phases 0/3
  and the repair escape hatch.
- **CPM/Bazel leaves-first topological build + Working-Backwards/MEA backward
  decomposition** — decide *what* each item must expose top-down from the goal;
  build *when* bottom-up leaves-first. → Phase 2 direction + Phase 4 build order.
- **Walking Skeleton / Tracer Bullet / Steel Thread** + vertical slicing — a thin
  end-to-end slice through every seam surfaces mismatches before full builds. →
  optional Phase 1.5.
- **GitHub Spec-Kit / Spec-Driven Development** — spec→plan→tasks as durable
  artifacts before code. → the whole artifact model.

> Produces PLANS, not code. Each item is planned through `feature-lifecycle`
> **phases 1–4 (the whole planning half: PLAN → PLAN_AUDIT → TESTS → DECISIONS)**,
> stopping before phase 5 (IMPLEMENT). "Assume built / don't build" means *stop
> before phase 5* — NOT skip the rest of planning. Phases 2–4 are what make each
> contract **grounded** (phase 2 audits it against the real codebase → no frozen
> impossible contract), **executable** (phase 3 renders it as the acceptance test
> that IS the contract — Specification-by-Example / Pact, so reconciliation matches
> test-vs-test, not prose-vs-prose), and **stable** (phase 4 resolves decisions so a
> deferred choice can't later shift a frozen `Provides` out from under a dependent).
> "Assume built" = plan against the declared contract (need-driven / outside-in TDD:
> stating what you need from a not-yet-built collaborator IS the design of its
> interface), recorded in `ASSUMPTIONS.md` — never actual code. Guard against BDUF
> with JEDUF: phases 3–4 pin the SEAMS (the downstream-bound contracts); each item
> keeps internal freedom and a build may change internals without re-reconciling.

---

## The layered stack (know where you are)

| Skill | Scope | Produces |
|---|---|---|
| **`epic-lifecycle`** (this) | a whole dependency-connected EPIC | reconciled per-item plans + a contract matrix |
| `feature-lifecycle` | ONE item, plan→build→audit | a merged, tested feature |
| `feature-orchestration` | dispatching + merging a fleet of item builds | items landed on main |

Run `epic-lifecycle` ONCE per epic, up front. Its per-item plans feed many
`feature-lifecycle` runs; `feature-orchestration` dispatches those.

---

## Artifacts

Under `.lifecycle/<epic>/` (committed on an `epic/<slug>` planning branch).

**Push the planning branch to origin — do not leave it local.** These artifacts
(the graph, the reconciled contracts, the whole plan) are the deliverable; a
machine move or a lost worktree wipes local-only work. Push `epic/<slug>` to origin
as you go so the plan is durable and portable across machines — it is a WIP branch,
NEVER merged to main, so a backup push (`git push --no-verify -u origin epic/<slug>`,
bypassing the mid-lifecycle pre-push gate, which exists to block *merges* to main,
not backups) is the correct move. Same for each item's `feat/<slug>` build branch
once building starts.

- `GRAPH.md` — the dependency DAG, topological order, leaf set, assumed-available
  substrate (already-shipped code + external blockers — boundary inputs, not
  planned here).
- `<item>/PLAN.md` — per item: the normal `feature-lifecycle` PLAN sections PLUS
  `## Provides` and `## Consumes` (below). These ARE the phase-1 plans the eventual
  `feature-lifecycle` build consumes verbatim.
- `RECONCILE.md` — the contract matrix (every consume↔provide pair + a verdict),
  the gaps, the convergence record, and the freeze line.
- `ASSUMPTIONS.md` — the assumed-built ledger: for each item, which dependencies
  were treated as already-built (with the exact `PROV` contracts assumed). This is
  what makes "plan without building" auditable.

### Contract grammar (parse these EXACT shapes)

- **Provides** (`## Provides`): `- **PROV-<ITEM>-1**: <a named, stable, checkable
  contract this item exposes>` — a trait+methods, a DB table+key, a route+shape, an
  emitted artifact/type, an invariant. Concrete, not "the storage stuff":
  `PROV-T2-1: ObjectStore::{get_range,put,get_stream} over S3+GCS, selected by CYTO_WORKSTORE_BACKEND`.
  Keep it at the level of *what a consumer needs*, NOT the provider's internal
  implementation shape (over-detailed contracts break on refactor — the Pact
  brittleness warning).
- **Consumes** (`## Consumes`): `- **CONS-<ITEM>-1** [from <PROVIDER-ITEM>]
  [expects: PROV-<PROVIDER>-N]: <the exact shape / precondition this item assumes>`.
  Every `CONS` names the providing item AND the specific `PROV` it binds to, and
  states the assumed shape (which is what reconciliation checks). **If you need
  something no provider lists as a `PROV`, write the `CONS` anyway** — that is a GAP
  for Phase 3 to resolve by growing the provider; do NOT silently re-implement the
  missing capability (that hides the seam and duplicates work).
- **Reconcile row** (`RECONCILE.md`): `- **CONS-<ITEM>-N ↔ PROV-<PROVIDER>-M** —
  verdict: MATCH | GAP | DRIFT — <note>`.
  - **MATCH** — the provider's plan delivers exactly the assumed shape.
  - **GAP** — the consumer assumes a contract the provider's plan doesn't provide →
    **grow the PROVIDER's plan to provide it** (the anti-descope move). Blocks freeze.
  - **DRIFT** — both address it but shapes differ → align one side. Blocks freeze.
- **Convergence** (`RECONCILE.md`): `**Unmet contracts:** <N>` — freeze requires 0.

---

## Phase 0 — Assemble the graph (`GRAPH.md`)

Get the epic's items + dependency edges. Sources: the **GitHub backlog** (epic
issue + child tasks + their `blocked-by` edges — use `github-backlog-management` or
`gh issue view`), or a **design doc's task breakdown**.

Write `GRAPH.md`: the node list; the edge list (`A → B` = "B depends on A"), WITHIN
the epic; assert **it is a DAG** (a cycle is a planning error — resolve now); the
**topological order** and **leaf set**; and the **assumed-available substrate**
(shipped code + external epics/blockers — recorded, not planned as items here).

### Pin the CROSS-EPIC seams — do NOT leave them unpinned in ASSUMPTIONS

An epic's riskiest contracts are often at its BOUNDARY — what it needs from another
epic or from shipped code (e.g. compute-metering needs `account_of(project)` + the
`account_id` key from the accounts epic; quota needs plan allowances from billing).
If those live only as prose in `ASSUMPTIONS.md`, the mechanism rigorously pins every
*intra*-epic seam and silently externalizes the *inter*-epic ones — exactly where
the biggest risk sits. So **declare each cross-epic interface this epic depends on as
an external contract in the substrate section**:

`- **PROV-<EXT>-1**: <the interface THIS epic assumes from the external provider>`

(`<EXT>` = the external epic/substrate id, e.g. `accounts`, `billing`, `shipped`.)
A dependent then binds a normal `CONS ... [from <EXT>] [expects: PROV-<EXT>-N]` to
it, and it enters the reconcile matrix like any other edge. Each externally-bound
`PROV` gets a **cross-epic acceptance test in the CONSUMING item** — a contract test
against the external interface (or its mock/stub), so if the external epic later
delivers a different shape, this epic's own test catches it (Pact across the
boundary). This turns "assumed and hoped" into "assumed and *verified*."

**Prefer VERTICAL slices.** If an item is a horizontal layer (no end-to-end value,
integration deferred), that is the failure mode itself — re-slice vertically (each
item end-to-end through the stack) using INVEST as the per-node gate. A
horizontally-sliced DAG hides seam mismatches until every node reports done.

Gate: a DAG with a non-empty leaf set + a topo order covering every node.

## Phase 1 — Plan the leaves (full planning half: feature-lifecycle 1–4)

For each leaf, run `feature-lifecycle` **phases 1–4** (PLAN → PLAN_AUDIT → TESTS →
DECISIONS — do NOT build; stop before phase 5). A leaf depends on nothing, so its
phase-2 audit runs FULLY against the real codebase and its phase-3 tests are real —
its `Provides` contracts come out maximally grounded + expressed as acceptance
tests. ADD to its `PLAN.md`:
- `## Provides` — every contract this leaf exposes that ANY other item could build
  on. Downstream items can only bind to what you name here; a capability you don't
  list is one a dependent cannot assume. Be generous and concrete.
- `## Consumes` — empty, or only already-shipped substrate from `GRAPH.md`.

Gate: each leaf `PLAN.md` has ≥1 `PROV`; leaves consume no in-epic item.

### Mine the PRIOR research — the OSS survey + the example repos (applies to EVERY planning half, Phase 1 AND Phase 2)

The design doc a plan realizes was almost always produced by a research pass that
already surveyed the **open-source landscape** and named **example repos to follow
for implementation** (a "OSS landscape / build-vs-adopt / prior-art" section). A
planning agent that ignores that section re-derives from scratch and descopes to
the nearest thing it can imagine — the exact failure this skill exists to prevent.
So EVERY leaf/dependent planning brief MUST:

- Point the agent at the design doc's **OSS-survey section by number** ("read §14
  OSS landscape") AND name the concrete example repos to study (WebSearch/WebFetch
  their public schema/docs/source), not just the survey's *conclusion*. Passing the
  verdict ("adopt X") without the exemplar loses the implementation shape.
- Require the plan to **CITE `follow <repo> for <aspect>`** in `## Patterns to
  follow` and in the relevant `## Decisions` (e.g. "follow Cal.com for the
  member-role enum + unique(account,user) constraint"; "follow River/Oban for the
  heartbeat-reclaim reaper"; "follow stripe-samples for the webhook handler").
  Where our design DIVERGES from a cited repo, the plan says why — divergence is a
  decision, not an accident.
- This is not optional polish: prior art is *already paid-for* grounding. Not using
  it is leaving the most descope-resistant input on the table.

## Phase 1.5 (optional but recommended) — Walking skeleton

If the epic's seam risk is high, plan ONE thin **end-to-end slice through every
downstream consumer first** (a `skeleton` item): the minimum path that touches each
seam so mismatches surface at plan/skeleton time, not final integration. Mark it
explicitly NOT the final architecture (it proves integration; it must not calcify).
Its `Consumes`/`Provides` are the trivial versions of the real contracts and seed
Phase 3.

## Phase 2 — Plan dependents against ASSUMED-BUILT providers

Walk the topological order (dependencies are fully planned before their dependents,
so you never plan against an unstable provider). For each non-leaf item, run
`feature-lifecycle` **phases 1–4**, treating **every dependency as already built** —
its FROZEN `## Provides` contracts are the assumed substrate (need-driven design:
stating your need designs the dependency's interface). Its phase-2 audit runs
against the real codebase for its OWN touch points and against the providers'
declared `Provides` for the assumed seams; its phase-3 tests express each `Consumes`
as *the acceptance test it needs the provider to pass*. Declare:
- `## Consumes` — one `CONS` per contract relied on, `[from <provider>] [expects:
  PROV-<provider>-N]` + the assumed shape. A need no provider lists = a GAP; write
  it anyway.
- `## Provides` — what THIS item exposes to its own downstream consumers.

Record each item's assumed-built deps + bound `PROV` ids in `ASSUMPTIONS.md`.

### Bind to the `Provides` contract, NEVER to a dependency's internals

A dependent's phases 1–4 reference **only its dependency's `## Provides` (the seam)
+ the phase-3 acceptance tests that make each `Provides` concrete** — NOT the
dependency's internal `## Items`, internal decisions, or implementation. Those are
the provider's *private* business (information hiding / Parnas; JEDUF). Item 2
depends on the INTERFACE, not the IMPLEMENTATION: if item 2 reaches into how item 1
works internally, a later change to item 1's internals ripples into item 2 — the
exact coupling this skill exists to prevent, and it makes the leaf un-swappable.

- ✅ `CONS-T2-1 [from T1] [expects: PROV-T1-1]: an S3 endpoint to run my contract
  tests against` — binds to T1's seam.
- ❌ "T2 assumes T1 brings up minio via docker-compose with these flags" — binds to
  T1's internals; forbidden.

**A dependent does NOT re-verify that its dependency's `Provides` is achievable.**
That was the provider's OWN phase-2 job, already done when the provider was planned
earlier in topological order — so by the time a dependent plans, its providers'
`Provides` are already codebase-grounded (phase 2) and stable (phase 4). The
dependent *trusts* the frozen contract and plans against it; its own phase-2 audit
covers only its OWN touch points + the `Consumes`↔`Provides` match (which
reconciliation, Phase 3, settles). This is exactly why topological order is
mandatory: it guarantees every dependency is fully, groundedly planned before
anything binds to it.

(At BUILD time the same boundary holds by construction: builds run bottom-up, so a
dependency is really built before its dependent, and each bound `PROV` is an
acceptance test the dependency's build had to pass — a dependent never builds
against an unbuilt or contract-broken provider.)

Gate: every `CONS` names a real provider item + a `PROV` id (may be a GAP); every
non-leaf has ≥1 `CONS`.

## Phase 3 — Reconcile (the anti-descope core) → `RECONCILE.md`

Build the **contract matrix**: for every `CONS` across the epic, find the `PROV` it
binds to, write a verdict (MATCH / GAP / DRIFT). Resolution rules:

- **A GAP grows the PROVIDER, not the consumer.** The default fix for "the leaf
  doesn't provide what I need" is to make the leaf provide it — because a real
  downstream item needs it, and the union of consumer needs IS the provider's scope
  (consumer-driven contract). Only if the capability is genuinely wrong to build
  does the CONSUMER drop the `CONS` — an **owner-call with a recorded reason**, not
  an agent's unilateral convenience.
- **DRIFT** — align one side; record which and why.
- **Reconcile is a NEGOTIATION, not a one-shot generation** (Adzic's warning:
  auto-generated-but-not-co-authored contracts become brittle tests). Each
  GAP/DRIFT edits a `PLAN.md`, which changes a `PROV`/`CONS`, which re-triggers the
  matrix. Loop until `**Unmet contracts:** 0`.
- **Reconcile the WHOLE-PICTURE goal, not only pairwise edges** (Deming: the
  planner owns the *system* objective). Does the union of all `Provides` chains
  actually terminate in the epic's headline outcome? An epic goal no `Provides`
  chain reaches is a GAP against the epic itself — add the missing item or extend a
  plan. (All-green edges can still miss the outcome.)

Gate: a verdict row for every `CONS`; `**Unmet contracts:** 0`; the epic-goal
reconciliation satisfied.

## Phase 4 — Freeze (JUST the seams) + build bottom-up

At 0 unmet contracts, write the freeze record in `RECONCILE.md`: `**Frozen:** <N>
items, <M> contracts, 0 unmet — <date-from-args>`.

**Freeze the SEAMS, not the internals (JEDUF — Just Enough Design Up Front).** The
frozen artifact is the set of edge contracts (`PROV`/`CONS` + acceptance example);
each item keeps full internal freedom. Freezing whole interfaces/internals up front
is BDUF — a named antipattern. Only the downstream-bound contracts are pinned.

Then the real builds run **bottom-up in topological order**, each via
`feature-lifecycle` seeded with this item's `<item>/PLAN.md`. Three rules carry the
reconciliation into the build so it can't be undone:

1. **Every downstream-bound `PROV` becomes an `[acceptance]` test** in that item's
   phase-3 enumeration, asserting the contract holds (Pact provider-verification,
   applied to plans). A build that drops the capability fails its own gate — the
   descope is mechanically blocked. The test must RUN against the built item, not
   compare two plan docs (bi-directional CDC's false-confidence trap).
2. **The contract is downstream-OWNED; the provider's executor may not weaken it.**
   The consumer authored the `CONS`; the building agent proves the `PROV` and
   cannot edit the acceptance test to pass. (This is the specific anti-reward-hack:
   if the executor can edit its own check, "pass" means "gamed.")
3. **Repair escape hatch (not an exception — a defined path).** If an executing
   build discovers a frozen contract is genuinely wrong, it does NOT silently
   change it — it triggers a **scoped re-reconciliation**: re-open Phase 3 for the
   affected edge only, renegotiate both sides, re-freeze, then continue. (Pact's
   `can-i-deploy`, LLMCompiler's Joiner, classical plan-repair: a frozen DAG that
   can never renegotiate on discovery is brittle.)

Hand off to `feature-orchestration` (or sequential `feature-lifecycle` runs) for
the bottom-up build + merge. Budget the reconciliation + final-integration steps as
REAL work (the CPM critique: the join node is a costed task, not free).

---

## The deterministic gate

`epic-check.mjs` (in `agent-kit/lifecycle/`, symlinked at `.claude/lifecycle/`),
mirroring `lifecycle-check.mjs`:

```bash
node .claude/lifecycle/epic-check.mjs --phase <0-4> --epic <slug> --repo <root>
```

Checks (STRUCTURE only; the judgment — are these the RIGHT contracts — is yours):
DAG + leaf set + topo order (P0); every leaf has a `PROV`, no in-epic `CONS` (P1);
every `CONS` names a real provider + `PROV`, every non-leaf has a `CONS` (P2); a
reconcile verdict for every `CONS` + `Unmet contracts: 0` (P3); the freeze line +
every downstream-bound `PROV` named by an `[acceptance]` test in its item's plan
(P4).

---

## Rules of thumb

- **Generous `Provides`, precise `Consumes`, at the NEED level.** Under-listing
  hides seams; a vague assumption can't be reconciled; an over-detailed contract
  breaks on refactor.
- **A GAP grows the provider.** Downstream need pins upstream scope (consumer-driven
  contract). Dropping a consumer's need is an owner-call, recorded.
- **Bind to the `Provides` contract, never to a dependency's internals.** A
  dependent references only its provider's seam (`Provides` + its acceptance tests),
  not the provider's `Items`/internal decisions/implementation — and it does NOT
  re-verify the contract is achievable (topological order already grounded it).
  Interface, not implementation; that is what keeps a leaf swappable.
- **Reconcile the epic goal, not only edges.** All-green edges can miss the outcome
  (Deming: own the system objective).
- **Freeze seams, not internals (JEDUF); keep a repair path.** Pin the edge
  contract; leave internals free; allow scoped re-reconciliation on build-time
  discovery.
- **The contract is downstream-owned and executable.** An acceptance test the
  provider proves and cannot weaken — the anti-reward-hack.
- **Plans, not builds.** Phases 0–4 build nothing. "Assume built" = plan against
  the declared contract, recorded in `ASSUMPTIONS.md`.
