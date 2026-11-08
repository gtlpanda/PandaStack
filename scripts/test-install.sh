#!/usr/bin/env bash
# test-install.sh — exercise install.sh against a throwaway HOME.
# Asserts: dry-run changes nothing; install links everything and backs up what
# was in the way; a second install is a no-op; uninstall restores the originals
# byte-for-byte and leaves no link into the repo.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pandastack-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset CLAUDE_CONFIG_DIR
export HARNESS_NO_GIT_CONFIG=1
CD="$HOME/.claude"

pass=0; fail=0
check() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1" >&2; fail=$((fail+1)); fi; }
snapshot() { (cd "$HOME" && find . -print | sort; find . -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' _ {} \; | sort); }

echo "== seed a pre-existing ~/.claude with things in the way"
mkdir -p "$CD/skills/legacy" "$CD/skills/verify" "$CD/skills/review" "$CD/agents"
echo '{"model":"old","hooks":{}}' > "$CD/settings.json"
echo '# old rules' > "$CD/CLAUDE.md"
echo 'name: legacy' > "$CD/skills/legacy/SKILL.md"
echo 'name: verify-old' > "$CD/skills/verify/SKILL.md"
echo 'name: review' > "$CD/skills/review/SKILL.md"   # another tool's skill named review (gstack ships one)
echo 'old reviewer' > "$CD/agents/reviewer.md"
ln -s /nonexistent "$CD/agents/checker.md"        # broken foreign symlink in the way
# shellcheck disable=SC2034  # read inside check's eval string
before="$(snapshot)"

echo "== 1. dry-run changes nothing"
"$REPO/install.sh" --dry-run >"$TMP/dry.log"
check "dry-run printed actions"        'grep -q "\[dry-run\] ln -s" "$TMP/dry.log"'
check "dry-run left tree untouched"    '[ "$(snapshot)" = "$before" ]'
check "dry-run created no backup dir"  '[ ! -d "$CD/backups" ]'

echo "== 2. install links everything, backs up conflicts"
"$REPO/install.sh" >"$TMP/install1.log"
# dest (under ~/.claude) = src (in the repo)
for pair in CLAUDE.md=CLAUDE.md loop.md=loop.md \
            skills/verify=core/skills/verify skills/harness-review=core/skills/harness-review \
            agents/checker.md=core/agents/checker.md agents/advisor.md=core/agents/advisor.md \
            agents/reviewer.md=graphs/qa/agents/reviewer.md agents/fixer.md=graphs/qa/agents/fixer.md \
            agents/qa-auditor.md=graphs/qa/agents/qa-auditor.md \
            workflows/harness-repair.js=graphs/qa/workflows/harness-repair.js; do
  rel="${pair%%=*}"; src="${pair#*=}"
  check "linked $rel -> $src" '[ -L "$CD/'"$rel"'" ] && [ "$(readlink "$CD/'"$rel"'")" = "$REPO/'"$src"'" ]'
done
check "untouched foreign skill kept"   '[ -f "$CD/skills/legacy/SKILL.md" ] && [ ! -L "$CD/skills/legacy" ]'
check "foreign skills/review untouched" '[ ! -L "$CD/skills/review" ] && [ "$(cat "$CD/skills/review/SKILL.md")" = "name: review" ]'
bk="$(ls -1d "$CD"/backups/*/ | head -1)"; bk="${bk%/}"
check "exactly one backup dir"         '[ "$(ls -1d "$CD"/backups/*/ | wc -l | tr -d " ")" = "1" ]'
check "manifest lists 4 moved items"   '[ "$(wc -l < "$bk/.harness-manifest" | tr -d " ")" = "4" ]'
check "own settings.json merged, not linked" '[ -f "$CD/settings.json" ] && [ ! -L "$CD/settings.json" ]'
check "merge kept their model"         '[ "$(jq -r .model "$CD/settings.json")" = "old" ]'
check "merge added the review gate"    'jq -e ".hooks.PreToolUse[0].hooks[0].command | test(\"bughunt/gate.mjs\")" "$CD/settings.json" >/dev/null'
check "settings before the merge kept" '[ "$(cat "$bk/settings.json.pre-merge")" = "{\"model\":\"old\",\"hooks\":{}}" ]'
check "merged copy kept for uninstall" 'cmp -s "$bk/settings.json.merged" "$CD/settings.json"'
check "old skills/verify in backup"    '[ "$(cat "$bk/skills/verify/SKILL.md")" = "name: verify-old" ]'
check "broken symlink moved to backup" '[ -L "$bk/agents/checker.md" ]'
# shellcheck disable=SC2034  # read inside check's eval string
after1="$(snapshot)"

echo "== 3. second install is a no-op"
"$REPO/install.sh" >"$TMP/install2.log"
check "no new backup dir"              '[ "$(ls -1d "$CD"/backups/*/ | wc -l | tr -d " ")" = "1" ]'
check "tree identical after re-run"    '[ "$(snapshot)" = "$after1" ]'
check "reports 0 linked"               'grep -q "done: 0 linked" "$TMP/install2.log"'

echo "== 4. uninstall restores original state"
"$REPO/install.sh" --uninstall >"$TMP/uninstall.log"
check "settings.json restored"         '[ ! -L "$CD/settings.json" ] && [ "$(cat "$CD/settings.json")" = "{\"model\":\"old\",\"hooks\":{}}" ]'
check "CLAUDE.md restored"             '[ "$(cat "$CD/CLAUDE.md")" = "# old rules" ]'
check "skills/verify restored"         '[ ! -L "$CD/skills/verify" ] && [ "$(cat "$CD/skills/verify/SKILL.md")" = "name: verify-old" ]'
check "agents/reviewer.md restored"    '[ "$(cat "$CD/agents/reviewer.md")" = "old reviewer" ]'
check "broken symlink restored as-is"  '[ -L "$CD/agents/checker.md" ] && [ "$(readlink "$CD/agents/checker.md")" = "/nonexistent" ]'
check "loop.md removed (was ours)"     '[ ! -e "$CD/loop.md" ] && [ ! -L "$CD/loop.md" ]'
check "skills/harness-review removed"  '[ ! -e "$CD/skills/harness-review" ] && [ ! -L "$CD/skills/harness-review" ]'
check "workflows link removed"         '[ ! -e "$CD/workflows/harness-repair.js" ] && [ ! -L "$CD/workflows/harness-repair.js" ]'
check "foreign skills/review survives" '[ "$(cat "$CD/skills/review/SKILL.md")" = "name: review" ]'
check "legacy skill still present"     '[ -f "$CD/skills/legacy/SKILL.md" ]'
check "no link into repo remains"      '! find "$CD" -type l -exec readlink {} \; | grep -q "^$REPO/"'
check "backup dir cleaned up"          '[ -z "$(ls -A "$CD/backups" 2>/dev/null)" ]'

echo "== 5. uninstall with nothing installed is safe"
"$REPO/install.sh" --uninstall >"$TMP/uninstall2.log"
check "second uninstall exits 0"       'true'
check "settings.json untouched"        '[ "$(cat "$CD/settings.json")" = "{\"model\":\"old\",\"hooks\":{}}" ]'

echo "== 6. regression: target that resolves into the repo is refused (audit C1/H4)"
RCOPY="$TMP/repocopy"; cp -R "$REPO" "$RCOPY"; rm -rf "$RCOPY/.git"
H2="$TMP/home2"; mkdir -p "$H2"; ln -s "$RCOPY" "$H2/.claude"
check "refuses ~/.claude -> repo"      '! HOME="$H2" "$RCOPY/install.sh" >/dev/null 2>&1'
check "repo skills untouched"          '[ -f "$RCOPY/core/skills/verify/SKILL.md" ] && [ ! -L "$RCOPY/core/skills/verify" ]'
H3="$TMP/home3"; mkdir -p "$H3/.claude" "$TMP/dotfiles/skills"; ln -s "$TMP/dotfiles/skills" "$H3/.claude/skills"
check "refuses symlinked skills dir"   '! HOME="$H3" "$REPO/install.sh" >/dev/null 2>&1'
check "nothing written through link"   '[ -z "$(ls -A "$TMP/dotfiles/skills")" ]'

echo "== 7. regression: same-second reinstall never overwrites a backup (audit H1)"
H4="$TMP/home4"; mkdir -p "$H4/.claude"; echo '"ORIGINAL"' > "$H4/.claude/settings.json"   # valid JSON, not an object: backed up and linked
HOME="$H4" "$REPO/install.sh" >/dev/null
rm "$H4/.claude/settings.json"; echo '"SECOND"' > "$H4/.claude/settings.json"
HOME="$H4" "$REPO/install.sh" >/dev/null
check "two backup dirs exist"          '[ "$(ls -1d "$H4"/.claude/backups/*/ | wc -l | tr -d " ")" = "2" ]'
check "ORIGINAL still in a backup"     'grep -rqs ORIGINAL "$H4/.claude/backups"'
check "SECOND still in a backup"       'grep -rqs SECOND "$H4/.claude/backups"'

echo "== 8. regression: spaces in the config path (audit H2)"
export CLAUDE_CONFIG_DIR="$TMP/My Claude Dir"; mkdir -p "$CLAUDE_CONFIG_DIR"; echo '{"keep":1}' > "$CLAUDE_CONFIG_DIR/settings.json"
"$REPO/install.sh" >/dev/null && "$REPO/install.sh" --uninstall >/dev/null
check "settings.json restored w/ spaces" '[ "$(cat "$CLAUDE_CONFIG_DIR/settings.json")" = "{\"keep\":1}" ]'
unset CLAUDE_CONFIG_DIR

echo "== 9. regression: stale harness link from a moved repo is replaced, not backed up (audit H3)"
H5="$TMP/home5"; mkdir -p "$H5/.claude/agents"
ln -s "/old/checkout/settings.json" "$H5/.claude/settings.json"
ln -s "/old/checkout/agents/fixer.md" "$H5/.claude/agents/fixer.md"
ln -s "/somewhere/else/thing.md" "$H5/.claude/agents/checker.md"   # foreign dangling link: real user data
HOME="$H5" "$REPO/install.sh" >"$TMP/install5.log"
check "stale link replaced"            '[ "$(readlink "$H5/.claude/settings.json")" = "$REPO/settings.json" ]'
check "stale links not in a backup"    '! grep -rqs "settings.json\|fixer.md" "$H5"/.claude/backups/*/.harness-manifest 2>/dev/null'
check "foreign dangling link backed up" 'grep -qs "agents/checker.md" "$H5"/.claude/backups/*/.harness-manifest'

echo "== 10. regression: partial restore keeps the manifest for the leftovers (audit M1)"
H6="$TMP/home6"; mkdir -p "$H6/.claude"; echo A > "$H6/.claude/CLAUDE.md"; echo '"B"' > "$H6/.claude/settings.json"
HOME="$H6" "$REPO/install.sh" >/dev/null
rm "$H6/.claude/CLAUDE.md"; echo NEW > "$H6/.claude/CLAUDE.md"      # user put a real file where our link was
HOME="$H6" "$REPO/install.sh" --uninstall >/dev/null 2>&1
# shellcheck disable=SC2034  # read inside check's eval string
bk6="$(ls -1d "$H6"/.claude/backups/*/ | head -1)"
check "settings.json restored"         '[ "$(cat "$H6/.claude/settings.json")" = "\"B\"" ]'
check "conflicting file left alone"    '[ "$(cat "$H6/.claude/CLAUDE.md")" = "NEW" ]'
check "manifest kept with leftover"    '[ "$(cat "$bk6.harness-manifest")" = "CLAUDE.md" ]'
rm "$H6/.claude/CLAUDE.md"; HOME="$H6" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "second uninstall restores it"   '[ "$(cat "$H6/.claude/CLAUDE.md")" = "A" ]'
check "backup dir now gone"            '[ ! -d "$bk6" ]'

echo "== 11. regression: dry-run uninstall reports what a real one would do (audit M2)"
H7="$TMP/home7"; mkdir -p "$H7/.claude"; echo X > "$H7/.claude/loop.md"
HOME="$H7" "$REPO/install.sh" >/dev/null
HOME="$H7" "$REPO/install.sh" --uninstall --dry-run >"$TMP/dry7.log" 2>&1
check "dry-run says it would restore"  'grep -q "\[dry-run\] mv .*loop.md" "$TMP/dry7.log"'
check "dry-run did not restore"        '[ -L "$H7/.claude/loop.md" ]'

echo "== 12. --skip leaves named targets alone and links the rest"
H8="$TMP/home8"; mkdir -p "$H8/.claude"; echo MINE > "$H8/.claude/settings.json"; echo RULES > "$H8/.claude/CLAUDE.md"
HOME="$H8" "$REPO/install.sh" --skip=settings.json,CLAUDE.md >"$TMP/install8.log"
check "skipped settings.json untouched" '[ ! -L "$H8/.claude/settings.json" ] && [ "$(cat "$H8/.claude/settings.json")" = "MINE" ]'
check "skipped CLAUDE.md untouched"    '[ ! -L "$H8/.claude/CLAUDE.md" ] && [ "$(cat "$H8/.claude/CLAUDE.md")" = "RULES" ]'
check "skips logged"                   '[ "$(grep -c "skip (--skip)" "$TMP/install8.log")" = "2" ]'
check "no backup made for skipped"     '[ ! -d "$H8/.claude/backups" ]'
check "rest linked (loop.md, workflow)" '[ -L "$H8/.claude/loop.md" ] && [ -L "$H8/.claude/workflows/harness-repair.js" ]'
H9="$TMP/home9"; mkdir -p "$H9/.claude"
HOME="$H9" "$REPO/install.sh" --skip=agents >/dev/null
check "--skip=<dir> skips every entry" '[ ! -e "$H9/.claude/agents" ] && [ -L "$H9/.claude/skills/verify" ]'
check "unknown --skip name refused"    '! HOME="$H9" "$REPO/install.sh" --skip=CLAUDE.mdd >/dev/null 2>&1'
check "--skip with --uninstall refused" '! HOME="$H9" "$REPO/install.sh" --uninstall --skip=CLAUDE.md >/dev/null 2>&1'
check "empty --skip= refused"          '! HOME="$H9" "$REPO/install.sh" --skip= >/dev/null 2>&1'
check "empty --skip= w/ uninstall refused" '! HOME="$H9" "$REPO/install.sh" --uninstall --skip= >/dev/null 2>&1'
check "refusals changed nothing"       '[ -L "$H9/.claude/CLAUDE.md" ] && [ ! -e "$H9/.claude/agents" ]'
H10="$TMP/home10"; mkdir -p "$H10/.claude"; echo MINE > "$H10/.claude/settings.json"
HOME="$H10" "$REPO/install.sh" --skip= >/dev/null 2>&1 || true
check "empty --skip= left settings alone" '[ ! -L "$H10/.claude/settings.json" ] && [ "$(cat "$H10/.claude/settings.json")" = "MINE" ] && [ ! -e "$H10/.claude/loop.md" ]'
HOME="$H10" "$REPO/install.sh" --skip=settings.json --dry-run >"$TMP/dry10.log"
check "--skip + --dry-run changes nothing" '[ "$(cat "$H10/.claude/settings.json")" = "MINE" ] && [ ! -e "$H10/.claude/loop.md" ] && grep -q "skip (--skip): settings.json" "$TMP/dry10.log"'

echo "== 13. every graph is installed; a name shipped by two sources is refused"
GCOPY="$TMP/graphcopy"; cp -R "$REPO" "$GCOPY"; rm -rf "$GCOPY/.git"
GCOPY="$(cd "$GCOPY" && pwd -P)"   # install.sh records physical paths (/var -> /private/var on macOS)
mkdir -p "$GCOPY/graphs/fake/agents"; printf -- '---\nname: extra\n---\n' > "$GCOPY/graphs/fake/agents/extra.md"
H11="$TMP/home11"; mkdir -p "$H11/.claude"
HOME="$H11" "$GCOPY/install.sh" >/dev/null
check "second graph's agent linked"    '[ "$(readlink "$H11/.claude/agents/extra.md")" = "$GCOPY/graphs/fake/agents/extra.md" ]'
check "first graph still linked"       '[ "$(readlink "$H11/.claude/agents/reviewer.md")" = "$GCOPY/graphs/qa/agents/reviewer.md" ]'
check "core agent linked"              '[ "$(readlink "$H11/.claude/agents/checker.md")" = "$GCOPY/core/agents/checker.md" ]'
cp "$GCOPY/core/agents/checker.md" "$GCOPY/graphs/fake/agents/checker.md"   # a graph shadowing a core agent
H12="$TMP/home12"; mkdir -p "$H12/.claude"; echo MINE > "$H12/.claude/settings.json"
check "duplicate name refused"         '! HOME="$H12" "$GCOPY/install.sh" >"$TMP/install12.log" 2>&1'
check "refusal names both sources"     'grep -q "agents/checker.md is provided by more than one source: core/agents/checker.md graphs/fake/agents/checker.md" "$TMP/install12.log"'
check "refusal wrote nothing"          '[ "$(cat "$H12/.claude/settings.json")" = "MINE" ] && [ ! -e "$H12/.claude/agents" ] && [ ! -d "$H12/.claude/backups" ]'

echo "== 14. an own settings.json is merged: their hooks and permissions kept, idempotent, undone exactly"
H14="$TMP/home14"; mkdir -p "$H14/.claude"
cat > "$H14/.claude/settings.json" <<'JSON'
{"model": "mine", "permissions": {"allow": ["Bash(ls)"]}, "statusLine": {"type": "command", "command": "x"},
 "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-stop"}]}], "PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "their-edit"}]}]}}
