#!/usr/bin/env bash
# selftest-hardening.sh — verifies the LIFECYCLE-HARDENING additions:
#   • lifecycle-check.mjs A1/A2/A3/A4/A5/A7/A8/A9/A10 deterministic gates
#   • merge-gate.mjs      C2 (migration collision) + C4 (stale branch) + clean
#   • preflight.sh        good env passes, missing-setup fails
#
# Each gate is proven BOTH ways: it PASSES a clean fixture and FAILS a
# seeded-bad one. Builds throwaway git repos; no network, no repo SHAs.
# Cross-platform: bash on Linux / macOS / Windows git-bash (git + node only).
#
#   bash .claude/lifecycle/selftest-hardening.sh
#
# Exit 0 = every gate behaved as specified.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/lifecycle-check.mjs"
MG="$HERE/merge-gate.mjs"
PREFLIGHT="$HERE/preflight.sh"
# shellcheck source=selftest-lib.sh
. "$HERE/selftest-lib.sh"

STALE_CHECK="$HERE/staleness-check.mjs"
HOOK="$HERE/edit-lint-hook.mjs"

lc()  { assert_exit_cmd "$1" "$2" -- node "$CHECK" "${@:3}"; }
# lc_says <needle> <label> <lifecycle-check args...> — asserts the DIAGNOSIS text, not just
# the exit code. The invocation-integrity defects all had the right *shape* of output and
# the wrong content, so these gates are pinned on what the message SAYS. A leading `--`
# lets a needle start with a dash.
lc_says_impl() {
  [ "${1:-}" = "--" ] && shift
  local needle="$1"; shift
  local out; out="$(node "$CHECK" "$@" 2>&1)"
  if printf '%s\n' "$out" | grep -qF -- "$needle"; then return 0; fi
  printf 'expected the diagnosis to contain: %s\n--- actual ---\n%s\n' "$needle" "$out"
  return 1
}
lc_says() {
  if [ "${1:-}" = "--" ]; then shift; assert_exit_cmd 0 "$2" -- lc_says_impl -- "$1" "${@:3}";
  else assert_exit_cmd 0 "$2" -- lc_says_impl "$1" "${@:3}"; fi
}
sc()  { assert_exit_cmd "$1" "$2" -- node "$STALE_CHECK" "${@:3}"; }

# sc_says <needle> <label> <staleness-check args...> — asserts the DIAGNOSIS text,
# not just the exit code. A staleness finding whose message does not name the
# CONSEQUENCE is the failure mode this whole checker exists to avoid.
sc_says_impl() {
  local needle="$1"; shift
  local out; out="$(node "$STALE_CHECK" "$@" 2>&1)"
  if printf '%s\n' "$out" | grep -q -- "$needle"; then return 0; fi
  printf 'expected the diagnosis to contain: %s\n--- actual ---\n%s\n' "$needle" "$out"
  return 1
}
sc_says() { assert_exit_cmd 0 "$2" -- sc_says_impl "$1" "${@:3}"; }

# hook_out <file> — runs the edit-lint hook exactly as a PostToolUse hook would.
# Exit 0 = the hook stayed QUIET, exit 1 = it emitted findings. (The hook itself
# always exits 0 by the fail-open contract, so the signal is its stdout.)
hook_out_impl() {
  local o
  o="$(printf '{"tool_input":{"file_path":"%s"}}' "$1" | node "$HOOK" 2>/dev/null)"
  printf '%s\n' "$o"
  [ -z "$o" ]
}
hk() { assert_exit_cmd "$1" "$2" -- hook_out_impl "$3"; }
# hk_says <needle> <label> <file> — the finding must name the thing it claims.
hk_says_impl() { printf '{"tool_input":{"file_path":"%s"}}' "$2" | node "$HOOK" 2>/dev/null | grep -q -- "$1"; }
hk_says() { assert_exit_cmd 0 "$2" -- hk_says_impl "$1" "$3"; }
# hk_raw <label> <raw stdin> — fail-open on malformed hook input.
hk_raw_impl() { local o; o="$(printf '%s' "$1" | node "$HOOK" 2>/dev/null)"; printf '%s\n' "$o"; [ -z "$o" ]; }

CLEANUP=()
KILLPIDS=()
trap 'for p in "${KILLPIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
      for d in "${CLEANUP[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done
      rm -f "$LC_SELFTEST_OUT"' EXIT

# write a ziee-shaped .claude/app.config into a fixture repo. This is how the
# de-ziee-ified preflight.sh + merge-gate.mjs read their app-specific paths; with
# it present the gates reproduce ziee's exact PASS/FAIL, proving the app.config
# seam is behavior-preserving. (The no-app.config SKIP path is asserted below.)
write_ziee_appconfig() {
  local R="$1"; mkdir -p "$R/.claude"
  cat > "$R/.claude/app.config" <<'CFGEOF'
PREFLIGHT_SEED_FILE=src-app/server/binaries/hub-seed/index.json
PREFLIGHT_SEED_HINT=refetch or copy the build seed from another clone
PREFLIGHT_SUBMODULE=src-app/server/vendor/pgvector
PREFLIGHT_NODE_WORKSPACES=src-app/ui src-app/desktop/ui
PREFLIGHT_BUILD_DB_ENV=ZIEE_BUILD_DB_PERWORKTREE
PREFLIGHT_BUILD_DB_HOSTPORT=127.0.0.1:54321
PREFLIGHT_BUILD_DB_SENTINEL=sqlx-build-sentinel
PREFLIGHT_CONFIG_DIR=src-app/server/config
PREFLIGHT_CONFIG_FILE=dev.yaml
PREFLIGHT_CONFIG_EXAMPLE=dev.example.yaml
PREFLIGHT_CONFIG_PLACEHOLDER=dev-secret-change-in-production-min-32-chars-long
MERGE_MIGRATIONS_DIR=src-app/server/migrations
MERGE_CARGO_PACKAGE=ziee
MERGE_CARGO_DIR=src-app
MERGE_CARGO_DESKTOP_PACKAGE=ziee-desktop
MERGE_DESKTOP_TOUCH_PREFIX=src-app/desktop/tauri/
MERGE_REGEN_CMD=just openapi-regen
MERGE_GENERATED=src-app/ui/openapi/openapi.json src-app/ui/src/api-client/types.ts src-app/desktop/ui/openapi/openapi.json src-app/desktop/ui/src/api-client/types.ts
CFGEOF
}

# ---------------------------------------------------------------------------
# build_be — a fully-valid BACKEND feature repo on branch feat/bar, committed
# clean. Echoes the repo root. The single source file is
# src-app/server/src/modules/bar/repository.rs (entirely diff-added vs main).
# ---------------------------------------------------------------------------
build_be() {
  local R; R="$(new_repo)"; CLEANUP+=("$R")
  git -C "$R" checkout -q -b feat/bar
  mkdir -p "$R/src-app/server/src/modules/bar" "$R/.lifecycle/bar"
  cat > "$R/src-app/server/src/modules/bar/repository.rs" <<'EOF'
pub fn list_bar() -> Vec<String> {
    vec!["a".into(), "b".into()]
}
EOF
  local D="$R/.lifecycle/bar"
  cat > "$D/PLAN.md" <<'EOF'
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
## Patterns to follow
- Mirror an existing server repository module.
EOF
  write_common "$D" "src-app/server/src/modules/bar/repository.rs" 3
  cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both seeded rows, not a truncated prefix.
EOF
  cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — bar
- **TEST-1**: PASS
EOF
  git -C "$R" add -A && git -C "$R" commit -qm feat-bar
  echo "$R"
}

# ---------------------------------------------------------------------------
# build_perm — a feature that INTRODUCES a user-facing permission (foo::use) in
# a modules/*/permissions.rs AND ships a UI surface gated by it. A9 (backend
# deny) is satisfied by TEST-2's 403; the A10 (frontend-hidden) test is left OFF
# so the caller can add it. Echoes the repo root; branch = feat/perm.
# ---------------------------------------------------------------------------
build_perm() {
  local R; R="$(new_repo)"; CLEANUP+=("$R")
  git -C "$R" checkout -q -b feat/perm
  mkdir -p "$R/src-app/server/src/modules/foo" "$R/src-app/ui/src/modules/foo" "$R/.lifecycle/foo"
  cat > "$R/src-app/server/src/modules/foo/permissions.rs" <<'EOF'
pub struct FooUse;
impl PermissionCheck for FooUse {
    const PERMISSION: &'static str = "foo::use";
}
EOF
  cat > "$R/src-app/ui/src/modules/foo/FooPage.tsx" <<'EOF'
export function FooPage() {
  return <div><h1>Foo</h1><button>Save</button></div>;
}
EOF
# The tests the plan enumerates (A11: a recorded PASS must be bound to something
# this branch wrote — the id cited in an added line, or the declared `file:` touched).
mkdir -p "$R/src-app/ui/tests/e2e/foo"
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
cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the user journey: open Foo, press Save.
import { expect, test } from '@playwright/test';
test('opens Foo and saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
  # The TESTS the plan enumerates. A11 requires a `TEST-N: PASS` to be bound to
  # something this branch wrote — the id cited in an added line, or the declared
  # `file:` itself touched — so a fixture that records PASS has to carry the
  # tests, exactly as a real branch does.
  mkdir -p "$R/src-app/server/tests/foo" "$R/src-app/ui/tests/e2e/foo"
  cat > "$R/src-app/server/tests/foo/foo.rs" <<'EOF'
// TEST-2 (ITEM-1, INV-1) — a caller lacking foo::use is refused.
#[test]
fn lacking_foo_use_is_forbidden() {
    assert_eq!(deny_status(), 403);
}
EOF
  cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-3 (ITEM-2) — a permitted user opens Foo and saves.
import { expect, test } from '@playwright/test';
test('permitted user saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
  # The RESTRICTED-USER spec several scenarios below enumerate as TEST-4.
  cat > "$R/src-app/ui/tests/e2e/foo/perm-gating.spec.ts" <<'EOF'
// TEST-4 (ITEM-2) — the restricted user reaches the app and sees no Foo UI.
import { expect, test } from '@playwright/test';
test('restricted user: dashboard loads, Foo is absent', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Foo' })).toHaveCount(0);
});
EOF
  local D="$R/.lifecycle/foo"
  cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §4 "Foo access control" — this plan realizes the gated
  Foo surface described there.
## Invariants
- **INV-1**: Foo is reachable only with `foo::use` — the backend refuses a caller that lacks it.
## Items
- **ITEM-1**: Define the foo::use permission (backend).
- **ITEM-2**: Add the FooPage UI, gated by foo::use.
## Files to touch
- `src-app/server/src/modules/foo/permissions.rs` — new perm (ITEM-1).
- `src-app/ui/src/modules/foo/FooPage.tsx` — new gated page (ITEM-2).
## Patterns to follow
- Mirror an existing permissions.rs and a settings page.
EOF
  write_common "$D" "src-app/server/src/modules/foo/permissions.rs" 5
  # write_common's PLAN_AUDIT verdicts cover ITEM-1; this plan has a second item.
  printf -- '- **ITEM-2** — verdict: PASS — mirrors an existing gated settings page; additive only.\n' >> "$D/PLAN_AUDIT.md"
  # write_common's LEDGER + AUDIT_COVERAGE cover the ONE source file it is told
  # about; this fixture touches a second (the UI page), so extend both. Without
  # this the fixture is only phase-3/8-valid, and phase 6 would report the
  # FooPage.tsx hunk as reviewed by 0 angles.
  for a in correctness a11y patterns-conformance; do
    printf '{"angle":"%s","file":"src-app/ui/src/modules/foo/FooPage.tsx","line":1,"severity":"info","finding":"none","status":"rejected"}\n' \
      "$a" >> "$D/LEDGER.jsonl"
  done
  printf 'src-app/ui/src/modules/foo/FooPage.tsx\t1\t3\tcorrectness,a11y,patterns-conformance\n' >> "$D/AUDIT_COVERAGE.tsv"
  cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/foo/permissions.rs` — asserts: PERMISSION is foo::use.
- **TEST-2** (tier: integration) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/tests/foo/foo.rs` — asserts: a user lacking foo::use gets 403 forbidden.
- **TEST-3** (tier: e2e) [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: a permitted user opens Foo and clicks Save.
EOF
  cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
- **TEST-3**: PASS
npm run check (ui): PASS
gate:ui (ui): PASS
EOF
  git -C "$R" add -A && git -C "$R" commit -qm feat-perm
  echo "$R"
}

echo "== lifecycle-hardening self-test =="
echo "-- Part A: lifecycle-check.mjs A1-A10 --"

# --- control: a clean backend feature passes phase 8 (so a FAIL below is the A-check)
R="$(build_be)"; D="$R/.lifecycle/bar"
lc 0 "A-control: clean backend phase 8 passes" --phase 8 --repo "$R" --dir "$D" --base main

# --- Phase 7 termination: a NON-DECAYING profile aborts instead of looping.
# "Repeat until 0" is unsound (an FP-emitting reviewer can produce a finding on
# any round), and it produced a real 17-round run. Profiles below are the real
# ones from this repo's features.
p7() { # $1=label $2=expect-exit  rest=profile
  local lbl="$1" want="$2"; shift 2
  local d; d="$(mktemp -d)"; mkdir -p "$d/.lifecycle/f"; printf '# PLAN\n' > "$d/.lifecycle/f/PLAN.md"
  local i=1; for n in "$@"; do printf '# R%s\n**New confirmed findings:** %s\n' "$i" "$n" > "$d/.lifecycle/f/FIX_ROUND-$i.md"; i=$((i+1)); done
  ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t && git add -A >/dev/null 2>&1 && git commit -qm x >/dev/null 2>&1 )
  lc "$want" "phase7: $lbl" --phase 7 --repo "$d" --dir "$d/.lifecycle/f" --base HEAD
}
p7 "geometric decay to 0 converges (workflow-builder)" 0 36 7 7 2 2 1 1 0
p7 "late ramp then decay converges (ask-user)"         0 0 15 1 0
p7 "non-decaying profile is REFUSED (activity-rail)"   1 0 2 17 16 20 12 14 15 8 10 7 8 6 8 5 15 21
p7 "non-decaying is caught EARLY, at round 5"          1 0 2 17 16 20
p7 "a legitimate late ramp is NOT aborted at round 2"  1 0 15

# ---------------------------------------------------------------------------
# --- T1: capture-recapture termination (an ESTIMATE, not an observation) ---
# ---------------------------------------------------------------------------
# p7t <label> <want> <ledger-body-file> -- <profile...>
# Same as p7 but also plants a LEDGER.jsonl so the estimator has an input.
p7t() {
  local lbl="$1" want="$2" ledger="$3"; shift 3; [ "${1:-}" = "--" ] && shift
  local d; d="$(mktemp -d)"; CLEANUP+=("$d"); mkdir -p "$d/.lifecycle/f"
  printf '# PLAN\n' > "$d/.lifecycle/f/PLAN.md"
  cp "$ledger" "$d/.lifecycle/f/LEDGER.jsonl"
  local i=1; for n in "$@"; do printf '# R%s\n**New confirmed findings:** %s\n' "$i" "$n" > "$d/.lifecycle/f/FIX_ROUND-$i.md"; i=$((i+1)); done
  ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t && git add -A >/dev/null 2>&1 && git commit -qm x >/dev/null 2>&1 )
  lc "$want" "phase7: $lbl" --phase 7 --repo "$d" --dir "$d/.lifecycle/f" --base HEAD
}
# mkledger <out> <round> <n-corroborated> <n-single-A> <n-single-B> [omit-corrob-field]
# Emits one row per finding: `m` rows corroborated by both angles, then singles.
mkledger() {
  local out="$1" rnd="$2" m="$3" sa="$4" sb="$5" omit="${6:-}"
  : > "$out"; local i=0
  while [ "$i" -lt "$m" ]; do
    if [ -n "$omit" ]; then printf '{"round":%s,"angle":"correctness","file":"src/a%s.rs","severity":"medium","finding":"f%s","status":"confirmed"}\n' "$rnd" "$i" "$i" >> "$out"
    else printf '{"round":%s,"angle":"correctness","file":"src/a%s.rs","severity":"medium","corroborated_by":2,"finding":"f%s","status":"confirmed"}\n' "$rnd" "$i" "$i" >> "$out"; fi
    i=$((i+1))
  done
  i=0; while [ "$i" -lt "$sa" ]; do
    printf '{"round":%s,"angle":"correctness","file":"src/b%s.rs","severity":"medium","corroborated_by":1,"finding":"g%s","status":"confirmed"}\n' "$rnd" "$i" "$i" >> "$out"; i=$((i+1)); done
  i=0; while [ "$i" -lt "$sb" ]; do
    printf '{"round":%s,"angle":"security","file":"src/c%s.rs","severity":"medium","corroborated_by":1,"finding":"h%s","status":"confirmed"}\n' "$rnd" "$i" "$i" >> "$out"; i=$((i+1)); done
}
LEDG="$(mktemp -d)"; CLEANUP+=("$LEDG")

