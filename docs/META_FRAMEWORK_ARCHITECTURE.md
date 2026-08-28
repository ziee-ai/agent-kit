# UI Meta-Framework Architecture

> **Anchors.** Every rule here is quoted from real code. `sdk:` = the pinned SDK
> submodule in your app (`sdk/packages/…`); `ziee:` = the reference consumer app
> (`ziee/src-app/ui/…`), which is NOT in your checkout — it is the provenance
> anchor for consumer conventions the SDK cannot express.
>
> **The rule of authority: the SDK supplies the mechanism; ziee is the reference
> consumer for how to USE it; an older fork (cytoanalyst, or a scaffold copied
> from one) is a snapshot, not a standard.** When they disagree, ziee wins.

The app is: `main.tsx` → `App.tsx` (`loadModules()` + `<AppShell>`) → modules
register routes/slots/stores → the router renders. **No app logic lives in the
root.** Everything else is a module.

---

## 1. Module system

### 1.1 `createModule` is a shape adapter, nothing more

`sdk:framework/src/module.ts:11-46`. Fields: `metadata`, `stores?`,
`components?`, `dependencies?` (module **names**, topo-ordered), `slots?`,
`shouldLoad?`, `onModuleRegister?`, `initialize?`, `cleanup?`. `routes` is NOT in
the base interface — apps declaration-merge it on; `createModule` spreads all
fields (`module.ts:32`) so a merged field survives.

`cleanup` is typed but **nothing in the framework calls it. There is no unload
path** — modules are load-once, forever.

### 1.2 Discovery is a BUILD-TIME MANIFEST + waves, not an eager glob

This is the single most-inherited stale shape. **Do not write
`import.meta.glob('./**/module.tsx', { eager: true })`** — that puts every module
body in the entry chunk.

A build plugin (`ziee:plugins/vite-plugin-module-manifest.js`, **app-local, not
shipped by the SDK**) statically extracts the cheap decision layer
`{ name, shouldLoad, routePaths, dependencies, load }` from each `module.tsx`
without evaluating its imports, and emits a virtual manifest; `load()` is a
dynamic import of the heavy body. The **runtime half ships in the SDK**:
`sdk:framework/src/module-system/manifest.ts` (`isEligible`, `coreEntries`,
`orderByDependencies`, `entryForPath`) + `ModuleLoadContext`
(`module-system/types.ts:62-78`: `isAuthenticated`, `needsSetup`, `path`,
`permissions`, `platform`, `can(...perms)`).

Three selection paths (`ziee:src/modules/loader.ts`):

| wave | trigger | what runs |
|---|---|---|
| **boot** | `loadModules()` from `App.tsx` | CORE modules (no `shouldLoad`) + any already-eligible. `initializeModules()` runs **once**, here (`loader.ts:89-93`) |
| **reactive** | `useAuthStore.subscribe` / `useAppStore.subscribe` on login, permission grant, setup done | `registerModule` + each NEW module's `initialize()` only — **never** a second `initializeModules()`, which rebuilds slots from scratch (`loader.ts:94-101`) |
| **route-driven** | `ensureModuleForPath(pathname)` for a deep link | loads the owning module — **only if `isEligible`**, so a user without a permission never receives that module's code (`loader.ts:141-152`) |

`shouldLoad` is **authoring-time and statically lifted**, so its body may
reference only `ctx` and the whitelisted `Permissions` enum
(`sdk:…/module-system/types.ts:54-60`); any other free identifier is a hard build
error. Gate with `ctx.can(Permissions.X)`, **never a literal string**.

Proportion in ziee today (verified): **13 of 54 `module.tsx` files have no
`shouldLoad`** — 7 top-level core modules (`agent`, `app`, `auth`, `background`,
`config-client`, `layouts/app-layout`, `router`) plus 6 file-viewer sub-modules.
Everything else is gated. **Omit `shouldLoad` only if the module is needed on the
first paint for every visitor.**

