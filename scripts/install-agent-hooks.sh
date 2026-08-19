#!/usr/bin/env bash
# Installs the feature-lifecycle pre-push hook into this clone's shared git hooks.
# The hook only enforces on branches whose worktree contains a .lifecycle/ dir;
# all other pushes pass through untouched. Idempotent.
set -euo pipefail
ROOT="$(git rev-parse --git-common-dir)"
HOOK="$ROOT/hooks/pre-push"
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# feature-lifecycle enforcement. Runs under bash on Linux, macOS, and Windows
# git-bash (git invokes hooks through that same bash), so it stays portable.
TOP="$(git rev-parse --show-toplevel)"
MG="$TOP/.claude/lifecycle/merge-gate.mjs"

# Classify the push: is EVERY updated ref main? (the full per-branch lifecycle
# gate can't validate a merge-into-main context — the diff-vs-main reconciliation
# is meaningless there — so main gets the fast HEAD-invariants guard instead.)
ONLY_MAIN=1
PUSHES_MAIN=0
MAIN_SHA=""
while read -r _local lsha remote _rsha; do
  if [ "$remote" = "refs/heads/main" ]; then PUSHES_MAIN=1; MAIN_SHA="$lsha"; else ONLY_MAIN=0; fi
done

# A push to main runs merge-gate --verify-head: the collides-with-main class the
# per-branch gate cannot see — no leaked .lifecycle/ artifacts, no duplicate
# migration prefixes. Fast (no build, no worktree). The FULL merge-gate
# (clean-build + regen-parity) is the orchestrator's pre-merge step, not a hook.
if [ "$PUSHES_MAIN" = "1" ] && [ -f "$MG" ]; then
  REV="${MAIN_SHA:-HEAD}"
  # a zero sha (branch deletion) has nothing to verify
  case "$REV" in *[!0]*) : ;; *) REV="HEAD" ;; esac
  node "$MG" --verify-head --rev "$REV" --repo "$TOP" || {
    echo "pre-push: merge-gate --verify-head FAILED — fix before pushing to main (or: git push --no-verify)." >&2
    exit 1
  }
fi
if [ "$ONLY_MAIN" = "1" ]; then exit 0; fi

if [ -d "$TOP/.lifecycle" ]; then
  CHECK="$TOP/.claude/lifecycle/lifecycle-check.mjs"
  if [ -f "$CHECK" ]; then
    # MID-ROUND pushes run --wip: the phases the branch has COMPLETED must be green, and the
    # one it is currently working may be in progress. --all demanded a state no mid-round
    # push can be in (scaffolding the next phase's artifact makes that phase `present`, and a
    # present phase with gaps is fatal), so every mid-round push used --no-verify. A gate
    # that always fails trains people to bypass it, and then it is absent on the day it would
    # have caught something. --wip lets an honest mid-round push pass honestly; it still
    # fails a regression in a completed phase and an unresolved drift, and once every phase
    # has artifacts it demands all nine exactly like --all.
    #
    # The whole-feature --all gate remains the pre-merge step (and the merge-gate path
    # above); this hook is not where a feature is certified complete.
    #
    # --scope: set LIFECYCLE_SCOPE=<name> so a stage gates on its OWN artifacts and a peer
    # stage's open round cannot fail this owner's push.
    SCOPE_ARGS=""
    [ -n "${LIFECYCLE_SCOPE:-}" ] && SCOPE_ARGS="--scope $LIFECYCLE_SCOPE"
    # shellcheck disable=SC2086
    node "$CHECK" --wip --repo "$TOP" $SCOPE_ARGS || {
      echo "pre-push: lifecycle-check --wip FAILED — a COMPLETED phase has gaps (the phase in progress is exempt)." >&2
      echo "          Fix the gaps above, or push a genuine WIP checkpoint with --no-verify naming each failing gate in the commit body." >&2
      exit 1
    }
  else
    echo "pre-push: .lifecycle/ present but lifecycle-check.mjs missing — run scripts/install-agent-hooks.sh from a clone with .claude/lifecycle committed." >&2
    exit 1
  fi
fi
exit 0
HOOKEOF
chmod +x "$HOOK"
echo "installed: $HOOK"
