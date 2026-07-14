---
name: design-variant-tournament
description: On-demand best-of-N design workflow for NEW flagship UI surfaces (onboarding, a landing/marketing page, a brand-new feature page, a first-run wizard). Generates 3 genuinely different on-system design variants, renders + screenshots each via the component gallery, has an Opus VISION judge score them against a rubric and pick a winner, then synthesizes the winner + the best ideas from the runners-up into one final on-system component. Use when the user asks to "design N options and pick the best", "run a design tournament", "best-of-N this screen", "explore directions for <new surface> and choose", or greenlights a flagship surface that deserves more than one first draft. NOT for maintenance edits, small tweaks, bug-fix restyles, or any surface where a single obvious layout is correct — those go straight to design-taste-frontend. Invoked on demand, never automatically.
---

# Design Variant Tournament

A **best-of-N + vision-judge** workflow for the handful of UI surfaces that are worth
designing more than once. You generate several genuinely-different-but-on-system
directions, render and screenshot each on the real kit, let an Opus **vision** judge
score them against the brief, pick a winner, and then **graft** the best specific ideas
from the losers into the winner. The output is one shipped, on-system component plus the
judge's written rationale.

This is deliberate, expensive, and **on demand**. It is not a default. Most UI work
does not warrant it.

---

## When to use / when NOT to

**USE it for a NEW flagship surface** where the layout is genuinely open and the surface
is high-leverage enough that a first draft is likely to leave value on the table:

- Onboarding / first-run setup wizard, getting-started guide.
- A landing / marketing / hero page.
- A brand-new top-level feature page (a new module's main page) with no established
  layout precedent.
- An empty-state or dashboard shell that sets the tone for a whole area.

**Do NOT use it** — go straight to `design-taste-frontend` (or just edit) — for:

- Maintenance edits, restyles, spacing/token fixes, bug-driven changes.
- Adding a field/card/row to an existing page (the layout is already decided).
- Any surface where one obvious, correct layout exists — running a tournament there
  just burns three implementations to rediscover the obvious one.
- Component-level review of something already built → that's `shadcn-component-review`.

Litmus test: *"Would a thoughtful designer sketch three different directions before
committing?"* If no, this skill is the wrong tool.

---

## How the field does this (prior art — why the method is shaped this way)

- **Best-of-N sampling**: draw N independent candidates, then select — reliably beats a
  single greedy draft when quality is hard to specify up front and easy to recognize
  after the fact. Design is exactly that shape.
- **LLM-as-judge / judge panels**: a separate evaluator model scoring candidates against
  an explicit rubric is a standard selection mechanism. The critical rule is
  **generator ≠ judge framing**: the judge evaluates artifacts against the brief's
  intent, not against "what I would have built."
- **Vision judging, not text**: for UI, the artifact is *how it looks rendered*, not the
  JSX. So the judge must look at **screenshots** (Claude/Opus vision), never at source
  code or a text description of the design. Text-bridge / local-LLM judges cannot see
  layout, spacing, hierarchy, or contrast — they are disqualified here.
- **Synthesis over pick-one**: the winner is a starting point. The measurable lift comes
  from grafting the runners-up's best local ideas (a better empty state, a cleaner header,
  a smarter density choice) into the winner — an ensemble/merge step, not a raw argmax.

---

## Hard guardrails (read before generating anything)

1. **On-system only.** Every variant is built from the **existing shadcn kit**
   (`@/components/ui`) + the design tokens + the `DESIGN_DIRECTION.md` ("bench notebook")
   identity. No off-system invention: no raw hex, no new one-off components that
   duplicate a kit primitive, no ad-hoc spacing outside the 2px/4px + `--radius` scale,
   no bespoke color that fights the single accent. Variation comes from **layout,
   density, and composition** — not from smuggling in a foreign design language.
   - Before writing a variant, run **`shadcn-component-discovery`** to confirm a kit /
     registry component already exists for each block you need (table, form, wizard step,
     card grid, empty state). Invent nothing that the kit already ships.
   - While writing each variant, apply **`design-taste-frontend`** (read the brief,
     state the Design Read, avoid slop) so each direction is a *good* execution of its
     idea, not a strawman.
   - After writing each variant, run **`shadcn-component-review`** on it and fix drift
     (hardcoded colors, `space-y-*` instead of `gap-*`, missing `data-slot`, token
     misuse) **before** it is screenshotted. A variant that loses on preventable drift
     tells you nothing.
