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

const CHAT_INPUT =
  '[data-testid="chat-message-textarea"], textarea[placeholder*="Type your message"]'

// ── Surface-sweep helper ----------------------------------------------------
// Most "audit every page" work is the same shape: navigate to a route, let it
// settle, let the battery audit the rendered surface. `nav()` builds such a
// step; `sweep()` builds a whole flow out of a route list. Keeping this generic
// means adding a surface is one line, and the step name (= the surface slug)
// becomes the report's per-surface grouping key.
// ── Real-LLM flow helpers ---------------------------------------------------
// Auditing a generative surface after a FIXED sleep audits the pending/streaming
// state, not the settled result — and render bugs live in the settled result.
// These helpers wait for the real reply to actually finish, and make "no reply
// arrived" a visible FINDING rather than a silent pass. Selectors are written as
// fallback lists so one flow set works across builds that differ in testids.
const ASSISTANT_MSG =
  '[data-testid="chat-message"][data-role="assistant"], [data-role="assistant"]'
const SEND_BTN =
  '[data-testid="chat-input-send-btn"], button[aria-label="Send message"]'

/**
 * Wait for the assistant's reply to APPEAR and then STOP GROWING.
 * Settled = last assistant message has text, its length is unchanged for
 * `stableTicks` consecutive 1s polls, and the send control is no longer busy.
 * Always returns (never throws) so a hung generation is reported, not hung on.
 */
async function waitForSettledReply(page, { cap = 150000, stableTicks = 3 } = {}) {
  const t0 = Date.now()
  let firstTokenMs = null
  let lastLen = 0
  let stable = 0
  let settled = false
  while (Date.now() - t0 < cap) {
    const s = await page
      .evaluate(
        ([A, S]) => {
          const a = [...document.querySelectorAll(A)]
          const btn = document.querySelector(S)
          return {
            n: a.length,
            len: (a[a.length - 1]?.innerText || '').length,
            busy: !!(btn && (btn.disabled || btn.getAttribute('aria-busy') === 'true')),
          }
        },
        [ASSISTANT_MSG, SEND_BTN],
      )
      .catch(() => null)
    if (!s) break
    if (s.len > 0 && firstTokenMs === null) firstTokenMs = Date.now() - t0
    if (s.len > 0 && s.len === lastLen && !s.busy) {
      if (++stable >= stableTicks) {
        settled = true
        break
      }
    } else stable = 0
    lastLen = s.len
    await page.waitForTimeout(1000)
  }
  return { ms: Date.now() - t0, firstTokenMs, chars: lastLen, settled }
}

/** Which rich-render primitives actually rendered (evidence of what was exercised). */
const probeRenderPrimitives = page =>
  page
    .evaluate(() => ({
      assistants: document.querySelectorAll('[data-role="assistant"]').length,
      code: document.querySelectorAll('[data-streamdown="code-block"], pre code').length,
      mermaid: document.querySelectorAll('[data-testid="mermaid-diagram"]').length,
      katex: document.querySelectorAll('.katex, .katex-display').length,
      html: document.querySelectorAll('[data-testid^="html-block"]').length,
      toolCard: document.querySelectorAll(
        '[data-testid^="mcp-toolcall-card-"],[data-testid^="mcp-tooluse-card-"],[data-testid="mcp-toolgroup-card"]',
      ).length,
      approval: document.querySelectorAll('[data-testid^="tool-approval-"]').length,
      toolError: document.querySelectorAll(
        '[data-testid^="mcp-toolcall-error-alert-"],[data-testid^="mcp-tooluse-error-alert-"]',
      ).length,
      fileCard: document.querySelectorAll('[data-testid="file-card"]').length,
      renderCrash: document.querySelectorAll('[data-testid="streamdown-fallback"]').length,
    }))
    .catch(() => ({}))

/**
 * Step factory: send `prompt` to the REAL model, wait for the settled reply,
 * audit that, and emit evidence findings describing what actually happened.
 * `expect` names a render primitive that this prompt is meant to produce; if the
 * reply settles without it, that is reported (objective: the primitive counted 0).
 */
const ask = (name, prompt, { expect = null, cap = 150000 } = {}) => ({
  name,
  run: async page => {
    const out = []
    const ta = page.locator(CHAT_INPUT).first()
    if (!(await ta.count().catch(() => 0))) {
      return [{
        category: 'step-error', severity: 'HIGH', selector: CHAT_INPUT,
        detail: `composer not present — cannot exercise the model for "${name}"`,
      }]
    }
    const before = await page
      .evaluate(A => document.querySelectorAll(A).length, ASSISTANT_MSG)
      .catch(() => 0)
    await ta.fill(prompt)
    await ta.press('Enter')
    const r = await waitForSettledReply(page, { cap })
    const p = await probeRenderPrimitives(page)
    const grew = (p.assistants ?? 0) > before

    // EVIDENCE row: what real infra actually did (always emitted, LOW).
    out.push({
      category: 'llm-infra', severity: 'LOW', selector: null,
      detail:
        `REAL-LLM exercised "${name}": settled=${r.settled} reply_arrived=${grew} ` +
        `total=${r.ms}ms first_token=${r.firstTokenMs ?? 'never'}ms chars=${r.chars} ` +
        `rendered={code:${p.code ?? 0} mermaid:${p.mermaid ?? 0} katex:${p.katex ?? 0} ` +
        `html:${p.html ?? 0} toolCard:${p.toolCard ?? 0} approval:${p.approval ?? 0} ` +
        `toolError:${p.toolError ?? 0} fileCard:${p.fileCard ?? 0}}`,
    })
    // No reply at all → the surface under audit is a PENDING state, which must
    // never be mistaken for a healthy settled render.
    if (!grew || r.chars === 0)
      out.push({
        category: 'llm-no-reply', severity: 'HIGH', selector: null,
        detail:
          `no assistant reply rendered within ${cap}ms for "${name}" ` +
          `(first_token=${r.firstTokenMs ?? 'never'}, chars=${r.chars}). ` +
          `The audited surface is a PENDING state, not a settled result.`,
      })
    else if (!r.settled)
      out.push({
        category: 'llm-no-settle', severity: 'MEDIUM', selector: null,
        detail: `reply started but never settled within ${cap}ms for "${name}" (chars=${r.chars}) — audited mid-stream`,
      })
    else if (expect && !(p[expect] > 0))
      out.push({
        category: 'llm-render-missing', severity: 'MEDIUM', selector: null,
        detail:
          `settled reply for "${name}" rendered NO \`${expect}\` primitive ` +
          `(count 0) though the prompt requested it — render path not exercised or not rendering.`,
      })
    if (p.renderCrash > 0)
      out.push({
        category: 'crash', severity: 'HIGH', selector: '[data-testid="streamdown-fallback"]',
        detail: `markdown renderer fell back to its error boundary (streamdown-fallback present) on "${name}"`,
      })
    return out
  },
})

