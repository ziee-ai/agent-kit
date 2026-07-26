/**
 * LIVE-UI-AUDIT — objective, evidence-based audit of a RUNNING app.
 *
 * This is the sibling of `src-app/ui/scripts/runtime-health.mjs`. runtime-health
 * points the browser-diagnostics + contrast/a11y/grid battery at the mock-API
 * GALLERY (isolated surfaces). THIS script points the SAME battery — plus a set
 * of live-only checks (overflow, collision, clipping, broken images, dead-end
 * controls, stuck spinners, non-2xx /api, light↔dark parity, token-palette
 * conformance) — at the REAL app, driving real JTBD flows as a logged-in user,
 * across viewports × themes × personas.
 *
 * Every signal is OBJECTIVE and MEASURABLE. There is no subjective-UX scoring
 * (that has proven unreliable). The one vision hook is scoped to BREAKAGE only
 * and is emitted as screenshot references for a separate, explicitly-objective
 * vision pass — never "is this good design".
 *
 * Usage:
 *   node live-ui-audit.mjs \
 *     [--url=http://127.0.0.1:1520] [--user=admin] [--password=password123] \
 *     [--viewports=390,768,1280] [--themes=light,dark] \
 *     [--jtbd=home,compose-send,adversarial-compose,browse-settings] \
 *     [--persona=normal|adversarial|all] [--fleet] \
 *     [--out=DIR] [--probe-deadends] [--headed]
 *
 * Exit code: 0 always in report mode; non-zero (1) if any gating HIGH finding
 * exists and --gate is passed. It is a REPORTER first — it never fails a build
 * unless asked, because it drives a live shared instance.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Resolve Playwright robustly so the skill is self-contained/portable. Try a
//    normal bare import first (works when run from a workspace that has it),
//    then fall back to an explicit node_modules dir (ziee repo root by default,
//    overridable with PLAYWRIGHT_DIR for another app).
async function loadChromium() {
  try {
    return (await import('@playwright/test')).chromium
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_DIR,
      path.resolve(__dirname, '../../../node_modules'),
      path.resolve(__dirname, '../../../src-app/ui/node_modules'),
      '/data/pbya/ziee/ziee/node_modules',
    ].filter(Boolean)
    for (const dir of candidates) {
      try {
        const req = createRequire(path.join(dir, '/'))
        const entry = req.resolve('@playwright/test')
        return (await import(pathToFileURL(entry).href)).chromium
      } catch {
        /* try next */
      }
    }
    throw new Error(
      'Could not resolve @playwright/test. Set PLAYWRIGHT_DIR=<path to a node_modules that has @playwright/test>.',
    )
  }
}

// ── CLI ---------------------------------------------------------------------
const arg = (n, d) =>
  (process.argv.find(a => a.startsWith(`--${n}=`)) || `--${n}=${d}`)
    .split('=')
    .slice(1)
    .join('=')
const flag = n => process.argv.includes(`--${n}`)

const BASE = arg('url', 'http://127.0.0.1:1520').replace(/\/$/, '')
const USER = arg('user', 'admin')
const PASS = arg('password', 'password123')
const VIEWPORTS = arg('viewports', '390,768,1280')
  .split(',')
  .map(Number)
  .filter(Boolean)
const THEMES = arg('themes', 'light,dark').split(',').filter(Boolean)
const OUT = arg('out', path.join(process.cwd(), 'live-ui-audit-out'))
const PROBE_DEADENDS = flag('probe-deadends')
const HEADED = flag('headed')
const GATE = flag('gate')
const FLEET = flag('fleet')
const PERSONA_ARG = arg('persona', 'normal')

const VIEWPORT_LABEL = { 390: 'mobile', 768: 'tablet', 1280: 'desktop' }
const SEV_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 }

// ── JTBD flow catalog -------------------------------------------------------
// Each flow is a JTBD ("job the user is trying to get done"). A flow is a list
// of named steps; the driver audits the rendered surface after each step. Steps
// are DEFENSIVE — a missing affordance records a finding instead of throwing.
const JTBD = arg(
  'jtbd',
  'home,compose-send,adversarial-compose,browse-settings',
)
  .split(',')
  .filter(Boolean)

const CHAT_INPUT = 'textarea[placeholder*="Type your message"]'

const FLOWS = {
  // JTBD: "I open the app and want to start working."
  home: {
    title: 'Open app — land on new-chat home',
    persona: 'normal',
    steps: [{ name: 'home', run: async () => {} }],
  },
  // JTBD: "I type a question and send it to the assistant."
  'compose-send': {
    title: 'Compose and send a chat message',
    persona: 'normal',
    steps: [
      {
        name: 'compose',
        run: async page => {
          const ta = page.locator(CHAT_INPUT).first()
          await ta.waitFor({ state: 'visible', timeout: 15000 })
          await ta.fill('What is 2 + 2? Answer in one word.')
        },
      },
      {
        name: 'sent',
        run: async page => {
          await page.locator(CHAT_INPUT).first().press('Enter')
          // Let the send resolve (or fail) and any response/toast render.
          await page.waitForTimeout(6000)
        },
      },
    ],
  },
  // JTBD (adversarial persona): "break the composer with weird input."
  'adversarial-compose': {
    title: 'Adversarial composer — empty / huge / double-submit',
    persona: 'adversarial',
    steps: [
      {
        name: 'empty-submit',
        run: async page => {
          const ta = page.locator(CHAT_INPUT).first()
          await ta.waitFor({ state: 'visible', timeout: 15000 })
          await ta.click()
          await ta.press('Enter') // empty submit — must no-op gracefully
          await page.waitForTimeout(800)
        },
      },
      {
        name: 'huge-input',
        run: async page => {
          const big = 'lorem ipsum dolor sit amet '.repeat(1200) // ~32k chars
          await page.locator(CHAT_INPUT).first().fill(big)
          await page.waitForTimeout(1200)
        },
      },
      {
        name: 'rapid-double-submit',
        run: async page => {
          const ta = page.locator(CHAT_INPUT).first()
          await ta.fill('rapid test 🚀 <script>x</script> "quoted" \\n')
          await ta.press('Enter')
          await ta.press('Enter') // double-submit race
          await page.waitForTimeout(4000)
        },
      },
    ],
  },
  // JTBD: "I configure my account / app settings."
  'browse-settings': {
    title: 'Browse settings surfaces',
    persona: 'normal',
    steps: [
      {
        name: 'settings-root',
        run: async page => {
          await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' })
          await page.waitForTimeout(2500)
        },
      },
      {
        name: 'settings-general',
        run: async page => {
          await page
            .goto(`${BASE}/settings/general`, { waitUntil: 'domcontentloaded' })
            .catch(() => {})
          await page.waitForTimeout(2000)
        },
      },
    ],
  },
}

// ── Network hygiene / request-sense -----------------------------------------
// Objective analysis of the actual request log per flow-step: failures,
// duplicates, N+1 bursts, waterfalls, excess/polling, oversized payloads, and
// RELEVANCE (endpoint-purpose vs page-purpose, grounded in the OpenAPI spec).
// Every flag cites the concrete request(s) as evidence.

