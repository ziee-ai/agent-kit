# React Component Patterns (CRITICAL)

> Component-level rules. The *mechanism* behind them (store-kit, proxy paths,
> slots, module waves) is `META_FRAMEWORK_ARCHITECTURE.md`; the gating layers are
> `PERMISSION_GATING.md`. `sdk:` = `sdk/packages/…`; `ziee:` = the reference app.
>
> Enforcement tags follow `CODING_GUIDELINES.md`: 🔧 lint · 🧪 test · 🔬 ci ·
> 🏛 type · 📐 convention.

---

## 1. Store access — the whole rule in three lines

```ts
const { items, loading, error } = MyStore   // RENDER. Reactive. Re-renders on change.
MyStore.$.items                             // HANDLER / async / init / module scope. Hook-free.
MyStore.doThing(arg)                        // ACTION. Anywhere. No `$`, no ceremony.
```

The path is chosen by **what the property IS**, not where you read it
(`sdk:framework/src/stores.ts:49-88`). A plain state value read outside a render
throws React's *Invalid hook call*.

🔧 **REMOVED — never write these:**

| gone | replacement | proof |
|---|---|---|
| `Stores.X.field` (the global proxy) | `import { X } from '@/modules/…/x'` — the value `registerLazyStore` returned | `sdk:framework/src/stores.ts:337-342` |
| `Stores.X.__state.field` | `X.$.field` — `__state` was **removed, not renamed** | `stores.ts:84-85`, `:233-234`; `store-kit.ts:641` |
| `X.$.doThing()` | `X.doThing()` — actions are already hook-free | `stores.ts:270-278` |

📐 A getter method (`X.getFoo()`) is path 2: it does **not** subscribe. In render,
also read the reactive field, or the component renders once empty and never
updates.

---

## 2. Declarative data — no `useEffect` load loops

🔬 A page **does not fetch**. The store's `init` does, on first proxy access
(§2.1 of the architecture doc). The component just reads:

```tsx
export function ThingsListPage() {
  const { items, loading, error } = Things       // init fires here, first access
  …
}
```

| Anti-pattern | Do instead |
|---|---|
| `useEffect(() => { void Store.load() }, [])` in a page | `init: ({ actions }) => { void actions.load() }` in the store |
| `useEffect` that re-fetches when a prop changes | an action call in the handler that changed it, or `watch(...)` in `init` |
| A component `useEffect` subscribing to the EventBus | `on('event', h)` inside the store's `init` — auto-grouped, auto-cleaned |
| A `setTimeout` DOM-ready hack for a portal/anchor | ResizeObserver / IntersectionObserver / parent-provided readiness |

🔬 **Every store declares `init`.** Event and sync subscriptions live there and
nowhere else.

📐 **No cross-module store access.** Never read another module's store from your
component, and never subscribe to its raw zustand hook. Import that module's
public handle through its barrel, or go through the EventBus. Cross-module UI
goes through the **slot system**, never a direct component import.

> ⚠️ **This one has NO mechanical gate today.** The reference app's
> `noRestrictedImports` blocks `antd` / `@ant-design/icons` / `antd/es/form` and
> nothing else (`ziee:biome.json:14-23`); its two Grit plugins ban `.__state` and
> raw interactive DOM elements. A cross-module import is caught by review only —
> which is exactly why the slot motto has to be a habit rather than a lint.

---

## 3. State branches: loading, empty, error — all three, always

🔬 Rendering only the happy path is a defect. From `@ziee/kit`:

| branch | component | rule |
|---|---|---|
| initial fetch | `Spin` / `Spinner` | always show something on first load |
| no rows | `Empty` | distinct from loading; never an blank div |
| fetch failed | `ErrorState` / `Alert` / `Result` | **always render `store.error`** — never `return null` on error |
| mutation outcome | `message.success(...)` / `message.error(...)` from `@ziee/kit` | every mutation gives feedback |

A page that already has rows and then hits an error surfaces it as a toast rather
than replacing the content (`ziee:src/modules/knowledge-base/pages/KnowledgeBasesListPage.tsx:32-36`).

🔧 `message`/`toast`/`Toaster` come from `@ziee/kit`
(`sdk:kit/src/index.ts:156-157`); mount `<Toaster/>` + `<DialogHost/>` once at the
root.

---

## 4. Permission gating in a component

Four layers, cheapest first — see `PERMISSION_GATING.md` for the full ladder:

```tsx
// 1. slot entry `permission` — owner filters BEFORE mount (no fetch, no 403)
// 2. route `permission` — in-place 403, URL preserved
<Can permission={Permissions.KnowledgeBaseManage}><Button …/></Can>   // 3. per-control
const canEdit = usePermission({ anyOf: [Permissions.A, Permissions.B] }) // 4. logic
```

🔧 **`usePermission` is a hook.** `usePermission(A) || usePermission(B)` is a
conditional-hook crash class — compose in the *expression*
(`{ anyOf: [...] }`), never with `||`/`&&` between two calls. The same applies to
any conditional store-proxy read (path 4 is a hook).