JSON
cp "$H14/.claude/settings.json" "$TMP/settings14.orig"
HOME="$H14" "$REPO/install.sh" --dry-run >"$TMP/dry14.log"
check "dry-run lists what the merge adds" 'grep -q "  + hooks.PreToolUse: node" "$TMP/dry14.log" && cmp -s "$H14/.claude/settings.json" "$TMP/settings14.orig"'
HOME="$H14" "$REPO/install.sh" >"$TMP/install14.log"
S14="$H14/.claude/settings.json"
check "their model kept"               '[ "$(jq -r .model "$S14")" = "mine" ]'
check "their permissions untouched"    '[ "$(jq -c .permissions "$S14")" = "{\"allow\":[\"Bash(ls)\"]}" ]'
check "their hooks kept"               '[ "$(jq -r ".hooks.Stop[0].hooks[0].command" "$S14")" = "their-stop" ] && [ "$(jq -r ".hooks.PreToolUse[0].hooks[0].command" "$S14")" = "their-edit" ]'
check "our gate added after theirs"    'jq -e ".hooks.PreToolUse[1].matcher == \"Bash\" and (.hooks.PreToolUse[1].hooks[0].command | test(\"gate.mjs\"))" "$S14" >/dev/null'
check "missing keys filled"            '[ "$(jq -r .advisorModel "$S14")" = "fable" ]'
cp "$S14" "$TMP/settings14.merged"
HOME="$H14" "$REPO/install.sh" >"$TMP/install14b.log"
check "second install changes nothing" 'cmp -s "$S14" "$TMP/settings14.merged" && grep -q "already has everything" "$TMP/install14b.log"'
check "gate added once"                '[ "$(grep -c "gate.mjs" "$S14")" = "1" ]'
HOME="$H14" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "uninstall restores the original byte for byte" 'cmp -s "$S14" "$TMP/settings14.orig"'
HOME="$H14" "$REPO/install.sh" >/dev/null
jq '.model = "edited"' "$S14" > "$S14.t" && mv "$S14.t" "$S14"
HOME="$H14" "$REPO/install.sh" --uninstall >"$TMP/uninstall14.log" 2>&1
check "edited after the merge: edit kept" '[ "$(jq -r .model "$S14")" = "edited" ]'
check "edited after the merge: our hook removed, theirs kept" '! grep -q "gate.mjs" "$S14" && [ "$(jq -r ".hooks.PreToolUse[0].hooks[0].command" "$S14")" = "their-edit" ]'
check "edited after the merge: says so" 'grep -q "kept your edits" "$TMP/uninstall14.log"'
H14b="$TMP/home14b"; mkdir -p "$H14b/.claude"; echo '[1, 2]' > "$H14b/.claude/settings.json"
HOME="$H14b" "$REPO/install.sh" >"$TMP/install14c.log" 2>&1
check "a non-object settings.json is backed up and linked" '[ "$(readlink "$H14b/.claude/settings.json")" = "$REPO/settings.json" ] && grep -q "not an object" "$TMP/install14c.log"'