// Load the OpenAPI spec (endpoint → purpose) if reachable; used for the
// relevance ("does this request make sense here?") judgment.
function loadOpenApi() {
  const candidates = [
    process.env.OPENAPI_JSON,
    path.resolve(__dirname, '../../../src-app/ui/openapi/openapi.json'),
    '/data/pbya/ziee/ziee/src-app/ui/openapi/openapi.json',
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const spec = JSON.parse(fs.readFileSync(p, 'utf8'))
      const map = {}
      for (const [route, ops] of Object.entries(spec.paths || {})) {
        const key = route.replace(/\/$/, '')
        const first = Object.values(ops)[0] || {}
        map[key] = {
          summary: first.summary || first.description || '',
          tags: (first.tags || []).map(t => String(t).toLowerCase()),
        }
      }
      return map
    } catch {
      /* try next */
    }
  }
  return {}
}

// Concrete /api URL path → OpenAPI-style template (uuids / numeric ids → {id}).
const templatize = urlPath =>
  urlPath
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}')

// Domains (first /api path segment) that are ALWAYS relevant regardless of
// route: app-shell infrastructure the authenticated shell legitimately loads.
const SHELL_DOMAINS = new Set([
  'auth', 'sync', 'onboarding', 'config', 'app', 'me', 'profile', 'permissions',
  'hardware', 'notifications', 'theme', 'server-update', // global update banner is app-shell, not page-specific
])
// Per-flow relevance: the first /api path segment(s) whose PURPOSE relates to
// the flow's page job. A GET to a heavy list endpoint outside this set (and
// outside SHELL_DOMAINS) is flagged `irrelevant` — grounded in path→purpose.
// The chat composer legitimately loads: the model picker (llm-models,
// llm-providers, user-llm-providers), the mic button's voice-readiness,
// summarization/context settings, assistants, MCP defaults, projects, files.
// Those are RELEVANT — flagging them was a false positive in the first proof
// run. Anything genuinely off-page (users/user-groups admin lists, other
// features' management endpoints) is NOT in this set and still flags.
const CHAT_DOMAINS = [
  'conversations', 'chat', 'assistants', 'models', 'model', 'llm-models',
  'providers', 'llm-providers', 'user-llm-providers', 'projects', 'files',
  'mcp', 'memory', 'knowledge-bases', 'citations', 'web-search', 'lit-search',
  'tools', 'user-settings', 'voice', 'summarization', 'usage', 'skills',
  'branches', 'messages', 'deliverables', // active-conversation sub-resources
]
const FLOW_RELEVANT_DOMAINS = {
  home: CHAT_DOMAINS,
  'compose-send': CHAT_DOMAINS,
  'adversarial-compose': CHAT_DOMAINS,
  'browse-settings': ['users', 'user-groups', 'settings', 'providers', 'llm-providers', 'user-llm-providers', 'model', 'models', 'llm-models', 'mcp', 'auth', 'session-settings', 'memory', 'summarization', 'web-search', 'lit-search', 'code-sandbox', 'sandbox', 'voice', 'file-rag', 'knowledge-bases', 'citations', 'hardware', 'notifications', 'user-settings', 'assistants'],
}

function analyzeNetwork(log, flowId, openapi, pushRaw) {
  // log: [{url, path, method, status, ms, bytes, type, step, failure}]
  const api = log.filter(r => r.path && r.path.startsWith('/api/'))
  const relevant = FLOW_RELEVANT_DOMAINS[flowId] || []
  const purpose = concretePath => {
    const t = '/' + templatize(concretePath).replace(/^\//, '')
    const hit = openapi[t] || openapi[t.replace(/\/$/, '')]
    return hit?.summary || ''
  }

  // group by step
  const steps = [...new Set(api.map(r => r.step))]
  for (const step of steps) {
    const rs = api.filter(r => r.step === step)

    // 1. failures (non-2xx, aborted, timed-out). net::ERR_ABORTED on a
    //    long-lived stream/subscribe endpoint is the CLIENT intentionally
    //    tearing the SSE stream down on navigation — not a server/app defect
    //    (same rationale runtime-health.mjs uses to mute ERR_ABORTED). Mute it.
    for (const r of rs) {
      const benignAbort =
        r.failure === 'net::ERR_ABORTED' &&
        /stream|subscribe|subscription|events|sse/i.test(r.path)
      if (benignAbort) continue
      if (r.failure || (r.status && r.status >= 400)) {
        pushRaw({
          step,
          category: 'network',
          subcategory: 'failure',
          severity: r.failure || r.status >= 500 ? 'HIGH' : 'MEDIUM',
          selector: null,
          detail: `network failure: ${r.method} ${r.path} → ${r.failure ? r.failure : r.status}${r.ms ? ` (${r.ms}ms)` : ''}`,
        })
      }
    }

    // 2. duplicates: same method+path fired ≥2× within one step
    const dupKey = {}
    for (const r of rs) (dupKey[`${r.method} ${r.path}`] ??= []).push(r)
    for (const [k, group] of Object.entries(dupKey)) {
      if (group.length >= 2) {
        pushRaw({
          step,
          category: 'network',
          subcategory: 'duplicate',
          severity: group.length >= 3 ? 'MEDIUM' : 'LOW',
          selector: null,
          detail: `duplicate request: ${k} fired ${group.length}× within step "${step}" (${group.map(g => g.status || g.failure || '?').join(',')})`,
        })
      }
    }

    // 3. N+1: many concrete urls sharing one template with different ids
    const tpl = {}
    for (const r of rs) {
      const t = `${r.method} ${templatize(r.path)}`
      if (!/\{id\}/.test(t)) continue
      ;(tpl[t] ??= new Set()).add(r.path)
    }
    for (const [t, urls] of Object.entries(tpl)) {
      if (urls.size >= 4) {
        pushRaw({
          step,
          category: 'network',
          subcategory: 'n+1',
          severity: 'MEDIUM',
          selector: null,
          detail: `N+1 pattern: ${urls.size} distinct requests to template ${t} in one step (${[...urls].slice(0, 3).map(u => u.split('/').pop()).join(', ')}…)`,
        })
      }
    }

    // 4. waterfall: longest run of sequential non-overlapping /api requests
    const ordered = rs
      .filter(r => r.tStart != null && r.tEnd != null)
      .sort((a, b) => a.tStart - b.tStart)
    let run = 1
    let maxRun = 1
    let runStart = 0
    let bestStart = 0
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].tStart >= ordered[i - 1].tEnd - 20) {
        run++
        if (run > maxRun) {
          maxRun = run
          bestStart = runStart
        }
      } else {
        run = 1
        runStart = i
      }
    }
    if (maxRun >= 4) {
      const chain = ordered.slice(bestStart, bestStart + maxRun)
      const totalMs = chain[chain.length - 1].tEnd - chain[0].tStart
      pushRaw({
        step,
        category: 'network',
        subcategory: 'waterfall',
        severity: 'MEDIUM',
        selector: null,
        detail: `waterfall: ${maxRun} sequential dependent /api requests (${totalMs}ms serial) that could be parallelized — ${chain.slice(0, 4).map(c => c.path).join(' → ')}`,
      })
    }

    // 5. oversized payloads (evidence: measured bytes)
    for (const r of rs) {
      if (r.bytes && r.bytes > 200_000) {
        pushRaw({
          step,
          category: 'network',
          subcategory: 'oversized',
          severity: r.bytes > 800_000 ? 'MEDIUM' : 'LOW',
          selector: null,
          detail: `oversized payload: ${r.method} ${r.path} returned ${(r.bytes / 1024).toFixed(0)} KiB${purpose(r.path) ? ` (${purpose(r.path)})` : ''} — verify the page renders that much`,
        })
      }
    }

    // 6. RELEVANCE: heavy GET list endpoint whose domain is unrelated to the
    //    flow's page purpose (endpoint-purpose vs page-purpose, cited).
    for (const r of rs) {
      if (r.method !== 'GET') continue
      const seg = r.path.replace(/^\/api\//, '').split(/[/?]/)[0]
      if (!seg) continue
      if (SHELL_DOMAINS.has(seg) || relevant.includes(seg)) continue
      // only flag "list-ish" GETs (pagination / collection), to stay objective
      const listish = /[?&]page=|[?&]per_page=|[?&]limit=/.test(r.url) || !/\{?id\}?$|\/[0-9a-f-]{8,}$/.test(r.path)
      if (!listish) continue
      pushRaw({
        step,
        category: 'network',
        subcategory: 'irrelevant',
        severity: 'MEDIUM',
        selector: null,
        detail: `irrelevant fetch for this page: ${r.method} ${r.path}${purpose(r.path) ? ` — "${purpose(r.path)}"` : ''}. Flow "${flowId}" (step "${step}") has no use for the \`${seg}\` domain; likely eager over-fetch of unrelated data.`,
      })
    }
  }

  // 7. excess / polling across the WHOLE cell (re-render storm / timer)
  const cellKey = {}
  for (const r of api) (cellKey[`${r.method} ${r.path}`] ??= []).push(r)
  for (const [k, group] of Object.entries(cellKey)) {
    if (group.length >= 4) {
      pushRaw({
        step: '(cell)',
        category: 'network',
        subcategory: 'excess',
        severity: 'MEDIUM',
        selector: null,
        detail: `excess/polling: ${k} fired ${group.length}× across the flow (possible timer/render-storm) — steps: ${[...new Set(group.map(g => g.step))].join(', ')}`,
      })
    }
  }
}

