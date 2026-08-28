# Agent-Kit Framework Docs (index)

This file is the **`@import` target** for every consuming app's root
`CLAUDE.md`. Claude Code auto-loads `CLAUDE.md` + `.claude/` only at the
working-dir ROOT, so a submodule's own docs are not picked up — the consumer
imports THIS file, which in turn imports the shared framework docs below.

These docs are the **universal** (app-agnostic) part of the ziee methodology.
App-specific module docs (memory/sandbox/bio_mcp test tiers, per-feature
sections, etc.) stay in each app's own `CLAUDE.md`, NOT here.

## Shared framework docs

@./META_FRAMEWORK_ARCHITECTURE.md
@./REACT_COMPONENT_PATTERNS.md
@./BACKEND_ARCHITECTURE.md
@./PERMISSION_GATING.md
@./TESTING_GUIDE.md
@./DEVELOPMENT_GUIDE.md
@./FRONTEND_DEPS.md
@./DESIGN_SYSTEM.md
@./CODING_GUIDELINES.md

## Provenance & status

The seven architecture docs were **written from source**, not synced from a
pre-existing file: the originals were never present on the machine that
bootstrapped agent-kit. Every rule in them is anchored to real code with a
`file:line` reference against the pinned SDK (`sdk/packages/*`,
`sdk/crates/*`) and the reference consumer app. Path prefixes used throughout:

| prefix | means |
|---|---|
| `sdk:` | `sdk/packages/…` — the pinned SDK submodule in your app |
| `sdk-crates:` | `sdk/crates/…` — the SDK's Rust crates |
| `ziee:` | the reference consumer app (`ziee/src-app/…`). **Not in your checkout** — it is the provenance anchor for consumer conventions the SDK itself cannot express |

**Rule of authority: the SDK supplies the mechanism; ziee is the reference
consumer for how to USE it; an older fork (cytoanalyst, or a scaffold copied from
one) is a snapshot, not a standard.** When they disagree, ziee wins.

| Doc | Status |
|---|---|
| DESIGN_SYSTEM.md | ✅ real (generated from the reference app's `index.css`) |
| CODING_GUIDELINES.md | ✅ real (ziee-derived; see its header for the ziee-domain vs framework-general split). §7/§9/§12/§13 carry **CORRECTED** notes where earlier revisions taught removed APIs |
| META_FRAMEWORK_ARCHITECTURE.md | ✅ written from source — module manifest + waves, store-kit + proxy paths, EventBus, sync, slots, router |
| REACT_COMPONENT_PATTERNS.md | ✅ written from source |
| BACKEND_ARCHITECTURE.md | ✅ written from source |
| PERMISSION_GATING.md | ✅ written from source |
| TESTING_GUIDE.md | ✅ written from source |
| DEVELOPMENT_GUIDE.md | ✅ written from source |
| FRONTEND_DEPS.md | ✅ written from source (rewritten — the antd-era framing was stale) |

### Known gaps (deliberately not covered)

These are named rather than guessed at, because a confident wrong answer is worse
than a stub:

- **`vite-plugin-module-manifest`** (the build half of smart module loading) is
  **app-local** in the reference app, not shipped by the SDK. Its runtime half
  (`isEligible` / `orderByDependencies` / `entryForPath`) *is* in the SDK. An app
  adopting waves must port the plugin.
- **The SDK router is a port and is behind the reference app's own router on four
  things** — a guarded catch-all, no route-driven module loading, no
  pending/forbidden deep-link fallback, no route dedupe. Enumerated in
  `META_FRAMEWORK_ARCHITECTURE.md` §6.4; not yet fixed upstream.
- **Cross-module import discipline has no mechanical gate.** Documented as
  convention, with the actual lint coverage stated honestly.
- **Desktop/Tauri packaging, and the visual-judge / geometry / affordance
  gallery gates**, are app-local in the reference app and are not documented here.
