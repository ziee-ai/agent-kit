#!/usr/bin/env node
// epic-check.mjs — deterministic gate for the `epic-lifecycle` skill.
// Mirrors lifecycle-check.mjs: enforces STRUCTURE/completeness of the epic
// planning artifacts per phase; the judgment (are these the RIGHT contracts) is
// the author's. Usage:
//   node epic-check.mjs --phase <0-4> --epic <slug> --repo <root>
// Artifacts live under <root>/.lifecycle/<epic>/.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// STRICT arg parsing, for the same reason lifecycle-check.mjs is strict: `indexOf` drops
// an unrecognised flag silently, and a gate must never grade something other than what it
// was asked to grade. `--k=v` is normalised rather than ignored.
const ARGV = [];
for (const a of process.argv.slice(2)) {
  const m = /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(a);
  if (m) ARGV.push(m[1], m[2]);
  else ARGV.push(a);
}
const VALUE_FLAGS = ['--phase', '--epic', '--repo'];
const BOOL_FLAGS = ['--wip'];
for (let i = 0; i < ARGV.length; i++) {
  const tok = ARGV[i];
  if (!tok.startsWith('--')) {
    console.error(`epic-check: FATAL: unexpected positional argument \`${tok}\`\n  usage: epic-check.mjs (--phase <0-4> | --wip) --epic <slug> --repo <root>`);
    process.exit(2);
  }
  if (!VALUE_FLAGS.includes(tok) && !BOOL_FLAGS.includes(tok)) {
    console.error(`epic-check: FATAL: unknown flag \`${tok}\`\n  valid: ${VALUE_FLAGS.join(', ')}${BOOL_FLAGS.length ? ', ' + BOOL_FLAGS.join(', ') : ''}\n  usage: epic-check.mjs (--phase <0-4> | --wip) --epic <slug> --repo <root>`);
    process.exit(2);
  }
  if (BOOL_FLAGS.includes(tok)) continue;
  const v = ARGV[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`epic-check: FATAL: \`${tok}\` requires a value`);
    process.exit(2);
  }
  i++;
}
const arg = (f) => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : null; };
const phase = parseInt(arg('--phase') ?? '-1', 10);
const epic = arg('--epic');
const repo = arg('--repo') ?? process.cwd();
const wantWip = ARGV.includes('--wip');
if (wantWip && arg('--phase') !== null) {
  console.error('epic-check: FATAL: --wip and --phase are mutually exclusive (--wip computes the in-progress phase itself)');
  process.exit(2);
}
if (!epic || (!wantWip && (phase < 0 || phase > 4))) {
  const usage = wantWip
    ? 'usage: epic-check.mjs --wip --epic <slug> --repo <root>'
    : 'usage: epic-check.mjs --phase <0-4> --epic <slug> --repo <root>';
  console.error(usage);
  process.exit(2);
}
const base = join(repo, '.lifecycle', epic);
const gaps = [];
const g = (m) => gaps.push(m);
const read = (p) => { try { return readFileSync(join(base, p), 'utf8'); } catch { return null; } };
const itemDirs = () => {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => {
    try { return statSync(join(base, d)).isDirectory() && existsSync(join(base, d, 'PLAN.md')); }
    catch { return false; }
  });
};
// Line-based section slice — robust against the `\Z`-is-not-a-JS-anchor trap
// (with the /i flag `\Z` matched a literal z, truncating a section at its first
// "Zarr"/"materialize"/"finalize" and dropping every line after it; a final
// section with no following heading failed to match at all). Take from the
// heading line to the next `## ` heading (or end of file).
const section = (txt, name) => {
  if (!txt) return null;
  const lines = txt.split(/\r?\n/);
  const head = new RegExp(`^##+\\s+${name}\\b`, 'i');
  const hi = lines.findIndex((l) => head.test(l));
  if (hi < 0) return null;
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) { if (/^##+\s/.test(lines[i])) { end = i; break; } }
  return lines.slice(hi + 1, end).join('\n');
};
// A PROV line may carry an optional parenthetical tag between the id and the
// colon — `- **PROV-T3-2** (G2): …` — so the colon is NOT required to sit
// immediately after `**`. Without this, such a contract parsed to NOTHING and
// was SILENTLY DROPPED: the item passed its own gate on its other contracts,
// and a downstream CONS binding the dropped PROV saw a phantom GAP. (Found when
// T4 first bound PROV-T3-2.)
const RE_PROV = /^\s*-\s*\*\*PROV-([A-Za-z0-9._-]+)\*\*\s*(?:\([^)]*\)\s*)?:/gim;
const RE_CONS = /^\s*-\s*\*\*CONS-([A-Za-z0-9._-]+)\*\*\s*\[from\s+([A-Za-z0-9._-]+)\]\s*\[expects:\s*PROV-([A-Za-z0-9._-]+)\]/gim;
const RE_RECON = /^\s*-\s*\*\*CONS-([A-Za-z0-9._-]+)\s*↔\s*PROV-([A-Za-z0-9._-]+)\*\*\s*—\s*verdict:\s*(MATCH|GAP|DRIFT)\b/gim;
// LOUD tripwire: a line that LOOKS like a contract declaration (opens `- **PROV-`
// / `- **CONS-`) but does NOT match the strict grammar above. Silent-drop is the
// dangerous failure mode (the gate goes green on unbindable contracts), so any
// such line is surfaced as an explicit error rather than skipped.
const RE_PROV_LOOSE = /^[ \t]*-[ \t]*\*\*PROV-([A-Za-z0-9._-]+)\*\*/gim;
const RE_CONS_LOOSE = /^[ \t]*-[ \t]*\*\*CONS-([A-Za-z0-9._-]+)/gim;
const all = (re, s) => { const out = []; if (!s) return out; let m; re.lastIndex = 0; while ((m = re.exec(s))) out.push(m); return out; };
// Return the ids that OPEN a contract bullet (loose) but never satisfy the strict
// grammar (strict) — i.e. declared-but-unbindable. Compared by captured id, not by
// line text, because `\s` in the strict regexes can span newlines and defeat any
// positional reconstruction. Reconcile rows (`CONS-X ↔ PROV-Y`) legitimately open
// `- **CONS-` without `[from …]`, so the CONS tripwire must skip them.
const malformed = (loose, strict, s, skip = null) => {
  if (!s) return [];
  const strictIds = new Set(all(strict, s).map((m) => m[1]));
  const seen = new Set();
  const out = [];
  for (const m of all(loose, s)) {
    const id = m[1];
    if (strictIds.has(id) || seen.has(id)) continue;
    if (skip && skip.test(s.slice(m.index).split('\n')[0])) continue;
    seen.add(id); out.push(id);
  }
  return out;
};

