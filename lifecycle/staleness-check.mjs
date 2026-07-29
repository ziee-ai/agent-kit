#!/usr/bin/env node
// staleness-check.mjs — detect the class of bug where a tool is looking at, or
// running, something OLDER than what is on disk.
//
// WHY THIS EXISTS — stale state was the single largest source of wasted effort in
// a recent 10-hour session, and NO existing gate caught any of it. What makes this
// class expensive is not that it fails; it is that it SUCCEEDS. Every instance
// produced a confident, well-formatted, wrong answer:
//
//   • a 24/7 audit rig auditing a build 87 commits old — 292 cycles reported
//     "healthy" about code nobody was running.
//   • a long-running bash loop still executing the copy of its own script that it
//     parsed at start — a freshness gate that existed ON DISK never ran, and the
//     same staleness under-reported findings by ~99×.
//   • a repo whose `sdk` submodule was an empty dir — `npm run check` could not
//     run there at all, and `git -C <empty-submodule>` silently WALKED UP to the
//     parent repo and answered about the PARENT's remote and branches, sending an
//     investigation down a false path.
//   • git worktrees pinning an old agent-kit commit — branches ran rules already
//     fixed upstream, and the fix was done twice.
//   • a UI gate "reusing" a dev server belonging to a DIFFERENT worktree —
//     phantom UI regressions that cost multiple agents hours.
//
// A loud failure is cheap. A confident wrong answer is not. Each check below
// therefore reports the CONSEQUENCE ("the answer you are about to trust is about
// <other thing>"), not merely the state.
//
// Usage:
//   node staleness-check.mjs --repo <path>
//                            [--port <n>]...        [--expect-root <path>]
//                            [--stamp <file>]...    [--stamp-repo <path>]
//                            [--process-pattern <re>]...
//                            [--json] [--quiet]
//
// Exit: 0 = nothing genuinely stale (informational findings may still print)
//       1 = at least one genuine staleness finding
//       2 = usage error
//
// Portability: the process and port probes read Linux `/proc`. Where it is not
// available the check degrades to SKIP — never an error, never a false PASS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------
const findings = [];
/** severity: 'stale' (gates), 'info' (reported, never gates), 'skip' (probe unavailable) */
const add = (severity, check, title, diagnosis, extra = {}) =>
  findings.push({ severity, check, title, diagnosis, ...extra });