echo "== 15. the merge fails safe, keys hooks on the matcher, honors --skip, and undoes a partial chain"
H15="$TMP/home15"; mkdir -p "$H15/.claude"; S15="$H15/.claude/settings.json"
printf '{"model": "mine",\n' > "$S15"; cp "$S15" "$TMP/s15.orig"
check "broken JSON: install refuses"   '! HOME="$H15" "$REPO/install.sh" >"$TMP/install15.log" 2>&1'
check "broken JSON: file untouched, says why" 'cmp -s "$S15" "$TMP/s15.orig" && [ ! -L "$S15" ] && grep -q "left as it is" "$TMP/install15.log"'
printf '\xef\xbb\xbf{"model": "bom"}\n' > "$S15"; chmod 640 "$S15"
HOME="$H15" "$REPO/install.sh" >/dev/null 2>&1
check "a byte-order mark is accepted"  '[ "$(jq -r .model "$S15")" = "bom" ] && grep -q "gate.mjs" "$S15"'
check "file mode kept"                 '[ "$(stat -c %a "$S15" 2>/dev/null || stat -f %Lp "$S15")" = "640" ]'
H15b="$TMP/home15b"; mkdir -p "$H15b/.claude"
jq -n --arg c "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$REPO/settings.json")" '{hooks: {PreToolUse: [{matcher: "Edit", hooks: [{type: "command", command: $c}]}]}}' > "$H15b/.claude/settings.json"
HOME="$H15b" "$REPO/install.sh" >/dev/null 2>&1
check "same command, other matcher: ours still added" '[ "$(jq "[.hooks.PreToolUse[] | select(.matcher == \"Bash\")] | length" "$H15b/.claude/settings.json")" = "1" ]'
HOME="$H15b" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "uninstall keeps their same-command hook" '[ "$(jq -r ".hooks.PreToolUse[0].matcher" "$H15b/.claude/settings.json")" = "Edit" ]'
H15c="$TMP/home15c"; mkdir -p "$H15c/.claude"; echo '{"model": "m"}' > "$H15c/.claude/settings.json"
HOME="$H15c" "$REPO/install.sh" --skip=skills/bughunt >"$TMP/install15c.log" 2>&1
check "--skip=skills/bughunt: no gate hook" '! grep -q "gate.mjs" "$H15c/.claude/settings.json" && grep -q "review gate hook is not merged" "$TMP/install15c.log"'
# A chain: merge 1, an edit, merge 2 (ours changed), then uninstall: the edit stays, our hooks go.
GC="$TMP/gcopy15"; cp -R "$REPO" "$GC"; rm -rf "$GC/.git"
H15d="$TMP/home15d"; mkdir -p "$H15d/.claude"; echo '{"model": "m"}' > "$H15d/.claude/settings.json"
HOME="$H15d" "$GC/install.sh" >/dev/null 2>&1
jq '.model = "edited"' "$H15d/.claude/settings.json" > "$TMP/t15" && cat "$TMP/t15" > "$H15d/.claude/settings.json"
jq '.newKey = 1' "$GC/settings.json" > "$TMP/t15" && cat "$TMP/t15" > "$GC/settings.json"
HOME="$H15d" "$GC/install.sh" >/dev/null 2>&1
HOME="$H15d" "$GC/install.sh" --uninstall >"$TMP/uninstall15d.log" 2>&1
check "partial chain: the edit survives" '[ "$(jq -r .model "$H15d/.claude/settings.json")" = "edited" ]'
check "partial chain: our hooks are gone" '! grep -q "gate.mjs" "$H15d/.claude/settings.json"'