// ---- GRAPH parsing (P0) ----
function graph() {
  const t = read('GRAPH.md');
  if (t == null) { g('GRAPH.md missing (Phase 0)'); return null; }
  // A DAG assertion must not be defeated by a NEGATED cycle mention ("no cycle
  // found", "acyclic") — only an ACTUAL cycle declaration ("found a cycle",
  // "cycle detected", "has a cycle") fails.
  const isDag = /\bDAG\b|\bacyclic\b/i.test(t) && !/(has|have|found|detected|contains|is)\s+(a\s+)?cycle/i.test(t);
  const hasLeaves = /leaf|leaves/i.test(t);
  const hasTopo = /topolog/i.test(t);
  const edges = [...t.matchAll(/^\s*-?\s*([A-Za-z0-9._-]+)\s*(?:→|->)\s*([A-Za-z0-9._-]+)/gim)].map((m) => [m[1], m[2]]);
  // external/substrate providers this epic assumes: PROV-<EXT>-N declared in GRAPH
  const subProv = all(RE_PROV, t).map((m) => `PROV-${m[1]}`);
  return { t, isDag, hasLeaves, hasTopo, edges, subProv };
}

// ---- per-item PROV/CONS ----
function items() {
  const map = {};
  for (const d of itemDirs()) {
    const t = read(join(d, 'PLAN.md'));
    const provSec = section(t, 'Provides');
    const consSec = section(t, 'Consumes');
    const prov = all(RE_PROV, provSec).map((m) => `PROV-${m[1]}`);
    const cons = all(RE_CONS, consSec).map((m) => ({ id: `CONS-${m[1]}`, from: m[2], expects: `PROV-${m[3]}` }));
    for (const bad of malformed(RE_PROV_LOOSE, RE_PROV, provSec))
      g(`${d}: PROV-${bad} won't bind — needs \`- **PROV-${bad}**[ (tag)]: text\` (colon after the id/tag)`);
    for (const bad of malformed(RE_CONS_LOOSE, RE_CONS, consSec, /↔/))
      g(`${d}: CONS-${bad} won't bind — needs \`- **CONS-${bad} [from <dir>] [expects: PROV-x]: text\``);
    map[d] = { t, prov, cons };
  }
  return map;
}

