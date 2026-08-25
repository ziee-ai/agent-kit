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

> Produces PLANS, not code. Nothing is built in Phases 0–4. "Assume built" means
> "plan against the declared contract" (need-driven / outside-in TDD: stating what
> you need from a not-yet-built collaborator IS the design of its interface),
> recorded in `ASSUMPTIONS.md` — never actual code.

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

Under `.lifecycle/<epic>/` (committed on an `epic/<slug>` planning branch):

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
(shipped code + external blockers — recorded, not planned).

**Prefer VERTICAL slices.** If an item is a horizontal layer (no end-to-end value,
integration deferred), that is the failure mode itself — re-slice vertically (each
item end-to-end through the stack) using INVEST as the per-node gate. A
horizontally-sliced DAG hides seam mismatches until every node reports done.

Gate: a DAG with a non-empty leaf set + a topo order covering every node.

## Phase 1 — Plan the leaves (planning-only)

For each leaf, produce `<item>/PLAN.md` via `feature-lifecycle` **phase 1 only**
(PLAN + BASE — do NOT build), and ADD:
- `## Provides` — every contract this leaf exposes that ANY other item could build
  on. Downstream items can only bind to what you name here; a capability you don't
  list is one a dependent cannot assume. Be generous and concrete.
- `## Consumes` — empty, or only already-shipped substrate from `GRAPH.md`.

Gate: each leaf `PLAN.md` has ≥1 `PROV`; leaves consume no in-epic item.

## Phase 1.5 (optional but recommended) — Walking skeleton

If the epic's seam risk is high, plan ONE thin **end-to-end slice through every
downstream consumer first** (a `skeleton` item): the minimum path that touches each
seam so mismatches surface at plan/skeleton time, not final integration. Mark it
explicitly NOT the final architecture (it proves integration; it must not calcify).
Its `Consumes`/`Provides` are the trivial versions of the real contracts and seed
Phase 3.

## Phase 2 — Plan dependents against ASSUMED-BUILT providers

Walk the topological order. For each non-leaf item, produce `<item>/PLAN.md`
(feature-lifecycle phase 1), treating **every dependency as already built** — its
`## Provides` contracts are the assumed substrate (need-driven design: stating your
need designs the dependency's interface). Declare:
- `## Consumes` — one `CONS` per contract relied on, `[from <provider>] [expects:
  PROV-<provider>-N]` + the assumed shape. A need no provider lists = a GAP; write
  it anyway.
- `## Provides` — what THIS item exposes to its own downstream consumers.

Record each item's assumed-built deps + bound `PROV` ids in `ASSUMPTIONS.md`.

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
- **Reconcile the epic goal, not only edges.** All-green edges can miss the outcome
  (Deming: own the system objective).
- **Freeze seams, not internals (JEDUF); keep a repair path.** Pin the edge
  contract; leave internals free; allow scoped re-reconciliation on build-time
  discovery.
- **The contract is downstream-owned and executable.** An acceptance test the
  provider proves and cannot weaken — the anti-reward-hack.
- **Plans, not builds.** Phases 0–4 build nothing. "Assume built" = plan against
  the declared contract, recorded in `ASSUMPTIONS.md`.