const STALE = (c, t, d, e) => add('stale', c, t, d, e);
const INFO = (c, t, d, e) => add('info', c, t, d, e);
const SKIP = (c, t, d, e) => add('skip', c, t, d, e);

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { repo: null, ports: [], stamps: [], patterns: [], expectRoot: null, stampRepo: null, json: false, quiet: false };
  const bad = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      if (argv[i + 1] === undefined) { bad.push(`${a} needs a value`); return null; }
      return argv[++i];
    };
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('--repo')) o.repo = val();
    else if (a.startsWith('--expect-root')) o.expectRoot = val();
    else if (a.startsWith('--stamp-repo')) o.stampRepo = val();
    else if (a.startsWith('--stamp')) { const v = val(); if (v) o.stamps.push(v); }
    else if (a.startsWith('--port')) { const v = val(); if (v) o.ports.push(v); }
    else if (a.startsWith('--process-pattern')) { const v = val(); if (v) o.patterns.push(v); }
    else if (a === '-h' || a === '--help') o.help = true;
    else bad.push(`unknown argument ${a}`);
  }
  return { ...o, bad };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 32 * 1024 * 1024,
  }).trim();
}
function gitOr(args, cwd, fallback = null) {
  try { return git(args, cwd); } catch { return fallback; }
}
function real(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
/** true when `child` is `root` or lives underneath it (both realpath-resolved). */
function under(child, root) {
  const c = real(child), r = real(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
const hasProc = () => { try { return fs.statSync('/proc/self').isDirectory(); } catch { return false; } };

// ---------------------------------------------------------------------------
// S1 — declared submodules are actually initialised
//
// An uninitialised submodule is an EMPTY DIRECTORY that still satisfies
// `existsSync`. Two failure modes follow, and the second is the nasty one:
//   1. anything that runs inside it (npm run check, a lint scanner) cannot run.
//   2. `git -C <empty-submodule> …` does NOT fail. git walks UP the directory
//      tree until it finds a repo, finds the PARENT, and answers about the
//      parent's remote/branches/HEAD — with exit 0. An investigation that trusts
//      that output is reasoning about the wrong repository.
// So the check is not "does the dir exist" but "does `git -C <dir>` resolve to
// THAT dir as its own toplevel".
// ---------------------------------------------------------------------------
function checkSubmodules(repo) {
  const gm = path.join(repo, '.gitmodules');
  if (!fs.existsSync(gm)) { SKIP('S1 submodules', 'no .gitmodules', 'repo declares no submodules — nothing to verify.'); return []; }

  const raw = gitOr(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], repo, '');
  const paths = [];
  for (const line of (raw || '').split('\n')) {
    const m = line.trim().match(/^submodule\.(.+)\.path\s+(.+)$/);
    if (m) paths.push({ name: m[1], rel: m[2].trim() });
  }
  if (!paths.length) { SKIP('S1 submodules', 'no submodule paths parsed', '.gitmodules present but declares no `path` entries.'); return []; }

  const ok = [];
  for (const { name, rel } of paths) {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) {
      STALE('S1 submodules', `${rel} — declared but absent`,
        `submodule '${name}' is declared in .gitmodules but ${rel} does not exist; every tool that reads it (lint scanners, npm run check, imports) resolves against nothing. Run: git -C ${repo} submodule update --init ${rel}`);
      continue;
    }
    if (!isDir(abs)) {
      STALE('S1 submodules', `${rel} — not a directory`,
        `submodule '${name}' path ${rel} exists but is not a directory; the submodule cannot be checked out over it.`);
      continue;
    }
    let entries = [];
    try { entries = fs.readdirSync(abs); } catch { /* unreadable */ }
    const empty = entries.length === 0;

    // The walk-up trap, asserted explicitly.
    const top = gitOr(['rev-parse', '--show-toplevel'], abs, null);
    const ownsItself = top !== null && real(top) === real(abs);

    if (empty) {
      const walked = top !== null && !ownsItself
        ? ` Worse, \`git -C ${rel}\` does NOT fail here: it walks UP and answers about ${real(top)} — the PARENT repo — with exit 0, so its remote/branch/HEAD output describes the wrong repository.`
        : '';
      STALE('S1 submodules', `${rel} — uninitialised (empty dir)`,
        `submodule '${name}' is an EMPTY directory, so nothing under it can run (npm run check / lint scanners / imports all resolve against nothing).${walked} Run: git -C ${repo} submodule update --init ${rel}`,
        { walkedUpTo: ownsItself ? null : (top && real(top)) });
      continue;
    }
    if (!ownsItself) {
      STALE('S1 submodules', `${rel} — populated but not its own git repo`,
        `${rel} has files but \`git -C ${rel} rev-parse --show-toplevel\` resolves to ${top ? real(top) : '(git failed)'}, not ${real(abs)}. Every \`git -C ${rel}\` answer you read is about that other repo, at exit 0.`,
        { walkedUpTo: top && real(top) });
      continue;
    }
    ok.push({ name, rel, abs });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// S2 — how far each submodule's pinned commit is behind its remote branch.
//
// INFORMATIONAL BY DESIGN. Being behind is frequently correct (a branch pins a
// known-good agent-kit on purpose). What is NOT acceptable is not KNOWING: the
// duplicated-work case was worktrees silently running rules already fixed
// upstream. Distances are measured against refs already fetched — this check
// never touches the network, so a large number can also just mean "stale fetch".
// ---------------------------------------------------------------------------
function checkPinnedVsUpstream(subs) {
  for (const { name, rel, abs } of subs) {
    const head = gitOr(['rev-parse', 'HEAD'], abs);
    if (!head) { SKIP('S2 pinned-vs-upstream', `${rel} — no HEAD`, 'submodule has no resolvable HEAD.'); continue; }

    let upstream = gitOr(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], abs);
    if (!upstream) {
      for (const cand of ['origin/HEAD', 'origin/main', 'origin/master']) {
        if (gitOr(['rev-parse', '--verify', '--quiet', cand], abs)) { upstream = cand; break; }
      }
    }
    if (!upstream) {
      SKIP('S2 pinned-vs-upstream', `${rel} — no upstream ref`,
        'no @{upstream} and no origin/HEAD|main|master present locally; distance cannot be measured without a fetch.');
      continue;
    }
    const behind = gitOr(['rev-list', '--count', `HEAD..${upstream}`], abs);
    const ahead = gitOr(['rev-list', '--count', `${upstream}..HEAD`], abs);
    const b = Number(behind ?? NaN), a = Number(ahead ?? NaN);
    if (!Number.isFinite(b)) { SKIP('S2 pinned-vs-upstream', `${rel} — distance unmeasurable`, `could not count HEAD..${upstream}.`); continue; }
    INFO('S2 pinned-vs-upstream', `${rel} — ${b} behind / ${a} ahead of ${upstream}`,
      b > 0
        ? `submodule '${name}' pins a commit ${b} behind ${upstream} (as last fetched) — if those ${b} commits contain rule/gate fixes, work done here is being judged by, or duplicating, an older ruleset. Not a failure: pinning is often deliberate.`
        : a > 0
          ? `submodule '${name}' pins a commit ${a} AHEAD of ${upstream} (as last fetched) — local work not yet pushed, or a stale fetch of the remote.`
          : `submodule '${name}' pin is level with ${upstream} (as last fetched).`,
      { behind: b, ahead: a, upstream, head });
  }
}

// ---------------------------------------------------------------------------
// S3 — a build/run artifact stamped with the commit it was built from, vs HEAD.
//
// This is the 87-commits-behind rig, generalised: any artifact that records
// "built from <sha>" can be compared to the repo it claims to represent. The
// consequence is what matters — a green report about commit X says nothing about
// the code at HEAD, but reads exactly like it does.
// ---------------------------------------------------------------------------
function checkStamp(stampFile, repo) {
  if (!fs.existsSync(stampFile)) {
    STALE('S3 build-stamp', `${stampFile} — missing`,
      `no build stamp at ${stampFile}: there is no evidence which commit the artifact was built from, so any result it produces cannot be attributed to a commit.`);
    return;
  }
  let text = '';
  try { text = fs.readFileSync(stampFile, 'utf8'); } catch (e) {
    STALE('S3 build-stamp', `${stampFile} — unreadable`, `could not read the build stamp (${e.message}); the artifact's provenance is unknown.`);
    return;
  }
  const m = text.match(/\b[0-9a-f]{7,40}\b/i);
  if (!m) {
    STALE('S3 build-stamp', `${stampFile} — no commit sha`,
      `the stamp contains no 7-40 hex commit id, so the artifact cannot be tied to a commit; its output is unattributable.`);
    return;
  }
  const sha = m[0];
  const head = gitOr(['rev-parse', 'HEAD'], repo);
  if (!head) {
    SKIP('S3 build-stamp', `${repo} — not a git repo`, 'cannot compare the stamp: --repo does not resolve to a git repository.');
    return;
  }
  if (gitOr(['cat-file', '-e', `${sha}^{commit}`], repo, null) === null) {
    STALE('S3 build-stamp', `${stampFile} — stamped commit ${sha} is unknown to this repo`,
      `the artifact claims to be built from ${sha}, which this repo does not contain. Whatever it is reporting on, it is not this checkout — treat every result it emits as unattributed.`);
    return;
  }
  const behind = Number(gitOr(['rev-list', '--count', `${sha}..${head}`], repo, 'NaN'));
  const ahead = Number(gitOr(['rev-list', '--count', `${head}..${sha}`], repo, 'NaN'));
  if (!Number.isFinite(behind)) {
    SKIP('S3 build-stamp', `${stampFile} — distance unmeasurable`, `could not count ${sha}..HEAD.`);
    return;
  }
  if (behind > 0) {
    STALE('S3 build-stamp', `${stampFile} — artifact is ${behind} commit(s) behind HEAD`,
      `the artifact was built from ${sha.slice(0, 12)} but HEAD is ${head.slice(0, 12)}, ${behind} commit(s) later. Every result it reports describes the OLD code and will read as a verdict on the current code. Rebuild before trusting it.`,
      { behind, stamped: sha, head });
    return;
  }
  if (Number.isFinite(ahead) && ahead > 0) {
    INFO('S3 build-stamp', `${stampFile} — artifact is ${ahead} commit(s) AHEAD of HEAD`,
      `the artifact was built from a commit not reachable from HEAD (checkout moved back, or built on another branch); results describe code this checkout does not have.`,
      { ahead, stamped: sha, head });
    return;
  }
  INFO('S3 build-stamp', `${stampFile} — level with HEAD`, `artifact built from ${sha.slice(0, 12)} == HEAD.`);
}

// ---------------------------------------------------------------------------
// S4 — a RUNNING process older than the script it was launched from.
//
// The subtlest and most valuable check. An interpreter reads its program text
// once. `bash` in particular parses a whole `while … done` block before the first
// iteration, so editing the script mid-run changes NOTHING for the running loop —
// it keeps executing the text it parsed minutes or hours ago, while `cat`ing the
// file shows the new logic. That is how a freshness gate that demonstrably exists
// on disk never ran once.
//
// The signal is a comparison, not a parse: mtime(script) > start(process) ⇒ the
// running instance predates the current file.
// ---------------------------------------------------------------------------
const SCRIPT_EXT = new Set(['.sh', '.bash', '.mjs', '.cjs', '.js', '.ts', '.py', '.rb', '.pl']);

// USER_HZ — the unit of /proc/<pid>/stat's `starttime`. Compile-time fixed at 100
// on every mainstream Linux ABI; overridable for the exotic case.
const USER_HZ = Number(process.env.STALENESS_USER_HZ || 100);
let BOOT_MS = null;
function bootMs() {
  if (BOOT_MS !== null) return BOOT_MS;
  try {
    const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
    BOOT_MS = m ? Number(m[1]) * 1000 : NaN;
  } catch { BOOT_MS = NaN; }
  return BOOT_MS;
}
/**
 * The process's start time.
 *
 * PRIMARY: `/proc/<pid>/stat` field 22 (`starttime`, USER_HZ ticks since boot)
 * plus `/proc/stat`'s `btime`. This is the kernel's immutable record. Field 2
 * (`comm`) may contain spaces and parentheses, so parse from the LAST ')'. Its
 * one weakness is that `btime` has ONE-SECOND resolution, so the result carries
 * up to ±1 s of rounding error — absorbed by FRESH_MARGIN_MS below.
 *
 * NOT `stat("/proc/<pid>").mtime`, except as a last-resort fallback. That was the
 * first implementation and it is unstable under load: it is a directory timestamp,
 * not a start record, and on a busy box it reads seconds LATE. Both directions of
 * that error are bad — reading late makes a genuinely stale process look fresh —
 * and it is exactly the confidently-wrong answer this file exists to prevent. The
 * F4 paired control caught it by failing ~1 run in 5; using the immutable value
 * removes the variance at the source rather than padding the margin around it.
 */
function procStartMs(pid) {
  const boot = bootMs();
  if (Number.isFinite(boot)) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ticks = Number(rest[19]); // overall field 22 == index 19 of fields 3..
      if (Number.isFinite(ticks)) {
        const started = boot + (ticks / USER_HZ) * 1000;
        if (started >= boot && started <= Date.now() + 1000) return started;
      }
    } catch { /* fall through to the approximation */ }
  }
  try { return fs.statSync(`/proc/${pid}`).mtimeMs; } catch { return null; }
}

