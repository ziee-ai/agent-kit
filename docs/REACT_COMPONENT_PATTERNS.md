# React Component Patterns (CRITICAL)

> **STATUS: PENDING — sync from source machine.**
> This is a placeholder. The real `REACT_COMPONENT_PATTERNS.md` was not present on the machine that
> bootstrapped `agent-kit` (only `DESIGN_SYSTEM.md` and `CODING_GUIDELINES.md`
> were available). Drop the canonical doc in over this file — every consumer
> `@import`s `docs/FRAMEWORK.md`, which references this path, so no consumer
> change is needed once the real content lands.

## What belongs here
- Correct store access patterns (declarative `Stores.X`, never hooks/`useEffect` loads)
- Permission gating (Can / usePermission / slot field)
- Anti-patterns to avoid
- Initialization system
- Error handling
- Loading states