2. **Variants must be genuinely different directions**, not three shades of the same
   layout. Pick three *distinct* points in design space up front (see Phase 1). If two
   variants converge, replace one.
3. **The judge is Claude/Opus vision, on screenshots.** Not the text bridge, not the
   local LLM engine, not a code read. See Phase 3.
4. **Everything is on the gallery.** Variants render as gallery story sections (or a
   temp preview route) so the exact same Playwright screenshot path the visual-testing
   system already uses (`src/dev/gallery/`, `npm run test:visual`) captures them, under
   the real `ThemeProvider`, no backend. See "Composition with the gallery."

---

## The method (5 phases)

### Phase 0 — Brief + Design Read (shared across all variants)

1. Restate the surface and its **intent** in 2–3 lines: what is the user here to do, who
   is the audience (life scientists — refined/precise, not flashy), what must this screen
   make obvious. This is the **rubric's north star** in Phase 3.
2. Produce one **Design Read** line (per `design-taste-frontend` §0.B):
   *"Reading this as: <surface kind> for <audience>, bench-notebook language, on the ziee
   kit, leaning <constraint>."*
3. List the **content inventory** (every real block the surface must contain) and the
   **hard constraints** (must fit mobile, AA contrast, reduced-motion, accent-driven).
   All three variants render the **same content** — only the treatment differs, so the
   judge compares directions, not scope.

### Phase 1 — Generate N=3 distinct on-system variants

Choose **three genuinely different directions** before coding. A reliable spread for a
research-workbench surface:

- **Variant A — dense / utilitarian.** Information-forward, tight but rhythmic spacing,
  everything visible without scrolling, table/list-driven. For power users who want
  density. (Bench-notebook default leans here.)
- **Variant B — spacious / editorial.** Generous whitespace, strong type hierarchy
  (Space Grotesk display + deliberate scale), one primary action per view, progressive
  disclosure. For first-run / marketing / calm.
- **Variant C — card-driven / modular.** Content grouped into scannable cards/tiles with
  clear affordances, good for heterogeneous content and empty states.

(These are defaults — pick the three that actually fit the brief. E.g. a wizard might be
*linear-stepper* vs *single-scroll* vs *split-pane*. The requirement is three
*distinct* layout/aesthetic hypotheses, each defensible.)

Build each as a **self-contained component** rendered in the gallery:

- File each variant under `src/dev/gallery/tournament/` (dev-only, never ships) as e.g.
  `OnboardingVariantA.tsx`, and register a story section
  (`gallery-section-tournament-onboarding-a`) so it screenshots on the standard path.
- Use only `@/components/ui` + tokens. Run `shadcn-component-review` on each and fix
  drift before screenshotting.
- Keep them comparable: same content, same viewport target, same theme/accent cell for
  the judged shot (default `desktop` + `light` + default accent; add `dark`/`mobile`
  cells only if the brief hinges on them).

### Phase 2 — Render + screenshot each variant

Reuse the existing gallery screenshot machinery — do **not** invent a new capture path.

```bash
cd src-app/ui
# Boots the backend-free gallery Vite server and drives Playwright (no Postgres, no cargo run).
npm run test:visual              # captures gallery-section-* PNGs incl. the tournament sections
# Screenshots land under tests/e2e/visual/**/*-snapshots/ keyed by section-viewport-theme-accent.
```

If you want just the tournament sections (faster), pass a section/grep filter to the
visual spec, or point Playwright at `/dev-gallery.html?theme=light&accent=<default>` and
screenshot the `gallery-section-tournament-*` testids directly. Either way you end with
**one PNG per variant** for the judged cell (plus optional dark/mobile PNGs).

Sanity-gate before judging: each variant must also pass **Layer A** (`assertLayoutSane` +
axe — no overflow, no collisions, AA, focus rings). A variant that fails Layer A is
**disqualified and regenerated**, not sent to the judge — the tournament compares *good*
executions, not one broken and two fine.