/**
 * How much newer than the process the script must be before we call it stale.
 * A launcher writes a script and execs it milliseconds later, and the kernel
 * reads the text AFTER exec, so `mtime ≈ start` is normal and must never be a
 * finding. Combined with the ±1 s clock error above, 2 s is the smallest margin
 * that never produced a false positive across repeated runs of the F4 control.
 * The cost is a blind spot only for edits made within 2 s of launch.
 */
const FRESH_MARGIN_MS = Number(process.env.STALENESS_FRESH_MARGIN_MS || 2000);
function procCmdline(pid) {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
    const parts = buf.toString('utf8').split('\0').filter(Boolean);
    return parts.length ? parts : null;
  } catch { return null; }
}
function procCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}
function procPpid(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}
/** self + every ancestor. The shell that launched THIS check almost always has
 *  the pattern in its own command line (the classic `grep` self-match); it can
 *  never be stale relative to a file it is about to be told about. */
function ancestorPids() {
  const seen = new Set([String(process.pid)]);
  let cur = String(process.ppid);
  for (let hops = 0; cur && cur !== '0' && hops < 64 && !seen.has(cur); hops++) {
    seen.add(cur);
    cur = procPpid(cur);
  }
  return seen;
}
/** The script file an interpreter was launched with, resolved against its cwd. */
function scriptOf(argv, cwd) {
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('-')) continue;
    const cands = path.isAbsolute(tok) ? [tok] : [cwd ? path.resolve(cwd, tok) : null, path.resolve(tok)].filter(Boolean);
    for (const c of cands) {
      try {
        if (!fs.statSync(c).isFile()) continue;
      } catch { continue; }
      if (SCRIPT_EXT.has(path.extname(c))) return c;
    }
  }
  return null;
}