`App.tsx` must pass the promise: `<AppShell authStore={useAuthStore}
modulesReady={loadModules()} />` — AppShell gates first paint on it
(`sdk:shell/src/bootstrap/AppShell.tsx:52-60,75-92`). Calling `loadModules()` for
effect without `modulesReady` renders the shell before the router exists.

### 1.3 Registration fans out BOTH directions — do not repeat it

`registerModule` (`sdk:…/module-system/store.ts:75-252`) merges stores (reusing
an already self-registered proxy, `:177-198`), appends components by `order`,
merges slots (`:216-231`), then calls `onModuleRegister` on every existing module
**and** the new module's hook for every existing module (`:233-243`).

> "registerModule fans out onModuleRegister to already-registered modules (router
> collects routes, sidebar collects slots) — do NOT hand-roll a second fan-out
> loop (that double-registers routes)." — `ziee:src/modules/loader.ts:81-84`

A second loop in the loader is a **live duplicate-route bug**: the SDK's
`addRoutes` (`sdk:framework/src/router/routes-store.ts:31-39`) appends without
dedup. ziee's app-local routes store dedupes by `path + layout`
(`ziee:src/modules/router/stores/routes-store.ts:12-28`) precisely for this.

### 1.4 What keeps a module cheap

`module.tsx` rides the module's own chunk and is evaluated the instant the module
is selected — **everything it imports at top level is paid immediately.**

- Page components go behind `lazyWithPreload(() => import('./Page'))` — an
  **app-local util** (`ziee:src/utils/lazyWithPreload.ts:22`), not an SDK export.
- **`stores: []` is the normal state.** A `registerLazyStore`d store self-registers
  on import; listing it builds nothing new and re-adds an eager import.
- `initialize` *kicks* work (one call); it never does the work inline.
- Slot fillers are component **references**, never rendered trees.

### 1.5 Anti-patterns

| Anti-pattern | Do instead |
|---|---|
| `import.meta.glob('./**/module.tsx', { eager: true })` | build-lifted manifest + lazy `load()` per module |
| Hand-rolled `onModuleRegister` loop after `registerModule` | let `registerModule` fan out |
| Re-running `initializeModules()` on a later wave | call only the new modules' `initialize()` |
| A literal permission string in `shouldLoad` | `ctx.can(Permissions.X)` (build-enforced) |
| Direct `import Page from './Page'` in `module.tsx` | `lazyWithPreload(() => import('./Page'))` |
| `loadModules()` without `modulesReady` | pass the promise to `<AppShell>` |

---

## 2. Store system (store-kit)

### 2.1 `defineStore` config surface

`sdk:framework/src/store-kit.ts:327-361` (explicit) / `:488-510` (glob forms).

| key | meaning |
|---|---|
| `state` | the eager data object. **Always present** — `X.field` is never `undefined` |
| `actions` | `(set, get) => ({…})` (eager inline) **or** `import.meta.glob('./actions/*.ts')` (lazy folder) **or** the same glob `{ eager: true }` |
| `immer` | `true` → draft setters. Default `false` → shallow merge |
| `persist` | zustand `PersistOptions`; `partialize` sees **State only** |
| `init` | once on first ACCESS (not registration). Gets `{ set, get, actions, on, watch, onCleanup }` (`store-kit.ts:52-72`) |

Middleware order is fixed: `subscribeWithSelector(persist?(immer?(builder)))`
(`store-kit.ts:470-484`) — `subscribeWithSelector` outermost so the 3-arg
`subscribe(selector, cb, opts)` overload survives.

`init`'s toolkit: `on(event, handler)` (EventBus, auto-grouped by store name,
auto-cleaned), `watch(store, selector, cb)` (cross-store reaction,
`fireImmediately` by default, auto-cleaned), `onCleanup(fn)` (imperative
resources: `AbortController`, timers, `window` listeners). `__destroy__` runs all
cleanups then `removeGroupListeners(storeName)` (`store-kit.ts:456-465`).

