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
@./DESIGN_SYSTEM.md
@./CODING_GUIDELINES.md

## Availability note

At bootstrap time only `DESIGN_SYSTEM.md` and `CODING_GUIDELINES.md` were present
on the source machine. The other six are **PENDING-sync stubs** — each names what
belongs there. Replacing a stub with its canonical doc is a drop-in: consumers
import this index, so no consumer edit is needed when the real content lands.

| Doc | Status |
|---|---|
| DESIGN_SYSTEM.md | ✅ real (from ziee root, generated from `index.css`) |
| CODING_GUIDELINES.md | ✅ real (ziee-derived; see its header for the ziee-domain vs framework-general split) |
| META_FRAMEWORK_ARCHITECTURE.md | ⏳ PENDING sync |
| REACT_COMPONENT_PATTERNS.md | ⏳ PENDING sync |
| BACKEND_ARCHITECTURE.md | ⏳ PENDING sync |
| PERMISSION_GATING.md | ⏳ PENDING sync |
| TESTING_GUIDE.md | ⏳ PENDING sync |
| DEVELOPMENT_GUIDE.md | ⏳ PENDING sync |
