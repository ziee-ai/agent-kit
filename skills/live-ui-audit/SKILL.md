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
any HIGH) `--merge=<dirs>` `--stuck-dwell-ms=4000` `--build-note=<text>`
(repeatable — see *Build caveats*).

### Build caveats — never report a deliberately cold build silently

Performance-shaped findings (`waterfall` / `excess` / `oversized` / `duplicate`)
describe the **build that was served**, not the app in the abstract. A target
built with the shipped idle-warm stripped (e.g. `VITE_STORE_PREFETCH=off
VITE_CLOSURE_PREFETCH=off`, which is how the 24/7 rig target is built) makes a
request the warm build would already have made read as a serialized cold fetch.

The battery **auto-detects** this: it loads the app authenticated, waits for
network-idle + an idle tick, and counts runtime-injected `link[rel=prefetch]`
elements (NOT `modulepreload`, which the bundler emits statically regardless).
Zero of them means idle prefetch was compiled out. Any caveat — auto-detected or
declared with `--build-note=` — is written into the report header **and** stamped
onto every perf-shaped finding (`buildNotes` field + a short marker on `detail`).

### Trusting the instrument

Every repaired detector has a paired **negative control**: a fixture where the
false positive must NOT fire, and a fixture where a genuine instance of the same
class must STILL fire. The detectors are exported (`inPageAudit`,
`analyzeNetwork`, `probeLoading`, `probeIsSettled`, `requestKey`) and the module
runs `main()` only when it is the process entrypoint, so a harness can import
them and drive them against hand-written HTML without launching the app. A
change that only reduces the count is indistinguishable from a disabled check —
require both halves.

### Broad sweeps: shard, then merge

A whole-app sweep is many flows × 6 cells and runs ~an hour serially. Split the
flow set into disjoint **shards**, run them in parallel (keep it modest — 4 is
plenty; the app is usually a shared instance), then consolidate:

```bash
S="node .../live-ui-audit.mjs --url=<URL> --user=admin --password=<pw> \
   --viewports=390,768,1280 --themes=light,dark --persona=all"
$S --jtbd=home,compose-send,adversarial-compose,chat-existing,conversations-list --out=$O/shard1-chat &
$S --jtbd=projects,knowledge-base,files,scheduled-tasks,hub,notifications        --out=$O/shard2-features &
$S --jtbd=settings-user,settings-admin-core                                      --out=$O/shard3-settings-a &
$S --jtbd=settings-admin-llm,settings-admin-tools                                --out=$O/shard4-settings-b &
wait
$S --jtbd=permission --out=$O/shard5-permission   # RBAC pass — run once, not per shard

# One consolidated, re-deduped, ranked inventory over all shards
node .../live-ui-audit.mjs --merge=$O/shard1-chat,$O/shard2-features,... --out=$O
```

`--merge` re-expands each shard's deduped rows back to per-cell findings,
re-dedups globally, and rewrites the full report into `--out` (screenshot paths
are rewritten shard-relative, so keep the shard dirs next to the merged report).

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
   `requestfailed`, non-2xx `/api` responses, step-execution errors, **stuck**
   spinners — a spinner is only *stuck* if it survives a re-probe after
   `--stuck-dwell-ms` (default 4000) **and** the app is not declaring in-flight
   work via its own `[data-busy]` discriminator. A live spinner during an SSE
   generation is correct rendering, not a defect.
2. **UI (visual correctness):** horizontal body overflow (`scrollWidth > innerWidth`),
   pairwise **control collision** (two distinct in-viewport controls whose
   **painted, post-clip** boxes overlap ≥60%, excluding intentional
   overlaid-actions + open menus/popovers), unreachable/clipped controls, broken
   images (`naturalWidth===0`), zero-size clickables.
3. **Responsive:** the UI battery at each viewport — controls clipped at 390px,
   body horizontal scroll, a surface that only fits at desktop width.
4. **Color/theme:** WCAG-AA contrast (fg vs composited effective bg, oklch-aware);
   **palette drift** (a *saturated* color not resolvable to any shipped
   DESIGN_SYSTEM token **and not carrying the repo's `data-allow-custom-color`
   opt-out** → hardcoded-color escape); **light↔dark parity** (an element
   that passes AA in one theme and fails in the other — the classic
   works-in-light-only bug).
5. **Consistency (design-system):** off-4px-grid spacing (2px half-step tolerated,
   sub-2px hairlines ignored; the finding names an offending element per value),
   **mixed variants in a peer icon-button group** (DESIGN_SYSTEM J6).
6. **Network hygiene / request-sense** (per flow-step, from the real request log):
   `failure` (non-2xx/aborted/timeout), `duplicate` (same method + path **+
   normalized query** ≥2× in a step — a paginated list's `?page=1..4` is four
   resources, not one endpoint four times), `n+1` (many ids on one endpoint
   template in a burst), `waterfall` (a run of requests each of which
   demonstrably could not be *issued* until the previous *returned* — strict
   non-overlap on real `request.timing()`, a ≤150ms continuation gap, each link
   ≥25ms, ≥300ms serial in total), `excess` (same resource firing ≥4× within one
   step — polling / re-render storm), `oversized` (payload > 200 KiB), and
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
| `browse-settings` | Configure account / app settings (short form) | normal |
| `chat-existing` | Re-open a conversation, its right panel, per-message actions | normal |
| `conversations-list` | Find a past conversation | normal |
| `projects` | Browse projects → open one → its files tab | normal |
| `knowledge-base` | Browse knowledge bases → open one | normal |
| `files` | Open an uploaded file | normal |
| `scheduled-tasks` | Browse scheduled tasks | normal |
| `hub` | Browse the 6 hub catalog tabs | normal |
| `notifications` | Review notifications + background runs | normal |
| `settings-user` | Configure the 12 user-scoped settings pages | normal |
| `settings-admin-core` | Administer users / auth / deployment (8 pages) | normal |
| `settings-admin-llm` | Administer providers, runtime, retrieval (6 pages) | normal |
| `settings-admin-tools` | Administer built-in + external tools (9 pages) | normal |
| `permission` | RBAC access-matrix audit as diverse personas | (multi) |

