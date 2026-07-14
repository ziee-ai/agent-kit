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
    node "$CHECK" --all --repo "$TOP" || {
      echo "pre-push: lifecycle-check --all FAILED — fix the gaps above before pushing." >&2
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
