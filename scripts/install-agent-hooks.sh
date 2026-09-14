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
    # Run UNSCOPED first. This is the common case, and it keeps behaviour
    # byte-identical for every non-epic layout: same command, same output, same code.
    # shellcheck disable=SC2086
    LC_OUT="$(node "$CHECK" --wip --repo "$TOP" $SCOPE_ARGS 2>&1)"; LC_RC=$?
    printf '%s\n' "$LC_OUT" >&2

    # ---- #564: EPIC-ROOT RESCOPE -------------------------------------------------
    # `.lifecycle/<epic>/<node>/` puts no artifacts at the epic ROOT, so auto-discovery
    # correctly refuses to grade nothing. The gate is MIS-SCOPED, not failing — but the
    # old hook turned that into a hard push failure, so every node branch was pushed with
    # --no-verify, which ALSO skipped the guard-integrity leg. Collateral nobody intended.
    #
    # THE TRIGGER IS THE GATE'S OWN SENTENCE. A genuine "a completed phase has gaps"
    # failure never prints it, so this cannot turn a red into a green.
    if [ $LC_RC -ne 0 ] && printf '%s' "$LC_OUT" | grep -q 'looks like an EPIC root'; then
      # BASE = the NEAREST fork point, not main. A node branch is cut from the EPIC
      # branch, so diffing against main attributes every node the epic ever accumulated
      # to this push (MEASURED: 45 for a one-node branch). Candidates are main + epic
      # branches only — never sibling node branches, which would resolve to nothing —
      # and never the pushed ref itself, whose merge-base with itself is degenerate.
      #
      # DELIBERATE CONSEQUENCE, measured: pushing an ALREADY-PUSHED `epic/*` branch resolves
      # against its own `origin/epic/*` ref, so it grades INCREMENTALLY — only the node(s)
      # that push actually adds. That is the useful reading for an aggregate branch, and it
      # is why an epic push does not have to be handed over every time. A node branch is
      # unaffected: `origin/<node-branch>` is NOT in the candidate set, so a node always
      # resolves against its fork point and is always re-graded, even on a code-only push.
      LC_SELF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
      LC_MB=""; LC_BEST=999999; LC_CAND=""
      for c in $(git for-each-ref --format='%(refname:short)' \
                   refs/heads/main refs/remotes/origin/main \
                   'refs/heads/epic/*' 'refs/remotes/origin/epic/*' 2>/dev/null); do
        [ "$c" = "$LC_SELF" ] && continue
        m="$(git merge-base "$c" HEAD 2>/dev/null)" || continue
        [ -n "$m" ] || continue
        d="$(git rev-list --count "$m..HEAD" 2>/dev/null)" || continue
        if [ "$d" -lt "$LC_BEST" ]; then LC_BEST="$d"; LC_MB="$m"; LC_CAND="$c"; fi
      done
      LC_NODES=""
      [ -n "$LC_MB" ] && LC_NODES="$(git diff --name-only "$LC_MB" HEAD -- .lifecycle/ 2>/dev/null \
          | awk -F/ 'NF>=4 {print $1"/"$2"/"$3}' | sort -u)"
      LC_N="$(printf '%s' "$LC_NODES" | grep -c . || true)"
      LC_MAX="${LIFECYCLE_MAX_NODES:-10}"

      if [ -z "$LC_MB" ]; then
        echo "" >&2
        echo "pre-push: epic-root layout, but no base ref (main / epic/*) was found to" >&2
        echo "          resolve this branch's node against. Pass --dir <node-subdir> yourself." >&2
      elif [ "$LC_N" = "0" ]; then
        # Nothing under the epic root differs from the fork point, so this push adds no
        # lifecycle artifact to certify — the state it carries is its base's, already
        # gated when the base was pushed. Say so; do not fail a push that changes nothing.
        echo "" >&2
        echo "pre-push: epic-root layout — this branch changes NO node artifacts vs $LC_CAND," >&2
        echo "          so there is nothing new for the lifecycle gate to certify. Passing this" >&2
        echo "          leg; guard-integrity above still ran." >&2
        LC_RC=0
      elif [ "$LC_N" -le "$LC_MAX" ]; then
        echo "" >&2
        echo "pre-push: epic-root layout — re-running the gate SCOPED to this branch's $LC_N node(s)," >&2
        echo "          resolved against $LC_CAND:" >&2
        LC_RC=0
        for d in $LC_NODES; do
          echo "          --dir $d" >&2
          # shellcheck disable=SC2086
          node "$CHECK" --wip --repo "$TOP" --dir "$d" $SCOPE_ARGS || LC_RC=1
        done
      else
        echo "" >&2
        echo "pre-push: epic-root layout, but this push maps to $LC_N node directories (cap $LC_MAX)." >&2
        echo "          That is an epic AGGREGATE branch, not one node's work: it is certified by" >&2
        echo "          the merge-gate at merge time, not by a per-push scan of every peer's" >&2
        echo "          work-in-progress (which would fail your push for someone else's WIP)." >&2
        echo "          Grade one node yourself:" >&2
        echo "              node $CHECK --wip --repo $TOP --dir .lifecycle/<epic>/<node>" >&2
        echo "          (raise the cap deliberately with LIFECYCLE_MAX_NODES=<n> if you mean to.)" >&2
      fi
    fi
    # ---- end #564 ----------------------------------------------------------------
    if [ $LC_RC -ne 0 ]; then
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
        echo "          (#564) An EPIC-ROOT layout is auto-rescoped to this branch's node(s), so if" >&2
        echo "          you still see an epic-root message above, the rescope could not resolve them" >&2
        echo "          from this branch's diff — pass --dir <node-subdir> yourself." >&2
        echo "" >&2
        echo "          If you are an AGENT: stop here. Report this output verbatim and ask the" >&2
        echo "          human to push, or to authorise the bypass explicitly." >&2
        echo "          If you are the HUMAN and you accept the consequences:" >&2
        echo "              I_MIGHT_GET_FIRED_FOR_THIS=1 git push ..." >&2
        echo "          (that keeps every OTHER check running, unlike --no-verify)" >&2
        exit 1
      fi
    fi
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