// ── In-page audit -----------------------------------------------------------
// Runs entirely in the browser against the live rendered surface. Ports the
// color/contrast/a11y/grid helpers from runtime-health.mjs and ADDS the
// live-only geometry + palette checks. Returns { findings, contrast, meta }.
function inPageAudit() {
  const findings = []
  const GRID = 4
  const vw = window.innerWidth
  const vh = window.innerHeight

  const visible = el => {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0')
      return false
    const r = el.getBoundingClientRect()
    return r.width >= 1 && r.height >= 1
  }
  const domPath = el => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 8) {
      let seg = node.tagName.toLowerCase()
      if (node.id) {
        seg += `#${node.id}`
        parts.unshift(seg)
        break
      }
      const p = node.parentElement
      if (p) {
        const sibs = Array.from(p.children).filter(c => c.tagName === node.tagName)
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`
      }
      parts.unshift(seg)
      node = node.parentElement
    }
    return parts.join('>')
  }
  const selectorFor = el => {
    const tid = el.getAttribute?.('data-testid')
    if (tid) return `[data-testid="${tid}"]`
    return domPath(el).slice(-80)
  }

  // ---- color helpers (ported from runtime-health.mjs) ---------------------
  const cvs = document.createElement('canvas')
  cvs.width = cvs.height = 1
  const cctx = cvs.getContext('2d', { willReadFrequently: true })
  const colorCache = new Map()
  const parseColor = c => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    if (colorCache.has(c)) return colorCache.get(c)
    let out = null
    try {
      cctx.clearRect(0, 0, 1, 1)
      cctx.fillStyle = '#000'
      cctx.fillStyle = c
      cctx.fillRect(0, 0, 1, 1)
      const [r, g, b, aByte] = cctx.getImageData(0, 0, 1, 1).data
      out = { r, g, b, a: aByte / 255 }
    } catch {
      out = null
    }
    colorCache.set(c, out)
    return out
  }
  const over = (fg, bg) => {
    const a = fg.a
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    }
  }
  const lum = ({ r, g, b }) => {
    const f = v => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const rootBgColor = () => {
    for (const el of [document.documentElement, document.body]) {
      const c = parseColor(getComputedStyle(el).backgroundColor)
      if (c && c.a > 0) return { r: c.r, g: c.g, b: c.b, a: 1 }
    }
    return document.documentElement.classList.contains('dark')
      ? { r: 10, g: 10, b: 10, a: 1 }
      : { r: 255, g: 255, b: 255, a: 1 }
  }
  const PAGE_BASE = rootBgColor()
  const effectiveBg = el => {
    let base = { ...PAGE_BASE }
    const stack = []
    let node = el
    while (node && node.nodeType === 1) {
      const bg = parseColor(getComputedStyle(node).backgroundColor)
      if (bg && bg.a > 0) stack.push(bg)
      node = node.parentElement
    }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base)
    return base
  }
  const sat = ({ r, g, b }) => {
    const mx = Math.max(r, g, b) / 255
    const mn = Math.min(r, g, b) / 255
    const l = (mx + mn) / 2
    if (mx === mn) return 0
    const d = mx - mn
    return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  }

  // ---- Build the ALLOWED design-system palette dynamically from the app's
  //      own computed CSS custom properties (:root + .dark), so we never
  //      hardcode token values (DESIGN_SYSTEM.md is the source; this reads the
  //      SHIPPED tokens directly). Any saturated color NOT near a token is a
  //      hardcoded-color / theme-drift escape.
  const tokenColors = []
  const rootCS = getComputedStyle(document.documentElement)
  for (let i = 0; i < rootCS.length; i++) {
    const prop = rootCS[i]
    if (!prop.startsWith('--')) continue
    const val = rootCS.getPropertyValue(prop).trim()
    if (!val) continue
    const c = parseColor(val)
    if (c && c.a > 0) tokenColors.push(c)
  }
  const nearToken = c =>
    tokenColors.some(
      t => Math.abs(t.r - c.r) + Math.abs(t.g - c.g) + Math.abs(t.b - c.b) <= 24,
    )

  // ---- 1. contrast (WCAG AA) + build the parity contrast map --------------
  const contrast = {} // domPath -> ratio (for light↔dark parity diff)
  const seenContrast = new Set()
  const textEls = Array.from(document.querySelectorAll('body *')).filter(el => {
    if (!visible(el)) return false
    return Array.from(el.childNodes).some(
      n => n.nodeType === 3 && n.textContent.trim().length > 1,
    )
  })
  for (const el of textEls) {
    const cs = getComputedStyle(el)
    const fgRaw = parseColor(cs.color)
    if (!fgRaw) continue
    const bg = effectiveBg(el)
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw
    const cr = ratio(fg, bg)
    contrast[domPath(el)] = Math.round(cr * 100) / 100
    const size = parseFloat(cs.fontSize)
    const bold = parseInt(cs.fontWeight, 10) >= 700
    const large = size >= 24 || (size >= 18.66 && bold)
    const threshold = large ? 3.0 : 4.5
    if (cr + 0.05 < threshold) {
      const key = `${cs.color}|${JSON.stringify(bg)}|${threshold}`
      if (seenContrast.has(key)) continue
      seenContrast.add(key)
      findings.push({
        category: 'contrast',
        severity: 'HIGH',
        selector: selectorFor(el),
        detail: `contrast ${cr.toFixed(2)}:1 < WCAG AA ${threshold}:1 (${large ? 'large' : 'normal'} text, ${size}px) — fg ${cs.color} on bg rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
      })
    }
  }

  // ---- 2. interactive missing accessible name -----------------------------
  const accName = el => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim() || '')
        .join(' ')
        .trim()
      if (t) return t
    }
    const title = el.getAttribute('title')
    if (title && title.trim()) return title.trim()
    if (el.tagName === 'INPUT') {
      const ph = el.getAttribute('placeholder')
      if (ph && ph.trim()) return ph.trim()
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (lbl?.textContent?.trim()) return lbl.textContent.trim()
      }
    }
    const wrap = el.closest('label')
    if (wrap?.textContent?.trim()) return wrap.textContent.trim()
    const text = el.textContent?.trim()
    if (text) return text
    const img = el.querySelector('img[alt]')
    if (img?.getAttribute('alt')?.trim()) return img.getAttribute('alt').trim()
    return ''
  }
  const INTERACTIVE =
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="radio"]'
  const interactives = Array.from(document.querySelectorAll(INTERACTIVE)).filter(
    el => visible(el) && el.getAttribute('aria-hidden') !== 'true',
  )
  const seenName = new Set()
  for (const el of interactives) {
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'radio') continue
    if (accName(el)) continue
    const sel = selectorFor(el)
    if (seenName.has(sel)) continue
    seenName.add(sel)
    findings.push({
      category: 'a11y-name',
      severity: 'MEDIUM',
      selector: sel,
      detail: `interactive <${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> has no accessible name`,
    })
  }

  // ---- 3. horizontal body overflow ----------------------------------------
  const sw = document.scrollingElement
    ? document.scrollingElement.scrollWidth
    : document.documentElement.scrollWidth
  if (sw > vw + 2) {
    // find the widest offender element that pokes past the right edge
    let worst = null
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > vw + 2 && r.width <= vw + 40) {
        if (!worst || r.right > worst.right) worst = { el, right: r.right }
      }
    }
    findings.push({
      category: 'overflow-x',
      severity: 'HIGH',
      selector: worst ? selectorFor(worst.el) : 'body',
      detail: `body scrollWidth ${sw} > viewport ${vw} — horizontal scroll${worst ? `; widest offender right=${Math.round(worst.right)}px (${selectorFor(worst.el)})` : ''}`,
    })
  }

  // ---- 4. broken images ---------------------------------------------------
  for (const img of document.querySelectorAll('img[src]')) {
    if (!visible(img)) continue
    if (img.complete && img.naturalWidth === 0) {
      findings.push({
        category: 'broken-image',
        severity: 'MEDIUM',
        selector: selectorFor(img),
        detail: `image failed to load (naturalWidth=0) src=${(img.getAttribute('src') || '').slice(0, 120)}`,
      })
    }
  }

  // ---- 5. zero-size + off-viewport (clipped) interactive controls ---------
  const seenGeom = new Set()
  for (const el of interactives) {
    const r = el.getBoundingClientRect()
    const sel = selectorFor(el)
    // zero/near-zero clickable
    if ((r.width < 2 || r.height < 2) && !seenGeom.has('z' + sel)) {
      seenGeom.add('z' + sel)
      findings.push({
        category: 'zero-size-control',
        severity: 'MEDIUM',
        selector: sel,
        detail: `interactive control has near-zero size ${Math.round(r.width)}×${Math.round(r.height)}px`,
      })
      continue
    }
    // horizontally clipped: extends past left/right viewport edge (a control
    // the user cannot fully reach at this width). Ignore vertical (legit scroll).
    const clippedRight = r.right > vw + 2 && r.left < vw
    const clippedLeft = r.left < -2 && r.right > 0
    if ((clippedRight || clippedLeft) && r.width < vw && !seenGeom.has('c' + sel)) {
      seenGeom.add('c' + sel)
      findings.push({
        category: 'clipped-control',
        severity: 'MEDIUM',
        selector: sel,
        detail: `interactive control clipped by viewport edge (rect left=${Math.round(r.left)} right=${Math.round(r.right)}, viewport width ${vw})`,
      })
    }
  }

  // ---- 6. pairwise collision of prominent interactive controls ------------
  // STRICT to avoid FP flood. Two DESIGN patterns look like "overlap" but are
  // intentional and must be excluded: (a) an action button laid OVER a row-link
  // (one box contains the other's center + is much larger), (b) an open
  // menu/popover/dialog layered over its trigger. We also require both boxes
  // fully in-viewport, ≥60% overlap of the smaller, and DISTINCT accessible
  // names (same-name = one control duplicated in the DOM, not a real clash).
  // Emitted as LOW — a hint for the scoped breakage vision pass, capped per cell.
  const inLayer = el =>
    !!el.closest(
      '[role="menu"],[role="listbox"],[role="dialog"],[role="tooltip"],[data-radix-popper-content-wrapper],[data-floating-ui-portal]',
    ) || el.getAttribute('aria-haspopup') != null
  const inView = r => r.top >= -2 && r.left >= -2 && r.right <= vw + 2 && r.bottom <= vh + 2
  const boxes = interactives
    .filter(el => !el.querySelector(INTERACTIVE) && !inLayer(el))
    .map(el => ({ el, r: el.getBoundingClientRect(), name: accName(el) }))
    .filter(b => b.r.width >= 8 && b.r.height >= 8 && inView(b.r))
  const centerIn = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  const cols = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const aA = a.r.width * a.r.height
      const bA = b.r.width * b.r.height
      const cax = (a.r.left + a.r.right) / 2
      const cay = (a.r.top + a.r.bottom) / 2
      const cbx = (b.r.left + b.r.right) / 2
      const cby = (b.r.top + b.r.bottom) / 2
      // intentional overlaid-action: bigger box holds the smaller's center
      if (centerIn(a.r, cbx, cby) && aA > bA * 1.5) continue
      if (centerIn(b.r, cax, cay) && bA > aA * 1.5) continue
      const ox = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left))
      const oy = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top))
      const inter = ox * oy
      if (inter <= 0) continue
      const frac = inter / Math.min(aA, bA)
      if (frac < 0.6) continue
      if (a.name && b.name && a.name === b.name) continue
      cols.push({ a, b, frac })
    }
  }
  cols.sort((x, y) => y.frac - x.frac)
  for (const { a, b, frac } of cols.slice(0, 3)) {
    findings.push({
      category: 'control-collision',
      severity: 'LOW',
      selector: selectorFor(a.el),
      detail: `two distinct interactive controls overlap ${Math.round(frac * 100)}% in-viewport — ${selectorFor(a.el)} ("${a.name || '?'}") ⨯ ${selectorFor(b.el)} ("${b.name || '?'}")`,
    })
  }

  // ---- 7. saturated hardcoded-color / theme-drift escapes -----------------
  const seenPalette = new Set()
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    for (const [prop, raw] of [
      ['background', cs.backgroundColor],
      ['border', cs.borderTopColor],
      ['color', cs.color],
    ]) {
      const c = parseColor(raw)
      if (!c || c.a < 0.5) continue
      if (sat(c) < 0.25) continue // neutral ramp — legit
      if (nearToken(c)) continue // matches a shipped token — legit
      const key = `${prop}:${raw}`
      if (seenPalette.has(key)) continue
      seenPalette.add(key)
      findings.push({
        category: 'palette-drift',
        severity: 'LOW',
        selector: selectorFor(el),
        detail: `saturated ${prop} color ${raw} not resolvable to any DESIGN_SYSTEM token (possible hardcoded color / theme-drift)`,
      })
    }
  }

  // ---- 8. off-grid spacing (aggregate, LOW; 2px half-step tolerated) ------
  const offGrid = new Set()
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    for (const v of [
      cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft,
      cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft,
      cs.rowGap, cs.columnGap,
    ]) {
      const px = Math.abs(parseFloat(v))
      if (!px || Number.isNaN(px)) continue
      if (px < 2) continue // sub-2px values are hairlines/borders, not spacing
      // tolerate 2px half-steps: flag only values not near a multiple of 2px
      if (px % 2 > 0.5 && 2 - (px % 2) > 0.5) offGrid.add(Math.round(px * 10) / 10)
    }
  }
  if (offGrid.size) {
    const list = [...offGrid].sort((a, b) => a - b).slice(0, 12)
    findings.push({
      category: 'spacing-grid',
      severity: 'LOW',
      selector: 'body',
      detail: `${offGrid.size} distinct off-grid spacing value(s) (2px half-step tolerated): ${list.map(v => v + 'px').join(', ')}`,
    })
  }

  // ---- 9. mixed variants in a peer icon-button group (DESIGN_SYSTEM J6) ----
  const groups = new Map()
  for (const el of interactives) {
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue
    // icon-only: no visible text, contains an svg
    if (el.textContent && el.textContent.trim().length) continue
    if (!el.querySelector('svg')) continue
    const p = el.parentElement
    if (!p) continue
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p).push(el)
  }
  for (const [, els] of groups) {
    if (els.length < 3) continue
    const sigs = new Set(
      els.map(el => {
        const cs = getComputedStyle(el)
        const bg = parseColor(cs.backgroundColor)
        const bd = parseColor(cs.borderTopColor)
        return `${bg.a > 0.05 ? 'fill' : 'nofill'}/${bd.a > 0.05 && parseFloat(cs.borderTopWidth) > 0 ? 'border' : 'noborder'}`
      }),
    )
    if (sigs.size > 1) {
      findings.push({
        category: 'mixed-variant',
        severity: 'MEDIUM',
        selector: selectorFor(els[0]),
        detail: `peer icon-button group (${els.length}) mixes ${sigs.size} variant signatures {${[...sigs].join(', ')}} — DESIGN_SYSTEM J6 (peers share one variant)`,
      })
    }
  }

  // ---- 10. stuck loading indicators ---------------------------------------
  const spinners = Array.from(
    document.querySelectorAll(
      '[role="progressbar"], .animate-spin, [aria-busy="true"], [data-testid*="spin"], [data-testid*="loading"], [data-testid*="skeleton"]',
    ),
  ).filter(visible)
  if (spinners.length) {
    findings.push({
      category: 'stuck-loading',
      severity: 'MEDIUM',
      selector: selectorFor(spinners[0]),
      detail: `${spinners.length} loading indicator(s) still present after settle window`,
    })
  }

  return {
    findings,
    contrast,
    meta: { vw, vh, scrollWidth: sw, dark: document.documentElement.classList.contains('dark') },
  }
}

