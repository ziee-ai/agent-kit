#!/usr/bin/env node
// Surface cheap deterministic findings AT EDIT TIME, in the agent's own loop.
//
// WHY THIS EXISTS — the strongest effect in the guardrail research, and it is
// about placement, not rigor. Facebook deployed the SAME static analysis with the
// SAME false-positive rate two ways: as a nightly batch with issues assigned to
// developers ("almost none of them were acted on" — ~0% fix rate), and surfaced at
// diff time during review of the change (>70% fix rate). Same analysis, same FPs,
// 70-point swing. (Distefano, Fähndrich, Logozzo & O'Hearn, CACM 62(8), 2019.)
//
// Our equivalent of "nightly batch" is phase 6/8: a lint violation written now is
// reported hours later, often to a DIFFERENT agent, after the code is committed —
// where fixing it costs a gate iteration. Reported here, the agent that wrote the
// line fixes it in the same breath, and no human is ever involved. This REDUCES
// human input; it does not add any.
//
// Design constraints:
//   • FAST — file-scoped (~300ms), never the 33s full `npm run check`.
//   • FAIL-OPEN — a broken linter must never block an edit. Any error exits 0
//     silently. This hook is an accelerator, not a gate; phase 8 remains the gate.
//   • QUIET ON SUCCESS — output only when there is something to fix, so it does
//     not become noise the agent learns to skip.
//
// Wire as a PostToolUse hook on Write|Edit. Reads the hook JSON on stdin.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync as fsReadFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const OUT = (context) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }));
  process.exit(0);
};
const QUIET = () => process.exit(0);

let raw = '';
try { raw = readAllStdin(); } catch { QUIET(); }
function readAllStdin() {
  // eslint-disable-next-line
  try { return fsReadFileSync(0, 'utf8'); } catch { return ''; }
}

let file = null;
try {
  const j = JSON.parse(raw || '{}');
  file = j?.tool_response?.filePath || j?.tool_input?.file_path || null;
} catch { QUIET(); }
if (!file) QUIET();

// Only source files in a UI workspace — everything else is out of scope for these
// linters, and running them anyway is pure latency.
if (!/\.(ts|tsx)$/.test(file)) QUIET();
if (/[\\/](node_modules|dist|\.vite|target)[\\/]/.test(file)) QUIET();

const abs = resolve(file);
if (!existsSync(abs)) QUIET();

// Locate the workspace root (the dir with package.json) by walking up.
let wsRoot = dirname(abs);
while (wsRoot !== dirname(wsRoot) && !existsSync(join(wsRoot, 'package.json'))) wsRoot = dirname(wsRoot);
if (!existsSync(join(wsRoot, 'package.json'))) QUIET();

// The linters live in the sdk submodule. An uninitialized submodule is common in
// fresh worktrees — degrade silently rather than reporting a phantom failure.
const lintDir = resolve(wsRoot, '..', '..', 'sdk', 'packages', 'config', 'src', 'lint');
if (!existsSync(lintDir)) QUIET();

const targetDir = dirname(abs);
if (!statSync(targetDir).isDirectory()) QUIET();

// File-scoped by design: pointed at the edited file's DIRECTORY, not the tree.
const CHECKS = [
  ['hardcoded-colors.mjs', 'hardcoded color — use a semantic token'],
  ['logical-direction.mjs', 'physical direction property — use ps/pe, ms/me, start/end'],
  ['settings-field.mjs', 'settings/form layout — compose Field, not raw flex-gap'],
  ['adjacent-inline.mjs', 'adjacent inline elements'],
];

const findings = [];
for (const [script, hint] of CHECKS) {
  const p = join(lintDir, script);
  if (!existsSync(p)) continue;
  try {
    execFileSync(process.execPath, [p, `--root=${targetDir}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
    });
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    // Only report lines that name the file just edited — a neighbour's
    // pre-existing violation is not this edit's problem and would train the
    // agent to ignore the hook.
    const mine = out.split('\n').filter((l) => l.includes(abs) || l.includes(file.split(sep).pop()));
    if (mine.length) findings.push(`• ${hint}\n${mine.slice(0, 6).map((l) => `    ${l.trim()}`).join('\n')}`);
  }
}

if (!findings.length) QUIET();
OUT(`Lint findings in the file you just edited (${file}) — fix them now, while the change is in front of you. These are the same checks phase 8 runs; catching them here costs ~300ms instead of a gate iteration.\n\n${findings.join('\n')}`);