# T1-1: heavy OVERLAP ⇒ the two angles saturated ⇒ Chapman N̂ ≈ observed ⇒ under
# one promotable defect estimated remaining ⇒ TERMINATE even though the final
# round is NOT 0. This is the payoff: the loop stops on the estimate, and the
# author is spared a round run purely to watch a counter read 0.
#   m=8 sA=1 sB=1 ⇒ n1=9 n2=9 obs=10 ⇒ N̂=(10·10)/9−1=10.1 ⇒ remaining 0.1
mkledger "$LEDG/hi.jsonl" 2 8 1 1
p7t "T1: high angle-overlap terminates the loop with findings still open" 0 "$LEDG/hi.jsonl" -- 12 6

# T1-2 (DISCRIMINATING CONTROL): the SAME profile and the same finding COUNT,
# but the two angles barely overlap ⇒ N̂ ≫ observed ⇒ many defects unfound ⇒ the
# loop must NOT terminate. Without this case, T1-1 could be passing because the
# gate went blanket-permissive rather than because the estimate said stop.
#   m=2 sA=4 sB=4 ⇒ n1=6 n2=6 obs=10 ⇒ N̂=(7·7)/3−1=15.3 ⇒ remaining 5.3
mkledger "$LEDG/lo.jsonl" 2 2 4 4
p7t "T1: LOW angle-overlap does NOT terminate (estimate says defects remain)" 1 "$LEDG/lo.jsonl" -- 12 6

# T1-3 (MIGRATION SAFETY): a ledger that records no `corroborated_by` at all —
# i.e. every ledger written before this reform — must fall back to the decay rule
# untouched, never be guessed at. Same shape as T1-1, which T1 would otherwise
# terminate; here it FAILs, proving the fallback is real.
mkledger "$LEDG/nofield.jsonl" 2 8 1 1 omit
p7t "T1: a ledger without corroborated_by falls back to the decay rule" 1 "$LEDG/nofield.jsonl" -- 12 6

# T1-4 (SMALL-SAMPLE FLOOR): 2 findings both corroborated would compute a tidy
# "0 remaining", but a two-sample estimate over 2 observations carries no
# information. Below the floor the estimator declines and the decay rule decides.
mkledger "$LEDG/tiny.jsonl" 2 2 0 0
p7t "T1: below the small-sample floor the estimator declines (no free pass)" 1 "$LEDG/tiny.jsonl" -- 12 6

# T1-5: T1 must not rescue the case the decay rule exists to catch — a
# non-decaying profile is an ABORT regardless of what the estimate says, because
# a flat/rising profile falsifies the model the estimate itself rests on.
mkledger "$LEDG/hi5.jsonl" 5 8 1 1
p7t "T1: does NOT override the non-decaying ABORT (model falsified)" 1 "$LEDG/hi5.jsonl" -- 0 2 17 16 20

# ---------------------------------------------------------------------------
# --- GUARD-SUB: the guard-substitution tripwire (concentration, not decay) ---
# ---------------------------------------------------------------------------
# mkconc <out> <round> <n-on-top-file> <n-elsewhere> <top-file>
mkconc() {
  local out="$1" rnd="$2" n="$3" rest="$4" top="$5"; : > "$out"; local i=0
  while [ "$i" -lt "$n" ]; do printf '{"round":%s,"angle":"tests-quality","file":"%s","severity":"low","finding":"evasion %s","status":"confirmed"}\n' "$rnd" "$top" "$i" >> "$out"; i=$((i+1)); done
  i=0; while [ "$i" -lt "$rest" ]; do printf '{"round":%s,"angle":"correctness","file":"src/other%s.rs","severity":"low","finding":"real %s","status":"confirmed"}\n' "$rnd" "$i" "$i" >> "$out"; i=$((i+1)); done
}
GRD="$(mktemp -d)"; CLEANUP+=("$GRD")

# All five G-cases share ONE profile: `20 10 5 0` — a clean geometric decay that
# CONVERGES. The decay rule reports OK on every one of them, so the only variable
# is the concentration measure. That is the point: if the decay rule already
# caught these, every case below would be exit 1 and the tripwire would be
# redundant. It is not — G-1 fires on a profile the decay rule calls converged.

# G-1 (THE NON-REDUNDANCY PROOF): 8 of 9 findings on the hand-written AST
# source-guard `railIsolation.test.ts` — the real file from the real feature
# whose rounds 13-17 put 46 of 59 findings on it. The profile CONVERGED, so the
# decay rule passes it; the tripwire refuses it, because a guard that
# pattern-matches a semantic property has an unbounded evasion space and each
# round only finds another spelling. Six rounds burned on a guard is not
# convergence, it is the wrong artifact under audit.
mkconc "$GRD/g1.jsonl" 4 8 1 "src-app/ui/src/modules/chat/components/rail/railIsolation.test.ts"
p7t "GUARD-SUB: fires at 89% guard concentration on a profile the decay rule calls CONVERGED" 1 "$GRD/g1.jsonl" -- 20 10 5 0

# G-2 (CONTROL — the axis is CONCENTRATION, not volume): identical round, same
# guard file, but the findings are SPREAD (3 of 9). Silent.
mkconc "$GRD/spread.jsonl" 4 3 6 "src-app/ui/src/modules/chat/components/rail/railIsolation.test.ts"
p7t "GUARD-SUB: a SPREAD round on the same guard file does not fire" 0 "$GRD/spread.jsonl" -- 20 10 5 0

# G-3 (CONTROL — the subject must be a TEST/GUARD file): the same 89% on the
# feature's own SOURCE file is normal work on the code under construction.
# Firing here would make the tripwire useless on every small feature.
mkconc "$GRD/src.jsonl" 4 8 1 "src-app/server/src/modules/rail/repository.rs"
p7t "GUARD-SUB: the same concentration on a SOURCE file does not fire" 0 "$GRD/src.jsonl" -- 20 10 5 0

# G-4 (CONTROL — round 1 is exempt): the first fix round may legitimately land
# almost entirely on the tests it just wrote.
mkconc "$GRD/r1.jsonl" 1 8 1 "src-app/ui/src/modules/chat/components/rail/railIsolation.test.ts"
p7t "GUARD-SUB: round 1 is exempt (new tests legitimately concentrate)" 0 "$GRD/r1.jsonl" -- 20 10 5 0

# G-5 (MIGRATION SAFETY): a ledger with no per-round attribution is not guessed
# at. Byte-identical to G-1 with `round` stripped ⇒ silent.
sed 's/"round":4,//' "$GRD/g1.jsonl" > "$GRD/noround.jsonl"
p7t "GUARD-SUB: a ledger without per-round attribution is not guessed at" 0 "$GRD/noround.jsonl" -- 20 10 5 0

# --- A1: a SECOND .lifecycle feature dir on the branch -> --all FAILs (global)
R="$(build_be)"; D="$R/.lifecycle/bar"
mkdir -p "$R/.lifecycle/stray"
echo "# a second feature's plan that sneaked onto the branch" > "$R/.lifecycle/stray/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm stray-dir
lc 1 "A1: two .lifecycle dirs is REFUSED even with explicit --dir" --all --repo "$R" --dir "$D" --base main
git -C "$R" rm -rq .lifecycle/stray && git -C "$R" commit -qm rm-stray
lc 0 "A1: one .lifecycle dir is accepted (control)" --all --repo "$R" --dir "$D" --base main

# --- A1 (regression): DELETING an inherited feature dir is itself refused.
# Making A1 base-relative removed the PRESSURE to delete a sibling's audit trail
# to go green; it does not DETECT the deletion. The absolute-count era produced a
# real one. NOTE the ordering trap this pins: deleting the siblings is what
# LEAVES one dir, so a check that short-circuits on "<=1 dir present" passes
# exactly when the damage has been done.
R="$(build_be)"; D="$R/.lifecycle/bar"
mkdir -p "$R/.lifecycle/sibling"
echo "# another feature's audit trail, inherited from the base" > "$R/.lifecycle/sibling/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm "sibling feature on the base"
git -C "$R" branch -f main HEAD
git -C "$R" checkout -q -b deleter
git -C "$R" rm -rq .lifecycle/sibling && git -C "$R" commit -qm "delete a sibling's audit trail"
lc 1 "A1: DELETING a base-inherited feature dir is REFUSED (leaves 1 dir behind)" --phase 1 --repo "$R" --dir "$D" --base main
git -C "$R" revert --no-edit HEAD >/dev/null 2>&1
lc 0 "A1: restoring the sibling clears it (control)" --phase 1 --repo "$R" --dir "$D" --base main

# --- A1 (regression): feature dirs INHERITED from the base must NOT trip A1.
# A branch cut from a long-lived integration branch carries every previously
# landed feature's committed artifacts. Counting those made A1 unsatisfiable and
# its only "remedy" was deleting other features' audit trails — the exact
# destructive act the lifecycle exists to prevent. A1 counts what the BRANCH adds.
#
# The two cases below prove OPPOSITE directions and are both required:
#   • the first DISCRIMINATES the fix — it FAILS against the old on-disk rule
#     (which refuses any >1 dir, inherited or not);
#   • the second is the NO-OVER-CORRECTION control — the old rule also refuses
#     here, so it cannot discriminate the fix; what it catches is the fix
#     swinging too far and letting a branch-added stray through (it FAILS if A1
#     is disabled or the diff-vs-base count stops reporting).
R="$(build_be)"; D="$R/.lifecycle/bar"
git -C "$R" checkout -q main
mkdir -p "$R/.lifecycle/previously-landed"
echo "# a landed feature's artifacts, already on the integration base" > "$R/.lifecycle/previously-landed/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm landed-feature
git -C "$R" checkout -q feat/bar
git -C "$R" merge -q --no-edit main
lc 0 "A1: feature dirs INHERITED from the base do not trip A1" --all --repo "$R" --dir "$D" --base main
# ...but a stray the BRANCH adds is still caught, even alongside inherited ones.
mkdir -p "$R/.lifecycle/stray"
echo "# a second feature added by THIS branch" > "$R/.lifecycle/stray/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm branch-stray
lc 1 "A1: a branch-added stray is still REFUSED alongside inherited dirs" --all --repo "$R" --dir "$D" --base main

