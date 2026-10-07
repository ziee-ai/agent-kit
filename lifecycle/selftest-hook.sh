#!/usr/bin/env bash
# selftest-hook.sh — verifies the pre-push hook that scripts/install-agent-hooks.sh
# installs, on all four shapes a worktree can present:
#   (a) an EPIC root (`epic/<slug>` + .lifecycle/<slug>/GRAPH.md, several <item>/
#       subdirectories, green epic-check) → the hook must PASS via the EPIC gate
#       (epic-check --wip), where the old "exactly one subdirectory" descent fails;
#   (b) the same epic with a regression in a completed (frozen) phase → FAIL;
#   (e) an honest MID-ROUND epic (P3 in progress, GAPs still open, not frozen) →
#       PASS — the in-progress phase is exempt, mirroring lifecycle-check --wip;
#   (f) the same mid-round epic with a regression in a COMPLETED phase (the DAG
#       assertion is broken) → FAIL;
#   (c) a feature root → the feature gate, byte-for-byte unchanged (green passes,
#       a completed-phase regression fails);
#   (d) an empty / unrecognised root → FAILS CLOSED (never a silent pass).
# Also: the deterministic fallback detection (branch NOT named epic/<slug> but
# GRAPH.md at the .lifecycle root) routes to the epic gate, and every scenario
# compares the hook's verdict with the gate it invokes.
#
# Builds throwaway git repos, installs the hook into each one's OWN .git/hooks
# (never a shared repo), and pushes to a throwaway bare remote. No network, no
# repo SHAs; git + node only. Runs under bash on Linux/macOS/git-bash.
#
#   bash .claude/lifecycle/selftest-hook.sh
#
# Exit 0 = every scenario behaved as specified.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AK="$(cd "$HERE/.." && pwd)"
INSTALLER="$AK/scripts/install-agent-hooks.sh"
CHECK="$HERE/lifecycle-check.mjs"
EC="$HERE/epic-check.mjs"
# shellcheck source=selftest-lib.sh
. "$HERE/selftest-lib.sh"

# hook_assert <want 0|1> <label> [--grep <needle>] -- <command...>
# Like assert_exit_cmd, but ALSO asserts that the captured output carries <needle>
# when --grep is given (normalizes nonzero to 1 like the shared helper).
hook_assert() {
  local want="$1" label="$2"; shift 2
  local needle=""
  if [ "${1:-}" = "--grep" ]; then needle="$2"; shift 2; fi
  [ "${1:-}" = "--" ] && shift
  "$@" >"$LC_SELFTEST_OUT" 2>&1
  local got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" = "$want" ] && { [ -z "$needle" ] || grep -qF -- "$needle" "$LC_SELFTEST_OUT"; }; then
    PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s (exit %s)\n' "$label" "$got"
  else
    FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (want exit %s, got %s)\n' "$label" "$want" "$got"
    sed 's/^/        | /' "$LC_SELFTEST_OUT"
  fi
}

# setup_repo — fresh repo with .claude/lifecycle symlinked to THIS kit (the fixture
# artifacts are committed; the gates are machine-local, exactly as in a real clone),
# the hook INSTALLED into the repo's own .git/hooks, and a throwaway bare origin.
setup_repo() {
  R="$(new_repo)"
  mkdir -p "$R/.claude"
  ln -s "$HERE" "$R/.claude/lifecycle"
  printf '.claude/\n' > "$R/.git/info/exclude"
  REMOTE="$(mktemp -d)/remote.git"
  git -C "$R" init --bare -q "$REMOTE"
  git -C "$R" remote add origin "$REMOTE"
  (cd "$R" && bash "$INSTALLER" >/dev/null 2>&1)
  CLEANUP+=("$R")
}

