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

status() {
  echo "sccache binary : $([ -x "$SCCACHE_BIN" ] && "$SCCACHE_BIN" --version || echo 'NOT INSTALLED')"
  if grep -q '^rustc-wrapper' "$CARGO_CFG" 2>/dev/null; then
    echo "wrapper        : ENABLED  ($(grep '^rustc-wrapper' "$CARGO_CFG"))"
  else
    echo "wrapper        : disabled (no rustc-wrapper in $CARGO_CFG)"
  fi
  [ -x "$SCCACHE_BIN" ] && "$SCCACHE_BIN" --show-stats 2>/dev/null | grep -iE 'cache hits|cache misses|cache location|max cache size' || true
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

echo "=== build cache enabled ==="
status
echo
echo "First build after enabling is a full rebuild (fingerprints changed) and"
echo "populates the cache. Every worktree created afterwards reuses it."
