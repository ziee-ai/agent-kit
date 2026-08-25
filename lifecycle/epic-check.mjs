#!/usr/bin/env node
// epic-check.mjs — deterministic gate for the `epic-lifecycle` skill.
// Mirrors lifecycle-check.mjs: enforces STRUCTURE/completeness of the epic
// planning artifacts per phase; the judgment (are these the RIGHT contracts) is
// the author's. Usage:
//   node epic-check.mjs --phase <0-4> --epic <slug> --repo <root>
// Artifacts live under <root>/.lifecycle/<epic>/.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const phase = parseInt(arg('--phase') ?? '-1', 10);
const epic = arg('--epic');
const repo = arg('--repo') ?? process.cwd();
if (!epic || phase < 0 || phase > 4) {
  console.error('usage: epic-check.mjs --phase <0-4> --epic <slug> --repo <root>');
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
const section = (txt, name) => {
  if (!txt) return null;
  const re = new RegExp(`^##+\\s+${name}\\b([\\s\\S]*?)(?=^##+\\s|\\Z)`, 'im');
  const m = txt.match(re); return m ? m[1] : null;
};
const RE_PROV = /^\s*-\s*\*\*PROV-([A-Za-z0-9._-]+)\*\*\s*:/gim;
const RE_CONS = /^\s*-\s*\*\*CONS-([A-Za-z0-9._-]+)\*\*\s*\[from\s+([A-Za-z0-9._-]+)\]\s*\[expects:\s*PROV-([A-Za-z0-9._-]+)\]/gim;
const RE_RECON = /^\s*-\s*\*\*CONS-([A-Za-z0-9._-]+)\s*↔\s*PROV-([A-Za-z0-9._-]+)\*\*\s*—\s*verdict:\s*(MATCH|GAP|DRIFT)\b/gim;
const all = (re, s) => { const out = []; if (!s) return out; let m; re.lastIndex = 0; while ((m = re.exec(s))) out.push(m); return out; };

// ---- GRAPH parsing (P0) ----
function graph() {
  const t = read('GRAPH.md');
  if (t == null) { g('GRAPH.md missing (Phase 0)'); return null; }
  const isDag = /\bDAG\b/i.test(t) && !/cycle (found|detected)/i.test(t);
  const hasLeaves = /leaf|leaves/i.test(t);
  const hasTopo = /topolog/i.test(t);
  const edges = [...t.matchAll(/^\s*-?\s*([A-Za-z0-9._-]+)\s*(?:→|->)\s*([A-Za-z0-9._-]+)/gim)].map((m) => [m[1], m[2]]);
  return { t, isDag, hasLeaves, hasTopo, edges };
}

// ---- per-item PROV/CONS ----
function items() {
  const map = {};
  for (const d of itemDirs()) {
    const t = read(join(d, 'PLAN.md'));
    const prov = all(RE_PROV, section(t, 'Provides')).map((m) => `PROV-${m[1]}`);
    const cons = all(RE_CONS, section(t, 'Consumes')).map((m) => ({ id: `CONS-${m[1]}`, from: m[2], expects: `PROV-${m[3]}` }));
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

if (phase >= 0) {
  if (!gr) { /* already flagged */ }
  else {
    if (!gr.isDag) g('GRAPH.md: does not assert a DAG (or names a cycle) — resolve the cycle');
    if (!gr.hasLeaves) g('GRAPH.md: no leaf set named');
    if (!gr.hasTopo) g('GRAPH.md: no topological order');
  }
}
if (phase >= 1) {
  if (itemDirs().length === 0) g('no <item>/PLAN.md files found');
  for (const [d, x] of Object.entries(it)) {
    if (x.prov.length === 0) g(`${d}/PLAN.md: "## Provides" has no PROV-${d}-N lines (an item must declare ≥1 contract it exposes)`);
  }
  for (const d of leafSet()) {
    // leaves must not consume an in-epic item — already true by def (cons empty); fine
  }
}
if (phase >= 2) {
  for (const [d, x] of Object.entries(it)) {
    for (const c of x.cons) {
      if (!it[c.from]) g(`${d}/PLAN.md: ${c.id} names provider "${c.from}" which is not an item with a PLAN.md`);
      else if (!it[c.from].prov.includes(c.expects)) g(`${d}/PLAN.md: ${c.id} expects ${c.expects} which ${c.from} does not (yet) provide — a GAP to resolve in Phase 3`);
    }
  }
  // every non-leaf (has a dependency edge in the graph) should declare ≥1 CONS
  if (gr) {
    const deps = new Set(gr.edges.map(([, b]) => b)); // things that depend on something
    for (const d of deps) if (it[d] && it[d].cons.length === 0) g(`${d}: GRAPH shows it depends on something but its PLAN.md "## Consumes" has no CONS lines`);
  }
}
if (phase >= 3) {
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
if (phase >= 4) {
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
console.log(`epic-check  epic=${epic}  phase=${phase}  items=${itemDirs().length}`);
if (gaps.length === 0) {
  console.log(`  ✓ phase ${phase} OK`);
  process.exit(0);
} else {
  console.log(`  ✗ phase ${phase} FAIL`);
  for (const m of gaps) console.log(`      - ${m}`);
  process.exit(1);
}