📐 Outside render (store `init`, actions, handlers) use `hasPermissionNow(expr)`
— it reads `.$` and does not subscribe.

---

## 5. Components, not primitives

🔧 Lint-enforced (Biome `noRestrictedImports` + `npm run lint:guardrails`):

- **Never import `antd`.** It is gone — the reference app has **zero** `antd`
  imports and no `antd` dependency (verified). Any guidance about antd tokens,
  `antd doctor`, or antd v6 deprecations is stale. (`ziee:biome.json:17-21`)
- **Never use raw `<button>/<input>/<select>/<textarea>`.** Use `@ziee/kit` — the
  kit enforces the accessible name + testid
  (`ziee:biome-plugins/no-raw-interactive-elements.grit`).
- **Never edit `kit/` or `shadcn/` to restyle app UI** — those DEFINE the tokens.
- `.__state` is banned by a second Grit plugin
  (`ziee:biome-plugins/no-store-internal-state.grit`) on top of `tsc`.

🔧 **`data-testid` is REQUIRED** on all functional/container/value/action kit
components and must be **globally unique** (a Vite plugin fails the build on
cross-file duplicates). Use a module-scoped kebab id (`kb-list-create-button`).
Collection items derive their testid from the container — give the **container**
one and the rows are covered. Icon-only `Button` also needs `tooltip` or
`aria-label`. The generated contract is `sdk:kit/src/KIT_MANIFEST.md`.

🔧 **No hardcoded colors** — no raw hue (`bg-red-600`), arbitrary value
(`text-[#fff]`), or inline `style` color. See `DESIGN_SYSTEM.md` for the token
table and the `Field`/`SectionHeader`/variant-weight rules.

---

## 6. Accessibility (the parts that are component-level)

- 🔬 Semantic interactive elements for clickables. A `div onClick` needs
  `role` + keyboard handlers.
- 🔬 Every control has an accessible name (`FormField label`, `<label htmlFor>`,
  `aria-label`); every page has a `role=main`; nav landmarks set.
- 🔧 Controlled kit inputs use `value`/`checked`, never `defaultValue`/
  `defaultChecked`.
- 🔧 No `:hover`/`:focus` implemented with inline `e.currentTarget.style.*` —
  use CSS `:hover` / `:focus-visible`.
- 🔧 Logical direction only (`ps/pe`, `ms/me`, `start/end`, `text-start`), never
  `pl/pr`/`ml/mr`/`left/right` — enforced by
  `sdk:config/src/lint/logical-direction.mjs`.

---

## 7. Initialization order (what exists when)

1. `main.tsx` imports `App.tsx`.
2. `App.tsx` module scope calls `loadModules()` → boot wave: manifest filtered by
   `isEligible`, bodies downloaded, `registerModule` per module,
   `initializeModules()` **once**.
3. `<AppShell authStore modulesReady>` renders a bare
   `<div data-testid="app-root">` until `modulesReady` resolves — **the theme
   store, the router and every slot come from module registration**, so nothing
   theme-dependent may render before it (`sdk:shell/src/bootstrap/AppShell.tsx:75-108`).
4. Modules' `initialize()` run on a microtask, errors caught per module.
5. A store's `init` runs on **first proxy access**, which may be much later.

🔬 Consequences to design around: a store nobody has touched has no `sync:`
subscription; a store whose `init` gates on a permission may run **before**
`/auth/me` lands, so it needs the `watch(useAuthStore, () => hasPermissionNow(…))`
re-trigger; and a module filling a **globally rendered** slot must be eligible
site-wide, or that surface silently vanishes on pages that never loaded it.

---

## 8. Error handling & boundaries

- `AppShell` wraps **every module-registered component in its own error
  boundary**, so one module's crash isolates to that module; the app entry's outer
  boundary catches what escapes (`AppShell.tsx:129-131`).
- 🔧 A slot component mounted with `createElement` gets **no Suspense boundary** —
  use `<LazyComponentRenderer component={…}/>`.
- 🔧 `EventBus.emit()` never rejects: handler throws are logged and swallowed
  (`sdk:framework/src/events/store.ts:104-120`). Surface errors **inside** the
  handler.
- 🔧 No `console.log`/`console.debug` in production code — `console.error`/`warn`
  only.

---

## 9. Module file layout (frontend)

```
modules/<name>/
  module.tsx      # createModule — the ONLY registration site
  types.ts        # this module's slot-key declarations (if it OWNS a region)
  stores/<store>/ # folder-per-store (index/state/actions.gen/actions/)
  components/     # this module's private components
  pages/          # route targets, reached only via lazyWithPreload
  gallery.tsx     # its seeded gallery surfaces (see TESTING_GUIDE.md §5)
```

🔧 Every `*.store.ts` / store folder is registered in the same commit — no dead
store files. 🔬 Import only from a module's public barrel; never its
`core/`/`utils/`/`components/` from outside.