### Phase 3 — Vision judge (Opus) scores + picks a winner

**The judge is you, reading the screenshots as images via the Read tool** (Opus vision),
in this session — not `visual-judge.mjs`'s defect-triage rubric, not the text bridge, not
the local engine. Read each variant's PNG and score it. (For a scripted/batched or
cross-cell run, `scripts/visual-judge.mjs`'s model-call plumbing is the reference
harness — but its rubric is *defect triage for one design*; the tournament needs the
*comparative scoring* rubric below. Keep them distinct.)

Score **each screenshot** on this rubric (0–5 each; note the reason per axis):

| Axis | What the judge looks for |
|---|---|
| **Brief fit** | Does the layout serve the Phase-0 intent + audience? Is the primary action/first task obvious? (highest weight) |
| **Hierarchy** | Deliberate type scale; the eye lands on the right thing first; headings clearly above body; nothing default/untuned. |
| **Alignment** | Shared edges; no ragged groups; controls in a row align; grid reads as intentional. |
| **Spacing / density** | Consistent 2/4px rhythm; density matches the audience; no cramped or lopsided gaps; breathing room where it counts. |
| **Taste / polish** | Reads as designed, not templated or AI-default; restrained, on-brand motion; empty/loading states handled. |
| **System consistency** | On the ziee "bench-notebook" identity: single accent, tokenized color, kit components, AA contrast in the judged theme(s). |

Then produce a **verdict**:

