# selftest-lib.sh — shared scaffolding for the feature-lifecycle self-tests.
# Sourced by selftest.sh (flow gates) and selftest-hardening.sh (A-checks +
# merge-gate + preflight). Pure POSIX-ish bash; runs on Linux, macOS, and
# Windows git-bash (no GNU-only flags; git + node the only hard deps).
#
# Provides: PASS/FAIL counters, assert_exit_cmd, write_common, new_repo.
#
# FIXTURE CONTRACT (read before editing a PLAN.md/TESTS.md fixture)
# -----------------------------------------------------------------
# Every fixture is a COMPLETE, VALID worked example of the lifecycle — not a
# string that merely satisfies a regex. Two gates bind the artifacts together
# and are easy to break by accident when editing one file in isolation:
#
#   • phase 1 requires PLAN.md to carry a `## Design source` section and an
#     `## Invariants` section with >=1 `- **INV-N**: <text>` line.
#   • phase 2 requires DESIGN_FIDELITY.md to carry exactly one
#     `- **INV-N** — fidelity: UPHELD|AT-RISK|DROPPED — <how>` line PER PLAN
#     invariant, and no verdict for an INV the PLAN does not declare.
#   • phase 3 requires each PLAN invariant to be pinned by >=1 TESTS.md line
#     tagged BOTH `[acceptance]` and `[invariant: INV-N]`.
#   • phase 8 requires every `[acceptance]` test to be recorded PASS.
#
# So: every fixture PLAN.md declares exactly ONE invariant, `INV-1`; every
# fixture TESTS.md tags exactly one test `[acceptance] [invariant: INV-1]`;
# write_common emits the matching DESIGN_FIDELITY.md verdict. If you rewrite a
# fixture's PLAN.md or TESTS.md mid-scenario (several negative cases do), carry
# those markers across — otherwise the scenario fails for the WRONG reason and
# the gate it is supposed to prove is no longer proven.

PASS=0
FAIL=0

note() { printf '  %s\n' "$*"; }

# assert_exit_cmd <expected 0|1> <label> -- <command...>
# Runs the command, captures its exit code, normalizes any nonzero to 1 (the
# validators use exit 1 for a gate failure, 2 for a fatal usage error — both
# are "did not pass"), and compares to <expected>.
assert_exit_cmd() {
  local want="$1"; local label="$2"; shift 2; [ "${1:-}" = "--" ] && shift
  "$@" >/tmp/lc-selftest.out 2>&1
  local got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s (exit %s)\n' "$label" "$got"
  else
    FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (want exit %s, got %s)\n' "$label" "$want" "$got"
    sed 's/^/        | /' /tmp/lc-selftest.out
  fi
}

# ---------------------------------------------------------------------------
# artifact writers (a valid set of phases 2,4,5,6,7,9 artifacts)
# ---------------------------------------------------------------------------
# write_common <feature-dir> <src-file-path> <src-line-count> [invariant-ids...]
# Writes PLAN_AUDIT / DESIGN_FIDELITY / DECISIONS / DRIFT-1 / LEDGER /
# AUDIT_COVERAGE / FIX_ROUND / HUMAN_FEEDBACK so the diff's single source file
# is covered by 3 angles over lines 1..N.
#
# The caller's PLAN.md owns phase 1 (it names the design source + the
# invariants); write_common writes the phase-2 fidelity verdict for each of
# them. `invariant-ids` defaults to `INV-1` — the id every fixture PLAN.md
# declares. Pass explicit ids only if a fixture declares a different set; a
# verdict for an INV the PLAN does not declare FAILS phase 2 (by design).
write_common() {
  local d="$1" srcfile="$2" srclines="$3"; shift 3
  local invs; invs="${*:-INV-1}"
  cat > "$d/PLAN_AUDIT.md" <<'EOF'
# PLAN_AUDIT
## Breakage risk
None — additive.
## Pattern conformance
Mirrors the reference module.
## Migration collisions
No migration.
## OpenAPI regen
Not required.

- **ITEM-1** — verdict: PASS — mirrors the reference module; additive only.
EOF
  # phase 2 design-fidelity: one verdict per PLAN invariant. UPHELD because the
  # invariant is realized directly by the single touched source file and pinned
  # by the [acceptance] test the fixture's TESTS.md enumerates.
  {
    printf '# DESIGN_FIDELITY\n'
    printf 'How the plan upholds each non-negotiable lifted from the design source named in PLAN.md.\n\n'
    for i in $invs; do
      printf -- '- **%s** — fidelity: UPHELD — realized directly by `%s`; pinned by the [acceptance] test tagged [invariant: %s] in TESTS.md.\n' \
        "$i" "$srcfile" "$i"
    done
  } > "$d/DESIGN_FIDELITY.md"
  cat > "$d/DECISIONS.md" <<'EOF'
# DECISIONS
### DEC-1: What does the change render/return?
**Resolution:** the minimal additive surface described in PLAN.md.
**Basis:** convention — matches the reference module.
EOF
  cat > "$d/DRIFT-1.md" <<'EOF'
# DRIFT round 1
- **DRIFT-1.1** — verdict: none — implementation matches the plan.
**Unresolved drifts:** 0
EOF
  : > "$d/LEDGER.jsonl"
  for a in correctness security error-handling concurrency perms api-contract \
           state-management a11y patterns-conformance tests-quality perf i18n; do
    printf '{"angle":"%s","file":"%s","line":1,"severity":"info","finding":"none","status":"rejected"}\n' \
      "$a" "$srcfile" >> "$d/LEDGER.jsonl"
  done
  printf 'file\tstart\tend\tangles\n' > "$d/AUDIT_COVERAGE.tsv"
  printf '%s\t1\t%s\tcorrectness,a11y,patterns-conformance\n' "$srcfile" "$srclines" >> "$d/AUDIT_COVERAGE.tsv"
  cat > "$d/FIX_ROUND-1.md" <<'EOF'
# FIX_ROUND 1
No confirmed findings to fix.
**New confirmed findings:** 0
EOF
  # phase 9 merge-readiness. These synthetic fixtures never went to a human, so
  # the honest record is the explicit "none received" statement the gate accepts
  # in place of FB-N entries (absence must be a deliberate claim, not a gap).
  cat > "$d/HUMAN_FEEDBACK.md" <<'EOF'
# HUMAN_FEEDBACK
No human feedback received — this feature is a self-test fixture and was never
put in front of a human reviewer.
EOF
}

# ---------------------------------------------------------------------------
# scratch repo scaffolding
# ---------------------------------------------------------------------------
new_repo() {
  local root; root="$(mktemp -d)"
  git -C "$root" init -q -b main
  git -C "$root" config user.email t@t.t
  git -C "$root" config user.name t
  echo "seed" > "$root/README.md"
  git -C "$root" add -A && git -C "$root" commit -qm baseline
  echo "$root"
}