echo "== 16. kit/, commands/, and bin/ are linked; copies in the way are backed up; others' entries kept"
H16="$TMP/home16"; mkdir -p "$H16/.claude/bin" "$H16/.claude/skills/commit" "$H16/.claude/skills/deep-qa" "$H16/.claude/commands"
echo OLD-STATUS > "$H16/.claude/bin/statusline.sh"                # a copy from an older setup
echo 'name: commit-copy' > "$H16/.claude/skills/commit/SKILL.md"   # a copied kit skill
echo OLD-CMD > "$H16/.claude/commands/founding-sales.md"           # a copied kit command
echo 'name: deep-qa' > "$H16/.claude/skills/deep-qa/SKILL.md"      # a retired skill: not ours to remove
echo MINE > "$H16/.claude/commands/mine.md"                        # someone's own command
echo '{"statusLine":{"type":"command","command":"my-line"}}' > "$H16/.claude/settings.json"
HOME="$H16" "$REPO/install.sh" >"$TMP/install16.log" 2>&1
for pair in skills/commit=kit/skills/commit skills/render=kit/skills/render agents/qa-engineer.md=kit/agents/qa-engineer.md \
            commands/founding-sales.md=kit/commands/founding-sales.md bin/statusline.sh=core/bin/statusline.sh; do
  rel="${pair%%=*}"; src="${pair#*=}"
  check "linked $rel -> $src" '[ "$(readlink "$H16/.claude/'"$rel"'")" = "$REPO/'"$src"'" ]'
