# Ziee Coding Guidelines

> **agent-kit provenance + split.** This doc is **ziee-derived** and vendored
> into agent-kit as shared reference. Its rules span two kinds:
> - **Framework-general** (apply to any app on this stack): §5 resource
>   lifecycle/cleanup, §6 error handling, §8 event emission, §9 module structure
>   & coupling, §10 API/type contract, §12 frontend store/proxy discipline,
>   §13 UI/UX & accessibility, §14 testing requirements, §15 dead-code,
>   §16 config/kill-switch/cross-platform, §17 dependencies/docs/naming.
> - **Ziee-domain** (reference for other apps, not binding): §1 authz &
>   ownership, §2 outbound HTTP & SSRF, §3 secrets, §4 DB correctness, §7
>   realtime sync (notify-and-refetch), §11 built-in MCP-server checklist.
> A future app should treat the framework-general sections as its own and the
> ziee-domain sections as informative precedent. The split was kept annotative
> (not a hard extraction) to avoid dropping content — see DEC-3 in the
> agent-kit-consume lifecycle.

Derived from a 23-dimension audit of the codebase: 2,033 consensus-confirmed
real findings, clustered into 220 root-cause patterns, distilled into the rules
below. **Each rule is a recurring mistake that already happened — follow them and
the audit backlog does not rebuild.**

Every rule carries an **enforcement** tag — the cheapest gate that catches it:
- 🔧 **lint** — mechanically catchable (clippy / biome / eslint / `ast-grep`); add the rule, never think about it again.
- 🧪 **test** — must ship with a test of a specific shape.
- 🔬 **ci** — checked on the PR diff (scoped, not a full-repo scan).
- 🏛 **type** — encode as a type-system invariant so it can't compile wrong.
- 📐 **convention** — no mechanical gate yet; reviewer/author discipline.

The goal: push as many ▢ as possible from `convention` → `lint`/`type`. Section
17 lists the lint rules worth building first.

---

## 1. Authorization & ownership  (the #1 source of critical findings)

- 🔬 **Every route gates authorization in the handler signature.** Use
  `RequirePermissions<(Perm,)>` or `RequireAdmin` as a handler parameter. Never
  hand-roll `JwtAuth`/jsonwebtoken checks; never register an `.api_route` whose
  handler takes no permission extractor. *(grep PR diff: new `api_route` →
  handler must have a `Require*` param.)*
- 🧪 **Every path-ID handler verifies ownership before acting.** Scope the SQL
  with `WHERE user_id = $auth` (or an ownership extractor) — don't fetch then
  trust. A cross-user ID must yield **404**, not the row. Ships with a
  cross-user-404 test.
- 🔧 **Least privilege.** Read endpoints use a `*::read` perm, never
  `create/edit/delete`. Match the perm constant to the minimum action.
- 🔧 **No identity from the client body.** Never accept `user_id`/`role` in a
  request body; derive from the token. Debug endpoints gate behind admin.
- 🔧 **No information leak via status.** Missing resource → `404`, not `200
  {status:"not_found"}`.

## 2. Outbound HTTP & SSRF  (critical; the most-repeated security pattern)

- 🔧 **Validate every user/model-supplied URL** against
  `url_validator::validate_outbound_url` (policy `PUBLIC_HTTP_OR_HTTPS` or
  stricter) **at the handler**, before building any client. This includes
  `resource_link` fetches and any third-party-supplied URL (e.g. Unpaywall PDFs).
- 🔧 **Never use reqwest's default redirect policy** on a client for a
  user-supplied URL — set a custom `RedirectPolicy` that re-validates each hop
  (defends DNS-rebinding + redirect-to-internal).
- 🔧 **Always set `.connect_timeout()` + `.timeout()`** (30–120s; SSE uses a
  longer body timeout) on every external client.
- 🔧 **One shared `reqwest::Client` per process** (`Arc`/`LazyLock`), not
  per-request. Same for native lib handles (pdfium, etc.).
- ⚙️ Trusted admin-configured hosts (self-hosted SearXNG) may use a
  private-allowing policy literal — that's the *only* exception, and it's explicit.

## 3. Secrets

- 🔧 **Never `#[derive(Debug)]` on a struct holding decrypted secrets / API keys
  / tokens.** Hand-write `Debug` that redacts.