### 2.2 Lazy actions + folder-per-store (the thing that keeps the app light)

Most of a store's WEIGHT is its actions. Each action gets its own file → its own
chunk, downloaded on first call. State stays eager; only action *code* defers.

```
<storeName>/
  index.ts        # defineStore + registerLazyStore (+ seam injection)
  state.ts        # state object + <Name>State / <Name>Set / <Name>Get aliases
  actions.gen.ts  # GENERATED name→factory type map — never hand-edited
  actions/
    doThing.ts    # export default (set: XSet, get: XGet) => async (...) => {…}
    _shared.ts    # `_`-prefixed = internal helper, NOT registered (store-kit.ts:199,214)
```

The action's runtime name is the **file basename** (`store-kit.ts:208-217`); its
TYPE comes from `actions.gen.ts` passed as the `AM` generic, because
`import.meta.glob` is untyped.

**The generator is SDK-provided**: `sdk:config/src/lint/store-actions.mjs`. Wire
it as `gen:store-actions` / `check:store-actions` and put the check inside
`npm run check`. It enforces the folder shape, **forbids** a hand-written
`lazyActions:` map or an inline `actions: {` in `index.ts`, and generates
`actions.gen.ts`.

- **Eager variant** (`{ eager: true }`): only for a store exposing a
  *synchronous* selector read in render (`getFoo(): string`) — signatures are
  preserved verbatim, no Promise wrapping (`store-kit.ts:153-177`).
- **A single `*.store.ts` file is still correct** for a boot-critical store that
  is eagerly imported anyway (ziee keeps 10 such against 124 folder stores; its
  `Auth.store.ts` is one, ~940 lines with an inline `actions:` factory). **Size
  alone is not the defect** — deferrability is.
- **Prefetch is baked in.** `init` warms every lazy-action chunk after
  `onNetworkIdle` then a `requestIdleCallback` gap (`store-kit.ts:274-325`).
  You almost never call `.preload()`.

### 2.3 `registerLazyStore` — register exactly ONCE

```ts
export const Users = registerLazyStore(defineStore('Users', { … }))
export const useUsersStore = UsersDef.store
```

It builds the lifecycle proxy **once** and self-registers it by name
(`sdk:framework/src/stores.ts:344-366`). The registry then treats the name as
**self-owned** and must never destroy or replace it (`module-system/store.ts:30-39`).

Two proxies over one zustand store = two `init` runs, two ref counts, two of
every `sync:<entity>` subscription, two refetches per remote change. Listing a
`registerLazyStore`d store in a `module.tsx` `stores: [...]` array is how that
happens.

### 2.4 The four proxy access paths — and the ONE removed API

`sdk:framework/src/stores.ts:49-88` + `:228-306`. The path is decided by **what
the property IS**, not where you read it:

| # | property kind | behavior | where legal |
|---|---|---|---|
| 1 | specials `$`, `__setState`, `__refCount`, `__refTracker`, `__destroyed` | synchronous, hook-free | anywhere |
| 2 | **functions (actions)** | resolved from `getState()`, hook-free | **anywhere** — render, handlers, async, module scope |
| 3 | nested store proxies | returned directly | anywhere |
| 4 | plain state values | `useEffect` (ref-count) + `useStore(useShallow(...))` — **reactive, RENDER-ONLY** | inside a component / `use*` hook |

```ts
X.doThing(args)      // path 2 — anywhere, no ceremony, never X.$.doThing()
const { a } = X      // path 4 — render only; re-renders on change
X.$.a                // path 1 — the ONLY hook-free state read (handlers/async/init)
```

