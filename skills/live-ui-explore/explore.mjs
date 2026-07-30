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
const leastVisited = () => Object.entries(coverage)
  .filter(([r]) => r !== '/' && !r.includes(':id'))
  .sort((a, b) => a[1] - b[1]).slice(0, 8).map(([r]) => r)
const discoveredRoutes = new Set()
// Every API call the app makes, normalised to an openapi-style template so it
// can be diffed against the spec. Route coverage is a weak proxy for what the
// app actually exercises — two pages can look "visited" while never triggering a
// write. This is the real coverage number.
const apiHits = new Map()   // "METHOD /api/x/{id}" -> count
const API_COVERAGE = arg('api-coverage', '/data/pbya/ziee/tmp/live-ui-explore/api-coverage.json')
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
  const SEL = [
    'button', 'a[href]', 'input', 'textarea', 'select',
    '[role=button]', '[role=tab]', '[role=menuitem]', '[role=option]',
    '[role=switch]', '[role=checkbox]', '[role=radio]', '[role=link]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
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
    if (hit !== el && !el.contains(hit) && !hit.contains(el)) return false;
    return true;
  };
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
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
    b.setAttribute('data-explore-mark', '1');
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
        { type: 'text', text: `${SYSTEM}\n\n--- CURRENT STATE ---\nurl: ${ctx.url}\ntitle: ${ctx.title}\nstep ${ctx.step} of ${STEPS}\n\nrecently tried (avoid repeating):\n${ctx.history || '(nothing yet)'}\n\nelements you can CLICK:\n${JSON.stringify(ctx.elements.filter(e => !e.editable))}\n\nelements you can TYPE into (only these accept "type" — typing into anything else does nothing):\n${JSON.stringify(ctx.elements.filter(e => e.editable))}\n\nlinks this page offers for "goto":\n${JSON.stringify(ctx.hrefs)}\n\nareas you have explored LEAST across all previous sessions (prefer these when you see a way to reach one):\n${JSON.stringify(ctx.leastVisited)}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${shotB64}` } },
      ],
    }],
  }
  const r = await fetch(LLM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.EXPLORE_LLM_KEY ? { Authorization: `Bearer ${process.env.EXPLORE_LLM_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!r.ok) throw new Error(`model HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
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
let bus = { console: [], pageerror: [], reqfail: [], http5xx: [], dialog: [], filechooser: [] }
const clearBus = () => { bus = { console: [], pageerror: [], reqfail: [], http5xx: [], dialog: [], filechooser: [] } }
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
})
page.on('response', r => { if (r.status() >= 500) bus.http5xx.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`) })
// A native dialog blocks everything; accept so exploration continues, but record it.
page.on('dialog', async d => { bus.dialog.push(`${d.type()}: ${d.message().slice(0, 200)}`); await d.accept().catch(() => {}) })

// A file chooser is modal and invisible to the page, so an unanswered one makes
// the click look like a no-op and the explorer retries it forever. Answer every
// chooser with a small generated file: app-agnostic, and it is the only way the
// upload paths get exercised at all.
const FIXTURE = '/tmp/live-ui-explore-fixture.txt'
try { writeFileSync(FIXTURE, 'live-ui-explore upload fixture\n' + 'lorem ipsum dolor sit amet\n'.repeat(40)) } catch {}
page.on('filechooser', async fc => {
  bus.filechooser.push(`filechooser (multiple=${fc.isMultiple()}) answered with a text fixture`)
  await fc.setFiles(FIXTURE).catch(() => {})
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
    log(`logged in as ${USER}`)
  } else {
    log('no login form — continuing (already authenticated?)')
  }
  // Start where we have been LEAST, not always at "/". This is what turns
  // per-cycle coverage from "whatever is nearest" into a sweep, without any
  // hardcoded route list — every candidate here was discovered by an earlier run.
  const known = Object.entries(coverage).filter(([r]) => r !== '/' && !r.includes(':id'))
  if (known.length) {
    known.sort((a, b) => a[1] - b[1])
    const target = known[0][0]
    log(`starting at least-visited route ${target} (${known[0][1]} prior visits, ${known.length} known)`)
    await page.goto(BASE + target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(2500)
  }
  clearBus()

  const history = []
  for (let i = 1; i <= STEPS; i++) {
    let ctx = null
    try { ctx = await page.evaluate(MARK_SCRIPT) }
    catch (e) { log(`step ${i}: evaluate FAILED — ${String(e).split('\n')[0].slice(0, 200)}`) }
    if (!ctx) { await page.goBack().catch(() => {}); await page.waitForTimeout(1500); continue }
    for (const h of ctx.hrefs || []) discoveredRoutes.add(routeOf(h))
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
        ...ctx, step: i, leastVisited: leastVisited(),
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
    for (const t of bus.console) record('console-error', 'MEDIUM', t, step, 'detector')
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
  summaryApi = { thisRun: apiHits.size, cumulative: Object.keys(apiCov).length }
  for (const s2 of steps) coverage[routeOf(s2.url)] = (coverage[routeOf(s2.url)] || 0) + 1
  for (const h of discoveredRoutes) if (!(h in coverage)) coverage[h] = 0   // seen but never visited
  try { writeFileSync(COVERAGE, JSON.stringify(coverage, null, 1)) } catch {}
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
