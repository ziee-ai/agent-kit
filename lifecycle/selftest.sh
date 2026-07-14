#!/usr/bin/env bash
# selftest.sh — portable, self-contained verification of the feature-lifecycle
# validator's FRONTEND gates (phase 3 e2e-tier requirement + phase 8
# npm-run-check / e2e result requirement) and the backend-only exemption.
#
# Builds throwaway git repos with controlled diffs + a full set of lifecycle
# artifacts, then asserts the validator's exit code for each scenario. No
# network, no repo-specific SHAs — runs on any clone.
#
#   bash .claude/lifecycle/selftest.sh
#
# Exit 0 = all scenarios behaved as specified.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/lifecycle-check.mjs"
# shellcheck source=selftest-lib.sh
. "$HERE/selftest-lib.sh"

# assert_exit <expected 0|1> <label> -- <validator args...>  (thin wrapper over
# the shared assert_exit_cmd, pinned to `node lifecycle-check.mjs`).
assert_exit() {
  local want="$1"; local label="$2"; shift 2; [ "${1:-}" = "--" ] && shift
  assert_exit_cmd "$want" "$label" -- node "$CHECK" "$@"
}

# (write_common + new_repo now live in selftest-lib.sh, sourced above.)

echo "== feature-lifecycle validator self-test =="

# ---------------------------------------------------------------------------
# FIXTURE 1 — FRONTEND-TOUCHING feature (src-app/ui/**)
# ---------------------------------------------------------------------------
FE="$(new_repo)"
git -C "$FE" checkout -q -b feat/foo
mkdir -p "$FE/src-app/ui/src/modules/foo" "$FE/src-app/ui/openapi" "$FE/.lifecycle/foo"
cat > "$FE/src-app/ui/src/modules/foo/FooPage.tsx" <<'EOF'
export function FooPage() {
  return (
    <div>
      <h1>Foo</h1>
      <button>Save</button>
    </div>
  );
}
EOF
# a GENERATED artifact also changes — must NOT count as a real UI touch
echo '{"openapi":"3.0.0"}' > "$FE/src-app/ui/openapi/openapi.json"

FD="$FE/.lifecycle/foo"
cat > "$FD/PLAN.md" <<'EOF'
# PLAN — foo
## Items
- **ITEM-1**: Add a FooPage component to the ui workspace.
## Files to touch
- `src-app/ui/src/modules/foo/FooPage.tsx` — new page (ITEM-1).
- `src-app/ui/openapi/openapi.json` — regenerated (excluded from gates).
## Patterns to follow
- Mirror an existing settings page in `src-app/ui/src/modules/`.
EOF
write_common "$FD" "src-app/ui/src/modules/foo/FooPage.tsx" 8

# --- variant A: all-unit test plan (NO e2e) -> phase 3 must FAIL
cat > "$FD/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders a Save button.
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm feat
assert_exit 1 "FE phase 3: all-unit plan for UI work is REFUSED" -- --phase 3 --repo "$FE" --dir "$FD" --base main

# --- variant B: plan now enumerates an e2e-tier test -> phase 3 OK
cat > "$FD/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders a Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user opens Foo page and clicks Save.
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm tests-e2e
assert_exit 0 "FE phase 3: UI plan WITH an e2e-tier test passes" -- --phase 3 --repo "$FE" --dir "$FD" --base main

# --- variant C: phase 8 results WITHOUT npm-run-check / e2e lines -> FAIL
cat > "$FD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm results-missing-fe-lines
assert_exit 1 "FE phase 8: missing 'npm run check (ui): PASS' is REFUSED" -- --phase 8 --repo "$FE" --dir "$FD" --base main

# --- variant C2: npm-run-check present but the e2e spec did not pass -> FAIL
cat > "$FD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: FAIL
npm run check (ui): PASS
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm results-e2e-fail
assert_exit 1 "FE phase 8: a failing e2e spec is REFUSED" -- --phase 8 --repo "$FE" --dir "$FD" --base main

# --- variant D: full frontend results -> phase 8 OK, and --all OK
cat > "$FD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
npm run check (ui): PASS
gate:ui (ui): PASS
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm results-complete
assert_exit 0 "FE phase 8: npm-run-check + e2e PASS lines accepted" -- --phase 8 --repo "$FE" --dir "$FD" --base main
assert_exit 0 "FE --all: complete frontend lifecycle is green" -- --all --repo "$FE" --dir "$FD" --base main

# ---------------------------------------------------------------------------
# FIXTURE 2 — BACKEND-ONLY feature that ALSO regenerates the client.
# The generated ui/ artifacts must NOT trigger the frontend gates; an all-unit
# + integration plan (no e2e) must PASS, and results need no npm-run-check line.
# ---------------------------------------------------------------------------
BE="$(new_repo)"
git -C "$BE" checkout -q -b feat/bar
mkdir -p "$BE/src-app/server/src/modules/bar" "$BE/src-app/ui/src/api-client" "$BE/.lifecycle/bar"
cat > "$BE/src-app/server/src/modules/bar/repository.rs" <<'EOF'
pub fn list_bar() -> Vec<String> {
    vec!["a".into(), "b".into()]
}
EOF
# regenerated client types — generated, must be excluded from touch detection
echo 'export type Bar = { id: string };' > "$BE/src-app/ui/src/api-client/types.ts"

BD="$BE/.lifecycle/bar"
cat > "$BD/PLAN.md" <<'EOF'
# PLAN — bar
## Items
- **ITEM-1**: Add list_bar to the bar repository.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
- `src-app/ui/src/api-client/types.ts` — regenerated (excluded from gates).
## Patterns to follow
- Mirror an existing server repository module.
EOF
write_common "$BD" "src-app/server/src/modules/bar/repository.rs" 3
cat > "$BD/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns two rows.
EOF
cat > "$BD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — bar
- **TEST-1**: PASS
EOF
git -C "$BE" add -A && git -C "$BE" commit -qm feat-bar
assert_exit 0 "BE phase 3: backend-only + regen-client plan needs NO e2e" -- --phase 3 --repo "$BE" --dir "$BD" --base main
assert_exit 0 "BE phase 8: backend-only results need NO npm-run-check line" -- --phase 8 --repo "$BE" --dir "$BD" --base main
assert_exit 0 "BE --all: backend-only lifecycle is green" -- --all --repo "$BE" --dir "$BD" --base main

rm -rf "$FE" "$BE"
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