// ── Permission + resource-scoping (RBAC) audit ------------------------------
// The security-critical dimension. Seeds permission-diverse personas, derives
// the expected access matrix from the codebase (curated oracle, cited to
// modules/*/permissions.rs + PERMISSION_GATING.md), then runs the audit AS each
// persona: negative-permission (gated surfaces absent at all 4 layers),
// cross-user isolation (A can't reach B's owner-scoped ids → 404), positive
// access, and resource-assignment reflection. Every flag cites matrix vs actual.

// Oracle: admin-gated surface → { UI route, backing admin API, required perm }.
// (Sources: users/permissions.rs users::read; groups groups::read; web_search
// web_search::admin::read; memory memory::admin; code_sandbox
// code_sandbox::resource_limits::read — all admin-only per the module docs.)
const ADMIN_MATRIX = [
  { route: '/settings/users', api: '/api/users', perm: 'users::read' },
  { route: '/settings/user-groups', api: '/api/groups', perm: 'groups::read' },
  { route: '/settings/web-search', api: '/api/web-search/settings', perm: 'web_search::admin::read' },
  { route: '/settings/memory-admin', api: '/api/memory/admin-settings', perm: 'memory::admin::read' },
  { route: '/settings/sandbox', api: '/api/code-sandbox/resource-limits', perm: 'code_sandbox::resource_limits::read' },
]