- 🔧 **`#[serde(skip)]` for secret fields** (not just `skip_serializing`).
- 📐 **Dual-column storage**: `*_encrypted` + the plaintext working value; expose
  only through a **view type** that carries the redacted form. SQL returning
  secret-bearing rows is **scoped to the owner**.
- 📐 **`env_clear()` before spawning children**, then whitelist only needed vars
  (`PATH`/`HOME`/…). When injecting admin-configured env, **denylist** loader
  vars (`LD_*`/`DYLD_*`/`PATH`/`HOME`/…).
- 📐 **Hash tokens before compare/store**; generic auth-failure text; never log a
  raw token/key/secret.

## 4. Database correctness

- 🔧 **Bounded deletes & selects.** Every `DELETE` on an unbounded-growth table
  gets a `LIMIT`/batch cap; every user-facing list method takes `page/per_page`,
  clamped to a max (default 50, cap 500) — never hardcode pagination.
- 🔧 **Wrap multi-step writes in one transaction** (`sqlx::begin`); storage +
  DB writes in the same scope (DB first, or temp-then-move).
- 🔧 **No TOCTOU.** Replace SELECT-then-INSERT with `INSERT … ON CONFLICT`, or
  guard+write in one txn (`SELECT … FOR UPDATE` / CAS `UPDATE … WHERE`). Add a
  **partial UNIQUE index** on any pair the code assumes distinct.
- 🔧 **No N+1 / in-memory filtering.** Push filters to SQL (`WHERE`/`IN`/`ANY`/
  `EXISTS`); never query inside a loop; never `SELECT *` then filter in Rust.
- 🔬 **Index every WHERE/FK column**; composite indexes for combined filters
  (`(user_id, created_at DESC)`). Use `CREATE INDEX CONCURRENTLY` in migrations;
  advisory-lock blocking `ALTER`s.
- 🔧 **Never `unwrap()`/`expect()` on enum strings from the DB** — `from_str`
  with a default/error variant.

## 5. Resource lifecycle, cleanup & orphans

- 🔧 **Every spawned long-lived child process gets `PR_SET_PDEATHSIG`** (or a
  Drop guard / `kill_on_drop`) so it dies with the server even on SIGKILL.
- 🔬 **Startup orphan-reclamation + shutdown covering all signal paths.**
- 🔧 **Every cache/temp/storage dir has a TTL + eviction/prune fn.** No cache
  path without an eviction policy. `create_dir_all` for a session/temp dir has a
  matching cleanup on **every** exit path (success/error/timeout) — prefer a RAII
  guard.
