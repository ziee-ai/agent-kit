#!/usr/bin/env bash
# preflight.sh — Phase-1 environment gate for the feature-lifecycle.
#
# Catches the recurring, high-cost SETUP friction that wasted time across dozens
# of sessions BEFORE any code was written. Each check fails LOUD with the exact
# fix. Run once when you cut a worktree (and any time the build acts strange):
#
#   bash .claude/lifecycle/preflight.sh [--repo <path>]
#
# Exit 0 = ready to build. Non-zero = a blocking setup problem (fix printed).
# Warnings (stale Vite) do not fail the gate.
#
# APP-AGNOSTIC (agent-kit): the app-specific checks (build seed, vendored
# submodule, node workspaces, build-DB isolation, dev-config seed) are driven by
# an app-provided `.claude/app.config` (a plain KEY=value data file — NEVER
# sourced). A check whose key is UNSET is SKIPPED, not failed, so this same
# script runs unchanged across ziee, CytoAnalyst, and any future app. With no
# app.config at all, only the generic checks (stale-Vite) run and the gate exits
# 0. See app.config.example for the full key list + the "unset ⇒ skip" contract.
#
# CROSS-PLATFORM: runs under bash on Linux, macOS, and Windows (git-bash — the
# same shell git uses to run the pre-push hook, so it is guaranteed present
# wherever this infra's hook works). Every check avoids GNU-only flags and
# guards Unix-only tools (pgrep/pg_isready) with `command -v`; fix hints call
# out the per-OS command where it differs.
set -u

# OS label for platform-specific fix hints (Darwin / Linux / MINGW*/MSYS* = Windows git-bash).
case "$(uname -s 2>/dev/null)" in
  Darwin) OSLABEL=macos ;;
  Linux)  OSLABEL=linux ;;
  MINGW*|MSYS*|CYGWIN*) OSLABEL=windows ;;
  *) OSLABEL=unknown ;;
esac

REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "preflight: FATAL: not in a git repo (pass --repo)"; exit 2; }
fi

