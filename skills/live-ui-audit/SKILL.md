---
name: live-ui-audit
description: Drive the LIVE running app like a human and produce an EVIDENCE-BASED audit of functional bugs, UI/visual correctness, responsive behavior, color/theme conformance, design-system consistency, network hygiene, and RBAC permission/resource-scoping. Objective, measurable signals ONLY — no subjective UX opinion. Use when asked to audit/QA/smoke-test a running instance, find real UI/responsive/theme/perf/permission bugs across viewports and themes, verify a deploy, or check whether a build "actually works" in the real app (not just gallery/tests). Takes a base URL + credentials, works against any running ziee-stack instance. Runs Playwright across 3 viewports × 2 themes × JTBD flows × personas and emits a ranked, deduped finding report with screenshots.
---

# Live UI Audit

Points an **objective** check battery at a **running** app and produces a ranked,
deduped, evidence-backed finding report. It is the live-app sibling of
`src-app/ui/scripts/runtime-health.mjs` (which runs the same class of checks
against the mock-API **gallery**); this skill drives the **real** app mid-flow as
a logged-in user and adds the checks only a live app can surface (network,
cross-user leaks, real data states).

**Every signal is measurable.** There is no "is this good design" scoring — that
has proven unreliable. The single vision hook is scoped to **breakage** (overlapping
text, cut-off cards, a detached control), never taste.

## When to use

- "Audit / QA / smoke-test the running app", "find UI bugs in the live app",
  "does this actually work in the real app", "check it across mobile/desktop and
  dark mode", "verify the deploy", "check for permission leaks".
- After a UI change, before a release, or to triage a "something looks broken"
  report — on a real instance, not the gallery.

**Not** for: pure visual-regression baselines (that's `gate:ui` / the gallery
Layer-B pixel diff), or subjective redesign work (`design-taste-frontend`,
`design-variant-tournament`).

## How to invoke

The battery is a self-contained Playwright script in this skill dir. It takes a
base URL + credentials, so it works against **any** running ziee instance.

```bash
# Full audit: 4 JTBD flows + permission personas × 3 viewports × 2 themes
node agent-kit/skills/live-ui-audit/live-ui-audit.mjs \
  --url=http://127.0.0.1:1520 --user=admin --password=password123 \
  --jtbd=home,compose-send,adversarial-compose,browse-settings,permission \
  --viewports=390,768,1280 --themes=light,dark --persona=all \
  --out=/path/to/out

# Fast triage (one flow, one cell)
node .../live-ui-audit.mjs --url=<URL> --jtbd=home --viewports=1280 --themes=light --out=<dir>

# Fleet mode: every JTBD × every persona (incl. adversarial + permission)
node .../live-ui-audit.mjs --url=<URL> --fleet --out=<dir>
```

Flags: `--url` `--user` `--password` `--viewports=390,768,1280`
`--themes=light,dark` `--jtbd=<ids>` `--persona=normal|adversarial|all`
`--fleet` `--out=<dir>` `--probe-deadends` `--headed` `--gate` (exit non-zero on
any HIGH).

**Playwright resolution:** the script imports `@playwright/test`, falling back to
the ziee repo-root `node_modules` (or `PLAYWRIGHT_DIR=<path>`). Chromium must be
installed (`npx playwright install chromium`). **OpenAPI:** the network relevance
check reads `src-app/ui/openapi/openapi.json` (or `OPENAPI_JSON=<path>`) to map
each endpoint → its purpose; it degrades gracefully if absent.

**If the app is down:** point `--url` at any running instance (the skill is
URL+creds driven — nothing is hardcoded to a port). Bring one up per the repo
Quick Start (`CONFIG_FILE=config/dev.yaml cargo run` + `npm run dev`) or a release
binary, then pass its origin.

## The check battery (7 objective dimensions)

Driven at **3 viewports (390 / 768 / 1280) × light AND dark**, navigating real
JTBD flows; after each step the battery runs:

1. **Bugs (functional):** `console.error` / `pageerror`, ErrorBoundary `crash`,
   `requestfailed`, non-2xx `/api` responses, step-execution errors, stuck
   spinners (still present after the settle window).
2. **UI (visual correctness):** horizontal body overflow (`scrollWidth > innerWidth`),
   pairwise **control collision** (two distinct in-viewport controls overlapping
   ≥60%, excluding intentional overlaid-actions + open menus/popovers), clipped /
   off-viewport controls, broken images (`naturalWidth===0`), zero-size clickables.
3. **Responsive:** the UI battery at each viewport — controls clipped at 390px,
   body horizontal scroll, a surface that only fits at desktop width.
4. **Color/theme:** WCAG-AA contrast (fg vs composited effective bg, oklch-aware);
   **palette drift** (a *saturated* color not resolvable to any shipped
   DESIGN_SYSTEM token → hardcoded-color escape); **light↔dark parity** (an element
   that passes AA in one theme and fails in the other — the classic
   works-in-light-only bug).
5. **Consistency (design-system):** off-4px-grid spacing (2px half-step tolerated,
   sub-2px hairlines ignored), **mixed variants in a peer icon-button group**
   (DESIGN_SYSTEM J6).
6. **Network hygiene / request-sense** (per flow-step, from the real request log):
   `failure` (non-2xx/aborted/timeout), `duplicate` (same url+method ≥2× in a
   step), `n+1` (many ids on one endpoint template in a burst), `waterfall`
   (long serial dependent chains), `excess` (same endpoint firing ≥4× across the
   flow — polling / re-render storm), `oversized` (payload > 200 KiB), and
   **`irrelevant`** — endpoint-purpose vs page-purpose: a heavy GET whose domain
   has nothing to do with the current flow's job (grounded in the OpenAPI
   summary + the flow's relevant-domain set; e.g. a login page fetching
   `/api/conversations`).
