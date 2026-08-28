# Permission Gating (CRITICAL)

> `sdk:` = `sdk/packages/…`, `sdk-crates:` = `sdk/crates/…` (the pinned SDK
> submodule); `ziee:` = the reference app.
>
> One rule above all: **the backend is the authority; every frontend layer is UX.**
> A hidden button is not a protected endpoint. Gate the route on the server, then
> gate the surfaces so the user is not shown things that will 403.

---

## 1. The vocabulary

A **permission** is a `module::resource::action` string (`projects::read`,
`agent::settings::manage`), matched with wildcards on both sides identically:

- exact match
- `*` — global wildcard
- hierarchical `::` wildcard — for `a::b::c`, `a::*` and `a::b::*` both match

**`is_admin` short-circuits everything**, on both sides. The `/api/auth/me`
payload does **not** rewrite `permissions[]` to `["*"]` for a root admin, so the
frontend must short-circuit on the flag itself — it does
(`sdk:framework/src/permissions/hasPermission.ts:23`).

**Root admin ≠ the Administrators group.** `is_admin` is a column on the user;
Administrators is a seeded group holding `['*']`. Both end up permitted, by
different code paths. `RequireAdmin` accepts only the former.

A **`PermissionExpr`** composes leaves (`sdk:framework/src/permissions/types.ts:27-30`):

```ts
type PermissionExpr = Permission | { allOf: PermissionExpr[] } | { anyOf: PermissionExpr[] }
```

Empty `allOf` is vacuously **true**; empty `anyOf` is **false**; `undefined`/`null`
**fails closed** (`evaluatePermission.ts:19-21` — added because a stale api-client
made an enum lookup resolve to `undefined` and crashed the whole router).

---

## 2. Backend — authorization is the handler signature

```rust
pub struct ProjectsRead;
impl PermissionCheck for ProjectsRead {
    const NAME:        &'static str = "ProjectsRead";
    const PERMISSION:  &'static str = "projects::read";
    const DESCRIPTION: &'static str = "Read chat projects";
    const MODULE:      &'static str = "project";
}
```

```rust
#[debug_handler]
pub async fn list_projects(
    auth: RequirePermissions<(ProjectsRead,)>,   // ← the gate
    Query(q): Query<ProjectListQuery>,
) -> ApiResult<Json<ProjectListResponse>> { … }
```

`RequirePermissions<(A, B)>` is **AND** across the tuple. Its algorithm
(`sdk-crates:ziee-framework/src/permissions/extractors.rs:73-129`):

1. pull the app-installed `IdentityResolver` out of request extensions
   (missing → 500);
2. `resolver.authenticate(parts)` → the user;
3. **`user.is_admin()` → granted immediately, groups never loaded**;
4. otherwise `resolver.load_groups(&user)`, then for each required permission
   check the **union** of the user's direct permissions and every **ACTIVE**
   group's permissions (`user_holds`, `:40-52`);
5. any missing → **403** `INSUFFICIENT_PERMISSIONS` naming them.

`RequireAdmin<R>` requires `is_admin` and returns 403 `ADMIN_REQUIRED` otherwise.

🔬 **Rules**
- Never hand-roll a JWT/session check in a handler.
- An `.api_route` whose handler has **no** `Require*` parameter is an
  unauthenticated endpoint. Treat that as a PR-blocking defect.
- **Least privilege**: a read endpoint takes a `*::read` permission, never
  `create`/`edit`/`delete`.
- **No identity from the client body** — never accept `user_id`/`role` in a
  request body; derive from the token.
- 🧪 Ownership is checked **in the SQL** (`WHERE user_id = $auth`), and a
  cross-user id returns **404**, not the row.

### Declaring the permission in OpenAPI

The `_docs` fn wraps with `with_permission::<(ProjectsRead,)>(op)`. It writes the
required permissions into the **`x-required-permissions` OpenAPI extension**
(`sdk-crates:ziee-framework/src/permissions/openapi.rs:62`) as well as the
description and the 403 example — because the extension is *the only
clobber-proof record*: a later `.description("…")` in the same builder REPLACES
the human-readable copy, and a builder's own `.response_with::<403, …>` drops the
403 example. On the shipped ziee spec those two losses once left 201 operations
with no recoverable permission, which downstream tooling reads as *"no permission
declared → anyone may run it"*.

### Granting

Permission strings are seeded by the owning module's own
`*_grant_permissions.sql` migration. The auth crate's seed keeps a clean base
(`Administrators=['*']`, `Users=['profile::read','profile::edit']`) and carries
**no domain permission strings**. 🧪 Assert in an in-source test that the
`PermissionCheck::PERMISSION` constants match the grant migration — drift leaves
the migration granting strings nobody checks for
(`ziee:src/modules/project/permissions.rs:42-50`).

---

## 3. Frontend — four layers, cheapest first

The app narrows the framework's `Permission = string` to its **generated**
`Permissions` enum (`@/api-client/permissions.ts`, regenerated with the OpenAPI
set — never hand-edited). Always pass an enum member, never a literal.

The primitives read the app's `Auth` store through an injected **seam**, not a
global: the app calls `setAuthView(Auth)` **once** at store-module scope
(`sdk:framework/src/permissions/authView.ts:22`). Reading before injection
throws a named error rather than silently denying.

