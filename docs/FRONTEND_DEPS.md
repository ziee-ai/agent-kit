# Frontend Dependency Hygiene

> `sdk:` = `sdk/packages/…`; `ziee:` = the reference app. This doc covers the
> **npm side**: workspace layout, version policy, the `npm run check` gate chain,
> and bump cadence.

> ⚠️ **Correction to earlier guidance.** Anything telling you about `antd doctor`,
> `@ant-design/cli`, `just antd-check`, or antd v6 deprecations is **stale**.
> **antd is gone**: the reference app has zero `antd` imports and no `antd`
> dependency (verified), and a Biome rule rejects the import
> (`ziee:biome.json:17-21`). UI comes from `@ziee/kit`. A vestigial
> `antd-diagnose` recipe may still exist in an app's justfile; it is dead.

---

## 1. Workspace layout

The repo root is an **npm workspaces** root that includes the SDK's package tree:

```json
{ "workspaces": ["src-app/ui", "sdk/packages/*"] }
```

So `@ziee/framework`, `@ziee/kit`, `@ziee/shell`, `@ziee/gallery`, `@ziee/config`,
`@ziee/test-e2e` resolve to the **working tree**, not a registry. Consequences:

- `npm install` at the ROOT, once, hoists for every workspace. Installing inside
  `src-app/ui` alone will produce a broken or duplicated tree.
- Editing a file under `sdk/packages/*` changes the app immediately — and is a
  **submodule** change that must be committed and pinned separately.
- **Tailwind must `@source` the workspace-linked `@ziee/*` trees it uses**
  (kit, shell) in `index.css`, or those packages' component classes are never
  generated and the UI renders unstyled.

The root `package.json` `overrides` block pins the few packages that must be
singletons across the tree (React/ReactDOM, TypeScript, Vite). Add an override
only for a genuine duplicate-instance hazard, not to dodge a peer warning.

---

## 2. Version policy — one version everywhere, enforced

`syncpack` is the gate, configured from the SDK's shared policy
(`sdk:config/syncpack.base.mjs`):

- `typescript` → **`~`** ranges. Its minors can break.
- everything else → **`^`**.
- catch-all: **the same version everywhere a dependency appears**
  (`sameRange`), across every workspace.

```js
// .syncpackrc.mjs
import { defineSyncpack } from '@ziee/config/syncpack'
export default defineSyncpack({
  source: ['package.json', 'src-app/ui/package.json'],
  versionGroups: [ /* app-specific, LABELLED exceptions only */ ],
})
```

Run `syncpack lint` to check, `syncpack fix-mismatches` to rewrite the lower
version up, then lint again. 📐 Every `versionGroups` entry carries a `label`
saying **why** that dependency is allowed to diverge — an unlabelled exception is
indistinguishable from an accident.

---

## 3. The `npm run check` gate chain

`check` is **not** just `tsc`. It is a chain of small, fast, mostly SDK-provided
gates. Adoption is an npm script plus a config entry — not a port.

| gate | source | catches |
|---|---|---|
| `tsc` | — | types across `src` **and** `tests` |
| `lint:guardrails` | app biome config (extends `sdk:config/biome.base.json`) | `antd` imports; raw `<button>/<input>/<select>/<textarea>`; the removed `.__state` (two Grit plugins) |
| `lint:hooks-top-level` | biome `correctness/useHookAtTopLevel` | conditional hooks — including the `usePermission(A) \|\| usePermission(B)` crash class |
| `check:store-actions` | **SDK** `config/src/lint/store-actions.mjs` | folder-per-store shape; bans `lazyActions:` / inline `actions: {`; regenerates `actions.gen.ts` |
| `lint:colors` | **SDK** `config/src/lint/hardcoded-colors.mjs` | raw hues, arbitrary color values, inline style colors |
| `lint:logical-direction` | **SDK** `config/src/lint/logical-direction.mjs` | physical `pl/pr`/`ml/mr`/`left/right` (RTL readiness) |
| `lint:settings-field`, `lint:adjacent-inline`, `lint:tooltip-placement` | **SDK** `config/src/lint/*` | settings-page composition, inline spacing, tooltip placement |
| `check:design-spec` | **SDK** `config/src/lint/design-spec.mjs` | `DESIGN_SYSTEM.md` drift from `index.css` |
| `check:kit-manifest` | **SDK** `config/src/lint/kit-manifest.mjs` | `KIT_MANIFEST.md` drift from the kit barrel |
| `check:testid-registry` | **SDK** `gallery/scripts/gen-testid-registry.mjs` | missing / duplicate `data-testid` |
| `check:gallery-*` (coverage, seed-registry, state-matrix, overlay-registry, prod-exclusion, harness-parity) | **SDK** `gallery/scripts/*` | every surface has a story; the gallery seed never ships to prod |

The SDK gallery scripts are **config-driven** through `gallery.config.json` and
fall back to the reference app's historical hardcodes — so adopting one is a
config entry, not a fork. 📐 Point `surfaceRoots` at **every** directory holding
components, including a design-system primitives folder outside `src/modules`, or
the registry generators never see them.

**Adoption order for a new app**, by (bug class prevented) × (cost):
1. `gate:ui` + `gallery:runtime` — the only mechanical definition of "a surface is
   done" (zero console errors, WCAG-AA contrast, a11y names, per surface × state ×
   theme).
2. `check:store-actions` — keeps the lazy-store convention honest.
3. biome + `lint:guardrails` + `lint:hooks-top-level`.
4. `lint:colors`, `check:design-spec` — one script line each; a design-system app
   without them will drift.
5. `check:gallery-prod-exclusion` — one line, and without it the gallery seed can
   silently ship.
6. `check:testid-registry` (+ the build-time uniqueness vite plugin).
7. The remaining registry/coverage gates, once the surface set stabilizes.

📐 A gate that exists but is not in `check` does not exist. Wire it into `check`
in the same commit you add it.

---

## 4. Bump cadence

| kind | cadence |
|---|---|
| within-major (`^`) | routine — `npm update`, run `check` + e2e, commit the lockfile |
| **cross-major** | deliberate, one at a time, with its own branch and a full test run. Never batched with feature work |
| React / TypeScript / Vite | pinned via root `overrides`; a bump is a repo-wide event, and `typescript` uses `~` because its minors break |
| the **SDK submodule** | a pin bump, not an npm bump: `git -C sdk fetch && git -C sdk checkout <sha> && git add sdk`. Diff `packages/framework/src` before and after — an app's pin can be **ahead** of the reference app's on some files, so a "forward" bump can be a regression. Check the differing files individually; never assume forward-compatible |

🔬 **`npm audit` in CI.** Direct dependencies carry no high/medium advisories. A
transitive advisory with no upstream fix gets a dated, linked note, not silence.

🔧 **No dependency without an import.** Remove a package in the same commit you
remove its last use — `check` will not catch a dead dep for you.

---

## 5. Anti-patterns

| Anti-pattern | Do instead |
|---|---|
| `npm install` inside `src-app/ui` | install at the repo ROOT (workspaces hoist) |
| Adding a dep to the app that the SDK already ships | import it from `@ziee/*` |
| Editing `sdk/packages/*` and committing only the app | that is a **submodule** change — commit it there and bump the pin deliberately |
| `git add -A` on a branch that isn't bumping a pin | it reverts submodule pins; stage explicitly |
| An unlabelled `versionGroups` exception | label it with the reason |
| Adding a lint script without wiring it into `check` | wire it in the same commit |
| Bumping the SDK pin "to get the latest" | diff first; a pin can be ahead on individual files |