const gr = graph();
const it = items();
const allProv = new Set(Object.values(it).flatMap((x) => x.prov));
const leafSet = () => {
  // a leaf = an item that consumes no in-epic item
  return Object.entries(it).filter(([, x]) => x.cons.length === 0).map(([d]) => d);
};

// ---- --wip: the MID-ROUND PUSH GATE (mirrors lifecycle-check --wip) ---------
// The pre-push hook runs this on an epic root. Same rule as the feature gate:
// the phases a branch has COMPLETED must be green, and the ONE it is currently
// working is exempt. Completion is read from the NEXT phase's artifact (the same
// "presence is progress; gaps are quality" frontier lifecycle-check uses):
//   · P0 (GRAPH.md) is in progress until some item plan exists;
//   · P1 (leaf plans) is in progress until a dependent plan declares ≥1 CONS
//     (i.e. P2 has started) — so a mid-P1 push does not yet demand every plan
//     be complete, exactly like a mid-P1 feature push;
//   · P2 (dependent plans) is in progress until RECONCILE.md exists;
//   · P3 (reconcile) is in progress until the freeze line exists. Its GAPs are
//     the author's worklist, so the "which X does not provide" check is P3
//     content (the Phase-2 gate per the skill allows GAPs).
//   · A complete epic (frozen) has no phase left in progress: every phase is
//     demanded, exactly like --all on a complete feature.
// A phase with artifacts ABOVE a hole (graph-less plans; a RECONCILE with no
// item plans) is a misdirected tree, not an in-progress one: no phase is exempt
// and the missing lower artifact fails its own phase (fail closed).
let gatePhase = phase;
let wipState = null;
if (wantWip) {
  const has = (p) => { try { return statSync(join(base, p)).isFile(); } catch { return false; } };
  const p0 = has('GRAPH.md');
  const p1 = itemDirs().length > 0;
  let p2 = false;
  if (p1) for (const x of Object.values(it)) if (x.cons.length > 0) { p2 = true; break; }
  const p3 = has('RECONCILE.md');
  const p4 = /\*\*Frozen:\*\*/i.test(read('RECONCILE.md') ?? '');
  const present = [p0, p1, p2, p3, p4];
  if (!present.some(Boolean)) {
    // GRADING NOTHING IS NOT A PASS (same rule as lifecycle-check): the tree is
    // an epic ROOT (the hook detected it) but holds no epic artifact at all.
    console.error(`epic-check: FAIL (--wip) — ${base} contains no epic artifacts (no GRAPH.md, no item plan, no RECONCILE.md); nothing was graded, so this run proves nothing.`);
    process.exit(1);
  }
  let k = 0; while (k < 5 && present[k]) k++;
  wipState = {
    complete: k === 5,
    malformed: present.slice(k + 1).some(Boolean),
    exempt: !present.slice(k + 1).some(Boolean) && k < 5 ? k - 1 : null, // the in-progress phase
  };
  gatePhase = wipState.complete || wipState.malformed ? 4 : k - 2;
}

