#!/usr/bin/env node
/**
 * merge-findings.mjs — fold a run's findings into the deduped ledger.
 *
 * This lived inline in explore-loop.sh. When explore-fleet.sh was written it was
 * not ported, so for four days the fleet produced findings and threw all of them
 * away: 12,956 of them, including 1,965 server-5xx and 26 uncaught-exception,
 * while every status report said "no new HIGH findings" because the file could
 * not change. A health signal that cannot move is worse than no signal.
 *
 * It is a standalone script now precisely so there is one implementation for
 * every runner to call, rather than two that drift.
 *
 *   node merge-findings.mjs <result.json|run-dir> [--state DIR]
 *   node merge-findings.mjs --backfill --state DIR      # sweep every past run
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const stateIdx = args.indexOf('--state')
const STATE = stateIdx >= 0 ? args[stateIdx + 1] : '/data/pbya/ziee/tmp/live-ui-explore'
const LEDGER = join(STATE, 'FINDINGS_LEDGER.md')
const SEEN = join(STATE, 'seen.json')

// Read the dedup index FAIL-CLOSED, and never treat an unreadable file as empty.
//
// The fleet runs three workers, each invoking this script at the end of its
// cycle, all writing this one file with a non-atomic writeFileSync. A reader that
// lands mid-write gets truncated JSON; starting from {} then rewrites the file
// with only the current run's findings. That is exactly how affordances.json lost
// 25,959 entries, and it happened here too: seen.json fell from 747 to 33 while
// every worker reported success. FINDINGS_LEDGER.md is append-only so the
// findings survived, but the index that stops re-reporting them did not.
let seen = {}
try {
  seen = JSON.parse(readFileSync(SEEN, 'utf8'))
} catch (e) {
  if (existsSync(SEEN) && statSync(SEEN).size > 0) {
    console.error(`merge-findings: ${SEEN} is unreadable — refusing to merge rather than overwrite it`)
    process.exit(0)   // exit 0: a skipped merge is not a failed cycle
  }
}
// Atomic replace, so a concurrent reader sees the old file or the new one.
const writeSeen = () => {
  const tmp = `${SEEN}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(seen, null, 1))
  renameSync(tmp, SEEN)
}

const fpOf = (f) => f.fingerprint || `${f.kind}|${String(f.detail).slice(0, 120)}`

function mergeOne(resultPath, cycleLabel) {
  let d
  try { d = JSON.parse(readFileSync(resultPath, 'utf8')) } catch { return 0 }
  const fresh = []
  for (const f of d.findings || []) {
    // model-vision-only stays out: it is a lead, not a machine-verified finding
    if (f.verifiedBy !== 'detector') continue
    if (!['HIGH', 'MEDIUM'].includes(f.severity)) continue
    const fp = fpOf(f)
    if (seen[fp]) { seen[fp].count++; seen[fp].lastCycle = cycleLabel; continue }
    seen[fp] = { count: 1, firstCycle: cycleLabel, lastCycle: cycleLabel, kind: f.kind, severity: f.severity }
    fresh.push(f)
  }
  if (fresh.length) {
    let out = ''
    for (const f of fresh) {
      out += `\n## ${f.severity} · ${f.kind}  _(new in ${cycleLabel})_\n`
        + `- url: \`${f.url}\`\n- action: \`${JSON.stringify(f.action)}\`\n- shot: \`${f.shot}\`\n\n${f.detail}\n`
    }
    appendFileSync(LEDGER, out)
  }
  return fresh.length
}

if (args.includes('--backfill')) {
  // Oldest first, so firstCycle labels stay chronological.
  const runs = readdirSync(STATE)
    .filter(n => /^(fleet\d+|run)-\d{8}-\d{6}$/.test(n))
    .sort()
  let added = 0, scanned = 0
  for (const r of runs) {
    const p = join(STATE, r, 'result.json')
    if (!existsSync(p)) continue
    scanned++
    added += mergeOne(p, r)
  }
  writeSeen()
  console.log(`backfill: ${scanned} runs scanned, ${added} new distinct findings, ${Object.keys(seen).length} in ledger`)
} else {
  const target = args.find(a => !a.startsWith('--') && a !== STATE)
  if (!target) { console.error('usage: merge-findings.mjs <result.json|run-dir> [--state DIR]'); process.exit(2) }
  const p = target.endsWith('.json') ? target : join(target, 'result.json')
  const label = target.replace(/\/$/, '').split('/').pop()
  const n = mergeOne(p, label)
  writeSeen()
  console.log(`ledger: +${n} new, ${Object.keys(seen).length} distinct total`)
}