# --- app.config (the de-ziee-ify seam) ------------------------------------
# A plain KEY=value data file at <repo>/.claude/app.config. Read it by hand
# (grep, NOT `source`) — a committed config a gate consumes must never be able
# to execute arbitrary shell.
CONFIG="$REPO/.claude/app.config"
# cfg <KEY> — prints the value (everything after the first '='), CR-stripped and
# leading/trailing-whitespace-trimmed (to match merge-gate.mjs's .trim(), so the
# two consumers of the same file agree). Empty when the file or key is absent;
# on a duplicate key it keeps the FIRST occurrence (grep|head -1), matching the
# node parser's keep-first rule.
cfg() {
  [ -f "$CONFIG" ] || return 0
  local line
  line="$(grep -E "^$1=" "$CONFIG" 2>/dev/null | head -1)" || return 0
  [ -n "$line" ] || return 0
  local val="${line#*=}"
  printf '%s' "$val" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

FAIL=0
ok()   { printf '  \033[32mok  \033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; printf '        fix: %s\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"; }
skip() { printf '  \033[90m--  \033[0m %s\n' "$*"; }

echo "== feature-lifecycle preflight ($REPO) =="
if [ ! -f "$CONFIG" ]; then
  warn "no .claude/app.config — running generic checks only (app-specific checks are app.config-driven; see app.config.example)" ""
fi

# 1. build seed present — else an app whose build embeds a fetched seed PANICS
#    at build time (ziee: hub_seed is fail-hard).  32 sessions.
SEED_REL="$(cfg PREFLIGHT_SEED_FILE)"
if [ -n "$SEED_REL" ]; then
  SEED="$REPO/$SEED_REL"
  SEED_HINT="$(cfg PREFLIGHT_SEED_HINT)"
  [ -n "$SEED_HINT" ] || SEED_HINT="regenerate or copy the build seed at $SEED_REL"
  if [ -f "$SEED" ]; then
    ok "build seed present ($SEED_REL)"
  else
    bad "build seed missing at $SEED_REL — the build PANICS without it" "$SEED_HINT"
  fi
else
  skip "build-seed check (PREFLIGHT_SEED_FILE unset)"
fi

# 2. vendored submodule initialized — else migrations / native build that depend
#    on it fail (ziee: pgvector → migration 46 CREATE EXTENSION + the memory build).
SUBMOD="$(cfg PREFLIGHT_SUBMODULE)"
if [ -n "$SUBMOD" ]; then
  P="$REPO/$SUBMOD"
  if [ -n "$(ls -A "$P" 2>/dev/null)" ]; then
    ok "submodule $SUBMOD initialized"
  elif grep -q "$SUBMOD" "$REPO/.gitmodules" 2>/dev/null; then
    bad "submodule NOT initialized ($SUBMOD is empty)" \
        "git -C \"$REPO\" submodule update --init $SUBMOD"
  else
    ok "submodule $SUBMOD not declared (skipping)"
  fi
else
  skip "submodule check (PREFLIGHT_SUBMODULE unset)"
fi

# 3. node_modules hoisted — npm workspaces hoist to the REPO ROOT; a missing/stale
#    tree gives phantom tsc errors (esp. on kit branches).
NODE_WS="$(cfg PREFLIGHT_NODE_WORKSPACES)"
if [ -n "$NODE_WS" ]; then
  if [ -d "$REPO/node_modules" ]; then
    ok "root node_modules present (workspace hoist)"
  else
    bad "root node_modules missing — tsc/lint will show phantom missing-module errors" \
        "cd \"$REPO\" && npm install   (hoists deps for the ui workspaces)"
  fi
  # Per-workspace node_modules is usually a symlink into the root hoist; a missing
  # one is only a problem if that workspace has un-hoistable deps. Warn, don't block.
  for ws in $NODE_WS; do
    if [ -d "$REPO/$ws" ] && [ ! -e "$REPO/$ws/node_modules" ]; then
      warn "$ws/node_modules absent (fine if fully hoisted; re-run npm install if tsc shows phantom errors)" \
           "cd \"$REPO\" && npm install"
    fi
  done
else
  skip "node_modules check (PREFLIGHT_NODE_WORKSPACES unset)"
fi

# 4. Per-worktree build-DB isolation — a shared build DB is wiped by every
#    concurrent build; without isolation two worktrees clobber each other.  60 sessions.
BDB_ENV="$(cfg PREFLIGHT_BUILD_DB_ENV)"
BDB_HP="$(cfg PREFLIGHT_BUILD_DB_HOSTPORT)"
BDB_SENTINEL="$(cfg PREFLIGHT_BUILD_DB_SENTINEL)"
if [ -n "$BDB_ENV" ] || [ -n "$BDB_HP" ]; then
  # indirect-read the env var named by the config (bash 3.2+; the shebang is bash).
  # SECURITY: the var NAME comes from a committed config file, and bash indirect
  # expansion ${!name} EVALUATES an array-subscript/command-substitution embedded
  # in the name (e.g. name='x[$(cmd)]' runs cmd) — which would violate this file's
  # "READ, never sourced / cannot execute shell" contract. So reject any
  # PREFLIGHT_BUILD_DB_ENV that is not a plain POSIX identifier before expanding.
  BDB_VAL=1
  if [ -n "$BDB_ENV" ]; then
    if printf '%s' "$BDB_ENV" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
      BDB_VAL="${!BDB_ENV:-1}"
    else
      warn "PREFLIGHT_BUILD_DB_ENV is not a valid shell identifier ('$BDB_ENV') — ignoring it (a config value is never evaluated as code)" ""
      BDB_ENV=""
    fi
  fi
  # build the "local cluster" match pattern from the configured host:port.
  LOCAL_RE=""
  if [ -n "$BDB_HP" ]; then
    HP_ESC="$(printf '%s' "$BDB_HP" | sed 's/\./\\./g')"
    PORT="${BDB_HP##*:}"
    LOCAL_RE="$HP_ESC|localhost:$PORT"
    [ -n "$BDB_SENTINEL" ] && LOCAL_RE="$LOCAL_RE|$BDB_SENTINEL"
  elif [ -n "$BDB_SENTINEL" ]; then
    LOCAL_RE="$BDB_SENTINEL"
  fi
  if [ -n "$BDB_ENV" ] && [ "$BDB_VAL" = "0" ]; then
    bad "$BDB_ENV=0 — per-worktree build-DB isolation is DISABLED (shared build-DB race)" \
        "unset $BDB_ENV   (auto-isolation keys the build DB by worktree path)"
  elif [ -n "${DATABASE_URL:-}" ] && [ -n "$LOCAL_RE" ] && ! printf '%s' "$DATABASE_URL" | grep -qE "$LOCAL_RE"; then
    # A genuine external override (different host:port, e.g. CI) is honored as-is.
    warn "DATABASE_URL is an external override ($DATABASE_URL) — build.rs will use it verbatim (fine for CI; NOT auto-isolated)" \
         "unset DATABASE_URL to use per-worktree auto-isolation when developing locally"
  else
    ok "per-worktree build-DB isolation active (auto-keyed by worktree path)"
  fi
else
  skip "build-DB isolation check (PREFLIGHT_BUILD_DB_ENV/HOSTPORT unset)"
fi

# 5. build-DB cluster reachable (info) — the local build cluster on the configured host:port.
if [ -n "$BDB_HP" ]; then
  BDB_HOST="${BDB_HP%:*}"
  BDB_PORT="${BDB_HP##*:}"
  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h "$BDB_HOST" -p "$BDB_PORT" -q 2>/dev/null; then ok "build-DB cluster reachable on $BDB_HP"
    else warn "build-DB cluster NOT reachable on $BDB_HP (build.rs will provision it, or start it)" \
              "start your build database (e.g. docker compose up -d)"; fi
  else
    warn "pg_isready not installed — cannot verify the $BDB_HP build cluster (build.rs handles provisioning)" ""
  fi
fi

# 6. no stale Vite serving old code — a lingering dev server hides code changes in e2e.
#    GENERIC dev-hygiene check (always on; warn-only). Portable detection: `pgrep -f`
#    works on Linux AND macOS (the `-a` flag does NOT — procps/Linux-only — so we drop
#    it); fall back to `ps` piped to grep; skip silently if neither tool exists.
VITE_PIDS=""
if command -v pgrep >/dev/null 2>&1; then
  VITE_PIDS="$(pgrep -f 'vite --config' 2>/dev/null | head -5)"
elif command -v ps >/dev/null 2>&1; then
  VITE_PIDS="$(ps ax 2>/dev/null | grep '[v]ite --config' | awk '{print $1}' | head -5)"
fi
if [ -n "$VITE_PIDS" ]; then
  VITE_PIDS_ONELINE="$(printf '%s ' $VITE_PIDS)"
  case "$OSLABEL" in
    windows) VITE_FIX='Stop-Process -Id <pid>  (PowerShell), or `wsl --shutdown` if Vite runs in WSL2' ;;
    *)       VITE_FIX='pkill -f "vite --config"   (NOT killall node)' ;;
  esac
  warn "stale Vite dev server(s) running (PIDs: ${VITE_PIDS_ONELINE}) — may serve OLD code in e2e" "$VITE_FIX"
