# selftest-lib.sh — shared scaffolding for the feature-lifecycle self-tests.
# Sourced by selftest.sh (flow gates) and selftest-hardening.sh (A-checks +
# merge-gate + preflight). Pure POSIX-ish bash; runs on Linux, macOS, and
# Windows git-bash (no GNU-only flags; git + node the only hard deps).
#
# Provides: PASS/FAIL counters, assert_exit_cmd, write_common, new_repo.

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
# artifact writers (a valid set of phases 1,2,4,5,6,7 artifacts)
# ---------------------------------------------------------------------------
# write_common <feature-dir> <src-file-path> <src-line-count>
# Writes PLAN_AUDIT / DECISIONS / DRIFT-1 / LEDGER / AUDIT_COVERAGE / FIX_ROUND
# so the diff's single source file is covered by 3 angles over lines 1..N.
write_common() {
  local d="$1" srcfile="$2" srclines="$3"
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
