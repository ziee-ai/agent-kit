# Backend Architecture

> Rust/axum server on the ziee SDK crates. `sdk-crates:` = `sdk/crates/…` (the
> pinned SDK submodule); `ziee:` = the reference app (`ziee/src-app/server/…`),
> the provenance anchor for conventions the crates cannot express.
>
> Enforcement tags follow `CODING_GUIDELINES.md`: 🔧 lint · 🧪 test · 🔬 ci ·
> 🏛 type · 📐 convention. §1–§5 of that file (authz, SSRF, secrets, DB
> correctness, resource lifecycle) are the binding rule set; this doc is the
> *shape* those rules live in.

---

## 1. Module system — link-time self-registration

There is **no central module list to edit**. A module registers itself into a
`linkme` distributed slice defined in the framework crate
(`sdk-crates:ziee-framework/src/module_api.rs`):

```rust
#[distributed_slice(MODULE_ENTRIES)]
static PROJECT_MODULE_REGISTRATION: ModuleEntry = ModuleEntry {
    name: "project",
    order: 47,                 // init order; see below
    description: "…",
    constructor: || Box::new(ProjectModule::new()),
};
```

`AppModule` (the trait every module implements) has exactly four members:

| member | required | purpose |
|---|---|---|
| `name()` | ✔ | unique module id |
| `init(&mut self, ctx: &ModuleContext)` | ✔ | take the pool, read config, spawn background tasks |
| `register_routes(&self, router: ApiRouter) -> ApiRouter` | ✔ | `router.merge(routes::x_router())` |
| `register_event_handlers()` | default `vec![]` | `Vec<Arc<dyn EventHandler>>` |
| `version()` / `description()` | defaults | metadata |

`ModuleContext` carries `db_pool`, the app-agnostic `ServerConfig`, and
`app_config: Arc<dyn Any + Send + Sync>` — the app's monolithic config,
type-erased. A module needing a domain sub-config **downcasts** it through one
app-side helper (`ziee:src/module_api/mod.rs:19-25`), so the framework's context
names no app type.

🔬 **`order` is the init sequence and it is sorted by `(order, name)`** —
`sdk-crates:ziee-framework/src/app_builder.rs:26-50`. The name tiebreak is load
bearing: a distributed slice's element order comes from the linker, so without it
two modules sharing an `order` could silently swap between builds, changing the
emitted `openapi.json` path order (a committed generated file) and any init
dependency. Pick a free `order` and record why in a comment.

**No unload path** — modules are constructed once at boot.

---

## 2. Canonical module layout

🔬 A module is a **flat directory** of well-known files. Deviating hides code from
reviewers who know where to look.

```
modules/<name>/
  mod.rs           # the ModuleEntry + AppModule impl. Nothing else.
  routes.rs        # ApiRouter assembly, api_route + *_with only
  handlers.rs      # extractors + orchestration + the *_docs fns  (≤ 800 lines)
  models.rs        # DB row types
  types.rs         # request/response DTOs (JsonSchema)
  repository.rs    # ALL business SQL
  permissions.rs   # the PermissionCheck constants
  events.rs        # this module's typed AppEvent variants
  migrations/      # module-owned .sql (see §6)
```

- 🔧 **All business SQL lives in `repository.rs`.** No inline `sqlx::query` in a
  handler.
- 🔬 **Handlers ≤ 800 lines**; split into a `handlers/` directory of submodules
  past that (`ziee:src/modules/user/handlers/`). Extractors do extraction +
  authorization only — no business logic.
- 🔬 **The module graph is a DAG.** A hub/aggregator module never imports a
  feature module's types. Shared infra goes to `common/` / `core/`.
- 📐 **Inversion over import.** When module A needs to contribute to module B's
  surface, B publishes an extension slice and A registers into it — B never
  imports A. `ziee:src/modules/project/routes.rs:32-45` documents three such
  inversions (project↔file, project↔chat, project↔mcp) where the routes moved to
  the *contributing* module.

Repository access is through the generated `Repos` accessor —
`ziee_framework::declare_repositories! { project: ProjectRepository => crate::modules::project, … }`
expands the factory, the `Deref` wrappers and `Repos` **in the invoking crate**
(`sdk-crates:ziee-framework/src/repository.rs:1-33`), so handlers just write
`Repos.project.create(...)`.

---

## 3. Routes + OpenAPI (aide)

🔧 Every route is registered with `api_route` + a `*_with` method so it enters the
spec, and every handler has a paired `_docs` function:

```rust
ApiRouter::new()
    .api_route("/projects", post_with(create_project, create_project_docs))
    .api_route("/projects/{id}", get_with(get_project, get_project_docs))
```

