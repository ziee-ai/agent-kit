# Development Guide

> The app-agnostic workflow: how a ziee-SDK app is laid out, brought up, changed,
> and gated. App-specific commands, ports and services stay in that app's own
> `CLAUDE.md` — this doc is the **shape** every app follows, not a command list
> for one of them.

---

## 1. Repository shape

```
<app>/
├─ sdk/                # git submodule → ziee-ai/sdk (PINNED)
├─ agent-kit/          # git submodule → ziee-ai/agent-kit (lifecycle + skills + docs)
├─ Cargo.toml          # workspace: src-app/server; `exclude = ["sdk"]` (nested workspace)
├─ package.json        # npm workspaces: sdk/packages/* + src-app/ui
├─ src-app/
│  ├─ docker-compose.yaml   # the shared build-DB cluster
│  ├─ server/               # the app binary crate — modules self-register
│  └─ ui/                   # the app UI on @ziee/framework + @ziee/kit + @ziee/shell
└─ .claude/            # app.config + lifecycle/skills symlinks into agent-kit
```

**Both submodules are PINNED. Bump deliberately, never as a side effect:**
`git -C sdk fetch && git -C sdk checkout <sha> && git add sdk`.

⚠️ **`git add -A` anywhere in a worktree reverts submodule pins** if the
submodule working tree is at a different commit. Stage explicitly on any branch
that is not deliberately bumping a pin.

Two mixed-language boundaries to keep straight: the Rust workspace **excludes**
`sdk/` (it is its own nested workspace), while the npm workspace **includes**
`sdk/packages/*` (so `@ziee/*` resolve to the working tree, not a registry).

---

## 2. Bring-up

```bash
git submodule update --init      # sdk + agent-kit (both pinned)
npm install                      # hoists deps for sdk/packages/* + the UI
cd src-app && docker compose up -d   # the shared build-DB cluster
```

**The build-DB cluster must be up for `cargo check`.** The SDK's auth crate
verifies its sqlx macros against a real migrated schema at *compile* time, and
`build.rs` provisions a **per-worktree** database on that cluster and sets
`DATABASE_URL`. Consequences worth internalizing:

- The composed migration set is exercised at check time — **a bad migration fails
  `cargo check`, not first boot.**
- Every worktree gets its own DB, so parallel worktrees do not collide.
- One cluster is shared by every ziee app on the box; if one is already
  listening, reuse it rather than starting a second.

**Per-machine config is gitignored.** A fresh clone or a new worktree ships only
`config/dev.example.yaml`, and the server hard-refuses to boot on the example's
placeholder `jwt.secret`. Run the phase-1 gate — `bash .claude/lifecycle/preflight.sh` —
which auto-seeds `config/dev.yaml` with a freshly generated secret. By hand:
`cp config/dev.example.yaml config/dev.yaml` and set `jwt.secret` to
`openssl rand -base64 48`.

📐 **Every app on the box picks a distinct port triple** — HTTP, embedded
Postgres, Vite dev — so the apps run side by side. Record the table in the app's
`CLAUDE.md`; it is the first thing another agent needs.

---

## 3. The daily loop

