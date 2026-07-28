/**
 * NEGATIVE-CONTROL harness for the live-ui-audit detectors — "trust the
 * instrument" for this battery, the sibling of the app's own
 * `scripts/detector-acceptance.mjs`.
 *
 * A detector that reports 0 findings is indistinguishable from a detector that
 * is silently broken, and a "fix" that merely reduces a count is
 * indistinguishable from a disabled check. So every repaired class asserts BOTH
 * halves against hand-written fixtures:
 *
 *   FP-GONE  — the false-positive fixture produces NO finding of that class.
 *   TP-KEPT  — a genuine instance of the SAME class still produces one.
 *
 * Needs no running app and no network: the DOM checks run against
 * `page.setContent` fixtures, the network checks against synthetic request
 * logs. Add a row here BEFORE changing any detector threshold.
 *
 *   node agent-kit/skills/live-ui-audit/detector-fixtures.mjs
 *   PLAYWRIGHT_DIR=<path to a node_modules with @playwright/test> node ...
 *
 * Exit 0 = every control held; exit 1 = a detector is over- or under-firing.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Same resolution strategy as the skill itself, so the harness is as portable
// as the thing it tests.
const chromium = await (async () => {
  try {
    return (await import('@playwright/test')).chromium
  } catch {
    for (const dir of [
      process.env.PLAYWRIGHT_DIR,
      path.resolve(__dirname, '../../../node_modules'),
      path.resolve(__dirname, '../../../src-app/ui/node_modules'),
    ].filter(Boolean)) {
      try {
        const pw = createRequire(path.join(dir, '/'))('@playwright/test')
        if (pw?.chromium) return pw.chromium
      } catch {
        /* try next */
      }
    }
    throw new Error('Could not resolve @playwright/test. Set PLAYWRIGHT_DIR.')
  }
})()
const D = await import(path.join(__dirname, 'live-ui-audit.mjs'))

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${info ? `   ${info}` : ''}`)
  ok ? pass++ : fail++
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const audit = async html => {
  await page.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#fff;color:#111;font:14px/1.4 system-ui}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
             overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
  </style></head><body>${html}</body></html>`)
  return page.evaluate(D.inPageAudit)
}
const of = (r, cat) => r.findings.filter(f => f.category === cat)

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[2a] visible() honours clip / clip-path  →  zero-size-control')
// ── FP: Tailwind sr-only skip link. 1x1 layout box, clipped to nothing.
//        A REQUIRED a11y affordance, reported 8x/cycle as a defect.
{
  const r = await audit(`
    <a href="#main" class="sr-only">Skip to content</a>
    <main id="main" style="padding:20px"><button style="width:120px;height:32px">Real</button></main>`)
  check('FP-GONE  sr-only skip link is not a zero-size-control',
    of(r, 'zero-size-control').length === 0,
    JSON.stringify(of(r, 'zero-size-control').map(f => f.detail)))
}
// ── FP: the clip-path form of the same idiom.
{
  const r = await audit(`
    <a href="#m" style="position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden">Skip</a>
    <main id="m"><button style="width:80px;height:30px">Ok</button></main>`)
  check('FP-GONE  clip-path:inset(50%) visually-hidden link is not a zero-size-control',
    of(r, 'zero-size-control').length === 0)
}
// ── TP: a genuinely collapsed control (no clip — it really is unclickable).
{
  const r = await audit(`<button style="width:1px;height:1px;border:0">Broken</button>`)
  check('TP-KEPT  a genuinely 1x1 unclipped button still fires zero-size-control',
    of(r, 'zero-size-control').length === 1,
    of(r, 'zero-size-control')[0]?.detail || '')
}
// ── TP: zero-height control from a collapsed flex row.
{
  const r = await audit(`<div style="display:flex;height:1px;overflow:visible">
      <button style="width:100px;height:1px;border:0">Collapsed</button></div>`)
  check('TP-KEPT  a 1px-high control still fires zero-size-control',
    of(r, 'zero-size-control').length === 1,
    of(r, 'zero-size-control')[0]?.detail || '')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[2b] ancestor-overflow clipping  →  control-collision')
// ── FP: the exact shape from the triage. A scroll container whose overflowing
//        rows keep layout rects BELOW the clip, where a pinned footer is drawn.
const SCROLL_FP = `
  <aside style="position:relative;width:260px;height:300px">
    <div id="scroller" style="height:240px;overflow-y:auto">
      ${Array.from({ length: 20 }, (_, i) =>
        `<button style="display:block;width:240px;height:36px">Conversation ${i}</button>`).join('')}
    </div>
    <div style="position:absolute;top:240px;left:0;width:260px;height:60px;background:#eee">
      <button style="width:240px;height:36px">Onboarding guide</button>
    </div>
  </aside>`
{
  const r = await audit(SCROLL_FP)
  const cols = of(r, 'control-collision')
  check('FP-GONE  rows scrolled past a scroll container do not "collide" with the pinned footer',
    cols.length === 0, JSON.stringify(cols.map(f => f.detail).slice(0, 2)))
}
// ── TP: two controls that genuinely overlap, nothing clipped.
{
  const r = await audit(`
    <div style="position:relative;height:200px">
      <button style="position:absolute;left:20px;top:20px;width:120px;height:40px">Save</button>
      <button style="position:absolute;left:30px;top:24px;width:120px;height:40px">Delete</button>
    </div>`)
  const cols = of(r, 'control-collision')
  check('TP-KEPT  two genuinely overlapping painted controls still fire control-collision',
    cols.length >= 1, cols[0]?.detail || '')
}
// ── TP: an overlap where one control is only PARTLY inside a scroll container —
//        the painted part still overlaps, so it must still fire.
{
  const r = await audit(`
    <div style="position:relative;height:300px">
      <div style="height:100px;overflow-y:auto;width:300px">
        <button style="display:block;width:200px;height:60px">Row A</button>
        <div style="height:400px"></div>
      </div>
      <button style="position:absolute;left:10px;top:10px;width:190px;height:50px">Overlay</button>
    </div>`)
  check('TP-KEPT  overlap of the PAINTED portion inside a scroll container still fires',
    of(r, 'control-collision').length >= 1,
    of(r, 'control-collision')[0]?.detail || '')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[2c] clipped-control: unreachable vs merely scrolled out')
// ── FP: scrolled out of a SCROLLABLE container → reachable, no finding.
{
  const r = await audit(SCROLL_FP)
  check('FP-GONE  a row scrolled out of a SCROLLABLE container is not clipped-control',
    of(r, 'clipped-control').length === 0,
    JSON.stringify(of(r, 'clipped-control').map(f => f.detail).slice(0, 2)))
}
// ── TP: same geometry, but the clipper is overflow:hidden with no scroll range
//        the user can drive → genuinely unreachable. MUST still fire.
{
  const r = await audit(`
    <div style="height:80px;overflow:hidden;width:300px">
      <button style="display:block;width:200px;height:40px">Visible</button>
      <button style="display:block;width:200px;height:40px">Visible2</button>
      <button style="display:block;width:200px;height:40px">UNREACHABLE</button>
    </div>`)
  const cc = of(r, 'clipped-control')
  check('TP-KEPT  a control cut to zero by a NON-scrollable overflow:hidden ancestor still fires',
    cc.length === 1, cc[0]?.detail || '')
  check('TP-KEPT  ... and names the offending clipper',
    /non-scrollable overflow ancestor/.test(cc[0]?.detail || ''))
}
// ── TP: viewport-edge clipping with no horizontal scroll to recover it.
{
  const r = await audit(`
    <div style="overflow-x:hidden;width:100%">
      <button style="position:absolute;left:1240px;top:10px;width:200px;height:40px">Cut</button>
    </div>`)
  check('TP-KEPT  a control past the viewport edge with no h-scroll still fires clipped-control',
    of(r, 'clipped-control').length >= 1,
    of(r, 'clipped-control')[0]?.detail || '')
}
// ── FP: same, but a horizontal scroller CAN reveal it.
{
  const r = await audit(`
    <div style="overflow-x:auto;width:400px;white-space:nowrap">
      <div style="width:2000px">
        <button style="width:200px;height:40px;margin-left:1300px">Reachable by scrolling</button>
      </div>
    </div>`)
  check('FP-GONE  a control reachable by scrolling a horizontal scroller is not clipped-control',
    of(r, 'clipped-control').length === 0,
    JSON.stringify(of(r, 'clipped-control').map(f => f.detail)))
}
// ── TP: viewport-edge branch (b), with NO clipping ancestor. `position:fixed`
//        so the control does NOT create document h-scroll — i.e. nothing can
//        bring it back. (An absolutely-positioned one WOULD create h-scroll and
//        is therefore reachable; that case is covered by the `overflow-x` HIGH,
//        which is why it must not double-report here.)
{
  const r = await audit(`
    <button style="position:fixed;left:1200px;top:10px;width:200px;height:40px">Off the right edge</button>`)
  const cc = of(r, 'clipped-control')
  check('TP-KEPT  viewport-edge branch fires with no clipping ancestor involved',
    cc.length === 1 && /viewport edge/.test(cc[0].detail), cc[0]?.detail || '')
}
// ── FP: the same control, absolutely positioned, so the document scrolls
//        horizontally and the user CAN reach it.
{
  const r = await audit(`
    <button style="position:absolute;left:1200px;top:10px;width:200px;height:40px">Reachable</button>`)
  check('FP-GONE  a control the document can h-scroll to is not clipped-control',
    of(r, 'clipped-control').length === 0,
    JSON.stringify(of(r, 'clipped-control').map(f => f.detail)))
}
// ── FP: the REAL radix ScrollArea shape — root `overflow:hidden` wrapping a
//        viewport that is the actual scroller. This is the settings-nav
//        structure the triage screenshots refuted; the outer hidden root must
//        NOT be read as a hard clip.
{
  const r = await audit(`
    <div style="position:relative;height:320px;width:280px;overflow:hidden">
      <div data-radix-scroll-area-viewport style="width:100%;height:240px;overflow-x:hidden;overflow-y:scroll">
        ${Array.from({ length: 25 }, (_, i) =>
          `<button style="display:block;width:250px;height:34px">Setting ${i}</button>`).join('')}
      </div>
      <div style="position:absolute;top:250px;left:0;width:280px;height:60px">
        <button style="width:250px;height:36px">Onboarding guide</button>
      </div>
    </div>`)
  check('FP-GONE  radix ScrollArea (hidden root + scrolling viewport): no clipped-control',
    of(r, 'clipped-control').length === 0,
    JSON.stringify(of(r, 'clipped-control').map(f => f.detail).slice(0, 2)))
  check('FP-GONE  ... and no control-collision with the pinned footer',
    of(r, 'control-collision').length === 0,
    JSON.stringify(of(r, 'control-collision').map(f => f.detail).slice(0, 2)))
}
// ── FP: a closed disclosure is deliberately not reachable — not a defect.
{
  const r = await audit(`
    <div data-state="closed" style="height:0;overflow:hidden">
      <button style="width:200px;height:40px">Hidden in a closed accordion</button>
    </div>`)
  check('FP-GONE  a control inside a closed disclosure is not clipped-control',
    of(r, 'clipped-control').length === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[3] palette-drift honours data-allow-custom-color')
const SWATCH = 'style="background-color:rgb(69,79,176);width:28px;height:28px" '
{
  const r = await audit(`<button data-allow-custom-color ${SWATCH}>x</button>`)
  check('FP-GONE  a data-allow-custom-color swatch is not palette-drift',
    of(r, 'palette-drift').length === 0,
    JSON.stringify(of(r, 'palette-drift').map(f => f.detail)))
}
{
  const r = await audit(`<div data-allow-custom-color><span ${SWATCH}>x</span></div>`)
  check('FP-GONE  ... and the marker covers the subtree it paints',
    of(r, 'palette-drift').length === 0)
}
{
  const r = await audit(`<button ${SWATCH}>x</button>`)
  check('TP-KEPT  the SAME hardcoded color WITHOUT the marker still fires palette-drift',
    of(r, 'palette-drift').length >= 1, of(r, 'palette-drift')[0]?.detail || '')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[7] stuck-loading honours the app’s own busy discriminator')
const settled = async html => {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  return { settled: await page.evaluate(D.probeIsSettled), probe: await page.evaluate(D.probeLoading) }
}
{
  const { settled: s, probe } = await settled(
    `<div data-busy="streaming"><div class="animate-spin" style="width:20px;height:20px"></div></div>`)
  check('FP-GONE  a live spinner while the app declares data-busy="streaming" reads as settled',
    s === true && probe.appBusy === 'streaming', `appBusy=${probe.appBusy}`)
}
{
  const { settled: s, probe } = await settled(
    `<div data-busy="loading"><div role="progressbar" style="width:20px;height:20px"></div></div>`)
  check('FP-GONE  ... same for data-busy="loading" (history fetch)',
    s === true && probe.appBusy === 'loading')
}
{
  const { settled: s, probe } = await settled(
    `<div class="animate-spin" style="width:20px;height:20px"></div>`)
  check('TP-KEPT  a spinner with NO [data-busy] is not settled (driver will dwell + re-probe)',
    s === false && probe.count === 1 && probe.appBusy === null, `count=${probe.count}`)
}
{
  const { settled: s } = await settled(`<div data-busy=""><div class="animate-spin" style="width:9px;height:9px"></div></div>`)
  check('TP-KEPT  an EMPTY data-busy does not count as a busy declaration',
    s === false)
}
{
  const { settled: s } = await settled(`<p>nothing loading</p>`)
  check('FP-GONE  a quiet surface is settled', s === true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[9] selectorFor emits a stable secondary key (anchor)')
{
  // A production build strips data-test* — this is what the rig actually sees.
  const r = await audit(`
    <nav aria-label="Settings"><ul><li><ul><li>
      <button style="width:1px;height:1px;border:0">Web Search</button>
    </li></ul></li></ul></nav>`)
  const f = of(r, 'zero-size-control')[0]
  check('anchor is emitted alongside the raw DOM-path selector',
    !!f?.anchor && /Web Search/.test(f.anchor) && /nav\[/.test(f.anchor),
    `selector=${f?.selector}  anchor=${f?.anchor}`)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[8b] spacing-grid names the offending element')
{
  const r = await audit(`<div style="padding:5px"><button style="width:40px;height:20px">a</button></div>`)
  const f = of(r, 'spacing-grid')[0]
  check('spacing-grid carries the offending property + element, not just "body"',
    !!f && /5px on padding/.test(f.detail) && f.selector !== 'body',
    f?.detail || '')
}

await browser.close()

// ═══════════════════════════════════════════════════════════════════════════
// Network detectors — pure functions over a synthetic request log.
console.log('\n[4] network duplicate/excess key on path PLUS query')
const netFindings = (log, flow = 'home') => {
  const out = []
  D.analyzeNetwork(log, flow, {}, f => out.push(f))
  return out
}
const rq = (key, over = {}) => ({
  url: `http://x${key}`,
  path: key.split('?')[0],
  key,
  method: 'GET',
  status: 200,
  ms: 40,
  tStart: 0,
  tEnd: 40,
  timed: true,
  bytes: 100,
  type: 'xhr',
  step: 's',
  ...over,
})
{
  // FP: a designed infinite-scroll pager fetching pages 1..4.
  const log = [1, 2, 3, 4].map(p => rq(`/api/conversations?limit=20&page=${p}`))
  const f = netFindings(log)
  check('FP-GONE  pages 1..4 of a pager are not "duplicate"',
    f.filter(x => x.subcategory === 'duplicate').length === 0)
  check('FP-GONE  ... and not "excess/polling"',
    f.filter(x => x.subcategory === 'excess').length === 0,
    JSON.stringify(f.map(x => x.subcategory)))
}
{
  // TP: the SAME resource really fetched 4x in one step.
  const log = [1, 2, 3, 4].map(() => rq('/api/conversations?limit=20&page=1'))
  const f = netFindings(log)
  check('TP-KEPT  the same page fetched 4x still fires duplicate',
    f.some(x => x.subcategory === 'duplicate'))
  check('TP-KEPT  ... and excess/polling',
    f.some(x => x.subcategory === 'excess'))
}
{
  // TP: query order must not create a false distinction.
  const norm = u => {
    const [p2, q] = u.split('?')
    return rq(D.requestKey(p2, q ? `?${q}` : ''))
  }
  const log = [norm('/api/x?a=1&b=2'), norm('/api/x?b=2&a=1')]
  check('TP-KEPT  reordered query params normalize to the SAME resource → duplicate',
    netFindings(log).some(x => x.subcategory === 'duplicate'),
    `keys=${log.map(r2 => r2.key).join(' , ')}`)
  check('TP-KEPT  ... and genuinely different pages do not',
    !netFindings([norm('/api/x?page=1'), norm('/api/x?page=2')]).some(x => x.subcategory === 'duplicate'))
}

console.log('\n[5] `conversations` is app-shell, not chat-only')
{
  const log = [rq('/api/conversations?page=1', { step: 'settings-root' })]
  check('FP-GONE  the shell sidebar loading conversations on settings is not "irrelevant"',
    netFindings(log, 'browse-settings').filter(x => x.subcategory === 'irrelevant').length === 0)
}
{
  const log = [rq('/api/users?page=1', { step: 'compose' })]
  check('TP-KEPT  a genuinely off-page admin list on a chat flow still fires "irrelevant"',
    netFindings(log, 'compose-send').some(x => x.subcategory === 'irrelevant'))
}

console.log('\n[6] waterfall needs causality, not a 20ms slack')
{
  // FP: four `void`-fired PARALLEL calls, each shorter than the old 20ms slack.
  //     Overlapping starts — nothing waited for anything.
  const log = [
    rq('/api/memory/admin-settings', { tStart: 100, tEnd: 112 }),
    rq('/api/memory/settings', { tStart: 102, tEnd: 118 }),
    rq('/api/memory/list', { tStart: 104, tEnd: 121 }),
    rq('/api/memory/stats', { tStart: 106, tEnd: 125 }),
    rq('/api/memory/x', { tStart: 108, tEnd: 130 }),
  ]
  const f = netFindings(log)
  check('FP-GONE  five overlapping parallel calls are not a waterfall',
    f.filter(x => x.subcategory === 'waterfall').length === 0)
}
{
  // FP: sub-slack requests fired back-to-back in ONE tick — non-overlap here is
  //     coincidence at our timing resolution, not causality.
  const log = [0, 1, 2, 3, 4].map(i =>
    rq(`/api/a${i}`, { tStart: 100 + i * 12, tEnd: 100 + i * 12 + 10 }))
  check('FP-GONE  a run of sub-25ms back-to-back requests is not a waterfall',
    netFindings(log).filter(x => x.subcategory === 'waterfall').length === 0)
}
{
  // FP: genuinely serialized but trivially cheap — not worth an engineer's time.
  const log = [0, 1, 2, 3].map(i =>
    rq(`/api/b${i}`, { tStart: 100 + i * 40, tEnd: 100 + i * 40 + 30 }))
  check('FP-GONE  a 4-deep chain costing <300ms serial is not reported',
    netFindings(log).filter(x => x.subcategory === 'waterfall').length === 0)
}
{
  // TP: a REAL dependent chain — each starts right after the previous ended.
  const log = [0, 1, 2, 3, 4].map(i =>
    rq(`/api/c${i}`, { tStart: 100 + i * 130, tEnd: 100 + i * 130 + 120 }))
  const f = netFindings(log).filter(x => x.subcategory === 'waterfall')
  check('TP-KEPT  a genuinely serialized 5-deep chain still fires waterfall',
    f.length === 1, f[0]?.detail || '')
  check('TP-KEPT  ... and carries the causality evidence (gaps)',
    /gaps 10\/10\/10\/10ms/.test(f[0]?.detail || ''), f[0]?.detail || '')
}
{
  // TP: chained but with the previous request's own timing untrusted → skipped.
  const log = [0, 1, 2, 3, 4].map(i =>
    rq(`/api/d${i}`, { tStart: 100 + i * 130, tEnd: 100 + i * 130 + 120, timed: false }))
  check('FP-GONE  rows without real network timing are never chained',
    netFindings(log).filter(x => x.subcategory === 'waterfall').length === 0)
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
process.exit(fail ? 1 : 0)
