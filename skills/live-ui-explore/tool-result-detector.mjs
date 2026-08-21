/**
 * tool-result-detector — the eleventh detector: a chat TOOL CALL that failed.
 *
 * ## The blind spot this closes
 *
 * The other ten detectors all watch the BROWSER: console, exceptions, failed
 * requests, blank pages, dialogs, redirects. A failing tool call trips none of
 * them. The HTTP request is 200, no console error is logged, no exception is
 * thrown, and the page renders normally — the failure lives entirely inside the
 * response payload. Worse, the activity rail deliberately renders a non-zero
 * exit as a SUCCESSFUL step (`describeActivity.ts`: "A non-zero exit is NOT
 * mapped to `failed`"), so the rendering is not a signal either. For its whole
 * life the rig watched the model use a broken sandbox and reported nothing:
 *
 *     Sandbox — Result ready — exit 1 — 422 ms
 *     stderr  bwrap: Can't find source path .../usr: No such file or directory
 *
 * That is infrastructure failing under the model's feet, invisible to every
 * existing detector, on exactly the surface the rig exists to exercise.
 *
 * ## Why the PAYLOAD and not the DOM
 *
 * The rail is a rendered signal the explorer can already see, and it is the
 * thing a user perceives — a real argument for reading it. It was rejected on
 * evidence: the rail's contract is that a non-zero exit is routine agentic data,
 * so the exact failure above renders as an ordinary green step whose only tell
 * is the words "exit 1" in a detail line, with the stderr inside a collapsed
 * body. Reading it would mean expanding every step and scraping rail markup —
 * coupling this to the most-churned component in the app to recover a signal the
 * payload carries as a typed field. The payload also carries results the rail
 * never renders (history refetches, the tool-call history endpoint), so it sees
 * strictly more.
 *
 * ## Where the line is drawn — and why it is NOT "exit != 0"
 *
 * A non-zero exit is NOT a defect. The model runs failing commands ON PURPOSE:
 * checking whether a file exists, probing a limit, testing error handling. A
 * detector that flags every `exit 1` would bury the ledger, which is the failure
 * mode this rig has already been poisoned by three times.
 *
 * So the question is never "did it fail" but "WHOSE fault was it". Calibrated
 * against 373 real `tool_result` blocks harvested from the live rig, the classes
 * separate STRUCTURALLY — no message-text matching:
 *
 * | observed class (count) | `server_id` | `structured_content` | verdict |
 * |---|---|---|---|
 * | success | present | object | not a failure |
 * | `run_js error (line 18): not a function` (4) | present | **object** | the caller's own script threw — the tool RAN |
 * | `… requires approval … was skipped` (6) | present | **object** | policy decided; the tool ran to a documented outcome |
 * | `MCP error {"code":-32602 …}` invalid params (20) | present | null | **caller-error code** — the tool correctly REFUSED |
 * | `MCP error {"code":-32601 …}` method not found (16) | present | null | same |
 * | `Could not resolve an MCP server for tool 'x'` (21) | **null** | null | the model invented a tool name; nothing was ever dispatched |
 * | `biomcp: Unknown entity: workflow` (1) | present | null | the tool RAN and rejected the request — no dispatcher prefix |
 * | `Tool execution failed: No data found in SSE response` (48) | present | **null** | **REPORTED** — dispatched to a real server, produced nothing |
 *
 * Read as a rule:
 *
 *   the dispatcher had to
 *   synthesize the result   => the call did not return one (see
 *                              DISPATCH_SYNTHESIZED)
 *   a server was resolved   => the call really was dispatched (not a naming or
 *                              pre-dispatch policy refusal)
 *   no structured payload   => the tool never produced its documented result,
 *                              so it did not run to completion
 *   no caller-error code    => the tool did not deliberately refuse the request
 *   -------------------------------------------------------------------------
 *   => the tool failed to RUN. That is the reportable class.
 *
 * Measured over that corpus the rule reports 48 of 372 blocks, and all 48 are the
 * one genuine defect in it: a built-in MCP server that has answered nothing on
 * every single call.
 *
 * The JSON-RPC codes are taken from the spec's own caller range (§5.1), not from
 * wording, so a rephrased "Invalid params: …" message stays correctly silent.
 * `-32603` and the `-32000..-32099` server range are deliberately NOT in the
 * caller set: those mean the server broke, which is the class we want.
 *
 * ## The one place a name list is unavoidable
 *
 * The sandbox is the exception, and it is worth being explicit about why. Its
 * result is a COMPLETED payload — `{stdout, stderr, exit_code}` — because bwrap
 * is the process being spawned, so when bwrap itself cannot start, its
 * diagnostics land in the command's own stderr channel and there is no
 * structural field that says "the command never ran". The only tell is that the
 * RUNNER is speaking where the COMMAND should be. So `RUNNER_PROGRAMS` matches a
 * handful of program names, anchored at the start of stderr, and only when
 * stdout is empty and the exit is non-zero.
 *
 * That is a wording match and it will miss a phrasing it does not know. That
 * direction is deliberate: an unknown phrasing is a MISS, never a false alarm —
 * the same side the existing console-error filter errs on, and the right side
 * when a noisy class is more expensive than a quiet one.
 */

