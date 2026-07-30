#!/usr/bin/env node
/**
 * api-coverage.mjs — what fraction of the API has the explorer actually reached?
 *
 * Route coverage ("it visited /projects") is a weak proxy: a page can be
 * rendered without a single write ever firing. The predecessor rig looked like
 * it covered the app for that reason. The honest measure is which ENDPOINTS the
 * UI actually triggered, diffed against the spec that defines them all.
 *
 * Reads:
 *   - the cumulative tally written by explore.mjs (METHOD /api/x/{id} -> count)
 *   - openapi.json, the authoritative list of what exists
 *
 * Reports overall coverage, coverage by HTTP method (a UI that only GETs is a
 * read-only tour), and the untouched endpoints grouped by resource so the gaps
 * are actionable rather than a wall of 300 lines.
 *
 *   node api-coverage.mjs [--spec <openapi.json>] [--hits <api-coverage.json>] [--top N]
 */
import { readFileSync } from 'node:fs'

const arg = (n, d) => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`))
  if (h) return h.slice(n.length + 3)
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const SPEC = arg('spec', '/data/pbya/ziee/tmp/live-rig-wt/src-app/ui/openapi/openapi.json')
const HITS = arg('hits', '/data/pbya/ziee/tmp/live-ui-explore/api-coverage.json')
const TOP = Number(arg('top', 40))

const spec = JSON.parse(readFileSync(SPEC, 'utf8'))
let hits = {}
try { hits = JSON.parse(readFileSync(HITS, 'utf8')) } catch { hits = {} }

// The spec's paths are already templated (/api/knowledge-bases/{id}); explore.mjs
// normalises live URLs to the same shape, so the two are directly comparable.
// Normalise the PARAM NAME too — the spec may say {kb_id} where the recorder
// emits {id}; comparing on shape rather than on the author's chosen name avoids
// reporting a hit endpoint as untouched.
const shape = s => s.replace(/\{[^}]+\}/g, '{}')

const declared = []
for (const [path, ops] of Object.entries(spec.paths || {})) {
  for (const method of Object.keys(ops)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
    declared.push({ key: `${method.toUpperCase()} ${path}`, shape: `${method.toUpperCase()} ${shape(path)}` })
  }
}
const hitShapes = new Map()
for (const [k, v] of Object.entries(hits)) {
  const sh = shape(k)
  hitShapes.set(sh, (hitShapes.get(sh) || 0) + v)
}

const touched = declared.filter(d => hitShapes.has(d.shape))
const untouched = declared.filter(d => !hitShapes.has(d.shape))

// Requests the UI made that the spec does not declare — usually a normalisation
// mismatch on our side, occasionally a real undocumented endpoint. Worth seeing
// rather than silently dropping.
const declaredShapes = new Set(declared.map(d => d.shape))
const unknown = [...hitShapes.keys()].filter(s => !declaredShapes.has(s))

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0')
console.log(`# API endpoint coverage\n`)
console.log(`- spec: ${declared.length} endpoints`)
console.log(`- exercised: **${touched.length} (${pct(touched.length, declared.length)}%)**`)
console.log(`- never touched: ${untouched.length}`)

const byMethod = {}
for (const d of declared) {
  const m = d.key.split(' ')[0]
  byMethod[m] ??= { total: 0, hit: 0 }
  byMethod[m].total++
  if (hitShapes.has(d.shape)) byMethod[m].hit++
}
console.log(`\n## by method`)
console.log(`(a UI that only GETs is a read-only tour — writes are where the bugs are)\n`)
for (const [m, v] of Object.entries(byMethod).sort()) {
  console.log(`- ${m.padEnd(6)} ${String(v.hit).padStart(3)}/${String(v.total).padEnd(3)}  ${pct(v.hit, v.total).padStart(5)}%`)
}

const group = k => (k.split(' ')[1] || '').split('/').slice(0, 3).join('/')
const groups = {}
for (const d of untouched) (groups[group(d.key)] ??= []).push(d.key)
console.log(`\n## untouched, by resource (top ${TOP} groups)\n`)
for (const [g, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length).slice(0, TOP)) {
  console.log(`- **${g}** — ${list.length}`)
  for (const k of list.slice(0, 6)) console.log(`    - ${k}`)
  if (list.length > 6) console.log(`    - …${list.length - 6} more`)
}

if (unknown.length) {
  console.log(`\n## requested but NOT in the spec (${unknown.length})`)
  console.log(`(normalisation mismatch on our side, or a genuinely undocumented endpoint)\n`)
  for (const u of unknown.slice(0, 15)) console.log(`- ${u}`)
}