> **REMOVED APIs. Do not write these; they do not exist.**
> - **The global `Stores.X` proxy** — removed. Import the handle directly
>   (`stores.ts:337-342`). Rationale at `sdk:framework/src/app-seam.ts:9-14`: the
>   global forced every store to register eagerly, an O(all-stores) boot cost.
>   SDK/shell code that must read an app store uses a typed **seam** instead
>   (`createAppStoreSeam`, `configClientSeam`, `appLayoutSeam`, `routesSeam`,
>   `setAuthView`).
> - **`.__state`** — removed, **not renamed**. Use `X.$.field`
>   (`stores.ts:84-85`, `:233-234`; `store-kit.ts:641`). Reading a plain state
>   value outside render throws React's *Invalid hook call* — asserted in
>   `sdk:framework/src/stores.test.ts:44-53` (TEST-4/TEST-10).

`peek()` is a different thing and belongs to the **seam** layer:
`createAppStoreSeam` returns `{ set, get, peek }` (`app-seam.ts:16-42`) — `get()`
throws when the app never injected the store (boot-critical, loud); `peek()`
returns `null` for shell chrome that legitimately renders store-less.

**Ref-counting.** Every path-4 read adds a ref on mount, removes on unmount; at
zero a destroy is **scheduled 5 s out** (`DEFAULT_DESTROY_DELAY_MS`,
`stores.ts:12`, `:139-164`); any access cancels it; a destroyed store resets and
re-initializes on next access.

---

## 3. Event bus

`sdk:framework/src/events/store.ts` — a zustand store, not a class
(`:13-44`):

- `on(eventType, handler, groupName?)` → `Unsubscribe`. A `groupName` gives
  per-group dedup: a second `on` for the same `group::event` **replaces** the
  first (`:53-83`).
- `emit(event)` → `Promise<void>`. Stamps `timestamp`, fans out, and **isolates
  each handler** — a throw or rejection is logged and swallowed, so a listener
  bug cannot reject the mutation that emitted (`:85-121`). **`emit()` never
  rejects; surface errors inside the handler.**
- `off`, `removeGroupListeners(group)`, `clear`, `getHandlerCount`.

There is **no `emit_async` on the client** — that is the Rust bus. The handle is
`EventBus` from `@ziee/framework/stores` (`stores.ts:397`), a lazily-built proxy
because `stores.ts` and `module-system` form an import cycle (`stores.ts:371-395`).

Typing is declaration-merge onto `AppEvents` (`events/types.ts:26-31`); **every
member must carry both `type` and `data`** — a member missing `data` drops it
from the union's common keys and breaks `emit` typing for *all* events.

**Subscriptions belong in the store's `init` via `on(...)`** — never a component
`useEffect`, never module scope. `on` auto-groups and auto-tears-down.

---

## 4. Realtime sync rides the bus

`sdk:framework/src/sync/SyncClient.ts:15-21` — opens `GET /api/sync/subscribe`
and re-emits each `{entity, action, id}` frame as a per-entity `sync:<entity>`
event.

- **Notify-and-refetch, never data on the wire.** Payload is `{ action, id }`
  (`SyncClient.ts:223-226`); the subscriber refetches via its own
  permission-checked endpoint.
- **Per-entity keys**, so a handler never runs for other entities.
- **The key space is DERIVED, not hand-listed** — a key-remapped mapped type over
  the generated `SyncEntity` union in `@/api-client/types`. Never hand-add a key;
  add the Rust `SyncEntity` variant and regenerate.
- **`sync:reconnect`** fires on genuine RE-connects only, debounced to once per
  5 s (`SyncClient.ts:26-31`, `:183-199`).
- **Self-echo suppression**: the connect stores the server's `connection_id`, the
  api-client stamps `X-Sync-Connection-Id` on mutations, the server skips the
  originating tab. (A same-tab sibling surface therefore needs a deliberate local
  echo if it must refresh.)
- Lifecycle is auth-driven by **user id**, not an `isAuthenticated` boolean, so a
  user switch re-opens the stream (`sync/index.ts:28-42`); `AppShell` calls
  `initSync` (`AppShell.tsx:93-95`).