# write_epic_root <repo> <slug> [regressive]
# A COMPLETE 3-node epic: APO (leaf) → BETA → GAMMA. All four epic phases green
# (DAG/leaves/topo; every plan has a PROV; CONS bind to real PROVs; verdict rows +
# Unmet 0 + freeze line; each downstream-bound PROV is named by an [acceptance]
# test in its PROVIDER's plan). `regressive` = regress a completed phase: BETA now
# binds an undeclared PROV (a GAP) and RECONCILE records it as unresolved.
write_epic_root() {
  local R="$1" slug="$2" mode="${3:-}"
  local E="$R/.lifecycle/$slug"
  mkdir -p "$E/APO" "$E/BETA" "$E/GAMMA"
  if [ "$mode" = "regressive" ]; then
    cat > "$E/GRAPH.md" <<'EOF'
# GRAPH — e1
It is a DAG (no cycle). Leaves: APO. Topological order: APO, BETA, GAMMA.
- APO -> BETA
- BETA -> GAMMA
EOF
    cat > "$E/APO/PLAN.md" <<'EOF'
# APO
## Provides
- **PROV-APO-1**: the append-only guard surface.
### Tests
- **TEST-APO-1** (tier: unit) [acceptance]: asserts PROV-APO-1 — the guard exits non-zero on a planted DELETE.
## Consumes
EOF
    cat > "$E/BETA/PLAN.md" <<'EOF'
# BETA
## Provides
- **PROV-BETA-1**: the delivery surface.
### Tests
- **TEST-BETA-1** (tier: unit) [acceptance]: asserts PROV-BETA-1 — the surface is served.
## Consumes
- **CONS-BETA-1** [from APO] [expects: PROV-APO-9]: the guard's shape.
EOF
    cat > "$E/GAMMA/PLAN.md" <<'EOF'
# GAMMA
## Provides
- **PROV-GAMMA-1**: the collector.
## Consumes
- **CONS-GAMMA-1** [from BETA] [expects: PROV-BETA-1]: the delivery surface.
EOF
    cat > "$E/RECONCILE.md" <<'EOF'
# RECONCILE — e1
- **CONS-BETA-1 ↔ PROV-APO-9** — verdict: GAP — APO must grow it.
- **CONS-GAMMA-1 ↔ PROV-BETA-1** — verdict: MATCH — BETA delivers the surface.
**Unmet contracts:** 1
**Frozen:** 3 items, 2 contracts, 1 unmet — 2026-10-07
EOF
  else
    cat > "$E/GRAPH.md" <<'EOF'
# GRAPH — e1
It is a DAG (no cycle). Leaves: APO. Topological order: APO, BETA, GAMMA.
- APO -> BETA
- BETA -> GAMMA
EOF
    cat > "$E/APO/PLAN.md" <<'EOF'
# APO
## Provides
- **PROV-APO-1**: the append-only guard surface.
### Tests
- **TEST-APO-1** (tier: unit) [acceptance]: asserts PROV-APO-1 — the guard exits non-zero on a planted DELETE.
## Consumes
EOF
    cat > "$E/BETA/PLAN.md" <<'EOF'
# BETA
## Provides
- **PROV-BETA-1**: the delivery surface.
### Tests
- **TEST-BETA-1** (tier: unit) [acceptance]: asserts PROV-BETA-1 — the surface is served.
## Consumes
- **CONS-BETA-1** [from APO] [expects: PROV-APO-1]: the guard's shape.
EOF
    cat > "$E/GAMMA/PLAN.md" <<'EOF'
# GAMMA
## Provides
- **PROV-GAMMA-1**: the collector.
## Consumes
- **CONS-GAMMA-1** [from BETA] [expects: PROV-BETA-1]: the delivery surface.
EOF
    cat > "$E/RECONCILE.md" <<'EOF'
# RECONCILE — e1
- **CONS-BETA-1 ↔ PROV-APO-1** — verdict: MATCH — APO delivers the guard.
- **CONS-GAMMA-1 ↔ PROV-BETA-1** — verdict: MATCH — BETA delivers the surface.
**Unmet contracts:** 0
**Frozen:** 3 items, 2 contracts, 0 unmet — 2026-10-07
EOF
  fi
  cat > "$E/DECISIONS_OPEN.md" <<'EOF'
# DECISIONS_OPEN
- **D1**: nothing open.
EOF
  cat > "$E/ASSUMPTIONS.md" <<'EOF'
# ASSUMPTIONS
- APO is assumed built for BETA, per GRAPH.md.
EOF
  cat > "$E/ISSUES.md" <<'EOF'
# ISSUES
- #1 APO
- #2 BETA
- #3 GAMMA
EOF
}

