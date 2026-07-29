#!/usr/bin/env bash
# Share compiled Rust dependencies across every worktree on this machine.
#
#   enable-build-cache.sh            # install + enable (idempotent)
#   enable-build-cache.sh --check    # report status, change nothing
#   enable-build-cache.sh --disable  # remove the wrapper, keep the cache
#
# THE PROBLEM
#   Each worktree keeps its own target/. A fresh one holds 0 compiled artifacts
#   where a warm one holds ~10.6k, so every new worktree recompiles the entire
#   dependency graph. On a fleet of concurrent feature worktrees that is the
#   single largest source of dead wall-clock.
#
# WHY NOT A SHARED CARGO_TARGET_DIR
#   Cargo takes an EXCLUSIVE LOCK per target dir. Pointing N worktrees at one
#   target dir serializes their builds — trading wall-clock for disk, which is
#   backwards on a box with a large volume and many concurrent agents.
#
# WHY SCCACHE IS THE RIGHT SHAPE
#   It caches individual rustc invocations in one shared store keyed on the
#   compilation INPUTS (not on paths), so N worktrees compile an identical
#   dependency graph once. Per-worktree target dirs stay independent, so nothing
#   serializes.
#
# WHY IT DOES NOT COST YOU INCREMENTAL COMPILATION
#   Cargo passes `-C incremental` only for the workspace crates you are editing,
#   and sccache declines to cache those. Dependencies build without incremental,
#   so they are exactly what gets cached — which is the whole cold-start cost.
#   MEASURED on a live build: Rust hit rate 61.4% (3458 hit / 2174 miss), with
#   `incremental` accounting for only 328 non-cacheable calls. So the dependency
#   graph — the part that dominates a fresh worktree — really is being reused.
#
# SCCACHE_BASEDIR — THE CROSS-WORKTREE SETTING PEOPLE MISS
#   Without it sccache does NOT normalise absolute paths, so the same C file
#   compiled under /repo/wt-a/... and /repo/wt-b/... hashes to DIFFERENT keys and
#   misses. That is the exact shape of a per-worktree fleet, and of any gate that
#   builds in a fresh staging tree. Symptom to look for in `--show-stats`:
#
#       Cache hits rate (Rust)   61.40 %     <- fine
#       Cache hits rate (C/C++)  28.38 %     <- the tell
#       Base directories         (none)      <- the cause
#
#   Setting it to the COMMON ANCESTOR of every worktree lets them share the
#   native objects. Rust is affected less (sccache hashes preprocessed input, so
#   paths leak in mainly via debug info and build scripts) — C/C++ is where the
#   win is, and C/C++ is what the expensive vendored crates are.
#
#   ⚠️ IT ONLY WORKS IF EVERY BUILD TREE IS ACTUALLY UNDER IT. A basedir of
#   /data/pbya/ziee does nothing for a tree in /tmp — the paths never normalise,
#   so the keys never match. This bit merge-gate.mjs, which staged its build in
#   the system temp dir; it now stages BESIDE THE REPO for exactly this reason.
#   Before trusting a basedir, check that the gate/CI staging paths sit under it.
#
#   ⚠️ SETTING IT INVALIDATES THE EXISTING CACHE. Keys are computed from the
#   (now rewritten) paths, so entries written without a basedir will never be
#   hit again. Expect ONE full-miss build, and expect the store to roughly
#   double before the LRU evicts the old generation. Do it when the box is quiet.
#
# WHAT THE EXPENSIVE NATIVE BUILDS ACTUALLY ARE (ziee, 2026-07)
#   `aws-lc-sys` (~1500 C files) is the dominant one, reached via
#   rustls <- reqwest / hyper-rustls / ngrok. Also rquickjs-sys (QuickJS),
#   ring, zstd-sys, libseccomp-sys, pdfium-render. Two notes worth carrying:
#     • `aws-lc-fips-sys` appears in Cargo.lock but has NO reverse dependency —
#       it is an optional feature of aws-lc-rs and is never compiled. Do not
#       "optimise" it away; it costs nothing.
#     • Swapping rustls onto the `ring` backend WOULD drop aws-lc-sys entirely,
#       but that changes the TLS crypto provider for the whole app. It is a real
#       lever and a real risk — an owner decision, not a build-cache tweak.
#
# WHY THIS IS MACHINE-LEVEL AND NOT COMMITTED TO THE APP REPO
#   A tracked `[build] rustc-wrapper` in the repo's .cargo/config.toml would hard
#   -fail every clone and CI runner that lacks sccache (cargo errors when the
#   wrapper binary is missing). agent-kit ships the MECHANISM; each machine opts
#   in once, here.
set -euo pipefail