Every sync handler **self-gates** (no-403-on-reconnect), and subscribes to BOTH
keys:

```ts
init: ({ on, actions, watch }) => {
  const reload = () => {
    if (!hasPermissionNow(Permissions.XRead)) return
    void actions.load()
  }
  on('sync:x', reload)
  on('sync:reconnect', reload)
  // bootstrap race: init may run before /auth/me populates permissions
  watch(useAuthStore, () => hasPermissionNow(Permissions.XRead),
        (now, prev) => { if (now && !prev) void actions.load() })
  void actions.load()
}
```

Because `init` fires on **first proxy access**, an untouched store has no `sync:`
subscription and does not refetch. That is intended — and it is why the
single-proxy invariant (§2.3) matters.

---

## 5. Slot system — the extensibility motto

**MOTTO: everything that can be a slot SHOULD be a slot.** Any surface another
module might extend — nav, menus, page sections, detail tabs, toolbars, banners
— is a slot, not a cross-module import.

### 5.1 Four different mechanisms, easily confused

| mechanism | where | use for |
|---|---|---|
| **module `Slots`** | `sdk:framework/src/module-system/types.ts:34` — declaration-merged `interface Slots`, each key an array of plain data entries | **cross-module UI regions.** This is what the motto is about |
| `createSlotRegistry` / `createExtensionSlot` | `sdk:framework/src/slots.tsx:78,179` — imperative `register(owner, …)` / `renderSlot()` / `unregister(owner)` / `isEnabled` | a sub-registry INSIDE one module whose members toggle at runtime (per-row menus, per-batch actions). **Not** the module slot system despite the name |
| `PanelRendererMap` | app-side: declaration-merged key→props map + `registerPanelRenderer` | **serializable/rehydratable** surfaces: the record stores `{type, data}`, the component resolves by key |
| `UIOverrides` / `<Seam>` | `sdk:framework/src/overrides/{types.ts:24,Override.ts:32}` | replacing ONE element of a core component for a platform build, without forking it |

Plus `ComponentRegistration` (`createModule({ components })`) — app-root mounts
rendered by `AppShell`, sorted by `order`; the router registers at `order: 0`.

### 5.2 The contract — get the direction right

**The CONSUMER (the layout/page that RENDERS the region) declares the key. The
OWNER filters by permission before mount. A filler only imports the type file.**

```ts
// OWNER: modules/settings/types/SettingsSlots.ts
export interface SettingsPageSlot {
  id: string; icon: ReactNode; label: string; path: string
  order: number; permission?: PermissionExpr
}
declare module '@ziee/framework/module-system/types' {
  interface Slots { settingsUserPages: SettingsPageSlot[]; settingsAdminPages: SettingsPageSlot[] }
}
export {}
```

```tsx
// FILLER: modules/auth/module.tsx — side-effect import activates the merge
import '@/modules/settings/types/SettingsSlots'
…
slots: {
  routeGuards: [{ id: 'auth-guard', component: AuthGuard }],
  settingsAdminPages: [{ id: 'sessions', icon: <TimerReset/>, label: 'Sessions',
                         path: 'sessions', order: 29,
                         permission: Permissions.SessionSettingsRead }],
}
```

Note the inversion: auth imports nothing from `settings/` but the type file, and
the **router never imports `AuthGuard`** — auth pushes the guard into the
router-owned `routeGuards` slot.

**Entry shapes**: nav-shaped (`{id, icon, label, path, order, permission?}`) or
component-shaped (`{id, order, component, permission?}`). `component` accepts
**all four** framework forms — `ComponentType | ReactElement |
LazyExoticComponent | (() => Promise<{default}>)`
(`sdk:shell/src/layouts/appLayoutSlots.ts:68-87`) — on purpose, so a filler can
hand over a bare dynamic import instead of importing eagerly. Typing a slot's
`component` as `ComponentType` only forces every filler to eagerly import its
component in `module.tsx`, which is exactly what makes modules expensive.

