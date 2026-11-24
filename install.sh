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
#   command line: autobuild -> one symlink in ~/.local/bin (PANDASTACK_BIN_DIR
#                 overrides it); backups and --skip name it local-bin/autobuild
#
# Usage:
#   ./install.sh              link the Claude targets as above; back up anything in
#                             the way. If `codex` is on PATH or ~/.agents exists, also
#                             link the catalog's Codex entry skills into ~/.agents/skills
#                             (the same as running --codex next; a Codex step that fails
#                             only warns, the Claude install stands)
#   ./install.sh --claude     the Claude targets only, never ~/.agents
#   ./install.sh --codex      the catalog's Codex entry skills only (every offering whose
#                             codex row is not unavailable) into ~/.agents/skills, and the
#                             review gate as a trusted PreToolUse hook in the Codex home's
#                             hooks.json (an untrusted gate is an error); needs node.
#                             With ~/.agents/skills -> ~/.claude/skills (one shared
#                             dir) it links nothing and registers only the gate.
#                             --claude and --codex are alternatives: not both
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh --skip=a,b   install, but leave these targets alone (e.g.
#                             --skip=settings.json,CLAUDE.md, or skills/verify)
#   ./install.sh --uninstall  remove our links, restore the most recent backup
#
# Env: CLAUDE_CONFIG_DIR overrides the target (default: $HOME/.claude).
#      PANDASTACK_BIN_DIR overrides where command-line tools go (default: $HOME/.local/bin).
#      PANDASTACK_CODEX_SKILLS_DIR overrides the --codex skills directory.
#      PANDASTACK_CODEX_HOME names the Codex home for the review gate hook (default:
#      $HOME/.codex); a CODEX_HOME naming another directory is not written, only warned
#      about. PANDASTACK_CODEX_BIN is the codex binary that trusts it (default: codex on PATH).
#      HARNESS_NO_GIT_CONFIG=1 skips enabling the repo's pre-commit hook.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"
CLAUDE_DIR="${CLAUDE_DIR%/}"
# The Claude config dir itself: --codex points CLAUDE_DIR at the Codex skills dir's parent below,
# and the shared-layout check (codex_skills_shared) compares against this one.
CLAUDE_HOME_DIR="$CLAUDE_DIR"
BACKUP_ROOT="$CLAUDE_DIR/backups"
MANIFEST=".harness-manifest"

FILE_TARGETS=(settings.json CLAUDE.md loop.md)
DIR_TARGETS=(skills agents workflows commands bin)
# Repo dirs that hold DIR_TARGETS entries: shared core, the kit, then each graph.
SOURCE_ROOTS=(core kit)
for g in "$REPO_DIR"/graphs/*/; do [ -d "$g" ] && SOURCE_ROOTS+=("graphs/$(basename "$g")"); done

# Command-line tools put on PATH, "<name><TAB><repo path>": each is one symlink in
# LOCAL_BIN. Their rel path (backups, the manifest, --skip) is local-bin/<name>.
PATH_TOOLS=("autobuild	graphs/autobuild/tool/bin/autobuild")
# With no HOME (a container or cron run that sets only CLAUDE_CONFIG_DIR) and no
# PANDASTACK_BIN_DIR, there is nowhere to put them: they are skipped with a note.
LOCAL_BIN="${PANDASTACK_BIN_DIR:-${HOME:+$HOME/.local/bin}}"
LOCAL_BIN="${LOCAL_BIN%/}"

DRY_RUN=0
CODEX_MODE=0
CLAUDE_ONLY=0
MODE=install
SKIP=()      # rel paths (or a whole DIR_TARGETS name) that install leaves alone

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --codex)     CODEX_MODE=1 ;;
    --claude)    CLAUDE_ONLY=1 ;;
    --uninstall) MODE=uninstall ;;
    --skip=*)
      # An empty value (e.g. --skip="$UNSET") must not fall through to a full install.
      [ -n "${arg#--skip=}" ] || { echo "--skip= needs at least one target" >&2; exit 2; }
      IFS=',' read -r -a parts <<< "${arg#--skip=}"; SKIP+=(${parts[@]+"${parts[@]}"}) ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$CLAUDE_ONLY" -eq 0 ] || [ "$CODEX_MODE" -eq 0 ] || { echo "--claude and --codex are alternatives; plain ./install.sh installs both when Codex is present" >&2; exit 2; }

# Codex installs only entry skills supported by the native CLI, plus one Codex hook: the
# review gate, in the Codex home's hooks.json (codex_review_gate). It never copies Claude
# settings/hooks, changes git configuration, or installs other agent assets.
if [ "$CODEX_MODE" -eq 1 ]; then
  CODEX_SKILLS_DIR="${PANDASTACK_CODEX_SKILLS_DIR:-${HOME:+$HOME/.agents/skills}}"
  [ -n "$CODEX_SKILLS_DIR" ] || { echo "--codex needs HOME or PANDASTACK_CODEX_SKILLS_DIR" >&2; exit 2; }
  case "$CODEX_SKILLS_DIR" in /*) ;; *) echo "PANDASTACK_CODEX_SKILLS_DIR must be absolute" >&2; exit 2 ;; esac
  case "/$CODEX_SKILLS_DIR/" in */../*|*/./*) echo "Codex skills directory must not contain . or .. components" >&2; exit 2 ;; esac
  CODEX_SKILLS_DIR="$(printf '%s' "$CODEX_SKILLS_DIR" | sed 's://*:/:g; s:/$::')"
  [ -n "$CODEX_SKILLS_DIR" ] || { echo "Codex skills directory cannot be /" >&2; exit 2; }
  CLAUDE_DIR="$(dirname "$CODEX_SKILLS_DIR")"
  BACKUP_ROOT="$CLAUDE_DIR/.pandastack-codex-backups-$(basename "$CODEX_SKILLS_DIR")"
  FILE_TARGETS=()
  DIR_TARGETS=(skills)
  LOCAL_BIN=""
elif [ -z "${HOME:-}" ] && [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
  echo "install needs HOME or CLAUDE_CONFIG_DIR" >&2; exit 2
fi

[ "$MODE" = install ] || [ "${#SKIP[@]}" -eq 0 ] || { echo "--skip only applies to install" >&2; exit 2; }

# The Codex targets come from the offering catalog: one plan run, before any change.
# Each line is "<dest><TAB><src>"; the plan's own error line reaches stderr unchanged.
CODEX_PLAN=""
if [ "$CODEX_MODE" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || { echo "--codex needs node to read the offering catalog; install Node and run again" >&2; exit 2; }
  CODEX_PLAN="$(node "$REPO_DIR/core/skills/native-runtime/install-plan.mjs" --installation-root "$REPO_DIR" --backend codex)" || exit 2
fi

log()  { printf '%s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] $*"; else "$@"; fi
}
# Physical path of a directory, or empty if it does not exist.
physical() { [ -d "$1" ] && (cd "$1" && pwd -P) || true; }

# The shared layout: the Codex skills dir is, or sits under, a symlink to the Claude skills dir
# (~/.agents/skills -> ~/.claude/skills), so each Codex entry IS the Claude entry the Claude
# install links. --codex still never links, backs up or unlinks anything through that symlink,
# but the review gate belongs in the Codex home either way. So the layout counts as shared, and
# --codex runs only its gate step, when the Codex skills dir resolves to the Claude skills dir
# (itself a real directory, outside the repo) and, to install, that dir's bughunt is a link to
# this checkout's with gate.mjs in it, or, to uninstall, our gate entry is in hooks.json. Any
# other symlinked layout is refused as before (guard_layout).
SHARED_CODEX_SKILLS=0
codex_skills_aliased() {
  local p="$CODEX_SKILLS_DIR"
  while [ "$p" != / ]; do
    [ ! -L "$p" ] || return 0
    p="$(dirname "$p")"
  done
  return 1
}
codex_skills_shared() {
  local claude_skills="$CLAUDE_HOME_DIR/skills" shared
  [ -n "$CLAUDE_HOME_DIR" ] && [ -d "$claude_skills" ] && [ ! -L "$claude_skills" ] || return 1
  shared="$(physical "$CODEX_SKILLS_DIR")"
  [ -n "$shared" ] && [ "$shared" = "$(physical "$claude_skills")" ] || return 1
  case "$shared" in "$REPO_DIR"|"$REPO_DIR"/*) return 1 ;; esac
  if [ "$MODE" = install ]; then
    [ -L "$CODEX_SKILLS_DIR/bughunt" ] \
      && [ "$(physical "$CODEX_SKILLS_DIR/bughunt")" = "$REPO_DIR/graphs/hunt/skills/bughunt" ] \
      && [ -f "$CODEX_SKILLS_DIR/bughunt/gate.mjs" ]
  else
    codex_gate_registered
  fi
}

# Refuse layouts where linking would write into, or move files out of, the repo
# itself, or write through a symlinked target dir (skills/, bin/, ...) into some other tree.
guard_layout() {
  local p t
  if [ "$CODEX_MODE" -eq 1 ]; then
    if codex_skills_aliased && codex_skills_shared; then SHARED_CODEX_SKILLS=1; return; fi
    # Refuse an aliased skills tree even when its entries already work: never
    # write through ~/.agents/skills -> ~/.claude/skills (including uninstall).
    for t in "$CODEX_SKILLS_DIR" "$BACKUP_ROOT"; do
      p="$t"
      while [ "$p" != / ]; do
        [ ! -L "$p" ] || die "--codex refuses symlinked directory $p; existing shared skill links can be used as-is, or choose a real PANDASTACK_CODEX_SKILLS_DIR"
        [ ! -e "$p" ] || [ -d "$p" ] || die "--codex needs a directory at $p"
        p="$(dirname "$p")"
      done
      case "$t" in "$REPO_DIR"|"$REPO_DIR"/*) die "$t resolves inside the repo; refusing" ;; esac
    done
    return
  fi
  p="$(physical "$CLAUDE_DIR")"
  case "$p" in "$REPO_DIR"|"$REPO_DIR"/*)
    die "$CLAUDE_DIR resolves inside the repo ($REPO_DIR); refusing" ;;
  esac
  for t in "${DIR_TARGETS[@]}"; do
    is_skipped "$t" && continue   # --skip=<dir>: install never touches it
    if [ -L "$CLAUDE_DIR/$t" ]; then
      die "$CLAUDE_DIR/$t is a symlink (-> $(readlink "$CLAUDE_DIR/$t")). Replace it with a real directory, or pass --skip=$t to leave it alone; per-entry links must land in $CLAUDE_DIR/$t itself"
    fi
    p="$(physical "$CLAUDE_DIR/$t")"
    case "$p" in "$REPO_DIR"|"$REPO_DIR"/*) die "$CLAUDE_DIR/$t resolves inside the repo; refusing" ;; esac
  done
}

# True if rel path $1 is exactly a dest in the Codex plan.
is_codex_plan_dest() {
  local d
  while IFS=$'\t' read -r d _; do
    [ -n "$d" ] && [ "$d" = "$1" ] && return 0
  done <<< "$CODEX_PLAN"
  return 1
}

# Where rel path $1 lives: under LOCAL_BIN for local-bin/<name>, else under ~/.claude.
dest_of() {
  if [ "$CODEX_MODE" -eq 1 ]; then
    is_codex_plan_dest "$1" || die "unsupported Codex target: $1"
    printf '%s/%s\n' "$CODEX_SKILLS_DIR" "${1#skills/}"
    return
  fi
  case "$1" in
    local-bin/*) printf '%s\n' "$LOCAL_BIN/${1#local-bin/}" ;;
    *) printf '%s\n' "$CLAUDE_DIR/$1" ;;
  esac
}

# Print "dest<TAB>src" for every item we manage, one per line. dest is the
# rel path (see dest_of); src is the path in the repo. Both are relative.
list_targets() {
  local t root entry name
  if [ "$CODEX_MODE" -eq 1 ]; then
    # An empty plan prints nothing, not one blank line.
    [ -z "$CODEX_PLAN" ] || printf '%s\n' "$CODEX_PLAN"
    return
  fi
  for t in "${FILE_TARGETS[@]}"; do printf '%s\t%s\n' "$t" "$t"; done
  if [ -n "$LOCAL_BIN" ]; then for t in "${PATH_TOOLS[@]}"; do printf 'local-bin/%s\n' "$t"; done; fi
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
    if [ "$CODEX_MODE" -eq 0 ] && [ "$s" = local-bin ]; then known=1; fi
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
  local rel="$1" dest
  dest="$(dest_of "$1")"
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
  [ "$CODEX_MODE" -eq 0 ] || return 0
  local t link
  for t in "${DIR_TARGETS[@]}"; do
    [ -d "$CLAUDE_DIR/$t" ] || continue
    [ "$MODE" = install ] && is_skipped "$t" && continue
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
  [ "$CODEX_MODE" -eq 0 ] || return 0
  [ "${HARNESS_NO_GIT_CONFIG:-0}" = "1" ] && return 0
  git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if [ "$(git -C "$REPO_DIR" config --get core.hooksPath || true)" != ".githooks" ]; then
    run git -C "$REPO_DIR" config core.hooksPath .githooks
    log "git: core.hooksPath=.githooks (pre-commit secret scan enabled)"
  fi
}

# Codex: the review gate (skills/bughunt/gate.mjs) as a PreToolUse hook in the Codex home's
# hooks.json, then trusted, because Codex skips an untrusted hook without a word. Anything but
# a trusted gate stops the install with an error (the plain-install Codex pass turns that into
# a warning). No Codex home yet (Codex never ran here) is a warning: run --codex again later.
# The target is PANDASTACK_CODEX_HOME, else $HOME/.codex. An inherited CODEX_HOME is never
# written on its own say-so (a test with a temp HOME would otherwise reach a real Codex home):
# when it names another directory, the install warns and says to set PANDASTACK_CODEX_HOME.
CODEX_GATE_HELPER="$REPO_DIR/graphs/hunt/skills/bughunt/codex-hook.mjs"
codex_home_dir() { printf '%s\n' "${PANDASTACK_CODEX_HOME:-${HOME:+$HOME/.codex}}"; }
# True when CODEX_HOME is set to a directory other than $1 (Codex would read its hooks there).
codex_home_elsewhere() {
  [ -n "${CODEX_HOME:-}" ] || return 1
  [ "$(physical "$CODEX_HOME")" != "$(physical "$1")" ] || [ -z "$(physical "$1")" ]
}

codex_review_gate() {
  [ "$CODEX_MODE" -eq 1 ] || return 0
  is_codex_plan_dest skills/bughunt || return 0
  if is_skipped skills/bughunt; then log "codex review gate: skills/bughunt is skipped, so the gate hook is not registered"; return 0; fi
  local home gate
  home="$(codex_home_dir)"
  gate="$CODEX_SKILLS_DIR/bughunt/gate.mjs"
  if codex_home_elsewhere "$home"; then
    warn "CODEX_HOME is $CODEX_HOME, so Codex reads its hooks there, not from ${home:-<unset>}: the review gate is not registered. Run again with PANDASTACK_CODEX_HOME=\"$CODEX_HOME\" to register it there"
    return 0
  fi
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    warn "no Codex home at ${home:-<unset: set PANDASTACK_CODEX_HOME or HOME>}: the review gate is not registered for Codex. Run Codex once, then ./install.sh --codex again"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    node "$CODEX_GATE_HELPER" merge --dry-run --codex-home "$home" --gate "$gate" || die "codex review gate: $home/hooks.json cannot be merged; fix it, or pass --skip=skills/bughunt"
    log "[dry-run] would trust the review gate hook in Codex and check that it is active"
    return 0
  fi
  node "$CODEX_GATE_HELPER" merge --codex-home "$home" --gate "$gate" || die "codex review gate: $home/hooks.json was left as it is; fix it, or pass --skip=skills/bughunt"
  node "$CODEX_GATE_HELPER" trust --codex-home "$home" --gate "$gate" \
    || die "codex review gate: the hook is in $home/hooks.json but could not be trusted, so Codex skips it and the gate is NOT active (see the error above)"
  node "$CODEX_GATE_HELPER" status --codex-home "$home" --gate "$gate" \
    || die "codex review gate: Codex does not report the hook as trusted, so the gate is NOT active"
}

# True when the Codex home's hooks.json holds our gate entry (exactly as install adds it).
codex_gate_registered() {
  local home
  home="$(codex_home_dir)"
  [ -n "$home" ] && [ -f "$home/hooks.json" ] || return 1
  node "$CODEX_GATE_HELPER" has --codex-home "$home" --gate "$CODEX_SKILLS_DIR/bughunt/gate.mjs" >/dev/null 2>&1
}

codex_review_gate_remove() {
  [ "$CODEX_MODE" -eq 1 ] || return 0
  local home args=()
  home="$(codex_home_dir)"
  [ -n "$home" ] && [ -f "$home/hooks.json" ] || return 0
  [ "$DRY_RUN" -eq 0 ] || args+=(--dry-run)
  node "$CODEX_GATE_HELPER" unmerge ${args[@]+"${args[@]}"} --codex-home "$home" --gate "$CODEX_SKILLS_DIR/bughunt/gate.mjs" \
    || warn "could not remove the review gate from $home/hooks.json; remove its PreToolUse entry for bughunt/gate.mjs by hand"
}

do_install() {
  local rel src dest stale on_path=0 linked=0 skipped=0 rc
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  [ "$CODEX_MODE" -eq 1 ] || [ -n "$LOCAL_BIN" ] || log "note: HOME is not set, so command-line tools (autobuild) are not linked; set PANDASTACK_BIN_DIR to link them"
  guard_layout
  check_duplicates
  check_skips
  if [ "$SHARED_CODEX_SKILLS" -eq 1 ]; then
    log "shared skills dir: $CODEX_SKILLS_DIR is $(physical "$CODEX_SKILLS_DIR"), the Claude skills dir, whose entries ./install.sh links; nothing is linked through it"
    codex_review_gate
    log "done: 0 linked (shared skills dir)"
    return 0
  fi
  run mkdir -p "$CLAUDE_DIR"
  while IFS=$'\t' read -r rel srcrel; do
    src="$REPO_DIR/$srcrel"; dest="$(dest_of "$rel")"
    if is_skipped "$rel"; then
      log "skip (--skip): $rel"; continue
    fi
    if [ ! -e "$src" ]; then
      log "skip (missing in repo): $rel"; continue
    fi
    case "$rel" in local-bin/*) on_path=1 ;; esac
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1)); continue
    fi
    if [ "$rel" = settings.json ] && [ -f "$dest" ] && [ ! -L "$dest" ]; then
      rc=0; merge_settings "$src" "$dest" || rc=$?
      [ "$rc" -eq 0 ] && continue
      log "settings.json is valid JSON but not an object: backing it up and linking ours"
    fi
    # A tool on PATH is named for itself, not its repo path: match a moved repo by the source path.
    stale="$rel"; case "$rel" in local-bin/*) stale="$srcrel" ;; esac
    if is_stale_harness_link "$dest" "$stale"; then
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
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) [ "$on_path" -eq 0 ] || warn "$LOCAL_BIN is not on your PATH: add it to run autobuild by name" ;;
  esac
  prune_dangling
  enable_git_hooks
  codex_review_gate
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
  if [ "$CODEX_MODE" -eq 1 ]; then guard_layout; fi
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  if [ "$SHARED_CODEX_SKILLS" -eq 1 ]; then
    log "shared skills dir: nothing is unlinked through $CODEX_SKILLS_DIR (the Claude uninstall owns its entries)"
    codex_review_gate_remove
    log "done: 0 unlinked (shared skills dir)"
    return 0
  fi
  while IFS=$'\t' read -r rel _; do
    dest="$(dest_of "$rel")"
    if points_into_repo "$dest"; then
      run rm "$dest"; log "unlinked: $rel"; removed=$((removed + 1))
    fi
  done < <(list_targets)
  prune_dangling
  if [ "$CODEX_MODE" -eq 0 ]; then unmerge_settings; fi
  codex_review_gate_remove

  backup="$(latest_backup_with_manifest)"
  if [ -z "$backup" ]; then
    log "no backup with a manifest under $BACKUP_ROOT; nothing to restore"
    log "done: $removed unlinked"
    return 0
  fi
  log "restoring from: $backup"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if [ "$CODEX_MODE" -eq 1 ]; then
      is_codex_plan_dest "$rel" || die "unsupported Codex backup target: $rel"
    fi
    if [ -z "$LOCAL_BIN" ] && [ "${rel#local-bin/}" != "$rel" ]; then
      warn "'$rel' kept in the backup: HOME is not set; set PANDASTACK_BIN_DIR and run --uninstall again to restore it"
      remaining+=("$rel"); continue
    fi
    dest="$(dest_of "$rel")"
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

# Plain ./install.sh (neither --claude nor --codex): after the Claude targets, the Codex entry
# skills too, when Codex is here (the `codex` command, or a ~/.agents directory). The Codex part is
# the unchanged --codex mode run as its own process, so every Codex safety check applies to it as
# it does to `./install.sh --codex`. It never fails the install: the Claude part has already
# succeeded, so a Codex problem is a warning that names the command to see why.
codex_present() {
  command -v codex >/dev/null 2>&1 || { [ -n "${HOME:-}" ] && [ -d "$HOME/.agents" ]; }
}

also_codex() {
  [ "$CODEX_MODE" -eq 0 ] && [ "$CLAUDE_ONLY" -eq 0 ] || return 0
  codex_present || return 0
  command -v node >/dev/null 2>&1 || { warn "Codex found, but node is missing: Codex entry skills not handled; install Node and run ./install.sh --codex"; return 0; }
  local plan fwd=() item line status=0
  plan="$(node "$REPO_DIR/core/skills/native-runtime/install-plan.mjs" --installation-root "$REPO_DIR" --backend codex)" \
    || { warn "Codex found, but its install plan failed: Codex entry skills not handled; run ./install.sh --codex to see why"; return 0; }
  # --skip names meant for the Claude targets (settings.json, local-bin/autobuild, ...) are not Codex's.
  for item in ${SKIP[@]+"${SKIP[@]}"}; do
    [ "$item" = skills ] && { fwd+=("--skip=skills"); continue; }
    while IFS=$'\t' read -r line _; do
      [ "$line" = "$item" ] && { fwd+=("--skip=$item"); break; }
    done <<< "$plan"
  done
  log ""
  log "== Codex found: the same as ./install.sh --codex =="
  local args=(--codex)
  [ "$DRY_RUN" -eq 0 ] || args+=(--dry-run)
  [ "$MODE" = install ] || args+=(--uninstall)
  bash "$REPO_DIR/install.sh" "${args[@]}" ${fwd[@]+"${fwd[@]}"} || status=$?
  [ "$status" -eq 0 ] || warn "the Codex step exited $status; the Claude part is done. Run ./install.sh --codex to see why"
  return 0
}
also_codex
