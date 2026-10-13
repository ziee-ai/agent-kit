#!/usr/bin/env node
// run-steps — run a list of steps EACH TO THE END and report every failure at once (owner 2026-10-12: "do not stop at the
// first fail, nor any process should stop at first failed, we need to gather all failed, then fix all at once").
//
// A `just` dependency list and an `a && b && c` npm chain both stop at the first red step, so a gate run surfaced ONE
// failure per ~3 h cycle (measured in the dental app: one batch needed five fix branches). This runner keeps going, prints one SUMMARY, exits 1 when any
// step failed, and (when RUN_STEPS_REPORT_DIR is set — the merge rig sets it) writes <dir>/<name>.json with every step's
// cwd, command, rc and seconds, so the rig can re-run exactly the failed steps.
//
// Usage:
//   node scripts/run-steps.mjs --name <label> [--cwd <dir>] -- "<cmd>" "<cmd>" ...
//   node scripts/run-steps.mjs --name <label> --just-deps <recipe> [--sub <leg>=<recipe>]...
//        each dependency named on `<recipe>:`'s header line becomes `just <leg>` (or the --sub replacement)
//   node scripts/run-steps.mjs --name <label> --just-legs "<leg> <leg> ..."   — the same, from an inline list
//   node scripts/run-steps.mjs --name <label> --npm-chain <script> [--cwd <pkg-dir>]
//        each `&&` segment of package.json scripts[<script>] becomes one step, run in <pkg-dir>
// Output streams live; each step is framed by `=== run-steps <name> [i/N] …` lines.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

// the app root (its justfile, the default step cwd): RUN_STEPS_ROOT, else the directory it is run from
const ROOT = resolve(process.env.RUN_STEPS_ROOT || process.cwd())
const argv = process.argv.slice(2)
let name = 'steps', cwd = process.cwd(), justDeps = null, justLegs = null, npmChain = null
const subs = new Map(), cmds = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--name') name = argv[++i]
  else if (a === '--cwd') cwd = resolve(argv[++i])
  else if (a === '--just-deps') justDeps = argv[++i]
  else if (a === '--just-legs') justLegs = argv[++i]
  else if (a === '--npm-chain') npmChain = argv[++i]
  else if (a === '--sub') { const [k, v] = argv[++i].split('='); subs.set(k, v) }
  else if (a === '--') { cmds.push(...argv.slice(i + 1)); break }
  else { console.error(`run-steps: unknown argument ${a}`); process.exit(2) }
}

const steps = [] // { cwd, cmd }
if (justDeps) {
  const jf = readFileSync(join(ROOT, 'justfile'), 'utf8')
  const m = jf.match(new RegExp(`^${justDeps.replace(/[-]/g, '\\-')}(?:\\s[^:\\n]*)?:([^\\n]*)$`, 'm'))
  if (!m) { console.error(`run-steps: recipe "${justDeps}" not found in ${join(ROOT, 'justfile')}`); process.exit(2) }
  for (const leg of m[1].trim().split(/\s+/).filter(Boolean)) steps.push({ cwd: ROOT, cmd: `just ${subs.get(leg) || leg}` })
}
for (const leg of (justLegs || '').split(/\s+/).filter(Boolean)) steps.push({ cwd: ROOT, cmd: `just ${subs.get(leg) || leg}` })
if (npmChain) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const body = pkg.scripts && pkg.scripts[npmChain]
  if (!body) { console.error(`run-steps: no script "${npmChain}" in ${join(cwd, 'package.json')}`); process.exit(2) }
  for (const seg of body.split(/\s+&&\s+/).map((s) => s.trim()).filter(Boolean)) steps.push({ cwd, cmd: seg })
}
for (const c of cmds) steps.push({ cwd, cmd: c })
if (!steps.length) { console.error('run-steps: no steps'); process.exit(2) }

const hms = () => new Date().toTimeString().slice(0, 8)
const results = []
steps.forEach((s, i) => {
  console.log(`=== run-steps ${name} [${i + 1}/${steps.length}] START ${hms()} :: ${s.cmd}`)
  const t0 = Date.now()
  // npm-chain segments run with the package's node_modules/.bin on PATH, as `npm run` would give them.
  const env = npmChain ? { ...process.env, PATH: `${join(s.cwd, 'node_modules', '.bin')}:${join(ROOT, 'node_modules', '.bin')}:${process.env.PATH}` } : process.env
  const cmd = s.cmd // a plain binding (an app sandbox lint may pin this call site)
  const r = spawnSync('sh', ['-c', cmd], { cwd: s.cwd, stdio: 'inherit', env })
  const rc = r.status == null ? (r.signal ? 128 : 1) : r.status
  const secs = Math.round((Date.now() - t0) / 100) / 10
  results.push({ step: i + 1, cwd: s.cwd, cmd: s.cmd, rc, secs })
  console.log(`=== run-steps ${name} [${i + 1}/${steps.length}] ${rc === 0 ? 'PASS' : 'FAIL'} rc=${rc} ${secs}s ${hms()} :: ${s.cmd}`)
})

const failed = results.filter((r) => r.rc !== 0)
console.log(`\n=== run-steps ${name} SUMMARY: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`)
for (const f of failed) console.log(`=== run-steps ${name} FAILED: rc=${f.rc} ${f.secs}s :: ${f.cmd}  (cwd ${f.cwd})`)
if (process.env.RUN_STEPS_REPORT_DIR) {
  try {
    mkdirSync(process.env.RUN_STEPS_REPORT_DIR, { recursive: true })
    writeFileSync(join(process.env.RUN_STEPS_REPORT_DIR, `${name}.json`), JSON.stringify({ name, results }, null, 2) + '\n')
  } catch (e) { console.error(`run-steps: could not write report: ${e.message}`) }
}
process.exit(failed.length ? 1 : 0)
