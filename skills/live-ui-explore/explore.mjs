#!/usr/bin/env node
/**
 * live-ui-explore — an EXPLORATORY UI auditor with eyes.
 *
 * ## What makes this different from a scripted crawler
 *
 * The predecessor (`live-ui-audit`) drove a hardcoded route list with hardcoded
 * selectors. Of its 19 interactions, ~17 were the chat composer, so in 149
 * cycles it never once created a project, added a user group, or scheduled a
 * task — it only ever RENDERED those pages. A scripted journey would not have
 * fixed that: it finds bugs only in the paths someone thought to script, which
 * is the same failure mode as a hand-written static-analysis guard (see the rail
 * audit's 20 non-converging rounds, and `gate-ui`'s port guard).
 *
 * So this driver is given NO app knowledge at all:
 *   - no route list — it discovers navigation by looking
 *   - no selectors — affordances are enumerated from generic HTML/ARIA
 *   - no journeys, no expected outcomes, no feature names in the prompt
 *
 * It is told only that it is a curious user poking at an unfamiliar app and
 * trying to break it.
 *
 * ## How it sees and acts (set-of-marks)
 *
 * Asking a model for raw click coordinates is unreliable. Instead, each step:
 *   1. enumerate interactive elements with a GENERIC selector (button, a[href],
 *      input, [role=button], [contenteditable], …) — no app-specific knowledge;
 *   2. draw a numbered badge over each one, in-page, and screenshot;
 *   3. the model replies with ONE action naming a badge number;
 *   4. execute it, then let the detectors observe the consequences.
 *
 * The model picks from a fixed, app-agnostic vocabulary: click, type, press,
 * scroll, back, goto_discovered (only a URL it SAW on the page), done.
 *
 * ## What counts as a finding
 *
 * Two independent sources, deliberately:
 *   - DETERMINISTIC detectors (uncaught exceptions, console errors, failed
 *     requests, HTTP 5xx, dialogs, blank-page-after-action). These need no
 *     model and cannot hallucinate.
 *   - The model's own VISUAL judgement ("this looks broken / stuck / wrong"),
 *     which catches what a detector cannot: a spinner that never resolves, a
 *     dialog with no way out, text overflowing its box.
 * A model-only finding is labelled as such so it is never mistaken for a
 * machine-verified one.
 *
 * ## Reproducibility
 *
 * Exploration is stochastic, so a finding nobody can reproduce is an anecdote.
 * Every step records: the action taken, the pre-action screenshot, the URL, and
 * any console/network events. A finding carries the full step trace that led to
 * it, so it can be replayed by hand.
 *
 * ## State
 *
 * A curious user WILL delete things and WILL wander into settings and change the
 * admin password, locking the harness out. The runner (`explore-loop.sh`)
 * therefore restores a pristine DB before every cycle. This script assumes that
 * has happened and does not defend against its own destructiveness — that is the
 * point of it.
 *
 * Usage:
 *   node explore.mjs --url=http://127.0.0.1:1520 --user=admin --password=pw \
 *                    [--steps=40] [--out=DIR] [--model=…] [--headed]
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const BASE = arg('url', 'http://127.0.0.1:1520').replace(/\/$/, '')
const USER = arg('user', 'admin')
const PASS = arg('password', 'password123')
const STEPS = Number(arg('steps', 40))
const OUT = arg('out', `/data/pbya/ziee/tmp/live-ui-explore/run-${Date.now()}`)
const MODEL = arg('model', process.env.EXPLORE_MODEL || 'qwen3.6-35b-a3b')
const LLM = (process.env.EXPLORE_LLM_URL || 'http://localhost:4000/v1') + '/chat/completions'
const HEADED = process.argv.includes('--headed')
// Coverage memory ACROSS cycles. Without it every cycle restarts at "/" and
// re-treads whatever is nearest — measured over 304 runs: /knowledge 158 visits
// and /chat 132, against /scheduled-tasks 22 and /settings/assistants 14. The
// file is written by this script and read by the next run; the routes in it are
// ones the app itself offered, never a hardcoded list.
const COVERAGE = arg('coverage', '/data/pbya/ziee/tmp/live-ui-explore/coverage.json')
// Is this URL part of the app we are auditing, or somewhere else entirely?
//
// This check was missing, and it saturated the whole rig. The explorer follows
// links like a user does, so it eventually clicked an outbound one (a GitHub
// readme link, an IANA reference) and landed on a third-party site. routeOf()
// strips the origin, so EVERY link on that foreign page was recorded as a ziee
// route: 132 of 167 ledger entries turned out to be iana.org paths.
//
// The damage is not the junk itself, it is that leastVisited() sorts ASCENDING,
// so freshly-discovered foreign routes (0 visits) outranked every real one. All
// eight "areas you have explored LEAST - prefer these" slots were foreign, and
// 17 of 20 cycles opened at /go/rfc2606. The SPA fallback answers 200 for any
// unknown path, so nothing ever surfaced the mistake: those pages simply had no
// app on them, and therefore no endpoints to reach.
const sameOrigin = (u) => sameOriginOf(u, BASE)
// Resolve `u` against `base` and ask whether the result is still OUR origin.
// The base matters: a relative href must be resolved against the page currently
// showing it, not against BASE, or every foreign site's nav bar reads as ours.
const sameOriginOf = (u, base) => {
  try { return new URL(String(u), base).origin === new URL(BASE).origin }
  catch { return false }
}
const routeOf = u => {
  const path = String(u).replace(/^https?:\/\/[^/]+/, '') || '/'
  const seg = path.split('?')[0].split('/').filter(Boolean)
  // collapse ids so /knowledge/<uuid> counts as /knowledge/:id, not 40 routes
  return '/' + seg.map(x => (/^[0-9a-f-]{16,}$/i.test(x) ? ':id' : x)).slice(0, 2).join('/')
}
let coverage = {}
try { coverage = JSON.parse(readFileSync(COVERAGE, 'utf8')) } catch { coverage = {} }

mkdirSync(OUT, { recursive: true })
mkdirSync(join(OUT, 'shots'), { recursive: true })
const findings = []
const steps = []
// Feature areas of the app whose API the rig has NEVER exercised, named in the
// app's own vocabulary (the resource segment of its own OpenAPI paths), ranked by
// how much is left untouched. This says WHAT is unexplored, never how to get
// there — the explorer still has to find the way by looking.
const untouchedAreas = () => {
  const out = []
  for (const [g, eps] of declaredGroups) {
    const miss = [...eps].filter(e => !apiSeen.has(e)).length
    if (miss) out.push([g.replace(/^\/api\//, ''), miss])
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g, n]) => `${g} (${n} unused)`)
}
const leastVisited = () => Object.entries(coverage)
  .filter(([r]) => r !== '/' && !r.includes(':id'))
  .sort((a, b) => a[1] - b[1]).slice(0, 8).map(([r]) => r)
const discoveredRoutes = new Set()

// ---------------------------------------------------------------------------
// NOVELTY MEMORY — per-affordance, persistent across cycles.
//
// Route-level hinting already existed and is not the bottleneck: the prompt has
// carried "prefer the areas you have explored LEAST" on every step from the
// start, and each cycle already STARTS at the least-visited route. After 41
// cycles the rig had still seen 13 of the app's 73 routes, and 0 discovered
// routes were unvisited — the hint was working perfectly on a list of 13.
//
// A page-level exhortation cannot tell the model WHICH of 60 badges is new, so
// it re-clicks the same handful. This records the individual controls it has
// operated and marks the untouched ones, which is a signal it can act on. The
// signature is the app's own accessible description of the control, never a
// badge index (reassigned every step) or a position (moves on reflow).
const AFFORDANCES = arg('affordances', '/data/pbya/ziee/tmp/live-ui-explore/affordances.json')
let tried = {}
try { tried = JSON.parse(readFileSync(AFFORDANCES, 'utf8')) } catch { tried = {} }
// Only THIS run's increments, so the merge below adds rather than overwrites.
const triedDelta = {}
const sigOf = (url, el) =>
  `${routeOf(url)}|${(el.tag || '?').toLowerCase()}${el.role ? ':' + el.role : ''}|${(el.label || '').trim().slice(0, 40).toLowerCase()}`

// ---------------------------------------------------------------------------
// SINK LEDGER — routes that consume steps without ever yielding new ground.
//
// /onboarding took 368 visits, 21% of all recorded activity, while total route
// discovery sat at 13. A route that expensive and that unproductive is a trap,
// and no amount of prompt encouragement escapes it, because the model does not
// experience the cost across cycles — only the ledger does.
// ---------------------------------------------------------------------------
// ENDPOINT GRADIENT — the objective, fed back to the agent.
//
// Measured over 103 cycles: +3.41 new CONTROLS per cycle but only +0.25 new
// ENDPOINTS. The novelty memory works exactly as designed and is optimising the
// wrong quantity — new buttons on pages whose API surface is already exhausted.
// Nothing in the loop ever told the explorer what "new ground" actually means.
//
// This is NOT the predecessor's hardcoded route list. That was a human writing
// down where to go, which is why it only ever tested the chat composer. This is
// derived at runtime from the app's OWN OpenAPI spec intersected with the rig's
// OWN history, it updates itself as coverage moves, and it names only WHAT is
// untouched — never how to reach it. The explorer still has to find the path by
// looking, which is the property worth protecting.
const OPENAPI = arg('openapi', '/data/pbya/ziee/tmp/live-rig-wt/src-app/ui/openapi/openapi.json')
let declaredGroups = new Map()   // "/api/voice" -> Set of "METHOD /api/x/{}"
try {
  const spec = JSON.parse(readFileSync(OPENAPI, 'utf8'))
  for (const [p, ops] of Object.entries(spec.paths || {})) {
    for (const m of Object.keys(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue
      const g = p.split('/').slice(0, 3).join('/')
      if (!declaredGroups.has(g)) declaredGroups.set(g, new Set())
      declaredGroups.get(g).add(`${m.toUpperCase()} ${p.replace(/\{[^}]+\}/g, '{}')}`)
    }
  }
} catch { /* no spec → the hint degrades to nothing, the rig still explores */ }