elif command -v pgrep >/dev/null 2>&1 || command -v ps >/dev/null 2>&1; then
  ok "no stale Vite dev servers"
else
  warn "cannot scan for stale Vite (no pgrep/ps on PATH) — if e2e serves stale code, kill the dev server manually" ""
fi

# 7. dev server config present with a REAL jwt secret — a fresh worktree ships only
#    <config>.example (the real config is gitignored / per-machine), so the backend
#    can't boot, and it hard-refuses to boot on the example's placeholder secret.
#    Auto-fix: seed the real config from the example with a generated secret (only when
#    absent — non-destructive).
# PLACEHOLDER MATCHING — compare the VALUE, never one spelling of it.
#
# This used to be `grep -qE '^[[:space:]]*secret:[[:space:]]*"$PLACEHOLDER"'`,
# with the double quotes literally part of the pattern. YAML accepts three
# spellings of the same scalar and that regex saw exactly one of them:
#
#     secret: "REPLACE_ME_…"   → refused      (correct)
#     secret: REPLACE_ME_…     → "ok  … present with a non-placeholder secret"
#     secret: 'REPLACE_ME_…'   → same false OK
#
# The bare form is the one a human hand-editing YAML is most likely to write,
# since YAML does not require the quotes. So preflight reported the environment
# ready for a config the server hard-refuses to boot on — a boot refusal that a
# green gate walks you straight into.
#
# The same quoted-only assumption was in the SEED path two ways: the example was
# searched for `"PLACEHOLDER"` (an unquoted example could not be seeded at all,
# and the failure was reported as a missing placeholder) and the substitution was
# a `sed` whose LHS interpolated $PLACEHOLDER into a regex — a placeholder with a
# `.` or `*` in it matched the wrong span or nothing.
#
# All three helpers below are LITERAL, metacharacter-safe (awk `index`/`==`, no
# regex over the placeholder) and quote-agnostic.

# ph_secret_line <placeholder> <file> — exit 0 iff a `secret:` line's value,
# with optional matching single/double quotes and trailing space stripped,
# EQUALS the placeholder.
ph_secret_line() {
  awk -v ph="$1" '
    /^[[:space:]]*secret:[[:space:]]*/ {
      v = $0
      sub(/^[[:space:]]*secret:[[:space:]]*/, "", v)
      sub(/[[:space:]]+$/, "", v)
      if (length(v) > 1) {
        f = substr(v, 1, 1); l = substr(v, length(v), 1)
        if ((f == "\"" && l == "\"") || (f == "'"'"'" && l == "'"'"'")) v = substr(v, 2, length(v) - 2)
      }
      if (v == ph) { found = 1; exit }
    }
    END { exit (found ? 0 : 1) }' "$2"
}

# ph_anywhere <placeholder> <file> — exit 0 iff the placeholder appears on any
# non-comment line. Catches the block-scalar spellings (`secret: >-` with the
# value on the following line) that no single-line rule can see, and any OTHER
# key the example left unfilled.
ph_anywhere() {
  awk -v ph="$1" '
    { line = $0; sub(/^[[:space:]]*/, "", line) }
    line ~ /^#/ { next }
    index($0, ph) { found = 1; exit }
    END { exit (found ? 0 : 1) }' "$2"
}

