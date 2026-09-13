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
    echo "pre-push: merge-gate --verify-head FAILED — fix before pushing to main." >&2
    echo "          There is NO bypass for this leg. I_MIGHT_GET_FIRED_FOR_THIS does not apply" >&2
    echo "          here: main is the gated branch, and this check is the gate." >&2
    echo "          Do NOT reach for 'git push --no-verify' either — a bypass is the human's to" >&2
    echo "          grant, never yours, and that flag skips EVERY leg of this hook, not this one." >&2
    echo "          Report the output above verbatim and hand the push to the human." >&2
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
      # The sanctioned escape is an env var, NOT --no-verify. The difference matters:
      # --no-verify makes git skip this hook ENTIRELY, so the pinned-guard integrity
      # leg above is skipped too — collateral nobody intends. This var bypasses only
      # THIS leg, leaves every other check running, and names itself loudly in any
      # transcript or shell history that contains it.
      if [ -n "${I_MIGHT_GET_FIRED_FOR_THIS:-}" ]; then
        echo "" >&2
        echo "  ########################################################################" >&2
        echo "  #  GATE BYPASSED ON PURPOSE — I_MIGHT_GET_FIRED_FOR_THIS is set.       #" >&2
        echo "  #                                                                      #" >&2
        echo "  #  A COMPLETED lifecycle phase has gaps and this push is going out     #" >&2
        echo "  #  anyway. This is a HUMAN's decision to make. If you are an agent and #" >&2
        echo "  #  you set this variable yourself, you have just granted yourself a    #" >&2
        echo "  #  permission that was not yours — stop, and tell the human.           #" >&2
        echo "  #                                                                      #" >&2
        echo "  #  Name every failing gate, and why, in the commit body.               #" >&2
        echo "  ########################################################################" >&2
        echo "    bypassed by : $(git config user.name 2>/dev/null || echo unknown) <$(git config user.email 2>/dev/null || echo unknown)>" >&2
        echo "    at          : $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
        echo "    branch      : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')  head: $(git rev-parse --short HEAD 2>/dev/null || echo '?')" >&2
        echo "" >&2
      else
        echo "pre-push: lifecycle-check --wip FAILED — a COMPLETED phase has gaps (the phase in progress is exempt)." >&2
        echo "          Fix the gaps above." >&2
        echo "" >&2
        echo "          'git push --no-verify' is the WRONG escape for THIS failure: the gate ran" >&2
        echo "          and found gaps, and that flag would skip this hook ENTIRELY — including the" >&2
        echo "          pinned-guard integrity check that is currently passing. (--no-verify is the" >&2
        echo "          right tool when the hook CANNOT RUN at all; that is not the case here.)" >&2
        echo "          Either way a bypass is the HUMAN's to grant, not yours." >&2
        echo "" >&2
        echo "          If the message above says this looks like an EPIC ROOT, the gate is" >&2
        echo "          MIS-SCOPED rather than failing: re-run with --dir <node-subdir> or set" >&2
        echo "          LIFECYCLE_SCOPE=<name>, and report the hook's invocation as a defect." >&2
        echo "" >&2
        echo "          If you are an AGENT: stop here. Report this output verbatim and ask the" >&2
        echo "          human to push, or to authorise the bypass explicitly." >&2
        echo "          If you are the HUMAN and you accept the consequences:" >&2
        echo "              I_MIGHT_GET_FIRED_FOR_THIS=1 git push ..." >&2
        echo "          (that keeps every OTHER check running, unlike --no-verify)" >&2
        exit 1
      fi
    }
  else
    echo "pre-push: .lifecycle/ present but lifecycle-check.mjs missing — the gate CANNOT RUN." >&2
    echo "          Most often this is a fresh 'git worktree add', which initialises NO submodules," >&2
    echo "          so a gate symlinked into one simply is not there. Fix the cause first:" >&2
    echo "              git submodule update --init --recursive" >&2
    echo "          (or run scripts/install-agent-hooks.sh from a clone with .claude/lifecycle committed)." >&2
    echo "" >&2
    echo "          I_MIGHT_GET_FIRED_FOR_THIS does NOT apply here — it bypasses a gate that RAN" >&2
    echo "          and failed, and this gate never ran. If the cause genuinely cannot be fixed," >&2
    echo "          'git push --no-verify' is the correct tool for THIS case — and it is still the" >&2
    echo "          HUMAN's call. If you are an agent: say the gate is absent and why, and ask." >&2
    exit 1
  fi
fi
exit 0
HOOKEOF
chmod +x "$HOOK"
echo "installed: $HOOK"