function checkProcesses(patterns) {
  if (!patterns.length) return;
  if (!hasProc()) {
    SKIP('S4 process-vs-script', 'no /proc', 'process/script freshness needs Linux /proc; skipped on this platform (never reported as passing).');
    return;
  }
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch {
    SKIP('S4 process-vs-script', '/proc unreadable', 'could not enumerate processes; skipped.');
    return;
  }
  const self = ancestorPids();

  for (const pat of patterns) {
    let re;
    try { re = new RegExp(pat); } catch (e) {
      STALE('S4 process-vs-script', `bad --process-pattern ${pat}`, `not a valid regular expression (${e.message}); no process could be checked, so absence of a finding proves nothing.`);
      continue;
    }
    let matched = 0;
    for (const pid of pids) {
      if (self.has(pid)) continue;
      const argv = procCmdline(pid);
      if (!argv) continue;
      const cmd = argv.join(' ');
      if (!re.test(cmd)) continue;
      matched++;
      const start = procStartMs(pid);
      const cwd = procCwd(pid);
      const script = scriptOf(argv, cwd);
      if (start === null) { SKIP('S4 process-vs-script', `pid ${pid} — start time unreadable`, `matched /${pat}/ but /proc/${pid} could not be stat'ed (likely another user).`); continue; }
      if (!script) {
        INFO('S4 process-vs-script', `pid ${pid} — no script file in argv`,
          `matched /${pat}/ but was not launched from a script file on disk (inline -c, or a binary), so there is no on-disk text to compare against. cmd: ${cmd.slice(0, 160)}`);
        continue;
      }
      let mt;
      try { mt = fs.statSync(script).mtimeMs; } catch { SKIP('S4 process-vs-script', `pid ${pid} — script unreadable`, `${script} could not be stat'ed.`); continue; }
      const ageSec = Math.round((mt - start) / 1000);
      if (mt > start + FRESH_MARGIN_MS) {
        STALE('S4 process-vs-script', `pid ${pid} — running text is older than ${path.basename(script)}`,
          `${script} was modified ${ageSec}s AFTER pid ${pid} started (${new Date(start).toISOString()}). The interpreter parsed the OLD text and is still executing it — any logic you added to that file (a new gate, a fixed query, extra reporting) is NOT running, while reading the file suggests it is. Restart the process to pick it up.`,
          { pid, script, startedAt: new Date(start).toISOString(), scriptMtime: new Date(mt).toISOString() });
      } else {
        INFO('S4 process-vs-script', `pid ${pid} — running text matches ${path.basename(script)}`,
          `${script} last modified ${new Date(mt).toISOString()}, before pid ${pid} started ${new Date(start).toISOString()}.`,
          { pid, script });
      }
    }
    if (matched === 0) {
      INFO('S4 process-vs-script', `/${pat}/ — no running process matched`,
        'nothing is running under this pattern, so nothing can be running stale text.');
    }
  }
}