- 🔬 **Cleanup on delete.** Deleting an entity that owns FS artifacts, a
  subprocess, a VM, or a workspace dir must stop/kill/remove them synchronously;
  ownership-bound cleanup failure **aborts the delete** (don't `let _ =`).
- 🔬 **Every child/join table has `ON DELETE CASCADE`/`SET NULL`** or explicit
  cleanup SQL; every accumulating table has a retention path.
- 🔧 **Every `tokio::spawn`ed loop stores its `JoinHandle` + has a cancellation
  mechanism** (`watch`/`CancellationToken`); shared concurrency maps have a
  deterministic removal path (TTL/unregister/bounded LRU).
- 🔧 **No `std::fs` in async** — use `tokio::fs`. No `println!`/`eprintln!` in
  handlers — use `tracing`.

## 6. Error handling

- 🔧 **Never `unwrap()`/`expect()` on runtime values** (DB/FS/env/HTTP) — `?` or
  match with logging + fallback.
- 🔧 **Never silently swallow** (`let _ =`, `.ok()`, `unwrap_or_default()` on a
  real failure, empty-string-on-serialize-fail). Propagate with `?` or surface a
  user-visible error. **DB error ≠ 404**: distinguish "row not found" from "query
  failed".
- 🔧 **Preserve error context** in `map_err` (`format!("{desc}: {e}")`), don't
  collapse to a bare `StatusCode`.
- 🔬 **Retry+backoff** on business-critical external calls (identity/search/
  download/verify). **Timeout** every user-facing SQL query
  (`tokio::time::timeout(30s, …)`).
- 🧪 **SSE channel writes use blocking-send + timeout** (not `try_send`); a
  persistently full channel logs `error!` + records a miss.

## 7. Realtime sync  (notify-and-refetch contract)

- 🔬 **Every mutation handler calls `sync_publish(entity, action, id, audience,
  origin.0)` after the DB write**, with the correct `Audience` (owner-scoped by
  default; the perm must equal the refetch endpoint's read-perm).
- 🏛 **New cross-device entity → add the `SyncEntity` variant first** (it
  auto-derives the `sync:<entity>` TS event key on next OpenAPI regen).
- 🧪 **Every store showing mutable data subscribes to `sync:<entity>` +
  `sync:reconnect`** in its `init` (via the `on(...)` toolkit `init` receives —
  the old `__init__.__store__` naming is gone), and **self-gates** the refetch
  with `hasPermissionNow(Permissions.X)` (no-403-on-reconnect). If `init`'s
  initial load is permission-gated, add the bootstrap-race re-trigger:
  `watch(useAuthStore, () => hasPermissionNow(Permissions.X), (now, prev) => { if (now && !prev) void actions.load() })`.
- 🔧 **Detached tasks emit with `origin: None`.**

## 8. Event emission

- 🔬 **Every successful mutation emits** (`EventBus::emit_async` + `sync_publish`).
  This includes the non-obvious paths (password reset, model update, …). A module
  that mutates has an `events.rs` with a typed `AppEvent`.

## 9. Module structure & coupling

**Backend**
- 🔬 **Canonical flat layout** per module: `mod.rs`, `handlers.rs`, `models.rs`,
  `repository.rs`, `permissions.rs`, `events.rs`, `routes.rs`.
- 🔧 **All business SQL lives in `repository.rs`** (handlers take `PgPool`, call
  repo fns) — no inline `sqlx::query` in handlers.
- 🔬 **Handlers ≤ 800 lines**; extract bloat into submodules. Extractors do
  extraction+authz only — no business logic.
- 🔬 **Module graph is a DAG.** Hub/aggregator modules don't import feature-module
  types or validators. Shared infra → `common/`/`core/`/`mcp_types`. Built-in MCP
  server IDs in one constants module (no hardcoded literals).

**Frontend**
- 🔧 **Canonical module layout**: `types.ts`, `stores/`, `components/`,
  `widgets/`, `events/`, `module.tsx`; every store is registered in the same
  commit (no dead module files). A store is a **folder**
  (`stores/<name>/{index,state,actions.gen}.ts` + `actions/`), not a file —
  see `REACT_COMPONENT_PATTERNS.md` §9 and `META_FRAMEWORK_ARCHITECTURE.md` §2.2.
- 📐 **No cross-module store access.** Never read another module's store handle
  or subscribe to its raw zustand hook. Communicate via the owning
  module's exported actions + EventBus. Import only from a module's public barrel
  (`@/modules/<name>/module`), never its `core/`/`utils/`/components.
- 🔧 **Cross-module UI via the slot system** (`settingsUserPages`,
  `routerEffects`, panel renderers), not direct component imports. Derive menus
  from slots+permission, never a manual hide-list.

## 10. API / type contract

- 🔧 **Every public async handler has `#[debug_handler]`** (required for aide
  OpenAPI gen) and its `_docs` ends with `.description(...)` (+ documents 404/
  error responses).
- 🔬 **Regenerate OpenAPI after any handler/type change** and verify: nullable
  Rust fields appear as `| null` in TS; every `#[derive(JsonSchema)]` field has a
  TS property; numeric Rust types map to TS `number` (never `string`).
- 🔧 **Tri-state fields use `Option<Option<T>>` + `#[serde(default,
  deserialize_with = "deserialize_nullable_field")]`.**
- 🔧 **Frontend calls the generated `ApiClient` method** (augment the generator if
  a signature is incomplete) — no raw `fetch`, no `as any` to drop params.
- 🔧 **DELETE handlers return `ApiResult<()>`** (→ 204); never a `(StatusCode,
  Json)` tuple.

## 11. Built-in MCP server checklist

When adding/maintaining a built-in MCP server, **all** of:
- 🔬 a `permissions.rs` with a domain-specific perm (`citations::use`, `bio::query`,
  …); the JSON-RPC handler gates on it (never a generic perm).
- 🔬 the chat extension's `before_llm_call` sets the attach flag via the shared
  `apply_*_attach` helper.
- 🔬 **both** `mcp.rs` edits: `auto_attach_builtin_ids()` **and**
  `is_builtin_server_id()` — forgetting either = silent "tools never reach the
  model". Auto-attached/read-only tools also added to the approval-bypass list.
- 🧪 servers fetching third-party data **prepend an untrusted-content guard**
  system message.
- 🧪 a real-LLM integration test that actually invokes the tool (model marked
  tool-capable).

## 12. Frontend store / proxy discipline

> **CORRECTED.** The global `Stores.X` proxy and the `.__state` alias were both
> **REMOVED** from the SDK (`sdk/packages/framework/src/stores.ts:337-342`,
> `:84-85`). Import each store's handle directly — the value `registerLazyStore`
> returns. Earlier revisions of this file taught `Stores.X.__state.field`; that
> API does not exist.

- 🔧 **Render** reads `X.field` (reactive; re-renders on change). **Handlers /
  async / store `init` / module scope** read `X.$.field` — the `$` snapshot is
  the only hook-free state read. A plain state read outside render throws
  React's *Invalid hook call*.
- 🔧 **Actions are hook-free on the proxy**: `X.doThing()` is callable anywhere.
  Never `X.$.doThing()`.
- 🔧 A getter method (`X.getFoo()`) does **not** subscribe — in render also
  read the reactive field or the component renders once empty and never updates.
- 🔬 **Every store declares `init`**; event/SSE subscriptions live there (via the
  `on`/`watch`/`onCleanup` toolkit `init` receives), never in a component
  `useEffect`.
- 🔧 **Register a store exactly once.** `registerLazyStore(...)` self-registers;
  also listing it in a `module.tsx` `stores: [...]` array builds a second
  lifecycle — two `init` runs, two of every `sync:` subscription.
- 📐 **No portal `setTimeout` DOM-ready hacks** — use ResizeObserver/
  IntersectionObserver/parent-provided readiness.

## 13. UI/UX & accessibility

> **CORRECTED.** This section was written in the antd era. **antd is gone** —
> the reference app has zero `antd` imports and no `antd` dependency, and a
> Biome rule rejects the import. UI comes from the kit (`@ziee/kit` /
> `@/components/ui`). Ignore any antd-token or antd-deprecation guidance.

- 🔬 **Semantic interactive elements** (kit `Button`/`Link`, or `button`/`a`) for
  clickables; a `div onClick` needs role + keyboard handlers. Raw
  `<button>/<input>/<select>/<textarea>` in app code is lint-rejected.
- 🔬 **Always render `store.error`** (kit `ErrorState`/`Alert`/`Result`) — never
  `return null` on error. **Always show loading** (`Spin`/`Spinner`) on initial
  fetch, and an `Empty` for no rows. **Always show success/error feedback** after
  a mutation (`message.*` from `@ziee/kit`).
- 🔬 **Accessible names**: every control has a label (kit `FormField label` /
  `<label htmlFor>` / `aria-label`); an icon-only `Button` needs `tooltip` or
  `aria-label`; every page a `role=main`; nav landmarks set.
- 🔧 **Semantic design tokens only** (`bg-background`, `text-muted-foreground`, …)
  — never a raw hue, an arbitrary color value, or an inline `style` color. See
  `DESIGN_SYSTEM.md`. No CSS-`!important` hacks; no inline
  `e.currentTarget.style.*` for hover/focus (use `:hover`/`:focus-visible`).
- 🔧 **Controlled kit controls** use `value`/`checked` (never `defaultValue`/
  `defaultChecked` in a controlled component).
- 🔧 **`data-testid` is required** on kit functional/container/value/action
  components and must be globally unique.
- 🔧 **No `console.log`/`debug` in production** (only `console.error`/`warn`).

## 14. Testing requirements

**Backend**
- 🔬 Pure logic (validation/parsing/formatting/bounds) → in-source `#[cfg(test)]`.
- 🧪 Every `RequirePermissions` endpoint → 401 (unauth) + 403 (wrong-perm) test.
- 🧪 Every non-2xx handler path → an integration test hitting it.
- 🧪 check-then-act / shared-state / concurrent-spawn code → a concurrency test.
- 🧪 cross-module runtime interaction → an integration test that exercises it
  (not each side in isolation).
- 🧪 state-persisting features → a restart/reload-persistence test; multi-turn
  chat features → a ≥2-turn test; SSE handlers → stream edge-case tests.
- 🧪 every model-callable built-in tool → a real-LLM test (key-gated, **runs** —
  don't `#[ignore]` to go green).

**Frontend (E2E)**
- 🔬 **No `page.route()` API mocking** — drive the real backend through the UI.
- 🧪 every permission-gated surface → both permitted + denied paths
  (`loginAsAdmin`/`loginAsUser`); every route guard → unauth-redirect + authed-
  reach.
- 🧪 every feature → at least one full multi-step user-journey; LLM features → a
  real-LLM/stub-engine E2E.
- 🧪 SSE components → connection+arrival+update; auth flows → success/fail/logout.
- 🔬 every interactive render exercises ≥1 interaction (not visibility-only);
  empty/error/loading branches each triggered; mobile-responsive pages tested at
  width < 640px; drag components use `.dragTo()`.
- 🧪 sync-emitting entities → a `13-sync/` cross-device test (two contexts,
  originating mutation via UI, no reload).

## 15. Dead code = unfinished work

- 🔬 **Wire features end-to-end in the same PR.** Every new public fn with a side
  effect has a production caller; every enum variant is constructible; every
  struct/DB field is read; every `pub use` has an external consumer.
- 🔧 **Never `#![allow(dead_code)]` at module level** to silence warnings. Remove
  it, or `#[allow(dead_code)]` the single intentionally-unused item with a reason.
- 🔧 Remove unused imports/deps (`cargo check` immediately after refactor; no
  `package.json` dep without an import).

## 16. Config, deploy kill-switch & cross-platform

- 🔬 **Every side-effecting/route-adding module has an `Option<XxxConfig>`
  deploy-level kill-switch.** The `enabled` guard in `init()` must also appear in
  `register_routes()` (before `.merge()`) and before any
  `upsert_builtin_server()`.
- 🏛 **Server-only features disabled on desktop on both sides**: a runtime config
  flag in the desktop backend **and** `CORE_MODULE_BLOCKLIST` in the desktop
  loader (not a cargo feature).
- 📐 **Platform-gate OS-specific code/deps** with `cfg`/`[target.X]` so other
  platforms still build; dlopen-runtime features degrade gracefully, don't get
  compiled out.

## 17. Dependencies, docs, naming

- 🔬 **`npm audit` + `cargo`/RUSTSEC advisory check in CI**; direct deps carry no
  high/medium advisories. Member crates inherit `dep.workspace = true`; no
  unused workspace deps; no new `serde_yaml`.
- 🔬 **Docs reference only verified paths/symbols/migration numbers** (derive from
  `ls migrations/` at write time); counts are scriptable, not hardcoded; no stale
  TODO/FIXME without a tracking link; code is the source of truth, not status prose.
- 🔧 **Never `ziee-chat`** (or `Ziee Chat`/`zieeChat`/…) in any user-facing
  string, comment, error, or log — the app is **`ziee`**. (Only the external
  GitHub URL + rolling log artifacts are exempt.)

---

## Build these lint rules first (highest leverage)

These convert the most-repeated findings into zero-effort gates:

1. `ast-grep`: bare `reqwest::Client::builder()` not routed through the validated
   builder → SSRF + timeout (§2). *Biggest single cluster.*
2. clippy/grep: `.api_route(` whose handler lacks a `Require*` param (§1).
3. clippy/grep: `#[derive(Debug)]` on a `*Secret*`/`*Credential*`/`*ApiKey*`
   struct (§3); handler `async fn` without `#[debug_handler]` (§10).
4. grep: `sqlx::query` inside `handlers.rs` (§9); `unwrap()/expect()` on
   DB/FS/env/HTTP results (§6); `let _ = .*delete` (§5/6).
5. biome/eslint: `console.log`, hardcoded hex colors, `defaultValue` on a
   controlled kit control, raw `fetch(` in modules, cross-module store/component
   imports (**no gate exists for this one today** — see
   `REACT_COMPONENT_PATTERNS.md` §2), `ziee-chat` strings (§12/13/9/17).
6. CI-scoped diff check: new built-in MCP server → both `mcp.rs` edits present
   (§11); new mutation handler → `sync_publish` present (§7).

## How to use this going forward

- **New code:** this file is the checklist. The `🔧 lint`/`🏛 type` rules should
  fail your build once §17's rules land; the `🧪 test` rules are PR requirements;
  `🔬 ci` rules run on the diff.
- **Instead of re-auditing:** the scoped CI checks (run an audit lens on the PR
  diff, not the whole repo) replace these from-scratch sweeps. Full data behind
  every rule: `.claude/audit/consensus.json` (machine-local).
</content>
