/**
 * Tests for the tool-result detector.  `node --test tool-result-detector.test.mjs`
 *
 * Every fixture below is a VERBATIM shape harvested from the live rig
 * (`GET /api/conversations/{id}/messages`), not an invention — including the
 * bwrap failure the detector was written for. The negative controls carry the
 * weight here: a detector that only proves it fires is a counter, not a detector.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyToolResult,
  findToolResults,
  ToolFailureTracker,
} from './tool-result-detector.mjs'

// ---------------------------------------------------------------------------
// THE CASE THAT MUST BE REPORTED — infrastructure failing under the model's feet.
// Verbatim from the rig: bwrap could not find the rootfs, so the command never
// ran at all, yet the HTTP call is 200 and the rail renders a normal step.
// ---------------------------------------------------------------------------
const BWRAP_INFRA_FAILURE = {
  type: 'tool_result',
  name: 'execute_command',
  tool_use_id: 'call_bwrap_1',
  server_id: '9f2a0f31-0000-5000-8000-000000000001',
  is_error: false,
  content: '{"stdout":"","stderr":"bwrap: Can\'t find source path ...","exit_code":1}',
  structured_content: {
    stdout: '',
    stderr:
      "bwrap: Can't find source path ./.ziee-cache/sandbox-rootfs/1.0.0-alpha/" +
      'ziee-sandbox-rootfs-x86_64-full/usr: No such file or directory\n',
    exit_code: 1,
    timed_out: false,
    duration_ms: 422,
    flavor: 'full',
  },
}

// ---------------------------------------------------------------------------
// THE CASE THAT MUST NOT BE REPORTED — a legitimate non-zero exit. The model
// deliberately runs failing commands; `grep` with no match exits 1 and that is
// the tool working perfectly.
// ---------------------------------------------------------------------------
const GREP_NO_MATCH = {
  type: 'tool_result',
  name: 'execute_command',
  tool_use_id: 'call_grep_1',
  server_id: '9f2a0f31-0000-5000-8000-000000000001',
  is_error: false,
  content: '{"stdout":"","stderr":"","exit_code":1}',
  structured_content: {
    stdout: '',
    stderr: '',
    exit_code: 1,
    timed_out: false,
    duration_ms: 38,
    flavor: 'full',
  },
}

test('REPORTS a sandbox runner that could not start the command', () => {
  const f = classifyToolResult(BWRAP_INFRA_FAILURE)
  assert.ok(f, 'the bwrap infrastructure failure must produce a finding')
  assert.equal(f.reason, 'runner-failed')
  assert.equal(f.severity, 'HIGH')
  assert.match(f.detail, /runner failed to start the command/)
  assert.match(f.detail, /Can't find source path/)
})

test('does NOT report a legitimate non-zero exit (grep, no match)', () => {
  assert.equal(classifyToolResult(GREP_NO_MATCH), null)
})

test('does NOT report a command that failed loudly on its own terms', () => {
  // The sharper negative control: non-zero exit AND a real stderr. The command
  // ran; its complaint is its own. Only the RUNNER speaking counts.
  //
  // The first entry is verbatim from the LIVE rig's sandbox — a real
  // `execute_command` result, `{"exit_code":2,"stderr":"grep: /etc/hostname: No
  // such file or directory\n","stdout":"","timed_out":false}` — captured while
  // building this detector, so the shape the negative control asserts on is the
  // one production actually emits.
  for (const [stderr, exit] of [
    ['grep: /etc/hostname: No such file or directory\n', 2],
    ['python3: can\'t open file \'/w/x.py\': [Errno 2] No such file or directory\n', 2],
    ['bash: line 1: frobnicate: command not found\n', 127],
    ['Traceback (most recent call last):\n  File "<stdin>", line 1\nZeroDivisionError\n', 1],
  ]) {
    assert.equal(
      classifyToolResult({
        ...GREP_NO_MATCH,
        tool_use_id: `x-${exit}-${stderr.length}`,
        structured_content: { ...GREP_NO_MATCH.structured_content, stderr, exit_code: exit },
      }),
      null,
      `must stay silent for: ${stderr.trim()}`,
    )
  }
})

test('does NOT report a command that produced output before failing', () => {
  assert.equal(
    classifyToolResult({
      ...BWRAP_INFRA_FAILURE,
      structured_content: {
        ...BWRAP_INFRA_FAILURE.structured_content,
        stdout: 'partial results\n',
      },
    }),
    null,
  )
})

test('does NOT report a wall-clock timeout (the model asked for something slow)', () => {
  assert.equal(
    classifyToolResult({
      ...BWRAP_INFRA_FAILURE,
      structured_content: {
        stdout: '',
        stderr: 'bwrap timed out after 120s',
        exit_code: -1,
        timed_out: true,
      },
    }),
    null,
  )
})

test('does NOT report a successful command', () => {
  assert.equal(
    classifyToolResult({
      ...GREP_NO_MATCH,
      structured_content: { ...GREP_NO_MATCH.structured_content, stdout: 'ok\n', exit_code: 0 },
    }),
    null,
  )
})

// ---------------------------------------------------------------------------
// The MCP class. Fixtures verbatim from the live rig (373 blocks sampled).
// ---------------------------------------------------------------------------
const rigBlock = (over) => ({
  type: 'tool_result',
  tool_use_id: `use-${Math.random().toString(36).slice(2)}`,
  ...over,
})

test('REPORTS a tool dispatched to its server that produced no result', () => {
  const f = classifyToolResult(
    rigBlock({
      name: 'list_citations',
      server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
      is_error: true,
      content: 'Tool execution failed: No data found in SSE response',
      structured_content: null,
    }),
  )
  assert.ok(f, 'a dispatched tool returning nothing must be reported')
  assert.equal(f.reason, 'never-ran')
  assert.match(f.detail, /No data found in SSE response/)
})

test('does NOT report a JSON-RPC caller error — the tool correctly refused', () => {
  for (const [code, msg] of [
    [-32602, 'Invalid params: spec.task must be a non-empty string'],
    [-32601, 'Method not found: list_capabilities'],
    [-32600, 'Invalid request'],
    [-32700, 'Parse error'],
  ]) {
    assert.equal(
      classifyToolResult(
        rigBlock({
          name: 'spawn_background',
          server_id: '5a84aa8f-37c9-540d-9472-8db03b461b8b',
          is_error: true,
          content: `Tool execution failed: MCP error: {"code":${code},"message":"${msg}"}`,
          structured_content: null,
        }),
      ),
      null,
      `caller-error ${code} must stay silent`,
    )
  }
})

test('does NOT report a tool that RAN and rejected the request itself', () => {
  // Both verbatim from the rig. Structurally identical to the reported class —
  // is_error, a resolved server, no structured payload — and separated only by
  // the absence of the dispatcher's synthesized-failure prefix, because these
  // results came back FROM the tool rather than being manufactured for it.
  for (const [name, content] of [
    ['biomcp', 'Error: Invalid argument: Unknown entity: workflow\n\nValid entities:\n- gene\n- variant'],
    ['ask_user', "ask_user 'schema' has no `properties`, so the form would render zero fields"],
  ]) {
    assert.equal(
      classifyToolResult(
        rigBlock({
          name,
          server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
          is_error: true,
          content,
          structured_content: null,
        }),
      ),
      null,
      `${name} ran and answered; that is not a tool failing to run`,
    )
  }
})

test('REPORTS a tool call that timed out without returning', () => {
  const f = classifyToolResult(
    rigBlock({
      name: 'literature_search',
      server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
      is_error: true,
      content: 'Tool execution timed out after 60s',
      structured_content: null,
    }),
  )
  assert.ok(f, 'a dispatch timeout is the tool failing to run')
  assert.equal(f.reason, 'never-ran')
})

test('DOES report a JSON-RPC SERVER error — that range is the tool breaking', () => {
  for (const code of [-32603, -32000, -32050]) {
    const f = classifyToolResult(
      rigBlock({
        name: 'literature_search',
        server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
        is_error: true,
        content: `Tool execution failed: MCP error: {"code":${code},"message":"upstream exploded"}`,
        structured_content: null,
      }),
    )
    assert.ok(f, `server-error ${code} must be reported`)
  }
})

test('does NOT report a tool name the model invented (nothing was dispatched)', () => {
  assert.equal(
    classifyToolResult(
      rigBlock({
        name: 'execute_command',
        server_id: null,
        is_error: true,
        content:
          "Could not resolve an MCP server for tool 'execute_command'. The model returned a " +
          'tool name without a server prefix and it could not be matched to an advertised tool, ' +
          'so the call was not executed. Retry, or select the tool explicitly.',
        structured_content: null,
      }),
    ),
    null,
  )
})

test('does NOT report the caller\'s own script throwing inside a tool that ran', () => {
  assert.equal(
    classifyToolResult(
      rigBlock({
        name: 'run_js',
        server_id: 'b3ece957-a23d-573e-80b2-896201e83950',
        is_error: true,
        content: 'run_js error (line 18): not a function',
        structured_content: {
          console: [],
          error: { line: 18, message: 'not a function' },
          result: null,
          tool_calls: [{ duration_ms: 22, server: 'files', status: 'failed', tool: 'read_file' }],
        },
      }),
    ),
    null,
  )
})

test('does NOT report a policy refusal (the tool ran to a documented outcome)', () => {
  assert.equal(
    classifyToolResult(
      rigBlock({
        name: 'spawn_background',
        server_id: '5a84aa8f-37c9-540d-9472-8db03b461b8b',
        is_error: true,
        content:
          "Tool 'spawn_background' requires approval and is not permitted to run unattended " +
          'for this scheduled task; it was skipped.',
        structured_content: { tool_name: 'spawn_background', unattended_denied: true },
      }),
    ),
    null,
  )
})

test('does NOT report a successful tool result', () => {
  assert.equal(
    classifyToolResult(
      rigBlock({
        name: 'remember',
        server_id: '16e2eeb0-46ed-5588-af8a-e973349f99a1',
        is_error: false,
        content: '{"content":"Alex\'s favorite color is teal.","scope":"user"}',
        structured_content: { content: "Alex's favorite color is teal.", scope: 'user' },
      }),
    ),
    null,
  )
})

test('ignores anything that is not a tool_result block', () => {
  for (const b of [null, 7, 'x', [], { type: 'text', text: 'hi' }, { type: 'tool_use' }]) {
    assert.equal(classifyToolResult(b), null)
  }
})

// ---------------------------------------------------------------------------
// The walker + the tracker.
// ---------------------------------------------------------------------------
test('finds tool_result blocks wherever the payload nests them', () => {
  // The real messages payload nests under `contents[].content` — a key name this
  // walker must not depend on.
  const payload = {
    messages: [
      { role: 'user', contents: [{ content: { type: 'text', text: 'go' } }] },
      { role: 'assistant', contents: [{ content: BWRAP_INFRA_FAILURE }] },
    ],
  }
  const found = findToolResults(payload)
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'execute_command')
  assert.equal(findToolResults({ deep: { deeper: [[{ x: [GREP_NO_MATCH] }]] } }).length, 1)
  assert.deepEqual(findToolResults(null), [])
})

test('reports one tool call once, however often its conversation is refetched', () => {
  const t = new ToolFailureTracker()
  assert.equal(t.observe([BWRAP_INFRA_FAILURE]).length, 1)
  assert.equal(t.observe([BWRAP_INFRA_FAILURE]).length, 0, 'a refetch must not re-report')
  assert.equal(t.observe([BWRAP_INFRA_FAILURE, GREP_NO_MATCH]).length, 0)
})

test('escalates a tool that has failed repeatedly and never once succeeded', () => {
  const t = new ToolFailureTracker()
  const fail = (n) =>
    rigBlock({
      tool_use_id: `sse-${n}`,
      name: 'list_citations',
      server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
      is_error: true,
      content: 'Tool execution failed: No data found in SSE response',
      structured_content: null,
    })
  assert.equal(t.observe([fail(1)])[0].severity, 'MEDIUM')
  assert.equal(t.observe([fail(2)])[0].severity, 'MEDIUM')
  const third = t.observe([fail(3)])[0]
  assert.equal(third.severity, 'HIGH', 'three failures and no success is a tool that is down')
  assert.match(third.detail, /not one of them succeeded/)
})

test('does NOT escalate when the same tool also succeeds', () => {
  const t = new ToolFailureTracker()
  const ok = (n) =>
    rigBlock({
      tool_use_id: `ok-${n}`,
      name: 'list_citations',
      server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
      is_error: false,
      content: '{"items":[]}',
      structured_content: { items: [] },
    })
  const fail = (n) =>
    rigBlock({
      tool_use_id: `f-${n}`,
      name: 'list_citations',
      server_id: '011e52cb-2d06-5e6b-8f4c-41076519f167',
      is_error: true,
      content: 'Tool execution failed: No data found in SSE response',
      structured_content: null,
    })
  t.observe([ok(1), fail(1), fail(2)])
  assert.equal(t.observe([fail(3)])[0].severity, 'MEDIUM', 'a tool that also works is not down')
})
