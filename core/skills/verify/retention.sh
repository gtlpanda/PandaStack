#!/usr/bin/env bash
# No optional language runtime is needed to verify a shell/Go/Python project.
set -uo pipefail
umask 077
fail() { if [[ -n "${SESSION_VALIDATED:-}" ]]; then printf 'capture incomplete\n' >"$SESSION_VALIDATED/.incomplete" || :; fi; echo 'Verification evidence capture failed' >&2; exit 125; }
CAPTURE_OWNER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/capture-owner.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=capture-owner.sh
source "$CAPTURE_OWNER" || fail
for tool in stat sha256sum mktemp mkdir chmod head wc mv rm setsid sleep mkfifo rmdir; do command -v "$tool" >/dev/null 2>&1 || fail; done
private_root() {
  local path="$1" current
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  current="$path"
  while :; do [[ ! -L "$current" ]] || return 1; [[ "$current" == / ]] && break; current="${current%/*}"; [[ -n "$current" ]] || current=/; done
  [[ -d "$path" && "$(stat -c %a "$path")" == 700 && "$(stat -c %u "$path")" == "$UID" ]]
}
quote() {
  local value="$1" ch code i
  printf '"'
  LC_ALL=C
  for ((i=0;i<${#value};i++)); do
    ch="${value:i:1}"
    case "$ch" in '"') printf '\\"';; '\') printf '\\\\';; *) printf -v code '%d' "'$ch"; if ((code<32)); then printf '\\u%04x' "$code"; else printf '%s' "$ch"; fi;; esac
  done
  printf '"'
}
birth() { local raw rest; [[ -r "/proc/$1/stat" ]] || return 1; IFS= read -r raw <"/proc/$1/stat" || return 1; rest="${raw##*) }"; local fields; read -r -a fields <<<"$rest"; printf '%s' "${fields[19]}"; }
budget() {
  local session="$1" change="$2" n used amount next
  private_root "$session" || return 1
  SESSION_VALIDATED="$session"
  for ((n=0;n<200;n++)); do mkdir "$session/.budget-lock" 2>/dev/null && break; sleep .01; done
  ((n<200)) || return 1
  if [[ ! -f "$session/.budget" || -L "$session/.budget" ]]; then rmdir "$session/.budget-lock"; return 1; fi
  used="$(<"$session/.budget")"; [[ "$used" =~ ^[0-9]+$ ]] || { rmdir "$session/.budget-lock"; return 1; }
  if [[ "$change" == reserve ]]; then amount=$((128*1024*1024-used)); ((amount>16*1024*1024)) && amount=$((16*1024*1024)); else amount="$change"; fi
  next=$((used+amount)); ((next>=0&&next<=128*1024*1024)) || { rmdir "$session/.budget-lock"; return 1; }
  printf '%s' "$next" >"$session/.budget" || { rmdir "$session/.budget-lock"; return 1; }; rmdir "$session/.budget-lock" || return 1; printf '%s' "$amount"
}
case "${1:-}" in
 init)
  parent="${2:-}"
  if [[ -n "$parent" ]]; then private_root "$parent" || fail; else parent="$(mktemp -d "${TMPDIR:-/tmp}/verify-evidence.XXXXXX")" || fail; fi
  session="${3:-}"
  if [[ -n "$session" ]]; then private_root "$session" || fail; [[ "$session" == "$parent/"* ]] || fail; parent="$session"; fi
  dir="$(mktemp -d "$parent/run.XXXXXX")" || fail
  [[ -n "$session" ]] || { printf '0' >"$dir/.budget" || fail; }
  printf '{"schemaVersion":1,"steps":[]}\n' >"$dir/manifest.json" || fail
  : >"$dir/.steps" || fail; printf '0\n' >"$dir/.bytes" || fail
  printf '%s\n' "$dir"
  ;;
 finalize)
  dir="${2:-}"; session="${3:-}"; private_root "$dir" && private_root "$session" || fail
  [[ "$dir" == "$session" ]] || exit 0
  SESSION_VALIDATED="$session"
  children=''; total=0
  for manifest in "$dir"/run*/manifest.json; do
    [[ -e "$manifest" ]] || continue
    [[ -f "$manifest" && ! -L "$manifest" && ! -L "${manifest%/*}" ]] || fail
    hashline="$(sha256sum "$manifest")" || fail; read -r hash _ <<<"$hashline" || fail; bytes="$(wc -c <"$manifest")" || fail
    total=$((total+bytes)); ((total<=1024*1024)) || fail
    [[ -z "$children" ]] || children+=','
    children+="{\"path\":$(quote "${manifest#"$dir/"}"),\"sha256\":\"$hash\",\"bytes\":$bytes,\"complete\":true}"
  done
  next="$(mktemp "$dir/final.XXXXXX")" || fail
  { printf '{"schemaVersion":1,"steps":['; while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\n' "$line"; done <"$dir/.steps"; printf '],"children":[%s]}\n' "$children"; } >"$next" || fail
  mv "$next" "$dir/manifest.json" || fail
  [[ ! -e "$session/.incomplete" ]] || exit 125
  ;;
 step)
  dir="${2:-}"; label="${3:-}"; [[ "${4:-}" == -- && $# -ge 5 ]] || fail; shift 4
  private_root "$dir" || fail
  for file in manifest.json .steps .bytes; do [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || fail; done
  IFS= read -r used <"$dir/.bytes"; [[ "$used" =~ ^[0-9]+$ ]] || fail
  session="${VERIFY_CAPTURE_SESSION:-$dir}"; [[ "$dir" == "$session" || "$dir" == "$session/"* ]] || fail; private_root "$session" || fail; SESSION_VALIDATED="$session"; limit="$(budget "$session" reserve)" || fail; ((limit>=0)) || fail
  log="$(mktemp "$dir/step.XXXXXX.log")" || fail; raw="$(mktemp "$dir/raw.XXXXXX")" || fail; fifo="$raw.pipe"
  mkfifo "$fifo" || fail
  joined=false
  if [[ ${VERIFY_CAPTURE_SCOPE_DIR+x} ]]; then
    joined=true; scope="$VERIFY_CAPTURE_SCOPE_DIR"; capture_join "$scope" || fail
  else scope="$(mktemp -d "$dir/scope.XXXXXX")" || fail; fi
  set +m
  bash "$CAPTURE_OWNER" run "$scope" -- "$@" >"$fifo" & pid=$!
  owner="$(birth "$pid")" || owner=''
  stop_owned() {
    if [[ "$joined" == true ]]; then capture_request "$scope" || :
    else
      printf 'closing\n' >"$scope/.closing" || :
      timeout --foreground --kill-after=1 1 bash -c '[[ -p "$1/stop" ]] && printf "STOP\n" >"$1/stop"' bash "$scope" || :
    fi
  }
  stopped=false; trap 'stopped=true; stop_owned' TERM INT
  head -c "$((limit+1))" "$fifo" >"$raw" & readerPid=$!
  wait "$readerPid"; reader=$?
  size="$(wc -c <"$raw")"; complete=true; rc=0
  if [[ "$stopped" == true ]] || ((reader!=0||size>limit)); then
    complete=false; stop_owned
    for ((n=0;n<150;n++)); do [[ "$(birth "$pid" 2>/dev/null || :)" != "$owner" ]] && break; sleep .02; done
    if [[ -n "$owner" && "$(birth "$pid" 2>/dev/null || :)" == "$owner" ]]; then rc=125; else wait "$pid" 2>/dev/null || :; fi
    rc=125
  else
    wait "$pid"; rc=$?
    if [[ "$joined" == true ]] && ! capture_join "$scope"; then complete=false; rc=125; fi
    if [[ -e "$scope/.incomplete" || ( "$joined" == false && ! -f "$scope/.settled" ) ]]; then complete=false; rc=125; fi
  fi
  trap - TERM INT
  head -c "$limit" "$raw" >"$log" || { complete=false; rc=125; }
  rm -f "$raw" "$fifo"
  bytes="$(wc -c <"$log")" || fail; budget "$session" "$((bytes-limit))" >/dev/null || { complete=false; rc=125; }; hashline="$(sha256sum "$log")" || fail; read -r hash _ <<<"$hashline" || fail
  if [[ "$complete" == false ]]; then printf 'capture incomplete\n' >"$session/.incomplete" || fail; fi
  row="{\"label\":$(quote "$label"),\"exitCode\":$rc,\"log\":{\"path\":$(quote "${log##*/}"),\"sha256\":\"$hash\",\"bytes\":$bytes,\"complete\":$complete}}"
  if [[ -s "$dir/.steps" ]]; then printf ',\n' >>"$dir/.steps" || fail; fi
  printf '%s' "$row" >>"$dir/.steps" || fail
  next="$(mktemp "$dir/manifest.XXXXXX")" || fail
  { printf '{"schemaVersion":1,"steps":['; while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\n' "$line"; done <"$dir/.steps"; printf ']}\n'; } >"$next" || fail
  mv "$next" "$dir/manifest.json" || fail; printf '%s\n' "$((used+bytes))" >"$dir/.bytes" || fail
  printf '%s\n' "$log"; exit "$rc"
  ;;
 *) fail;;
esac
