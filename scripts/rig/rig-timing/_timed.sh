#!/bin/bash
# rig-timing shim core ("time each merge-gate stage"). Sourced by the `just` / `cargo` shims that
# auto-merge.sh puts FIRST on PATH for the gate only. Records every call (start, end, secs, rc, depth, cwd, args) to
# $RIG_TIMING_DIR/calls.tsv. The TOP-LEVEL `just` call (depth 0 — the gate's C3/C7/C9 commands) also runs with
# --verbose --timestamp and keeps its whole output in $RIG_TIMING_DIR/just-<n>-<recipe>.log, because merge-gate.mjs
# discards a passing stage's output. Output goes to a FILE then is replayed (never a pipe: a background child holding a
# pipe open would hang the gate). Exit code is the real tool's, unchanged.
# The real tool is the next one on PATH after this directory (override: RIG_REAL_JUST / RIG_REAL_CARGO).
real_tool() { # $1 = tool name -> the first executable $1 on PATH that is not in this shim directory
  local here d IFS=:; here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  for d in $PATH; do
    [ -n "$d" ] && [ "$(cd "$d" 2>/dev/null && pwd -P)" != "$here" ] && [ -x "$d/$1" ] && [ ! -d "$d/$1" ] && { echo "$d/$1"; return 0; }
  done
  echo "rig-timing: no real $1 on PATH" >&2; echo "/nonexistent/$1"; return 1
}
timed_run() { # $1 = real binary, $2 = tool name, rest = args
  local real=$1 tool=$2; shift 2
  local dir=${RIG_TIMING_DIR:-}; local depth=${RIG_TIMING_DEPTH:-0}
  [ -n "$dir" ] && mkdir -p "$dir" 2>/dev/null || dir=
  [ -z "$dir" ] && exec "$real" "$@"
  local t0=$(date +%s.%N) rc
  export RIG_TIMING_DEPTH=$((depth+1))
  if [ "$tool" = just ] && [ "$depth" = 0 ]; then
    local n=$(ls "$dir"/just-*.log 2>/dev/null | wc -l); local f="$dir/just-$((n+1))-${1//[^A-Za-z0-9_-]/_}.log"
    # FLAGS, not JUST_VERBOSE/JUST_TIMESTAMP env vars: env is inherited by every nested `just` the recipes run, and tests that parse
    # `just --dry-run` output broke on the extra "===> running recipe" lines (measured in a consumer app's gate)
    "$real" --verbose --timestamp "$@" > "$f" 2>&1; rc=$?
    cat "$f"
  else
    "$real" "$@"; rc=$?
  fi
  local t1=$(date +%s.%N)
  printf '%s\t%s\t%.1f\t%s\t%s\t%s\t%s\t%s\n' "$(date -d @${t0%.*} +%H:%M:%S)" "$(date -d @${t1%.*} +%H:%M:%S)" \
    "$(awk -v a=$t0 -v b=$t1 'BEGIN{print b-a}')" "$rc" "$depth" "$tool" "$PWD" "$*" | cut -c1-600 >> "$dir/calls.tsv"
  return $rc
}