# --- A2: an uncommitted (dirty) working tree at phase 8 -> FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
echo "// stray uncommitted edit" >> "$R/src-app/server/src/modules/bar/repository.rs"
lc 1 "A2: dirty working tree at phase 8 is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A3: a diff-added #[ignore] -> phase 8 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\n#[ignore]\nfn skipped_test() {}\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-ignore
lc 1 "A3: a diff-added #[ignore] is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A3 (skip vs env-gate): `.skip(` is two different constructs. An
# UNCONDITIONAL skip disables the test forever and must be refused; a CONDITIONAL
# one is the framework's runtime dependency gate ("needs a real LLM / an API key")
# and must be allowed, or authors evade the check or delete the guard — both
# worse than what A3 defends against.
# build_perm (not build_be) because these cases add a .spec.ts: a frontend touch
# pulls in the npm-check + canary gates, and a backend-only fixture would then
# fail for reasons unrelated to A3 — the test would pass for the wrong reason.
R="$(build_perm)"; D="$R/.lifecycle/foo"
# build_perm deliberately ships WITHOUT the A10 restricted-user e2e so callers can
# add it; complete it here, or the control below fails on A10 rather than A3.
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [positive-control] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use still loads the app shell and can open the dashboard (positive control), and sees NO Foo nav entry, page, or Save button.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam complete-perm-fixture
SPEC="$R/src-app/ui/tests/e2e/foo/extra.spec.ts"; mkdir -p "$(dirname "$SPEC")"
lc 0 "A3-control: the perm fixture passes phase 8 before any skip is added" --phase 8 --repo "$R" --dir "$D" --base main
printf "import { test } from '@playwright/test'\ntest.skip('sorts by name', async () => {})\n" > "$SPEC"
git -C "$R" add -A && git -C "$R" commit -qm add-unconditional-skip
lc 1 "A3: an UNCONDITIONAL test.skip('name', fn) is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
printf "import { test } from '@playwright/test'\ntest.skip(true, 'nope')\n" > "$SPEC"
git -C "$R" commit -qam skip-true
lc 1 "A3: test.skip(true, …) — a skip dressed as a condition — is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
printf "import { test } from '@playwright/test'\ntest.only('just this one', async () => {})\n" > "$SPEC"
git -C "$R" commit -qam add-only
lc 1 "A3: .only( is still REFUSED (it disables every OTHER test)" --phase 8 --repo "$R" --dir "$D" --base main
printf "import { test } from '@playwright/test'\nconst HAS_KEY = !!process.env.ANTHROPIC_API_KEY\ntest.skip(!HAS_KEY, 'ANTHROPIC_API_KEY not set — real-LLM E2E skipped')\n" > "$SPEC"
git -C "$R" commit -qam env-gate
lc 0 "A3: a CONDITIONAL env gate test.skip(!HAS_KEY, …) is ALLOWED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A4: a cosmetic assert!(true) -> phase 8 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\nfn t() { assert!(true); }\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-cosmetic
lc 1 "A4: a cosmetic assert!(true) is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A5: TESTS.md that dropped a previously-committed test -> phase 3 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
# earlier commit had TEST-1 + TEST-2; now shrink to TEST-1.
# Both revisions keep TEST-1's [acceptance]/[invariant: INV-1] markers so the
# ONLY gap phase 3 can report on the shrunk revision is A5 — the gate under test.
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: one.
- **TEST-2** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/bar/bar.rs` — asserts: two.
EOF
git -C "$R" commit -qam tests-two
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: one.
EOF
git -C "$R" commit -qam tests-shrunk
lc 1 "A5: TESTS.md shrink (dropped TEST-2) is REFUSED" --phase 3 --repo "$R" --dir "$D" --base main

# --- FB-7 plan-coverage / descope gate ---
R="$(build_be)"; D="$R/.lifecycle/bar"
# (1) an extra PLAN item with no covering TEST and no descope -> bipartite FAIL
cat > "$D/PLAN.md" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path
  described there; the write path is out of scope for this round.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_bar to the bar repository.
- **ITEM-2**: A planned sub-feature.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
git -C "$R" commit -qam plan-item2 >/dev/null
lc 1 "FB-7: an uncovered PLAN item is REFUSED (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
# (2) mark ITEM-2 [DESCOPED] but with NO recorded approval -> still FAIL
cat > "$D/PLAN.md" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path
  described there; the write path is out of scope for this round.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_bar to the bar repository.
- **ITEM-2**: [DESCOPED] cut from this round.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
git -C "$R" commit -qam plan-descoped-unapproved >/dev/null
lc 1 "FB-7: a [DESCOPED] item without recorded approval is REFUSED (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
# (3) add an APPROVED descope disposition to DECISIONS.md -> PASS
printf '\n- DESCOPED: ITEM-2 — deferred to a follow-up [approved: human 2026-07]\n' >> "$D/DECISIONS.md"
git -C "$R" commit -qam descope-approved >/dev/null
lc 0 "FB-7: a [DESCOPED] item WITH an approved DECISIONS disposition passes (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main

# ---------------------------------------------------------------------------
# Fix 1 — owner-APPROVED TEST descope. A test covering an item that is BOTH
# [DESCOPED] in PLAN.md AND approved in DECISIONS.md is exempt from A5 (if its
# test was REMOVED) and from the phase-8 result-requirement (if KEPT enumerated).
# Gated by the SAME full FB-7 approval chain — an unapproved/undescoped item
# unlocks nothing.
# ---------------------------------------------------------------------------
# Shared grow-the-plan step: add ITEM-2 covered by TEST-2, committed as the PRIOR
# TESTS.md the A5 shrink-guard walks back to.
grow_item2() {
  local R="$1" D="$2"
  cat > "$D/PLAN.md" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_bar to the bar repository.
- **ITEM-2**: A sub-feature (section H) planned this round.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
  cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both rows.
- **TEST-2** (tier: integration) [covers: ITEM-2] file: `src-app/server/tests/bar/sub.rs` — asserts: the section-H sub-feature.
EOF
  git -C "$R" commit -qam grow-plan-item2 >/dev/null
}
# The PLAN.md with ITEM-2 marked [DESCOPED] (reused across cases).
plan_item2_descoped() {
  cat > "$1" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_bar to the bar repository.
- **ITEM-2**: [DESCOPED] section H, deferred to a follow-up issue.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
}

# (1a) POSITIVE — approved descope, TEST-2 REMOVED → A5 exempt (phase 3 PASS).
R="$(build_be)"; D="$R/.lifecycle/bar"
grow_item2 "$R" "$D"
plan_item2_descoped "$D/PLAN.md"
printf '\n- DESCOPED: ITEM-2 — section H deferred to issue #29 [approved: owner 2026-08]\n' >> "$D/DECISIONS.md"
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both rows.
EOF
git -C "$R" commit -qam descope-item2-drop-test2 >/dev/null
lc 0 "Fix1/A5: an APPROVED-descoped item's REMOVED test is exempt from A5 (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main

# (1b) NEGATIVE — descope WITHOUT approval, TEST-2 REMOVED → A5 still fires.
R="$(build_be)"; D="$R/.lifecycle/bar"
grow_item2 "$R" "$D"
plan_item2_descoped "$D/PLAN.md"   # [DESCOPED] but NO DECISIONS approval line
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both rows.
EOF
git -C "$R" commit -qam descope-unapproved-drop-test2 >/dev/null
lc 1 "Fix1/A5 anti-loophole: an UNapproved descope does NOT exempt the removed test (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
if grep -q "A5" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "Fix1/A5 anti-loophole: A5 still names itself for the unapproved descope"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "Fix1/A5 anti-loophole: A5 still names itself for the unapproved descope"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# (1c) NEGATIVE — removed test whose item is NOT [DESCOPED] → A5 fires (FB-7 kept
# satisfied by covering ITEM-2 with a DIFFERENT retained test, so ONLY A5 can speak).
R="$(build_be)"; D="$R/.lifecycle/bar"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — bar
## Design source
- `docs/design/bar.md` §1 "Bar listing" — this plan realizes the read path.
## Invariants
- **INV-1**: `list_bar` returns every bar row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_bar to the bar repository.
- **ITEM-2**: A sub-feature planned this round.
## Files to touch
- `src-app/server/src/modules/bar/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both rows.
- **TEST-2** (tier: integration) [covers: ITEM-2] file: `src-app/server/tests/bar/sub.rs` — asserts: the sub-feature (path A).
- **TEST-3** (tier: integration) [covers: ITEM-2] file: `src-app/server/tests/bar/sub2.rs` — asserts: the sub-feature (path B).
EOF
git -C "$R" commit -qam grow-item2-two-tests >/dev/null
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns both rows.
- **TEST-3** (tier: integration) [covers: ITEM-2] file: `src-app/server/tests/bar/sub2.rs` — asserts: the sub-feature (path B).
EOF
git -C "$R" commit -qam drop-test2-item-not-descoped >/dev/null
lc 1 "Fix1/A5 anti-loophole: a removed test whose item is NOT [DESCOPED] still fails A5 (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main

# (1d) POSITIVE — approved descope, TEST-2 KEPT enumerated with NO PASS line →
# exempt from the phase-8 result-requirement.
R="$(build_be)"; D="$R/.lifecycle/bar"
grow_item2 "$R" "$D"
plan_item2_descoped "$D/PLAN.md"
printf '\n- DESCOPED: ITEM-2 — section H deferred to issue #29 [approved: owner 2026-08]\n' >> "$D/DECISIONS.md"
# TESTS.md still enumerates TEST-2 (covers the descoped-approved ITEM-2);
# TEST_RESULTS.md records NO result for it — build_be's TEST_RESULTS has only TEST-1.
git -C "$R" commit -qam descope-item2-keep-test2 >/dev/null
lc 0 "Fix1/phase8: an approved-descoped item's KEPT test needs no PASS line (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# (1e) NEGATIVE — same KEPT test but the descope is UNapproved → phase-8 still
# demands a PASS for TEST-2 (the exemption is approval-gated).
R="$(build_be)"; D="$R/.lifecycle/bar"
grow_item2 "$R" "$D"
plan_item2_descoped "$D/PLAN.md"   # [DESCOPED] but no DECISIONS approval
git -C "$R" commit -qam descope-unapproved-keep-test2 >/dev/null
lc 1 "Fix1/phase8 anti-loophole: an UNapproved descope's kept test still needs a PASS (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# ---------------------------------------------------------------------------
# Fix 2 — [standing-gate] disposition. A `[standing-gate]` TEST asserts the
# branch's code passes a STANDING repo-wide gate (`npm run check` / `gate:ui`),
# not a branch-authored test. It is exempt from A11's branch-authorship rule and
# its phase-8 result-requirement is discharged by a recorded green standing-gate
# line — but ONLY when that line is present, and NEVER on an [acceptance] test.
# ---------------------------------------------------------------------------
# add_standing_test <repo> <dir> — appends an UNEARNED standing-gate TEST-3 whose
# declared file the branch never touched and whose id is cited in no added line.
add_standing_test() {
  cat >> "$2/TESTS.md" <<'EOF'
- **TEST-3** (tier: integration) [standing-gate] [covers: ITEM-1] file: `scripts/domain-lint.mjs` — asserts: the branch's code passes domain-lint (a standing repo-wide gate run by npm run check).
EOF
}

# (2a) POSITIVE — [standing-gate] TEST-3 recorded PASS WITH an `npm run check
# (ui): PASS` line present → A11 exempt + phase-8 discharged (phase 8 PASS).
R="$(build_be)"; D="$R/.lifecycle/bar"
add_standing_test "$R" "$D"
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-3**: PASS
npm run check (ui): PASS
EOF
git -C "$R" commit -qam standing-gate-with-green-line >/dev/null
lc 0 "Fix2: a [standing-gate] test WITH 'npm run check (ui): PASS' present passes A11 + phase 8" --phase 8 --repo "$R" --dir "$D" --base main

