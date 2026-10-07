#!/usr/bin/env bash
# Installs the feature-lifecycle pre-push hook into this clone's shared git hooks.
# The hook only enforces on branches whose worktree contains a .lifecycle/ dir;
# all other pushes pass through untouched. Idempotent.
# TEMP (RED proof): the old nested-epic descent, exactly-one-subdirectory only.
set -euo pipefail
ROOT="$(git rev-parse --git-common-dir)"
HOOK="$ROOT/hooks/pre-push"
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# feature-lifecycle enforcement. Runs under bash on Linux, macOS, and Windows
# git-bash (git invokes hooks through that same bash), so it stays portable.
TOP="$(git rev-parse --show-toplevel)"
MG="$TOP/.claude/lifecycle/merge-gate.mjs"

ONLY_MAIN=1
PUSHES_MAIN=0
MAIN_SHA=""
while read -r _local lsha remote _rsha; do
  if [ "$remote" = "refs/heads/main" ]; then PUSHES_MAIN=1; MAIN_SHA="$lsha"; else ONLY_MAIN=0; fi
done
if [ "$PUSHES_MAIN" = "1" ] && [ -f "$MG" ]; then
  REV="${MAIN_SHA:-HEAD}"
  case "$REV" in *[!0]*) : ;; *) REV="HEAD" ;; esac
  node "$MG" --verify-head --rev "$REV" --repo "$TOP" || {
    echo "pre-push: merge-gate --verify-head FAILED — fix before pushing to main." >&2
    exit 1
  }
fi
if [ "$ONLY_MAIN" = "1" ]; then exit 0; fi

if [ -d "$TOP/.lifecycle" ]; then
  CHECK="$TOP/.claude/lifecycle/lifecycle-check.mjs"
  if [ -f "$CHECK" ]; then
    # TEMP: the old nested-epic descent — descend ONLY when the sole .lifecycle/
    # dir carries no artifacts of its own AND EXACTLY ONE subdirectory does.
    # (This is the logic #537 says still dies on a real multi-node epic root.)
    DIR_ARGS=""
    _lc_has_artifacts() {
      for _f in PLAN.md PLAN_AUDIT.md DESIGN_FIDELITY.md TESTS.md DECISIONS.md \
                LEDGER.jsonl AUDIT_COVERAGE.tsv TEST_RESULTS.md HUMAN_FEEDBACK.md; do
        [ -f "$1/$_f" ] && return 0
      done
      for _f in "$1"/DRIFT-*.md "$1"/FIX_ROUND-*.md; do [ -f "$_f" ] && return 0; done
      return 1
    }
    _lc_n=0; _lc_sole=""
    for _d in "$TOP/.lifecycle"/*/; do
      [ -d "$_d" ] || continue
      _lc_n=$((_lc_n + 1)); _lc_sole="${_d%/}"
    done
    if [ "$_lc_n" = "1" ] && ! _lc_has_artifacts "$_lc_sole"; then
      _lc_m=0; _lc_item=""
      for _d in "$_lc_sole"/*/; do
        [ -d "$_d" ] || continue
        if _lc_has_artifacts "${_d%/}"; then _lc_m=$((_lc_m + 1)); _lc_item="${_d%/}"; fi
      done
      if [ "$_lc_m" = "1" ]; then
        DIR_ARGS="--dir $_lc_item"
        echo "pre-push: nested epic layout — grading $_lc_item" >&2
      fi
    fi
    SCOPE_ARGS=""
    [ -n "${LIFECYCLE_SCOPE:-}" ] && SCOPE_ARGS="--scope $LIFECYCLE_SCOPE"
    # shellcheck disable=SC2086
    node "$CHECK" --wip --repo "$TOP" $SCOPE_ARGS $DIR_ARGS || {
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
