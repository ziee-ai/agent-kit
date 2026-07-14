---
name: feature-lifecycle
description: >
  Binding 8-phase state machine for ALL feature work in the ziee repo. Enforces
  plan → plan-audit → explicit test enumeration → up-front decisions → implement
  + drift-convergence loop → blind multi-angle audit with full diff coverage →
  fix/re-audit loop → gated test run. Every phase writes machine-checkable
  artifacts under .lifecycle/<feature>/ (committed on the branch); a deterministic
  validator gates each phase and a pre-push hook enforces the whole chain. Use
  whenever you start, resume, or review a feature/bugfix branch of nontrivial size.
---

# Feature Lifecycle

A phase state machine. **You may not enter phase N+1 until the validator passes
phase N:**

```bash
node .claude/lifecycle/lifecycle-check.mjs --phase <N> --repo <worktree-root>
# exit 0 → proceed.  non-zero → read the gap list, fix, re-run.
```

All artifacts live in `.lifecycle/<feature>/` **inside the feature worktree** and
are **committed on the branch** so they ride the PR and the pre-push hook can
read them. `<feature>` is a short kebab slug (e.g. `project-search`).

Work in a dedicated worktree off `origin/main`:

```bash
git worktree add -b feat/<slug> /data/pbya/ziee/tmp/<slug>-wt origin/main
mkdir -p /data/pbya/ziee/tmp/<slug>-wt/.lifecycle/<feature>
```

> The validator is **deterministic** — it enforces *structure and completeness*,
> not judgment. Passing it is necessary, not sufficient; the phases below carry
> the judgment. Never write filler to satisfy the parser.

---

## Artifact grammar (the validator parses these EXACT shapes)

Match these line formats precisely or the gate will not pass.

- **Plan item** — `- **ITEM-3**: <description>`
- **Descoped plan item** — `- **ITEM-30**: [DESCOPED] <what is being cut this round>`
  A `[DESCOPED]` item is EXEMPT from needing a covering test, but ONLY if
  DECISIONS.md records an approved disposition for it (below). Otherwise it fails
  the **plan-coverage gate** — see Phase 3.
- **Descope approval** (`DECISIONS.md`) — `- DESCOPED: ITEM-30 — <reason> [approved: <who/when>]`
  The `[approved: …]` token (or `· approved` / `human-approved`) is the human
  sign-off. A descope without it is a silent cut and FAILS.
- **Audit verdict** — `- **ITEM-3** — verdict: PASS — <rationale>`
  (verdict ∈ `PASS | CONCERN | BLOCKED`; `BLOCKED` fails the gate)
- **Test** — `- **TEST-2** (tier: integration) [covers: ITEM-1, ITEM-3] file: \`path/to/test.rs\` — asserts: <what it proves>`
  (tier ∈ `unit | integration | e2e`). **UI work must enumerate ≥1 `tier: e2e`
  test** — the gate refuses an all-unit plan for a frontend-touching diff.