# write_midround_epic <repo> <slug> [broken-dag]
# An honest MID-ROUND epic: plans done, P3 reconciling (RECONCILE exists, GAPs
# open, NOT frozen). `broken-dag` regresses the COMPLETED phase 0 instead.
write_midround_epic() {
  local R="$1" slug="$2" mode="${3:-}"
  local E="$R/.lifecycle/$slug"
  mkdir -p "$E/APO" "$E/BETA" "$E/GAMMA"
  if [ "$mode" = "broken-dag" ]; then
    cat > "$E/GRAPH.md" <<'EOF'
# GRAPH — e1
It HAS a cycle: A and B loop. Leaves: APO. Topological order: none yet.
- APO -> BETA
- BETA -> GAMMA
EOF
  else
    cat > "$E/GRAPH.md" <<'EOF'
# GRAPH — e1
It is a DAG (no cycle). Leaves: APO. Topological order: APO, BETA, GAMMA.
- APO -> BETA
- BETA -> GAMMA
EOF
  fi
  cat > "$E/APO/PLAN.md" <<'EOF'
# APO
## Provides
- **PROV-APO-1**: the append-only guard surface.
## Consumes
EOF
  cat > "$E/BETA/PLAN.md" <<'EOF'
# BETA
## Provides
- **PROV-BETA-1**: the delivery surface.
## Consumes
- **CONS-BETA-1** [from APO] [expects: PROV-APO-9]: the guard's shape — an open GAP.
EOF
  cat > "$E/GAMMA/PLAN.md" <<'EOF'
# GAMMA
## Provides
- **PROV-GAMMA-1**: the collector.
## Consumes
- **CONS-GAMMA-1** [from BETA] [expects: PROV-BETA-1]: the delivery surface.
EOF
  cat > "$E/RECONCILE.md" <<'EOF'
# RECONCILE — e1
- **CONS-BETA-1 ↔ PROV-APO-9** — verdict: GAP — APO must grow it (reconcile in progress).
- **CONS-GAMMA-1 ↔ PROV-BETA-1** — verdict: MATCH — BETA delivers the surface.
**Unmet contracts:** 1
EOF
}

# write_green_feature <repo> — a COMPLETE, green feature-root artifact set (the
# same fixture selftest.sh FIXTURE 1 ends on: every phase valid, incl. the
# phase-8 self-revert proof and the FE result lines).
write_green_feature() {
  local R="$1"
  local FD="$R/.lifecycle/foo"
  mkdir -p "$R/src-app/ui/src/modules/foo" "$R/src-app/ui/openapi" "$FD"
  cat > "$R/src-app/ui/src/modules/foo/FooPage.tsx" <<'EOF'
export function FooPage() {
  return (
    <div>
      <h1>Foo</h1>
      <button>Save</button>
    </div>
  );
}
EOF
  cat > "$R/src-app/ui/src/modules/foo/FooPage.test.tsx" <<'EOF'
// TEST-1 (ITEM-1, INV-1) — exactly one Save affordance.
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FooPage } from './FooPage';
test('exactly one Save affordance', () => {
  render(<FooPage />);
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
});
EOF
  echo '{"openapi":"3.0.0"}' > "$R/src-app/ui/openapi/openapi.json"
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
  cat > "$FD/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders exactly one Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user opens Foo page and clicks Save.
EOF
  mkdir -p "$R/src-app/ui/tests/e2e/foo"
  cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the user journey: open Foo, press Save.
import { expect, test } from '@playwright/test';
test('opens Foo and saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
  cat > "$FD/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
npm run check (ui): PASS
gate:ui (ui): PASS
EOF
}

echo "== pre-push hook self-test =="
CLEANUP=()

# ---------------------------------------------------------------------------
# (a) EPIC ROOT, several node subdirs, green epic-check → the hook PASSES via
#     the EPIC gate. This is #537: the old hook's "exactly one item subdir"
#     descent never fired on 3 node dirs, so the feature gate FATALed an
#     honest epic push.
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b epic/e1
write_epic_root "$R" e1
git -C "$R" add README.md .lifecycle
git -C "$R" commit -qm "epic e1: complete plan"
hook_assert 0 "(a) multi-node epic root: hook PASSES" --grep "epic-check  epic=e1" -- \
  git -C "$R" push -u origin epic/e1
# and the direct gate agrees, so the hook really ran the epic gate, not a no-op
hook_assert 0 "(a) CONTROL: epic-check --wip on the same tree is green" -- \
  node "$EC" --wip --epic e1 --repo "$R"

