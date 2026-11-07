#!/usr/bin/env bash
# install.sh — link this repo's Claude Code config into ~/.claude/
#
# Links (never the whole ~/.claude directory — it holds credentials and state):
#   files:        settings.json, CLAUDE.md, loop.md    -> one symlink each,
#                 except an existing settings.json of your own: ours is merged
#                 into it (scripts/merge-settings.mjs: our hooks added, keys you
#                 lack filled in, yours kept, permissions never touched), with
#                 the file before the merge kept in the backup dir
#   directories:  skills/, agents/, workflows/, commands/, bin/
#                 -> one symlink PER ENTRY (so entries installed by other tools
#                 keep working), taken from core/<dir>/, kit/<dir>/ (standalone
#                 tools that belong to no graph), and every graphs/<graph>/<dir>/,
#                 landing flat in ~/.claude/<dir>/. Two sources with one name:
#                 refused.
#
# Usage:
#   ./install.sh              link; back up anything in the way
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh --skip=a,b   install, but leave these targets alone (e.g.
#                             --skip=settings.json,CLAUDE.md, or skills/verify)
#   ./install.sh --uninstall  remove our links, restore the most recent backup
#
# Env: CLAUDE_CONFIG_DIR overrides the target (default: $HOME/.claude).
#      HARNESS_NO_GIT_CONFIG=1 skips enabling the repo's pre-commit hook.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_DIR="${CLAUDE_DIR%/}"
BACKUP_ROOT="$CLAUDE_DIR/backups"
MANIFEST=".harness-manifest"

FILE_TARGETS=(settings.json CLAUDE.md loop.md)
DIR_TARGETS=(skills agents workflows commands bin)
# Repo dirs that hold DIR_TARGETS entries: shared core, the kit, then each graph.
SOURCE_ROOTS=(core kit)
for g in "$REPO_DIR"/graphs/*/; do [ -d "$g" ] && SOURCE_ROOTS+=("graphs/$(basename "$g")"); done

DRY_RUN=0
MODE=install
SKIP=()      # rel paths (or a whole DIR_TARGETS name) that install leaves alone

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) MODE=uninstall ;;
    --skip=*)
      # An empty value (e.g. --skip="$UNSET") must not fall through to a full install.
      [ -n "${arg#--skip=}" ] || { echo "--skip= needs at least one target" >&2; exit 2; }
      IFS=',' read -r -a parts <<< "${arg#--skip=}"; SKIP+=(${parts[@]+"${parts[@]}"}) ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$MODE" = install ] || [ "${#SKIP[@]}" -eq 0 ] || { echo "--skip only applies to install" >&2; exit 2; }

log()  { printf '%s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] $*"; else "$@"; fi
}
# Physical path of a directory, or empty if it does not exist.
physical() { [ -d "$1" ] && (cd "$1" && pwd -P) || true; }

# Refuse layouts where linking would write into, or move files out of, the repo
# itself, or write through a symlinked target dir (skills/, bin/, ...) into some other tree.
guard_layout() {
  local p t
  p="$(physical "$CLAUDE_DIR")"
  case "$p" in "$REPO_DIR"|"$REPO_DIR"/*)
    die "$CLAUDE_DIR resolves inside the repo ($REPO_DIR); refusing" ;;
  esac
  for t in "${DIR_TARGETS[@]}"; do
    if [ -L "$CLAUDE_DIR/$t" ]; then
      die "$CLAUDE_DIR/$t is a symlink (-> $(readlink "$CLAUDE_DIR/$t")). Replace it with a real directory first; per-entry links must land in $CLAUDE_DIR/$t itself"
    fi
    p="$(physical "$CLAUDE_DIR/$t")"
    case "$p" in "$REPO_DIR"|"$REPO_DIR"/*) die "$CLAUDE_DIR/$t resolves inside the repo; refusing" ;; esac
  done
}

# Print "dest<TAB>src" for every item we manage, one per line. dest is the
# path under ~/.claude; src is the path in the repo. Both are relative.
list_targets() {
  local t root entry name
  for t in "${FILE_TARGETS[@]}"; do printf '%s\t%s\n' "$t" "$t"; done
  for root in "${SOURCE_ROOTS[@]}"; do
    for t in "${DIR_TARGETS[@]}"; do
      [ -d "$REPO_DIR/$root/$t" ] || continue
      for entry in "$REPO_DIR/$root/$t"/*; do
        [ -e "$entry" ] || continue
        name="$(basename "$entry")"
        printf '%s/%s\t%s/%s/%s\n' "$t" "$name" "$root" "$t" "$name"
      done
    done
  done
}

# Refuse two repo sources that would land on the same ~/.claude path (two
# graphs both shipping agents/advisor.md). Names share one flat namespace.
check_duplicates() {
  local targets dups d
  targets="$(list_targets)"
  dups="$(cut -f1 <<< "$targets" | sort | uniq -d)"
  [ -z "$dups" ] && return 0
  while IFS= read -r d; do
    printf 'error: %s is provided by more than one source: %s\n' "$d" \
      "$(awk -F'\t' -v d="$d" '$1==d{printf "%s ", $2}' <<< "$targets")" >&2
  done <<< "$dups"
  die "rename one of each duplicate; every agent, skill, workflow, command, and bin name must be unique across core/, kit/, and graphs/"
}

# True if rel path $1 is named by --skip, directly or by its top-level dir.
is_skipped() {
  local s
  for s in ${SKIP[@]+"${SKIP[@]}"}; do
    [ "$1" = "$s" ] && return 0
    case "$1" in "$s"/*) return 0 ;; esac
  done
  return 1
}
# Refuse --skip names that match nothing, so a typo cannot silently install the target.
check_skips() {
  local s t known targets
  # Collect first: `list_targets | grep -q` under pipefail fails when grep exits
  # early on a match and list_targets takes SIGPIPE.
  targets="$(list_targets | cut -f1)"
  for s in ${SKIP[@]+"${SKIP[@]}"}; do
    known=0
    for t in "${DIR_TARGETS[@]}"; do [ "$s" = "$t" ] && known=1; done
    [ "$known" -eq 1 ] || grep -qxF -- "$s" <<< "$targets" || die "--skip: '$s' is not an install target (see the table in README.md)"
  done
}

# True if $1 is a symlink whose literal target is inside this repo.
points_into_repo() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in "$REPO_DIR"/*) return 0 ;; *) return 1 ;; esac
}
# True if $1 is a dangling symlink that looks like a harness link from a
# previous checkout location (target path ends in /<rel>). Not user data.
is_stale_harness_link() {  # $1 = path, $2 = rel
  [ -L "$1" ] && [ ! -e "$1" ] || return 1
  case "$(readlink "$1")" in */"$2") return 0 ;; *) return 1 ;; esac
}