- A short table of per-variant scores (per axis + total).
- The **winner** with a 2–4 sentence rationale grounded in *what is visible in the
  screenshot* ("Variant B's single-column editorial scale makes the one primary action
  unmistakable; A buries it in a toolbar").
- For each **runner-up**, name **1–3 specific local ideas worth stealing** ("C's card
  empty-state is clearer than B's blank panel"; "A's dense summary strip is a better
  header than B's").

Judge discipline: evaluate against the brief, not against your own taste; only cite
things actually visible; conservative on subjective brand calls, decisive on
hierarchy/alignment/spacing/contrast.

### Phase 4 — Synthesize the winner (graft the best of the runners-up)

Do **not** ship the raw winner. Build the **final** component from the winner's structure,
grafting the specific runner-up ideas the judge flagged:

1. Start from the winning variant's layout.
2. Fold in each stolen idea, keeping the winner's overall language coherent (don't
   Frankenstein — each graft must feel native).
3. Move the final component out of `src/dev/gallery/tournament/` into its real home in the
   app (real module/route), wired to real data/stores per the meta-framework patterns.
4. Run `shadcn-component-review` once more on the synthesized result; re-screenshot it in
   the gallery and Layer-A it. Optionally re-judge the synthesized shot against the
   winning variant to confirm the graft was a net improvement, not a regression.

### Phase 5 — Output

Deliver:

1. **The final on-system component** (synthesized, in its real location, drift-clean,
   Layer-A green).
2. **The judge's rationale**: the score table, the winner + why, and which runner-up
   ideas were grafted in (and where).
3. **Provenance note**: keep the three variant files in `tournament/` (or delete them per
   the user's call) and note the screenshots' location so the decision is reviewable.

Then **clean up**: the `tournament/` gallery sections are dev-only; either leave them
behind a clear `tournament-*` prefix or remove them once the winner is synthesized — they
must never leak into the shipped app or the visual-regression baseline as permanent noise.

---

## Composition with the gallery (rendering backbone)

This skill does **not** build its own renderer. It rides the existing visual-testing
system (`src-app/ui/src/dev/gallery/`, documented in that dir's `README.md`):

- **Where variants live:** a dev-only `tournament/` area whose components are registered
  as gallery story sections (`gallery-section-tournament-<surface>-<variant>`), rendered
  under the real `ThemeProvider` at `/dev-gallery.html?theme=&accent=` — **no backend, no
  Postgres, no `cargo run`.**
- **How they're captured:** the same Playwright path Layer A/B use (`npm run test:visual`),
  so screenshots are deterministic and theme/accent-addressable (the `desktop/light` cell
  by default; `dark`/`mobile`/accent cells on demand).
- **Why:** identical render + capture surface for all three variants means the judge
  compares *design*, not rendering artifacts, and the whole thing runs offline for the
  cost of a Vite boot.

If a surface genuinely can't be expressed as an isolated gallery section (needs live
routing/state to be judged fairly), a **temporary `/dev/preview/<surface>` route** gated on
`import.meta.env.DEV` is the fallback — same screenshot approach, torn down after.

---

## Worked example

**Brief:** "Design the new first-run onboarding wizard for ziee. It has to walk a new admin
through: enable memory, pick an embedding model, enable web/lit search, invite users. Make
it feel like a confident research tool, not a SaaS funnel. Give me three directions and
pick the best."

**Phase 0 — Design Read:** *"Reading this as: first-run admin onboarding for a
life-science research workbench, bench-notebook language, on the ziee kit, leaning calm +
confidence-building over funnel-y."* Content inventory: 4 setup steps + a welcome + a
finish. Constraints: mobile, AA, reduced-motion, accent-driven, resumable.

**Phase 1 — three directions:**
- **A — linear stepper:** classic numbered stepper rail on the left, one step per view,
  dense form on the right. Utilitarian, familiar.
- **B — single-scroll editorial:** one long calm page, big Space-Grotesk section headers,
  each setup block revealed in sequence, one primary CTA at a time. Spacious.
- **C — card checklist:** a "setup checklist" of cards the admin can complete in any
  order, each card expanding inline. Modular, non-linear.

Each built from `@/components/ui` (Steps/Card/Form/Select/Button…), reviewed with
`shadcn-component-review`, registered as `gallery-section-tournament-onboarding-{a,b,c}`.

**Phase 2 — render:** `npm run test:visual` → three PNGs (desktop/light), all Layer-A
green.

**Phase 3 — judge (Opus reads the three PNGs):**

| Variant | Brief fit | Hierarchy | Align | Spacing | Taste | System | Total |
|---|---|---|---|---|---|---|---|
| A dense stepper | 3 | 3 | 4 | 3 | 3 | 4 | 20 |
| **B editorial** | **5** | **5** | 4 | **5** | 4 | 4 | **27** |
| C card checklist | 4 | 3 | 4 | 4 | 4 | 4 | 23 |

*Winner: B.* "B's single-column editorial scale makes each setup decision feel considered
and the one primary action per view unmistakable — it reads as a confident tool, exactly
the brief. A feels like a form to get through; C's any-order freedom undercuts the
guided-first-run intent." Steal from **C**: its per-step *completion check* affordance
(clear done/not-done state) is better than B's implicit progress. Steal from **A**: its
compact left rail as a *persistent progress indicator* alongside B's scroll.

**Phase 4 — synthesize:** B's editorial single-scroll + C's explicit per-step completion
checks + a slim A-style progress rail pinned as you scroll. Moved to the real
`getting-started` onboarding route, wired to the real settings stores, re-reviewed,
re-shot, Layer-A green.

**Phase 5 — output:** final wizard component + the table above + "grafted C's completion
checks and A's progress rail into B."

---

## Anti-patterns

- **Running it on a maintenance edit.** If the layout is already decided, this is waste.
  Use `design-taste-frontend` / just edit.
- **Three variants that are the same layout in different paddings.** If the judge can't
  tell them apart structurally, you didn't generate variants — regenerate for real spread.
- **Off-system variants.** A variant that wins by breaking the design system is
  disqualified — you'd be shipping drift. On-system is a precondition, not a scoring axis
  you can trade away.
- **Judging code or a text description.** The judge must see rendered pixels. Reading JSX
  and imagining the result defeats the entire point.
- **Using the text bridge / local LLM as the judge.** They can't see layout. Vision judge
  = Claude/Opus, always.
- **Shipping the raw winner without synthesis.** The graft step is where the measurable
  lift is; skipping it throws away two-thirds of the work.
- **Leaving `tournament/` sections in the shipped app or the visual baseline.** Dev-only,
  cleaned up after.
- **Auto-running it.** On demand only. It costs three implementations + a vision pass;
  spend that budget deliberately.