// ---------------------------------------------------------------------------
// S5 — who actually owns a port.
//
// A gate that "reuses an already-running dev server" is only correct if that
// server belongs to THIS tree. When it belongs to a sibling worktree it serves
// that tree's code, and the gate reports its findings against your branch —
// phantom regressions that no diff explains.
// ---------------------------------------------------------------------------
function listenInodes(port) {
  const inodes = new Set();
  let sawTable = false;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    sawTable = true;
    for (const line of txt.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      if (p[3] !== '0A') continue; // TCP_LISTEN
      const lp = parseInt(String(p[1]).split(':')[1], 16);
      if (lp === port) inodes.add(`socket:[${p[9]}]`);
    }
  }
  return sawTable ? inodes : null;
}
function ownerOfSockets(want) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return []; }
  const out = [];
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (want.has(link)) { out.push({ pid, cwd: procCwd(pid), argv: procCmdline(pid) }); break; }
    }
  }
  return out;
}

function checkPorts(ports, expectRoot) {
  if (!ports.length) return;
  if (!hasProc()) {
    SKIP('S5 port-ownership', 'no /proc', 'port ownership needs Linux /proc; skipped on this platform (never reported as passing).');
    return;
  }
  for (const raw of ports) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      STALE('S5 port-ownership', `bad --port ${raw}`, 'not a valid port number; nothing was probed, so silence here proves nothing.');
      continue;
    }
    const want = listenInodes(port);
    if (want === null) { SKIP('S5 port-ownership', `port ${port} — no /proc/net/tcp`, 'socket table unreadable; skipped.'); continue; }
    if (want.size === 0) {
      INFO('S5 port-ownership', `port ${port} — nothing listening`,
        'no listener to be reused; a tool told to "reuse an existing server" here will start its own.');
      continue;
    }
    const owners = ownerOfSockets(want);
    if (!owners.length) {
      STALE('S5 port-ownership', `port ${port} — listener exists but owner is unattributable`,
        `something is listening on ${port} but no /proc entry could be matched to it (typically another user's process). It cannot be confirmed to belong to ${real(expectRoot)}; a tool that "reuses" it may be driving a foreign server and reporting its behaviour as yours.`);
      continue;
    }
    for (const o of owners) {
      const cmd = (o.argv || []).join(' ').slice(0, 160);
      if (!o.cwd) {
        STALE('S5 port-ownership', `port ${port} — owner pid ${o.pid} cwd unreadable`,
          `pid ${o.pid} owns port ${port} but its working directory cannot be read (different user), so it cannot be confirmed to belong to ${real(expectRoot)}. Reusing it risks testing a foreign tree. cmd: ${cmd}`, { pid: o.pid });
        continue;
      }
      if (under(o.cwd, expectRoot)) {
        INFO('S5 port-ownership', `port ${port} — owned by pid ${o.pid} under ${real(expectRoot)}`,
          `cwd ${real(o.cwd)} is inside the expected root; reusing this listener tests THIS tree.`, { pid: o.pid, cwd: real(o.cwd) });
      } else {
        STALE('S5 port-ownership', `port ${port} — FOREIGN owner (pid ${o.pid})`,
          `pid ${o.pid} listening on ${port} runs from ${real(o.cwd)}, which is NOT under ${real(expectRoot)}. It serves that tree's code. Any tool that reuses this port will report findings from a DIFFERENT checkout as if they were regressions in yours. cmd: ${cmd}`,
          { pid: o.pid, cwd: real(o.cwd) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const USAGE = `usage: node staleness-check.mjs --repo <path>
                                 [--port <n>]... [--expect-root <path>]
                                 [--stamp <file>]... [--stamp-repo <path>]
                                 [--process-pattern <regex>]...
                                 [--json] [--quiet]`;

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); process.exit(0); }
  if (o.bad.length) { console.error(`staleness-check: ${o.bad.join('; ')}\n${USAGE}`); process.exit(2); }
  if (!o.repo) { console.error(`staleness-check: --repo is required\n${USAGE}`); process.exit(2); }
  const repo = path.resolve(o.repo);
  if (!isDir(repo)) { console.error(`staleness-check: --repo ${repo} is not a directory`); process.exit(2); }

  const expectRoot = path.resolve(o.expectRoot || repo);
  const stampRepo = path.resolve(o.stampRepo || repo);

  const subs = checkSubmodules(repo);
  checkPinnedVsUpstream(subs);
  for (const s of o.stamps) checkStamp(path.resolve(s), stampRepo);
  checkProcesses(o.patterns);
  checkPorts(o.ports, expectRoot);

  const stale = findings.filter((f) => f.severity === 'stale');

  if (o.json) {
    console.log(JSON.stringify({ repo, expectRoot, stale: stale.length, findings }, null, 2));
    process.exit(stale.length ? 1 : 0);
  }

  if (!o.quiet) {
    for (const f of findings) {
      const tag = f.severity === 'stale' ? 'STALE' : f.severity === 'info' ? 'info ' : 'skip ';
      console.log(`${tag} [${f.check}] ${f.title} — ${f.diagnosis}`);
    }
  }
  if (stale.length) {
    if (!o.quiet) console.log(`\nstaleness-check: ${stale.length} stale finding(s) — the answers above are about something OTHER than what is on disk.`);
    process.exit(1);
  }
  if (!o.quiet) console.log('staleness-check: nothing stale.');
  process.exit(0);
}

main();
