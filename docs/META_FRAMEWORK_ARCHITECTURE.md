# UI Meta-Framework Architecture

> **STATUS: PENDING — sync from source machine.**
> This is a placeholder. The real `META_FRAMEWORK_ARCHITECTURE.md` was not present on the machine that
> bootstrapped `agent-kit` (only `DESIGN_SYSTEM.md` and `CODING_GUIDELINES.md`
> were available). Drop the canonical doc in over this file — every consumer
> `@import`s `docs/FRAMEWORK.md`, which references this path, so no consumer
> change is needed once the real content lands.

## What belongs here
- Module system with auto-discovery
- Store system (Zustand with proxies) / store-kit
- Event bus (type-safe, decoupled)
- Slot system (extensible UI)
- Router integration
- Complete module examples