### 5.3 What the registry does NOT do

`registerModule` **appends** to the per-key array in a NEW Map
(`module-system/store.ts:216-224`); `initializeModules()` rebuilds the map from
scratch once, after the boot wave (`:292-317`).

It does **not** sort, permission-filter, dedupe by `id`, validate the shape, or
offer an unregister path. **All of that is the owner's job.** There is no
`useSlot()` hook — the API is `ModuleSystem.slots.get(key)`.

**The owner sorts (`order` ascending, absent = 0) and permission-filters with
`evaluatePermission` BEFORE mounting** — so an unpermitted widget never mounts
and never fires its on-mount fetch (no 403 storm on boot). A filler that renders
*mixed* content self-gates internally with `<Can>` instead of declaring a
slot-level `permission`. Factor this into one `useSlotEntries(key)` reader rather
than repeating an `isAllowed` closure per owner.

Keep the **unfiltered** list available too, so a page can tell "section doesn't
exist" from "section exists but you're forbidden" on a deep link.

### 5.4 Late waves DO re-render the region

Most fillers arrive in a later smart-load wave, after the owning layout painted.
The chain: `registerModule` puts a **new array** in a **new Map** → the owner
reads `const { slots } = ModuleSystem` (path 4, `useStore(useShallow(...))`) →
zustand's `shallow` special-cases Maps by comparing each key with `Object.is` →
new array ⇒ re-render. A module registering **no** slots produces identical
entries ⇒ no spurious re-render. But the subscription is on the whole Map, so
**any** registration re-renders **every** slot owner: keep expensive uncached
work out of a slot owner's render body.

### 5.5 Mount component entries through `LazyComponentRenderer`

`sdk:shell/src/components/LazyComponentRenderer.tsx` accepts all four `component`
forms, caches the `React.lazy` type by loader identity (`:27,37-44` — creating it
inside a render silently remounts the subtree on every parent re-render), and
supplies the `Suspense` boundary (`:122-124`). **`createElement(entry.component)`
loses lazy support and the Suspense boundary in one move.** (`WidgetRenderer` is
deprecated, `:129-133`.)

### 5.6 Slot rules + anti-patterns

1. Consumer owns the type; fillers import it for the merge only.
2. One `types.ts` per owner, merged onto
   `'@ziee/framework/module-system/types'`, ending `export {}`.
3. Entries are plain data + a component reference. Never a rendered element built
   at module scope; never a closure over another module's store.
4. Stable `id` (`<module>-<thing>`) + numeric `order` on every entry.
5. Owner sorts + permission-filters; cap-by-`slice(n)` happens **after** filtering.
6. A gated slot entry that links to a route sets `permission` in **both** places —
   the slot filter only hides the entry point; the route gate protects the URL.
7. Empty slot ⇒ render **nothing** (no wrapper, no reserved gap).
8. Need something the entry shape can't express? **Grow the shape** (a scoped
   re-reconciliation with the owner) — never import across modules.

| Anti-pattern | Do instead |
|---|---|
| Filler declares the key it fills | owner declares |
| Each filler checks its own permission | owner filters the slot |
| Slot `permission` with no route `permission` | set both |
| `createElement(entry.component)` | `<LazyComponentRenderer component={…}/>` |
| `component: <Widget/>` (an element) | a component ref or `() => import()` |
| Owner hardcodes a fallback when the slot is empty | empty renders nothing; a required item is a core entry the owner registers itself |
| `createSlotRegistry` for a cross-module region | that's the intra-module registry — use `Slots` |
| A manual hide-list / `if (moduleName === …)` in a menu | derive from slot + permission |

---

## 6. Router integration