done
bk16="$(ls -1d "$H16"/.claude/backups/*/ | head -1)"; bk16="${bk16%/}"
check "copied status line backed up"   '[ "$(cat "$bk16/bin/statusline.sh")" = "OLD-STATUS" ]'
check "copied kit skill backed up"     '[ "$(cat "$bk16/skills/commit/SKILL.md")" = "name: commit-copy" ]'
check "copied command backed up"       '[ "$(cat "$bk16/commands/founding-sales.md")" = "OLD-CMD" ]'
check "retired skill left alone"       '[ ! -L "$H16/.claude/skills/deep-qa" ] && [ -f "$H16/.claude/skills/deep-qa/SKILL.md" ]'
check "own command left alone"         '[ "$(cat "$H16/.claude/commands/mine.md")" = "MINE" ]'
check "their status line wins"         '[ "$(jq -r .statusLine.command "$H16/.claude/settings.json")" = "my-line" ]'
H16b="$TMP/home16b"; mkdir -p "$H16b/.claude"; echo '{}' > "$H16b/.claude/settings.json"
HOME="$H16b" "$REPO/install.sh" >/dev/null 2>&1
check "no status line: ours filled in" 'jq -r .statusLine.command "$H16b/.claude/settings.json" | grep -q "/bin/statusline.sh"'
H16c="$TMP/home16c"; mkdir -p "$H16c/.claude"
HOME="$H16c" "$REPO/install.sh" --skip=bin >"$TMP/install16c.log" 2>&1
check "--skip=bin + linked settings warns" '[ -L "$H16c/.claude/settings.json" ] && grep -q "status line stays blank" "$TMP/install16c.log"'
H16d="$TMP/home16d"; mkdir -p "$H16d/.claude" "$TMP/mycmds"; echo MINE > "$TMP/mycmds/mine.md"; ln -s "$TMP/mycmds" "$H16d/.claude/commands"
check "symlinked commands/ refused, naming --skip" '! HOME="$H16d" "$REPO/install.sh" >"$TMP/install16d.log" 2>&1 && grep -q "pass --skip=commands" "$TMP/install16d.log" && [ ! -e "$H16d/.claude/skills" ]'
HOME="$H16d" "$REPO/install.sh" --skip=commands >/dev/null 2>&1
check "--skip=commands installs the rest, writes nothing into it" '[ -L "$H16d/.claude/skills/verify" ] && [ "$(ls "$TMP/mycmds")" = "mine.md" ]'
HOME="$H16" "$REPO/install.sh" --uninstall >"$TMP/uninstall16.log" 2>&1
check "uninstall restores the copies"  '[ "$(cat "$H16/.claude/bin/statusline.sh")" = "OLD-STATUS" ] && [ "$(cat "$H16/.claude/commands/founding-sales.md")" = "OLD-CMD" ] && [ ! -L "$H16/.claude/skills/commit" ]'
check "uninstall leaves no repo link"  '! find "$H16/.claude" -type l -lname "$REPO/*" | grep -q .'

