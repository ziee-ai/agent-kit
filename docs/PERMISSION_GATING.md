# Permission Gating (CRITICAL)

> **STATUS: PENDING — sync from source machine.**
> This is a placeholder. The real `PERMISSION_GATING.md` was not present on the machine that
> bootstrapped `agent-kit` (only `DESIGN_SYSTEM.md` and `CODING_GUIDELINES.md`
> were available). Drop the canonical doc in over this file — every consumer
> `@import`s `docs/FRAMEWORK.md`, which references this path, so no consumer
> change is needed once the real content lands.

## What belongs here
- The `PermissionExpr` type and the four gating layers: slot -> route -> `<Can>` -> `usePermission`
- Root admin vs Administrators group
- Wildcards and `is_admin` short-circuit
- Slot fields + route field for declarative gating
- Checklist for adding a new gated feature
- Anti-patterns to avoid
