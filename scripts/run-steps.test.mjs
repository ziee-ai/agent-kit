// scripts/run-steps.test.mjs — the keep-going step runner (owner 2026-10-12: never stop at the first failure).
// Two-direction: a red step must NOT stop later steps and must make the run exit 1; an all-green run exits 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER = join(ROOT, 'scripts', 'run-steps.mjs')
const run = (args, opts = {}) => spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', ...opts })

test('TEST-1 a failing step does not stop the later steps; exit 1; every failure listed', () => {
  const d = mkdtempSync(join(tmpdir(), 'run-steps-'))
  const r = run(['--name', 't1', '--', 'exit 3', `touch ${join(d, 'second-ran')}`, 'exit 5'], { env: { ...process.env, RUN_STEPS_REPORT_DIR: d } })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.ok(existsSync(join(d, 'second-ran')), 'step 2 must run after step 1 failed')
  assert.match(r.stdout, /SUMMARY: 1\/3 passed, 2 failed/)
  assert.match(r.stdout, /FAILED: rc=3 .* :: exit 3/)
  assert.match(r.stdout, /FAILED: rc=5 .* :: exit 5/)
  const rep = JSON.parse(readFileSync(join(d, 't1.json'), 'utf8'))
  assert.deepEqual(rep.results.map((x) => x.rc), [3, 0, 5])
})

test('TEST-2 all steps green -> exit 0 (the other direction)', () => {
  const r = run(['--name', 't2', '--', 'true', 'echo ok'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SUMMARY: 2\/2 passed, 0 failed/)
})

test('TEST-3 --just-deps expands the recipe header (with --sub) into `just <leg>` steps', () => {
  const app = mkdtempSync(join(tmpdir(), 'run-steps-app-'))
  writeFileSync(join(app, 'justfile'), 'merge-checks: lint check-ui test-static\n    @echo done\n')
  const r = run(['--name', 't3', '--just-deps', 'merge-checks', '--sub', 'check-ui=check-ui-all', '--', 'true'], {
    cwd: app, env: { ...process.env, PATH: `${mkShim()}:${process.env.PATH}` },
  })
  const jf = readFileSync(join(app, 'justfile'), 'utf8')
  const legs = jf.match(/^merge-checks:([^\n]*)$/m)[1].trim().split(/\s+/)
  for (const leg of legs) assert.match(r.stdout, new RegExp(`:: just ${leg === 'check-ui' ? 'check-ui-all' : leg}\\n`), `leg ${leg} missing`)
  assert.match(r.stdout, new RegExp(`SUMMARY: ${legs.length + 1}/${legs.length + 1} passed`))
})

test('TEST-4 --npm-chain splits a package script on && and runs every segment after a red one', () => {
  const d = mkdtempSync(join(tmpdir(), 'run-steps-npm-'))
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { check: `false && touch ${join(d, 'b')} && touch ${join(d, 'c')}` } }))
  const r = run(['--name', 't4', '--npm-chain', 'check', '--cwd', d])
  assert.equal(r.status, 1)
  assert.ok(existsSync(join(d, 'b')) && existsSync(join(d, 'c')), 'segments after the red one must run')
  assert.match(r.stdout, /SUMMARY: 2\/3 passed, 1 failed/)
})

// a `just` shim that succeeds without running anything (TEST-3 proves the expansion, not the legs)
function mkShim() {
  const d = mkdtempSync(join(tmpdir(), 'run-steps-shim-'))
  writeFileSync(join(d, 'just'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return d
}

test('TEST-5 --just-legs runs an inline leg list in order, keep-going', () => {
  const r = run(['--name', 't5', '--just-legs', 'a b c'], { env: { ...process.env, PATH: `${mkShim()}:${process.env.PATH}` } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /\[1\/3\] START .* :: just a\n[\s\S]*\[2\/3\] START .* :: just b\n[\s\S]*\[3\/3\] START .* :: just c\n/)
})