echo "== 17. autobuild goes on PATH: one link in ~/.local/bin; one in the way is backed up and restored"
H17="$TMP/home17"; mkdir -p "$H17/.claude" "$H17/.local/bin" "$H17/old/bin"
printf '#!/bin/sh\necho OLD-AUTOBUILD\n' > "$H17/old/bin/autobuild"; chmod +x "$H17/old/bin/autobuild"
ln -s "$H17/old/bin/autobuild" "$H17/.local/bin/autobuild"     # the tool's old home, linked by hand
HOME="$H17" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" "$REPO/install.sh" >"$TMP/install17.log" 2>&1
check "autobuild linked into ~/.local/bin" '[ "$(readlink "$H17/.local/bin/autobuild")" = "$REPO/graphs/autobuild/tool/bin/autobuild" ]'
check "the linked autobuild runs"          '"$H17/.local/bin/autobuild" help 2>&1 | grep -q "Exit codes of .run."'
check "the autobuild skill is linked"      '[ "$(readlink "$H17/.claude/skills/autobuild")" = "$REPO/graphs/autobuild/skills/autobuild" ]'
bk17="$(ls -1d "$H17"/.claude/backups/*/ | head -1)"; bk17="${bk17%/}"
check "old link backed up as local-bin/autobuild" '[ "$(readlink "$bk17/local-bin/autobuild")" = "$H17/old/bin/autobuild" ] && grep -qx "local-bin/autobuild" "$bk17/.harness-manifest"'
check "warns when ~/.local/bin is not on PATH" 'grep -q "$H17/.local/bin is not on your PATH" "$TMP/install17.log"'
HOME="$H17" "$REPO/install.sh" >"$TMP/install17b.log" 2>&1
check "second install leaves it alone"    '! grep -q "local-bin/autobuild" "$TMP/install17b.log"'
HOME="$H17" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "uninstall restores the old link"   '[ "$(readlink "$H17/.local/bin/autobuild")" = "$H17/old/bin/autobuild" ]'
H17b="$TMP/home17b"; mkdir -p "$H17b/.claude"
HOME="$H17b" "$REPO/install.sh" --skip=local-bin/autobuild >/dev/null 2>&1
check "--skip=local-bin/autobuild leaves PATH alone" '[ ! -e "$H17b/.local/bin/autobuild" ] && [ -L "$H17b/.claude/skills/autobuild" ]'
H17c="$TMP/home17c"; mkdir -p "$H17c/.claude"
HOME="$H17c" PANDASTACK_BIN_DIR="$H17c/tools" "$REPO/install.sh" >/dev/null 2>&1
check "PANDASTACK_BIN_DIR picks the dir"  '[ -L "$H17c/tools/autobuild" ] && [ ! -e "$H17c/.local/bin/autobuild" ]'