/**
 * JSON-RPC 2.0 §5.1 codes that blame the CALLER. A tool answering with one of
 * these worked correctly: it inspected a bad request and refused it. Server-side
 * codes (`-32603` internal error, and the `-32000..-32099` implementation-defined
 * range) are absent on purpose — those mean the tool broke.
 */
export const CALLER_ERROR_CODES = new Set([-32700, -32600, -32601, -32602])

/**
 * Programs that ARE the sandbox runner rather than anything the model asked to
 * run. Anchored at the start of a line, because these tools prefix their
 * diagnostics with their own name (`bwrap: Can't find source path …`). A user
 * command's stderr does not open this way unless the model literally invoked the
 * runner, which the empty-stdout + non-zero-exit conditions then make harmless.
 */
export const RUNNER_PROGRAMS =
  /^\s*(bwrap|squashfuse|fusermount3?|crun|runc|libkrun|wslpath|newuidmap|newgidmap|prlimit)\b\s*:/

/**
 * The DISPATCHER's own two synthesized failures — the machine-checkable
 * statement "this result was manufactured because the call did not return one".
 *
 * `mcp/chat_extension/helpers.rs::execute_tool` has exactly three arms:
 *   Ok(Ok(result)) — the tool RAN; its payload is passed through, `is_error`
 *                    included. A tool that inspected the request and said no
 *                    lands here, and its refusal is its answer, not a failure.
 *   Ok(Err(e))     — `format!("Tool execution failed: {e}")`
 *   Err(_)         — `format!("Tool execution timed out after {n}s")`
 * The last two are precisely "the tool failed to run"; the first is precisely
 * "it ran and returned non-zero". One producer, one prefix each.
 *
 * This is a wording match, and unlike the rest of the rules it is on ZIEE's own
 * string rather than a spec's. Calibration showed why it earns its place: without
 * it the detector fired on `biomcp: "Unknown entity: workflow"` and on `ask_user:
 * "'schema' has no properties"` — both tools that ran and correctly rejected what
 * the model sent. Those two are structurally identical to a real transport
 * failure (`is_error`, a resolved server, no structured payload); only the
 * dispatcher's prefix separates them. If the prefix is ever reworded the detector
 * goes QUIET rather than noisy, which is the survivable direction.
 */
export const DISPATCH_SYNTHESIZED = /^\s*Tool execution (failed|timed out)\b/

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '')

/**
 * The JSON-RPC error code carried in a dispatch-failure message, or null.
 * ziee's dispatcher embeds the upstream error verbatim
 * (`Tool execution failed: MCP error: {"code":-32602,"message":"…"}`), so the
 * code is machine-readable even though the envelope is prose. Reading a NUMBER
 * out of it is not a wording match: the number is the spec's, and it survives
 * any rephrasing of the message beside it.
 */