BACKUP_DIR=""
ensure_backup_dir() {
  [ -n "$BACKUP_DIR" ] && return 0
  local ts n=0
  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUP_ROOT/$ts"
  while [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; do n=$((n + 1)); BACKUP_DIR="$BACKUP_ROOT/$ts-$n"; done
  run mkdir -p "$BACKUP_DIR"
  log "backup dir: $BACKUP_DIR"
}

backup_target() {  # $1 = rel path
  local rel="$1" dest="$CLAUDE_DIR/$1"
  ensure_backup_dir
  if [ -e "$BACKUP_DIR/$rel" ] || [ -L "$BACKUP_DIR/$rel" ]; then
    die "backup collision: $BACKUP_DIR/$rel already exists; refusing to overwrite"
  fi
  run mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  run mv "$dest" "$BACKUP_DIR/$rel"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] record '$rel' in $BACKUP_DIR/$MANIFEST"
  else
    printf '%s\n' "$rel" >> "$BACKUP_DIR/$MANIFEST"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would back up: $rel"; else log "backed up: $rel"; fi
}

# Merges our settings.json into a person's own (a regular file). Returns 0 when
# merged or nothing was missing, 3 when theirs is valid JSON but not an object
# (the caller backs it up and links ours); dies on anything else, leaving the
# file untouched. Every step checks itself: a function called from a
# condition runs without set -e. Writes in place (keeping mode and owner) only
# after the backup copies are verified; keeps the file from before the merge,
# and the merged file, in the backup dir for uninstall.
merge_settings() {  # $1 = ours (in the repo), $2 = theirs (under ~/.claude)
  local merged added rc=0 flags=()
  command -v node >/dev/null 2>&1 || die "node is needed to merge settings.json into your own; install Node, or pass --skip=settings.json"
  if is_skipped skills/bughunt; then flags+=(--no-hooks); log "settings.json: skills/bughunt is skipped, so the review gate hook is not merged"; fi
  if is_skipped bin/statusline.sh; then flags+=(--no-statusline); log "settings.json: bin/statusline.sh is skipped, so the status line is not merged"; fi
  merged="$(mktemp)" || die "mktemp failed"
  added="$(mktemp)" || die "mktemp failed"
  node "$REPO_DIR/scripts/merge-settings.mjs" merge ${flags[@]+"${flags[@]}"} "$1" "$2" >"$merged" 2>"$added" || rc=$?
  if [ "$rc" -eq 3 ]; then rm -f "$merged" "$added"; return 3; fi
  if [ "$rc" -ne 0 ]; then
    warn "$(tail -1 "$added")"
    rm -f "$merged" "$added"
    die "settings.json was left as it is; fix it, or pass --skip=settings.json"
  fi
  if [ ! -s "$added" ]; then
    log "settings.json: your own file already has everything ours adds"
    rm -f "$merged" "$added"; return 0
  fi
  sed 's/^added: /  + /' "$added"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would merge the lines above into settings.json (your own file), keeping a backup"
    rm -f "$merged" "$added"; return 0
  fi
  ensure_backup_dir
  [ -d "$BACKUP_DIR" ] || die "could not create $BACKUP_DIR; settings.json was left as it is"
  cp -p "$2" "$BACKUP_DIR/settings.json.pre-merge" && cmp -s "$2" "$BACKUP_DIR/settings.json.pre-merge" \
    || die "could not back up settings.json to $BACKUP_DIR; it was left as it is"
  cp "$merged" "$BACKUP_DIR/settings.json.merged" && cmp -s "$merged" "$BACKUP_DIR/settings.json.merged" \
    || die "could not save the merged settings to $BACKUP_DIR; settings.json was left as it is"
  if ! { cat "$merged" > "$2" && cmp -s "$merged" "$2"; }; then
    cp -p "$BACKUP_DIR/settings.json.pre-merge" "$2" 2>/dev/null || true
    die "writing settings.json failed; restored it from $BACKUP_DIR/settings.json.pre-merge"
  fi
  log "merged into settings.json (your own file; before: $BACKUP_DIR/settings.json.pre-merge)"
  rm -f "$merged" "$added"
}