- **Restricted-user e2e** (`[negative-perm]` tag) — `- **TEST-7** (tier: e2e) [negative-perm] [covers: ITEM-3] file: \`.../foo.spec.ts\` — asserts: a user LACKING foo::use sees NO Foo UI (nav entry, page, composer, buttons all absent)`.
  REQUIRED whenever the diff introduces a user-facing permission
  (`X::use`/`X::read`/`X::manage` defined in a `modules/*/permissions.rs` or
  granted in a migration). This is the FRONTEND half of the authz gate (A10),
  paired with the backend deny test (A9). It must be `tier: e2e` — a 403/deny
  integration test does NOT satisfy it (that's A9).
- **Decision** — `### DEC-1: <question>` then a `**Resolution:** <answer>` line
  and a `**Basis:** <convention|user|codebase>` line
- **Drift entry** — `- **DRIFT-1.2** — verdict: plan-wins — <text>`
  (verdict ∈ `plan-wins | impl-wins | none | resolved`); each DRIFT-*.md needs a
  `**Unresolved drifts:** <N>` summary line
- **Ledger row** (`LEDGER.jsonl`, one JSON/line) —
  `{"angle":"correctness","file":"src/...","line":42,"severity":"high","finding":"...","status":"confirmed"}`
- **Coverage row** (`AUDIT_COVERAGE.tsv`, tab-separated, header `file⇥start⇥end⇥angles`) —
  `src/foo.rs⇥120⇥145⇥correctness,security,perf`
- **Fix round** (`FIX_ROUND-1.md`) — a `**New confirmed findings:** <N>` line
- **Test result** (`TEST_RESULTS.md`) — `- **TEST-2**: PASS`
- **Frontend gate line** (`TEST_RESULTS.md`, REQUIRED once the diff touches a UI
  workspace) — `npm run check (ui): PASS` — one line per touched workspace; the
  label is `ui` (→ `src-app/ui`) or `desktop/ui` (→ `src-app/desktop/ui`)
- **Human-feedback entry** (`HUMAN_FEEDBACK.md`) —
  `- **FB-1** [status: resolved] — <verbatim feedback> → <resolution> [generalizable: yes — <rule>]`
  (`status` ∈ `open | resolved | wontfix`; any `open` fails phase 9)

---

## Phase 1 — PLAN.md

**Preflight FIRST** — before writing a line of the plan, run the environment
gate so a setup problem surfaces now, not three phases deep into a red build:

```bash
bash .claude/lifecycle/preflight.sh --repo <worktree-root>
# exit 0 → env ready. non-zero → fix the printed problem (hub-seed, build-DB
# isolation, node_modules, pgvector submodule, stale Vite) before proceeding.
```

(This is the same gate on Linux, macOS, and Windows git-bash — it avoids
GNU-only tool flags and guards Unix-only tools.)

Write `.lifecycle/<feature>/PLAN.md` with three required sections:

- `## Items` — every unit of work as `- **ITEM-N**: <desc>`. IDs are the spine of
  the whole lifecycle: audits, tests, drift, and results all reference them.
- `## Files to touch` — the concrete files you expect to add/edit.
- `## Patterns to follow` — for each area, name the **closest existing module**
  to mirror (file structure, naming, idioms). This is a hard project rule
  ([[feedback_match_existing_patterns]]).

**UI-surface plan checklist** (harvested from live human review — answer these
IN the plan for EVERY page/drawer/card/panel the feature adds; a surface that
skips them ships as a defect):

- **Precedent** — which existing sibling surface is this the twin of (the
  Projects card ⇄ a new entity card; a settings list ⇄ a new settings list)?
  Mirror its structure / typography / tokens / container layout FIRST, then add
  feature-specific elements. Divergence from the sibling is a bug, not a variant.
- **Scale / cardinality** — what is the MAX size of every list/collection this
  surface renders? What bounds the initial load? Never "fetch all + render all"
  for an unbounded/high-cap set — specify server-side paging or virtualization,
  a bounded first page, and a "Showing N of M" affordance. Pick the pagination
  IDIOM by surface type: a settings/detail list uses the numbered `ListPagination`
  (default page size 10); a top-level nav feed uses Load-More.
- **Device size / responsive** — what is the behavior at mobile (~390px), tablet,
  and desktop? What stacks / reflows / hides / scrolls, and which sibling's
  breakpoint behavior does it mirror? A surface that only works at desktop width
  is a defect. Its gallery coverage MUST include a narrow-viewport (390px) state
  (enforced at Phase 8 / `gate:ui`), not only the desktop state.
- **Populated-render review** — the visual DoD is NOT met until a POPULATED
  (seeded, representative-data) render of every list/card surface has been through
  the design-critic vision pass, at each viewport. An empty/loading state hides
  real-data layout bugs (a control stranded far from its title once the card has
  content, text overflow, a count pushing a button off-screen). Every gallery
  surface needs a loaded-with-data state, not just empty/error — review THAT.
- **User-visible progress** — any surface that ingests or produces work (upload,
  index, fetch) must show the live status the user expects (%, thumbnails, index
  state, itemized errors), answering "what does the user want to SEE and DO
  here?" — a silent boolean spinner is a defect.
- **Input economy** — never make the user type what the system can supply or pick.
  Auto-detect client-known values (timezone via `Intl…`, locale) and show them
  read-only, never as an input. Collect a structured value via a form generated
  from the target's declared schema (one typed field per input), NEVER a raw-JSON
  textarea (last-resort fallback only). Offer multi-select where a field naturally
  takes multiple values (e.g. days-of-week), not single-select. (Entity references
  → pickers is already covered above.)
- **JTBD design (mandatory deliverable)** — write an explicit **jobs-to-be-done /
  user-experience design** stating what a real human wants to DO with this feature,
  enumerated across EVERY surface it exposes (list, detail, drawer/form,
  notifications, thread/conversation, empty/error/loading, mobile). Reconcile each
  surface against it before implementing. A code-mechanism description is NOT a UX
  design. This feeds the checklist above; it is what caught a feature shipping a
  bare `timestamp — status` row where the user actually wanted an evolving,
  followable result stream.
- **Multi-instance / workspace surfaces** — if the feature lets the same view
  exist in more than one place at once (split panes, tabs, side-by-side, multiple
  windows), design the ENTIRE interaction model up front: every open / navigate /
  persist / edge case (open an EXISTING item next to another — not only newly
  created ones; what a sidebar click does when the item is/ isn't already shown;
  leaving and returning; per-instance state persistence). The happy path alone is
  a design hole. Build it on the meta-framework SEAMS — a per-instance store
  (`defineLocalStore` + a React context/`useX()` hook), extensions bound through a
  per-instance runtime, UI composed via slots — NEVER a monolithic god-component
  that reaches across modules. A "context-aware bridge" that only covers reactive
  READS does NOT isolate a multi-instance surface: actions, `.$`/getState,
  subscribe must bind to the INSTANCE, or state silently leaks to the focused one.
  **Per-window layout state must NOT be per-user `localStorage`** — that is shared
  across ALL tabs, so "restore my layout" replays into every window. Scope
  per-window state to the tab (`sessionStorage`); and note a `window.open`/
  link-opened tab receives a COPY of the opener's `sessionStorage`, so per-tab
  storage alone doesn't isolate a pop-out — gate restore to a real reload
  (`navigation.type === 'reload'`) to defeat the copy.
- **URL-as-view-into-focus** — when a URL reflects some focused entity, EVERY way
  of changing that focus (sidebar click, focus-click, programmatic open) must
  reconcile the URL; otherwise any URL-consuming action (open-in-new-tab,
  deep-link copy, back/forward) silently operates on the wrong entity. A
  bidirectional "X always tracks Y" invariant asserted in a comment must be
  verified in BOTH directions — the common bug is wiring only the happy-path
  direction and leaving the others stale.
- **Platform-provided affordances** — do not ship in-app chrome the platform
  itself already provides (a web browser's native "open in new tab"); gate such
  redundant affordances by platform (runtime `__TAURI__` check) via a pure
  predicate, and challenge every affordance's value in EACH context it renders in.

**P3 — conflict-surface scoping (BASE.md).** Also write a short
`.lifecycle/<feature>/BASE.md` recording what CURRENT main touches that this
branch will also touch: the highest existing migration number
(`ls src-app/server/migrations | tail -1`), any files/modules you expect to
edit that main is actively changing, and whether an `openapi.json` regen is
implied. This makes a migration-number or file collision visible at plan time
rather than as a build.rs failure after a long merge — and it is exactly what
the merge-gate re-checks against real main at merge time.

Gate: `--phase 1`.

## Phase 2 — PLAN_AUDIT.md

Audit the plan *against the codebase* before writing code. Required dimension
sections (`## Breakage risk`, `## Pattern conformance`, `## Migration collisions`,
`## OpenAPI regen`) plus a per-item verdict line for **every** ITEM:

```
- **ITEM-1** — verdict: PASS — mirrors project/repository.rs; no new migration
- **ITEM-2** — verdict: CONCERN — needs `just openapi-regen` (new response field)
```

Check: does any item break an existing caller? Does it conform to the reference
module? Do migration numbers collide with `ls migrations/`? Does a type change
require `just openapi-regen` in BOTH ui and desktop? Any `BLOCKED` verdict fails
the gate — resolve it (amend the plan) first.

Gate: `--phase 2`.

## Phase 3 — TESTS.md

Enumerate **every** test up front. The gate enforces a bipartite mapping:
**every ITEM is covered by ≥1 TEST**, and every TEST names a valid ITEM, a tier,
a target file, and what it asserts.

**Plan-coverage gate (FB-7) — no silent scope-dropping.** Every PLAN ITEM must be
either (a) covered by an enumerated TEST (implemented), or (b) explicitly
`[DESCOPED]` in PLAN.md **with an approved `DESCOPED: ITEM-N … [approved: …]`
disposition in DECISIONS.md**. An item that is neither — quietly cut so the tree
goes green — FAILS the gate. This exists because a feature once shipped "green"
with ~16 planned, user-facing sub-features silently absent; descoping is now a
recorded, human-approved DECISION, never an omission. Be comprehensive — mirror the codebase's
existing tier pattern (unit `#[cfg(test)]` / integration `tests/<module>/` / e2e
`ui/tests/e2e/`) ([[feedback_comprehensive_tests]]). No cosmetic tests — mock
only the external boundary ([[feedback_no_cosmetic_tests]]).

Enumerate tests per tier for each ITEM. A backend item usually gets unit +
integration; **a user-visible UI item MUST also get an `e2e` spec** for the flow:

```
- **TEST-4** (tier: unit)        [covers: ITEM-3] file: `src-app/ui/src/modules/foo/Foo.store.ts` — asserts: store reducer maps the response
- **TEST-5** (tier: e2e)         [covers: ITEM-3] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user opens Foo, submits, sees the result
```

The gate computes touched areas from the diff (or, before any code exists,
PLAN.md's *Files to touch*). If a **frontend** path (`src-app/ui/**` or
`src-app/desktop/ui/**`, ignoring the mechanically-generated
`openapi.json`/`api-client/types.ts`) is touched and **no `tier: e2e` test is
enumerated, the gate fails** — an all-unit plan for UI work is refused. Budget
the e2e specs here; phase 8 runs them.

**Permission-gating rule (A10) — MANDATORY when your feature adds a
permission.** If the feature introduces a user-facing permission (a
`X::use`/`X::read`/`X::manage` defined in a `modules/*/permissions.rs` OR
granted in a migration), you MUST verify + test that **unpermitted users see
NOTHING** at every layer, and enumerate the **restricted-user e2e** that proves
the UI is ABSENT — not just 403-on-use. Walk all four gating layers from
`.claude/PERMISSION_GATING.md` — **slot → route → `<Can>` → `usePermission`** —
and assert, in a spec that logs in as a user LACKING the permission, that every
surface (sidebar/nav entry, route/page, composer, action buttons, menu items)
is absent. Tag it `[negative-perm]` at `tier: e2e`. The happy-path e2e (which
runs WITH the permission) can never catch an ungated surface; this spec is the
only thing that forces the negative case. The gate fails phase 3 if a permission
is introduced but no `(tier: e2e) [negative-perm]` spec is enumerated. This is
the FRONTEND half of the authz proof — paired with the backend deny test
(A9, phase 8).

> **Honest limit of the gate.** A10 enforces only that ONE restricted-user e2e
> *exists and passes* — it CANNOT verify that spec covers EVERY gated surface (a
> test could assert the nav entry is hidden yet miss an ungated composer). That
> is why the rule above is to walk ALL FOUR layers inside the spec; the gate is
> a floor, not a ceiling. Under-covering here is exactly how live2/live3/live4
> shipped ungated surfaces past a green 8/8 lifecycle.

Gate: `--phase 3` (fails loudly if any ITEM is unmapped, a UI diff has no e2e
test, or a new permission has no restricted-user `[negative-perm]` e2e).

## Phase 4 — DECISIONS.md

Identify **every** human/product input the whole implementation will need, UP
FRONT, and resolve each — so implementation then runs nonstop. Prefer resolving
by existing convention and record the rationale; batch anything genuinely
ambiguous into ONE `AskUserQuestion` at plan time. **Zero** `TBD`/`TODO`/`ASK`/
`???` markers may remain (the gate greps for them).

**Enumerate the full option space, and escalate genuine product choices as
pickers.** Exhaustively list every decision the feature requires (surfaces,
defaults, behaviors, tunables). Resolve by convention ONLY those with an
unambiguous codebase precedent. For any decision that is a genuine product/human
choice about WHAT to build or modify, present it as an explicit `AskUserQuestion`
**option picker** for the human to choose — never silently pick a default and
proceed, and never a bare "I recommend X, proceeding." Give the human the options.

```
### DEC-1: How is the search matched — prefix or substring?
**Resolution:** case-insensitive substring (ILIKE '%q%')
**Basis:** convention — matches conversations title filter in chat/repository.rs
```

**Configurable-settings rule (mandatory DEC).** Any operational tunable the
feature introduces — resource limits (memory/CPU/timeout/size caps), retention
periods, rate/quota limits, concurrency caps, feature enable/disable toggles,
model/provider selection, thresholds — MUST get an explicit DEC answering
**"fixed constant, or admin-configurable settings row?"** Default to
**admin-configurable** following the existing singleton-settings pattern
(`code_sandbox_settings` / `session_settings` / `memory_admin_settings`: a
settings table + migration with sane defaults, read-at-use with cache
invalidation, REST GET/PUT gated by a `<feature>::settings::{read,manage}`
permission, a sync entity, an admin settings card mirroring the closest
existing one, and bounds validation so an admin can't footgun the server).
Choose a fixed constant ONLY with an explicit rationale (e.g. a security
boundary that must not be operator-weakened) — and even then, structure it as a
`Limits`-style struct (not inline magic numbers) so it can be promoted to
configurable later without a rewrite. Never ship an operational tunable as a
bare hardcoded constant by omission. Enumerate the settings CRUD + gate + sync +
validation in TESTS.md when configurable.

Gate: `--phase 4`.

## Phase 5 — Implement + drift loop

**Two mandatory walks per item, before/while implementing it** (record findings
in an `INFRA_INTEGRATION.md` artifact): (1) a **user-experience walk** — how does a
real user actually encounter, trigger, and live with this item end-to-end? (2) an
**infrastructure-integration walk** — enumerate EVERY existing subsystem the item
touches (chat pipeline, MCP tool-call + approval flow, permissions, notifications,
sync, streaming, workflow runner, settings, …) and, for each, check whether it has
specific behaviors/constraints that must be handled, not assumed. This is what
surfaced the unattended-tool-approval gap that drove a safe-default policy rather
than a silent security hole. (3) an **entity-lifecycle walk** — enumerate every
entity the surface holds (a conversation in a pane, an attached file, a selected
item) and, for EACH, prove add / remove / **delete** / mutate / access-loss is
handled from BOTH paths: the LOCAL mutation and the SYNC/SSE path (they are
separate handlers — the originating device's own echo is suppressed, so a
`sync:X` handler that only covers the cross-device case misses the local delete).
"What happens when it's deleted / access is revoked?" must be ANSWERED BY RUNNING
it (delete it, watch the surface), never inferred from a handler.

> **Entity-lifecycle audit (mandatory sub-check of the infra walk).** For EVERY
> entity a surface holds, displays, or caches (conversation, pane, file, message,
> membership, …), enumerate what happens on **ADD / REMOVE / MUTATE / access-loss**
> — and prove each is handled from **BOTH** origins: the **local same-session**
> mutation path AND the **cross-device / sync (SSE)** path. These are DIFFERENT
> code (the originating device's sync echo is self-suppressed), so a handler that
> covers `sync:X delete` does NOT cover the user deleting it themselves, and
> vice-versa. Answer each "what happens when it's removed?" by RUNNING it (remove
> it, watch the surface) — not by pointing at a sync handler. This is exactly the
> gap that shipped a split pane going stale on a local delete (FB-23): the
> cross-device path was wired, the local one wasn't.

Implement all items (only `cargo check` / `tsc` mid-flight; don't run the full
suites yet — [[feedback_finish_all_before_testing]]). Then audit
**implementation vs plan** and write `DRIFT-1.md`. For each divergence:

- `plan-wins` → the impl is wrong; re-implement that part to match the plan.
- `impl-wins` → the plan was wrong; **amend PLAN.md** (and re-run `--phase 1..3`)
  with the rationale captured in the drift entry.
- `none`/`resolved` → reconciled.

End each round with `**Unresolved drifts:** <N>`. Repeat (`DRIFT-2.md`, …) until a
round records **0** unresolved drifts.

Gate: `--phase 5` (checks the final round is 0).

## Phase 6 — Blind multi-angle audit

Spawn **fresh/blind** subagents (diff-only context: `git diff main...HEAD`) — do
NOT hand them your reasoning. Use ≥10 angles from the proven roster:

`correctness · security · error-handling · concurrency · perms/authz ·
api-contract · state-management · a11y · patterns-conformance · tests-quality ·
perf · i18n/copy`

**UI surfaces additionally require these angles** (harvested from human review —
each traces to real rework that shipped despite a green gate):

- **precedent-fidelity** — does each new surface mirror its closest sibling's
  structure/typography/tokens, or did it diverge (a bold heading where the sibling
  uses `!font-normal !text-sm`, a stray leading icon)? Match the pagination IDIOM
  of the same KIND of page (settings numbered vs feed Load-More), not just "some
  pagination exists."
- **affordance-parity / reuse** — did it REUSE the existing component (`FileCard`,
  `ProjectFilesManagePanel`, `ListPagination`) via its slots, or hand-roll a
  parallel implementation? A reimplementation of something that already exists is
  a finding. **Before building a component that has a single-context sibling** (a
  header, toolbar, drop-zone), OPEN the sibling and understand WHY each non-obvious
  value exists (a `50px` height, a `paddingLeft: 118`, a `z-10`, a magic offset —
  they almost always encode a real constraint: macOS traffic-lights, a fixed
  overlay's z, a WCAG tap target). Hand-rolling a parallel version silently drops
  those constraints and ships regressions invisible without running the real
  chrome. Reuse the sibling or share its logic via a hook; never re-derive.
- **new-rendering-context affordance audit** — when the change introduces a NEW
  context the same UI now renders in (a pop-out window, a split pane, a mobile
  tab), audit EVERY pre-existing affordance rendered there for whether its behavior
  still makes sense. A navigate/global-state action that was correct in the single
  context routinely breaks the new one (a back button collapses the whole split; a
  window-wide navigate escapes a chat-only pop-out). Do this at implementation
  time, not after the human points it out.
- **scale-performance** — does every list bound its initial load (paging/
  virtualization) instead of fetch-all/render-all, and show "Showing N of M"? A
  list that renders its entire potentially-large set fails.
- **responsive-fidelity** — verify the surface at ~390px / tablet / desktop: no
  horizontal page scroll, no clipped/overlapping content, adequate tap targets,
  and breakpoint behavior matching its sibling. Desktop-only = defect.
- **design-in-context** — does the component fit its container and siblings
  (counts in the container title, primary actions in `extra`/top-right, no
  duplicated headers), or was it designed in isolation and now fights its parent?
- **reactive-read-in-loop (Rules of Hooks)** — a store read INSIDE a `.map()`, a
  loop, or a conditional render MUST use the non-subscribing `.$` snapshot, never
  the reactive proxy (which is a hook) — else the hook count varies per render and
  React crashes. Pure unit tests can't catch this; only a live render / an e2e
  that actually shows the component does. Flag any reactive proxy access under a
  `.map()`/conditional.
- **high-frequency write to reactively-read state** — a store field read reactively
  by a large subtree must NOT be written on every `pointermove` of a drag/resize
  (the whole subtree re-renders per frame). Write to the DOM imperatively during
  the gesture and commit to the store ONCE on release. Flag any per-frame/
  per-pointermove store write of a field a big tree subscribes to.
- **plan-coverage / scope-drift** — reconcile EVERY PLAN ITEM against shipped code
  with file:line evidence. An item with no implementation and no approved
  `[DESCOPED]` disposition is a finding (this is the human-judgment complement to
  the deterministic FB-7 gate — the gate catches missing dispositions; the audit
  catches an item "covered" on paper but absent in code).
- **test-reality / paper-9/9 (do this every round)** — FB-7 only checks a TEST
  *line* exists; a hollow test that passes trivially still satisfies it, so a
  feature can be "covered on paper" yet never built. For EACH TEST, OPEN the spec
  and confirm it actually exercises everything its TESTS.md line claims — mounts
  the real surface, asserts real DOM/behavior, drives the real path. Flag:
  (a) a spec whose assertions are NARROWER than its TESTS.md prose (a phantom
  leg — the claim exceeds the code); (b) an **isolation/"other side unaffected"
  test whose control is IDLE** (an empty quiescent pane/tab proves nothing — the
  other side must be ACTIVELY doing the thing, e.g. two simultaneous streams,
  both directions); (c) **one spec file mapped to many TEST-IDs** that share a
  single assertion (coverage inflation — each TEST-ID must be a distinct exercised
  assertion); (d) a mocked unit standing in for render/behavior that only the
  real surface can prove. This is the systematic form of rule B7 — the human
  keeps finding these when the audit doesn't.

**Audit-vs-user-decision rule:** when an audit angle surfaces that a feature's
cost/behavior conflicts with a decision the human explicitly made (e.g. a perf
tradeoff on a UX choice they picked), record it as a tracked `HUMAN_FEEDBACK`
item and surface it — do NOT silently reverse the human's decision.

Each angle appends findings to `LEDGER.jsonl`. **Coverage law:** every hunk of
`git diff main...HEAD --unified=0` must appear in `AUDIT_COVERAGE.tsv` as reviewed
by **≥3 distinct angles**. The validator parses the real diff and reconciles it
against the TSV — any uncovered hunk fails the gate. (Forks that share the
parent's cached context are the cheap way to fan out — [[feedback_fork_cache_review]].)

> The coverage law excludes the lifecycle artifacts and **mechanically-generated
> files** (`**/openapi.json`, `**/api-client/types.ts`) — those are derived
> deterministically from reviewed source by a golden-tested generator, so review
> the *source* hunks, not the generated output. (The same exclusion is why a
> backend feature that merely regenerates the client is **not** treated as UI
> work by the phase 3 / phase 8 frontend gates.) A regen may produce a large
> positional (key-order) diff in `openapi.json` with a tiny content delta; verify
> the content delta with `comm` on sorted files and record it as a drift entry.

Gate: `--phase 6`.

## Phase 7 — Fix / re-audit loop

Merge the ledger → fix every confirmed finding → **re-run a full blind round**.
Record each round in `FIX_ROUND-<n>.md` ending with `**New confirmed findings:**
<N>`. Repeat until a full blind round yields **0** new confirmed findings. (Reject
false positives explicitly in the ledger; a dismissed finding is not a fix.)

Gate: `--phase 7` (checks the final round is 0).

## Phase 8 — Gated test run (conditional on the touched areas)

ONLY NOW run tests, scoped to what you built ([[feedback_test_scope]]). **Which
gates apply is computed from `git diff main...HEAD`** (generated
`openapi.json`/`api-client/types.ts` excluded, so they never make a backend diff
look like UI work). A diff that touches both back- and front-end runs BOTH
chains.

**If the diff touches the backend** (`src-app/server/**`, `src-app/desktop/tauri/**`):

```bash
# integration (source the env file first — real LLM keys live there)
source src-app/server/tests/.env.test
cargo test --test integration_tests <module>:: -- --test-threads=1 \
  2>&1 | tee /data/pbya/ziee/tmp/lifecycle-logs/<feature>-int.log
```

**If the diff touches a frontend workspace** (`src-app/ui/**` and/or
`src-app/desktop/ui/**`), ALL of the following are required, per touched
workspace:

1. **`npm run check` — the one gate command, run in EACH touched workspace.** It
   chains the whole static frontend contract: `tsc` + the biome guardrails +
   `lint:colors` + `lint:settings-field` + `check:kit-manifest` +
   `check:testid-registry` + `check:design-spec` + `check:gallery-coverage` +
   `check:state-matrix`. Don't run these individually — run the one command and
   record its result:
   ```bash
   cd src-app/ui && npm run check          # and src-app/desktop/ui if touched
   ```
   Write a `npm run check (ui): PASS` line (and `npm run check (desktop/ui): PASS`)
   in `TEST_RESULTS.md` — the gate requires one per touched workspace.
2. **New conditional render states need gallery coverage.** Any new
   loading/empty/error/variant state your diff introduces must have a gallery
   entry (or an explicit allowlist reason). This is enforced by the
   `check:state-matrix` gate *inside* `npm run check` above — budget for it: if
   you added a state, add its gallery cell or the gate (and thus phase 8) fails.
3. **UI evaluator gate** (per CLAUDE.md's "UI Build Gate"): zero console
   errors / uncaught exceptions / failed requests / AA-contrast failures on the
   touched gallery surfaces, and the visual-regression baseline matches. Run the
   gallery runtime + gate scripts:
   ```bash
   cd src-app/ui && npm run gate:ui                     # runtime-health + Layer A/axe + tsc/lint
   VISUAL_SNAPSHOTS=1 npm run gate:ui                   # + Layer B pixel regression vs baseline
   ```
4. **e2e specs for the user-visible flows** you enumerated as `tier: e2e` in
   phase 3 (TESTS.md) — run them and record each TEST-ID:
   ```bash
   cd src-app/ui && npx playwright test tests/e2e/<file> --workers=1
   ```
   This includes any `[negative-perm]` **restricted-user** spec (A10): run it
   and record its TEST-ID as PASS — the gate requires the negative-permission
   e2e to pass, not just the happy-path one.

Write `TEST_RESULTS.md` with a `- **TEST-N**: PASS` line for **every** TEST-ID
from Phase 3 (plus the `npm run check (<ws>): PASS` line(s) above for a UI diff).
The gate fails if any phase-3 test is missing/not PASS, if a touched workspace has
no passing `npm run check` line, or if any enumerated `tier: e2e` spec is not
PASS. Never `#[ignore]` (or `.skip`) to go green — only genuine
platform-incompatibility is a legit skip ([[feedback_no_ignore_unless_platform]]).

**Phase 8 also enforces these deterministically** (from the diff + `TEST_RESULTS.md`),
so budget for them — they are not optional polish:

- **A2** clean working tree — every load-bearing file committed on the branch
  (no uncommitted change the gate can't see).
- **A3** no diff-added `#[ignore]`/`.skip`/`.only`; **A4** no cosmetic/always-true
  assertion (`assert!(true)`, `expect(x).toBe(x)`).
- **A5** TESTS.md may not shrink — a previously-enumerated TEST-ID cannot vanish.
- **A7** a UI diff must record a boot/runtime canary line
  (`gate:ui (<ws>): PASS`) — a green e2e can still ship a non-booting app or a
  root ErrorBoundary crash on an un-exercised path. **A6:** the gallery +
  `gate:ui` + `runtime-health` IS the browser-verify harness — "I can't verify
  in a browser" is not a valid gap.
- **A8** a new built-in MCP server must include BOTH `mcp.rs` edits
  (`auto_attach_builtin_ids` + `is_builtin_server_id`) — else it registers but
  the model never sees the tools.
- **A9** a new permission must have a BACKEND DENY-path test (403/forbidden),
  not only the allow path.
- **A10** a new user-facing permission (`X::use`/`X::read`/`X::manage` in a
  `modules/*/permissions.rs` or a migration grant) must ALSO have a
  **restricted-user e2e** — `(tier: e2e) [negative-perm]` — that logs in as a
  user LACKING the permission and asserts the feature UI is ABSENT, and it must
  be enumerated (phase 3) and PASS (phase 8). A9 proves the API refuses; A10
  proves the UI is hidden. Both are required — a 403 backend test alone leaves
  an ungated menu item / composer / nav entry invisible to the gate.
- **R2-5** every `/api/` e2e route-mock the diff adds must match a live route in
  `openapi.json` — a renamed route makes the mock a silent no-op that
  false-greens the spec.

**P4 — full-output capture.** Save the FULL test log as an artifact
(`| tee /data/pbya/ziee/tmp/lifecycle-logs/<feature>-{int,e2e}.log`), never just
an inline tail — the failing test's assertion/panic is in the body, and a
re-run to recover it wastes minutes ([[feedback_periodic_check_stuck]]).

Gate: `--phase 8`.

## Phase 9 — HUMAN_FEEDBACK.md (the human-review gate; last before merge)

Maintain `.lifecycle/<feature>/HUMAN_FEEDBACK.md` as a **living ledger** from the
moment the feature is testable. When the human reviews the running feature and
gives feedback — a UX critique, a missed convention, a "no user would do this" —
record it **VERBATIM** immediately, then resolve it and log how. Never
paraphrase-away or silently drop a human critique.

One entry per feedback item, in this exact shape (the gate parses it):

```
- **FB-1** [status: resolved] — <verbatim human feedback> → <how you addressed it> [generalizable: yes — <candidate lifecycle rule the whole fleet should follow>]
- **FB-2** [status: open] — <verbatim feedback not yet fixed>
- **FB-3** [status: wontfix] — <feedback> → <rationale for not doing it>
```

- `[status: …]` ∈ `open | resolved | wontfix`. **Any `open` item FAILS the gate**
  — the feature is not merge-ready with unaddressed human feedback.
- `[generalizable: yes — <rule>]` flags feedback that isn't specific to this
  feature but is a **convention the whole fleet should follow** (e.g. "select an
  entity with a picker, never a raw ID text input"; "reuse existing page/drawer
  layouts, don't build bespoke"). The orchestrator HARVESTS every
  `generalizable: yes` item at merge and folds it into this skill / a lint — so
  one human's feedback improves every future feature. Once folded in, the
  orchestrator marks that entry
  `[generalizable: yes — <rule> · harvested@<commit>]` (or moves it under a
  `## Harvested` heading). This matters for a feature that merges MULTIPLE times
  (see **Iteration mode**): the harvest mark stops the same rule being applied
  twice and leaves an audit trail of which feedback became which rule.
- If the human gave **no** feedback, the file must exist and state
  **"no human feedback received"** explicitly — absence is a deliberate claim.

This gate is **PENDING** (informational, does not block the build) while the file
is absent — a feature can be 8/8 and still awaiting human review. It reaches
**9/9 (truly merge-ready)** only once the file exists and every item is resolved.
The merge does not happen until the orchestrator has read this ledger.

Gate: `--phase 9` (fails on any `[status: open]`; pending while the file is absent).

---

## Iteration mode (re-entering an already-merged feature)

A merged feature is rarely final — the human comes back to refine it gradually,
conversationally. Iteration mode is the SAME lifecycle, entered against a feature
that already shipped, with three adjustments:

1. **Reuse, extend — don't rebuild.** Cut a fresh worktree off *current*
   `origin/main` and carry the feature's existing `.lifecycle/<feature>/`
   artifacts forward (copy them in). Only THIS round's DELTA needs new PLAN items
   + new TESTS.md rows; prior items stay as satisfied context. Do NOT re-plan or
   re-test the whole feature — and do NOT drop prior test-IDs (A5 still guards
   shrinkage).

2. **Red between checkpoints is fine; green at the checkpoint is mandatory.**
   While you and the human are chatting and trying things, the tree may be red —
   that's iterating, not a stall. The gate only has to be a genuine `--all` 9/9
   at a **checkpoint** — when the orchestrator is about to merge a coherent round
   of changes. Batch a round of related feedback into ONE merge; don't merge
   every single tweak (keeps main clean and each merge-gate run meaningful).

3. **The ledger is the spine AND the memory.** `HUMAN_FEEDBACK.md` persists on the
   branch and survives a context `/clear`: a session re-opening the feature reads
   the ledger to recover what was asked and decided. Each new piece of feedback is
   a new `FB-N` (verbatim, `status: open`) → implement it → add the test that
   covers it → flip `resolved`. Phase 9 fails while any `open` remains, so "all
   gates pass at the end" is automatic: you cannot merge with unaddressed
   feedback.

Across an iterated feature's multiple merges, the orchestrator harvests only the
NOT-yet-harvested `generalizable: yes` items each round (per the harvest mark in
Phase 9), so each rule is folded into this skill exactly once.

---

## Phase discipline (binding behavioral rules)

These are the human-judgment rules the deterministic gate cannot encode. They
are binding, not advisory — each traces to a specific failure that reached main
or wasted many sessions.

- **B1 — box load is NOT a deferral reason.** "The machine is busy, I'll do it
  later" is not a valid stop. Check actual CPU headroom (`%idle`/`%iowait` via
  `top`/`iostat`/Activity Monitor/`Get-Counter` on Windows), not the load
  average — a high load average with idle CPU is fine. "Blocked" requires a
  SPECIFIC error (a port bind failure, a docker daemon down, a compile error),
  never a resource metric.
- **B6 — a gate must survive the merge strip.** If your feature ADDS a check to
  `npm run check` / CI / the build, that check must read its config /
  source-of-truth from a PERMANENT committed path (a product-tree file), NEVER
  from a `.lifecycle/` artifact — `.lifecycle/` is stripped at merge, so a gate
  that reads it passes in your worktree and then fails `npm run check`
  PERMANENTLY on main. Verify any new gate against a lifecycle-stripped tree
  (temporarily move `.lifecycle/` aside, re-run the gate, confirm it still
  passes) before declaring done. (Caught on the desktop-override gate, which
  read its approval list from `.lifecycle/…/DECISIONS.md`.)
- **B7 — verification means RUNNING it, never reading the code.** "I determined
  this behaves correctly by reading the code" is a GUESS, not verification, and it
  is a recurring miss. Every behavioral claim must be proven by a test that
  actually EXERCISES the behavior. For UI/render behavior specifically: mount the
  route/component and assert the DOM (e.g. "the pop-out route renders NO sidebar/
  app-nav and DOES render the ConversationPane") — a mocked unit that covers the
  window-API mechanics does NOT cover what actually renders. No item ships with
  "0 tests" or a read-and-assert stand-in; the FB-7 coverage for a render/behavior
  item must be a test that genuinely runs it.
- **B8 — do not stop to ask about IMPLEMENTATION approach.** You are authorized to
  implement. Once you have worked out the right approach, DO it and keep going —
  never pause on "want me to start there?" / "should I proceed?". The only things
  you escalate to the human are genuine PRODUCT choices about what the feature
  should DO, surfaced as explicit option pickers (the Phase-4 rule). Implementation
  decisions are resolved by precedent/convention and executed, not asked.
- **B9 — reproduce a reported bug LITERALLY before fixing it.** When the human
  hands you a concrete step-by-step repro, reproduce that EXACT sequence and watch
  what happens before designing a fix — do not fix a plausible-adjacent symptom
  (a stale URL) when the real mechanism is different (shared hydration). The
  regression test must be EXACTLY the reported sequence and nothing more: every
  extra step you add (a reload, a wait, a nav) is a chance to diverge from the
  repro and mask the real behavior; test unrelated features in their OWN tests.
  And when the human asks "what renders?", SCREENSHOT it and LOOK — a green
  assertion (esp. one that waits up to 30s for an element) can mask a
  hangs-on-a-spinner defect. Trust the human's causal diagnosis over your first
  unproven hypothesis, and PROVE the real cause by running.
- **B3 — never edit the SHARED test harness to route around YOUR feature's
  problem.** `tests/common/*`, the gallery cassette, `playwright.*.config`, the
  build DB helper are shared infrastructure. If your test needs them changed,
  that's a signal your feature is wrong or the change belongs in its own
  reviewed commit — not a silent workaround that breaks everyone else.
- **B4 — a warm build is NOT a clean build.** New SSE/content-block variants,
  proc-macro registrations, and codegen inputs can compile against a STALE
  expansion in an incremental tree yet fail from clean. Validate them with
  `cargo clean -p <crate> && cargo check` before believing them. (The
  authoritative catch is the merge-gate's C1; this is the cheap local mitigation.)
- **B5 — don't stop to ask permission mid-task.** Continue authorized work to
  completion; surface genuinely ambiguous PRODUCT decisions once, up front, in
  Phase 4 — not as a mid-implementation halt ([[feedback_autonomous_loop]]).
- **P1 — independently re-verify the load-bearing gate yourself.** Trust the
  ARTIFACT you re-ran, not a sub-agent's "it passes" self-report. Before
  declaring a phase done, re-run its gate in the actual worktree and read the
  output. This is the single biggest clean-vs-red differentiator.
- **P5 — native-verify a cfg-gated arm on ITS OWN platform.** A
  `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "macos")]` block is
  invisible to a Linux `cargo check` — it is never compiled. Before pushing
  platform-specific code you MUST `cargo check` it on that OS (the Mac / Windows
  build hosts — [[project_crossplatform_build_test_hosts]]) and give it a
  cfg-gated unit test that runs there. A Linux-only green is not coverage of a
  Windows/macOS arm.
- **R2-3 — diff-review desktop `ui/` overrides against the server `ui/`
  equivalent (SECURITY).** `src-app/desktop/ui/` carries HAND-WRITTEN overrides
  (not just codegen). When you change logic in `src-app/ui/`, diff the desktop
  counterpart and confirm no security-relevant logic was dropped — a dropped
  `evaluatePermission` filter once reached desktop prod. Codegen'd files
  (`openapi.json`/`api-client/types.ts`) are regenerated for both by
  `just openapi-regen`; the hand-written surfaces are the risk.

**Cross-platform reality.** This infra runs on Linux, macOS, and Windows.
`lifecycle-check.mjs`, `merge-gate.mjs` are pure Node (portable); `preflight.sh`,
`selftest*.sh`, and the git hook run under bash — present on all three via
git-bash on Windows (git runs its hooks through that same bash). Keep any new
shell in this dir POSIX-portable (no GNU-only flags; guard Unix-only tools with
`command -v`).

---

## Finishing

```bash
node .claude/lifecycle/lifecycle-check.mjs --all --repo <worktree-root>   # must be all-green
git add -A && git commit && git push        # pre-push hook re-runs --all
```

The pre-push hook blocks the push unless `--all` is green. To push a
deliberately-incomplete WIP branch, `git push --no-verify` (and say so).

## Notes

- Keep commit messages clean — no Claude trailers ([[feedback_no_claude_trailers]]).
- If a decision genuinely can't be resolved by convention, surface it EARLY
  rather than guessing ([[feedback_research_landscape_before_plan]]).
- The lifecycle artifacts are committed; the skill/validator/hook are machine-local.

## Merge hygiene (required)

`.lifecycle/<feature>/` artifacts live ON THE FEATURE BRANCH so the validator
and pre-push hook can gate it. They are process records, not product code —
**strip them when merging to main**: the merge driver (or the final commit
before merge) runs `git rm -r .lifecycle` so main never accumulates lifecycle
artifacts. The branch history preserves them for audit.

## Merge-gate (required before ANY push to main)

The per-branch `--all` gate CANNOT catch a collision with *current* main: the
pre-push hook EXEMPTS pushes to main by design, so a migration-number clash, a
stale branch, a dropped desktop regen, or a proc-macro variant that only fails
from a clean tree are all invisible to it. **Before merging/pushing to main, run
the merge-gate** — it stages the merge onto fresh `origin/main` and re-checks
against reality:

```bash
node .claude/lifecycle/merge-gate.mjs <feature-branch>
# C4 stale-branch · C2 migration-collision · staging-merge + P2 completeness ·
# C5 .lifecycle strip · C3 regen-parity (BOTH ui/ + desktop/ui/) · C1 clean build
# exit 0 → the merge onto current main is clean. non-zero → fix the reported gate.
```

Add `--keep-staging` to push the validated merge straight from the staging
worktree; `--skip-heavy` to run only the fast deterministic gates (C2/C4/P2/C5)
when iterating. This codifies — and replaces — the by-hand
staging-merge/`cargo clean`/regen-both-workspaces discipline.