| # | layer | API | when |
|---|---|---|---|
| 1 | **slot entry** | `permission?: PermissionExpr` on the entry; the **OWNER** filters with `evaluatePermission` before mounting | any nav item, menu entry, tab, widget, page section |
| 2 | **route** | `permission` on the `RouteConfig` → the app's injected `permissionGate` renders an **in-place 403** (URL + layout preserved) | every gated URL |
| 3 | **`<Can>`** | `<Can permission={…}>{children}</Can>`, `fallback` defaults to nothing | a single button/control inside a page |
| 4 | **`usePermission`** | `const ok = usePermission(expr)` | you need the boolean for branching |

Plus **`hasPermissionNow(expr)`** — the non-reactive escape for store `init`,
actions, and event handlers. It reads `.$` and does **not** subscribe
(`hasPermissionNow.ts:17-20`).

### Layer 1 is the important one

Filtering at the slot layer means an unpermitted widget **never mounts and never
fires its on-mount fetch** — no 403 storm on boot. The **owner** of the region
does it; a filler does not self-check:

```tsx
const isAllowed = (e: { permission?: PermissionExpr }) =>
  !e.permission || evaluatePermission(user, permissions, e.permission)
const nav = (slots.get('sidebarNavigation') || []).filter(isAllowed)
```

Factor this into one `useSlotEntries(key)` reader (sort + filter in one place)
rather than repeating the closure per owner. Keep the **unfiltered** list too, so
a deep link can distinguish *"section doesn't exist"* (404) from *"section exists
but you're forbidden"* (403).

A filler that renders **mixed** content self-gates internally with `<Can>`
instead of declaring a slot-level `permission`.

### Layers 1 and 2 go together

🔬 **A gated slot entry that links to a route sets `permission` in BOTH places.**
The slot filter only hides the entry point; the route gate is what protects the
URL against a typed address or a bookmark. `ziee:src/modules/auth/module.tsx`
sets the same `Permissions.SessionSettingsRead` twice — on the route (`:61`) and
on the `settingsAdminPages` entry that links to it (`:82`).

### Fail-closed defaults

- **Route guards**: with zero `routeGuards` registered and protected routes
  present, the router logs an error and falls back to `<Navigate to={loginPath}>`
  (`sdk:framework/src/router/RouterComponent.tsx:101-128`).
- **`permission` with no `permissionGate`**: the SDK router logs a one-time
  warning and renders the route **UNGATED** (`RouterComponent.tsx:29-39`). An app
  using `createRouterModule` must supply `permissionGate` — otherwise every route
  `permission` in the app is decorative.
- **`evaluatePermission(undefined)`** → `false`.

---

## 4. Checklist — adding a gated feature

- [ ] `permissions.rs`: a `PermissionCheck` per action, `module::resource::action`,
      least privilege (`read` for reads).
- [ ] A `*_grant_permissions.sql` migration in the **owning module**; an in-source
      test asserting the constants match it.
- [ ] Every handler takes `RequirePermissions<(…,)>`; every path-ID handler scopes
      its SQL by owner and 404s cross-user.
- [ ] Every `_docs` fn wraps `with_permission::<(…,)>` and still ends with
      `.description(...)`.
- [ ] `just openapi-regen` → the new member appears in the generated
      `Permissions` enum; commit **all five** generated files.
- [ ] Route: `permission: Permissions.X` (+ `requiresAuth` if behind the guards).
- [ ] Slot entry pointing at it: the **same** `Permissions.X`.
- [ ] Store `init` that fetches gated data: `if (!hasPermissionNow(Permissions.X))
      return`, on **both** `sync:<entity>` and `sync:reconnect`, plus the
      `watch(useAuthStore, () => hasPermissionNow(...))` bootstrap-race re-trigger.
- [ ] Module `shouldLoad: (ctx) => ctx.can(Permissions.X)` if the whole module is
      gated — so its code never reaches an unpermitted user.
- [ ] 🧪 Backend: a 401 (unauth) and a 403 (wrong-perm) test per gated endpoint.
- [ ] 🧪 E2E: **both** the permitted and the denied path for every gated surface.

---

## 5. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| `usePermission(A) \|\| usePermission(B)` | conditional-hook crash class — use `{ anyOf: [A, B] }` |
| `hasPermission(...)` where the component should re-render | use `usePermission` / `<Can>`; `hasPermissionNow` does not subscribe |
| Reading permissions in a store `init` with the reactive path | path 4 is a hook — `init` is not a render |
| A slot `permission` with no route `permission` | the URL stays reachable |
| Each filler component checking its own permission | the widget still mounts and still fetches → 403 storm |
| A manual hide-list (`if (name === 'admin') …`) in a menu | derive the menu from slot + permission |
| A permission literal (`'projects::read'`) in `shouldLoad` or a slot entry | use `Permissions.X`; in `shouldLoad` a literal is a hard build error |
| Frontend gating with no backend `Require*` | the endpoint is public |
| `RequirePermissions` on a read endpoint using an `edit` perm | least privilege |
| Refetching on `sync:reconnect` without a permission gate | 403 storm for restricted users on every reconnect |