# (2b) NEGATIVE — the SAME [standing-gate] test WITHOUT the npm-check PASS line →
# fails (A11 fires + the standing-gate result-requirement fires).
R="$(build_be)"; D="$R/.lifecycle/bar"
add_standing_test "$R" "$D"
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-3**: PASS
EOF
git -C "$R" commit -qam standing-gate-no-green-line >/dev/null
lc 1 "Fix2 anti-loophole: a [standing-gate] test WITHOUT the npm-check PASS line FAILS (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main
if grep -q "A11\|standing-gate" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "Fix2 anti-loophole: the refusal names A11/standing-gate"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "Fix2 anti-loophole: the refusal names A11/standing-gate"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# (2c) NEGATIVE — [standing-gate] + [acceptance] together is REJECTED at phase 3
# (an invariant proof cannot be discharged by a standing gate).
R="$(build_be)"; D="$R/.lifecycle/bar"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-3** (tier: integration) [standing-gate] [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `scripts/domain-lint.mjs` — asserts: the invariant holds via a standing gate.
EOF
git -C "$R" commit -qam standing-gate-plus-acceptance >/dev/null
lc 1 "Fix2 anti-loophole: [standing-gate] + [acceptance] together is REJECTED (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main

# (2d) CONTROL — the ORIGINAL A11 catch still fires: an unearned PASS with NO
# standing-gate tag (an inherited PASS from another feature's namespace) FAILS.
R="$(build_be)"; D="$R/.lifecycle/bar"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-3** (tier: integration) [covers: ITEM-1] file: `scripts/domain-lint.mjs` — asserts: an unrelated claim, in a file this branch never touched.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-3**: PASS
npm run check (ui): PASS
EOF
git -C "$R" commit -qam unearned-no-standing-tag >/dev/null
lc 1 "Fix2 CONTROL: an unearned PASS with NO [standing-gate] tag STILL fails A11 (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# --- A8: a built-in MCP server without BOTH mcp.rs edits -> FAIL; with both -> PASS
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\nfn bar_mcp_server_id() -> u32 { 1 }\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-mcp
lc 1 "A8: built-in MCP w/o auto_attach_builtin_ids+is_builtin_server_id is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
printf '// wires auto_attach_builtin_ids + is_builtin_server_id\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-mcp-wiring
lc 0 "A8: built-in MCP WITH both mcp.rs edits passes" --phase 8 --repo "$R" --dir "$D" --base main

# --- A9: a new permission without a DENY test -> FAIL; with a 403 test -> PASS
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\nconst PERMISSION: &str = "bar::use";\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-perm
lc 1 "A9: new permission without a deny/403 test is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
mkdir -p "$R/src-app/server/tests/bar"
cat > "$R/src-app/server/tests/bar/bar.rs" <<'EOF'
// TEST-2 (ITEM-1) — a caller lacking bar::use is refused.
#[test]
fn lacking_bar_use_is_forbidden() { assert_eq!(deny_status(), 403); }
EOF
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-2** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/bar/bar.rs` — asserts: a user lacking bar::use gets 403 forbidden.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-2**: PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm add-deny-test
lc 0 "A9: new permission WITH a 403 deny test passes" --phase 8 --repo "$R" --dir "$D" --base main

# --- A10: a new user-facing permission (::use/::read/::manage) needs a
#     RESTRICTED-USER e2e (frontend-hidden), not only the A9 backend deny.

# A10-1: perm introduced in permissions.rs, NO [negative-perm] e2e -> phase 3 + 8 FAIL
R="$(build_perm)"; D="$R/.lifecycle/foo"
lc 1 "A10: new ::use perm without a restricted-user e2e is REFUSED (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
lc 1 "A10: new ::use perm without a restricted-user e2e is REFUSED (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# A10-2: a [negative-perm] tag on a NON-e2e (integration) test does NOT satisfy
#        A10 — a 403/deny test is A9; the frontend proof MUST be tier: e2e.
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: integration) [negative-perm] [covers: ITEM-1] file: `src-app/server/tests/foo/foo.rs` — asserts: 403 without foo::use.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam mistagged-integration
lc 1 "A10: a [negative-perm] tag on a NON-e2e test does NOT satisfy A10" --phase 8 --repo "$R" --dir "$D" --base main

# A10-3: add the restricted-user e2e -> phase 3 + 8 PASS (A9 backend + A10 frontend both present)
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [positive-control] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use still loads the app shell and can open the dashboard (positive control), and sees NO Foo nav entry, page, or Save button.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam add-negperm-e2e
lc 0 "A10: new ::use perm WITH a restricted-user e2e passes (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
lc 0 "A10: new ::use perm WITH a restricted-user e2e passes (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# A10-4: the restricted-user e2e is enumerated but its RESULT is FAIL -> phase 8 FAIL
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [positive-control] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use still loads the app shell and can open the dashboard (positive control), and sees no Foo UI.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: FAIL
EOF
git -C "$R" commit -qam negperm-e2e-fails
lc 1 "A10: an enumerated-but-FAILING restricted-user e2e is REFUSED (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# A10-5: a permission GRANTED IN A MIGRATION (no permissions.rs const, so A9
#        does NOT fire) still requires a restricted-user e2e — A10 catches what
#        A9 misses.
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig-10
git -C "$R" checkout -q -b feat/permmig
mkdir -p "$R/.lifecycle/foo"
cat > "$R/src-app/server/migrations/00000000000011_grant_foo.sql" <<'EOF'
-- grant foo::use to the default Users group (mirrors migration 98)
UPDATE groups SET permissions = array_append(permissions, 'foo::use') WHERE name = 'Users';
EOF
# The tests the plan enumerates (A11).
mkdir -p "$R/src-app/server/tests/foo" "$R/src-app/ui/tests/e2e/foo"
cat > "$R/src-app/server/tests/foo/foo.rs" <<'EOF'
// TEST-1 (ITEM-1, INV-1) — the Users group gains foo::use after migration.
#[test]
fn users_group_gains_foo_use() { assert!(users_perms().contains(&"foo::use")); }
EOF
cat > "$R/src-app/ui/tests/e2e/foo/perm-gating.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the restricted user reaches the app and sees no Foo UI.
import { expect, test } from '@playwright/test';
test('restricted user: dashboard loads, Foo is absent', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Foo' })).toHaveCount(0);
});
EOF
D="$R/.lifecycle/foo"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §4 "Foo access control" — this plan realizes the default
  grant described there.
## Invariants
- **INV-1**: The default Users group holds `foo::use` after migration.
## Items
- **ITEM-1**: Grant foo::use to the default Users group (migration).
## Files to touch
- `src-app/server/migrations/00000000000011_grant_foo.sql` — grant (ITEM-1).
## Patterns to follow
- Mirror migration 98 (idempotent grant).
EOF
write_common "$D" "src-app/server/migrations/00000000000011_grant_foo.sql" 2
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: integration) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/tests/foo/foo.rs` — asserts: the Users group gains foo::use.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm feat-permmig
lc 1 "A10: a migration granting ::use without a restricted-user e2e is REFUSED (A9 alone misses it)" --phase 8 --repo "$R" --dir "$D" --base main
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-2** (tier: e2e) [negative-perm] [positive-control] [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use still loads the app shell and can open the dashboard (positive control), and sees no Foo UI.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-2**: PASS
npm run check (ui): PASS
gate:ui (ui): PASS
EOF
git -C "$R" commit -qam add-negperm-mig
lc 0 "A10: the migration grant WITH a restricted-user e2e passes (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# --- A7: a UI diff whose results omit the boot/runtime canary -> phase 8 FAIL
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/ui
mkdir -p "$R/src-app/ui/src/modules/foo" "$R/.lifecycle/foo"
cat > "$R/src-app/ui/src/modules/foo/FooPage.tsx" <<'EOF'
export function FooPage() {
  return <div><h1>Foo</h1><button>Save</button></div>;
}
EOF
# The tests the plan enumerates (A11: a recorded PASS must be bound to something
# this branch wrote — the id cited in an added line, or the declared `file:` touched).
mkdir -p "$R/src-app/ui/tests/e2e/foo"
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
cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the user journey: open Foo, press Save.
import { expect, test } from '@playwright/test';
test('opens Foo and saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
D="$R/.lifecycle/foo"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §2 "Foo surface" — this plan realizes the single-action
  Foo page described there.
## Invariants
- **INV-1**: The Foo surface exposes exactly one Save affordance.
## Items
- **ITEM-1**: Add a FooPage component.
## Files to touch
- `src-app/ui/src/modules/foo/FooPage.tsx` — new page (ITEM-1).
## Patterns to follow
- Mirror an existing settings page.
EOF
write_common "$D" "src-app/ui/src/modules/foo/FooPage.tsx" 3
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: renders exactly one Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user clicks Save.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
npm run check (ui): PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm feat-ui-no-canary
lc 1 "A7: UI results missing the boot/runtime canary line is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
printf 'gate:ui (ui): PASS\n' >> "$D/TEST_RESULTS.md"
git -C "$R" commit -qam add-canary
lc 0 "A7: UI results WITH gate:ui canary passes" --phase 8 --repo "$R" --dir "$D" --base main

# --- R2-5: an e2e route-mock pointing at a route not in openapi.json -> FAIL;
#     fixing it to a live route -> PASS. (Needs an openapi.json to check against.)
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/mock
mkdir -p "$R/src-app/ui/openapi" "$R/src-app/ui/tests/e2e/foo" "$R/.lifecycle/foo"
echo '{"paths":{"/api/things":{"get":{}},"/api/things/{id}":{"get":{}}}}' > "$R/src-app/ui/openapi/openapi.json"
cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
import { test } from '@playwright/test';
test('foo', async ({ page }) => {
  await page.route('**/api/ghosts', (r) => r.fulfill({ json: [] }));
});
EOF
D="$R/.lifecycle/foo"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §3 "Things flow" — this plan realizes the e2e coverage
  of the things list described there.
## Invariants
- **INV-1**: The things list is rendered from the live `/api/things` route, never a fabricated one.
## Items
- **ITEM-1**: Add an e2e spec for the things flow.
## Files to touch
- `src-app/ui/tests/e2e/foo/foo.spec.ts` — new spec (ITEM-1).
## Patterns to follow
- Mirror an existing e2e spec.
EOF
write_common "$D" "src-app/ui/tests/e2e/foo/foo.spec.ts" 5
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: e2e) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: things list renders from /api/things.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
npm run check (ui): PASS
gate:ui (ui): PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm feat-mock-ghost
lc 1 "R2-5: e2e mock of an unknown /api/ route is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
# fix the mock to a live route
sed 's#\*\*/api/ghosts#**/api/things#' "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" > "$R/tmp.ts" && mv "$R/tmp.ts" "$R/src-app/ui/tests/e2e/foo/foo.spec.ts"
git -C "$R" commit -qam fix-mock
lc 0 "R2-5: e2e mock of a live /api/ route passes" --phase 8 --repo "$R" --dir "$D" --base main

# ---------------------------------------------------------------------------
echo "-- Part B: merge-gate.mjs (deterministic gates, --skip-heavy) --"
# ---------------------------------------------------------------------------
# build_mg <branch-migration-file> — main has migration 10; branch adds the
# given file. Echoes repo root; branch = feat/mig.
build_mg() {
  local branchmig="$1"; local R; R="$(new_repo)"; CLEANUP+=("$R")
  mkdir -p "$R/src-app/server/migrations"
  write_ziee_appconfig "$R"
  echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
  git -C "$R" add -A && git -C "$R" commit -qm mig-10
  git -C "$R" checkout -q -b feat/mig
  echo "CREATE TABLE b();" > "$R/src-app/server/migrations/$branchmig"
  git -C "$R" add -A && git -C "$R" commit -qm branch-mig
  echo "$R"
}

# clean: branch migration 11 > main max 10
R="$(build_mg 00000000000011_b.sql)"
assert_exit_cmd 0 "merge-gate: clean branch (mig 11 > 10) passes" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy

# C2 collision: branch migration 09 <= main max 10
R="$(build_mg 00000000000009_early.sql)"
assert_exit_cmd 1 "merge-gate C2: migration <= main max is REFUSED" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy

# --- STALE-REF guard: a bare branch name must never silently grade a local ref
# that is behind its remote. This is the real-world failure it exists for: the
# gate once graded a local branch 430 commits behind origin and reported eleven
# file conflicts that did not exist on the branch anyone was landing.
#
# Proven BOTH ways, and the negative control matters more than the positive:
# without an ahead-only allowance the guard would block legitimate pre-push
# gating of unpushed work.
R="$(new_repo)"; CLEANUP+=("$R")
write_ziee_appconfig "$R"
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig-10
git -C "$R" checkout -q -b feat/mig
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000011_b.sql"
git -C "$R" add -A && git -C "$R" commit -qm branch-mig
# Fabricate a remote that is AHEAD of the local branch (one extra commit on a
# refs/remotes/origin/feat/mig ref — no network, no real remote needed).
git -C "$R" update-ref refs/remotes/origin/feat/mig "$(git -C "$R" rev-parse feat/mig)"
echo "CREATE TABLE c();" > "$R/src-app/server/migrations/00000000000012_c.sql"
git -C "$R" add -A && git -C "$R" commit -qm remote-only
git -C "$R" update-ref refs/remotes/origin/feat/mig "$(git -C "$R" rev-parse HEAD)"
git -C "$R" reset -q --hard HEAD~1   # local falls BEHIND its remote
assert_exit_cmd 1 "merge-gate: a branch BEHIND its remote is REFUSED (stale-ref guard)" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy
if grep -qiE "STALE ref" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: stale-ref refusal names the reason (not a generic failure)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: stale-ref refusal names the reason (not a generic failure)"
fi
# Same repo, addressed by the REMOTE ref: must pass — the escape hatch the
# refusal message tells the user about has to actually work.
assert_exit_cmd 0 "merge-gate: the suggested 'origin/<branch>' re-run PASSES" -- \
  node "$MG" origin/feat/mig --repo "$R" --base main --no-fetch --skip-heavy
# NEGATIVE CONTROL: local AHEAD of remote is normal pre-push gating, not stale.
# Without this the guard would be indistinguishable from "refuse any divergence".
R="$(build_mg 00000000000011_b.sql)"
git -C "$R" update-ref refs/remotes/origin/feat/mig "$(git -C "$R" rev-parse feat/mig~1)"
assert_exit_cmd 0 "merge-gate: local AHEAD of remote still passes (unpushed work)" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy

# de-ziee-ify + UNCONFIGURED-INPUT PROBE.
#
# This pair USED to assert that no `.claude/app.config` ⇒ C2 SKIPs, and that the
# colliding migration above therefore passed. That is the defect, not the feature:
# comic shipped an app.config with MERGE_MIGRATIONS_DIR simply absent while eight
# migrations sat in the tree, and every run printed "no migrations dir" — the SECOND
# time C2 was found inert. Unset now means "look before you skip".
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig-10
git -C "$R" checkout -q -b feat/mig
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000009_early.sql"
git -C "$R" add -A && git -C "$R" commit -qm branch-mig
assert_exit_cmd 1 "merge-gate C2: NO app.config but migrations EXIST ⇒ hard FAIL, not SKIP" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy
# The diagnosis must name the missing key and the roots it found, or the operator
# cannot act on it.
if grep -qE "MERGE_MIGRATIONS_DIR is UNSET" "$LC_SELFTEST_OUT" && grep -qF "src-app/server/migrations" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate C2: the diagnosis names the unset key AND the root it should be"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate C2: unset-key diagnosis is not actionable"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi
# CONTROL — an app that genuinely has NO migrations still SKIPs (the probe finds
# nothing), so the app-agnostic contract is preserved for apps without a database.
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/nomig
echo "hello" > "$R/src.txt"; git -C "$R" add -A && git -C "$R" commit -qm no-migrations
assert_exit_cmd 0 "merge-gate C2 CONTROL: no app.config AND no migrations anywhere ⇒ SKIP" -- \
  node "$MG" feat/nomig --repo "$R" --base main --no-fetch --skip-heavy
if grep -qE "C2.*SKIP" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate C2 CONTROL: the C2 line explicitly reads SKIP (not PASS)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate C2 CONTROL: did not report SKIP"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# crash-guard regression: a MISSING MERGE_REGEN_CMD binary must record a clean
# C3 FAIL, not throw a TypeError on undefined stdout. Runs WITHOUT --skip-heavy
# so C3 actually executes the (nonexistent) regen command.
R="$(new_repo)"; CLEANUP+=("$R"); mkdir -p "$R/.claude"
printf 'MERGE_MIGRATIONS_DIR=migrations\nMERGE_REGEN_CMD=ziee-nonexistent-regen-binary-xyz\nMERGE_GENERATED=gen.txt\n' > "$R/.claude/app.config"
echo hi > "$R/gen.txt"; git -C "$R" add -A && git -C "$R" commit -qm base-c3
git -C "$R" checkout -q -b feat/c3
echo change > "$R/f.txt"; git -C "$R" add -A && git -C "$R" commit -qm work-c3
C3OUT="$(node "$MG" feat/c3 --repo "$R" --base main --no-fetch 2>&1)"
if printf '%s' "$C3OUT" | grep -qiE "C3.*(could not run|FAIL)" && ! printf '%s' "$C3OUT" | grep -qE "TypeError|is not a function|Cannot read (properties|property)"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate C3: missing regen binary records a clean FAIL (no crash)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate C3: missing regen binary — crashed or no clean FAIL"
  printf '%s\n' "$C3OUT" | sed 's/^/        | /'
fi

# C4 stale: main advances after fork; branch is behind; --max-behind 0
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
write_ziee_appconfig "$R"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig-10
git -C "$R" checkout -q -b feat/stale
echo "x" > "$R/x.txt"; git -C "$R" add -A && git -C "$R" commit -qm branch-work
git -C "$R" checkout -q main
echo "y" > "$R/y.txt"; git -C "$R" add -A && git -C "$R" commit -qm main-advance
assert_exit_cmd 1 "merge-gate C4: a branch behind main (--max-behind 0) is REFUSED" -- \
  node "$MG" feat/stale --repo "$R" --base main --no-fetch --skip-heavy --max-behind 0

# staging PROVISIONING: `git worktree add` gives the TRACKED tree only, so a
# submodule's working tree is EMPTY and a gitignored per-machine config is absent
# → C1/C3 fail SPURIOUSLY. Prove the gate provisions both. The regen command here
# IS the assertion: it exits non-zero unless BOTH the submodule content and the
# declared gitignored file are present in the staging tree.
R="$(new_repo)"; CLEANUP+=("$R"); mkdir -p "$R/.claude" "$R/cfg"
S="$(new_repo)"; CLEANUP+=("$S")
echo "submodule-source" > "$S/marker.txt"
git -C "$S" add -A && git -C "$S" commit -qm sub-content
git -C "$R" config protocol.file.allow always
git -C "$R" -c protocol.file.allow=always submodule add -q "$S" sub >/dev/null 2>&1
cat > "$R/assert-staging.sh" <<'EOF'
#!/usr/bin/env bash
# stands in for `just openapi-regen`: the codegen needs BOTH the submodule
# sources and the gitignored dev config.
test -f sub/marker.txt || { echo "failed to read sub/marker.txt"; exit 1; }
test -f cfg/dev.yaml   || { echo "no config file found"; exit 1; }
exit 0
EOF
chmod +x "$R/assert-staging.sh"
# gen.txt is declared too, but it is TRACKED — it must be REFUSED (the merged
# tree is authoritative; copying the live version could mask a real failure).
printf 'MERGE_REGEN_CMD=./assert-staging.sh\nMERGE_GENERATED=gen.txt\nMERGE_STAGING_COPY_FILES=cfg/dev.yaml gen.txt\n' > "$R/.claude/app.config"
echo "generated" > "$R/gen.txt"
printf 'cfg/dev.yaml\n' > "$R/.gitignore"
git -C "$R" add -A && git -C "$R" commit -qm base-provision
echo "secret: per-machine" > "$R/cfg/dev.yaml"   # gitignored ⇒ never in a worktree
git -C "$R" checkout -q -b feat/provision
echo work > "$R/w.txt"; git -C "$R" add -A && git -C "$R" commit -qm work-provision
# GIT_ALLOW_PROTOCOL=file is a FIXTURE-only need: git refuses `file://` submodule
# clones (CVE-2022-39253) and honors the relaxation only from the command line /
# this env var, never from repo config. Real consumers use https/ssh submodules.
export GIT_ALLOW_PROTOCOL=file
assert_exit_cmd 0 "merge-gate: staging is provisioned (submodules + declared gitignored config) ⇒ C3 PASSes" -- \
  node "$MG" feat/provision --repo "$R" --base main --no-fetch
if grep -qE "staging: submodules checked out" "$LC_SELFTEST_OUT" \
   && grep -qE 'staging: copied gitignored "cfg/dev.yaml"' "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: staging provisioning is reported on stdout (submodules + copy)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: staging provisioning was not reported"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi
if grep -qE 'staging: MERGE_STAGING_COPY_FILES: "gen.txt" is TRACKED by git — NOT copied' "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: a TRACKED declared copy path is REFUSED (merged tree stays authoritative)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: a TRACKED declared copy path was not refused"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# fail-SOFT but LOUD: a DECLARED copy file that is absent from the repo must warn
# clearly and let the gate fail for its REAL reason — never be silently skipped.
rm -f "$R/cfg/dev.yaml"
MISSOUT="$(node "$MG" feat/provision --repo "$R" --base main --no-fetch 2>&1 || true)"
if printf '%s' "$MISSOUT" | grep -qE 'staging: MERGE_STAGING_COPY_FILES: "cfg/dev.yaml" is ABSENT' \
   && printf '%s' "$MISSOUT" | grep -qE "C3.*FAIL" \
   && printf '%s' "$MISSOUT" | grep -qE "no config file found"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: an ABSENT declared copy file warns loudly and the gate still FAILs honestly"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: absent declared copy file — no warning or no honest FAIL"
  printf '%s\n' "$MISSOUT" | sed 's/^/        | /'
fi
unset GIT_ALLOW_PROTOCOL

# ---------------------------------------------------------------------------
# C3 parity is DERIVED, not declared: a generated file the merge resolved by
# TAKING A SIDE must fail even when MERGE_GENERATED does not name it. This is
# the cytoanalyst defect — `just openapi-regen` wrote five files against a
# two-entry list, and C3 scoped its diff TO the list, so the other three were
# silently exempt from the whole point of the gate.
# Fixture: regen.sh writes declared.txt AND undeclared.txt; the branch commits a
# side-taken (wrong) undeclared.txt. ONLY an unscoped parity diff catches it.
# ---------------------------------------------------------------------------
mk_regen_repo() {   # $1 = content committed for undeclared.txt on the branch
  local R; R="$(new_repo)"; mkdir -p "$R/.claude"
  cat > "$R/regen.sh" <<'EOF'
#!/usr/bin/env bash
# stands in for `just openapi-regen`: TWO outputs, one of them undeclared.
printf 'declared-canonical\n'   > declared.txt
printf 'undeclared-canonical\n' > undeclared.txt
exit 0
EOF
  chmod +x "$R/regen.sh"
  printf 'MERGE_REGEN_CMD=./regen.sh\nMERGE_GENERATED=declared.txt\n' > "$R/.claude/app.config"
  printf 'declared-canonical\n'   > "$R/declared.txt"
  printf 'undeclared-canonical\n' > "$R/undeclared.txt"
  git -C "$R" add -A && git -C "$R" commit -qm base-regen
  git -C "$R" checkout -q -b feat/regen
  printf '%s\n' "$1" > "$R/undeclared.txt"
  echo work > "$R/w.txt"
  git -C "$R" add -A && git -C "$R" commit -qm work-regen
  echo "$R"
}

# (1) side-taken UNDECLARED generated file ⇒ C3 must FAIL (exit 1).
R="$(mk_regen_repo 'took-one-side-instead-of-regenerating')"; CLEANUP+=("$R")
SIDEOUT="$(node "$MG" feat/regen --repo "$R" --base main --no-fetch 2>&1 || true)"
if printf '%s' "$SIDEOUT" | grep -qE "C3 .*regen-parity .*FAIL" \
   && printf '%s' "$SIDEOUT" | grep -q "undeclared.txt"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate C3: a side-taken generated file NOT in MERGE_GENERATED still FAILs (parity is derived from git)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate C3: an UNDECLARED side-taken generated file slipped through"
  printf '%s\n' "$SIDEOUT" | sed 's/^/        | /'
fi

# (2) C6 generated-coverage: even with parity CLEAN, a regen output the config
# does not name must be reported LOUDLY — so the next omission cannot be silent.
R="$(mk_regen_repo 'undeclared-canonical')"; CLEANUP+=("$R")
COVOUT="$(node "$MG" feat/regen --repo "$R" --base main --no-fetch 2>&1 || true)"
if printf '%s' "$COVOUT" | grep -qE "C3 .*regen-parity .*PASS" \
   && printf '%s' "$COVOUT" | grep -qE "C6 .*generated-coverage .*FAIL" \
   && printf '%s' "$COVOUT" | grep -q "undeclared.txt"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate C6: a regen output missing from MERGE_GENERATED FAILs even when parity is clean"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate C6: an omission from MERGE_GENERATED was not reported"
  printf '%s\n' "$COVOUT" | sed 's/^/        | /'
fi

# (3) negative control: with BOTH outputs declared, the same tree is fully green
# (C6 must not be a check that can only fail).
R="$(mk_regen_repo 'undeclared-canonical')"; CLEANUP+=("$R")
printf 'MERGE_REGEN_CMD=./regen.sh\nMERGE_GENERATED=declared.txt undeclared.txt\n' > "$R/.claude/app.config"
assert_exit_cmd 0 "merge-gate C3+C6: a COMPLETE MERGE_GENERATED list on a correctly-regenerated merge is green" -- \
  node "$MG" feat/regen --repo "$R" --base main --no-fetch

# ---------------------------------------------------------------------------
echo "-- Part C: preflight.sh (env gate) --"
# ---------------------------------------------------------------------------
# good: hub-seed + pgvector + node_modules present (+ ziee-shaped app.config so
# the de-ziee-ified checks activate exactly as they did when hard-coded).
GOOD="$(new_repo)"; CLEANUP+=("$GOOD")
write_ziee_appconfig "$GOOD"
mkdir -p "$GOOD/src-app/server/binaries/hub-seed" \
         "$GOOD/src-app/server/vendor/pgvector" \
         "$GOOD/src-app/server/config" \
         "$GOOD/node_modules"
echo '{"hub_version":"v0.0.0"}' > "$GOOD/src-app/server/binaries/hub-seed/index.json"
echo 'all:' > "$GOOD/src-app/server/vendor/pgvector/Makefile"
# a real repo always ships config/dev.example.yaml; check #7 auto-seeds dev.yaml from it.
printf 'jwt:\n  secret: "dev-secret-change-in-production-min-32-chars-long"\n' \
  > "$GOOD/src-app/server/config/dev.example.yaml"
assert_exit_cmd 0 "preflight: fully-provisioned env passes" -- \
  env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$GOOD"

# --- placeholder detection is about the VALUE, not one spelling of it --------
#
# The check used to interpolate the placeholder into `secret:[[:space:]]*"…"`
# — double quotes literally in the pattern — so it saw ONE of the three
# spellings YAML accepts. Each case below is the SAME unsubstituted secret the
# server hard-refuses to boot on, and each must be REFUSED (exit 1). The
# unquoted case is the regression: it used to print
# "ok  … present with a non-placeholder jwt.secret".
PH='dev-secret-change-in-production-min-32-chars-long'
for spelling in 'double' 'bare' 'single' 'trailing-space' 'block-scalar'; do
  case "$spelling" in
    double)         printf 'jwt:\n  secret: "%s"\n' "$PH" ;;
    bare)           printf 'jwt:\n  secret: %s\n' "$PH" ;;
    single)         printf "jwt:\n  secret: '%s'\n" "$PH" ;;
    'trailing-space') printf 'jwt:\n  secret: "%s"   \n' "$PH" ;;
    block-scalar)   printf 'jwt:\n  secret: >-\n    %s\n' "$PH" ;;
  esac > "$GOOD/src-app/server/config/dev.yaml"
  assert_exit_cmd 1 "preflight: placeholder jwt.secret ($spelling) is REFUSED" -- \
    env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$GOOD"