const nav = (name, pathOf, settle = 2500) => ({
  name,
  run: async (page, ctx) => {
    const target = typeof pathOf === 'function' ? pathOf(ctx) : pathOf
    if (!target) return // fixture unavailable → nothing to audit, not a finding
    await page
      .goto(`${BASE}${target}`, { waitUntil: 'domcontentloaded' })
      .catch(() => {})
    await page.waitForTimeout(settle)
  },
})
const sweep = (title, routes, persona = 'normal') => ({
  title,
  persona,
  steps: routes.map(([name, p]) => nav(name, p)),
})

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

  // ── Feature surfaces ─────────────────────────────────────────────────────
  // JTBD: "I re-open a conversation I already have and work inside it."
  // Covers the loaded-chat surface, the right side panel, and the per-message
  // action affordances (branch / edit / regenerate) that only exist on a real
  // conversation with real messages.
  'chat-existing': {
    title: 'Open an existing conversation, its right panel and message actions',
    persona: 'normal',
    steps: [
      nav('chat-conversation', ctx => ctx.conversationId && `/chat/${ctx.conversationId}`, 4000),
      {
        name: 'chat-right-panel',
        run: async page => {
          // Open the right/side panel by whichever affordance this build ships.
          const opener = page
            .locator(
              '[data-testid*="right-panel"], [data-testid*="panel-toggle"], ' +
                'button[aria-label*="panel" i], button[title*="panel" i]',
            )
            .first()
          if (await opener.count().catch(() => 0))
            await opener.click({ timeout: 4000 }).catch(() => {})
          await page.waitForTimeout(2500)
        },
      },
      {
        name: 'chat-message-actions',
        run: async page => {
          // Reveal the hover-only per-message toolbar on the last message, then
          // open any branch/version affordance it exposes.
          const msg = page
            .locator('[data-testid*="message"], [class*="message"]')
            .last()
          if (await msg.count().catch(() => 0))
            await msg.hover({ timeout: 4000 }).catch(() => {})
          await page.waitForTimeout(800)
          const branch = page
            .locator(
              'button[aria-label*="branch" i], button[title*="branch" i], ' +
                'button[aria-label*="edit" i], button[aria-label*="regenerate" i]',
            )
            .first()
          if (await branch.count().catch(() => 0))
            await branch.click({ timeout: 3000 }).catch(() => {})
          await page.waitForTimeout(2000)
        },
      },
    ],
  },
  // JTBD: "I find one of my past conversations."
  'conversations-list': sweep('Browse the conversation list', [
    ['conversations', '/chats'],
  ]),
  // JTBD: "I organise work in a project and see its files."
  projects: {
    title: 'Browse projects and open a project workspace',
    persona: 'normal',
    steps: [
      nav('projects-list', '/projects'),
      nav('project-detail', ctx => ctx.projectId && `/projects/${ctx.projectId}`, 3500),
      {
        name: 'project-files',
        run: async page => {
          // Project detail is tabbed; open the files/knowledge tab if present.
          const tab = page
            .getByRole('tab', { name: /file|knowledge|reference/i })
            .first()
          if (await tab.count().catch(() => 0))
            await tab.click({ timeout: 4000 }).catch(() => {})
          await page.waitForTimeout(2000)
        },
      },
    ],
  },
  // JTBD: "I manage the knowledge base the agent retrieves from."
  'knowledge-base': {
    title: 'Browse knowledge bases',
    persona: 'normal',
    steps: [
      nav('knowledge-list', '/knowledge'),
      nav('knowledge-detail', ctx => ctx.kbId && `/knowledge/${ctx.kbId}`, 3000),
    ],
  },
  // JTBD: "I look at a file I uploaded."
  files: {
    title: 'Open an uploaded file',
    persona: 'normal',
    steps: [nav('file-detail', ctx => ctx.fileId && `/files/${ctx.fileId}`, 4000)],
  },
  // JTBD: "I schedule work to run unattended."
  'scheduled-tasks': sweep('Browse scheduled tasks', [
    ['scheduled-tasks', '/scheduled-tasks'],
  ]),
  // JTBD: "I install models / assistants / MCP servers / skills from the hub."
  hub: sweep('Browse the hub catalog tabs', [
    ['hub-installed', '/hub/installed'],
    ['hub-models', '/hub/models'],
    ['hub-assistants', '/hub/assistants'],
    ['hub-mcp-servers', '/hub/mcp-servers'],
    ['hub-skills', '/hub/skills'],
    ['hub-workflows', '/hub/workflows'],
  ]),
  // JTBD: "I check what happened while I was away."
  notifications: sweep('Review notifications and background runs', [
    ['notifications', '/notifications'],
    ['notifications-background', '/notifications/background'],
  ]),

  // ── Settings surfaces (split into 4 flows so they can run in parallel) ────
  // JTBD: "I configure MY account and MY tools."
  'settings-user': sweep('Configure user-scoped settings', [
    ['settings-root', '/settings'],
    ['settings-general', '/settings/general'],
    ['settings-profile', '/settings/profile'],
    ['settings-assistants', '/settings/assistants'],
    ['settings-user-llm-providers', '/settings/user-llm-providers'],
    ['settings-mcp-servers', '/settings/mcp-servers'],
    ['settings-memory', '/settings/memory'],
    ['settings-skills', '/settings/skills'],
    ['settings-workflows', '/settings/workflows'],
    ['settings-citations', '/settings/citations'],
    ['settings-literature-keys', '/settings/literature-keys'],
    ['settings-web-search-keys', '/settings/web-search-keys'],
  ]),
  // JTBD (admin): "I administer users, auth and the deployment itself."
  'settings-admin-core': sweep('Administer users, auth and deployment', [
    ['settings-users', '/settings/users'],
    ['settings-user-groups', '/settings/user-groups'],
    ['settings-sessions', '/settings/sessions'],
    ['settings-auth-providers', '/settings/auth-providers'],
    ['settings-hardware', '/settings/hardware'],
    ['settings-about', '/settings/about'],
    ['settings-agent', '/settings/agent'],
    ['settings-assistant-templates', '/settings/assistant-templates'],
  ]),
  // JTBD (admin): "I administer model serving and retrieval."
  'settings-admin-llm': sweep('Administer LLM providers, runtime and retrieval', [
    ['settings-llm-providers', '/settings/llm-providers'],
    ['settings-llm-repositories', '/settings/llm-repositories'],
    ['settings-llm-runtime', '/settings/llm-runtime'],
    ['settings-summarization-admin', '/settings/summarization-admin'],
    ['settings-file-rag-admin', '/settings/file-rag-admin'],
    ['settings-memory-admin', '/settings/memory-admin'],
  ]),
  // ── REAL-LLM generation surfaces ─────────────────────────────────────────
  // These drive the actual configured model (no stub) and audit the SETTLED
  // render. Each targets a render path that only exists once real generated
  // content arrives.
  'llm-reply': {
    title: 'Ask the real model a question and read the settled reply',
    persona: 'normal',
    steps: [ask('llm-reply', 'What is 2 + 2? Answer in one word.', { cap: 90000 })],
  },
  'llm-render-code': {
    title: 'Real model returns a fenced code block (syntax highlighting)',
    persona: 'normal',
    steps: [
      ask(
        'llm-code-block',
        'Write a Python function that reverses a string. Reply with ONLY one fenced ```python code block, no prose.',
        { expect: 'code' },
      ),
    ],
  },
  'llm-render-mermaid': {
    title: 'Real model returns a mermaid diagram',
    persona: 'normal',
    steps: [
      ask(
        'llm-mermaid',
        'Reply with ONLY a fenced ```mermaid block containing: graph TD; A[Start]-->B[Middle]; B-->C[End]; . No prose.',
        { expect: 'mermaid' },
      ),
    ],
  },
  'llm-render-math': {
    title: 'Real model returns LaTeX math (KaTeX)',
    persona: 'normal',
    steps: [
      ask(
        'llm-math',
        'Reply with ONLY the quadratic formula as display LaTeX between $$ delimiters. No prose.',
        { expect: 'katex' },
      ),
    ],
  },
  'llm-render-html': {
    title: 'Real model returns a fenced HTML block (sandboxed preview)',
    persona: 'normal',
    steps: [
      ask(
        'llm-html',
        'Reply with ONLY one fenced ```html block containing a small complete HTML page with a heading and a styled button. No prose.',
        { expect: 'html' },
      ),
      {
        name: 'llm-html-preview',
        run: async page => {
          // The html block defaults to Code mode; flip to Preview to exercise
          // the sandboxed iframe render path.
          const t = page
            .locator('[data-testid="html-block-toggle"], [aria-label="HTML block view mode"]')
            .first()
          if (await t.count().catch(() => 0)) {
            await t.getByText(/preview/i).click({ timeout: 4000 }).catch(async () => {
              await t.click({ timeout: 4000 }).catch(() => {})
            })
          }
          await page.waitForTimeout(3000)
        },
      },
    ],
  },
  'llm-long-response': {
    title: 'Real model returns a LONG response (scrolling, jump-to-latest)',
    persona: 'normal',
    steps: [
      ask(
        'llm-long',
        'List 30 numbered facts about the ocean. Write at least two full sentences for each. Be verbose.',
        { cap: 240000 },
      ),
      {
        name: 'llm-long-scrolled-top',
        run: async page => {
          // Scroll the message list back UP — exercises the jump-to-latest
          // affordance and long-content layout.
          await page.mouse.move(400, 400)
          await page.mouse.wheel(0, -4000)
          await page.waitForTimeout(2500)
        },
      },
    ],
  },
  // JTBD: "I ask the agent to actually RUN code." Exercises the tool-call card,
  // any approval prompt, and the tool-result render against the real sandbox.
  'sandbox-exec': {
    title: 'Ask the real model to execute code in the sandbox (tool-use)',
    persona: 'normal',
    steps: [
      ask(
        'sandbox-exec',
        'Use your code execution tool to run this exact bash command and show me its output: echo ZIEE_SANDBOX_OK_123',
        { expect: 'toolCard', cap: 300000 },
      ),
      {
        name: 'sandbox-exec-approval',
        run: async page => {
          // If an approval prompt appeared, approve once so the tool actually
          // executes (the point of the flow); then wait for the settled result.
          // Approve affordance: prefer the app's testids, fall back to an
          // accessible-name match so the flow still works on builds that ship
          // different testids (or none).
          const approve = page
            .locator(
              '[data-testid="tool-approval-approve-once"], [data-testid="tool-approval-approve-conv"], ' +
                'button:has-text("Approve once"), button:has-text("Approve")',
            )
            .first()
          const findings = []
          if (await approve.count().catch(() => 0)) {
            findings.push({
              category: 'llm-infra', severity: 'LOW', selector: null,
              detail: 'sandbox tool-call required interactive approval; approving once to exercise execution',
            })
            await approve.click({ timeout: 5000 }).catch(() => {})
            const r = await waitForSettledReply(page, { cap: 300000 })
            findings.push({
              category: 'llm-infra', severity: 'LOW', selector: null,
              detail: `post-approval settle: settled=${r.settled} total=${r.ms}ms chars=${r.chars}`,
            })
          }
          const p = await probeRenderPrimitives(page)
          // The sentinel is IN THE PROMPT, so it is echoed by the user's own
          // message bubble — searching document.body would "confirm" execution
          // that never happened. Scope the check to ASSISTANT/tool output only.
          const asstText = await page
            .evaluate(
              A => [...document.querySelectorAll(A)].map(e => e.innerText || '').join('\n'),
              ASSISTANT_MSG,
            )
            .catch(() => '')
          const executed = /ZIEE_SANDBOX_OK_123/.test(asstText)
          const awaitingApproval =
            (p.approval ?? 0) > 0 || /requires your approval|needs approval/i.test(asstText)
          findings.push({
            category: 'llm-infra',
            severity: executed ? 'LOW' : 'MEDIUM',
            selector: null,
            detail:
              `SANDBOX EXECUTION ${executed ? 'CONFIRMED' : 'NOT CONFIRMED'}: sentinel ` +
              `ZIEE_SANDBOX_OK_123 ${executed ? 'found' : 'absent'} in ASSISTANT/tool output ` +
              `(user-prompt echo excluded). awaiting_approval=${awaitingApproval} ` +
              `toolCard=${p.toolCard ?? 0} approval=${p.approval ?? 0} toolError=${p.toolError ?? 0}. ` +
              `Ground truth for "did it run" is GET /api/mcp/tool-calls, not page text. ` +
              `(A first sandbox call may lazily fetch+mount a rootfs; NOT-CONFIRMED means the tool did not ` +
              `complete in this run, NOT that the surface is healthy.)`,
          })
          return findings
        },
      },
    ],
  },
  // JTBD: "I attach a file to my message."
  'file-attach': {
    title: 'Attach a file to a chat message',
    persona: 'normal',
    steps: [
      {
        name: 'file-attach',
        run: async page => {
          const findings = []
          // Reveal the attach affordance (it lives behind the composer "+").
          const add = page
            .locator('[data-testid="chat-input-add-btn"], button[aria-label="Add tools & files"]')
            .first()
          if (await add.count().catch(() => 0))
            await add.click({ timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(1200)
          const input = page.locator('input[type=file]').first()
          if (!(await input.count().catch(() => 0))) {
            findings.push({
              category: 'llm-infra', severity: 'MEDIUM', selector: 'input[type=file]',
              detail: 'no file input reachable from the composer — attachment path NOT exercised',
            })
            return findings
          }
          const tmp = path.join(OUT, 'audit-attachment.txt')
          try {
            fs.writeFileSync(tmp, 'ziee live-ui-audit attachment fixture\n')
            await input.setInputFiles(tmp)
          } catch (e) {
            findings.push({
              category: 'llm-infra', severity: 'MEDIUM', selector: null,
              detail: `could not set file input: ${(e.message || e).slice(0, 120)}`,
            })
            return findings
          }
          await page.waitForTimeout(4000)
          const p = await probeRenderPrimitives(page)
          findings.push({
            category: 'llm-infra',
            severity: (p.fileCard ?? 0) > 0 ? 'LOW' : 'MEDIUM',
            selector: null,
            detail: `attachment card after upload: fileCard=${p.fileCard ?? 0} (0 = attachment UI did not render)`,
          })
          return findings
        },
      },
      ask('file-attach-send', 'In one short sentence, what is in the attached file?', {
        cap: 120000,
      }),
    ],
  },

  // JTBD (admin): "I administer the agent's tools."
  'settings-admin-tools': sweep('Administer built-in and external tools', [
    ['settings-mcp-admin', '/settings/mcp-admin'],
    ['settings-sandbox', '/settings/sandbox'],
    ['settings-web-search', '/settings/web-search'],
    ['settings-literature', '/settings/literature'],
    ['settings-voice', '/settings/voice'],
    ['settings-js-tool', '/settings/js-tool'],
    ['settings-scheduler', '/settings/scheduler'],
    ['settings-skills-admin', '/settings/skills-admin'],
    ['settings-workflows-admin', '/settings/workflows-admin'],
  ]),
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
// Settings surfaces are administrative: the whole management API surface is
// on-page-purpose there, so one broad set covers every settings flow.
const SETTINGS_DOMAINS = [
  'users', 'user-groups', 'groups', 'settings', 'providers', 'llm-providers',
  'user-llm-providers', 'model', 'models', 'llm-models', 'llm-repositories',
  'repositories', 'local-llm', 'llm-runtime', 'runtime', 'engines', 'mcp',
  'auth', 'session-settings', 'memory', 'summarization', 'web-search',
  'lit-search', 'code-sandbox', 'sandbox', 'voice', 'file-rag',
  'knowledge-bases', 'citations', 'hardware', 'notifications', 'user-settings',
  'assistants', 'assistant-templates', 'skills', 'workflows', 'scheduler',
  'scheduled-tasks', 'js-tool', 'agent', 'agent-settings', 'server-update',
  'auth-providers', 'files', 'hub', 'usage', 'projects',
]
const FLOW_RELEVANT_DOMAINS = {
  home: CHAT_DOMAINS,
  'compose-send': CHAT_DOMAINS,
  'adversarial-compose': CHAT_DOMAINS,
  'browse-settings': SETTINGS_DOMAINS,
  'chat-existing': CHAT_DOMAINS,
  'conversations-list': CHAT_DOMAINS,
  projects: [...CHAT_DOMAINS, 'projects'],
  'knowledge-base': ['knowledge-bases', 'knowledge', 'files', 'file-rag', 'conversations', 'projects'],
  files: ['files', 'file-rag', 'conversations', 'projects'],
  'scheduled-tasks': ['scheduled-tasks', 'scheduler', 'conversations', 'assistants', 'models', 'llm-models', 'workflows'],
  hub: ['hub', 'models', 'llm-models', 'assistants', 'mcp', 'skills', 'workflows', 'llm-providers', 'providers'],
  notifications: ['notifications', 'conversations', 'workflows', 'scheduled-tasks', 'runs'],
  'settings-user': SETTINGS_DOMAINS,
  'settings-admin-core': SETTINGS_DOMAINS,
  'settings-admin-llm': SETTINGS_DOMAINS,
  'settings-admin-tools': SETTINGS_DOMAINS,
  // real-LLM flows live on the chat surface (plus tool/sandbox endpoints)
  'llm-reply': CHAT_DOMAINS,
  'llm-render-code': CHAT_DOMAINS,
  'llm-render-mermaid': CHAT_DOMAINS,
  'llm-render-math': CHAT_DOMAINS,
  'llm-render-html': CHAT_DOMAINS,
  'llm-long-response': CHAT_DOMAINS,
  'sandbox-exec': [...CHAT_DOMAINS, 'code-sandbox', 'sandbox', 'tool-result'],
  'file-attach': [...CHAT_DOMAINS, 'files'],
}

function analyzeNetwork(log, flowId, openapi, pushRaw) {
  // log: [{url, path, method, status, ms, bytes, type, step, failure}]
  const api = log.filter(r => r.path && r.path.startsWith('/api/'))
  const relevant = FLOW_RELEVANT_DOMAINS[flowId] || []
  // The synthetic `(load)` step is the DRIVER's own bootstrap: every flow lands
  // on `/` (the chat home) first so the shell is authenticated before the flow's
  // own navigation. Requests attributed to it therefore belong to the HOME page,
  // not to the flow's target surface — judging them against the target surface's
  // relevant-domain set flags the whole chat home as "irrelevant" on every
  // non-chat flow (a pure false positive introduced by nav-driven sweep flows).
  // Judge `(load)` against the home page's own domain set instead.
  const relevantFor = step => (step === '(load)' ? CHAT_DOMAINS : relevant)
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
      if (SHELL_DOMAINS.has(seg) || relevantFor(step).includes(seg)) continue
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

  // 7. excess / polling (re-render storm / timer)
  // Counted PER STEP, not per cell. A nav-driven sweep flow visits N pages in
  // one cell, and the app shell legitimately re-fetches its own endpoints once
  // per navigation — so a per-cell threshold flags every shell endpoint on every
  // multi-page flow (the dominant FP once sweep flows were added). The true
  // render-storm signal is one STEP (one page) firing the same endpoint ≥4×.
  const cellKey = {}
  for (const r of api)
    (cellKey[`${r.method} ${r.path}`] ??= []).push(r)
  for (const [k, all] of Object.entries(cellKey)) {
    const perStep = {}
    for (const r of all) (perStep[r.step] ??= []).push(r)
    const worstStep = Object.entries(perStep).sort((a, b) => b[1].length - a[1].length)[0]
    const group = worstStep ? worstStep[1] : []
    if (group.length >= 4) {
      pushRaw({
        step: worstStep[0],
        category: 'network',
        subcategory: 'excess',
        severity: 'MEDIUM',
        selector: null,
        detail: `excess/polling: ${k} fired ${group.length}× within the single step "${worstStep[0]}" (possible timer/render-storm; ${all.length}× across the whole flow)`,
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
  // identity / deployment
  { route: '/settings/users', api: '/api/users', perm: 'users::read' },
  { route: '/settings/user-groups', api: '/api/groups', perm: 'groups::read' },
  { route: '/settings/sessions', api: '/api/auth/session-settings', perm: 'auth::session_settings::read' },
  { route: '/settings/auth-providers', api: '/api/admin/auth-providers', perm: 'auth_providers::read' },
  { route: '/settings/hardware', api: '/api/hardware', perm: 'hardware::read' },
  { route: '/settings/about', api: '/api/server-update/status', perm: 'server_update::read' },
  { route: '/settings/agent', api: '/api/agent/settings', perm: 'agent::settings::read' },
  { route: '/settings/assistant-templates', api: '/api/assistant-templates', perm: 'assistants::template::read' },
  // model serving / retrieval
  { route: '/settings/llm-providers', api: '/api/llm-providers', perm: 'llm_providers::read' },
  { route: '/settings/llm-repositories', api: '/api/llm-repositories', perm: 'llm_repositories::read' },
  { route: '/settings/llm-runtime', api: '/api/local-runtime/settings', perm: 'local_runtime::settings::read' },
  { route: '/settings/summarization-admin', api: '/api/summarization/settings', perm: 'summarization::settings::read' },
  { route: '/settings/file-rag-admin', api: '/api/file-rag/admin-settings', perm: 'file_rag::admin::read' },
  { route: '/settings/memory-admin', api: '/api/memory/admin-settings', perm: 'memory::admin::read' },
  // agent tooling
  { route: '/settings/mcp-admin', api: '/api/mcp/system-servers', perm: 'mcp_servers::admin::read' },
  { route: '/settings/sandbox', api: '/api/code-sandbox/resource-limits', perm: 'code_sandbox::resource_limits::read' },
  { route: '/settings/web-search', api: '/api/web-search/settings', perm: 'web_search::admin::read' },
  { route: '/settings/literature', api: '/api/lit-search/settings', perm: 'lit_search::admin::read' },
  { route: '/settings/voice', api: '/api/voice/settings', perm: 'voice::admin::read' },
  { route: '/settings/js-tool', api: '/api/js-tool/settings', perm: 'js_tool::settings::read' },
  { route: '/settings/scheduler', api: '/api/scheduler/admin-settings', perm: 'scheduler::admin::read' },
  { route: '/settings/skills-admin', api: '/api/skills/system', perm: 'skills::manage_system' },
  { route: '/settings/workflows-admin', api: '/api/workflows/system', perm: 'workflows::manage_system' },
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
    // Wait for the DENIAL (or the page) to actually resolve. A route whose
    // module is lazily loaded can still be showing the route spinner after 2s —
    // reading the body then yields "no denial text", which reported a gated
    // route as an ungated surface (a pure FP: every one of these turned out to
    // render "Not authorized" a few seconds later). Poll for a settled body.
    const denialSeen = await page
      .waitForFunction(
        () => {
          const t = document.body?.innerText || ''
          if (/not authorized|don't have permission|forbidden|access denied|403/i.test(t))
            return true
          // settled non-empty page that is NOT just a spinner
          return t.trim().length > 80 && !document.querySelector('[data-testid="route-spinner"]')
        },
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false)
    void denialSeen
    await page.waitForTimeout(1000)
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
    } else if (stayed && !denied && backingStatus !== undefined) {
      // NOTE the `backingStatus !== undefined` guard. If the page never issued
      // its backing admin request, we did not observe a rendered gated surface —
      // we observed a page that did not load (or one the gate blocked before it
      // fetched). Reporting that as an ungated surface was a pure FP: every such
      // row verified as correctly rendering "Not authorized". Only flag when the
      // page really did reach its admin API and still rendered.
      rec('restricted', {
        step: m.route, category: 'permission', subcategory: 'ungated-surface',
        severity: 'MEDIUM', selector: m.route, screenshot: shot,
        detail: `route ${m.route} rendered for restricted-user (url stayed, no explicit denial) and its backing API returned ${backingStatus}. Verify the page shell exposes no gated affordance. Oracle: requires ${m.perm}.`,
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

// ── flow fixtures -----------------------------------------------------------
// Detail routes (/chat/:id, /projects/:id, …) need a REAL id. Resolve them once
// from the live API instead of hardcoding, so the same flow set works against
// any instance. A missing fixture makes its nav step a graceful no-op rather
// than a false "broken surface" finding.
async function resolveFixtures(token) {
  const pick = async (urlPath, ...keys) => {
    const { json } = await apiStatus(token, urlPath)
    if (!json) return null
    for (const k of keys) {
      const arr = json[k]
      if (Array.isArray(arr) && arr.length) return arr[0]?.id ?? null
    }
    if (Array.isArray(json) && json.length) return json[0]?.id ?? null
    return null
  }
  const f = {
    conversationId: await pick('/api/conversations?page=1&per_page=5', 'conversations', 'items', 'data'),
    projectId: await pick('/api/projects', 'projects', 'items', 'data'),
    kbId: await pick('/api/knowledge-bases', 'knowledge_bases', 'items', 'data'),
    fileId: await pick('/api/files', 'files', 'items', 'data'),
  }
  console.log(
    `  fixtures: ${Object.entries(f)
      .map(([k, v]) => `${k}=${v ? String(v).slice(0, 8) : '—'}`)
      .join(' ')}`,
  )
  return f
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

  const fixtures = await resolveFixtures(access_token)
  const findings = []

  // ── Real-infra preflight ────────────────────────────────────────────────
  // The generative flows are worthless if the driving user cannot open a chat
  // stream. Probe the streaming endpoints for THIS user up-front and record it,
  // so a run that could only ever observe pending-states says so explicitly
  // instead of reading as "the app is fine".
  const preflight = []
  for (const ep of ['/api/chat/stream', '/api/sync/subscribe']) {
    const ctrl = AbortSignal.timeout(4000)
    let status = 0
    try {
      status = (await fetch(BASE + ep, {
        headers: { Authorization: `Bearer ${access_token}` },
        signal: ctrl,
      })).status
    } catch {
      status = -1 // stream held open == reachable
    }
    preflight.push({ ep, status })
    if (status === 429)
      findings.push({
        flow: '(preflight)', jtbd: 'real-infra preflight', persona: USER,
        viewport: 1280, viewportLabel: 'desktop', theme: 'light',
        step: '(preflight)', category: 'llm-infra', severity: 'HIGH', selector: ep,
        detail:
          `STREAMING UNAVAILABLE for the driving user "${USER}": ${ep} → 429 before any audit load. ` +
          `Generative flows cannot receive a reply as this user; any chat surface audited in this run is a ` +
          `PENDING state. (Per-user stream/connection slots are exhausted — verify with a freshly created user.)`,
        screenshot: null,
      })
  }
  console.log(
    `  real-infra preflight as ${USER}: ${preflight.map(p => `${p.ep}=${p.status === -1 ? 'open' : p.status}`).join('  ')}`,
  )

  const browser = await chromium.launch({ headless: !HEADED })
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
          // `net::ERR_ABORTED` on a lazily-loaded chunk is the BROWSER cancelling
          // an in-flight download because we navigated away — a driver artifact
          // of sweeping many routes quickly, not an app defect. (A genuine
          // chunk-load failure surfaces as ERR_FAILED / ERR_CONNECTION_* / 404,
          // which still reports.) Same rationale as the SSE ERR_ABORTED mute.
          if (req.failure()?.errorText === 'net::ERR_ABORTED') return
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
              // A step MAY return findings of its own (real-LLM/sandbox
              // evidence rows that only the step can observe). The driver
              // stamps them like any other finding.
              const extra = await step.run(page, fixtures)
              if (Array.isArray(extra))
                for (const f of extra) push({ step: step.name, screenshot: null, ...f })
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
// A finding's SURFACE is the page/screen it fired on. Nav-driven steps are named
// after the surface they open, so the step name IS the surface; driver-level
// findings (console/pageerror/nav) carry a parenthesised pseudo-step and are
// attributed to the flow instead.
const surfaceOf = f =>
  f.step && !String(f.step).startsWith('(') ? f.step : `${f.flow} (flow-level)`
// The seven audit DIMENSIONS the battery reports against (the report groups by
// these; raw categories map onto them).
const DIMENSION = {
  // 1. functional bugs
  'console-error': 'bug', 'page-error': 'bug', crash: 'bug',
  'request-failed': 'bug', 'nav-error': 'bug', 'step-error': 'bug',
  'stuck-loading': 'bug',
  // 2. UI / visual correctness
  'control-collision': 'ui', 'broken-image': 'ui', 'zero-size-control': 'ui',
  // 3. responsive
  'overflow-x': 'responsive', 'clipped-control': 'responsive',
  // 4. color / theme
  contrast: 'color-theme', 'theme-parity': 'color-theme',
  'palette-drift': 'color-theme',
  // 5. design-system consistency
  'spacing-grid': 'consistency', 'mixed-variant': 'consistency',
  // 6. network hygiene   7. RBAC
  network: 'network', permission: 'permission',
  // real-infra evidence (what the live LLM / sandbox actually did)
  'llm-infra': 'real-infra', 'llm-no-reply': 'real-infra',
  'llm-no-settle': 'real-infra', 'llm-render-missing': 'real-infra',
}
const dimensionOf = f => DIMENSION[f.category] || f.category

// A client-initiated cancel (`net::ERR_ABORTED`) is never an app defect — it is
// this driver navigating away while a request is in flight. Suppressed at REPORT
// time (not just at capture) so re-merging previously-collected shard data is
// cleaned too. Genuine transport failures (ERR_FAILED / ERR_CONNECTION_* / 4xx /
// 5xx) are untouched.
const isBenignAbort = f =>
  /net::ERR_ABORTED/.test(f.detail || '') &&
  (f.category === 'request-failed' || f.subcategory === 'failure')

// Same rule as the per-step `excess` threshold, applied to already-rendered
// rows so re-merging data captured before that fix is cleaned: an excess row
// whose evidence spans MULTIPLE steps is the app shell re-fetching once per
// navigation in a multi-page sweep, not a render storm within one page.
const isCrossStepExcess = f =>
  f.subcategory === 'excess' && /steps: [^,]+,/.test(f.detail || '')

// Same rule as the `backingStatus !== undefined` guard, applied to rows captured
// before it existed: "route rendered ... backing API status=n/a" means the page
// never loaded, not that a gated surface leaked. Verified FP class.
const isUnloadedRoutePermission = f =>
  f.subcategory === 'ungated-surface' && /backing API status=n\/a/.test(f.detail || '')

function writeReport(rawAll) {
  const all = rawAll.filter(
    f => !isBenignAbort(f) && !isCrossStepExcess(f) && !isUnloadedRoutePermission(f),
  )
  const suppressed = rawAll.length - all.length
  if (suppressed)
    console.log(`  suppressed ${suppressed} driver-artifact rows (net::ERR_ABORTED teardown + cross-step excess)`)
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
  const byDim = {}
  const bySurface = {} // surface -> dimension -> count
  const surfaceSev = {} // surface -> {HIGH,MEDIUM,LOW}
  for (const f of deduped) {
    bySev[f.severity]++
    const cat = f.subcategory ? `${f.category}/${f.subcategory}` : f.category
    byCat[cat] = (byCat[cat] || 0) + 1
    const dim = dimensionOf(f)
    const surf = surfaceOf(f)
    f._dim = dim
    f._surface = surf
    byDim[dim] = (byDim[dim] || 0) + 1
    ;(bySurface[surf] ??= {})[dim] = (bySurface[surf]?.[dim] || 0) + 1
    surfaceSev[surf] ??= { HIGH: 0, MEDIUM: 0, LOW: 0 }
    surfaceSev[surf][f.severity]++
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
  const icon = s => (s === 'HIGH' ? '🔴' : s === 'MEDIUM' ? '🟡' : '⚪')

  md.push('## By dimension\n')
  md.push('| Dimension | Count |')
  md.push('|---|---|')
  for (const [d, n] of Object.entries(byDim).sort((a, b) => b[1] - a[1]))
    md.push(`| **${d}** | ${n} |`)
  md.push('')
  md.push('## By category (raw signal)\n')
  md.push('| Category | Count |')
  md.push('|---|---|')
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
    md.push(`| \`${c}\` | ${n} |`)
  md.push('')

  // ── per-surface × per-dimension matrix ────────────────────────────────────
  const DIMS = [...new Set(Object.values(DIMENSION))]
  md.push('## Counts per dimension per surface\n')
  md.push(`| Surface | ${DIMS.join(' | ')} | 🔴 | 🟡 | ⚪ | Total |`)
  md.push(`|---|${DIMS.map(() => '---').join('|')}|---|---|---|---|`)
  const surfRows = Object.entries(bySurface).sort(
    (a, b) =>
      surfaceSev[b[0]].HIGH - surfaceSev[a[0]].HIGH ||
      Object.values(b[1]).reduce((x, y) => x + y, 0) -
        Object.values(a[1]).reduce((x, y) => x + y, 0),
  )
  for (const [surf, dims] of surfRows) {
    const tot = Object.values(dims).reduce((x, y) => x + y, 0)
    const s = surfaceSev[surf]
    md.push(
      `| \`${surf}\` | ${DIMS.map(d => dims[d] || '').join(' | ')} | ${s.HIGH || ''} | ${s.MEDIUM || ''} | ${s.LOW || ''} | ${tot} |`,
    )
  }
  md.push('')

  // ── systematically-broken surfaces ────────────────────────────────────────
  // A surface is "systematically broken" at a cell when a geometry or render
  // breakage (overflow / clipping / crash / stuck load) fires there — i.e. the
  // page does not fit, or does not render, at that viewport×theme at all.
  const SYSTEMIC = new Set([
    'overflow-x', 'clipped-control', 'crash', 'page-error', 'nav-error',
    'stuck-loading',
  ])
  const systemic = {} // `surface @ cell` -> [categories]
  for (const f of deduped) {
    if (!SYSTEMIC.has(f.category)) continue
    for (const c of f.cells)
      (systemic[`${f._surface} @ ${c}`] ??= new Set()).add(f.category)
  }
  const systemicRows = Object.entries(systemic).sort(
    (a, b) => b[1].size - a[1].size,
  )
  if (systemicRows.length) {
    md.push('## Systematically broken (surface × viewport/theme)\n')
    md.push('| Surface @ cell | Breakage categories |')
    md.push('|---|---|')
    for (const [k, set] of systemicRows)
      md.push(`| \`${k}\` | ${[...set].map(x => `\`${x}\``).join(', ')} |`)
    md.push('')
  }

  // ── top actionable ────────────────────────────────────────────────────────
  // "Actionable" ranks by severity, then by BLAST RADIUS (how many
  // viewport×theme cells it fired in), then by dimension weight — a HIGH that
  // reproduces in every cell is more actionable than one that fires in one.
  const DIM_WEIGHT = {
    permission: 6, bug: 5, responsive: 4, 'color-theme': 3, ui: 2,
    network: 1, consistency: 0,
  }
  const actionable = [...deduped]
    .sort(
      (a, b) =>
        SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
        (DIM_WEIGHT[b._dim] ?? 0) - (DIM_WEIGHT[a._dim] ?? 0) ||
        b.cells.length - a.cells.length,
    )
    .slice(0, 20)
  md.push('## Top 20 most-actionable\n')
  md.push('| # | Sev | Dimension | Surface | Signal | Cells |')
  md.push('|---|---|---|---|---|---|')
  actionable.forEach((f, i) => {
    md.push(
      `| ${i + 1} | ${icon(f.severity)} | ${f._dim} | \`${f._surface}\` | ${String(f.detail).replace(/\|/g, '\\|').slice(0, 190)} | ${f.cells.length} |`,
    )
  })
  md.push('')

  // ── full inventory, grouped by dimension then surface ─────────────────────
  md.push('## Full inventory — grouped by dimension, then surface\n')
  for (const dim of DIMS.filter(d => byDim[d])) {
    md.push(`# Dimension: ${dim} (${byDim[dim]})\n`)
    const inDim = deduped.filter(f => f._dim === dim)
    const surfaces = [...new Set(inDim.map(f => f._surface))].sort(
      (a, b) =>
        inDim.filter(f => f._surface === b && f.severity === 'HIGH').length -
          inDim.filter(f => f._surface === a && f.severity === 'HIGH').length ||
        inDim.filter(f => f._surface === b).length -
          inDim.filter(f => f._surface === a).length,
    )
    for (const surf of surfaces) {
      const rows = inDim
        .filter(f => f._surface === surf)
        .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
      md.push(`## ${dim} · \`${surf}\` (${rows.length})\n`)
      for (const f of rows) {
        md.push(
          `### ${icon(f.severity)} ${f.severity} · \`${f.subcategory ? `${f.category}/${f.subcategory}` : f.category}\``,
        )
        md.push(`- **JTBD:** ${f.jtbd || f.flow} (persona: ${f.persona || 'normal'})`)
        md.push(`- **Signal:** ${f.detail}`)
        if (f.selector) md.push(`- **Element:** \`${f.selector}\``)
        md.push(`- **Cells (viewport/theme):** ${f.cells.join(', ')}`)
        if (f.screenshot) md.push(`- **Screenshot:** \`${f.screenshot}\``)
        md.push(
          `- **Repro:** login ${USER} → flow \`${f.flow}\` → step \`${f.step}\` at ${f.cells[0]}`,
        )
        md.push('')
      }
    }
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

// ── merge mode --------------------------------------------------------------
// A broad sweep is cheapest to run as several SHARDS (disjoint --jtbd sets) in
// parallel, each with its own --out. `--merge=dirA,dirB,…` re-reads those
// shards' findings.jsonl, expands each deduped row back into its per-cell raw
// findings, and re-runs the single consolidated report into --out. Screenshot
// paths stay shard-relative, so point --out at a dir holding the shards (or
// symlink/copy their screenshots/ in).
function mergeShards(dirs) {
  const raw = []
  for (const d of dirs) {
    const p = path.join(d, 'findings.jsonl')
    if (!fs.existsSync(p)) {
      console.warn(`  ! merge: no findings.jsonl in ${d} — skipped`)
      continue
    }
    let n = 0
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const f = JSON.parse(line)
      const shard = path.basename(d)
      const cells = f.cells?.length ? f.cells : [`${f.viewportLabel}/${f.theme}`]
      for (const c of cells) {
        const [viewportLabel, theme] = c.split('/')
        const { cells: _c, _dim, _surface, ...rest } = f
        raw.push({
          ...rest,
          viewportLabel,
          theme: theme || f.theme,
          // keep the screenshot resolvable from the merged dir
          screenshot: f.screenshot ? `${shard}/${f.screenshot}` : null,
        })
        n++
      }
    }
    console.log(`  merged ${n} raw findings from ${d}`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  writeReport(raw)
}

const MERGE = arg('merge', '')
if (MERGE) {
  mergeShards(MERGE.split(',').filter(Boolean))
} else {
  main().catch(e => {
    console.error(e)
    process.exit(2)
  })
}
