# Frontend Dependency Hygiene

> **STATUS: PENDING — sync from source machine.**
> This is a placeholder. The real `FRONTEND_DEPS.md` was not present on the
> machine that bootstrapped `agent-kit`. Drop the canonical doc in over this
> file — consumers `@import` `docs/FRAMEWORK.md`, which references this path, so
> no consumer change is needed once the real content lands.

## What belongs here
- The `npm run check` gate (tsc + antd doctor + antd lint)
- The `@ant-design/cli` workflow + `just antd-check`
- Within-major vs cross-major bump cadence
- Common antd v6 deprecation fixes
- Deferred major bumps + why
