#!/usr/bin/env bash
# Create a feature worktree that is READY TO BUILD.
#
# preflight.sh CHECKS these preconditions and tells you to fix them by hand.
# This script DOES them, because doing them by hand is how a worktree ends up
# panicking on a missing hub-seed twenty minutes into a build.
#
#   new-worktree.sh <path> <branch> [base-ref]
#
# What it sets up, and why each one exists:
#   1. the worktree + submodules      — a bare `worktree add` leaves sdk/ empty
#   2. node_modules symlinks (x3)     — npm workspaces hoist to the REPO ROOT; a
#                                       fresh worktree has none, and `npm install`
#                                       per worktree costs minutes and disk for an
#                                       identical tree
#   3. binaries/hub-seed              — build.rs PANICS without it (deliberately:
#                                       shipping an empty seed silently degrades
#                                       the hub UI). It is manifest-relative, so a
#                                       new worktree never inherits it.
#
# What it deliberately does NOT do: copy `target/`. Cargo fingerprints embed
# absolute paths, so a copied target dir from another worktree is partially
# invalidated and rebuilds anyway — with the added risk of stale artifacts. The
# right cross-worktree build cache is sccache (see SCCACHE below), which keys on
# compilation inputs rather than on paths.
set -euo pipefail

WT_PATH=${1:?usage: new-worktree.sh <path> <branch> [base-ref]}
BRANCH=${2:?usage: new-worktree.sh <path> <branch> [base-ref]}
BASE=${3:-origin/main}

# The repo this script lives in (agent-kit is a submodule of the consumer repo).
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

say() { printf '  %s\n' "$*"; }

echo "=== new worktree: $BRANCH at $WT_PATH (from $BASE) ==="

git -C "$REPO" fetch origin "${BASE#origin/}" -q 2>/dev/null || true
git -C "$REPO" worktree add "$WT_PATH" -b "$BRANCH" "$BASE"
git -C "$WT_PATH" submodule update --init --recursive -q
say "worktree + submodules ready"

# 2. node_modules — root + both UI workspaces, symlinked at the SAME relative
#    paths npm expects. A symlink (not a copy) so a dep bump in the main repo is
#    picked up everywhere.
for d in "" "src-app/ui" "src-app/desktop/ui"; do
  src="$REPO/${d:+$d/}node_modules"
  dst="$WT_PATH/${d:+$d/}node_modules"
  if [ -d "$src" ] && [ ! -e "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    say "linked ${d:-<root>}/node_modules"
  fi
done

# 3. hub-seed — hardlink the tree so it costs no disk and no network. Falls back
#    to a copy across filesystems.
SEED_SRC="$REPO/src-app/server/binaries/hub-seed"
SEED_DST="$WT_PATH/src-app/server/binaries/hub-seed"
if [ -d "$SEED_SRC" ] && [ ! -d "$SEED_DST" ]; then
  mkdir -p "$(dirname "$SEED_DST")"
  cp -al "$SEED_SRC" "$SEED_DST" 2>/dev/null || cp -r "$SEED_SRC" "$SEED_DST"
  say "staged hub-seed ($(du -sh "$SEED_DST" 2>/dev/null | cut -f1))"
elif [ ! -d "$SEED_SRC" ]; then
  say "WARNING: no hub-seed in $REPO — the first build will fetch it (or panic offline)"
fi

# 4. Report the build-cache posture rather than silently assuming it.
if command -v sccache >/dev/null 2>&1; then
  if [ -n "${RUSTC_WRAPPER:-}" ]; then
    say "sccache active — dependency compiles are shared across worktrees"
  else
    say "sccache installed but RUSTC_WRAPPER unset — see SCCACHE note in this script"
  fi
else
  say "sccache NOT installed — this worktree will recompile the whole dependency"
  say "graph from scratch (~10.6k artifacts). See SCCACHE note in this script."
fi

echo "=== ready: cd $WT_PATH ==="

# ---------------------------------------------------------------------------
# SCCACHE — sharing compiled dependencies across worktrees
#
# Every worktree keeps its OWN target/ (they must: cargo takes an exclusive lock
# per target dir, so a shared CARGO_TARGET_DIR would serialize a fleet of
# concurrent worktrees — trading wall-clock for disk on a box where disk is not
# the constraint). sccache instead caches individual rustc invocations in one
# shared store, keyed on the compilation inputs, so N worktrees compile an
# identical dependency graph ONCE.
#
#   cargo install sccache --locked
#   # then, in ~/.cargo/config.toml:
#   #   [build]
#   #   rustc-wrapper = "/home/<user>/.cargo/bin/sccache"
#   export SCCACHE_DIR=/data/<...>/sccache      # put it on the big volume
#   export SCCACHE_CACHE_SIZE=200G
#
# Why this does NOT cost you incremental compilation: cargo passes
# `-C incremental` only for the workspace crates you are editing, and sccache
# declines to cache those. Dependencies are built without incremental, so they
# are exactly what gets cached — which is the entire cold-start cost.
#
# ⚠️ FLIP IT AT A QUIET MOMENT. Adding a rustc-wrapper changes the rustc command
# line, which invalidates existing fingerprints — every ALREADY-WARM worktree
# does one full rebuild the first time it builds afterwards. Enabling this while
# a fleet of agents is mid-build converts a speedup into a stampede.
# ---------------------------------------------------------------------------