```rust
#[debug_handler]                                    // 🔧 required for aide codegen
pub async fn create_project(
    auth: RequirePermissions<(ProjectsCreate,)>,    // 🔬 authz IS the signature
    Extension(event_bus): Extension<Arc<EventBus>>,
    origin: SyncOrigin,
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<Json<Project>> {
    validate_project_name(&request.name)?;
    let project = Repos.project.create(auth.user.id, request).await?;
    event_bus.emit_async(ProjectEvent::created(project.id, auth.user.id));
    sync_publish(SyncEntity::Project, SyncAction::Create, project.id,
                 Audience::owner(auth.user.id), origin.0);
    Ok((StatusCode::CREATED, Json(project)))
}

pub fn create_project_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsCreate,)>(op)        // documents the required perm
        .id("Project.create").tag("Projects")
        .summary("…")
        .description("…\nError codes (in `error_code`):\n- `VALIDATION_ERROR` (400) …")
        .response::<201, Json<Project>>()
        .response_with::<400, (), _>(|res| res.description("Invalid request"))
}
```
*(`ziee:src/modules/project/{routes.rs:10-31,handlers.rs:252-304}`)*

🔧 The `_docs` fn **must** end with a `.description(...)` and document the non-2xx
responses. `.id("Module.method")` is what names the generated TS client method.

**Generated + committed artifacts** — regenerate, never hand-edit. The generator
does **five unconditional `fs::write`s**
(`sdk-crates:ziee-framework/src/openapi/mod.rs:51-89`) from one regen command
(`just openapi-regen` in both reference apps): `ui/openapi/openapi.json` and
`ui/src/api-client/{types,permissionDescriptions,permissions,apiEndpoints}.ts`.
The exact set for your app is `MERGE_GENERATED` in `.claude/app.config`; naming
only a subset there is how a merge silently takes a side on the rest.

🔬 After any handler/type change, regenerate and verify: nullable Rust fields
appear as `| null`; every `#[derive(JsonSchema)]` field has a TS property;
numeric Rust types map to TS `number` (never `string`).

🔧 `DELETE` handlers return `ApiResult<()>` (→ 204), never a `(StatusCode, Json)`
tuple. Tri-state fields use `Option<Option<T>>` + `#[serde(default,
deserialize_with = "deserialize_nullable_field")]`.

---

## 4. Errors

`ApiResult<T> = Result<(StatusCode, T), (StatusCode, AppError)>`
(`sdk-crates:ziee-core/src/error.rs:27`). Constructors:
`AppError::not_found(resource)` (`:87`), `AppError::forbidden(code, msg)`
(`:115`), `AppError::internal_error(msg)` (`:119`).

- 🔧 Never `unwrap()`/`expect()` on a runtime value (DB / FS / env / HTTP).
- 🔧 Never silently swallow (`let _ =`, `.ok()`, `unwrap_or_default()` on a real
  failure). **A DB error is not a 404** — distinguish "no row" from "query
  failed".
- 🔧 Preserve context in `map_err` (`format!("{desc}: {e}")`); never collapse to a
  bare `StatusCode`.
- 🔧 Missing resource → `404`, never `200 {status:"not_found"}`.
- 🔧 `tracing`, never `println!`/`eprintln!`, in a handler.

---

## 5. Permissions (backend half)

Full ladder in `PERMISSION_GATING.md`. The backend shape:

```rust
pub struct ProjectsRead;
impl PermissionCheck for ProjectsRead {
    const NAME:        &'static str = "ProjectsRead";
    const PERMISSION:  &'static str = "projects::read";   // module::action
    const DESCRIPTION: &'static str = "Read chat projects";
    const MODULE:      &'static str = "project";
}
```

🔬 **Authorization is the handler signature.** `RequirePermissions<(A, B)>` is
AND across the tuple; it authenticates via the injected `IdentityResolver`,
**short-circuits on `user.is_admin`**, then checks the UNION of the user's direct
permissions and every ACTIVE group's permissions, returning 403 with the missing
names (`sdk-crates:ziee-framework/src/permissions/extractors.rs:73-129`).
`RequireAdmin` is root-admin-only.

🔧 Never hand-roll a JWT check. 🔬 An `.api_route` whose handler takes no
`Require*` parameter is an unauthenticated endpoint — a PR-diff-level defect.

🧪 Every path-ID handler **verifies ownership in the SQL** (`WHERE user_id = $auth`),
and a cross-user id yields **404**, not the row — with a cross-user-404 test.

---

## 6. Database & migrations

**Migrations are module-owned**: `modules/<module>/migrations/*.sql` (SDK crates
own theirs under `sdk/crates/<crate>/migrations/`). `build.rs` globs the union,
copies every `.sql` into a generated `migrations-merged/` (basename-collision
guarded, gitignored), and both the build-DB provisioner and the runtime
`sqlx::migrate!("./migrations-merged")` apply that version-sorted set.

