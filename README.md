# agent-kit

The **shared agent-development infrastructure** for `ziee-ai` apps — one evolving
source of truth for the feature-lifecycle methodology, so it stops being
copy-pasted (and diverging) across N apps.

It holds:

- **`skills/`** — the universal Claude Code skills: `feature-lifecycle` (the
  8-phase state machine), `feature-orchestration` (the merge/fleet protocol), and
  the design-system skills (`design-taste-frontend`, `design-variant-tournament`,
  `shadcn-component-discovery`, `shadcn-component-review`, `frontend-ui-engineering`).
- **`lifecycle/`** — the deterministic validator + gates: `lifecycle-check.mjs`
  (per-phase gate), `merge-gate.mjs` (merge-time gate), `preflight.sh` (Phase-1
  env gate), and the `selftest*.sh` suites that prove them.
- **`scripts/install-agent-hooks.sh`** — installs the `pre-push` hook that
  enforces `lifecycle-check --all` on lifecycle branches.
- **`docs/`** — the framework docs (`FRAMEWORK.md` is the `@import` target;
  `DESIGN_SYSTEM.md`, `CODING_GUIDELINES.md`, + the architecture docs).

## The propagation model (prose floats, gates pin)

Skills change in two ways, which propagate differently:

- **Prose / guidance** (a new phase rule, a review angle) — SAFE: nothing green
  goes red. → **float the latest**.
- **New deterministic GATES** in `lifecycle-check.mjs`/`merge-gate.mjs`/`preflight.sh`
  (a stricter check) — POTENTIALLY BREAKING: a new gate can red an app's
  in-flight branches. → **semver-pinned per app, opt-in bumps**
  (patch = new prose rule; minor = new *optional* gate; major = a new *enforced*
  gate — read the changelog first).

## How an app consumes it (submodule + symlink + @import)

Claude Code auto-loads `CLAUDE.md` + `.claude/` **only at the working-dir ROOT** —
a submodule's own `CLAUDE.md`/`.claude/` is NOT picked up. So each app:

1. adds agent-kit as a git submodule at repo-root `agent-kit/`;
2. **symlinks** the shared skills + lifecycle into `.claude/` (git tracks
   symlinks; Claude Code + node follow them):
   - `.claude/skills/<name> -> ../../agent-kit/skills/<name>`
   - `.claude/lifecycle -> ../agent-kit/lifecycle`
   - the app's `.gitignore` `.claude` whitelist must track those symlinks — use
     **no trailing slash** (`!.claude/lifecycle`, not `!.claude/lifecycle/`); a
     trailing-slash pattern matches directories only, and a symlink is a file, so
     it would stay ignored;
3. opens its root `CLAUDE.md` with `@agent-kit/docs/FRAMEWORK.md`, then adds its
   own app-specific module sections;
4. supplies a **`.claude/app.config`** (see `app.config.example`) with its own
   paths — the de-ziee-ified `preflight.sh`/`merge-gate.mjs` read it; any key left
   unset makes that check/gate SKIP, so the shared scripts run unchanged across
   apps;
5. runs a one-command post-clone setup (`just dev-init`, which does
   `git submodule update --init` + creates the symlinks + installs the pre-push
   hook via `scripts/install-agent-hooks.sh`).

**Fresh clone / Windows caveat.** The `.claude` symlinks are committed, so a
checkout HAS them — but they DANGLE until the submodule is populated, so
`just dev-init` (which inits the submodule first) is the FIRST post-clone step;
even the bootstrap `bash .claude/lifecycle/preflight.sh` is unreachable before
it. On Windows, default Git checks committed symlinks out as plain TEXT FILES
unless symlink support is on — enable Developer Mode (or run as admin) and
`git config core.symlinks true`; `dev-init` detects a non-symlink checkout and
tells you how to fix it.

ziee is the reference consumer (branch `feat/agent-kit-consume`).

## De-ziee-ify contract

`preflight.sh` and `merge-gate.mjs` carry NO baked-in ziee paths. Everything
app-specific (build seed, vendored submodule, node workspaces, build-DB
isolation, dev-config seed; migrations dir, generated files, regen command,
cargo package + desktop crate) is read from the consumer's `.claude/app.config`
and SKIPs when unset. `lifecycle-check.mjs` is already app-agnostic (its
route-coverage + frontend-workspace checks no-op when the relevant paths are
absent). See `app.config.example` for the full key list.

## Verifying the kit

```bash
bash lifecycle/selftest.sh            # lifecycle-check phase gates (9 scenarios)
bash lifecycle/selftest-hardening.sh  # A1-A9 + merge-gate + preflight + de-ziee-ify (40 scenarios)
```