# ph_replace <placeholder> <replacement> <file> — literal, every occurrence, to
# stdout. Quoting in the source is preserved because only the placeholder token
# itself is replaced: `secret: "PH"` → `secret: "<secret>"`, `secret: PH` →
# `secret: <secret>`.
ph_replace() {
  awk -v ph="$1" -v rep="$2" '
    {
      out = ""; rest = $0; n = length(ph)
      while ((i = index(rest, ph)) > 0) {
        out = out substr(rest, 1, i - 1) rep
        rest = substr(rest, i + n)
      }
      print out rest
    }' "$3"
}

CFG_DIR_REL="$(cfg PREFLIGHT_CONFIG_DIR)"
CFG_FILE="$(cfg PREFLIGHT_CONFIG_FILE)"
CFG_EXAMPLE="$(cfg PREFLIGHT_CONFIG_EXAMPLE)"
PLACEHOLDER="$(cfg PREFLIGHT_CONFIG_PLACEHOLDER)"
if [ -n "$CFG_DIR_REL" ] && [ -n "$CFG_FILE" ] && [ -n "$CFG_EXAMPLE" ] && [ -n "$PLACEHOLDER" ]; then
  CFG_DIR="$REPO/$CFG_DIR_REL"
  DEV_CFG="$CFG_DIR/$CFG_FILE"
  DEV_EX="$CFG_DIR/$CFG_EXAMPLE"
  gen_secret() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -base64 48 | tr -d '\n'
    elif [ -r /dev/urandom ]; then head -c 36 /dev/urandom | base64 | tr -d '\n'
    else printf 'dev-%s-%s-change-me-to-a-random-48-char-secret' "$(date +%s)" "$$"; fi
  }
  if [ ! -f "$DEV_CFG" ]; then
    if [ -f "$DEV_EX" ]; then
      SECRET="$(gen_secret)"
      # replace only the exact placeholder VALUE (| delimiter: base64 never contains |).
      # Guard three ways so a bad seed is NEVER reported as a successful bootstrap:
      #  (a) the example must actually CONTAIN the configured placeholder (else the
      #      sed is a no-op and no secret is injected — a mismatched
      #      PREFLIGHT_CONFIG_PLACEHOLDER),
      #  (b) the sed must succeed and produce a non-empty file,
      #  (c) the placeholder must be GONE from the result (the substitution ran).
      if ! grep -qF -- "$PLACEHOLDER" "$DEV_EX"; then
        bad "$CFG_EXAMPLE does not contain the placeholder \"$PLACEHOLDER\" — cannot inject a jwt.secret (check PREFLIGHT_CONFIG_PLACEHOLDER)" \
            "set PREFLIGHT_CONFIG_PLACEHOLDER to the exact placeholder value that appears in $CFG_EXAMPLE"
      elif ph_replace "$PLACEHOLDER" "$SECRET" "$DEV_EX" > "$DEV_CFG" && [ -s "$DEV_CFG" ] && ! grep -qF -- "$PLACEHOLDER" "$DEV_CFG"; then
        ok "bootstrapped $CFG_DIR_REL/$CFG_FILE from $CFG_EXAMPLE (generated a random jwt.secret; edit for an external DB)"
      else
        rm -f "$DEV_CFG"
        bad "failed to bootstrap $CFG_DIR_REL/$CFG_FILE from $CFG_EXAMPLE (sed error / placeholder not replaced)" \
            "author $DEV_CFG manually — the server will not boot without it"
      fi
    else
      bad "$CFG_DIR_REL/$CFG_FILE missing and no $CFG_EXAMPLE to seed from" \
          "author $DEV_CFG manually — the server will not boot without it"
    fi
  elif ph_secret_line "$PLACEHOLDER" "$DEV_CFG"; then
    bad "$CFG_DIR_REL/$CFG_FILE still has the placeholder jwt.secret — the server refuses to boot" \
        "set jwt.secret to a random >=32-char value:  openssl rand -base64 48"
  elif ph_anywhere "$PLACEHOLDER" "$DEV_CFG"; then
    bad "$CFG_DIR_REL/$CFG_FILE still contains the placeholder value \"$PLACEHOLDER\" (not on a \`secret:\` line — a block scalar, or another key the example left unfilled)" \
        "replace every occurrence with a real value; for a secret:  openssl rand -base64 48"
  else
    ok "$CFG_DIR_REL/$CFG_FILE present with a non-placeholder jwt.secret"
  fi
else
  skip "dev-config seed check (PREFLIGHT_CONFIG_* unset)"
fi

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "preflight: $FAIL blocking problem(s) — fix them before building."
  exit 1
fi
echo "preflight: OK — environment ready."
exit 0