Naming: `<YYYYMMDDNNNN>_<module>_<desc>.sql` where `NNNN` is a **monotonic
counter**, not wall-clock seconds, assigned to preserve **FK-topological order**.
The reference banding: `0001` framework bootstrap · `0050` auth schema · `0100+`
per-module tables (no inline FKs) · `4000+` deferred FK ALTERs · `4500/5000+` seed
data · `6000+` permission grants.
*(`ziee:src/modules/MIGRATIONS.md`)*

Ownership rules:
1. 🔬 **One owner per table.** Others reference it by FK; join tables belong to
   their parent module.
2. 🔬 **No domain data in the SDK/auth crate.** The auth seed creates system
   groups with a CLEAN base (`Administrators=['*']`,
   `Users=['profile::read','profile::edit']`); every domain permission grant lives
   in the owning module's own `*_grant_permissions.sql`. 🧪 Assert the
   `PermissionCheck::PERMISSION` strings match that grant migration in an
   in-source test (`ziee:src/modules/project/permissions.rs:42-50`).
3. 🔬 **FKs are deferred** to a post-schema band, so cross-module order is free.
4. 🔧 **An APPLIED migration file is immutable, comments included** (sqlx
   checksums the full bytes). Change schema only by adding a new migration.

🔧 The build DB is real: `build.rs` provisions + migrates a per-worktree database
on the shared build cluster and sets `DATABASE_URL`, so `sqlx::query!` /
`query_as!` macros verify against the composed schema — **a bad migration fails
`cargo check`, not first boot.**

DB rules that recur (from `CODING_GUIDELINES.md` §4): bounded deletes and
paginated selects clamped to a max; multi-step writes in one transaction; no
SELECT-then-INSERT (use `ON CONFLICT` or `FOR UPDATE`) plus a partial UNIQUE
index on any pair the code assumes distinct; no N+1 / in-memory filtering;
index every WHERE/FK column.

---

## 7. Events + realtime sync

Two distinct buses, easy to conflate:

| | backend `EventBus` | frontend `EventBus` |
|---|---|---|
| API | `emit_async(AppEvent)` | `emit(event)` / `on(...)` |
| purpose | in-process server-side reactions (`EventHandler` impls) | client-side decoupling |

The `EventHandler` **trait** lives in the framework crate and takes the event
type-erased as `&(dyn Any + Send + Sync)`, so the framework stays domain-free;
handlers `downcast_ref::<AppEvent>()`
(`sdk-crates:ziee-framework/src/events.rs:16-42`). The concrete `AppEvent` enum
and the dispatcher are app-side.

🔬 **Every successful mutation does BOTH**: `event_bus.emit_async(...)` **and**
`sync_publish(entity, action, id, audience, origin.0)` after the DB write. A
module that mutates has an `events.rs` with a typed event.

Sync is **notify-and-refetch**: the SSE stream carries `{entity, action, id}`
only; the client refetches through the permission-checked REST endpoint
(`ziee:src/modules/sync/mod.rs:1-9`). Pick the `Audience` at the call site
(owner-scoped by default) — **the permission the audience implies must equal the
read-perm of the endpoint the client will refetch from.** 🏛 A new cross-device
entity adds its `SyncEntity` variant **first**; the `sync:<entity>` TS event key
then derives automatically on the next OpenAPI regen. 🔧 Detached background tasks
publish with `origin: None`.

---

## 8. Deploy kill-switches

🔬 Every side-effecting or route-adding module gets an `Option<XxxConfig>`
deploy-level kill-switch, and **the `enabled` guard must appear in
`register_routes()` too**, before the `.merge()`:

```rust
fn register_routes(&self, router: ApiRouter) -> ApiRouter {
    // Deploy kill switch also guards route registration: when disabled the
    // surface is never mounted, so a permitted user cannot reach it.
    // Without this the config toggle would be bypassable.
    if !self.enabled { return router; }
    router.merge(routes::voice_router())
}
```
*(`ziee:src/modules/voice/mod.rs:126-135`)*

Gating only `init()` leaves the routes mounted — the toggle becomes decorative.

---

## 9. Auth is turnkey — do not hand-write it

Identity, sessions, OAuth providers, refresh tokens and the `users`/`groups`
schema belong to the SDK's auth crate and its migrations. An app mounts the
turnkey auth module and injects an `IdentityResolver`; it does **not** write
login handlers, token verification, or a users table. Cross-device auth sync is
wired by supplying an `AuthSyncSink` once the app has a sync module — an app that
declares it inert should say so at the injection site, so the gap is visible.
