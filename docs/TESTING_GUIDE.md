# Testing Guide

> `sdk:` = `sdk/packages/…`; `ziee:` = the reference app. The binding *rules* are
> `CODING_GUIDELINES.md` §14; this doc is the **shape** — the tiers, the harness,
> the selector ladder, and where a feature's suites go.
>
> Enforcement tags: 🔧 lint · 🧪 test · 🔬 ci · 📐 convention.

---

## 1. The four tiers

Every app names its tiers in a `docs/TESTING.md` and gives each one a `just`
recipe. **A tier nobody can find is a tier nobody runs** — pin the table to
`just --list` with a check script so the doc and the recipes cannot drift.

| tier | proves | needs |
|---|---|---|
| **unit** | pure logic in in-source `#[cfg(test)]` (`cargo test --lib`) + `node --test` for scripts: parsing, validation, bounds, formatting | the shared build-DB cluster **at compile time only** (sqlx macros verify against it) |
| **integration** | real-server behavior: spawn the REAL binary against its OWN database cloned from a migrated template, drive the HTTP API, reap on `Drop` | the build-DB cluster |
| **static** | the whole Rust workspace compiles **including test crates** (`cargo check --workspace --tests`) + `tsc` over `src` **and** `tests` — specs are inside the compiler + the whole `npm run check` gate chain | the build-DB cluster |
| **e2e** | user-visible flows through the **production bundle**, Playwright driving a real spawned backend | the cluster + `npx playwright install chromium` |

📐 Run e2e through the recipe, not `playwright test` directly — the recipe builds
the UI first, and a stale `dist/` silently tests old code.