done
# NEGATIVE CONTROL — without it "refuse everything" would score 5/5. A real
# secret that merely CONTAINS the word `secret`, and a comment that quotes the
# placeholder verbatim (documentation, not configuration), must both pass.
printf 'jwt:\n  # replace "%s" with a random value\n  secret: "kP3q8Zx-not-the-placeholder-just-a-long-random-value-49ch"\n' "$PH" \
  > "$GOOD/src-app/server/config/dev.yaml"
assert_exit_cmd 0 "preflight: a real jwt.secret passes (placeholder only in a comment)" -- \
  env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$GOOD"

# --- and the SEED path carried the same quoted-only assumption ---------------
# `dev.example.yaml` with an UNQUOTED placeholder could not be seeded at all:
# the guard grepped for `"PLACEHOLDER"` and reported the example as not
# containing its own placeholder. Seeding must work from every spelling, and
# the result must be a config that then PASSES.
for spelling in 'double' 'bare' 'single'; do
  rm -f "$GOOD/src-app/server/config/dev.yaml"
  case "$spelling" in
    double) printf 'jwt:\n  secret: "%s"\n' "$PH" ;;
    bare)   printf 'jwt:\n  secret: %s\n' "$PH" ;;
    single) printf "jwt:\n  secret: '%s'\n" "$PH" ;;
  esac > "$GOOD/src-app/server/config/dev.example.yaml"
  assert_exit_cmd 0 "preflight: seeds dev.yaml from a $spelling-quoted example" -- \
    env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$GOOD"
  if [ -f "$GOOD/src-app/server/config/dev.yaml" ] && \
     ! grep -qF -- "$PH" "$GOOD/src-app/server/config/dev.yaml"; then
    PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "preflight: seeded dev.yaml ($spelling example) has no placeholder left"
  else
    FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "preflight: seeded dev.yaml ($spelling example) still holds the placeholder"
  fi
done
# a placeholder full of REGEX METACHARACTERS must be matched literally — the old
# sed interpolated it into a pattern, so `.`/`*`/`[` matched the wrong span.
META="$(new_repo)"; CLEANUP+=("$META")
write_ziee_appconfig "$META"
sed -i 's|^PREFLIGHT_CONFIG_PLACEHOLDER=.*|PREFLIGHT_CONFIG_PLACEHOLDER=RE.PLACE[ME]*|' "$META/.claude/app.config"
mkdir -p "$META/src-app/server/binaries/hub-seed" "$META/src-app/server/vendor/pgvector" \
         "$META/src-app/server/config" "$META/node_modules"
echo '{"hub_version":"v0.0.0"}' > "$META/src-app/server/binaries/hub-seed/index.json"
echo 'all:' > "$META/src-app/server/vendor/pgvector/Makefile"
printf 'jwt:\n  secret: "RE.PLACE[ME]*"\n' > "$META/src-app/server/config/dev.example.yaml"
printf 'jwt:\n  secret: RE.PLACE[ME]*\n' > "$META/src-app/server/config/dev.yaml"
assert_exit_cmd 1 "preflight: a placeholder containing regex metacharacters is matched LITERALLY" -- \
  env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$META"
rm -f "$GOOD/src-app/server/config/dev.yaml"
printf 'jwt:\n  secret: "%s"\n' "$PH" > "$GOOD/src-app/server/config/dev.example.yaml"

# bad: hub-seed missing (build.rs would PANIC) — app.config present so the seed
# + node_modules checks are ACTIVE and fail.
BAD="$(new_repo)"; CLEANUP+=("$BAD")
write_ziee_appconfig "$BAD"
assert_exit_cmd 1 "preflight: missing hub-seed/node_modules is REFUSED" -- \
  env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$BAD"

# de-ziee-ify: with NO app.config, every app-specific preflight check SKIPs and
# the gate exits 0 on the generic checks only (a fresh app pre-app.config is not
# hard-blocked by ziee's server prerequisites).
NOCFG="$(new_repo)"; CLEANUP+=("$NOCFG")
assert_exit_cmd 0 "preflight: NO app.config ⇒ generic-only, exit 0" -- \
  env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$NOCFG"

# SECURITY regression: a malicious PREFLIGHT_BUILD_DB_ENV must be rejected before
# bash ${!name} indirect expansion — a config value must NEVER execute code.
INJ="$(new_repo)"; CLEANUP+=("$INJ"); mkdir -p "$INJ/.claude"
INJMARK="$INJ/INJECTION_EXECUTED"
printf 'PREFLIGHT_BUILD_DB_ENV=x[$(touch %s)]\nPREFLIGHT_BUILD_DB_HOSTPORT=127.0.0.1:5999\n' "$INJMARK" > "$INJ/.claude/app.config"
env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$INJ" >"$LC_SELFTEST_OUT" 2>&1 || true
if [ -e "$INJMARK" ]; then
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "preflight: malicious PREFLIGHT_BUILD_DB_ENV EXECUTED code (injection)"
else
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "preflight: malicious PREFLIGHT_BUILD_DB_ENV does NOT execute code (injection guard)"
fi

# ---------------------------------------------------------------------------
echo "-- Part D: merge-gate --verify-head (the pre-push-to-main hook guard) --"
# ---------------------------------------------------------------------------
# clean HEAD: one migration, no .lifecycle
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
write_ziee_appconfig "$R"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig
assert_exit_cmd 0 "verify-head: clean HEAD passes" -- node "$MG" --verify-head --repo "$R"

# C5: HEAD still carries .lifecycle/ artifacts
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/.lifecycle/foo"
echo "# plan" > "$R/.lifecycle/foo/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm leaked-lifecycle
assert_exit_cmd 1 "verify-head C5: leaked .lifecycle/ on HEAD is REFUSED" -- node "$MG" --verify-head --repo "$R"

# C2: HEAD has two migrations with the same number prefix
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
write_ziee_appconfig "$R"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000010_b.sql"
git -C "$R" add -A && git -C "$R" commit -qm dup-mig
assert_exit_cmd 1 "verify-head C2: duplicate migration prefix on HEAD is REFUSED" -- node "$MG" --verify-head --repo "$R"

# UNCONFIGURED-INPUT PROBE on the verify-head path — same rule as the branch path:
# unset MERGE_MIGRATIONS_DIR with migrations present is a misconfiguration, and the
# duplicate prefix below must NOT slip onto main behind a "no migrations dir" skip.
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000010_b.sql"
git -C "$R" add -A && git -C "$R" commit -qm dup-mig
assert_exit_cmd 1 "verify-head C2: NO app.config but migrations EXIST ⇒ hard FAIL, not SKIP" -- node "$MG" --verify-head --repo "$R"
# CONTROL — no app.config and no migrations at all: verify-head still passes on C5 alone.
R="$(new_repo)"; CLEANUP+=("$R")
echo "hello" > "$R/src.txt"; git -C "$R" add -A && git -C "$R" commit -qm no-migrations
assert_exit_cmd 0 "verify-head C2 CONTROL: no app.config AND no migrations ⇒ passes (C5 only)" -- node "$MG" --verify-head --repo "$R"

# ---------------------------------------------------------------------------
echo "-- Part E: lifecycle-check.mjs de-ziee-ify (a NON-ziee frontend layout) --"
# ---------------------------------------------------------------------------
# lifecycle-check's frontend-workspace map + openapi-spec registry defaulted to
# ziee's `src-app/ui` / `src-app/desktop/ui`. A second app with a different
# layout (here: a single `webapp/` workspace) must be able to drive both from
# .claude/app.config — proven BOTH ways: WITHOUT the config the ziee-default
# paths are absent so the FE gate + R2-5 route gate SKIP (a non-ziee-layout FE
# touch reads as backend-only); WITH the config they activate on the app's own
# paths. Each fixture is a complete phase-8 artifact set (mirrors Part A's R2-5).