# Undoes merge_settings: newest merge first, puts back the file from before
# each merge while the file is still exactly what that merge wrote. Then, if
# any of our hooks remain (the file was edited after a merge), removes just
# those hooks and keeps everything else.
unmerge_settings() {
  local dest="$CLAUDE_DIR/settings.json" dirs=() i b out removed
  [ -f "$dest" ] && [ ! -L "$dest" ] && [ -d "$BACKUP_ROOT" ] || return 0
  for i in "$BACKUP_ROOT"/*/; do [ -f "${i}settings.json.merged" ] && dirs+=("${i%/}"); done
  [ "${#dirs[@]}" -gt 0 ] || return 0
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    b="${dirs[$i]}"
    cmp -s "$dest" "$b/settings.json.merged" || break
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would restore settings.json from before the merge ($b)"; break; fi
    cat "$b/settings.json.pre-merge" > "$dest" || die "could not restore settings.json from $b"
    rm -f "$b/settings.json.pre-merge" "$b/settings.json.merged"
    find "$b" -type d -empty -delete 2>/dev/null || true
    log "restored settings.json from before the merge ($b)"
  done
  command -v node >/dev/null 2>&1 || { warn "node is missing: check settings.json for PandaStack's hooks by hand"; return 0; }
  out="$(mktemp)" || die "mktemp failed"
  removed="$(mktemp)" || die "mktemp failed"
  if node "$REPO_DIR/scripts/merge-settings.mjs" unmerge "$REPO_DIR/settings.json" "$dest" >"$out" 2>"$removed"; then
    if grep -q '^removed: ' "$removed"; then
      if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would remove PandaStack's hooks from settings.json"
      else
        cat "$out" > "$dest" || die "could not write settings.json"
        warn "settings.json changed since the merge: kept your edits, removed only what PandaStack added (its hooks, and its status line if unchanged)"
      fi
    fi
  else
    warn "settings.json could not be read ($(tail -1 "$removed")); check it for PandaStack's hooks by hand"
  fi
  rm -f "$out" "$removed"
}

# Remove symlinks under managed dirs that point into the repo but whose source
# is gone (e.g. a skill renamed or deleted in the repo).
prune_dangling() {
  local t link
  for t in "${DIR_TARGETS[@]}"; do
    [ -d "$CLAUDE_DIR/$t" ] || continue
    for link in "$CLAUDE_DIR/$t"/*; do
      [ -L "$link" ] || continue
      points_into_repo "$link" || continue
      [ -e "$link" ] && continue
      run rm "$link"
      log "pruned dangling link: ${link#"$CLAUDE_DIR"/}"
    done
  done
}

enable_git_hooks() {
  [ "${HARNESS_NO_GIT_CONFIG:-0}" = "1" ] && return 0
  git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if [ "$(git -C "$REPO_DIR" config --get core.hooksPath || true)" != ".githooks" ]; then
    run git -C "$REPO_DIR" config core.hooksPath .githooks
    log "git: core.hooksPath=.githooks (pre-commit secret scan enabled)"
  fi
}

do_install() {
  local rel src dest linked=0 skipped=0 rc
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  guard_layout
  check_duplicates
  check_skips
  run mkdir -p "$CLAUDE_DIR"
  while IFS=$'\t' read -r rel srcrel; do
    src="$REPO_DIR/$srcrel"; dest="$CLAUDE_DIR/$rel"
    if is_skipped "$rel"; then
      log "skip (--skip): $rel"; continue
    fi
    if [ ! -e "$src" ]; then
      log "skip (missing in repo): $rel"; continue
    fi
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1)); continue
    fi
    if [ "$rel" = settings.json ] && [ -f "$dest" ] && [ ! -L "$dest" ]; then
      rc=0; merge_settings "$src" "$dest" || rc=$?
      [ "$rc" -eq 0 ] && continue
      log "settings.json is valid JSON but not an object: backing it up and linking ours"
    fi
    if is_stale_harness_link "$dest" "$rel"; then
      run rm "$dest"; log "removed stale harness link: $rel -> $(readlink "$dest" 2>/dev/null || echo '?')"
    elif [ -L "$dest" ] || [ -e "$dest" ]; then
      backup_target "$rel"
    fi
    run mkdir -p "$(dirname "$dest")"
    run ln -s "$src" "$dest"
    log "linked: $rel -> $src"
    linked=$((linked + 1))
  done < <(list_targets)
  if is_skipped bin/statusline.sh && points_into_repo "$CLAUDE_DIR/settings.json"; then
    warn "settings.json is linked to ours, whose statusLine runs bin/statusline.sh, which --skip left out: the status line stays blank"
  fi
  prune_dangling
  enable_git_hooks
  log "done: $linked linked, $skipped already linked"
}

latest_backup_with_manifest() {
  local dirs=() i
  [ -d "$BACKUP_ROOT" ] || return 0
  for i in "$BACKUP_ROOT"/*/; do [ -d "$i" ] && dirs+=("${i%/}"); done
  [ "${#dirs[@]}" -gt 0 ] || return 0
  # glob results are sorted; walk from the newest (lexicographically last)
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    if [ -f "${dirs[$i]}/$MANIFEST" ]; then printf '%s\n' "${dirs[$i]}"; return 0; fi
  done
}

