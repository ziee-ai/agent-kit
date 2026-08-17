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
# The TEST the plan enumerates, CITING its id. A11 requires a `TEST-N: PASS` to be
# earned by an added line of this branch's diff — so a fixture that records PASS
# must actually carry the test, exactly as a real branch must.
cat > "$FE/src-app/ui/src/modules/foo/FooPage.test.tsx" <<'EOF'
// TEST-1 (ITEM-1, INV-1) — exactly one Save affordance.
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FooPage } from './FooPage';
test('exactly one Save affordance', () => {
  render(<FooPage />);
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
});
EOF
# a GENERATED artifact also changes — must NOT count as a real UI touch
echo '{"openapi":"3.0.0"}' > "$FE/src-app/ui/openapi/openapi.json"

FD="$FE/.lifecycle/foo"
cat > "$FD/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §2 "Foo surface" — this plan realizes the single-action
  Foo page described there; no other section of that design is in scope.
## Invariants
- **INV-1**: The Foo surface exposes exactly one Save affordance.
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
# TEST-1 already carries the [acceptance] proof of INV-1, so the ONLY gap phase 3
# can report here is the missing e2e tier — the gate under test.
cat > "$FD/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders exactly one Save button.
EOF
git -C "$FE" add -A && git -C "$FE" commit -qm feat
assert_exit 1 "FE phase 3: all-unit plan for UI work is REFUSED" -- --phase 3 --repo "$FE" --dir "$FD" --base main