export function jsonRpcCodeOf(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/"code"\s*:\s*(-?\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * Classify ONE `tool_result` content block.
 *
 * Returns `null` for everything that is not a tool failing to run — which is
 * most things, and is the point. Otherwise returns a finding shape:
 * `{ reason, severity, tool, detail, key }`, where `key` is the per-tool failure
 * identity used to notice that a tool is failing EVERY time (see `ToolFailureTracker`).
 */
export function classifyToolResult(block) {
  if (!isPlainObject(block) || block.type !== 'tool_result') return null
  const tool = typeof block.name === 'string' && block.name ? block.name : '(unnamed tool)'
  const sc = block.structured_content
  const text = typeof block.content === 'string' ? block.content : ''

  // ---- Rule 1: a COMPLETED exec payload whose runner never started the command.
  //
  // Scoped to results that actually carry an exit code, so it can only ever fire
  // on a command-running tool. Everything about the command itself — its exit
  // code, its stderr, its silence — is DATA and returns null here.
  if (isPlainObject(sc) && typeof sc.exit_code === 'number') {
    const exit = sc.exit_code
    const stdout = typeof sc.stdout === 'string' ? sc.stdout : ''
    const stderr = typeof sc.stderr === 'string' ? sc.stderr : ''
    // A wall-clock kill is the model's command being slow, not the runner being
    // broken — even though the runner is the one that says so.
    if (exit !== 0 && sc.timed_out !== true && stdout.trim() === '' && RUNNER_PROGRAMS.test(stderr)) {
      const first = stderr.trim().split('\n')[0].slice(0, 220)
      return {
        reason: 'runner-failed',
        severity: 'HIGH',
        tool,
        key: `${tool}|runner|${first}`,
        detail:
          `${tool}: the sandbox runner failed to start the command — exit ${exit}, no stdout, ` +
          `and stderr is the runner speaking, not the command: ${first}`,
      }
    }
    // The command ran. Its exit code is its own business.
    return null
  }

  // ---- Rule 2: the tool never produced a result at all.
  if (block.is_error !== true) return null

  if (!DISPATCH_SYNTHESIZED.test(text)) return null               // the tool ran and answered
  const code = jsonRpcCodeOf(text)
  if (code != null && CALLER_ERROR_CODES.has(code)) return null   // the tool refused a bad request
  if (isBlank(block.server_id)) return null                       // nothing was ever dispatched
  if (isPlainObject(sc)) return null                              // the tool ran and returned its payload

  return {
    reason: 'never-ran',
    severity: 'MEDIUM',
    tool,
    key: `${tool}|never-ran|${text.slice(0, 160)}`,
    detail:
      `${tool}: dispatched to its MCP server and returned no result — ` +
      `${text.trim().slice(0, 220) || '(no message)'}`,
  }
}

/**
 * Generic recursive search for `tool_result` blocks in an arbitrary API payload.
 *
 * Deliberately shape-agnostic: the messages endpoint nests them under
 * `contents[].content`, the tool-call-history endpoint under a different key
 * again, and a future endpoint will pick a third. Keying on the block's own
 * `type` discriminator instead of on any container's field name is the only
 * version of this that does not rot. Bounded so a huge payload cannot stall a
 * step.
 */
export function findToolResults(payload, { maxNodes = 200_000 } = {}) {
  const out = []
  let budget = maxNodes
  const visit = (node) => {
    if (budget-- <= 0 || node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const v of node) visit(v)
      return
    }
    if (node.type === 'tool_result') out.push(node)
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v)
    }
  }
  visit(payload)
  return out
}

/**
 * Per-cycle memory, for two jobs the classifier alone cannot do.
 *
 * 1. DEDUPE by `tool_use_id`. One tool call is one event however many times its
 *    conversation is refetched; without this, re-opening a chat would re-report
 *    every historical failure in it and the volume would look like severity.
 * 2. ESCALATE the never-ran class when a tool is failing for EVERY call. A tool
 *    that fails once may have hit a bad moment; a tool that has failed three
 *    times and has never once succeeded is down, and that difference is worth a
 *    severity. It is deliberately measured per CYCLE and kept in memory: the
 *    ledger already dedupes across cycles and counts recurrences, so a second
 *    durable counter would be a parallel mechanism, and a mistake baked into one
 *    would be permanent and invisible.
 */
export class ToolFailureTracker {
  constructor() {
    this.seenUses = new Set()
    this.succeeded = new Set()
    this.failureCounts = new Map()
  }

  /**
   * Feed every `tool_result` seen in a payload; get back only the NEW findings.
   * Successes are fed in too — they are what proves a tool is not down.
   */
  observe(blocks) {
    const found = []
    for (const b of blocks) {
      const useId = typeof b?.tool_use_id === 'string' ? b.tool_use_id : null
      if (useId) {
        if (this.seenUses.has(useId)) continue
        this.seenUses.add(useId)
      }
      const verdict = classifyToolResult(b)
      const tool = typeof b?.name === 'string' ? b.name : null
      // "Succeeded" means the tool RAN, which is exactly `is_error !== true` —
      // a `grep` exiting 1 counts, a refused-bad-params call does not. Reading
      // it off the block rather than off `!verdict` matters: a caller-error is
      // silent but is not evidence the tool is healthy, and treating it as such
      // would suppress the escalation for a tool that is genuinely down.
      if (b?.is_error !== true && tool) this.succeeded.add(tool)
      if (!verdict) continue
      const n = (this.failureCounts.get(verdict.key) || 0) + 1
      this.failureCounts.set(verdict.key, n)
      // Never succeeded in this cycle, and failing repeatedly: not bad luck.
      const everyCall = n >= 3 && !this.succeeded.has(verdict.tool)
      found.push({
        ...verdict,
        occurrences: n,
        severity: everyCall ? 'HIGH' : verdict.severity,
        detail: everyCall
          ? `${verdict.detail} — ${n} calls this cycle, not one of them succeeded`
          : verdict.detail,
      })
    }
    return found
  }
}
