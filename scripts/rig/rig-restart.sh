#!/bin/bash
# rig-restart.sh — restart ONLY the merge rig process (load a newly installed auto-merge.sh) without touching the primary checkout
# or any worktree. Run only while the rig is HOLDING (between gates). Finds the running loop by its resolved binary (bash) and its
# exact script path — never by a substring match of this script's own command line — stops its process group, then relaunches it
# detached, logging to $RIG_STATE/auto-merge.log. Config: RIG_STATE (required), RIG_BIN (default: this directory).
RIG_BIN=${RIG_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
[ -n "${RIG_STATE:-}" ] || { echo "rig-restart: RIG_STATE is required" >&2; exit 2; }
[ -f "$RIG_STATE/rig.env" ] && . "$RIG_STATE/rig.env"
AM=${RIG_AUTO_MERGE:-$RIG_BIN/auto-merge.sh}; TRASH=${RIG_TRASH:-$RIG_STATE/trash}; mkdir -p "$TRASH"
pg=$(for p in /proc/[0-9]*; do [ "$(basename "$(readlink "$p/exe" 2>/dev/null)")" = bash ] || continue
  tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -qE "^(/usr)?/bin/(env )?bash $AM( |\$)" && ps -o pgid= -p "$(basename "$p")"; done 2>/dev/null | tr -d ' ' | sort -u)
for g in $pg; do kill -TERM -"$g" 2>/dev/null && echo "stopped rig pgid $g"; done
sleep 5
[ -e "$RIG_STATE/auto-merge.done" ] && mv "$RIG_STATE/auto-merge.done" "$TRASH/auto-merge.done.$(date +%s)"
setsid nohup "$AM" >> "$RIG_STATE/auto-merge.log" 2>&1 < /dev/null & disown
echo "rig restarted (new code) $(date +%H:%M)"