# --- variant B: plan now enumerates an e2e-tier test -> phase 3 OK
cat > "$FD/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders exactly one Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user opens Foo page and clicks Save.
EOF
mkdir -p "$FE/src-app/ui/tests/e2e/foo"
cat > "$FE/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the user journey: open Foo, press Save.
import { expect, test } from '@playwright/test';
test('opens Foo and saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
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

#[cfg(test)]
mod tests {
    // TEST-1 (ITEM-1, INV-1) — the listing is never silently truncated.
    #[test]
    fn list_bar_returns_every_row() {
        assert_eq!(super::list_bar().len(), 2);
    }
}
EOF
# regenerated client types — generated, must be excluded from touch detection
echo 'export type Bar = { id: string };' > "$BE/src-app/ui/src/api-client/types.ts"

BD="$BE/.lifecycle/bar"
cat > "$BD/PLAN.md" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path
  described there; the write path is out of scope for this round.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
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
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both seeded rows, not a truncated prefix.
EOF
cat > "$BD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — bar
- **TEST-1**: PASS
EOF
git -C "$BE" add -A && git -C "$BE" commit -qm feat-bar
assert_exit 0 "BE phase 3: backend-only + regen-client plan needs NO e2e" -- --phase 3 --repo "$BE" --dir "$BD" --base main
assert_exit 0 "BE phase 8: backend-only results need NO npm-run-check line" -- --phase 8 --repo "$BE" --dir "$BD" --base main
assert_exit 0 "BE --all: backend-only lifecycle is green" -- --all --repo "$BE" --dir "$BD" --base main

# ---------------------------------------------------------------------------
# FIXTURE 3 — A11: an UNEARNED PASS.
# `TEST-N` is a per-feature namespace, so an ID can be cited only in ANOTHER
# feature's test and still be grepped up. This fixture records PASS for an
# acceptance test whose id appears in NO line the branch added — the exact shape
# that shipped a design invariant as "proven" on a real branch.
# ---------------------------------------------------------------------------
UE="$(new_repo)"
git -C "$UE" checkout -q -b feat/baz
mkdir -p "$UE/src-app/server/src/modules/baz" "$UE/.lifecycle/baz"
# The branch adds real code — but nothing cites TEST-1, and the file TESTS.md
# points at is a PRE-EXISTING one in another module that this branch never opens.
# A stranger's file already on main carries the id, which is precisely what a bare
# grep would find.
mkdir -p "$UE/src-app/server/src/modules/other"
cat > "$UE/src-app/server/src/modules/other/legacy_test.rs" <<'EOF'
// TEST-1 — another feature's test, on main long before this branch existed.
#[test]
fn unrelated() { assert!(true); }
EOF
git -C "$UE" add -A && git -C "$UE" commit -qm pre-existing-stranger
git -C "$UE" checkout -q main && git -C "$UE" merge -q --ff-only feat/baz && git -C "$UE" checkout -q feat/baz
cat > "$UE/src-app/server/src/modules/baz/repository.rs" <<'EOF'
pub fn list_baz() -> Vec<String> {
    vec!["a".into()]
}
EOF
BZ="$UE/.lifecycle/baz"
cat > "$BZ/PLAN.md" <<'EOF'
# PLAN — baz
## Design source
- `docs/design/baz.md` §1 "Baz listing" — this plan realizes the read path.
## Invariants
- **INV-1**: `list_baz` returns every baz row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_baz to the baz repository.
## Files to touch
- `src-app/server/src/modules/baz/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
write_common "$BZ" "src-app/server/src/modules/baz/repository.rs" 3
cat > "$BZ/TESTS.md" <<'EOF'
# TESTS — baz
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/other/legacy_test.rs` — asserts: list_baz returns every row.
EOF
cat > "$BZ/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — baz
- **TEST-1**: PASS
EOF
git -C "$UE" add -A && git -C "$UE" commit -qm feat-baz
assert_exit 1 "A11: an acceptance PASS cited in NO added line is REFUSED" -- --phase 8 --repo "$UE" --dir "$BZ" --base main
# …and the message NAMES the check, so the author meets the argument rather than a bare exit code.
if grep -q "A11" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "A11: the refusal names the check"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "A11: the refusal names the check"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# …and it becomes green the moment the branch actually carries the test.
cat >> "$UE/src-app/server/src/modules/baz/repository.rs" <<'EOF'

#[cfg(test)]
mod tests {
    // TEST-1 (ITEM-1, INV-1) — the listing is never silently truncated.
    #[test]
    fn list_baz_returns_every_row() {
        assert_eq!(super::list_baz().len(), 1);
    }
}
EOF
git -C "$UE" add -A && git -C "$UE" commit -qm earn-test-1
assert_exit 0 "A11: the SAME PASS is accepted once the branch cites it in a test" -- --phase 8 --repo "$UE" --dir "$BZ" --base main

# ---------------------------------------------------------------------------
# phase 5 convergence — EVERY drift file must report 0, including SCOPED ones.
#
# The bug this pins: `glob` matched only `^DRIFT-(\d+)\.md$`, so a per-owner file
# (`DRIFT-stage2-1.md`, the naming a feature split across concurrent owners needs) was
# invisible; and `phase5` read its count from the HIGHEST-numbered match alone, so even
# once visible, one converged file decided the verdict for all of them. Observed in the
# field: a `DRIFT-stage2-1.md` declaring `Unresolved drifts: 1` with `--phase 5` exiting 0.
#
# Reserved number ranges per owner would NOT have fixed it — a high-numbered converged file
# masks a low-numbered unresolved one, which is the same bug in a different convention. So
# the assertions below cover both halves: the scoped file is SEEN, and a converged sibling
# does not discharge it.
DE="$(new_repo)"
git -C "$DE" checkout -q -b feat/drift
mkdir -p "$DE/.lifecycle/drift" "$DE/src-app/server/src"
echo "pub fn a() {}" > "$DE/src-app/server/src/a.rs"
write_common "$DE/.lifecycle/drift" src-app/server/src/a.rs 1
git -C "$DE" add -A && git -C "$DE" commit -qm drift-base

drift_file() { printf '# DRIFT\n\n- **DRIFT-%s** — verdict: resolved — x\n\n**Unresolved drifts:** %s\n' "$2" "$3" > "$DE/.lifecycle/drift/$1"; }

# CONTROL — one unscoped, converged file passes. Without this, every FAIL below could be
# a fixture that never satisfies phase 5 for some unrelated reason.
drift_file DRIFT-1.md 1.1 0
assert_exit 0 "phase5: a single converged DRIFT-1.md passes" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# THE REGRESSION — a SCOPED file with unresolved drift must be seen and must FAIL.
drift_file DRIFT-stage2-1.md S2-1.1 1
assert_exit 1 "phase5: a SCOPED drift file with 1 unresolved FAILS (was invisible)" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# …and a CONVERGED higher-numbered sibling must NOT discharge it. This is the half the
# regex alone does not fix: both files now match, and the old code read only the last.
drift_file DRIFT-stage3-9.md S3-9.1 0
assert_exit 1 "phase5: a converged higher-numbered sibling does NOT mask an unresolved one" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# All scoped files converged ⇒ green. Proves the FAILs above are about the COUNT and not
# merely about a scoped filename being present.
drift_file DRIFT-stage2-1.md S2-1.1 0
assert_exit 0 "phase5: all drift files converged (scoped included) passes" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# An EARLIER unscoped round left unresolved is still unresolved — the single-owner case the
# old "read the last file" logic also got wrong.
drift_file DRIFT-1.md 1.1 2
assert_exit 1 "phase5: an earlier unconverged round is not discharged by a later one" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# ---------------------------------------------------------------------------
# The count parser must read the SUMMARY LINE, not prose that quotes it.
#
# `phase5` extracted the count with a regex applied to the whole file, taking the FIRST
# match anywhere — so a drift entry that QUOTES the summary phrase decided its own file's
# verdict. Found by tripping over it: prose quoting the phrase with a `1`, above a real
# summary of `0`, made the gate report 1. That direction fails SAFE.
#
# The dangerous direction is the mirror, and it is what the first scenario below pins:
# prose quoting the phrase with a `0`, above a REAL summary of `2`, reports GREEN with
# genuine unresolved drift. A gate that can be spoofed by prose is the same class of bug as
# a gate that cannot see a file.
drift_prose() {
  # $1 file · $2 the number the PROSE quotes · $3 the number the SUMMARY declares
  printf '# DRIFT\n\n- **DRIFT-9.1** — verdict: none — the report said `Unresolved drifts: %s` and the gate agreed.\n\n**Unresolved drifts:** %s\n' "$2" "$3" > "$DE/.lifecycle/drift/$1"
}

# Reset to a single clean file so these assertions are about the parser alone.
rm -f "$DE"/.lifecycle/drift/DRIFT-*.md

# THE ONE THAT MATTERS — prose says 0, the summary says 2. Must be RED.
drift_prose DRIFT-1.md 0 2
assert_exit 1 "phase5 parser: prose quoting '0' must NOT mask a real summary of 2" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# The safe direction actually observed in the field — prose says 1, summary says 0. Green.
drift_prose DRIFT-1.md 1 0
assert_exit 0 "phase5 parser: prose quoting '1' does not spoof a real summary of 0" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

# CONTROL — an ordinary artifact with no prose quoting still parses exactly as before, in
# both the plain and list-marker spellings. Without this the anchor could be too strict and
# silently stop reading real summary lines, which fails CLOSED but breaks every consumer.
printf '# DRIFT\n\n- **DRIFT-1.1** — verdict: resolved — x\n\n**Unresolved drifts:** 0\n' > "$DE/.lifecycle/drift/DRIFT-1.md"
assert_exit 0 "phase5 parser: an ordinary '**Unresolved drifts:** 0' still parses" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"
printf '# DRIFT\n\n- **DRIFT-1.1** — verdict: none — x\n\n- **Unresolved drifts:** 3\n' > "$DE/.lifecycle/drift/DRIFT-1.md"
assert_exit 1 "phase5 parser: the list-marker spelling '- **Unresolved drifts:** 3' still parses" -- --phase 5 --repo "$DE" --dir "$DE/.lifecycle/drift"

rm -rf "$FE" "$BE" "$UE" "$DE"
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