if (gatePhase >= 0) {
  if (!gr) { /* already flagged */ }
  else {
    if (!gr.isDag) g('GRAPH.md: does not assert a DAG (or names a cycle) — resolve the cycle');
    if (!gr.hasLeaves) g('GRAPH.md: no leaf set named');
    if (!gr.hasTopo) g('GRAPH.md: no topological order');
  }
}
if (gatePhase >= 1) {
  if (itemDirs().length === 0) g('no <item>/PLAN.md files found');
  for (const [d, x] of Object.entries(it)) {
    if (x.prov.length === 0) g(`${d}/PLAN.md: "## Provides" has no PROV-${d}-N lines (an item must declare ≥1 contract it exposes)`);
  }
  for (const d of leafSet()) {
    // leaves must not consume an in-epic item — already true by def (cons empty); fine
  }
}
if (gatePhase >= 2) {
  const subProv = new Set(gr?.subProv ?? []); // external/substrate PROVs declared in GRAPH.md
  for (const [d, x] of Object.entries(it)) {
    for (const c of x.cons) {
      const inEpic = !!it[c.from];
      const isExternal = !inEpic && subProv.has(c.expects); // a cross-epic substrate contract, pinned in GRAPH
      if (!inEpic && !isExternal) {
        g(`${d}/PLAN.md: ${c.id} names provider "${c.from}" which is neither an in-epic item nor an external substrate PROV declared in GRAPH.md — pin the cross-epic interface as a PROV-<EXT> in GRAPH's substrate section (it must NOT be left unpinned in ASSUMPTIONS.md)`);
      } else if (inEpic && !it[c.from].prov.includes(c.expects) && gatePhase >= 3) {
        g(`${d}/PLAN.md: ${c.id} expects ${c.expects} which ${c.from} does not (yet) provide — a GAP to resolve in Phase 3`);
      }
    }
  }
  // every non-leaf (has a dependency edge in the graph) should declare ≥1 CONS
  if (gr) {
    const deps = new Set(gr.edges.map(([, b]) => b)); // things that depend on something
    for (const d of deps) if (it[d] && it[d].cons.length === 0) g(`${d}: GRAPH shows it depends on something but its PLAN.md "## Consumes" has no CONS lines`);
  }
}
if (gatePhase >= 3) {
  const recon = read('RECONCILE.md');
  if (recon == null) g('RECONCILE.md missing (Phase 3)');
  else {
    const rows = all(RE_RECON, recon);
    const covered = new Set(rows.map((m) => `CONS-${m[1]}`));
    for (const [d, x] of Object.entries(it)) for (const c of x.cons) {
      if (!covered.has(c.id)) g(`RECONCILE.md: no verdict row for ${c.id} (from ${d})`);
    }
    const unmetM = recon.match(/\*\*Unmet contracts:\*\*\s*(\d+)/i);
    if (!unmetM) g('RECONCILE.md: missing "**Unmet contracts:** <N>" convergence line');
    else if (parseInt(unmetM[1], 10) !== 0) g(`RECONCILE.md: Unmet contracts = ${unmetM[1]} (must be 0 to pass Phase 3)`);
    const openVerdicts = rows.filter((m) => m[3] !== 'MATCH');
    for (const m of openVerdicts) g(`RECONCILE.md: CONS-${m[1]} ↔ PROV-${m[2]} verdict is ${m[3]} — resolve to MATCH before freeze`);
  }
}
if (gatePhase >= 4) {
  const recon = read('RECONCILE.md') ?? '';
  if (!/\*\*Frozen:\*\*/i.test(recon)) g('RECONCILE.md: missing "**Frozen:** ..." freeze line (Phase 4)');
  // every downstream-bound PROV must be named by an [acceptance] test in its item's PLAN
  const boundProv = new Set(Object.values(it).flatMap((x) => x.cons.map((c) => c.expects)));
  for (const [d, x] of Object.entries(it)) {
    for (const p of x.prov) {
      if (!boundProv.has(p)) continue; // only downstream-bound contracts must be pinned
      const item = p.replace(/^PROV-/, '').replace(/-\d+$/, '');
      const plan = it[d].t ?? '';
      const named = new RegExp(`\\[acceptance\\][^\\n]*${p.replace(/[-]/g, '\\-')}|${p.replace(/[-]/g, '\\-')}[^\\n]*\\[acceptance\\]`, 'i').test(plan)
        || new RegExp(`\\[acceptance\\][\\s\\S]{0,400}${p.replace(/[-]/g, '\\-')}`, 'i').test(plan);
      if (!named) g(`${d}/PLAN.md: downstream-bound ${p} is not named by an [acceptance] test — Phase 4 requires each consumed contract be pinned by an acceptance test`);
    }
  }
}

const tier = 'epic-lifecycle';
if (wantWip) {
  console.log(`epic-check  epic=${epic}  wip  items=${itemDirs().length}`);
  if (gaps.length === 0) {
    if (wipState.complete) console.log('  ✓ complete — every phase demanded (phases 0..4 green)');
    else if (wipState.exempt === 0) console.log('  ✓ phase 0 in progress (exempt)');
    else if (wipState.exempt != null) console.log(`  ✓ phases 0..${wipState.exempt - 1} complete, phase ${wipState.exempt} in progress (exempt)`);
    process.exit(0);
  }
  console.log(`  ✗ wip FAIL — a completed phase has gaps${wipState.exempt != null ? ` (phase ${wipState.exempt} in progress is exempt)` : ''}`);
  for (const m of gaps) console.log(`      - ${m}`);
  process.exit(1);
}
console.log(`epic-check  epic=${epic}  phase=${phase}  items=${itemDirs().length}`);
if (gaps.length === 0) {
  console.log(`  ✓ phase ${phase} OK`);
  process.exit(0);
} else {
  console.log(`  ✗ phase ${phase} FAIL`);
  for (const m of gaps) console.log(`      - ${m}`);
  process.exit(1);
}