# helper: write the phases-1..8 artifacts for a webapp-layout feature whose
# single touched file is $2 (relative), with $3 e2e-mock spec body appended.
build_webapp_feat() {
  local R="$1" touched="$2"
  local D="$R/.lifecycle/foo"; mkdir -p "$D" "$(dirname "$R/$touched")"
  cat > "$D/PLAN.md" <<EOF
# PLAN — foo
## Design source
- \`docs/design/foo.md\` §1 "Webapp surface" — this plan realizes the surface
  described there.
## Invariants
- **INV-1**: The webapp surface is driven only by routes the app actually serves.
## Items
- **ITEM-1**: Add a webapp surface.
## Files to touch
- \`$touched\` — new (ITEM-1).
## Patterns to follow
- Mirror an existing webapp surface.
EOF
  write_common "$D" "$touched" 6
  echo "$D"
}

# --- E1: OPENAPI_SPECS (R2-5 route registry) is app.config-driven ---
# webapp/openapi.json registers /api/things; the e2e spec mocks a GHOST route.
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/webmock
mkdir -p "$R/webapp/openapi" "$R/webapp/tests/e2e/foo"
echo '{"paths":{"/api/things":{"get":{}},"/api/things/{id}":{"get":{}}}}' > "$R/webapp/openapi/openapi.json"
cat > "$R/webapp/tests/e2e/foo/foo.spec.ts" <<'EOF'
import { test } from '@playwright/test';
test('foo', async ({ page }) => {
  await page.route('**/api/ghosts', (r) => r.fulfill({ json: [] }));
});
EOF
D="$(build_webapp_feat "$R" "webapp/tests/e2e/foo/foo.spec.ts")"
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: e2e) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `webapp/tests/e2e/foo/foo.spec.ts` — asserts: things list renders from a served route.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
npm run check (webapp): PASS
gate:ui (webapp): PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm webmock
# WITHOUT app.config: ziee-default OPENAPI_SPECS (src-app/…) absent ⇒ R2-5 SKIPs
# AND webapp/ is not a known FE workspace ⇒ FE npm-check gate SKIPs ⇒ exit 0
# (the ghost mock is NOT flagged — the ziee paths simply don't exist here).
lc 0 "lifecycle-check: NO app.config ⇒ webapp-layout FE + R2-5 gates SKIP (ghost mock not flagged)" --phase 8 --repo "$R" --dir "$D" --base main
# WITH app.config pointing at the webapp layout: R2-5 finds the live registry and
# REFUSES the ghost mock; the FE workspace gate is satisfied by the check line.
mkdir -p "$R/.claude"
printf 'LIFECYCLE_FRONTEND_WORKSPACES=webapp/:webapp\nLIFECYCLE_OPENAPI_SPECS=webapp/openapi/openapi.json\n' > "$R/.claude/app.config"
git -C "$R" add -A && git -C "$R" commit -qm add-appconfig
lc 1 "lifecycle-check: app.config LIFECYCLE_OPENAPI_SPECS ⇒ R2-5 REFUSES a ghost /api mock in the webapp layout" --phase 8 --repo "$R" --dir "$D" --base main
# fix the mock to the live route ⇒ passes (proves it was a real route check, not a blanket fail)
sed 's#\*\*/api/ghosts#**/api/things#' "$R/webapp/tests/e2e/foo/foo.spec.ts" > "$R/tmp.ts" && mv "$R/tmp.ts" "$R/webapp/tests/e2e/foo/foo.spec.ts"
git -C "$R" commit -qam fix-webmock
lc 0 "lifecycle-check: webapp-layout mock of a LIVE /api route passes (app.config-driven registry)" --phase 8 --repo "$R" --dir "$D" --base main

# --- E2: FRONTEND_WORKSPACES map is app.config-driven ---
# A real FE source touch in the webapp layout, with a TEST_RESULTS that OMITS the
# per-workspace `npm run check` line.
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/webfe
mkdir -p "$R/webapp/src" "$R/webapp/tests/e2e/foo"
cat > "$R/webapp/src/FooPage.tsx" <<'EOF'
export function FooPage() {
  return (<div><h1>Foo</h1><button>Save</button></div>);
}
EOF
# The tests the plan enumerates (A11: a recorded PASS must be bound to something
# this branch wrote).
cat > "$R/webapp/src/FooPage.test.tsx" <<'EOF'
// TEST-1 (ITEM-1) — the surface renders its Save affordance.
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FooPage } from './FooPage';
test('renders Save', () => {
  render(<FooPage />);
  expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
});
EOF
cat > "$R/webapp/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1, INV-1) — the journey runs against a route the app serves.
import { expect, test } from '@playwright/test';
test('clicks Save against a served route', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
D="$(build_webapp_feat "$R" "webapp/src/FooPage.tsx")"
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `webapp/src/FooPage.test.tsx` — asserts: renders Save.
- **TEST-2** (tier: e2e) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `webapp/tests/e2e/foo/foo.spec.ts` — asserts: user clicks Save against a served route.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm webfe
# WITHOUT app.config: webapp/ is NOT a recognized FE workspace (ziee default map
# is src-app/…) ⇒ the touch reads as non-frontend ⇒ no `npm run check` line is
# required ⇒ exit 0 (the FE gate is app.config-driven, not baked to src-app).
lc 0 "lifecycle-check: NO app.config ⇒ webapp FE touch not gated (no npm-check line required)" --phase 8 --repo "$R" --dir "$D" --base main
# WITH the workspace map: webapp/ IS a frontend workspace ⇒ the missing
# `npm run check (webapp): PASS` line is REFUSED.
mkdir -p "$R/.claude"
printf 'LIFECYCLE_FRONTEND_WORKSPACES=webapp/:webapp\n' > "$R/.claude/app.config"
git -C "$R" add -A && git -C "$R" commit -qm add-appconfig-fe
lc 1 "lifecycle-check: app.config LIFECYCLE_FRONTEND_WORKSPACES ⇒ missing 'npm run check (webapp)' is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main
# add the required per-workspace check line ⇒ passes.
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
- **TEST-2**: PASS
npm run check (webapp): PASS
gate:ui (webapp): PASS
EOF
git -C "$R" commit -qam webfe-results-complete
lc 0 "lifecycle-check: webapp FE workspace satisfied by 'npm run check (webapp): PASS'" --phase 8 --repo "$R" --dir "$D" --base main

# ---------------------------------------------------------------------------
echo "-- Part F: LIGHT track + baseline-controlled A7 + A10 positive control --"
# ---------------------------------------------------------------------------

# --- LIGHT track: gate weight scales to BLAST RADIUS, not diff size alone. ---
# build_light [extra-setup] — build_be, but FIX_ROUND-1 records 3 open findings
# and there is no second round. Under HEAVY that is "not converged"; under LIGHT
# one completed round is the requirement.
build_light() {
  local R; R="$(build_be)"
  cat > "$R/.lifecycle/bar/FIX_ROUND-1.md" <<'EOF'
# FIX_ROUND 1
Three confirmed findings, all fixed in this round.
**New confirmed findings:** 3
EOF
  git -C "$R" commit -qam one-round >/dev/null
  echo "$R"
}

# L-1: a small, no-blast-radius change stops after ONE audit round.
R="$(build_light)"; D="$R/.lifecycle/bar"
lc 0 "LIGHT: a small no-blast-radius diff needs ONE audit round (phase 7)" --phase 7 --repo "$R" --dir "$D" --base main
# and the tier + its reason are VISIBLE, not implicit — nobody should have to
# guess which track they are on.
if grep -q "tier=LIGHT" "$LC_SELFTEST_OUT" && grep -q "no new permission, migration, module, or public API/schema change" "$LC_SELFTEST_OUT"; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "LIGHT: the tier AND its reason are reported on stdout"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "LIGHT: tier/reason not reported"
  sed 's/^/        | /' "$LC_SELFTEST_OUT"
fi

# L-2 (BLAST-RADIUS CONTROL — migration): byte-identical artifacts; the ONLY
# change is that the diff now adds a migration. A schema mistake is not
# revertible in place, so that change buys the HEAVY track and the same
# single-round loop is REFUSED. This is the case that proves the tier is
# computed from blast radius, not from whether the author felt done.
R="$(build_light)"; D="$R/.lifecycle/bar"
mkdir -p "$R/src-app/server/migrations"
echo "ALTER TABLE bar ADD COLUMN note TEXT;" > "$R/src-app/server/migrations/00000000000011_bar_note.sql"
git -C "$R" add -A && git -C "$R" commit -qm add-migration
lc 1 "LIGHT: adding a MIGRATION flips the same feature to HEAVY (one round refused)" --phase 7 --repo "$R" --dir "$D" --base main

# L-3 (BLAST-RADIUS CONTROL — new module): same artifacts, plus a new module
# seam nothing has exercised yet.
R="$(build_light)"; D="$R/.lifecycle/bar"
mkdir -p "$R/src-app/server/src/modules/baz"
printf 'pub mod repository;\n' > "$R/src-app/server/src/modules/baz/mod.rs"
git -C "$R" add -A && git -C "$R" commit -qm add-module
lc 1 "LIGHT: adding a NEW MODULE flips the same feature to HEAVY" --phase 7 --repo "$R" --dir "$D" --base main

# L-4 (SIZE CONTROL): no blast-radius signal at all, but the diff crosses the
# size threshold — a 900-line change is not reviewed by one round either.
R="$(build_light)"; D="$R/.lifecycle/bar"
i=0; while [ "$i" -lt 900 ]; do printf 'pub fn filler_%s() -> u32 { %s }\n' "$i" "$i" >> "$R/src-app/server/src/modules/bar/repository.rs"; i=$((i+1)); done
git -C "$R" commit -qam bulk
lc 1 "LIGHT: crossing the size threshold alone flips to HEAVY" --phase 7 --repo "$R" --dir "$D" --base main

# L-5 (THE LOAD-BEARING GUARANTEE): LIGHT relaxes the audit-ROUND requirement and
# NOTHING else. Every deterministic hardening check runs in both tiers — they are
# nearly free and they are what catch the silent failures. A cosmetic assertion
# on a LIGHT diff is still refused.
R="$(build_light)"; D="$R/.lifecycle/bar"
lc 0 "LIGHT: control — the light fixture passes phase 8 before the bad assert" --phase 8 --repo "$R" --dir "$D" --base main
printf '\nfn t() { assert!(true); }\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam light-cosmetic
lc 1 "LIGHT: A4 (and every hardening check) still runs on the LIGHT track" --phase 8 --repo "$R" --dir "$D" --base main

# --- A7: baseline-controlled canary + the false-PASS catch ---
# build_ui <canary-line...> — a UI-touching feature whose TEST_RESULTS carries
# whatever canary line(s) the caller passes. Echoes the repo root.
build_ui() {
  local R; R="$(new_repo)"; CLEANUP+=("$R")
  git -C "$R" checkout -q -b feat/ui7
  mkdir -p "$R/src-app/ui/src/modules/foo" "$R/.lifecycle/foo"
  cat > "$R/src-app/ui/src/modules/foo/FooPage.tsx" <<'EOF'
export function FooPage() {
  return <div><h1>Foo</h1><button>Save</button></div>;
}
EOF
# The tests the plan enumerates (A11: a recorded PASS must be bound to something
# this branch wrote — the id cited in an added line, or the declared `file:` touched).
mkdir -p "$R/src-app/ui/tests/e2e/foo"
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
cat > "$R/src-app/ui/tests/e2e/foo/foo.spec.ts" <<'EOF'
// TEST-2 (ITEM-1) — the user journey: open Foo, press Save.
import { expect, test } from '@playwright/test';
test('opens Foo and saves', async ({ page }) => {
  await page.goto('/foo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
EOF
  local D="$R/.lifecycle/foo"
  cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
## Design source
- `docs/design/foo.md` §2 "Foo surface" — this plan realizes the single-action
  Foo page described there.
## Invariants
- **INV-1**: The Foo surface exposes exactly one Save affordance.
## Items
- **ITEM-1**: Add a FooPage component.
## Files to touch
- `src-app/ui/src/modules/foo/FooPage.tsx` — new page (ITEM-1).
## Patterns to follow
- Mirror an existing settings page.
EOF
  write_common "$D" "src-app/ui/src/modules/foo/FooPage.tsx" 3
  cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: renders exactly one Save button.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: user clicks Save.
EOF
  { printf '# TEST_RESULTS — foo\n- **TEST-1**: PASS\n- **TEST-2**: PASS\nnpm run check (ui): PASS\n'
    for l in "$@"; do printf '%s\n' "$l"; done; } > "$D/TEST_RESULTS.md"
  git -C "$R" add -A && git -C "$R" commit -qm feat-ui7
  echo "$R"
}

# A7-1: the BASELINE-CONTROLLED form — the branch is no worse than its base. On a
# loaded shared box an absolute PASS is a tax on the author for the box's state;
# a controlled comparison is the honest measurement and it is now accepted.
R="$(build_ui 'gate:ui (ui): branch 3 vs base 5')"; D="$R/.lifecycle/foo"
lc 0 "A7: a baseline-controlled canary (branch 3 vs base 5) is ACCEPTED" --phase 8 --repo "$R" --dir "$D" --base main
# equal is "no worse" — the common real case on a box with pre-existing findings.
R="$(build_ui 'gate:ui (ui): branch=5 base=5')"; D="$R/.lifecycle/foo"
lc 0 "A7: branch == base is 'no worse' and passes" --phase 8 --repo "$R" --dir "$D" --base main

# A7-2 (CONTROL): a REGRESSION against the base is still refused — the relief is
# from the absolute bar, not from the requirement.
R="$(build_ui 'gate:ui (ui): branch 7 vs base 5')"; D="$R/.lifecycle/foo"
lc 1 "A7: a branch WORSE than its base is REFUSED (branch 7 vs base 5)" --phase 8 --repo "$R" --dir "$D" --base main

# A7-3: the absolute PASS form still works — every pre-existing artifact stays
# valid (zero findings cannot be worse than any base).
R="$(build_ui 'gate:ui (ui): PASS')"; D="$R/.lifecycle/foo"
lc 0 "A7: the absolute 'gate:ui (ui): PASS' form is still accepted" --phase 8 --repo "$R" --dir "$D" --base main

# A7-4 (THE FALSE-PASS CATCH — the part worth keeping): a recorded PASS sitting
# in the same file as pasted output reading GATE FAILED is a pipeline artifact,
# not a result. `cmd | tail` exits with tail's status; one real recorded PASS was
# exactly that.
R="$(build_ui 'gate:ui (ui): PASS' '```' '  Ran 41 surfaces ... GATE FAILED (3 HIGH runtime findings)' '```')"; D="$R/.lifecycle/foo"
lc 1 "A7: a recorded PASS contradicted by pasted 'GATE FAILED' output is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# A7-4b: ...but PROSE about earlier red runs is NOT pasted output and must NOT
# contradict a genuine PASS. Scanning the whole file punished honest disclosure:
# an author who HID four failed attempts passed, one who explained them failed.
# That is backwards, and it fired on a real branch whose only offence was saying
# why the gate had failed before it passed. Only fenced blocks count.
R="$(build_ui 'gate:ui (ui): PASS' 'Note: this took four red runs before I found the cause. Without it the gate failed every time.')"; D="$R/.lifecycle/foo"
lc 0 "A7: PROSE about an earlier failure does NOT contradict a genuine PASS" --phase 8 --repo "$R" --dir "$D" --base main
# ...and the catch does NOT fire on ordinary passing output (no blanket refusal
# of any file that happens to quote a log).
R="$(build_ui 'gate:ui (ui): PASS' '  Ran 41 surfaces ... 0 HIGH findings, gate OK')"; D="$R/.lifecycle/foo"
lc 0 "A7: passing pasted output does NOT trip the false-PASS catch" --phase 8 --repo "$R" --dir "$D" --base main
# ...and the catch is scoped to the ABSOLUTE form: a COMPARATIVE line already
# ADMITS findings, so a gate that exits non-zero on BOTH runs is exactly what it
# describes. Firing here would punish the honest record and push authors back
# onto the absolute form this reform exists to relieve.
R="$(build_ui 'gate:ui (ui): branch 3 vs base 5' '  branch run: GATE FAILED (3)' '  base run: GATE FAILED (5)')"; D="$R/.lifecycle/foo"
lc 0 "A7: 'GATE FAILED' output does NOT contradict a COMPARATIVE line (it admits findings)" --phase 8 --repo "$R" --dir "$D" --base main

# --- A10 positive control: "the UI is absent" must not pass vacuously ---
# A negative-permission spec asserting only ABSENCE passes identically when the
# page never loaded at all — a failed route, a login bounce, a render crash. One
# real spec was confounded exactly this way and would have gone green with the
# permission gate DELETED.
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use sees NO Foo nav entry, page, or Save button.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam negperm-uncontrolled
lc 1 "A10: an ABSENCE-ONLY restricted-user e2e is REFUSED as confounded (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
lc 1 "A10: an ABSENCE-ONLY restricted-user e2e is REFUSED as confounded (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# ...the same spec with the POSITIVE CONTROL added passes. The control is what
# makes "absent" mean "gated" rather than "never rendered".
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [positive-control] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use still loads the dashboard (positive control) and sees NO Foo nav entry, page, or Save button.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam negperm-controlled
lc 0 "A10: a restricted-user e2e WITH the positive control passes (phase 3)" --phase 3 --repo "$R" --dir "$D" --base main
lc 0 "A10: a restricted-user e2e WITH the positive control passes (phase 8)" --phase 8 --repo "$R" --dir "$D" --base main

# ...and the control is recognized from the asserts PROSE too (same grammar A9
# uses for its deny-path prose), so an author who states it plainly without
# reaching for the tag is not blocked on bookkeeping.
R="$(build_perm)"; D="$R/.lifecycle/foo"
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-4** (tier: e2e) [negative-perm] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a restricted user can open the dashboard and reach /settings, and sees NO Foo nav entry, page, or Save button.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-4**: PASS
EOF
git -C "$R" commit -qam negperm-prose
lc 0 "A10: the positive control is recognized from the asserts prose (no tag required)" --phase 8 --repo "$R" --dir "$D" --base main
echo "-- Part G: staleness-check.mjs (stale state that answers CONFIDENTLY WRONG) --"
# ---------------------------------------------------------------------------
# Every check below is proven BOTH ways: it fires on a genuinely stale fixture and
# stays silent on the clean twin. A check never observed to fire is not evidence.

# --- F-lib: the SELFTEST HARNESS's own shared-state bug, paired both ways ---
# assert_exit_cmd captures each command's output to a scratch file and several
# assertions grep it. That path used to be a hard-coded /tmp/lc-selftest.out, so
# two concurrent suites interleaved into one file and grepped each other's text —
# reporting a confident wrong verdict rather than failing loudly. Same class as
# everything else in Part F, one level down: the tool checking the tool was stale.
CONC="$(mktemp -d)"; CLEANUP+=("$CONC")
cat > "$CONC/worker.sh" <<'WEOF'
#!/usr/bin/env bash
# Loops assert_exit_cmd and verifies the captured output is the output IT produced.
set -u
. "$1"
tag="$2"; n="${3:-250}"; i=0
while [ "$i" -lt "$n" ]; do
  i=$((i+1))
  assert_exit_cmd 0 "t$i" -- printf '%s\n' "$tag" >/dev/null 2>&1
  grep -qx -- "$tag" "$LC_SELFTEST_OUT" 2>/dev/null || exit 1
done
[ "$FAIL" -eq 0 ] || exit 1
WEOF
conc_pair() {  # <unique|shared> — exit 0 when BOTH workers only ever saw their own output
  local mode="$1" a b ra rb
  if [ "$mode" = shared ]; then
    LC_SELFTEST_OUT="$CONC/shared.out" bash "$CONC/worker.sh" "$HERE/selftest-lib.sh" AAAAAAAA 250 & a=$!
    LC_SELFTEST_OUT="$CONC/shared.out" bash "$CONC/worker.sh" "$HERE/selftest-lib.sh" BBBBBBBB 250 & b=$!
  else
    env -u LC_SELFTEST_OUT bash "$CONC/worker.sh" "$HERE/selftest-lib.sh" AAAAAAAA 250 & a=$!
    env -u LC_SELFTEST_OUT bash "$CONC/worker.sh" "$HERE/selftest-lib.sh" BBBBBBBB 250 & b=$!
  fi
  wait "$a"; ra=$?; wait "$b"; rb=$?
  [ "$ra" -eq 0 ] && [ "$rb" -eq 0 ]
}
assert_exit_cmd 0 "selftest harness: two parallel suites with per-run scratch files do NOT clobber" -- conc_pair unique
assert_exit_cmd 1 "selftest harness: forcing ONE shared scratch file reproduces the clobber (negative control)" -- conc_pair shared

# --- F0: usage errors are exit != 0 (silence must never mean "checked and fine") ---
sc 1 "staleness: no --repo ⇒ usage error"                       --port 1
sc 1 "staleness: --repo pointing at a non-directory ⇒ usage error" --repo "$HERE/selftest-lib.sh"

# --- F1/F2: submodule initialised, and the git -C walk-up trap ---
# sub-origin is the submodule's upstream; parent embeds it at sdk/.
SUBO="$(new_repo)"; CLEANUP+=("$SUBO")
echo v1 > "$SUBO/f.txt"; git -C "$SUBO" add -A; git -C "$SUBO" commit -qm c1
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" -c protocol.file.allow=always submodule add -q "$SUBO" sdk >/dev/null 2>&1
git -C "$R" commit -qm add-sub >/dev/null 2>&1
sc 0 "staleness: initialised submodule ⇒ clean"                 --repo "$R"

# advance the submodule's upstream, then fetch so origin/main is ahead of the pin.
echo v2 > "$SUBO/f.txt"; git -C "$SUBO" commit -qam c2
echo v3 > "$SUBO/f.txt"; git -C "$SUBO" commit -qam c3
git -C "$R/sdk" fetch -q origin 2>/dev/null
# F2: being BEHIND upstream is reported but must NOT gate — pinning is often
# deliberate, and a gate here would train everyone to ignore the tool.
sc 0 "staleness: submodule 2 behind upstream ⇒ reported, still exit 0" --repo "$R"
sc_says "behind" "staleness: the behind-distance is actually reported"  --repo "$R"

# F1-stale: deinit ⇒ an EMPTY dir that still passes existsSync.
git -C "$R" submodule deinit -f -q sdk >/dev/null 2>&1
sc 1 "staleness: uninitialised (empty) submodule ⇒ REFUSED"     --repo "$R"
# and the diagnosis must name the walk-up, because that is what misleads: git -C
# on the empty dir answers about the PARENT repo at exit 0.
sc_says "walks UP" "staleness: empty-submodule diagnosis names the git -C walk-up trap" --repo "$R"
sc_says "EMPTY directory" "staleness: diagnosis names the consequence, not just the state" --repo "$R"

# F1b: declared in .gitmodules but the path is gone entirely.
rm -rf "$R/sdk"
sc 1 "staleness: declared submodule whose path is absent ⇒ REFUSED" --repo "$R"
# F1c: a POPULATED dir that is not its own git repo (someone copied files in, or
# rm -rf'd its .git) — same walk-up trap, and existsSync + readdir both pass.
mkdir -p "$R/sdk"; echo "copied" > "$R/sdk/file.txt"
sc 1 "staleness: populated submodule dir that is not its own repo ⇒ REFUSED" --repo "$R"
sc_says "not" "staleness: not-own-repo diagnosis names the repo it actually resolved to" --repo "$R"
# restore for the remaining parts
rm -rf "$R/sdk"
git -C "$R" -c protocol.file.allow=always submodule update --init -q sdk >/dev/null 2>&1
sc 0 "staleness: re-initialised submodule ⇒ clean again"        --repo "$R"

# --- F3: a build stamp vs HEAD (the 87-commits-behind audit rig, generalised) ---
STAMPDIR="$(mktemp -d)"; CLEANUP+=("$STAMPDIR")
git -C "$R" rev-parse HEAD > "$STAMPDIR/fresh.stamp"
sc 0 "staleness: build stamp == HEAD ⇒ clean"                   --repo "$R" --stamp "$STAMPDIR/fresh.stamp"
OLDSHA="$(git -C "$R" rev-parse HEAD)"
for i in 1 2 3; do echo "n$i" > "$R/n$i.txt"; git -C "$R" add -A; git -C "$R" commit -qm "n$i"; done
printf 'built_from=%s\nbuilt_at=whenever\n' "$OLDSHA" > "$STAMPDIR/old.stamp"
sc 1 "staleness: artifact built 3 commits behind HEAD ⇒ REFUSED" --repo "$R" --stamp "$STAMPDIR/old.stamp"
sc_says "behind HEAD" "staleness: stamp diagnosis states the distance"  --repo "$R" --stamp "$STAMPDIR/old.stamp"
echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$STAMPDIR/alien.stamp"
sc 1 "staleness: stamp naming a commit this repo lacks ⇒ REFUSED" --repo "$R" --stamp "$STAMPDIR/alien.stamp"
sc 1 "staleness: missing stamp file ⇒ REFUSED (provenance unknown)" --repo "$R" --stamp "$STAMPDIR/nope.stamp"
echo "no sha here at all" > "$STAMPDIR/nosha.stamp"
sc 1 "staleness: stamp with no commit id ⇒ REFUSED"             --repo "$R" --stamp "$STAMPDIR/nosha.stamp"

# --- F4: a RUNNING process older than the script it was launched from ---
# Deliberately run against a PLAIN repo (no submodules, no stamp): if F4's fixtures
# shared $R, an unrelated S1/S3 finding could make an F4 "REFUSED" case pass for the
# WRONG reason — a test that certifies nothing.
PR="$(new_repo)"; CLEANUP+=("$PR")
sc 0 "staleness: --process-pattern matching nothing ⇒ clean"    --repo "$PR" --process-pattern 'zzz-no-such-process-zzz'
sc 1 "staleness: an invalid --process-pattern regex ⇒ REFUSED (silence would prove nothing)" \
     --repo "$PR" --process-pattern '['
if [ -d /proc/self ]; then
  PROCDIR="$(mktemp -d)"; CLEANUP+=("$PROCDIR")
  PMARK="stalecheck-loop-$$"
  cat > "$PROCDIR/$PMARK.sh" <<'LOOPEOF'
#!/usr/bin/env bash
while true; do sleep 2; done
LOOPEOF
  chmod +x "$PROCDIR/$PMARK.sh"
  sleep 1
  bash "$PROCDIR/$PMARK.sh" >/dev/null 2>&1 &
  LOOPPID=$!; KILLPIDS+=("$LOOPPID")
  sleep 1
  # CLEAN twin: the process started AFTER the script's last write.
  sc 0 "staleness: running process newer than its script ⇒ clean" --repo "$PR" --process-pattern "$PMARK"
  # Now edit the script mid-run. bash parsed the whole `while` block at start, so
  # the live loop keeps running the OLD text — reading the file suggests otherwise.
  # Sleep past STALENESS_FRESH_MARGIN_MS (2s): an edit made within that window of
  # launch is deliberately NOT a finding, so the fixture must clear it to test the
  # rule rather than the margin.
  sleep 3
  printf '\n# a gate added after the loop started — never runs in the live process\n' >> "$PROCDIR/$PMARK.sh"
  sc 1 "staleness: script edited AFTER the process started ⇒ REFUSED" --repo "$PR" --process-pattern "$PMARK"
  sc_says "parsed the OLD text" "staleness: process diagnosis names the parsed-once consequence" \
       --repo "$PR" --process-pattern "$PMARK"
  kill "$LOOPPID" 2>/dev/null; wait "$LOOPPID" 2>/dev/null
  sleep 1
  sc 0 "staleness: after the stale process exits ⇒ clean again" --repo "$PR" --process-pattern "$PMARK"
else
  note "skip: /proc unavailable — S4 process-freshness probe is Linux-only"
fi

# --- F5: port ownership (the 'reused a sibling worktree's dev server' bug) ---
if [ -d /proc/net ] && [ -r /proc/net/tcp ]; then
  PORTDIR="$(mktemp -d)"; CLEANUP+=("$PORTDIR")
  mkdir -p "$PORTDIR/mine" "$PORTDIR/sibling"
  PORT=$(( 39000 + ($$ % 900) ))
  sc 0 "staleness: nothing listening on the port ⇒ clean"        --repo "$PR" --port "$PORT" --expect-root "$PORTDIR/mine"
  ( cd "$PORTDIR/sibling" && exec node -e "require('http').createServer().listen($PORT,'127.0.0.1')" ) >/dev/null 2>&1 &
  SRVPID=$!; KILLPIDS+=("$SRVPID")
  sleep 1
  sc 0 "staleness: listener owned by THIS tree ⇒ clean"          --repo "$PR" --port "$PORT" --expect-root "$PORTDIR/sibling"
  sc 1 "staleness: listener owned by a DIFFERENT tree ⇒ REFUSED" --repo "$PR" --port "$PORT" --expect-root "$PORTDIR/mine"
  sc_says "FOREIGN owner" "staleness: port diagnosis names the foreign owner + its tree" \
       --repo "$PR" --port "$PORT" --expect-root "$PORTDIR/mine"
  kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null
else
  note "skip: /proc/net/tcp unavailable — S5 port-ownership probe is Linux-only"
fi

# ---------------------------------------------------------------------------
echo "-- Part H: edit-lint-hook.mjs (cheap lints in the agent's own edit loop) --"
# ---------------------------------------------------------------------------
# The hook ALWAYS exits 0 (fail-open); its signal is stdout. These cases prove the
# plumbing — discovery of both scanner dirs, the file-scoped filter, the advisory
# arm, dedupe, and fail-open — using STUB scanners, so the selftest stays portable
# (git + node only, no npm install, no sdk checkout). The real scanners are wired
# by filename; the stubs stand in for them 1:1.
HR="$(mktemp -d)"; CLEANUP+=("$HR")
mkdir -p "$HR/sdk/packages/config/src/lint" "$HR/src-app/ui/scripts" "$HR/src-app/ui/src/mod"
printf '{"name":"ws","private":true}\n' > "$HR/src-app/ui/package.json"

# A stub scanner: scans --root for a marker and prints `<abs>:<line> <msg>`, exit 1.
write_stub() { # <path> <marker> <msg> <exit-code>
  cat > "$1" <<STUBEOF
import fs from 'node:fs'; import path from 'node:path';
const root = (process.argv.find(a => a.startsWith('--root=')) || '').split('=').slice(1).join('=');
let hits = 0;
for (const f of (fs.existsSync(root) ? fs.readdirSync(root) : [])) {
  if (!/\.(ts|tsx)\$/.test(f)) continue;
  const p = path.join(root, f);
  fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (l.includes('$2')) { hits++; console.log(\`\${p}:\${i + 1}  $3\`); }
  });
}
if (!hits) console.log('[stub] ✓ nothing found.');
process.exit(hits ? $4 : 0);
STUBEOF
}
write_stub "$HR/sdk/packages/config/src/lint/hardcoded-colors.mjs" "BAD_COLOR" "hardcoded color class" 1
write_stub "$HR/src-app/ui/scripts/lint-icon-action.mjs"           "BAD_ICON"  "wrong action glyph"   1
# ADVISORY stub: reports but exits 0, exactly like tooltip-placement/native-scroll.
write_stub "$HR/sdk/packages/config/src/lint/tooltip-placement.mjs" "BAD_TIP"  "mixed tooltip sides"  0
# A scanner that CRASHES must never block an edit (fail-open).
printf 'throw new Error("scanner exploded")\n' > "$HR/sdk/packages/config/src/lint/adjacent-inline.mjs"

M="$HR/src-app/ui/src/mod"
printf 'export const Clean = () => null\n'                    > "$M/Clean.tsx"
printf 'export const Dirty = () => "BAD_COLOR"\n'             > "$M/Dirty.tsx"
printf 'export const Icon = () => "BAD_ICON"\n'               > "$M/Icon.tsx"
printf 'export const Tip = () => "BAD_TIP"\n'                 > "$M/Tip.tsx"

hk 1 "edit-lint: fires on a violating .tsx (sdk scanner dir)"      "$M/Dirty.tsx"
hk_says "hardcoded color class" "edit-lint: the finding carries the scanner's message" "$M/Dirty.tsx"
hk_says "Dirty.tsx" "edit-lint: the finding names the edited file"                     "$M/Dirty.tsx"
hk 1 "edit-lint: fires on a violating .tsx (app-local scripts dir)" "$M/Icon.tsx"
hk 1 "edit-lint: an ADVISORY scanner (exit 0 + output) still reports" "$M/Tip.tsx"
# THE control that matters: Clean.tsx sits in the SAME directory as three
# violating files. A dir-scoped scanner sees all four; the hook must report none,
# or the agent learns to ignore it.
hk 0 "edit-lint: silent on a clean file whose NEIGHBOURS all violate"  "$M/Clean.tsx"
# fail-open, four ways
hk 0 "edit-lint: silent when a scanner throws (fail-open)"            "$M/Clean.tsx"
hk 0 "edit-lint: silent for a non-source extension"                   "$HR/src-app/ui/package.json"
hk 0 "edit-lint: silent for a file that does not exist"               "$HR/src-app/ui/src/mod/ghost.tsx"
assert_exit_cmd 0 "edit-lint: silent on malformed hook stdin"    -- hk_raw_impl 'not json at all'
assert_exit_cmd 0 "edit-lint: silent on hook stdin with no file" -- hk_raw_impl '{"tool_input":{}}'
# An UNINITIALISED sdk submodule (the S1 condition) must degrade to silence here,
# never to a phantom failure — staleness-check is what diagnoses it out loud.
mv "$HR/sdk/packages/config/src/lint" "$HR/lint-parked"
hk 0 "edit-lint: silent when the sdk lint dir is missing (uninitialised submodule)" "$M/Dirty.tsx"
mv "$HR/lint-parked" "$HR/sdk/packages/config/src/lint"
hk 1 "edit-lint: fires again once the sdk lint dir is back"           "$M/Dirty.tsx"
# Duplicate lines from overlapping --root dirs collapse to one.
DUPES="$(printf '{"tool_input":{"file_path":"%s"}}' "$M/Dirty.tsx" | node "$HOOK" 2>/dev/null | grep -c 'hardcoded color class' || true)"
assert_exit_cmd 0 "edit-lint: identical findings are deduped (exactly 1 line)" -- test "$DUPES" = "1"

# --- G-rust: rustfmt arm, diff-scoped ---
if command -v rustfmt >/dev/null 2>&1; then
  RR="$(new_repo)"; CLEANUP+=("$RR")
  mkdir -p "$RR/src"
  printf '[package]\nname = "f"\nversion = "0.1.0"\nedition = "2021"\n' > "$RR/Cargo.toml"
  cat > "$RR/src/lib.rs" <<'RSEOF'
pub fn a() -> i32 {
    1
}

pub fn b(  ) ->i32{
let x=2;
    x
}

pub fn c() -> i32 {
    3
}
RSEOF
  git -C "$RR" add -A; git -C "$RR" commit -qm baseline
  # 84 of a 120-file sample of the real server tree already fail rustfmt at HEAD,
  # so an un-scoped rustfmt arm would be ~70% noise. It must blame only the lines
  # this working tree changed.
  hk 0 "edit-lint(rust): pre-existing unformatted hunk, no edit ⇒ silent"      "$RR/src/lib.rs"
  printf 'pub fn d(  )->i32{ 4 }\n' >> "$RR/src/lib.rs"
  hk 1 "edit-lint(rust): an edit that introduces bad formatting ⇒ fires"       "$RR/src/lib.rs"
  hk_says "rustfmt" "edit-lint(rust): the finding names rustfmt + the fix"     "$RR/src/lib.rs"
  git -C "$RR" checkout -q -- src/lib.rs
  # An edit in a WELL-FORMATTED region must not resurrect the pre-existing hunk.
  printf 'pub fn e() -> i32 {\n    5\n}\n' >> "$RR/src/lib.rs"
  hk 0 "edit-lint(rust): a well-formatted edit does not blame the old hunk"    "$RR/src/lib.rs"
  # A brand-new UNTRACKED file has no baseline ⇒ every hunk is this edit's.
  printf 'pub fn z(  )->i32{ 9 }\n' > "$RR/src/new.rs"
  hk 1 "edit-lint(rust): untracked new file has no baseline ⇒ all hunks fire"  "$RR/src/new.rs"
  # The hook must never write to the tree it is inspecting.
  git -C "$RR" checkout -q -- src/lib.rs; rm -f "$RR/src/new.rs"
  BEFORE="$(git -C "$RR" status --porcelain)"
  printf '{"tool_input":{"file_path":"%s"}}' "$RR/src/lib.rs" | node "$HOOK" >/dev/null 2>&1
  assert_exit_cmd 0 "edit-lint: the hook never mutates the tree it inspects" \
    -- test "$BEFORE" = "$(git -C "$RR" status --porcelain)"
else
  note "skip: rustfmt not installed — the Rust arm's paired controls need it"
fi


# ===========================================================================
# INVOCATION INTEGRITY — a run that graded NOTHING must never report OK.
#
# Observed defect (fix/gate-integrity): `lifecycle-check.mjs --all --feature C9`
# — the real flag is `--dir` — printed
#     lifecycle-check: OK — phases 1..0 complete (0/9)
# and exited 0. The old parser matched flags with `args.indexOf(name)`, so an
# unrecognised flag AND its value were silently dropped; `--dir` stayed unset;
# auto-discovery selected the single `.lifecycle/<epic>/` subdirectory — an EPIC
# ROOT whose phase artifacts live one level further down — found all nine phases
# PENDING, and reported a green. A merge agent read that as a passing lifecycle.
#
# Three separate holes, each proven here BOTH ways: unknown flag, artifact-less
# directory, and the all-PENDING "0/9 OK".
# ===========================================================================
echo "-- lifecycle-check: invocation integrity --"
IV="$(new_repo)"; git -C "$IV" checkout -q -b feat/item1
mkdir -p "$IV/src-app/server/src/modules/item1" "$IV/.lifecycle/epic-x/ITEM-1" "$IV/.lifecycle/epic-x/ITEM-2"
printf 'pub fn list_item() -> Vec<String> {\n    vec!["a".into(), "b".into()]\n}\n' \
  > "$IV/src-app/server/src/modules/item1/repository.rs"
IVD="$IV/.lifecycle/epic-x/ITEM-1"
cat > "$IVD/PLAN.md" <<'EOF'
# PLAN — item1
## Design source
- `docs/design/item1.md` §1 "Item listing" — this plan realizes the read path.
## Invariants
- **INV-1**: `list_item` returns every item row — the listing is never silently truncated.
## Items
- **ITEM-1**: Add list_item to the item1 repository.
## Files to touch
- `src-app/server/src/modules/item1/repository.rs` — new fn (ITEM-1).
## Patterns to follow
- Mirror an existing server repository module.
EOF
write_common "$IVD" "src-app/server/src/modules/item1/repository.rs" 3
cat > "$IVD/TESTS.md" <<'EOF'
# TESTS — item1
- **TEST-1** (tier: unit) [acceptance] [invariant: INV-1] [covers: ITEM-1] file: `src-app/server/src/modules/item1/repository.rs` — asserts: list_item returns both seeded rows, not a truncated prefix.
EOF
printf '# TEST_RESULTS — item1\n- **TEST-1**: PASS\n' > "$IVD/TEST_RESULTS.md"
# Epic-level bookkeeping that is NOT a phase artifact — exactly what an epic root holds.
printf '# GRAPH\nITEM-1 -> ITEM-2\n' > "$IV/.lifecycle/epic-x/GRAPH.md"
printf '# PLAN — item2 (not started)\n' > "$IV/.lifecycle/epic-x/ITEM-2/PLAN.md"
git -C "$IV" add -A && git -C "$IV" commit -qm item1-complete

# CONTROL — pointed at the real feature dir, the same tree is green.
lc 0 "invocation: CONTROL — the correctly-directed run passes" --all --repo "$IV" --dir "$IVD" --base main
# 1. An unknown flag is FATAL and names itself; it is never dropped.
lc 1 "invocation: an unknown flag (--feature) is fatal, not silently dropped" --all --repo "$IV" --feature ITEM-1 --base main
lc_says "unknown flag \`--feature\`" "invocation: the fatal error NAMES the rejected flag" --all --repo "$IV" --feature ITEM-1 --base main
lc_says -- "--dir" "invocation: the fatal error lists the valid flags" --all --repo "$IV" --feature ITEM-1 --base main
# 2. A value-taking flag with no value is fatal (it used to silently become `true`).
lc 1 "invocation: --dir with no value is fatal" --all --repo "$IV" --dir
# 3. Auto-discovery landing on an EPIC ROOT is fatal, and says so.
lc 1 "invocation: auto-discovered EPIC ROOT (no artifacts of its own) is fatal" --all --repo "$IV" --base main
lc_says "EPIC root" "invocation: the epic-root diagnosis names the fix (pass --dir <subdirectory>)" --all --repo "$IV" --base main
# 4. An existing but artifact-less --dir is fatal, not a vacuous pass.
mkdir -p "$IV/.lifecycle/epic-x/EMPTY"
lc 1 "invocation: an existing but artifact-LESS --dir is fatal" --all --repo "$IV" --dir "$IV/.lifecycle/epic-x/EMPTY" --base main
# 5. `--k=v` is honoured — the old exact-token match dropped it exactly like an unknown flag.
lc_says "epic-x/EMPTY" "invocation: --dir=<v> is honoured, not dropped" --all --repo "$IV" "--dir=$IV/.lifecycle/epic-x/EMPTY" --base main
lc 0 "invocation: --dir=<v> CONTROL — the =form reaches the green feature too" --all --repo "$IV" "--dir=$IVD" "--base=main"
# 6. GRADING NOTHING IS NOT A PASS. A dir holding an artifact but no COMPLETE phase leaves
#    every phase PENDING; that used to print `OK — phases 1..0 complete (0/9)`, exit 0.
mkdir -p "$IV/.lifecycle/epic-x/STRAY" && : > "$IV/.lifecycle/epic-x/STRAY/AUDIT_COVERAGE.tsv"
lc 1 "invocation: all-nine-PENDING is a FAILURE, not 'phases 1..0 complete (0/9)'" --all --repo "$IV" --dir "$IV/.lifecycle/epic-x/STRAY" --base main
lc_says "every phase is PENDING" "invocation: the all-PENDING failure says no phase was graded" --all --repo "$IV" --dir "$IV/.lifecycle/epic-x/STRAY" --base main
lc_says "no phase was graded" "invocation: ...and that the run therefore proves nothing" --all --repo "$IV" --dir "$IV/.lifecycle/epic-x/STRAY" --base main
# 7. --wip inherits every rule above (same runner, same parser).
lc 1 "invocation: --wip is bound by the same all-PENDING rule" --wip --repo "$IV" --dir "$IV/.lifecycle/epic-x/STRAY" --base main
lc 1 "invocation: --wip rejects an unknown flag too" --wip --repo "$IV" --feature ITEM-1 --base main
rm -rf "$IV"


# --- merge-gate + epic-check: the same strict-flag rule ------------------------
# `argv.indexOf(name)` drops an unrecognised flag in EVERY one of these gates. It is
# loudest in lifecycle-check (it manufactured a 0/9 green), but a merge-gate run with a
# typo'd `--verify-head` silently becomes a full branch gate, and a typo'd value flag
# leaves its bare value to be read as the branch name.
R="$(new_repo)"; CLEANUP+=("$R")
git -C "$R" checkout -q -b feat/x; echo hi > "$R/f.txt"
git -C "$R" add -A && git -C "$R" commit -qm x
assert_exit_cmd 1 "merge-gate: an unknown flag is fatal, not dropped" -- \
  node "$MG" feat/x --repo "$R" --base main --no-fetch --skip-heavy --feature C9
assert_exit_cmd 1 "merge-gate: a value-taking flag with no value is fatal" -- \
  node "$MG" feat/x --repo "$R" --base main --no-fetch --skip-heavy --rev
assert_exit_cmd 0 "merge-gate CONTROL: the same run without the bogus flag is unchanged" -- \
  node "$MG" feat/x --repo "$R" --base main --no-fetch --skip-heavy
assert_exit_cmd 0 "merge-gate: --k=v is honoured, not dropped" -- \
  node "$MG" feat/x "--repo=$R" "--base=main" --no-fetch --skip-heavy

EPIC_CHECK="$HERE/epic-check.mjs"
assert_exit_cmd 1 "epic-check: an unknown flag is fatal" -- node "$EPIC_CHECK" --phase 0 --epic e --repo "$R" --feature C9
assert_exit_cmd 1 "epic-check: a bare positional is fatal" -- node "$EPIC_CHECK" --phase 0 --epic e --repo "$R" C9
assert_exit_cmd 1 "epic-check CONTROL: a missing epic still fails on its own merits" -- node "$EPIC_CHECK" --phase 0 --epic e --repo "$R"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
