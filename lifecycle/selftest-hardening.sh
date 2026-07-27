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

lc()  { assert_exit_cmd "$1" "$2" -- node "$CHECK" "${@:3}"; }

CLEANUP=()
trap 'for d in "${CLEANUP[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done' EXIT

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
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: list_bar returns two rows.
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
  local D="$R/.lifecycle/foo"
  cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
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
  cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/foo/permissions.rs` — asserts: PERMISSION is foo::use.
- **TEST-2** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/foo/foo.rs` — asserts: a user lacking foo::use gets 403 forbidden.
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

# --- A1: a SECOND .lifecycle feature dir on the branch -> --all FAILs (global)
R="$(build_be)"; D="$R/.lifecycle/bar"
mkdir -p "$R/.lifecycle/stray"
echo "# a second feature's plan that sneaked onto the branch" > "$R/.lifecycle/stray/PLAN.md"
git -C "$R" add -A && git -C "$R" commit -qm stray-dir
lc 1 "A1: two .lifecycle dirs is REFUSED even with explicit --dir" --all --repo "$R" --dir "$D" --base main
git -C "$R" rm -rq .lifecycle/stray && git -C "$R" commit -qm rm-stray
lc 0 "A1: one .lifecycle dir is accepted (control)" --all --repo "$R" --dir "$D" --base main

# --- A2: an uncommitted (dirty) working tree at phase 8 -> FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
echo "// stray uncommitted edit" >> "$R/src-app/server/src/modules/bar/repository.rs"
lc 1 "A2: dirty working tree at phase 8 is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A3: a diff-added #[ignore] -> phase 8 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\n#[ignore]\nfn skipped_test() {}\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-ignore
lc 1 "A3: a diff-added #[ignore] is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A4: a cosmetic assert!(true) -> phase 8 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
printf '\nfn t() { assert!(true); }\n' >> "$R/src-app/server/src/modules/bar/repository.rs"
git -C "$R" commit -qam add-cosmetic
lc 1 "A4: a cosmetic assert!(true) is REFUSED" --phase 8 --repo "$R" --dir "$D" --base main

# --- A5: TESTS.md that dropped a previously-committed test -> phase 3 FAIL
R="$(build_be)"; D="$R/.lifecycle/bar"
# earlier commit had TEST-1 + TEST-2; now shrink to TEST-1
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: one.
- **TEST-2** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/bar/bar.rs` — asserts: two.
EOF
git -C "$R" commit -qam tests-two
cat > "$D/TESTS.md" <<'EOF'
# TESTS — bar
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/server/src/modules/bar/repository.rs` — asserts: one.
EOF
git -C "$R" commit -qam tests-shrunk
lc 1 "A5: TESTS.md shrink (dropped TEST-2) is REFUSED" --phase 3 --repo "$R" --dir "$D" --base main

# --- FB-7 plan-coverage / descope gate ---
R="$(build_be)"; D="$R/.lifecycle/bar"
# (1) an extra PLAN item with no covering TEST and no descope -> bipartite FAIL
cat > "$D/PLAN.md" <<'EOF'
# PLAN — bar
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
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-2** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/bar/bar.rs` — asserts: a user lacking bar::use gets 403 forbidden.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-2**: PASS
EOF
git -C "$R" commit -qam add-deny-test
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
- **TEST-4** (tier: e2e) [negative-perm] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use sees NO Foo nav entry, page, or Save button.
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
- **TEST-4** (tier: e2e) [negative-perm] [covers: ITEM-2] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use sees no Foo UI.
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
D="$R/.lifecycle/foo"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
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
- **TEST-1** (tier: integration) [covers: ITEM-1] file: `src-app/server/tests/foo/foo.rs` — asserts: the Users group gains foo::use.
EOF
cat > "$D/TEST_RESULTS.md" <<'EOF'
# TEST_RESULTS — foo
- **TEST-1**: PASS
EOF
git -C "$R" add -A && git -C "$R" commit -qm feat-permmig
lc 1 "A10: a migration granting ::use without a restricted-user e2e is REFUSED (A9 alone misses it)" --phase 8 --repo "$R" --dir "$D" --base main
cat >> "$D/TESTS.md" <<'EOF'
- **TEST-2** (tier: e2e) [negative-perm] [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/perm-gating.spec.ts` — asserts: a user LACKING foo::use sees no Foo UI.
EOF
cat >> "$D/TEST_RESULTS.md" <<'EOF'
- **TEST-2**: PASS
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
D="$R/.lifecycle/foo"
cat > "$D/PLAN.md" <<'EOF'
# PLAN — foo
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
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `src-app/ui/src/modules/foo/FooPage.test.tsx` — asserts: renders Save.
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
- **TEST-1** (tier: e2e) [covers: ITEM-1] file: `src-app/ui/tests/e2e/foo/foo.spec.ts` — asserts: things list renders.
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

