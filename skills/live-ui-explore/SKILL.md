---
name: live-ui-explore
description: Exploratory UI auditor — a vision-driven agent that pokes at a running app with no prior knowledge of it, uses features for real, and tries to break them.
---

# live-ui-explore

An unattended UI auditor that behaves like a **curious user who has never seen
the app**. It is given no route list, no selectors, no journeys and no feature
names; it looks at a screenshot, decides one thing to do, does it, and watches
what happens.

## Why not a scripted crawler or scripted journeys

The predecessor (`live-ui-audit`) drove a hardcoded route list. Of its 19
interactions, ~17 were the chat composer — so across 149 cycles it **rendered**
`/projects`, `/knowledge` and `/settings/users` but never created a project,
added a group or scheduled a task. Write paths, form validation, optimistic
update and sync fan-out were never exercised once.

Scripted journeys would not fix that. A journey only finds bugs in the path
someone thought to script — the same failure mode as a hand-written
static-analysis guard, which this repo has now paid for twice (the activity
rail's 20 non-converging audit rounds, and `gate-ui`'s port guard). The fix is to
stop enumerating and start exploring.

## How it works

**Set-of-marks.** Asking a model for click coordinates is unreliable. Each step:
enumerate interactive elements with a generic HTML/ARIA selector (`button`,
`a[href]`, `input`, `[role=button]`, `[contenteditable]`, …), draw a numbered
badge over each, screenshot, and let the model name a badge number. The selector
list contains nothing app-specific.

**Fixed action vocabulary:** `click`, `type`, `press`, `scroll`, `back`, `goto`,
`done`. `goto` accepts only a link the page actually offered, so it cannot invent
URLs.

**Two independent finding sources, never conflated:**

| source | examples | label |
|---|---|---|
| deterministic detectors | uncaught exception, HTTP 5xx, console error, failed request, blank page after an action, a visible enabled control that cannot be used, **a chat tool call that failed to run** | `machine-verified` |
| the model's own eyes | spinner that never resolves, dialog with no exit, text overflowing its box | `MODEL VISION ONLY (unverified)` |

Only machine-verified findings reach the ledger. A model-only finding is never
presented as fact.

**Reproducibility.** Exploration is stochastic, so every step records its action,
pre-action screenshot, URL, and console/network events. A finding carries the
trace that produced it.

## Running it

```bash
# one bounded run
node explore.mjs --url=http://127.0.0.1:1520 --user=admin --password=pw --steps=45

# continuous
STEPS=45 INTERVAL=45 bash explore-loop.sh
```

Model comes from `EXPLORE_MODEL` / `EXPLORE_LLM_URL` (defaults to a local
OpenAI-compatible bridge). Any vision-capable chat endpoint works.

## Two things that are load-bearing

**Pristine DB restore every cycle.** The explorer is *supposed* to delete things
and wander into settings, so without a restore, cycle 2 explores a wrecked app
and within ~20 cycles it has changed the admin password and locked itself out.
`explore-loop.sh` clones a pristine template before each cycle. The predecessor
never needed this because it never mutated anything — which was its defect.

**Signal hygiene.** Measured on the first live cycle: 10 of 14 findings were
noise. Two filters fixed it, and both are narrow on purpose:

- `ERR_ABORTED` on a *streaming* endpoint is dropped — navigating away from a
  page holding an EventSource always aborts it. A genuine stream failure still
  reports.
- A `type` aimed at a non-editable element is skipped and logged, not recorded.
  That is the explorer mis-aiming, not an app defect, and it was burying the real
  findings.

## Tool calls: the one failure the browser cannot show you

Every other detector watches the browser, and a failing chat tool call trips
none of them — HTTP 200, no console error, no exception, the page renders, and
the activity rail draws a non-zero exit as a *successful* step on purpose. The
failure lives entirely inside the response payload, so `tool-result-detector.mjs`
reads the payload: `explore.mjs` walks every `/api/` JSON body for `tool_result`
blocks. That is how the rig watched the model use a sandbox whose `bwrap` could
not find its rootfs and reported nothing for its entire run.

**A non-zero exit is not a defect.** The model runs failing commands deliberately.
The line is *whose fault it was*, and it is drawn structurally, calibrated against
372 real result blocks from the live rig:

- a **completed exec payload** (`{stdout, stderr, exit_code}`) is the command's own
  business — reported only when the *runner* is speaking where the command should
  be (non-zero exit, no stdout, stderr opening `bwrap:`/`squashfuse:`/…);
- an `is_error` result is reported only when the dispatcher had to **synthesize**
  it (`helpers.rs::execute_tool`'s `Tool execution failed/timed out` arms), a
  server **was** resolved, no structured payload came back, and the JSON-RPC code
  is not in the spec's caller range (`-32600..-32602`, `-32700`).

Everything else stays silent: a refused bad request, a tool name the model
invented, a policy skip, `run_js` running the caller's own broken script. On that
corpus the rule reports 48 blocks and all 48 are one genuine defect — a built-in
MCP server that has answered nothing on every call. Severity escalates to HIGH
when a tool has failed three times in a cycle and never once succeeded;
cross-cycle recurrence is left to the ledger rather than counted twice.

`node --test tool-result-detector.test.mjs` — the negative controls are the point
of that file.

Cross-cycle dedup is by a fingerprint that normalises **only** volatile
identifiers (uuids, bare numbers) — never whole messages. An over-broad key
silently collapses distinct defects into one, which is how the predecessor's
dedup under-reported by ~99×.

## Known limits

- Broad but shallow at ~45 steps/cycle; it will not complete a long multi-stage
  flow in one pass.
- Login is done mechanically by the harness. That is the one piece of app
  knowledge here, and it is deliberate: the auth wall is the precondition for
  exploring, not something worth rediscovering every cycle.
- The model occasionally mis-aims an action; the guard above absorbs the common
  case rather than pretending it does not happen.