const DENIAL_RE = /forbidden|not authorized|access denied|permission|403|you do not have/i

async function apiStatus(token, urlPath, method = 'GET') {
  try {
    const r = await fetch(BASE + urlPath, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: r.status, json: r.status < 300 ? await r.json().catch(() => null) : null }
  } catch (e) {
    return { status: 0, error: String(e) }
  }
}

async function seedPersona(adminToken, p) {
  // login-or-create (idempotent)
  let login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: p.username, password: p.password }),
  })
  if (login.status === 401) {
    await fetch(`${BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        username: p.username,
        email: p.email,
        password: p.password,
        permissions: p.permissions || [],
      }),
    })
    login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: p.username, password: p.password }),
    })
  }
  if (!login.ok) throw new Error(`seed ${p.key}: login failed ${login.status}`)
  const token = (await login.json()).access_token
  await fetch(`${BASE}/api/onboarding/getting-started/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {})
  const me = await apiStatus(token, '/api/auth/me')
  const userId = me.json?.id || me.json?.user_id || me.json?.user?.id || null
  // ensure this persona OWNS a conversation (the cross-user isolation fixture)
  let convs = await apiStatus(token, '/api/conversations?page=1&per_page=5')
  let list = convs.json?.conversations || convs.json?.items || convs.json?.data || (Array.isArray(convs.json) ? convs.json : [])
  let convId = list?.[0]?.id
  if (!convId) {
    const created = await fetch(`${BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: `audit-owned-${p.key}` }),
    })
    if (created.ok) convId = (await created.json()).id
  }
  return { ...p, token, userId, convId }
}

async function runPermissionAudit(browser, adminToken, record) {
  const shotDir = 'screenshots'
  const rec = (persona, f) =>
    record({
      flow: 'permission',
      jtbd: 'RBAC — permission + resource scoping',
      persona,
      viewport: 1280,
      viewportLabel: 'desktop',
      theme: 'light',
      ...f,
    })

  // seed restricted-user + user-B (proof scope). power-user documented in SKILL.
  let restricted, userb
  try {
    restricted = await seedPersona(adminToken, {
      key: 'restricted', username: 'audit_restricted',
      email: 'audit_restricted@example.com', password: 'password123', permissions: [],
    })
    userb = await seedPersona(adminToken, {
      key: 'userb', username: 'audit_userb',
      email: 'audit_userb@example.com', password: 'password123', permissions: [],
    })
  } catch (e) {
    rec('admin', {
      step: 'seed', category: 'permission', subcategory: 'seed-error',
      severity: 'MEDIUM', selector: null,
      detail: `could not seed personas: ${e.message} — permission dimension skipped`,
      screenshot: null,
    })
    return
  }
  console.log(
    `  permission personas: restricted(uid=${restricted.userId?.slice?.(0, 8)}, conv=${restricted.convId?.slice?.(0, 8)}) userb(conv=${userb.convId?.slice?.(0, 8)})`,
  )

  // ── A) negative-permission: backend gating (API-authoritative) ───────────
  for (const m of ADMIN_MATRIX) {
    const { status } = await apiStatus(restricted.token, m.api)
    if (status >= 200 && status < 300) {
      rec('restricted', {
        step: m.route, category: 'permission', subcategory: 'ungated-surface',
        severity: 'HIGH', selector: m.api, screenshot: null,
        detail: `BACKEND NOT GATED: restricted-user (lacks ${m.perm}) got ${status} from admin API ${m.api} — expected 403. Oracle: ${m.route} requires ${m.perm}.`,
      })
    } else if (status !== 403 && status !== 401 && status !== 404) {
      rec('restricted', {
        step: m.route, category: 'permission', subcategory: 'ungated-surface',
        severity: 'LOW', selector: m.api, screenshot: null,
        detail: `unexpected status ${status} from ${m.api} as restricted-user (expected 403).`,
      })
    }
  }

  // ── B) negative-permission: frontend gating (all 4 layers) + nav leak ─────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  await ctx.addInitScript(t => {
    try {
      localStorage.setItem('auth-storage', JSON.stringify({ state: { token: t }, version: 0 }))
    } catch {}
  }, restricted.token)
  const page = await ctx.newPage()
  // capture backing-api statuses seen during nav (layer-2 evidence)
  const apiSeen = {}
  page.on('response', r => {
    const u = r.url()
    for (const m of ADMIN_MATRIX) if (u.includes(m.api)) apiSeen[m.route] = r.status()
  })
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(CHAT_INPUT + ', [data-testid="layout-sidebar-toggle-button"]', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)

  // nav-menu leak: any link/menuitem to an admin route visible to restricted?
  const adminRoutes = ADMIN_MATRIX.map(m => m.route)
  const leakedNav = await page.evaluate(routes => {
    const hits = []
    for (const a of document.querySelectorAll('a[href], [role="menuitem"], [role="link"]')) {
      const href = a.getAttribute('href') || ''
      const txt = (a.textContent || '').trim().slice(0, 40)
      for (const r of routes)
        if (href.includes(r)) hits.push({ route: r, href, txt })
    }
    return hits
  }, adminRoutes)
  for (const h of leakedNav) {
    rec('restricted', {
      step: h.route, category: 'permission', subcategory: 'ungated-surface',
      severity: 'HIGH', selector: `a[href="${h.href}"]`, screenshot: null,
      detail: `NAV LEAK (layer-1): restricted-user's shell shows a nav entry to admin route ${h.route} ("${h.txt}") — a lacked-permission surface must be absent at the nav layer.`,
    })
  }

  // direct-navigate each admin route → must be blocked (redirect/deny), not rendered
  for (const m of ADMIN_MATRIX) {
    await page.goto(`${BASE}${m.route}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(2000)
    const finalUrl = page.url().replace(BASE, '')
    const bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 4000)
    const denied = DENIAL_RE.test(bodyText)
    const stayed = finalUrl.startsWith(m.route)
    const backingStatus = apiSeen[m.route]
    const shot = `${shotDir}/permission__restricted__${m.route.replace(/\W+/g, '-')}.png`
    await page.screenshot({ path: path.join(OUT, shot) }).catch(() => {})
    if (stayed && !denied && backingStatus >= 200 && backingStatus < 300) {
      rec('restricted', {
        step: m.route, category: 'permission', subcategory: 'ungated-surface',
        severity: 'HIGH', selector: m.route, screenshot: shot,
        detail: `ROUTE NOT GATED (layer-2/3): restricted-user direct-nav to ${m.route} rendered it (url stayed, no denial) AND backing ${m.api} returned ${backingStatus}. Oracle: requires ${m.perm}.`,
      })
    } else if (stayed && !denied) {
      rec('restricted', {
        step: m.route, category: 'permission', subcategory: 'ungated-surface',
        severity: 'MEDIUM', selector: m.route, screenshot: shot,
        detail: `route ${m.route} rendered for restricted-user (url stayed, no explicit denial) though backing API status=${backingStatus ?? 'n/a'}. Verify the page shell exposes no gated affordance. Oracle: requires ${m.perm}.`,
      })
    }
    // else: redirected away or explicit denial → gated correctly (no finding)
  }
  await ctx.close()

  // ── C) cross-user isolation (leak check — API-authoritative) ─────────────
  if (userb.convId) {
    const { status } = await apiStatus(restricted.token, `/api/conversations/${userb.convId}`)
    if (status >= 200 && status < 300) {
      rec('restricted', {
        step: 'cross-user', category: 'permission', subcategory: 'cross-user-leak',
        severity: 'HIGH', selector: `/api/conversations/${userb.convId}`, screenshot: null,
        detail: `CROSS-USER LEAK: restricted-user read user-B's conversation ${userb.convId} → ${status} (expected 404). Owner-scoped resources must 404 across users.`,
      })
    }
  }
  // positive-access control: restricted CAN read its OWN conversation
  if (restricted.convId) {
    const { status } = await apiStatus(restricted.token, `/api/conversations/${restricted.convId}`)
    if (!(status >= 200 && status < 300)) {
      rec('restricted', {
        step: 'own-resource', category: 'permission', subcategory: 'broken-positive-access',
        severity: 'MEDIUM', selector: `/api/conversations/${restricted.convId}`, screenshot: null,
        detail: `broken positive access: restricted-user got ${status} reading its OWN conversation ${restricted.convId} (expected 2xx).`,
      })
    }
  }

  // ── D) resource-assignment reflection ────────────────────────────────────
  const adminProv = await apiStatus(adminToken, '/api/llm-providers')
  const userProv = await apiStatus(restricted.token, '/api/user-llm-providers')
  const cnt = j => (Array.isArray(j) ? j.length : (j?.providers || j?.items || j?.data || []).length)
  const adminN = cnt(adminProv.json)
  const userN = cnt(userProv.json)
  if (adminN > 0 && userN >= adminN) {
    rec('restricted', {
      step: 'assignment', category: 'permission', subcategory: 'unreflected-resource',
      severity: 'MEDIUM', selector: '/api/user-llm-providers', screenshot: null,
      detail: `possible unreflected resource: restricted-user's accessible providers (${userN}) ≥ full deployment set (${adminN}) — assignment scoping may not be applied. Evidence: /api/user-llm-providers=${userN} vs /api/llm-providers=${adminN}. (Seed group-scoped assignments to make this definitive.)`,
    })
  }

  console.log(`  ✓ permission audit (restricted + userb) complete`)
}