# ---------------------------------------------------------------------------
# (b) the SAME epic with a regression in a completed (frozen) phase → FAIL
# ---------------------------------------------------------------------------
write_epic_root "$R" e1 regressive
git -C "$R" add .lifecycle
git -C "$R" commit -qm "epic e1: regress APO's contract (GAP left open)"
hook_assert 1 "(b) frozen epic with an unresolved GAP: hook FAILS" --grep "epic-check --wip FAILED" -- \
  git -C "$R" push origin epic/e1

# ---------------------------------------------------------------------------
# (e) MID-ROUND epic (P3 in progress, GAPs open, not frozen) → PASS: the
#     in-progress phase is exempt, mirroring lifecycle-check --wip.
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b epic/e1
write_midround_epic "$R" e1
git -C "$R" add README.md .lifecycle
git -C "$R" commit -qm "epic e1: mid-round push (reconciling GAPs)"
hook_assert 0 "(e) mid-round epic (P3 in progress): hook PASSES" --grep "phase 3 in progress (exempt)" -- \
  git -C "$R" push -u origin epic/e1

# ---------------------------------------------------------------------------
# (f) the same mid-run state, but a COMPLETED phase regressed (DAG assertion
#     broken) → FAIL. An in-progress exemption must never excuse a completed one.
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b epic/e1
write_midround_epic "$R" e1 broken-dag
git -C "$R" add README.md .lifecycle
git -C "$R" commit -qm "epic e1: mid-round push with a broken GRAPH"
hook_assert 1 "(f) mid-round epic with a broken completed phase: hook FAILS" --grep "epic-check --wip FAILED" -- \
  git -C "$R" push -u origin epic/e1

# ---------------------------------------------------------------------------
# Deterministic FALLBACK: branch NOT named epic/<slug> but the .lifecycle root
# carries GRAPH.md — still an epic root, still the epic gate (the old descent
# heuristic was the only other classifier and it failed on >1 item dir).
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b planning-e1
write_epic_root "$R" e1
git -C "$R" add README.md .lifecycle
git -C "$R" commit -qm "planning-e1: complete plan (branch name does not say epic/)"
hook_assert 0 "epic root by GRAPH.md fallback (non-epic branch name): hook PASSES" --grep "epic-check  epic=e1" -- \
  git -C "$R" push -u origin planning-e1

# ---------------------------------------------------------------------------
# (c) FEATURE ROOT — the feature gate must behave exactly as before: a complete
#     green feature passes, a completed-phase regression fails; and the hook's
#     verdict matches the gate it invokes.
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b feat/foo
write_green_feature "$R"
git -C "$R" add README.md src-app .lifecycle
git -C "$R" commit -qm "feat/foo: complete lifecycle"
add_srp "$R" "$R/.lifecycle/foo"
hook_assert 0 "(c) complete feature root: hook PASSES" --grep "lifecycle-check  feature=" -- \
  git -C "$R" push -u origin feat/foo
hook_assert 0 "(c) CONTROL: lifecycle-check --wip on the same tree is green" -- \
  node "$CHECK" --wip --repo "$R" --dir "$R/.lifecycle/foo" --base main
# regression: drop the [acceptance] pin from the plan's only acceptance test
cat > "$R/.lifecycle/foo/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: FooPage renders exactly one Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user opens Foo page and clicks Save.
EOF
git -C "$R" add .lifecycle/foo/TESTS.md
git -C "$R" commit -qm "feat/foo: regress phase 3 (acceptance pin dropped)"
hook_assert 1 "(c) feature root with a completed-phase regression: hook FAILS" --grep "lifecycle-check --wip FAILED" -- \
  git -C "$R" push origin feat/foo

# ---------------------------------------------------------------------------
# (d) UNRECOGNISED ROOT → fails closed: a .lifecycle/<x>/ with no artifacts is
#     neither an epic root (no GRAPH/RECONCILE) nor a feature (nothing to grade),
#     and the hook must refuse, never silently pass.
# ---------------------------------------------------------------------------
setup_repo
git -C "$R" checkout -q -b feat/none
mkdir -p "$R/.lifecycle/none"
echo "just a stray file, not a lifecycle artifact" > "$R/.lifecycle/none/stray.txt"
git -C "$R" add README.md .lifecycle
git -C "$R" commit -qm "feat/none: unrecognised tree"
hook_assert 1 "(d) unrecognised root: hook FAILS CLOSED" --grep "contains no lifecycle artifacts" -- \
  git -C "$R" push -u origin feat/none

rm -rf "${CLEANUP[@]}"
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