| task | shape |
|---|---|
| run the backend | `CONFIG_FILE=config/dev.yaml cargo run` from `src-app/server` (or the app's `just dev-server`) |
| run the UI | `npm run dev` in `src-app/ui`; `/api` is proxied to the backend port |
| static check | the app's `just check` — the whole Rust workspace **including test crates** + the UI `npm run check` chain |
| regenerate the API contract | the app's `just openapi-regen` — see §4 |
| tests | the four tiers in `TESTING_GUIDE.md` §1 |

`just` recipes are the app's public interface. If a thing is worth running twice,
it is worth a recipe — and the recipe is what CI and other agents will call.

---

## 4. Generated files — regenerate, never hand-edit

One command writes **five** files unconditionally
(`sdk-crates:ziee-framework/src/openapi/mod.rs:51-89`):

```
ui/openapi/openapi.json
ui/src/api-client/types.ts
ui/src/api-client/permissionDescriptions.ts
ui/src/api-client/permissions.ts
ui/src/api-client/apiEndpoints.ts
```

They are **committed**. Regenerate after any handler, DTO, permission or
`SyncEntity` change, and commit all five together.

🔬 The app's `.claude/app.config` `MERGE_GENERATED` key must name **all** of them.
Naming a subset is how a merge silently takes a side on the rest — one app named
two of five for months.

Other generated-and-committed artifacts follow the same rule: `actions.gen.ts`
per store (`npm run gen:store-actions`), the testid registry, `DESIGN_SYSTEM.md`
(from `index.css`), the kit manifest. Each has a paired `--check` gate in
`npm run check`; if you hand-edit one, the gate fails and it is correct to fail.

---

## 5. Worktrees

Feature work happens in **git worktrees**, one per item, so several agents build
in parallel without touching the owner's live rig.

- Each worktree gets its **own build DB** automatically (`build.rs`) and must get
  its **own ports**. Never assume the default port is free.
- Gitignored per-machine files (`config/dev.yaml`, caches) do **not** come along
  with `git worktree add`. Declare them in `.claude/app.config`
  (`MERGE_STAGING_COPY_FILES`) so the merge gate's staging worktree provisions
  them; submodules are checked out automatically.
- A dev server should be provably attributable to a worktree. The SDK's gallery
  **worktree sentinel** vite plugin serves the worktree root at `/__worktree` for
  exactly this — do not remove it; gates use it to prove which tree a dev server
  is serving.
- Read-only means read-only: do not run builds, servers or `git add` inside
  someone else's worktree.

---

## 6. Process: the lifecycle tooling

`.claude/skills/` and `.claude/lifecycle/` are **symlinks into the `agent-kit`
submodule** — the shared, evolving methodology, not app-local copies. Claude Code
loads `CLAUDE.md` + `.claude/` only at the working-dir root, which is why each app
symlinks them in and `@import`s `agent-kit/docs/FRAMEWORK.md`.

| stage | skill | deterministic gate |
|---|---|---|
| plan a whole dependency-connected epic (DAG → leaves-first plans → contract reconciliation → freeze) | `epic-lifecycle` | `epic-check.mjs` |
| build ONE item through 8 phases (plan → audit → tests → decisions → implement → blind audit → fix → gated run) | `feature-lifecycle` | `lifecycle-check.mjs` |
| dispatch + merge a fleet of item builds | `feature-orchestration` | `merge-gate.mjs <branch>` |

All three scripts are **de-ziee-ified**: everything app-specific comes from
`.claude/app.config`, and **an unset key makes that check SKIP**. So adopting the
tooling in a new app is writing that file, not editing the scripts.

A `pre-push` hook (`agent-kit/scripts/install-agent-hooks.sh`) enforces
`lifecycle-check --wip` on lifecycle branches: completed phases must be green, the
phase in progress is exempt.

**Propagation model:** prose floats (a new phase rule breaks nothing), but a new
deterministic **gate** can red an app's in-flight branches — so gates are
semver-pinned per app and bumped deliberately.

---

## 7. Adding things — the short version

**A backend module**: `modules/<name>/` with the flat file set, a
`#[distributed_slice(MODULE_ENTRIES)]` entry with a free `order`, module-owned
migrations, `permissions.rs` + a grant migration, `Require*` on every handler,
`sync_publish` + `emit_async` on every mutation, then regenerate the API contract.
Details: `BACKEND_ARCHITECTURE.md`.

**A frontend module**: `modules/<name>/module.tsx` exporting
`createModule({...})`; **decide CORE vs `shouldLoad` deliberately** (omit
`shouldLoad` only if every visitor needs it on first paint); routes via
`lazyWithPreload`; `stores: []`; slots as plain data; `initialize` only kicks
work. Details: `META_FRAMEWORK_ARCHITECTURE.md` §1.

**A store**: a folder, not a file —
`<name>/{index.ts, state.ts, actions.gen.ts, actions/}` — `registerLazyStore`
exactly once, `npm run gen:store-actions`, subscriptions in `init`. Details:
`META_FRAMEWORK_ARCHITECTURE.md` §2.

**A cross-module surface**: a **slot**, declared by the region's owner, filled
with plain data by the contributor, permission-filtered by the owner. Details:
`META_FRAMEWORK_ARCHITECTURE.md` §5.

---

## 8. Troubleshooting

| symptom | cause |
|---|---|
| `cargo check` fails on a sqlx macro | the build-DB cluster is down, or a new migration is invalid — read the SQL error, it is real |
| server refuses to boot on `jwt.secret` | `config/dev.yaml` is missing or still on the example placeholder → run `preflight.sh` |
| every route registered twice | a hand-rolled `onModuleRegister` fan-out in the loader — `registerModule` already fans out both directions |
| a store's `init` runs twice / doubled refetches | the store is registered twice: `registerLazyStore` **and** listed in a `module.tsx` `stores: [...]` |
| `Invalid hook call` from a handler | a plain state read outside render — use `X.$.field` |
| a slot surface vanishes on some pages | the filling module is not eligible there; a module filling a globally rendered slot must be eligible **site-wide** |
| a deep link redirects to `/` | route-driven module loading is missing (the SDK router has no `RouteModuleLoader`) |
| kit components render unstyled | Tailwind's `@source` list is missing the workspace-linked `@ziee/*` package trees |
| the dark/light flash on first paint | the pre-hydration script in `index.html` and the theme store's default disagree — they read the same persisted key and must be kept in sync |