Most surfaces need nothing but "navigate there and audit what renders", so the
`nav()` / `sweep()` helpers build such flows declaratively — adding a surface is
one `['surface-slug', '/route']` line. **The step name IS the surface slug**, and
the report groups per-surface by it, so name steps after the screen they open.
Detail routes (`/chat/:id`, `/projects/:id`, …) take their ids from `ctx`, which
`resolveFixtures()` reads from the live API at start-up — never hardcode an id,
and let a missing fixture make the step a graceful no-op rather than a finding.

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
steps }`, plus, for consumers that fingerprint or render findings:

| field | what it is |
|---|---|
| `surface` / `_surface` | the page/screen the finding fired on (both spellings published) |
| `dimension` / `_dim` | which of the 7 dimensions it belongs to (both spellings) |
| `detail` / `message` | the signal string (both spellings) |
| `signal` | `category/subcategory\|surface\|anchor` — a ready-made fingerprint key |
| `anchor` | **stable secondary element key**: `tag[role] "accessible name" @ landmark`. A `--mode production` build strips literal `data-test*` attributes, so `selector` degrades to a raw `nth-of-type` DOM path that names nothing a human can find and changes with any sibling edit. Always read `anchor` first. |
| `buildNotes` | build caveats in force for a perf-shaped finding (see above) |

Publishing both the `_`-prefixed and plain spellings is deliberate: a consumer
that reached for `surface` used to get an empty string, which silently collapses
a fingerprint to `severity\|category\|subcategory` and renders the surface as a
bare `?`. **Ranked most-severe-first, deduped** across viewports/themes (each row
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
neutral ramp is legit, and `data-allow-custom-color` — the repo's own sanctioned
opt-out, honoured by its committed linter — is respected); sub-2px spacing is
hairline, not grid drift.

### Geometry is measured on the PAINTED box, never the layout box

`getBoundingClientRect()` is a **layout** box; it is not what the user sees or
can reach, and conflating the two was historically this battery's largest
false-positive source (≈79 findings/cycle on one target).

* **Self-clip.** `clip: rect(0,0,0,0)` / `clip-path: inset(50%)` collapse a box
  to nothing while leaving a 1×1 layout rect. That is `sr-only` — so the
  keyboard skip link, a *required* a11y affordance, read as a
  `zero-size-control`. Self-clipped elements are not "visible".
* **Ancestor overflow.** A row scrolled past the bottom of its scroll container
  keeps a layout rect down there, where a pinned footer is drawn — hence "two
  controls overlap 66%" for things the screenshot shows never touching.

`clipState()` intersects an element with every clipping ancestor's padding box
and classifies the loss by **reachability**, which is the distinction that
actually matters:

* cut by a **user-scrollable** ancestor → merely scrolled out of view; the user
  scrolls and reaches it. Not a defect, and its rect is not used for geometry.
* cut by a **non-scrollable** clipper (`overflow: hidden|clip`, or `auto`/`scroll`
  with no scroll range) → genuinely **unreachable**, and still reported as
  `clipped-control` naming the offending clipper and its scroll range.

Do not "fix" a clipping false positive by suppressing the class — re-derive
which of those two cases the geometry is in.

### Other tunings

`SHELL_DOMAINS` is the set of `/api` domains the authenticated **shell** loads on
every surface regardless of route (auth/sync/onboarding/notifications/… and
`conversations`, because the persistent sidebar's recent-conversations widget
renders on settings too). The per-flow
relevance set lists each flow's real page dependencies (e.g. the chat composer
legitimately loads models/providers/voice/summarization) so only genuinely
off-page fetches flag. When adding a flow, tune its relevant-domain set from a
first run before trusting the `irrelevant` column.

The synthetic **`(load)` step is the driver's own bootstrap** — every flow lands
on `/` first so the shell is authenticated before the flow navigates away. Its
requests therefore belong to the HOME page, so relevance judges `(load)` against
the home domain set, not the target surface's. (Without that, every nav-driven
sweep flow reports the entire chat home as `irrelevant` — the dominant FP once
sweep flows were added.)

**Prove whether a saturated shared instance is env noise or an app bug.**
Per-user SSE connection caps (ziee: 12/user) make `/api/sync/subscribe` → 429
look like an app defect, and a parallel audit can self-induce it. Distinguish
before reporting: probe the endpoint **sequentially with zero concurrency**, and
probe as a **freshly created user**. Fresh-user 200 + incumbent-user 429 under no
load = a real per-user slot-reclamation defect; both 429 only while your own
shards run = self-induced, report as noise. Never report either without the probe.

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