const SINKS = arg('sinks', '/data/pbya/ziee/tmp/live-ui-explore/sinks.json')
let sinks = {}
try { sinks = JSON.parse(readFileSync(SINKS, 'utf8')) } catch { sinks = {} }
const SINK_MIN_STEPS = 40      // enough evidence to judge
// A route is a sink only when it yields NOTHING NEW — neither a route nor an
// untried control.
//
// Keying on new ROUTES alone was wrong, and wrong in a way that got worse over
// time: as discovery saturates, every page stops revealing new routes, so the
// whole app classifies as a sink and the explorer refuses to start anywhere and
// bails after five steps. It had already mislabelled /settings/general,
// /settings/assistants, /hub/assistants and /notifications — real pages, full of
// untried controls, whose only sin was linking nowhere new.
// A page whose controls are all exhausted AND that links nowhere new is genuinely
// spent; that is the condition worth acting on.
// Measured over a RECENT window, not a lifetime total. Cumulative counters do not
// decay: once a route had ever produced anything it could never be judged spent,
// and once it had produced nothing it could never be redeemed after the app's
// state changed underneath it. `barren` is consecutive steps on that route
// yielding nothing new, and it resets the moment the route pays out again.
const isSink = (r) => (sinks[r]?.barren || 0) >= SINK_MIN_STEPS
// Every API call the app makes, normalised to an openapi-style template so it
// can be diffed against the spec. Route coverage is a weak proxy for what the
// app actually exercises — two pages can look "visited" while never triggering a
// write. This is the real coverage number.
let newEndpointsThisStep = 0   // reset per step; drives the payout signal
// FOLLOW-THROUGH. Measured across 226 untouched endpoints, the largest class (71)
// is "parent entity + second-step action" — and the rig had created 132 knowledge
// bases and uploaded 94 files while never once putting a file INTO a base. It
// reliably finds the entry action of a feature and stops there, because creating
// is easy to discover and using is one affordance deeper.
//
// So count what it makes versus what it then does with it, and say so. This is a
// statement about its own behaviour, not about ziee: "you keep making things and
// never using them" needs no knowledge of what the things are.
const created = []          // {kind, at} — successful creating POSTs this cycle
const usedExisting = []     // successful writes against an EXISTING entity
const apiHits = new Map()   // "METHOD /api/x/{id}" -> count (attempted)
const apiOutcomes = new Map() // "METHOD /api/x/{id}" -> {ok, c4, c5} (what came back)
const API_COVERAGE = arg('api-coverage', '/data/pbya/ziee/tmp/live-ui-explore/api-coverage.json')
// Cumulative endpoint history, loaded at START (it was previously only read at
// the end, to merge). The explorer needs to know what PRIOR cycles reached, or
// every cycle re-derives the same gradient from an empty set.
let apiSeen = new Set()
try {
  for (const k of Object.keys(JSON.parse(readFileSync(API_COVERAGE, 'utf8'))))
    apiSeen.add(k.replace(/\{[^}]+\}/g, '{}'))
} catch { /* first run */ }
const templatize = u => {
  const path = String(u).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  return path.split('/').map(seg =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? '{id}'
    : /^\d+$/.test(seg) ? '{id}' : seg).join('/')
}
const log = m => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`
  console.log(line)
  appendFileSync(join(OUT, 'explore.log'), line + '\n')
}

// ---------------------------------------------------------------------------
// GENERIC affordance enumeration + numbered overlay (set-of-marks).
// The selector list is plain HTML/ARIA. Nothing here knows what this app is.
// ---------------------------------------------------------------------------
const MARK_SCRIPT = `(() => {
  // Remove the badge DIVs *and* clear the marked-attributes from the previous
  // enumeration. Clearing the attributes is the load-bearing half: indices are
  // reassigned from 0 each time, so a leftover data-explore-marked="5" on an
  // old node makes the selector match TWO elements, and .first() picks the
  // stale (often detached) one — which then times out. That manufactured 458
  // false interaction-failed findings overnight, on buttons that click in
  // 29-67ms by hand.
  document.querySelectorAll('[data-explore-mark]').forEach(n => n.remove());
  document.querySelectorAll('[data-explore-marked]').forEach(n => n.removeAttribute('data-explore-marked'));
  // Controls that are interactive BY DEFINITION — native elements and ARIA roles
  // whose whole purpose is to be operated. This list is pure HTML/ARIA semantics:
  // it says nothing about this particular app, which is the property that keeps
  // the explorer a clueless user rather than a scripted tour.
  //
  // The second half of this list was missing, and measurably so: a coverage pass
  // found combobox / listbox / treeitem / slider / spinbutton / summary controls
  // rendered and never offered as candidates. The explorer was not declining to
  // open selects, trees and disclosures — it could not see them.
  const SEL = [
    'button', 'a[href]', 'input', 'textarea', 'select', 'summary',
    '[role=button]', '[role=tab]', '[role=menuitem]', '[role=option]',
    '[role=switch]', '[role=checkbox]', '[role=radio]', '[role=link]',
    '[role=combobox]', '[role=listbox]', '[role=treeitem]', '[role=slider]',
    '[role=spinbutton]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=searchbox]', '[role=textbox]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  // Cell-like elements are a different case. A table renders ~36 visible cells per
  // page and MOST DO NOTHING when clicked, so adding td,th outright would spend
  // a 45-step budget on no-ops and look like coverage while teaching nothing.
  // Offer one only when the app itself presents it as clickable — an inherited
  // cursor:pointer is the app's own declaration of intent, and reading it is
  // still generic CSS, not app knowledge.
  const SEL_CELL = 'td,th,[role=gridcell],[role=row],[role=treeitem],li';
  const presentsAsClickable = el => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).cursor === 'pointer') return true;
      if (a.matches('table,[role=grid],[role=treegrid],ul,ol')) break;
    }
    return false;
  };
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    if (el.disabled) return false;
    // HIT-TEST. Visible-and-sized is not the same as clickable: when a modal is
    // open every control BEHIND it still passes the checks above, so they get
    // marked, the model picks one, and Playwright waits the full timeout for an
    // element that can never receive the event. That was the entire residual
    // interaction-failed class — including clicks on the chat composer, which
    // obviously works. It also explains narrow coverage: with a dialog open the
    // explorer kept choosing unreachable things instead of the dialog's own
    // controls.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    // Accept only: the point resolves to THIS element, or to a descendant of it
    // (a span inside a button). An ANCESTOR is a rejection, not a pass — that
    // was an escape hatch: a hover-gated control inside
    // div.row-actions{opacity:0;pointer-events:none} resolves to its ancestor,
    // so hit.contains(el) waved it through and every click on it timed out.
    if (hit !== el && !el.contains(hit)) return false;
    // Effective, inherited properties — not the element's own. opacity and
    // pointer-events both cascade in effect: a control with opacity:1 inside an
    // opacity:0 wrapper is invisible and unclickable, and reading only the
    // element lied about both.
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.pointerEvents === 'none') return false;
      if (Number(as.opacity) < 0.05) return false;
      if (as.visibility === 'hidden' || as.display === 'none') return false;
    }
    return true;
  };
  const out = [];
  let i = 0;
  // ORDER IS LOAD-BEARING. The dedupe rule below drops an element that already has
  // a marked ANCESTOR, and a <tr>/<li> precedes its own buttons in document order.
  // Iterating one combined query would therefore mark the row first and suppress
  // the Edit/Delete buttons inside it — the highest-value controls on a list page.
  // Definitionally-interactive controls claim their slot first; cell-like
  // containers only pick up what is left.
  const primary = [...document.querySelectorAll(SEL)];
  const cells = [...document.querySelectorAll(SEL_CELL)]
    .filter(el => !el.matches(SEL) && presentsAsClickable(el));
  // PAGE CHROME GOES LAST. The badge budget below is a hard 60, and it used to be
  // spent in document order — where nav, sidebar and header come first. Measured
  // on /settings/users: 118 visible affordances, 60 badges, so 58 were never
  // offered, and always the SAME 58, because document order does not change
  // between cycles. Those 58 are the main content: the table rows, the row
  // actions, the create button. That is a far bigger constraint on coverage than
  // any selector gap, and it explains a rig that renders pages without operating
  // them. Landmarks are generic ARIA, so this stays app-agnostic.
  //
  // But chrome must NOT be starved to zero. Ranking it strictly last did exactly
  // that: on a 97-affordance page all 60 badges went to content and the sidebar
  // got none, so the explorer could no longer navigate AWAY from that page. That
  // trades breadth for depth, and breadth is the scarcer resource here — across
  // 41 cycles it discovered 13 of the app's 73 routes. So reserve a slice of the
  // budget for navigation: content gets first call on most slots, chrome keeps
  // enough to always offer a way out.
  const isChrome = el => !!el.closest('nav,aside,header,footer,[role=navigation],[role=banner],[role=complementary],[role=contentinfo]');
  const CHROME_RESERVE = 15;
  const split = list => [list.filter(el => !isChrome(el)), list.filter(isChrome)];
  const [pc, pch] = split(primary);
  const [cc, cch] = split(cells);
  const content = [...pc, ...cc];
  const chrome = [...pch, ...cch];
  const ordered = [
    ...content.slice(0, Math.max(0, 60 - Math.min(CHROME_RESERVE, chrome.length))),
    ...chrome.slice(0, CHROME_RESERVE),
    ...content.slice(Math.max(0, 60 - Math.min(CHROME_RESERVE, chrome.length))),
    ...chrome.slice(CHROME_RESERVE),
  ];
  for (const el of ordered) {
    if (!vis(el)) continue;
    // skip an element whose interactive ancestor is already marked (avoid dupes)
    if (el.closest('[data-explore-marked]') && el.closest('[data-explore-marked]') !== el) continue;
    el.setAttribute('data-explore-marked', String(i));
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                   el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 60);
    const editable = el.matches('input,textarea,[contenteditable="true"]') &&
                     !['checkbox','radio','submit','button','file'].includes(el.type);
    out.push({
      n: i, tag: el.tagName.toLowerCase(), type: el.type || null,
      role: el.getAttribute('role') || null, label, editable,
      href: el.getAttribute('href') || null,
    });
    const b = document.createElement('div');
    // Store the badge INDEX, not a constant flag: callers need to find one badge
    // by number (to recolour it). Teardown matches the bare attribute, so it is
    // unaffected by the value.
    b.setAttribute('data-explore-mark', String(i));
    b.textContent = String(i);
    b.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none',
      'background:#e11d48', 'color:#fff', 'font:bold 11px monospace',
      'padding:0 3px', 'border-radius:3px',
      'left:' + Math.max(0, r.left) + 'px', 'top:' + Math.max(0, r.top) + 'px',
    ].join(';');
    document.body.appendChild(b);
    i++;
    if (i >= 60) break;   // a screenshot with 200 badges is unreadable
  }
  // links the page offers, so the model can navigate only where it SAW it could
  const hrefs = [...new Set([...document.querySelectorAll('a[href^="/"]')]
    .map(a => a.getAttribute('href')).filter(Boolean))].slice(0, 25);
  return { elements: out, hrefs, url: location.href, title: document.title };
})()`

const unmark = `(() => document.querySelectorAll('[data-explore-mark]').forEach(n => n.remove()))()`

// ---------------------------------------------------------------------------
// model call
// ---------------------------------------------------------------------------
const SYSTEM = `You are a curious, slightly mischievous person poking at a web application you have never seen before. Nobody told you what it does.