do_uninstall() {
  local rel dest removed=0 backup restored=0 remaining=()
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  while IFS=$'\t' read -r rel _; do
    dest="$CLAUDE_DIR/$rel"
    if points_into_repo "$dest"; then
      run rm "$dest"; log "unlinked: $rel"; removed=$((removed + 1))
    fi
  done < <(list_targets)
  prune_dangling
  unmerge_settings

  backup="$(latest_backup_with_manifest)"
  if [ -z "$backup" ]; then
    log "no backup with a manifest under $BACKUP_ROOT; nothing to restore"
    log "done: $removed unlinked"
    return 0
  fi
  log "restoring from: $backup"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    dest="$CLAUDE_DIR/$rel"
    if [ ! -e "$backup/$rel" ] && [ ! -L "$backup/$rel" ]; then
      warn "'$rel' listed in manifest but missing from backup; skipped"; continue
    fi
    # In dry-run our link was not actually removed above; treat it as gone.
    if { [ -e "$dest" ] || [ -L "$dest" ]; } && ! { [ "$DRY_RUN" -eq 1 ] && points_into_repo "$dest"; }; then
      warn "'$rel' already exists at target; left backup copy in place"
      remaining+=("$rel"); continue
    fi
    run mkdir -p "$(dirname "$dest")"
    run mv "$backup/$rel" "$dest"
    log "restored: $rel"; restored=$((restored + 1))
  done < "$backup/$MANIFEST"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "${#remaining[@]}" -eq 0 ]; then
      rm -f "$backup/$MANIFEST"
      find "$backup" -type d -empty -delete 2>/dev/null || true
      [ -d "$backup" ] && warn "$backup kept (contains unlisted files)"
    else
      printf '%s\n' "${remaining[@]}" > "$backup/$MANIFEST"
      warn "$backup kept with ${#remaining[@]} unrestored item(s); run --uninstall again after clearing the conflicts"
    fi
  fi
  log "done: $removed unlinked, $restored restored"
}

case "$MODE" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
