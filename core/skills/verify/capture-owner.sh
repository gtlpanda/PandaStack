#!/usr/bin/env bash
# Cooperative Linux capture ownership. This file may be sourced for validation.
# All signal targets below come from root-local observations, never scope records.

co_pid() { [[ $1 =~ ^[1-9][0-9]{0,9}$ ]] && (( ${#1} < 10 || $1 <= 2147483647 )); }
co_start() { [[ $1 =~ ^[1-9][0-9]{0,19}$ ]]; }
co_uuid() { [[ $1 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }
co_parse_record() {
  local LC_ALL=C text=$1 rest part
  (( ${#text} <= 256 )) || return 1
  [[ $text == *$'\n' && ${text%$'\n'} != *$'\n'* ]] || return 1
  rest=${text%$'\n'}
  local -a values=()
  while [[ $rest == *$'\t'* ]]; do
    part=${rest%%$'\t'*}; values+=("$part"); rest=${rest#*$'\t'}
  done
  values+=("$rest")
  [[ ${#values[@]} == 8 && ${values[0]} == 1 ]] || return 1
  co_uuid "${values[1]}" && co_uuid "${values[2]}" &&
    co_pid "${values[3]}" && co_start "${values[4]}" &&
    co_pid "${values[5]}" && co_start "${values[6]}" && co_pid "${values[7]}" || return 1
  # Sourced parser output for callers; scope attribution never grants signal authority.
  # shellcheck disable=SC2034
  CO_SCOPE_ID=${values[1]}
  CO_BOOT_ID=${values[2]} CO_OWNER_PID=${values[3]} CO_OWNER_START=${values[4]}
  CO_ANCHOR_PID=${values[5]} CO_ANCHOR_START=${values[6]} CO_PGID=${values[7]}
}
co_latch() { CO_CLOSING=1; [[ ${CO_FAILURE:-} ]] || CO_FAILURE=$1; }
co_can_grant() { [[ ${CO_CLOSING:-0} == 0 ]]; }
co_identity_matches() {
  [[ $1 == "$4" && $2 == "$5" && $3 == "$6" && $7 =~ ^[RSDTtIWP]$ ]]
}
co_settled() { [[ $1 == empty && $2 == yes ]]; }
# Populates CO_PROC_* using a kernel snapshot. No caller may supply production facts.
co_proc() {
  local pid=$1 line rest
  co_pid "$pid" || return 1
  IFS= read -r line < "/proc/$pid/stat" 2>/dev/null || return 1
  [[ $line == "$pid ("* && $line == *') '* ]] || return 1
  rest=${line##*) }
  local -a fields
  read -r -a fields <<< "$rest"
  (( ${#fields[@]} >= 20 )) || return 1
  CO_PROC_PID=$pid CO_PROC_STATE=${fields[0]} CO_PROC_PARENT=${fields[1]} CO_PROC_PGID=${fields[2]} CO_PROC_START=${fields[19]}
  [[ $CO_PROC_STATE =~ ^[RSDTtIWPZX]$ ]] || return 1
  [[ $CO_PROC_PARENT == 0 ]] || co_pid "$CO_PROC_PARENT" || return 1
  { [[ $CO_PROC_PGID == 0 ]] || co_pid "$CO_PROC_PGID"; } && { [[ $CO_PROC_START == 0 ]] || co_start "$CO_PROC_START"; }
}
co_live() { [[ $CO_PROC_STATE =~ ^[RSDTtIWP]$ ]]; }
co_path() {
  local leaf=$1 rest component path=''
  [[ $leaf == /* && $leaf != / && $leaf != */ && $leaf != *'//'*  ]] 2>/dev/null || return 1
  [[ $leaf != *$'\r'* && $leaf != *$'\n'* ]] || return 1
  rest=${leaf#/}
  while [[ $rest ]]; do
    component=${rest%%/*}
    [[ $component && $component != . && $component != .. ]] || return 1
    path+=/$component
    [[ -d $path && ! -L $path ]] || return 1
    if [[ $rest == */* ]]; then rest=${rest#*/}; else rest=''; fi
  done
  [[ $(stat -c '%u:%a' -- "$leaf" 2>/dev/null) == "$UID:700" ]]
}
co_file() {
  local file=$1 kind=$2
  [[ ! -L $file ]] || return 1
  if [[ $kind == regular ]]; then [[ -f $file ]] || return 1; else [[ -p $file ]] || return 1; fi
  [[ $(stat -c '%u:%a' -- "$file" 2>/dev/null) == "$UID:600" ]]
}
co_capabilities() {
  local command
  for command in stat setsid timeout mkfifo chmod bash mv; do command -v "$command" >/dev/null 2>&1 || return 1; done
  [[ -r /proc/sys/kernel/random/boot_id && -r /proc/sys/kernel/random/uuid && -r /proc/$BASHPID/stat ]] || return 1
  # Require the exact bounded writer options before admitting a payload.
  timeout --foreground --kill-after=1 1 bash -c ':' </dev/null >/dev/null 2>&1
}
capture_join() {
  local LC_ALL=C
  local leaf=$1 bytes size boot current=$BASHPID next seen=' ' count=0 owner_group
  co_capabilities && co_path "$leaf" && co_file "$leaf/scope-v1.tsv" regular && co_file "$leaf/stop" fifo || return 1
  size=$(stat -c '%s' -- "$leaf/scope-v1.tsv") || return 1
  [[ $size =~ ^[1-9][0-9]{0,2}$ ]] && ((size<=256)) || return 1
  # read -N is bounded and preserves LF; comparison to stat rejects NUL elision.
  IFS= read -r -N 257 bytes < "$leaf/scope-v1.tsv" || :
  [[ ${#bytes} == "$size" ]] && co_parse_record "$bytes" || return 1
  IFS= read -r boot < /proc/sys/kernel/random/boot_id || return 1
  [[ $boot == "$CO_BOOT_ID" && $CO_ANCHOR_PID == "$CO_PGID" && $CO_OWNER_PID != "$CO_ANCHOR_PID" ]] || return 1
  co_proc "$CO_OWNER_PID" && co_live && [[ $CO_PROC_START == "$CO_OWNER_START" && $CO_PROC_PGID != "$CO_PGID" ]] || return 1
  owner_group=$CO_PROC_PGID
  co_pid "$owner_group" || return 1
  co_proc "$CO_ANCHOR_PID" && co_live && [[ $CO_PROC_START == "$CO_ANCHOR_START" && $CO_PROC_PARENT == "$CO_OWNER_PID" && $CO_PROC_PGID == "$CO_PGID" ]] || return 1
  next=$current
  while ((count < 256)); do
    [[ $seen != *" $next "* ]] || return 1
    seen+="$next "
    co_proc "$next" && co_live && co_start "$CO_PROC_START" && [[ $CO_PROC_PGID == "$CO_PGID" ]] || return 1
    if [[ $next == "$CO_ANCHOR_PID" ]]; then
      [[ $CO_PROC_START == "$CO_ANCHOR_START" && $CO_PROC_PARENT == "$CO_OWNER_PID" ]] || return 1
      # Admission rechecks the still-live exact outside owner.
      co_proc "$CO_OWNER_PID" && co_live && [[ $CO_PROC_START == "$CO_OWNER_START" && $CO_PROC_PGID == "$owner_group" ]]
      return
    fi
    next=$CO_PROC_PARENT; ((count+=1))
  done
  return 1
}
capture_request() {
  local leaf=$1
  capture_join "$leaf" || return 125
  timeout --foreground --kill-after=1 1 bash -c 'printf "STOP\n" > "$1"' capture-stop "$leaf/stop" </dev/null >/dev/null 2>&1 || return 125
}
co_anchor() {
  local leaf=$1 grant code anchor_grant_fd anchor_release_fd release_deadline
  shift
  # The waiting anchor is granted once, only after its parent writes metadata.
  trap ':' TERM INT HUP
  exec {anchor_grant_fd}<>"$leaf/.grant" || exit 125
  IFS= read -r -t 3 -u "$anchor_grant_fd" grant || exit 125
  exec {anchor_grant_fd}>&-
  [[ $grant == GO ]] || exit 125
  VERIFY_CAPTURE_SCOPE_DIR=$leaf "$@" </dev/null 2>&1
  code=$?
  # Payload stdout/stderr is settled before publishing status. No relay process.
  exec 1>/dev/null 2>/dev/null
  if ! { printf '%s\n' "$code" > "$leaf/.status.pending" && mv -- "$leaf/.status.pending" "$leaf/.status"; }; then
    # Retain the anchor even if TERM interrupted status publication. Root owns
    # the bounded escalation; this fixed notification never chooses a target.
    timeout --foreground --kill-after=1 1 bash -c 'printf "STOP\n" > "$1"' capture-stop "$leaf/stop" </dev/null >/dev/null 2>&1 || :
  fi
  exec {anchor_release_fd}<>"$leaf/.release" || exit 125
  release_deadline=$((SECONDS+5))
  while ! IFS= read -r -t 0.1 -u "$anchor_release_fd" grant; do
    ((SECONDS < release_deadline)) || exit 125
  done
  exec {anchor_release_fd}>&-
  [[ $grant == RELEASE ]] || exit 125
  exit "$code"
}
# Checks local root identity, independently of mutable disk metadata.
co_local_anchor() {
  co_proc "$LOCAL_ANCHOR_PID" &&
    co_identity_matches "$LOCAL_ANCHOR_PID" "$LOCAL_ANCHOR_START" "$LOCAL_PGID" "$CO_PROC_PID" "$CO_PROC_START" "$CO_PROC_PGID" "$CO_PROC_STATE" &&
    [[ $CO_PROC_PARENT == "$LOCAL_OWNER_PID" ]]
}
co_membership() {
  local file pid
  CO_MEMBERS=empty
  co_local_anchor || { CO_MEMBERS=unknown; return 1; }
  for file in /proc/[0-9]*/stat; do
    pid=${file#/proc/}; pid=${pid%/stat}
    if ! co_proc "$pid"; then
      # A vanished proc is harmless; unreadable existing proc is unknown.
      [[ ! -e $file ]] || { CO_MEMBERS=unknown; return 1; }
      continue
    fi
    if [[ $CO_PROC_PGID == "$LOCAL_PGID" && $pid != "$LOCAL_ANCHOR_PID" ]] && co_live; then CO_MEMBERS=populated; fi
  done
  co_local_anchor || { CO_MEMBERS=unknown; return 1; }
}
co_mark_failure() {
  co_latch "$1"
  if [[ ! -e $LOCAL_LEAF/.incomplete ]]; then (umask 077; printf '%s\n' "$CO_FAILURE" > "$LOCAL_LEAF/.incomplete"); fi
}
co_stop_local() {
  co_mark_failure "${1:-capture-incomplete}"
  # Identity is checked immediately before each signal. No disk record selects it.
  if co_local_anchor; then kill -TERM -- "-$LOCAL_PGID" 2>/dev/null || :; fi
  local until=$((SECONDS+1))
  while ((SECONDS < until)); do IFS= read -r -t 0.05 -u "$STOP_FD" -n 16 _ || :; done
  if co_local_anchor; then kill -KILL -- "-$LOCAL_PGID" 2>/dev/null || :; fi
  # Never wait indefinitely for uninterruptible/unknown membership.
  until=$((SECONDS+2))
  while ((SECONDS < until)); do
    if ! co_proc "$LOCAL_ANCHOR_PID" || [[ $CO_PROC_STATE == Z || $CO_PROC_STATE == X ]]; then wait "$LOCAL_ANCHOR_PID" 2>/dev/null || :; break; fi
    IFS= read -r -t 0.05 -u "$STOP_FD" -n 16 _ || :
  done
  return 125
}
co_root() {
  local leaf=$1
  shift
  co_capabilities && co_path "$leaf" || return 125
  # A new owner may only initialize an empty caller-owned private allocation.
  local -a entries
  shopt -s nullglob dotglob; entries=("$leaf"/*); shopt -u dotglob
  ((${#entries[@]} == 0)) || return 125
  umask 077
  local LOCAL_LEAF=$leaf LOCAL_OWNER_PID=$BASHPID LOCAL_OWNER_START LOCAL_ANCHOR_PID LOCAL_ANCHOR_START LOCAL_PGID
  local CO_CLOSING=0 CO_FAILURE='' STOP_FD GRANT_FD RELEASE_FD boot scope message='' status deadline
  co_proc "$LOCAL_OWNER_PID" || return 125
  co_start "$CO_PROC_START" || return 125
  LOCAL_OWNER_START=$CO_PROC_START
  IFS= read -r boot < /proc/sys/kernel/random/boot_id || return 125
  IFS= read -r scope < /proc/sys/kernel/random/uuid || return 125
  co_uuid "$boot" && co_uuid "$scope" || return 125
  mkfifo -m 600 -- "$leaf/stop" "$leaf/.grant" "$leaf/.release" || return 125
  exec {STOP_FD}<>"$leaf/stop" {GRANT_FD}<>"$leaf/.grant" {RELEASE_FD}<>"$leaf/.release" || return 125
  if [[ -e $leaf/.closing ]]; then co_mark_failure closing; return 125; fi
  # setsid is used once; this wrapper itself remains outside the payload group.
  setsid bash "${BASH_SOURCE[0]}" anchor "$leaf" -- "$@" {STOP_FD}>&- {GRANT_FD}>&- {RELEASE_FD}>&- &
  LOCAL_ANCHOR_PID=$!; LOCAL_PGID=$LOCAL_ANCHOR_PID
  if co_proc "$LOCAL_ANCHOR_PID"; then LOCAL_ANCHOR_START=$CO_PROC_START; fi
  deadline=$((SECONDS+2))
  while :; do
    if co_proc "$LOCAL_ANCHOR_PID" && co_start "$CO_PROC_START" && [[ ! ${LOCAL_ANCHOR_START:-} || $CO_PROC_START == "$LOCAL_ANCHOR_START" ]] && [[ $CO_PROC_PGID == "$LOCAL_PGID" && $CO_PROC_PARENT == "$LOCAL_OWNER_PID" ]] && co_live; then LOCAL_ANCHOR_START=$CO_PROC_START; break; fi
    if ((SECONDS >= deadline)); then co_stop_local anchor-admission; return 125; fi
    # NUL terminates successfully; other partial bytes count even on read failure.
    message=''
    if IFS= read -r -d '' -t 0.02 -u "$STOP_FD" -n 16 message || [[ $message ]]; then co_stop_local stop-before-grant; return 125; fi
  done
  printf '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$scope" "$boot" "$LOCAL_OWNER_PID" "$LOCAL_OWNER_START" "$LOCAL_ANCHOR_PID" "$LOCAL_ANCHOR_START" "$LOCAL_PGID" > "$leaf/scope-v1.tsv" || { co_stop_local record-write; return 125; }
  chmod 600 -- "$leaf/scope-v1.tsv" || { co_stop_local record-mode; return 125; }
  trap 'co_stop_local interrupted; exit 125' TERM INT HUP
  # Any pending message, including malformed/partial input, closes admission.
  message=''
  if IFS= read -r -d '' -t 0.01 -u "$STOP_FD" -n 16 message || [[ $message ]]; then co_stop_local stop-before-grant; return 125; fi
  if [[ -e $leaf/.closing ]]; then co_stop_local closing; return 125; fi
  co_can_grant && co_local_anchor || { co_stop_local grant-denied; return 125; }
  printf 'GO\n' >&"$GRANT_FD" || { co_stop_local grant-write; return 125; }
  deadline=0
  while :; do
    if [[ -e $leaf/.closing ]]; then co_stop_local closing; return 125; fi
    message=''
    if IFS= read -r -d '' -t 0.05 -u "$STOP_FD" -n 16 message || [[ $message ]]; then co_stop_local stop-request; return 125; fi
    co_local_anchor || { co_stop_local anchor-lost; return 125; }
    if [[ -f $leaf/.status && ! -L $leaf/.status ]]; then
      IFS= read -r status < "$leaf/.status" || { co_stop_local invalid-status; return 125; }
      [[ $status =~ ^(0|[1-9][0-9]{0,2})$ ]] && ((status<=255)) || { co_stop_local invalid-status; return 125; }
      ((deadline)) || deadline=$((SECONDS+2))
      co_membership || { co_stop_local unknown-membership; return 125; }
      if co_settled "$CO_MEMBERS" yes; then
        printf 'RELEASE\n' >&"$RELEASE_FD" || { co_stop_local release-failed; return 125; }
        local join_deadline=$((SECONDS+2))
        while co_proc "$LOCAL_ANCHOR_PID" && [[ $CO_PROC_STATE != Z && $CO_PROC_STATE != X ]]; do
          [[ $CO_PROC_START == "$LOCAL_ANCHOR_START" ]] || { co_mark_failure stale-anchor; return 125; }
          if ((SECONDS >= join_deadline)); then co_stop_local anchor-join; return 125; fi
          message=''
          if IFS= read -r -d '' -t 0.02 -u "$STOP_FD" -n 16 message || [[ $message ]]; then co_stop_local stop-during-join; return 125; fi
        done
        wait "$LOCAL_ANCHOR_PID"; local result=$?
        [[ $result == "$status" ]] || { co_mark_failure anchor-status; return 125; }
        printf 'settled\n' > "$leaf/.settled" || { co_mark_failure settle-write; return 125; }
        trap - TERM INT HUP
        return "$status"
      fi
      if ((SECONDS >= deadline)); then co_stop_local populated-membership; return 125; fi
    fi
  done
}
co_main() {
  set +m
  local mode=${1:-} leaf=${2:-}
  [[ $# -ge 2 ]] || return 125
  shift 2
  case $mode in
    request) [[ $# == 0 ]] || return 125; capture_request "$leaf" ;;
    run)
      [[ ${1:-} == -- && $# -ge 2 ]] || return 125; shift
      if [[ ${VERIFY_CAPTURE_SCOPE_DIR+x} ]]; then
        [[ $VERIFY_CAPTURE_SCOPE_DIR == "$leaf" ]] && capture_join "$leaf" || return 125
        exec "$@" </dev/null 2>&1
      else co_root "$leaf" "$@"; fi ;;
    anchor) [[ ${1:-} == -- && $# -ge 2 ]] || return 125; shift; co_anchor "$leaf" "$@" ;;
    *) return 125 ;;
  esac
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then co_main "$@"; exit $?; fi