Your goals, in order:
1. Work out what this app can do, by looking and clicking.
2. Actually USE it — create things, fill forms, upload, rename, toggle settings, submit. Reading pages teaches you nothing; a real user makes things happen.
3. Try to BREAK it. Empty submits, absurdly long text, weird characters, double-clicks, submitting a form with required fields blank, cancelling halfway, navigating away mid-save.
4. Report anything that looks broken to you.

Bias strongly toward parts of the app you have not touched yet. Do not sit on one page.

You are shown a screenshot with small red NUMBER badges overlaid on every element you can interact with, plus two lists: one of clickable elements and one of elements that accept typing. "type" works ONLY on a badge from the typeable list — aiming it at a button or a div does nothing and wastes your turn. If nothing on screen is typeable, click something first to open a form. Choose exactly ONE action.

Reply with ONLY a JSON object, no prose, no code fence:
{"reason":"<12 words on why>","action":"click|type|press|scroll|back|goto|done","n":<badge number, for click/type>,"text":"<for type>","key":"<for press: Enter|Escape|Tab>","href":"<for goto, MUST be one from the offered list>","broken":"<empty string, or what looks broken to you>"}

Set "broken" only when you can SEE something wrong: an error message, a spinner that never finishes, empty space where content belongs, text spilling out of its container, a dialog with no way to close it, a control that does nothing when used. Otherwise leave it as "".`

// Strip UNPAIRED UTF-16 surrogates before any text reaches the model.
//
// A lone surrogate makes the bridge's tokenizer reject the WHOLE request with
// `TextEncodeInput must be Union[TextInputSequence...]` — a 400, so the step is
// lost, and deterministic, so retrying cannot help (measured: 47 of 49 retrying
// calls exhausted all four attempts). It cost 17.5% of every step.
//
// Two sources, and the second is ours:
//   - the explorer types garbage BY DESIGN, the app stores it, and it comes back
//     as an element label in the very next prompt;
//   - `.slice(0, 60)` on a label truncates by UTF-16 CODE UNIT, so a label with
//     an emoji near the cut is severed mid-pair. We manufacture the bad input
//     ourselves, which is why this grew with the app's accumulated state.
//
// Applied at the single point where the prompt is assembled, so no future caller
// can route around it.
const stripLoneSurrogates = (t) =>
  String(t).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')

const retryStats = { calls: 0, callsNeedingRetry: 0, transient: 0, hardFail: 0 }
async function decide(ctx, shotB64) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    // Qwen-class reasoning models burn the whole budget inside `reasoning_content`
    // and then return an EMPTY `content` (measured: 20k chars of reasoning,
    // finish_reason=length, content 0 bytes — one step in ten lost). Thinking off
    // returns the decision directly and is far faster, so more steps per cycle.
    // Harmless on backends that ignore the field.
    chat_template_kwargs: { enable_thinking: false },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: stripLoneSurrogates(`${SYSTEM}\n\n--- CURRENT STATE ---\nurl: ${ctx.url}\ntitle: ${ctx.title}\nstep ${ctx.step} of ${STEPS}\n\nrecently tried (avoid repeating):\n${ctx.history || '(nothing yet)'}\n\nelements you can CLICK:\n${JSON.stringify(ctx.elements.filter(e => !e.editable))}\n\nelements you can TYPE into (only these accept "type" — typing into anything else does nothing):\n${JSON.stringify(ctx.elements.filter(e => e.editable))}\n\nlinks this page offers for "goto":\n${JSON.stringify(ctx.hrefs)}\n\nareas you have explored LEAST across all previous sessions (prefer these when you see a way to reach one):\n${JSON.stringify(ctx.leastVisited)}\n\nbadges you have NEVER used before, in any session — these are drawn GREEN in the screenshot, everything else is red. Strongly prefer one of these:\n${JSON.stringify(ctx.fresh || [])}\n\nFEATURE AREAS of this app you have NEVER exercised, worst first. Clicking new buttons on pages you already know teaches us nothing; REACHING these areas is the goal. If you can see any way toward one, take it:\n${JSON.stringify(ctx.untouchedAreas || [])}${ctx.followThrough ? `

FINISH WHAT YOU START. This session you have CREATED ${ctx.created.length} thing(s) but only acted on an existing one ${ctx.usedExisting.length} time(s). Making something is the easy half and teaches us almost nothing. A thing you just made is only interesting once you PUT SOMETHING IN IT, CONFIGURE IT, RUN IT, RENAME IT or DELETE IT. Before creating anything else, go back to something you already made and use it properly.
recently created: ${JSON.stringify(ctx.created)}` : ''}`) },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${shotB64}` } },
      ],
    }],
  }
  // RETRY with backoff, for genuinely transient failures only.
  //
  // NOTE: the 400 burst this was originally written for was NOT transient and NOT
  // concurrency — it was a lone surrogate in the prompt (see stripLoneSurrogates
  // above), which is deterministic, so 47 of 49 retrying calls exhausted all four
  // attempts and retrying bought nothing. Keep this for real transients (5xx,
  // 429, dropped connections); it is not a substitute for valid input.
  // Jittered, so N workers that collide do not retry in lockstep.
  let r, lastErr
  let attemptedHere = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) { attemptedHere++; await new Promise(res => setTimeout(res, 400 * 2 ** attempt + Math.floor(Math.random() * 400))) }
    try {
      r = await fetch(LLM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.EXPLORE_LLM_KEY ? { Authorization: `Bearer ${process.env.EXPLORE_LLM_KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      })
    } catch (e) { lastErr = e; continue }             // network/timeout
    if (r.ok) break
    lastErr = new Error(`model HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    retryStats.transient++
    if (r.status !== 400 && r.status !== 429 && r.status < 500) break   // a real client error: do not hammer
    r = undefined
  }
  if (attemptedHere) retryStats.callsNeedingRetry++
  retryStats.calls++
  if (!r || !r.ok) { retryStats.hardFail++; throw lastErr || new Error('model call failed') }
  const j = await r.json()
  const msg = j.choices?.[0]?.message ?? {}
  // A reasoning model can exhaust max_tokens inside `reasoning_content` and
  // return an EMPTY `content`. The decision is often already written in the
  // reasoning, so fall back to it rather than losing the step.
  const txt = (msg.content && msg.content.trim())
    ? msg.content
    : (msg.reasoning_content || msg.provider_specific_fields?.reasoning || '')
  const all = [...String(txt).matchAll(/\{[\s\S]*?\}/g)].map(x => x[0])
  for (const cand of all.reverse()) {           // last complete object wins
    try {
      const o = JSON.parse(cand)
      if (o && typeof o.action === 'string') return o
    } catch { /* keep looking */ }
  }
  throw new Error(`no usable JSON (finish=${j.choices?.[0]?.finish_reason}, ` +
                  `content=${(msg.content || '').length}b, reasoning=${String(msg.reasoning_content || '').length}b)`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: !HEADED })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

// Per-step event buffers. Cleared after each step so an event is attributed to
// the action that caused it, not to the whole run.
// http4xx is reset per step like everything else: it is the "did the server
// deliberately refuse THIS action" signal, so it must not leak across steps or
// it would quiet console errors belonging to a later, unrelated action.
let bus = { console: [], pageerror: [], reqfail: [], http4xx: [], http5xx: [], dialog: [], filechooser: [] }
const clearBus = () => { bus = { console: [], pageerror: [], reqfail: [], http4xx: [], http5xx: [], dialog: [], filechooser: [] } }
const NOISE = /favicon|\/@vite\/|__vite|sockjs|hot-update|ERR_ABORTED.*\.map/i
// A long-lived stream aborted by NAVIGATION is the browser working, not the app
// failing. Measured: 6 of 14 findings in cycle 1 were this one non-event. Scoped
// to ERR_ABORTED on streaming endpoints only, so a genuine stream failure still
// reports.
const BENIGN_ABORT = /ERR_ABORTED/i
const STREAMING = /\/(stream|subscribe|subscription|events|sse)(\/|\?|$)/i

page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) bus.console.push(m.text().slice(0, 300)) })
page.on('pageerror', e => bus.pageerror.push(String(e).slice(0, 300)))
page.on('requestfailed', r => {
  const err = r.failure()?.errorText || ''
  if (NOISE.test(r.url())) return
  if (BENIGN_ABORT.test(err) && STREAMING.test(r.url())) return
  bus.reqfail.push(`${r.method()} ${r.url().slice(0, 160)} — ${err}`)
})
page.on('request', r => {
  const u = r.url()
  if (!/\/api\//.test(u)) return
  const key = `${r.method()} ${templatize(u)}`
  apiHits.set(key, (apiHits.get(key) || 0) + 1)
  // Did THIS request reach ground no cycle has ever reached? That is the actual
  // objective, so it is what the harness must reward.
  if (!apiSeen.has(key)) { apiSeen.add(key); newEndpointsThisStep++ }
})
page.on('response', r => {
  const s = r.status()
  const u = r.url()
  if (/\/api\//.test(u)) {
    // Coverage counted on `request` answers "did the UI ever call this?" — which
    // is NOT the same as "does this work". An endpoint that only ever 404s or
    // 403s reads as covered. Recording the OUTCOME separates the two, so a
    // coverage number can be read as reached-and-worked rather than attempted.
    const key = `${r.request().method()} ${templatize(u)}`
    const o = apiOutcomes.get(key) || { ok: 0, c4: 0, c5: 0 }
    if (s < 400) o.ok++; else if (s < 500) o.c4++; else o.c5++
    if (s < 400 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.request().method())) {
      // A write to a COLLECTION makes something new; a write to a path that
      // already names an entity ({id} in it) acts on something that exists. The
      // second is the one that reaches the deep endpoints.
      const t = templatize(u)
      const isSecondStep = /\{id\}/.test(t)
      const bucket = isSecondStep ? usedExisting : created
      bucket.push(t.replace(/^\/api\//, ''))
    }
    apiOutcomes.set(key, o)
    // A 4xx in this step EXPLAINS a console error in the same step (see the
    // console-error classification below).
    if (s >= 400 && s < 500) bus.http4xx.push(`${s} ${r.request().method()} ${templatize(u)}`)
  }
  if (s >= 500) bus.http5xx.push(`${s} ${r.request().method()} ${u.slice(0, 160)}`)
})
// A native dialog blocks everything; accept so exploration continues, but record it.
page.on('dialog', async d => { bus.dialog.push(`${d.type()}: ${d.message().slice(0, 200)}`); await d.accept().catch(() => {}) })

// A file chooser is modal and invisible to the page, so an unanswered one makes
// the click look like a no-op and the explorer retries it forever. Answer every
// chooser with a small generated file: app-agnostic, and it is the only way the
// upload paths get exercised at all.
// A POOL of fixtures, not one file.
//
// Every upload used to be the same 1.1 KB text file, so 94 uploads exercised
// exactly one code path. Real ingest branches on type: a PDF goes to the text
// extractor, an image to a different renderer, an empty file to the validator, a
// large one to the size limit. Rotating the fixture per upload gets those
// branches for free — no app knowledge, just varied input, which is what a
// curious user with a Downloads folder would produce anyway.
const FIXTURE_DIR = '/tmp/live-ui-explore-fixtures'
try { mkdirSync(FIXTURE_DIR, { recursive: true }) } catch {}
const FIXTURES = []
const addFixture = (name, data) => {
  const f = join(FIXTURE_DIR, name)
  try { writeFileSync(f, data); FIXTURES.push(f) } catch {}
}
addFixture('notes.txt', 'live-ui-explore fixture\n' + 'lorem ipsum dolor sit amet\n'.repeat(40))
addFixture('data.csv', 'id,name,score\n' + Array.from({ length: 200 }, (_, i) => `${i},row-${i},${i * 7 % 101}`).join('\n') + '\n')
addFixture('config.json', JSON.stringify({ fixture: true, nested: { a: [1, 2, 3] }, note: 'live-ui-explore' }, null, 2))
addFixture('readme.md', '# Fixture\n\nA markdown fixture with a [link](https://example.invalid) and `code`.\n\n- one\n- two\n')
addFixture('empty.txt', '')                                    // zero-byte: validator path
addFixture('big.txt', 'x'.repeat(3 * 1024 * 1024))             // 3 MB: size-limit path
// Minimal valid PNG (1x1) and PDF — binary paths, not just text.
addFixture('pixel.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
addFixture('doc.pdf', Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (fixture pdf) Tj ET\nendstream endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'))
let fixtureTurn = 0
page.on('filechooser', async fc => {
  const pick = FIXTURES.length ? FIXTURES[fixtureTurn++ % FIXTURES.length] : null
  bus.filechooser.push(`filechooser (multiple=${fc.isMultiple()}) answered with ${pick ? pick.split('/').pop() : 'nothing'}`)
  if (pick) await fc.setFiles(pick).catch(() => {})
})

// Stable key for cross-cycle dedup. Normalises ONLY volatile identifiers —
// uuids, bare numbers — never whole messages. An over-broad key silently
// collapses distinct defects into one, which is how the predecessor's dedup
// under-reported by ~99x.
const fingerprint = (kind, detail, url) => {
  const norm = String(detail)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 180)
  const path = String(url || '').replace(/^https?:\/\/[^/]+/, '')
    .replace(/[0-9a-f-]{20,}/gi, '<id>')
  return `${kind}|${path}|${norm}`
}

function record(kind, severity, detail, step, verifiedBy) {
  findings.push({ kind, severity, detail, step: step?.i ?? null, url: step?.url ?? null,
                  action: step?.action ?? null, shot: step?.shot ?? null, verifiedBy,
                  fingerprint: fingerprint(kind, detail, step?.url) })
  log(`  ⚑ ${severity} ${kind}: ${String(detail).slice(0, 140)}`)
}

try {
  // --- entry: log in mechanically. This is the ONE piece of app knowledge here,
  // and it is deliberate: the auth wall is the precondition for exploring at all,
  // not something worth spending exploration budget rediscovering every cycle.
  log(`opening ${BASE}`)
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)
  const userBox = page.getByPlaceholder(/username or email/i)
  if (await userBox.count()) {
    await userBox.fill(USER)
    await page.getByPlaceholder(/password/i).first().fill(PASS)
    await page.getByRole('button', { name: /sign in/i }).first().click()
    await page.waitForTimeout(6000)
    // ASSERT it worked. Logging success right after clicking asserts nothing, and
    // the cost of that was not hypothetical: the explorer renamed its own admin
    // account through the profile UI, every later cycle logged "logged in as
    // admin" while sitting on the login screen, and hours of cycles explored
    // exactly one page. The loop HAS a recovery path for this; it never fired
    // because it greps for a string this file never printed.
    //
    // So the failure must be (a) detected by state, not assumed, and (b) reported
    // in the exact wording explore-loop.sh's recovery greps for. Those two strings
    // are a contract between the files — change one and recovery silently dies.
    if (await page.locator('input[type=password]').count()) {
      log(`authentication failed as ${USER} — still on the login form (credentials changed?)`)
      findings.push({
        kind: 'locked-out', severity: 'HIGH', verifiedBy: 'detector',
        detail: `could not authenticate as "${USER}"; every subsequent step in this cycle would explore the login screen only`,
        url: page.url(), fingerprint: 'locked-out',
      })
      writeFileSync(join(OUT, 'result.json'), JSON.stringify(
        { lockedOut: true, findings, urlsVisited: [], stepsTaken: 0 }, null, 2))
      await browser.close()
      process.exit(3)
    }
    log(`logged in as ${USER}`)
  } else {
    log('no login form — continuing (already authenticated?)')
  }
  // Start where we have been LEAST, not always at "/". This is what turns
  // per-cycle coverage from "whatever is nearest" into a sweep, without any
  // hardcoded route list — every candidate here was discovered by an earlier run.
  // Never START inside a known sink — that spends the opening steps of a cycle on
  // ground already proven barren.
  const known = Object.entries(coverage)
    .filter(([r]) => r !== '/' && !r.includes(':id') && !isSink(r))
  if (known.length) {
    known.sort((a, b) => a[1] - b[1])
    const target = known[0][0]
    log(`starting at least-visited route ${target} (${known[0][1]} prior visits, ${known.length} known)`)
    await page.goto(BASE + target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(2500)
  }
  clearBus()

  const history = []
  let sinkStreak = 0
  let untriedHere = 0      // untried controls on the current page
  let routePayout = 0      // new routes this page revealed this step
  for (let i = 1; i <= STEPS; i++) {
    // SINK ESCAPE. A route with a long history of consuming steps and revealing
    // nothing gets a hard bound on how long this cycle may linger. Persuasion in
    // the prompt does not work here — the model cannot feel a cost paid across
    // previous cycles, so the harness enforces it.
    {
      const here = routeOf(page.url())
      sinkStreak = isSink(here) ? sinkStreak + 1 : 0
      if (sinkStreak > 5) {
        const escape = Object.entries(coverage)
          .filter(([r]) => r !== '/' && !r.includes(':id') && !isSink(r))
          .sort((a, b) => a[1] - b[1])[0]
        if (escape) {
          log(`SINK ESCAPE: ${here} has gone ${sinks[here].barren} consecutive steps without a new route or an untried control (${sinks[here].steps} steps total) — leaving for ${escape[0]}`)
          await page.goto(BASE + escape[0], { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
          await page.waitForTimeout(2500)
          sinkStreak = 0
          // Bounced straight back? Then the APP is forcing this navigation, which
          // is a defect worth reporting rather than a quirk to route around.
          if (routeOf(page.url()) === here) {
            record('forced-redirect', 'HIGH',
              `app redirected back to ${here} after an explicit navigation to ${escape[0]} — an authenticated user cannot leave this route`,
              { i, url: page.url() }, 'detector')
          }
        }
      }
    }
    // Wandered off the app? Come back. Following an outbound link is realistic
    // user behaviour, but every step spent on a third-party site is a step not
    // spent auditing ziee — and it was how the route ledger got poisoned in the
    // first place.
    if (!sameOrigin(page.url())) {
      log(`off-site at ${page.url().slice(0, 60)} — returning to the app`)
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
      await page.waitForTimeout(2000)
    }
    let ctx = null
    try { ctx = await page.evaluate(MARK_SCRIPT) }
    catch (e) { log(`step ${i}: evaluate FAILED — ${String(e).split('\n')[0].slice(0, 200)}`) }
    if (!ctx) { await page.goBack().catch(() => {}); await page.waitForTimeout(1500); continue }
    // Credit any genuinely-new route to the page that revealed it. A route that
    // never reveals anything is what the sink test is looking for.
    {
      const here = routeOf(ctx.url)
      sinks[here] = sinks[here] || { steps: 0, barren: 0 }
      if (sinks[here].barren === undefined) sinks[here].barren = 0
      let paidOut = 0
      // Trust NOTHING from a page that is not ours.
      //
      // The first version of this guard checked each href against BASE and was
      // useless for the case it existed to stop: MARK_SCRIPT collects only
      // RELATIVE hrefs (a[href^="/"]), and a relative href on iana.org resolves
      // against BASE just fine, so all 69 of its paths sailed through and the
      // ledger re-polluted from 36 back to 129 routes within the hour. A relative
      // link belongs to the origin of the page SHOWING it, so that is what has to
      // be checked first.
      if (sameOrigin(ctx.url)) {
        for (const h of ctx.hrefs || []) {
          if (!sameOriginOf(h, ctx.url)) continue   // resolve against the CURRENT page
          const r = routeOf(h)
          if (!discoveredRoutes.has(r) && !(r in coverage)) paidOut++
          discoveredRoutes.add(r)
        }
      }
      untriedHere = ctx.elements.filter(e => !tried[sigOf(ctx.url, e)]).length
      routePayout = paidOut
    }

    // Which of the offered controls has this rig NEVER operated, in any cycle?
    // Recolour those badges before the screenshot so the signal reaches the model
    // through the same channel it already uses to choose — the picture.
    const fresh = ctx.elements.filter(e => !tried[sigOf(ctx.url, e)]).map(e => e.n)
    if (fresh.length) {
      await page.evaluate(ns => {
        for (const n of ns) {
          const b = document.querySelector(`[data-explore-mark="${n}"]`)
          if (b) { b.style.background = '#15803d'; b.style.outline = '2px solid #86efac' }
        }
      }, fresh).catch(() => {})
    }
    const shotPath = join(OUT, 'shots', `step-${String(i).padStart(3, '0')}.png`)
    const buf = await page.screenshot({ path: shotPath })
    await page.evaluate(unmark).catch(() => {})

    if (!ctx.elements.length) {
      record('dead-end', 'MEDIUM', `no interactive element visible at ${ctx.url}`, { i, url: ctx.url, shot: shotPath }, 'detector')
      await page.goBack().catch(() => {})
      await page.waitForTimeout(1500)
      continue
    }

    // If the last 3 actions were identical, the action is not working. Saying so
    // explicitly beats relying on the model to notice its own history — it did
    // not (an ineffective button clicked 6x in one run).
    const recent = history.slice(-3)
    const stuck = recent.length === 3 && new Set(recent).size === 1
    let act
    try {
      act = await decide({
        ...ctx, step: i, leastVisited: leastVisited(), fresh, untouchedAreas: untouchedAreas(),
        created: created.slice(-6), usedExisting: usedExisting.slice(-6),
        followThrough: created.length && usedExisting.length * 3 < created.length,
        history: history.slice(-6).join('\n') +
          (stuck ? `\n\nSTOP. You have done "${recent[0]}" three times with no effect. It does not work. Choose a DIFFERENT element, or navigate somewhere you have not been.` : ''),
      }, buf.toString('base64'))
    } catch (e) {
      log(`step ${i}: model error — ${String(e).slice(0, 160)}`)
      continue
    }

    const step = { i, url: ctx.url, action: act, shot: shotPath }
    const target = ctx.elements.find(e => e.n === Number(act.n))
    const desc = `${act.action}${target ? ` [${target.n}:${target.tag}${target.label ? ' "' + target.label + '"' : ''}]` : ''}${act.text ? ` "${String(act.text).slice(0, 30)}"` : ''}`
    log(`step ${i}/${STEPS} @${ctx.url.replace(BASE, '') || '/'} → ${desc}  (${act.reason || ''})`)
    history.push(`${desc} @ ${ctx.url.replace(BASE, '')}`)
    // Remember the control itself, so a later cycle knows it is no longer new.
    if (target) {
      const sg = sigOf(ctx.url, target)
      tried[sg] = (tried[sg] || 0) + 1          // in-memory: drives green badges now
      triedDelta[sg] = (triedDelta[sg] || 0) + 1 // on-disk: merged additively at exit
    }
    // Charge the step to the route it happened on, for the sink ledger.
    {
      const r = routeOf(ctx.url)
      sinks[r] = sinks[r] || { steps: 0, barren: 0 }
      sinks[r].steps++
      // Judged HERE, after the action ran, because the requests it triggered
      // arrive during execution — evaluating payout before the click always
      // reads zero. Three tiers, in order of what we actually want:
      //   a new ENDPOINT (the objective) or a new ROUTE -> full reset
      //   untried controls only                         -> half decay
      //   nothing at all                                -> full decay
      if (newEndpointsThisStep > 0 || routePayout > 0) sinks[r].barren = 0
      else sinks[r].barren += untriedHere ? 0.5 : 1
      if (newEndpointsThisStep > 0) log(`  +${newEndpointsThisStep} new endpoint(s)`)
      newEndpointsThisStep = 0
    }

    // the model's own visual judgement — kept separate from detector findings
    if (act.broken && String(act.broken).trim()) {
      record('looks-broken', 'MEDIUM', act.broken, step, 'model-vision-only')
    }

    // Validate the action against what the affordance actually IS. A `type` aimed
    // at a button can only fail, and reporting that as an app defect buries the
    // real findings (4 of 14 in cycle 1) — it is the explorer mis-aiming, not a bug.
    if (act.action === 'type' && target && !target.editable) {
      log(`  skipped: [${target.n}] is a ${target.tag}, not editable (explorer mis-aim, not a defect)`)
      steps.push({ ...step, skipped: 'type-into-non-editable', urlAfter: page.url() })
      continue
    }
    clearBus()
    const before = page.url()

    // RE-RESOLVE the target by DESCRIPTION, not by the stale badge index.
    //
    // Badge numbers are assigned when the screenshot is taken, but the model
    // takes seconds to answer and this is a React SPA — a re-render replaces DOM
    // nodes and drops the `data-explore-marked` attribute. Playwright then waits
    // the full timeout for a node that no longer exists, which surfaced as
    // `interaction-failed: TimeoutError`. That was 3 of 4 findings in cycle 2,
    // and it was entirely this harness: probed by hand, the same buttons click in
    // 21-27ms. A false-finding class that buries real ones is worse than none.
    //
    // So: re-mark, then find the element matching the chosen one's identity
    // (tag + role + type + label). If it is genuinely gone, that is not a defect —
    // the page moved on. If it is still there and STILL cannot be used, that is a
    // real finding.
    let liveN = target ? target.n : null
    if (target) {
      const fresh = await page.evaluate(MARK_SCRIPT).catch(() => null)
      await page.evaluate(unmark).catch(() => {})
      const same = fresh?.elements?.find(e =>
        e.tag === target.tag && e.role === target.role &&
        e.type === target.type && e.label === target.label)
      if (!same) {
        log(`  affordance gone after re-render: [${target.n}] ${target.tag} "${target.label}" — page moved on, not a defect`)
        steps.push({ ...step, skipped: 'affordance-vanished', urlAfter: page.url() })
        continue
      }
      liveN = same.n
    }

    try {
      const loc = target ? page.locator(`[data-explore-marked="${liveN}"]`).first() : null
      switch (act.action) {
        case 'click': if (loc) await loc.click({ timeout: 8000 }); break
        case 'type':
          if (loc) { await loc.click({ timeout: 8000 }).catch(() => {}); await loc.fill(String(act.text ?? ''), { timeout: 8000 }) }
          break
        case 'press': await page.keyboard.press(act.key || 'Enter'); break
        case 'scroll': await page.mouse.wheel(0, 700); break
        case 'back': await page.goBack(); break
        case 'goto':
          // only a link the page actually offered — never an invented URL
          if (ctx.hrefs.includes(act.href)) await page.goto(BASE + act.href, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          else log(`  refused goto ${act.href} (not offered by the page)`)
          break
        case 'done': i = STEPS; break
        default: log(`  unknown action ${act.action}`)
      }
    } catch (e) {
      // A failed interaction is itself a signal: the affordance was visible,
      // enabled and marked, yet could not be used.
      record('interaction-failed', 'MEDIUM', `${desc} → ${String(e).split('\n')[0].slice(0, 200)}`, step, 'detector')
    }

    await page.waitForTimeout(2200)

    // ---- deterministic detectors, attributed to THIS action
    for (const t of bus.pageerror) record('uncaught-exception', 'HIGH', t, step, 'detector')
    for (const t of bus.http5xx) record('server-5xx', 'HIGH', t, step, 'detector')
    // A console error is only a DEFECT if nothing legitimately explains it.
    //
    // Measured over the first 22 cycles, 26 of 26 ledger entries were the app
    // behaving CORRECTLY: a wrong password rejected 401, a duplicate knowledge
    // base 409, "Username must be 3-100 characters" 400. The explorer types
    // garbage on purpose, so a well-built app produces a steady stream of these.
    // Filing them as MEDIUM defects buries the real ones — the same
    // volume-is-not-signal failure that made 458 findings out of one harness bug.
    //
    // The discriminator is STATE, not message text: did the server deliberately
    // answer 4xx in this same step? Matching on wording would silently miss the
    // next phrasing (and there is always a next phrasing). The tradeoff is that a
    // genuine console error CO-OCCURRING with an unrelated 4xx is quieted; that
    // errs toward silence, which is the right side to err on here. 5xx and
    // uncaught exceptions are unaffected and still HIGH.
    const explained = bus.http4xx.length ? ` [expected: app returned ${bus.http4xx[0]}]` : ''
    for (const t of bus.console)
      record('console-error', explained ? 'LOW' : 'MEDIUM', t + explained, step, 'detector')
    for (const t of bus.reqfail) record('request-failed', 'MEDIUM', t, step, 'detector')
    for (const t of bus.dialog) record('native-dialog', 'LOW', t, step, 'detector')
    for (const t of bus.filechooser) log(`  ${t}`)

    // blank page after an action = something navigated into nothing
    const bodyLen = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => -1)
    if (bodyLen === 0) record('blank-page', 'HIGH', `body empty after ${desc} (was ${before})`, step, 'detector')

    steps.push({ ...step, events: bus, urlAfter: page.url() })
  }
} catch (e) {
  log(`FATAL ${String(e).slice(0, 300)}`)
  record('harness-error', 'HIGH', String(e).slice(0, 300), null, 'detector')
} finally {
  let summaryApi = null
  const summary = {
    startedAt: new Date().toISOString(), base: BASE, model: MODEL,
    stepsPlanned: STEPS, stepsTaken: steps.length,
    urlsVisited: [...new Set(steps.map(s => s.url))],
    apiEndpointsHit: [...apiHits.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`),
    findings, steps,
  }
  // merge this run's endpoint hits into the durable tally
  let apiCov = {}
  try { apiCov = JSON.parse(readFileSync(API_COVERAGE, 'utf8')) } catch {}
  for (const [k, v] of apiHits) apiCov[k] = (apiCov[k] || 0) + v
  try { writeFileSync(API_COVERAGE, JSON.stringify(apiCov, null, 1)) } catch {}
  // Durable outcome tally, written beside the hit tally rather than replacing it
  // so an existing api-coverage.json stays readable by the old reporter.
  const OUTCOMES = API_COVERAGE.replace(/\.json$/, '') + '-outcomes.json'
  let apiOut = {}
  try { apiOut = JSON.parse(readFileSync(OUTCOMES, 'utf8')) } catch {}
  for (const [k, o] of apiOutcomes) {
    const p = apiOut[k] || { ok: 0, c4: 0, c5: 0 }
    apiOut[k] = { ok: p.ok + o.ok, c4: p.c4 + o.c4, c5: p.c5 + o.c5 }
  }
  try { writeFileSync(OUTCOMES, JSON.stringify(apiOut, null, 1)) } catch {}
  summaryApi = { thisRun: apiHits.size, cumulative: Object.keys(apiCov).length }
  // MERGE-ON-WRITE, so several explorers can share one set of ledgers.
  //
  // These three were read at start and written wholesale at the end: correct for
  // one explorer, silently lossy for N, because the last writer wipes everyone
  // else's cycle. Re-reading at write time and applying only THIS run's delta
  // makes concurrent explorers additive instead.
  //
  // The read-modify-write is not atomic, so a collision inside the same
  // millisecond can still drop one cycle's increment. That window is ~1ms out of
  // a ~168s cycle and the data is an approximate coverage tally, so the trade is
  // worth it; a lock file would serialise every explorer's shutdown.
  const mergeWrite = (path, delta, combine) => {
    try {
      let disk = {}
      try { disk = JSON.parse(readFileSync(path, 'utf8')) } catch {}
      for (const [k, v] of Object.entries(delta)) disk[k] = combine(disk[k], v)
      writeFileSync(path, JSON.stringify(disk, null, 1))
    } catch {}
  }
  const visitDelta = {}
  for (const s2 of steps) {
    if (!sameOrigin(s2.url)) continue          // steps spent off-site are not coverage
    const r = routeOf(s2.url); visitDelta[r] = (visitDelta[r] || 0) + 1
  }
  for (const h of discoveredRoutes) if (!(h in visitDelta)) visitDelta[h] = 0  // seen, never visited
  mergeWrite(COVERAGE, visitDelta, (a, b) => (a || 0) + b)
  // Both novelty ledgers are cumulative and only useful across cycles — a control
  // tried this run must still read as tried next run, or the green badges reset
  // every cycle and the signal means nothing.
  mergeWrite(AFFORDANCES, triedDelta, (a, b) => (a || 0) + b)
  // `barren` is a per-explorer STREAK, not a total: two explorers on one route are
  // independent observations, so keep the LOWER streak. That is the conservative
  // direction — it delays declaring a sink rather than risking abandoning a route
  // that is still paying out for somebody else.
  mergeWrite(SINKS, sinks, (a, b) => ({
    steps: Math.max(a?.steps || 0, b.steps || 0),
    barren: a ? Math.min(a.barren ?? 0, b.barren ?? 0) : (b.barren ?? 0),
  }))
  const sinkList = Object.keys(sinks).filter(isSink)
  log(`affordances known: ${Object.keys(tried).length}; sinks: ${sinkList.join(', ') || 'none'}`)
  log(`model calls: ${retryStats.calls}, needed a retry: ${retryStats.callsNeedingRetry}, transient 4xx/5xx: ${retryStats.transient}, hard failures: ${retryStats.hardFail}`)
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(summary, null, 2))
  const bySev = s => findings.filter(f => f.severity === s).length
  const det = findings.filter(f => f.verifiedBy === 'detector').length
  log(`api endpoints hit this run: ${apiHits.size}${summaryApi ? ` (cumulative ${summaryApi.cumulative})` : ''}`)
  log(`done: ${steps.length} steps, ${[...new Set(steps.map(s => s.url))].length} distinct urls, ` +
      `${findings.length} findings (HIGH ${bySev('HIGH')} / MEDIUM ${bySev('MEDIUM')} / LOW ${bySev('LOW')}; ${det} detector-verified)`)
  writeFileSync(join(OUT, 'FINDINGS.md'),
    `# live-ui-explore — ${new Date().toISOString()}\n\n` +
    `${steps.length} steps · ${[...new Set(steps.map(s => s.url))].length} distinct URLs · model \`${MODEL}\`\n\n` +
    (findings.length ? findings.map(f =>
      `## ${f.severity} — ${f.kind}\n- **${f.verifiedBy === 'detector' ? 'machine-verified' : 'MODEL VISION ONLY (unverified)'}**\n` +
      `- step ${f.step} at \`${f.url}\`\n- action: \`${JSON.stringify(f.action)}\`\n- screenshot: \`${f.shot}\`\n\n${f.detail}\n`
    ).join('\n') : '_no findings_\n'))
  await browser.close().catch(() => {})
  process.exit(0)
}