MODE=${1:-enable}
CARGO_CFG="$HOME/.cargo/config.toml"
SCCACHE_BIN="$HOME/.cargo/bin/sccache"
# Default the store to the big volume the worktrees live on, not $HOME.
CACHE_DIR=${SCCACHE_DIR:-/data/pbya/ziee/.sccache}
CACHE_SIZE=${SCCACHE_CACHE_SIZE:-200G}
# The COMMON ANCESTOR of every worktree on this box. sccache rewrites absolute
# paths under it to relative ones, so the same native object compiled in two
# different worktrees hashes to ONE key. Without this, every new worktree
# re-compiles the whole C/C++ surface (aws-lc-sys alone is ~1500 files).
BASE_DIR=${SCCACHE_BASEDIR:-/data/pbya/ziee}

status() {
  echo "sccache binary : $([ -x "$SCCACHE_BIN" ] && "$SCCACHE_BIN" --version || echo 'NOT INSTALLED')"
  if grep -q '^rustc-wrapper' "$CARGO_CFG" 2>/dev/null; then
    echo "wrapper        : ENABLED  ($(grep '^rustc-wrapper' "$CARGO_CFG"))"
  else
    echo "wrapper        : disabled (no rustc-wrapper in $CARGO_CFG)"
  fi
  if grep -q '^SCCACHE_BASEDIR' "$CARGO_CFG" 2>/dev/null; then
    echo "basedir        : $(grep '^SCCACHE_BASEDIR' "$CARGO_CFG")"
  else
    echo "basedir        : NOT SET  <- cross-worktree C/C++ objects will MISS"
  fi
  [ -x "$SCCACHE_BIN" ] && "$SCCACHE_BIN" --show-stats 2>/dev/null | grep -iE 'cache hits rate|cache misses |cache location|max cache size|base directories' || true
}

case "$MODE" in
  --check) status; exit 0 ;;
  --disable)
    if [ -f "$CARGO_CFG" ]; then
      sed -i.bak '/^rustc-wrapper/d' "$CARGO_CFG"
      echo "wrapper removed (backup at $CARGO_CFG.bak); cache store left intact at $CACHE_DIR"
    fi
    exit 0 ;;
esac

# 1. install
if [ ! -x "$SCCACHE_BIN" ]; then
  echo "installing sccache (a few minutes) …"
  cargo install sccache --locked
fi

# 2. ⚠️ THE STAMPEDE WARNING — this is the part people get wrong.
# Adding a rustc-wrapper CHANGES THE RUSTC COMMAND LINE, which invalidates every
# existing fingerprint. Each already-warm worktree therefore does ONE full
# rebuild the next time it builds. Enabling this while a fleet of agents is
# mid-build converts a speedup into a stampede — do it when the box is quiet.
building=$(pgrep -fc 'cargo (build|check|test)' 2>/dev/null || echo 0)
if [ "${building:-0}" -gt 0 ]; then
  echo "⚠️  $building cargo build(s) are running right now."
  echo "    Enabling the wrapper invalidates their fingerprints and forces a full"
  echo "    rebuild in every warm worktree. Re-run this when the box is quiet,"
  echo "    or pass FORCE=1 if you accept that."
  [ "${FORCE:-0}" = "1" ] || exit 1
fi

mkdir -p "$CACHE_DIR"
touch "$CARGO_CFG"

# 3. wire it up (idempotent: never append a second [build] or a duplicate key)
grep -q '^\[build\]' "$CARGO_CFG" || printf '\n[build]\n' >> "$CARGO_CFG"
if grep -q '^rustc-wrapper' "$CARGO_CFG"; then
  sed -i "s|^rustc-wrapper.*|rustc-wrapper = \"$SCCACHE_BIN\"|" "$CARGO_CFG"
else
  sed -i "0,/^\[build\]/s||[build]\nrustc-wrapper = \"$SCCACHE_BIN\"|" "$CARGO_CFG"
fi
grep -q '^\[env\]' "$CARGO_CFG" || printf '\n[env]\n' >> "$CARGO_CFG"
grep -q '^SCCACHE_DIR' "$CARGO_CFG" || sed -i "0,/^\[env\]/s||[env]\nSCCACHE_DIR = \"$CACHE_DIR\"\nSCCACHE_CACHE_SIZE = \"$CACHE_SIZE\"|" "$CARGO_CFG"
if grep -q '^SCCACHE_BASEDIR' "$CARGO_CFG"; then
  sed -i "s|^SCCACHE_BASEDIR.*|SCCACHE_BASEDIR = \"$BASE_DIR\"|" "$CARGO_CFG"
else
  sed -i "0,/^\[env\]/s||[env]\nSCCACHE_BASEDIR = \"$BASE_DIR\"|" "$CARGO_CFG"
fi

echo "=== build cache enabled ==="
status
echo
echo "First build after enabling is a full rebuild (fingerprints changed) and"
echo "populates the cache. Every worktree created afterwards reuses it."
