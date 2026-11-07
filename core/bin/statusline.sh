#!/usr/bin/env bash
# Claude Code status line: model, working directory (~-shortened), git branch,
# effort level, the worktree name when the directory is a linked git worktree, and context used.
input=$(cat)
model=$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // empty' 2>/dev/null)
effort=$(printf '%s' "$input" | jq -r '.effort.level // empty' 2>/dev/null)
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
# Context used, as Claude Code reports it; computed from the last request's tokens if absent.
ctx=$(printf '%s' "$input" | jq -r '.context_window as $c | if $c == null then empty
  elif $c.used_percentage != null then $c.used_percentage
  elif ($c.current_usage != null and ($c.context_window_size // 0) > 0) then
    (($c.current_usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) * 100 / $c.context_window_size | floor)
  else empty end' 2>/dev/null)
[ -z "$dir" ] && dir=$PWD
# ~ only for HOME itself or a path under it, never a sibling that shares the prefix (/home/bobby).
short=$dir
if [ -n "${HOME:-}" ] && [ "$HOME" != / ]; then
  case "$dir" in
    "$HOME") short='~' ;;
    "$HOME"/*) short="~${dir#"$HOME"}" ;;
  esac
fi

git_() { git -C "$dir" --no-optional-locks "$@" 2>/dev/null; }
branch=$(git_ symbolic-ref --short -q HEAD || git_ rev-parse --short HEAD)

# A linked worktree has its own git dir, separate from the shared common dir.
worktree=
gitdir=$(git_ rev-parse --absolute-git-dir)
common=$(git_ rev-parse --path-format=absolute --git-common-dir)
if [ -n "$gitdir" ] && [ -n "$common" ] && [ "$gitdir" != "$common" ]; then
  worktree=$(basename "$(git_ rev-parse --show-toplevel)")
fi

out=
if [ -n "$model" ] && [ -n "$effort" ]; then out="[$model · $effort] "
elif [ -n "$model" ]; then out="[$model] "; fi
out="$out$short"
[ -n "$branch" ] && out="$out ($branch)"
[ -n "$worktree" ] && out="$out wt:$worktree"
[ -n "$ctx" ] && out="$out ctx:${ctx}%"
printf '%s' "$out"