📐 **Directory == runner.** The Playwright config collects ONE directory with no
`testIgnore`. A tier needing a *differently configured backend* or a *different
server* gets its own sibling `tests/<tier>-e2e/` + `playwright.<tier>.config.ts` +
npm script, driven from the same recipe — never a nested directory under the main
`tests/e2e/`. (ziee's main config does carry a `testIgnore: '**/visual/**'` for a
backend-free visual layer with its own config; a nested exception is the thing to
avoid, not the sibling.)

---

## 2. Backend tests

- 🔬 Pure logic (validation, parsing, formatting, bounds) → in-source
  `#[cfg(test)]` next to the code it proves.
- 🧪 **Every `RequirePermissions` endpoint** → a 401 (unauthenticated) and a 403
  (wrong-permission) test.
- 🧪 **Every non-2xx handler path** → an integration test that hits it.
- 🧪 **Every path-ID handler** → a cross-user request returns **404**, not the row.
- 🧪 Check-then-act / shared-state / concurrent-spawn code → a concurrency test.
- 🧪 Cross-module runtime interaction → one integration test that exercises the
  interaction, not each side in isolation.
- 🧪 State-persisting features → a restart/reload-persistence test; SSE handlers →
  stream edge-case tests.
- 🧪 A model-callable tool → a real-LLM test that **runs** (key-gated is fine;
  `#[ignore]` to go green is not).

Suites live in the aggregating integration test crate:
`server/tests/<module>/mod.rs` plus a `mod <module>;` line in
`tests/integration_tests.rs`. The harness (`tests/common/`) hands each test a
server with `api_url()` / `client` / `database_url()`. Per-test isolation is by
database + spawned subprocess, so `--test-threads > 1` is safe; the reference app
defaults to 6.

---

## 3. E2E — drive the real app

The scaffold is `@ziee/test-e2e` (`sdk:test-e2e`): a parameterized Playwright
preset, the per-run Postgres global-setup/teardown, a port allocator, and the
selector helpers. The app supplies specs + fixtures through one `E2EConfig` seam.

**Each test gets its own full stack** — a fresh backend process, its own Vite/
preview server, its own database. That is also why parallelism is conservative:
many servers cold-booting at once widens the readiness window and is the dominant
source of flakiness. Raise workers only after validating on the target CI box.

### 3.1 The no-mocking rule, stated honestly

🔬 **The rule: no `page.route()` API mocking. Drive the real backend through the
UI.** A spec that stubs `/api/*` is testing the stub.

**The reference app does not fully comply**: 94 of its 695 specs call
`page.route()` (measured), mostly to force states a real backend won't produce on
demand — an update-server status, a hardware profile, a download progress stream,
a third-party endpoint. Treat those as **legacy debt, not precedent**. For new
work:

- a state a real backend *can* reach → reach it (seed via the API, then drive the
  UI);
- a state that needs a *different backend configuration* → a sibling tier with
  its own config, not a mock;
- an **external** dependency (a third-party HTTP API, an LLM provider) → a stub
  **server**, not a `page.route` over your own `/api`;
- store-only / SSE-only state that no GET can produce → the **gallery**'s seeded
  `setup` (§5), which is not the e2e tier.

If you cannot avoid a route stub, it must stub something that is not your own
API, and say why in a comment.

### 3.2 Selector ladder

`role → label → text → testid` (`sdk:test-e2e/src/testid.ts:38-40`). The wrappers
`byRole` / `byLabel` / `byText` / `byTestId` keep call sites uniform.

- 🔧 Prefer **`data-testid` over visible text / accessible name for anything
  i18n-sensitive** — translations move, testids do not. Kit components already
  require an explicit, globally unique `data-testid`.
- Bind a typed helper to the app's generated testid union
  (`makeByTestId<KnownTestId>()`) so an unknown id is a **compile** error;
  derived ids (`user-row-${id}`) still work.
- Collection items derive their testid from the container — give the **container**
  one.

### 3.3 Coverage rules

- 🧪 Every **permission-gated surface** → both the permitted and the denied path
  (a `loginAsAdmin` / restricted-user helper pair).
- 🧪 Every **route guard** → unauth-redirect **and** authed-reach.
- 🧪 A **guest-reachable** route → a spec that visits it **logged out**. In a
  guest-first app add one for an **unknown URL** logged out: the public `*` route
  currently wins over the router's guarded fallback only by react-router
  definition-order tie-breaking, and nothing else tests it.
- 🧪 Every feature → at least one full multi-step **user journey**.
- 🧪 SSE components → connection + arrival + update. Auth flows →
  success / failure / logout.
- 🧪 A sync-emitting entity → a cross-device test: **two browser contexts**, the
  mutation driven through the UI in one, the update asserted in the other, **no
  reload**.
- 🔬 Every interactive render exercises ≥1 interaction (not visibility-only);
  empty / error / loading branches each triggered; responsive pages tested below
  640px; drag components use `.dragTo()`.
- 📐 Spec files run in **relative-path order**. A suite that must see a virgin
  database (a first-run setup assertion) needs a `00-` prefix to stay first.

---

## 4. Static gates — `npm run check`

The frontend `check` is a **chain of small gates**, not just `tsc`. Most are
SDK-provided and config-driven; adoption is an npm script plus a config entry.
See `FRONTEND_DEPS.md` §3 for the full inventory and adoption order. The ones
that catch the most:

| gate | catches |
|---|---|
| `lint:guardrails` (biome `noRestrictedImports` + two Grit plugins) | `antd` imports; raw `<button>/<input>/<select>/<textarea>`; the removed `.__state`. **Not** cross-module imports — nothing gates those |
| `lint:hooks-top-level` (biome `useHookAtTopLevel`) + an app hook lint | `usePermission(A) \|\| usePermission(B)` and conditional store-proxy reads |
| `check:store-actions` | folder-per-store shape; bans `lazyActions:` / inline `actions: {` |
| `lint:colors` | raw hues, arbitrary color values, inline style colors |
| `check:design-spec` | `DESIGN_SYSTEM.md` drift from `index.css` |
| `check:testid-registry` (+ the build-time uniqueness plugin) | missing / duplicate testids — every E2E selector depends on it |
| `check:gallery-prod-exclusion` | the gallery seed marker leaking into the production bundle |

🔬 `tsc` must cover **`tests/` as well as `src/`** — otherwise specs drift out of
the type system, which is the whole point of typed selectors.

---

## 5. The gallery — a real testing tier, not a storybook

`@ziee/gallery` (`sdk:gallery`) is a framework; the app injects everything
app-specific through one `mountGallery(GalleryConfig)` call, from a **separate
Vite entry** (`gallery.html`) that the app's `main.tsx` never imports — so it
tree-shakes out of production, asserted by `check:gallery-prod-exclusion`.

Two authoring lanes:

- **Stories** — component matrices (`GalleryStory` / `GalleryCase` /
  `StorySection`).
- **Seeded surfaces** — whole pages with fixture state, discovered by an eager
  glob that must stay app-side (`import.meta.glob` cannot cross a package
  boundary). Each entry is `{slug, title, note, path, initialPath, component,
  setup}`, where `setup` seeds store state no GET can produce.

📐 Both lanes may live in `modules/<name>/gallery.tsx` (co-located, the newer
convention) or in a central `dev/gallery/stories/` (ziee's historical shape).
Pick one per app and keep it.

The gates on top:

- **`gallery:runtime`** loads **every surface × state × theme** as a full page
  reload of a URL-isolated entry and records console errors, pageerrors, failed
  requests, React warnings, **WCAG-AA contrast failures**, unnamed interactives,
  and off-4px-grid spacing.
- **`gate:ui`** is the surface exit condition: tsc + lint + **zero HIGH runtime
  findings** + the visual layer, printed per surface.

Rules:
1. New component ⇒ a story case in the same commit; new page ⇒ a seeded surface.
2. **Populated fixtures first** — long titles that must clamp, real counts, full
   slot sets. Empty / error / loading are *additional* cases.
3. Never re-encode theme, accent, or viewport in a story — the harness sweeps
   those axes.
4. Slugs are globally unique.
5. **A surface is done when `gate:ui` is green for it, not when it looks right.**