echo "== 18. security-audit: the skill, the workflow and the three agents link; nothing under vendor/ does"
H18="$TMP/home18"; mkdir -p "$H18/.claude"
HOME="$H18" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" "$REPO/install.sh" >"$TMP/install18.log" 2>&1
SA="graphs/security-audit"
for pair in skills/security-audit=$SA/skills/security-audit workflows/security-audit-flow.js=$SA/workflows/security-audit-flow.js \
            agents/audit-researcher.md=$SA/agents/audit-researcher.md agents/audit-analyst.md=$SA/agents/audit-analyst.md \
            agents/audit-synthesizer.md=$SA/agents/audit-synthesizer.md; do
  rel="${pair%%=*}"; src="${pair#*=}"
  check "linked $rel -> $src" '[ -L "$H18/.claude/'"$rel"'" ] && [ "$(readlink "$H18/.claude/'"$rel"'")" = "$REPO/'"$src"'" ]'
done
check "the linked skill is PandaStack's, not upstream's" 'grep -q "^name: security-audit$" "$H18/.claude/skills/security-audit/SKILL.md" && grep -q "explicit-request audit" "$H18/.claude/skills/security-audit/SKILL.md" && [ "$(readlink -f "$H18/.claude/skills/security-audit/SKILL.md")" = "$REPO/$SA/skills/security-audit/SKILL.md" ]'
check "no link points into vendor/"          '! find "$H18/.claude" -type l -lname "$REPO/$SA/vendor*" | grep -q .'
check "nothing of upstream is reachable through a link" '[ -z "$(find -L "$H18/.claude" \( -name UPSTREAM.json -o -name "validate-*.cjs" -o -path "*cloudflare-security-audit*" \) 2>/dev/null)" ]'
check "the three agents and only they are linked from the graph" '[ "$(find "$H18/.claude/agents" -type l -lname "$REPO/$SA/agents/*" | wc -l | tr -d " ")" = "3" ]'
check "the installed helper runs through the link (next on a path that is no run: exit 1 and NEXT: FAIL)" 'out18="$(node "$H18/.claude/skills/security-audit/audit-run.mjs" next "$TMP/not-a-run" 2>&1)"; rc18=$?; [ "$rc18" = 1 ] && [ "${out18#NEXT: FAIL }" != "$out18" ]'
check "the installed guidance helper runs through the link and writes nothing" 'n18="$(find "$H18" | wc -l)"; node "$H18/.claude/skills/security-audit/blocks.mjs" guidance "cors wildcard origin" | grep -q "^Guidance mode: this writes no files" && [ "$(find "$H18" | wc -l)" = "$n18" ]'
HOME="$H18" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "uninstall leaves no security-audit link" '! find "$H18/.claude" -type l -lname "$REPO/*" | grep -q .'

echo
echo "TEST-INSTALL: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