# de-ziee-ify: with NO .claude/app.config, C2 has no migrations dir configured
# and SKIPs — the same colliding migration that fails above now PASSES (proving
# the app-specific gate is app.config-driven, not baked in).
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
git -C "$R" add -A && git -C "$R" commit -qm mig-10
git -C "$R" checkout -q -b feat/mig
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000009_early.sql"
git -C "$R" add -A && git -C "$R" commit -qm branch-mig
assert_exit_cmd 0 "merge-gate: NO app.config ⇒ C2 SKIPs (collision not flagged)" -- \
  node "$MG" feat/mig --repo "$R" --base main --no-fetch --skip-heavy
# strengthen: exit 0 alone can't distinguish SKIP from PASS — assert the C2 line
# actually reads SKIP in the just-captured output (/tmp/lc-selftest.out).
if grep -qE "C2.*SKIP" /tmp/lc-selftest.out; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: NO app.config ⇒ C2 line explicitly reads SKIP (not PASS)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: NO app.config — C2 did not report SKIP"
  sed 's/^/        | /' /tmp/lc-selftest.out
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
if grep -qE "staging: submodules checked out" /tmp/lc-selftest.out \
   && grep -qE 'staging: copied gitignored "cfg/dev.yaml"' /tmp/lc-selftest.out; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: staging provisioning is reported on stdout (submodules + copy)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: staging provisioning was not reported"
  sed 's/^/        | /' /tmp/lc-selftest.out
fi
if grep -qE 'staging: MERGE_STAGING_COPY_FILES: "gen.txt" is TRACKED by git — NOT copied' /tmp/lc-selftest.out; then
  PASS=$((PASS+1)); printf '  \033[32mok  \033[0m %s\n' "merge-gate: a TRACKED declared copy path is REFUSED (merged tree stays authoritative)"
else
  FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "merge-gate: a TRACKED declared copy path was not refused"
  sed 's/^/        | /' /tmp/lc-selftest.out
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
env -u DATABASE_URL -u ZIEE_BUILD_DB_PERWORKTREE bash "$PREFLIGHT" --repo "$INJ" >/tmp/lc-selftest.out 2>&1 || true
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

# de-ziee-ify: with NO app.config, verify-head C2 has no migrations dir and
# SKIPs — the same duplicate-prefix HEAD that fails above now passes verify-head
# (C5 .lifecycle-strip, the app-agnostic guard, still runs).
R="$(new_repo)"; CLEANUP+=("$R")
mkdir -p "$R/src-app/server/migrations"
echo "CREATE TABLE a();" > "$R/src-app/server/migrations/00000000000010_a.sql"
echo "CREATE TABLE b();" > "$R/src-app/server/migrations/00000000000010_b.sql"
git -C "$R" add -A && git -C "$R" commit -qm dup-mig
assert_exit_cmd 0 "verify-head: NO app.config ⇒ C2 SKIPs (dup prefix not flagged; C5 still runs)" -- node "$MG" --verify-head --repo "$R"

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
- **TEST-1** (tier: e2e) [covers: ITEM-1] file: `webapp/tests/e2e/foo/foo.spec.ts` — asserts: things list renders.
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
mkdir -p "$R/webapp/src"
cat > "$R/webapp/src/FooPage.tsx" <<'EOF'
export function FooPage() {
  return (<div><h1>Foo</h1><button>Save</button></div>);
}
EOF
D="$(build_webapp_feat "$R" "webapp/src/FooPage.tsx")"
cat > "$D/TESTS.md" <<'EOF'
# TESTS — foo
- **TEST-1** (tier: unit) [covers: ITEM-1] file: `webapp/src/FooPage.test.tsx` — asserts: renders Save.
- **TEST-2** (tier: e2e) [covers: ITEM-1] file: `webapp/tests/e2e/foo/foo.spec.ts` — asserts: user clicks Save.
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

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
