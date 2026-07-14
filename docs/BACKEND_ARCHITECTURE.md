# Backend Architecture

> **STATUS: PENDING — sync from source machine.**
> This is a placeholder. The real `BACKEND_ARCHITECTURE.md` was not present on the machine that
> bootstrapped `agent-kit` (only `DESIGN_SYSTEM.md` and `CODING_GUIDELINES.md`
> were available). Drop the canonical doc in over this file — every consumer
> `@import`s `docs/FRAMEWORK.md`, which references this path, so no consumer
> change is needed once the real content lands.

## What belongs here
- Rust module system (mod/routes/models/repository/permissions)
- Permission system (RBAC)
- OpenAPI integration (aide)
- Error handling patterns
- Database integration (SQLx)
