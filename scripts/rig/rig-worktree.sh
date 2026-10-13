# rig-worktree.sh — sourced by rig-pregate.sh / rerun-failures.sh / auto-merge.sh (the delta). rig_worktree_at <sha> <logdir>: put the
# ONE persistent rig worktree ($W, default $RIG_WORKTREE, default $RIG_STATE/rig-wt) at <sha>, detached and clean, submodules
# updated. Created from $RIG_REPO once (then $RIG_WORKTREE_INIT_CMD, if set, runs in it once); $RIG_DEPS_CMD (default
# `npm install --no-audit --no-fund`) runs only when $RIG_DEPS_LOCKFILE (default package-lock.json) exists in the tree and changed,
# or $RIG_DEPS_DIR (default node_modules) is missing. RIG_DEPS_CMD="" disables the deps step. Never pushes.
# Tip: an app whose test lock gives gate runs priority by path can point RIG_WORKTREE at such a path.
rig_worktree_at() {
  local sha=$1 log=$2 lock_before lockf=${RIG_DEPS_LOCKFILE:-package-lock.json} depsd=${RIG_DEPS_DIR:-node_modules}
  local primary=${RIG_REPO:?rig_worktree_at: RIG_REPO is required}
  W=${W:-${RIG_WORKTREE:-${RIG_STATE:?rig_worktree_at: RIG_STATE is required}/rig-wt}}
  mkdir -p "$log"
  git -C "$primary" fetch -q origin 2>/dev/null
  if [ ! -e "$W/.git" ]; then
    mkdir -p "$(dirname "$W")"
    git -C "$primary" worktree add -q --detach "$W" "$sha" || { echo "rig worktree: add failed" >&2; return 1; }
    if [ -n "${RIG_WORKTREE_INIT_CMD:-}" ]; then
      (cd "$W" && ${RIG_RUN_WRAPPER:-bash -c} "$RIG_WORKTREE_INIT_CMD") > "$log/worktree-init.log" 2>&1 || { echo "rig worktree: init failed ($log/worktree-init.log)" >&2; return 1; }
    fi
  fi
  cd "$W" || return 1
  lock_before=$(git hash-object "$lockf" 2>/dev/null)
  git checkout -q -f --detach "$sha" && git clean -fdq && git submodule update -q --init --recursive || { echo "rig worktree: checkout $sha failed" >&2; return 1; }
  local deps=${RIG_DEPS_CMD-npm install --no-audit --no-fund}
  if [ -n "$deps" ] && [ -f "$lockf" ] && { [ "$(git hash-object "$lockf" 2>/dev/null)" != "$lock_before" ] || [ ! -d "$depsd" ]; }; then
    ${RIG_RUN_WRAPPER:-bash -c} "$deps" > "$log/deps-install.log" 2>&1 || { echo "rig worktree: deps install failed ($log/deps-install.log)" >&2; return 1; }
  fi
}