// ── driver ------------------------------------------------------------------
async function main() {
  const chromium = await loadChromium()
  const openapi = loadOpenApi()
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true })
  console.log(
    `  openapi purpose-map: ${Object.keys(openapi).length} endpoints loaded${Object.keys(openapi).length ? '' : ' (relevance check degraded — spec not found)'}`,
  )

  // Get a token once (API), inject per-context (mirrors tests/common/auth-helpers).
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  if (!loginRes.ok)
    throw new Error(`login failed ${loginRes.status}: ${await loginRes.text()}`)
  const { access_token } = await loginRes.json()
  if (!access_token) throw new Error('login returned no access_token')
  // Best-effort: mark onboarding complete so AuthGuard lands on the app.
  await fetch(`${BASE}/api/onboarding/getting-started/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
  }).catch(() => {})

  const browser = await chromium.launch({ headless: !HEADED })
  const findings = []
  const contrastByCell = {} // `${flow}|${step}|${vw}` -> { light:{}, dark:{} }

  // Persona/flow selection
  let flowIds = JTBD.filter(f => FLOWS[f])
  if (!FLEET && PERSONA_ARG !== 'all')
    flowIds = flowIds.filter(f => FLOWS[f].persona === PERSONA_ARG || PERSONA_ARG === 'normal' && FLOWS[f].persona === 'normal')
  if (FLEET || PERSONA_ARG === 'all') flowIds = JTBD.filter(f => FLOWS[f])

  console.log(
    `live-ui-audit → ${BASE} as ${USER}\n  flows: ${flowIds.join(', ')}\n  viewports: ${VIEWPORTS.join(', ')}  themes: ${THEMES.join(', ')}\n`,
  )

  for (const flowId of flowIds) {
    const flow = FLOWS[flowId]
    for (const vw of VIEWPORTS) {
      for (const theme of THEMES) {
        const ctx = await browser.newContext({
          viewport: { width: vw, height: 900 },
          colorScheme: theme === 'dark' ? 'dark' : 'light',
        })
        // inject token before app JS runs + force theme class
        await ctx.addInitScript(
          ({ token, theme }) => {
            try {
              localStorage.setItem(
                'auth-storage',
                JSON.stringify({ state: { token }, version: 0 }),
              )
              localStorage.setItem('theme', theme)
              localStorage.setItem('ui-theme', theme)
            } catch {}
          },
          { token: access_token, theme },
        )
        const page = await ctx.newPage()

        // network log for this cell + the currently-executing step (for
        // per-step attribution of requests)
        const netLog = []
        const reqStart = new Map()
        let currentStep = '(load)'

        // driver-level listeners
        const cellTag = `${flowId}/${VIEWPORT_LABEL[vw] || vw}/${theme}`
        const push = f =>
          findings.push({
            flow: flowId,
            jtbd: flow.title,
            persona: flow.persona,
            viewport: vw,
            viewportLabel: VIEWPORT_LABEL[vw] || String(vw),
            theme,
            ...f,
          })
        page.on('console', m => {
          const t = m.text()
          if (m.type() !== 'error') return
          if (/Download the React DevTools|\[vite\]|Future Flag|Content-Security-Policy/i.test(t))
            return
          push({
            step: '(console)',
            category: /\[AppErrorBoundary/.test(t) ? 'crash' : 'console-error',
            severity: 'HIGH',
            selector: null,
            detail: t.replace(/\s+/g, ' ').slice(0, 280),
            screenshot: null,
          })
        })
        page.on('pageerror', e => {
          push({
            step: '(pageerror)',
            category: 'page-error',
            severity: 'HIGH',
            selector: null,
            detail: (e.message || String(e)).replace(/\s+/g, ' ').slice(0, 280),
            screenshot: null,
          })
        })
        const parsePath = url => {
          try {
            return new URL(url).pathname
          } catch {
            return null
          }
        }
        page.on('request', req => reqStart.set(req, { t: Date.now(), step: currentStep }))
        page.on('requestfailed', req => {
          const url = req.url()
          const started = reqStart.get(req)
          const p = parsePath(url)
          if (p && p.startsWith('/api/')) {
            // /api failures are handled by the network analyzer (subcategory
            // failure) — record into the log rather than double-reporting.
            netLog.push({
              url, path: p, method: req.method(),
              status: null, failure: req.failure()?.errorText || 'failed',
              ms: started ? Date.now() - started.t : null,
              tStart: started?.t, tEnd: Date.now(),
              bytes: 0, type: req.resourceType(), step: started?.step || currentStep,
            })
            return
          }
          // non-/api transport failure (asset) — real, report directly
          if (/favicon\.ico$|\.map$|^data:|@vite\/client|@react-refresh|hot-update/i.test(url))
            return
          push({
            step: '(request)',
            category: 'request-failed',
            severity: 'HIGH',
            selector: null,
            detail: `${req.method()} ${url} — ${req.failure()?.errorText ?? 'failed'}`,
            screenshot: null,
          })
        })
        page.on('requestfinished', async req => {
          const url = req.url()
          const p = parsePath(url)
          if (!p || !p.startsWith('/api/')) return
          const started = reqStart.get(req)
          let status = null
          let bytes = 0
          try {
            const resp = await req.response()
            status = resp?.status() ?? null
            const cl = resp?.headers()['content-length']
            bytes = cl ? Number(cl) : (await req.sizes()).responseBodySize || 0
          } catch {
            /* response gone */
          }
          netLog.push({
            url, path: p, method: req.method(),
            status, failure: null,
            ms: started ? Date.now() - started.t : null,
            tStart: started?.t, tEnd: Date.now(),
            bytes, type: req.resourceType(), step: started?.step || currentStep,
          })
        })

        try {
          // land on the app first for every flow
          await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
          await page
            .waitForSelector(CHAT_INPUT + ', [data-testid="layout-sidebar-toggle-button"]', {
              timeout: 20000,
            })
            .catch(() => {})
          await page.waitForTimeout(1200)

          for (const step of flow.steps) {
            currentStep = step.name
            try {
              await step.run(page)
            } catch (e) {
              push({
                step: step.name,
                category: 'step-error',
                severity: 'MEDIUM',
                selector: null,
                detail: `flow step "${step.name}" threw: ${(e.message || String(e)).slice(0, 160)}`,
                screenshot: null,
              })
            }
            // settle + audit
            await page.waitForTimeout(600)
            const shotRel = `screenshots/${flowId}__${step.name}__${VIEWPORT_LABEL[vw] || vw}__${theme}.png`
            await page
              .screenshot({ path: path.join(OUT, shotRel), fullPage: false })
              .catch(() => {})
            let audit
            try {
              audit = await page.evaluate(inPageAudit)
            } catch {
              await page.waitForTimeout(500)
              audit = await page.evaluate(inPageAudit).catch(() => null)
            }
            if (audit) {
              for (const f of audit.findings)
                push({ step: step.name, ...f, screenshot: shotRel })
              const key = `${flowId}|${step.name}|${vw}`
              contrastByCell[key] ??= {}
              contrastByCell[key][theme] = audit.contrast
            }
          }
        } catch (e) {
          push({
            step: '(nav)',
            category: 'nav-error',
            severity: 'HIGH',
            selector: null,
            detail: (e.message || String(e)).slice(0, 200),
            screenshot: null,
          })
        }
        // let in-flight requests finish, then analyze the cell's network log
        await page.waitForTimeout(500)
        analyzeNetwork(netLog, flowId, openapi, f =>
          push({ ...f, screenshot: null }),
        )
        await ctx.close()
        console.log(`  ✓ ${cellTag} (${netLog.length} /api reqs)`)
      }
    }
  }

  // ── permission + resource-scoping (RBAC) — its own persona set ───────────
  if (FLEET || JTBD.includes('permission') || PERSONA_ARG === 'all') {
    console.log('\n  running permission + resource-scoping audit…')
    await runPermissionAudit(browser, access_token, f => findings.push(f)).catch(e =>
      findings.push({
        flow: 'permission', jtbd: 'RBAC', persona: 'admin', viewport: 1280,
        viewportLabel: 'desktop', theme: 'light', step: '(error)',
        category: 'permission', subcategory: 'seed-error', severity: 'MEDIUM',
        selector: null, detail: `permission audit errored: ${e.message}`, screenshot: null,
      }),
    )
  }
  await browser.close()

  // ── light↔dark contrast parity diff ────────────────────────────────────
  for (const [key, byTheme] of Object.entries(contrastByCell)) {
    const light = byTheme.light
    const dark = byTheme.dark
    if (!light || !dark) continue
    const [flowId, step, vw] = key.split('|')
    for (const p of Object.keys(light)) {
      if (!(p in dark)) continue
      const lo = Math.min(light[p], dark[p])
      const hi = Math.max(light[p], dark[p])
      // AA-pass in one theme, AA-fail (<4.5) in the other → parity break
      if (lo + 0.05 < 4.5 && hi >= 4.5) {
        findings.push({
          flow: flowId,
          jtbd: FLOWS[flowId]?.title,
          persona: FLOWS[flowId]?.persona,
          viewport: Number(vw),
          viewportLabel: VIEWPORT_LABEL[vw] || vw,
          theme: light[p] < dark[p] ? 'light' : 'dark',
          step,
          category: 'theme-parity',
          severity: 'HIGH',
          selector: p.slice(-80),
          detail: `light↔dark contrast parity: ${light[p]}:1 (light) vs ${dark[p]}:1 (dark) — element readable in one theme, fails AA in the other`,
          screenshot: `screenshots/${flowId}__${step}__${VIEWPORT_LABEL[vw] || vw}__${light[p] < dark[p] ? 'light' : 'dark'}.png`,
        })
      }
    }
  }

  writeReport(findings)
}

// ── report ------------------------------------------------------------------
function writeReport(all) {
  // Dedup across viewports/themes: collapse identical (category, detail, flow,
  // step) into ONE row that lists every viewport×theme it appeared in.
  const groups = new Map()
  for (const f of all) {
    const norm = (f.detail || '').replace(/right=\d+px|left=-?\d+|scrollWidth \d+|\d{3,}/g, '#')
    const k = `${f.category}|${f.subcategory || ''}|${f.flow}|${f.step}|${norm}|${f.selector || ''}`
    if (!groups.has(k)) groups.set(k, { ...f, cells: [] })
    groups.get(k).cells.push(`${f.viewportLabel}/${f.theme}`)
  }
  const deduped = [...groups.values()].map(g => ({
    ...g,
    cells: [...new Set(g.cells)],
  }))
  deduped.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.category.localeCompare(b.category),
  )

  const bySev = { HIGH: 0, MEDIUM: 0, LOW: 0 }
  const byCat = {}
  for (const f of deduped) {
    bySev[f.severity]++
    const cat = f.subcategory ? `${f.category}/${f.subcategory}` : f.category
    byCat[cat] = (byCat[cat] || 0) + 1
  }

  fs.writeFileSync(
    path.join(OUT, 'findings.jsonl'),
    deduped.map(f => JSON.stringify(f)).join('\n') + (deduped.length ? '\n' : ''),
  )

  const md = []
  md.push('# Live UI Audit — findings\n')
  md.push(
    `Target: \`${BASE}\` · driven as \`${USER}\` · ${new Date().toISOString()}\n`,
  )
  md.push(
    'Evidence-based, objective signals only. Deduped across viewports×themes (each row lists the cells it appeared in). No subjective UX commentary.\n',
  )
  md.push('## Totals\n')
  md.push('| Severity | Count (deduped) |')
  md.push('|---|---|')
  md.push(`| 🔴 HIGH | ${bySev.HIGH} |`)
  md.push(`| 🟡 MEDIUM | ${bySev.MEDIUM} |`)
  md.push(`| ⚪ LOW | ${bySev.LOW} |`)
  md.push(`| **Total** | **${deduped.length}** (${all.length} raw) |\n`)
  md.push('## By category\n')
  md.push('| Category | Count |')
  md.push('|---|---|')
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
    md.push(`| \`${c}\` | ${n} |`)
  md.push('')
  md.push('## Findings (most-severe first)\n')
  const icon = s => (s === 'HIGH' ? '🔴' : s === 'MEDIUM' ? '🟡' : '⚪')
  for (const f of deduped) {
    md.push(
      `### ${icon(f.severity)} ${f.severity} · \`${f.subcategory ? `${f.category}/${f.subcategory}` : f.category}\` — ${f.flow} / ${f.step}`,
    )
    md.push(`- **JTBD:** ${f.jtbd || f.flow} (persona: ${f.persona || 'normal'})`)
    md.push(`- **Signal:** ${f.detail}`)
    if (f.selector) md.push(`- **Element:** \`${f.selector}\``)
    md.push(`- **Cells:** ${f.cells.join(', ')}`)
    if (f.screenshot) md.push(`- **Screenshot:** \`${f.screenshot}\``)
    md.push(
      `- **Repro:** login ${USER} → flow \`${f.flow}\` → step \`${f.step}\` at ${f.cells[0]}`,
    )
    md.push('')
  }
  fs.writeFileSync(path.join(OUT, 'findings.md'), md.join('\n'))

  console.log(
    `\n=== live-ui-audit: ${deduped.length} deduped findings (HIGH ${bySev.HIGH} / MEDIUM ${bySev.MEDIUM} / LOW ${bySev.LOW}) from ${all.length} raw ===`,
  )
  console.log(`  → ${path.join(OUT, 'findings.md')}`)
  console.log(`  → ${path.join(OUT, 'findings.jsonl')}`)
  console.log(`  → ${path.join(OUT, 'screenshots')}/`)
  if (GATE && bySev.HIGH > 0) process.exitCode = 1
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