**There are TWO routers.** ziee's is **app-local**
(`ziee:src/modules/router/{module.tsx,types.ts,components/RouterComponent.tsx,stores/routes-store.ts}`)
and is where every router feature was invented. The SDK's
`@ziee/framework/router` is a **domain-agnostic port** of it
(`sdk:framework/src/router/types.ts:8-15`). **ziee does not use
`createRouterModule`.** A new app may — knowing the port is behind on four
things (§6.4).

### 6.1 App-side knobs

`createRouterModule(options)` (`sdk:framework/src/router/module.tsx:28-63`) takes
exactly four: `loginPath`, `homePath`, `fallback`, `permissionGate`
(`router/config.ts:19-32`). `RouteConfig.permission` is `unknown` on purpose
(`router/types.ts:52-59`) and is narrowed by the app's injected gate; **if no gate
is registered the route renders UNGATED** with a one-time console warning
(`RouterComponent.tsx:29-39`). ziee types it `PermissionExpr` directly.

### 6.2 Layouts

A route names a `LayoutDefinition` **object**; the router groups routes by object
**identity** and emits one nested `<Route element={<Layout><Outlet/></Layout>}>`
per group (`sdk:…/RouterComponent.tsx:52-96`). One exported `XLayoutDef` per
shell — two objects for one shell splits the group.

ziee's layout defs are `lazy()` on purpose so a module referencing a layout does
not drag the whole shell into its chunk, and ziee's router wraps the layout in
`Suspense` keyed by **index** (a lazy component has no stable `.name`). **The SDK
router does neither** (`sdk:…/RouterComponent.tsx:76-85`: no Suspense,
`key={layoutDef.component.name || 'layout'}`). So on the SDK router a lazy layout
suspends with no boundary and two lazy layouts collide on the key — keep layout
components eager there until it is fixed.

### 6.3 Guards, effects, fail-closed

Both routers read two router-owned slots and compose them at render:

- **`routeGuards`** — first-registered guard is the OUTERMOST wrapper
  (`reduceRight`). With **zero** guards registered and protected routes present,
  the router logs an error and **falls back to `<Navigate to={loginPath}>`** —
  fail-closed (`sdk:…/RouterComponent.tsx:101-128`).
- **`routerEffects`** — headless components mounted INSIDE `<BrowserRouter>` so
  they may use `useNavigate`/`useLocation`; they must render `null`. A redirect
  belongs here, never in a page's `useEffect`.

`requiresAuth` partitions routes into guarded vs public; `permission` is
orthogonal and produces an **in-place 403** (URL + layout preserved).

### 6.4 Four gaps in the SDK port — know them before adopting it

| gap | consequence |
|---|---|
| the catch-all `*` is **guarded** (`RouterComponent.tsx:144-147`) | correct for an authenticated-only app; **wrong for a guest-first app** — an unknown URL sends a visitor to sign-in. A guest-first app registers an explicit PUBLIC `*` 404 route **and an E2E that visits an unknown URL logged out** (it currently wins only by react-router definition-order tie-breaking) |
| no `RouteModuleLoader` (`ensureModuleForPath` / `revalidateForPath` per navigation) | with smart loading on, a bookmarked deep link into a lazily-loaded module is redirected to `/` before its module arrives |
| no `RouteFallback` state machine (pending → spinner w/ timeout; forbidden → in-place 403) | a forbidden deep link loses its address instead of explaining itself |
| `addRoutes` has no `path+layout` dedupe (`routes-store.ts:31-39`) | a second registration wave inserts routes twice |

### 6.5 Router rules

1. One router module per app; it registers **no routes of its own**.
2. Every route: `path`, `element` via `lazyWithPreload`, `requiresAuth`,
   `permission?`, `layout`.
3. `requiresAuth` = "behind the guards"; `permission` = "in-place 403". Set
   `requiresAuth` **deliberately** — a guest-first app defaults it to `false` and
   `true` needs a reason.
4. Routes are collected via `onModuleRegister`; **never call `addRoutes`
   yourself**, never hand-roll a second fan-out loop.