7. **Permission + resource-scoping (RBAC)** — the security-critical dimension,
   run as permission-diverse personas (below).

Plus **one vision pass scoped to BREAKAGE only:** each finding row carries a
screenshot path; hand the HIGH/MEDIUM geometry findings' screenshots to a vision
model asking ONLY "is text overlapping / is a card cut off / is a control
detached from its label" — never "is this good design".

## JTBD / persona model

A run is **JTBD flows × personas × viewports × themes**. A **JTBD** ("job to be
done") is a real user goal expressed as an ordered, defensive set of steps; the
battery audits the surface after each step. Built-in flows:

| JTBD id | Job | Persona |
|---|---|---|
| `home` | Open the app, land on new-chat home | normal |
| `compose-send` | Type a question and send it to the assistant | normal |
| `adversarial-compose` | Break the composer: empty submit, ~32k-char paste, rapid double-submit | **adversarial** |
| `browse-settings` | Configure account / app settings | normal |
| `permission` | RBAC access-matrix audit as diverse personas | (multi) |

The **adversarial "break-it" persona** feeds empty/huge/weird inputs, rapid nav,
and double-submits — exactly the inputs that surface un-guarded states. Add a
flow by extending the `FLOWS` map (a `title`, a `persona`, and `steps[]` of
`{name, run(page)}`); add its relevant network domains to `FLOW_RELEVANT_DOMAINS`.

### Permission personas (dimension 7)

Seeds (idempotently, via the admin REST API — mirrors `tests/common/auth-helpers`)
permission-diverse personas, each owning its own resources, then audits AS each:

- **admin** — all perms (the token you pass).
- **restricted-user** (`audit_restricted`) — base group perms only; owns one
  conversation.
- **user-B** (`audit_userb`) — a second regular user owning its OWN conversation
  (the cross-user isolation control).
- **power-user** — documented extension point: seed with a mid-tier perm set +
  assigned providers/models/MCP/KBs to exercise `unreflected-resource` definitively.

**The oracle** = the expected access matrix, derived from the codebase:
`modules/*/permissions.rs` + the granting migrations + the four frontend gating
layers (slot → route → `<Can>` → `usePermission`, per `.claude/PERMISSION_GATING.md`),
and the owner-scoped rule (cross-user id → **404**). Encoded as `ADMIN_MATRIX`
({route, backing admin API, required perm}) + the seeded {resource → owner}.

Per-persona checks (subcategories):
- `ungated-surface` (**HIGH**) — a lacked-permission surface reachable at ANY of
  the 4 layers: a nav entry visible (layer-1), the route rendering on direct-nav
  without redirect/denial (layer-2/3), or the **backend admin API returning 2xx**
  to a user without the perm (the authoritative signal).
- `cross-user-leak` (**HIGH**) — persona A reads user-B's owner-scoped id (a 2xx
  where a 404 is required).
- `broken-positive-access` — a persona canNOT reach a surface/resource it IS
  entitled to.
- `unreflected-resource` — a picker/list shows the full deployment set instead of
  only what the persona is assigned/owns.

## Output contract

`--out` gets `findings.jsonl` (machine) + `findings.md` (human) + `screenshots/`.
Each finding = `{ severity, category (+ subcategory for network/permission),
flow, jtbd, persona, viewport, theme, the exact signal string (e.g. "body
scrollWidth 1440 > viewport 390"), screenshot path, cells it appeared in, repro
steps }`. **Ranked most-severe-first, deduped** across viewports/themes (each row
lists the cells it fired in). **No subjective UX commentary.**

Severity floor: cross-user leaks, ungated surfaces, contrast failures,
theme-parity breaks, horizontal overflow, uncaught errors, 5xx = **HIGH**.

## Tuning / false-positive discipline

Objective ≠ zero-FP; the thresholds are tuned and documented in the script
(each with a rationale comment), mirroring `runtime-health.mjs`'s harness-noise
ledger. Notable tunings: control-collision excludes intentional overlaid-actions
+ open popovers and requires ≥60% overlap of distinct in-viewport controls
(LOW, a vision-pass hint); `net::ERR_ABORTED` on stream/subscribe endpoints is a
benign client teardown (muted); palette-drift only flags *saturated* colors (the
neutral ramp is legit); sub-2px spacing is hairline, not grid drift; the network
relevance set lists each flow's real page dependencies (e.g. the chat composer
legitimately loads models/providers/voice/summarization) so only genuinely
off-page fetches flag. When adding a flow, tune its relevant-domain set from a
first run before trusting the `irrelevant` column.

## Relationship to existing infra

- **Reuses** the color/contrast/a11y/grid helpers + severity model from
  `src-app/ui/scripts/runtime-health.mjs`.
- **Anchors** color + consistency to `DESIGN_SYSTEM.md` — but reads the SHIPPED
  token values from the app's own computed CSS custom properties at runtime, so
  it never hardcodes what `index.css` already owns.
- **Grounds** network relevance in `src-app/ui/openapi/openapi.json`.
- **Mirrors** the auth/seed patterns in `tests/common/auth-helpers.ts`.

Porting to another ziee-stack app: keep this SKILL, drop in that app's
`openapi.json` path (`OPENAPI_JSON`), and adjust `ADMIN_MATRIX` /
`FLOW_RELEVANT_DOMAINS` / `FLOWS` to its routes.
