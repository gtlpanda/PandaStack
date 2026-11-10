# Phase 1 exact Git path and discovery classification

Preserve the complete P1-13 placement policy and existing tracking fail-open API.
For Git commands returning one pathname, remove exactly the command's single
terminating LF byte. Do not trim/trimEnd, remove trailing CR, or split on newline:
POSIX paths may themselves end in space, tab, CR or LF. An actual path ending LF
therefore produces two LF bytes; only one is the Git output terminator. Revision
hash token parsing may remain separate. Protect the actual Git root, never a trimmed
existing sibling. Keep recorded repo/runnerRoot values canonical but byte-exact.

Apply correct parsing to project/runner worktree roots, metadata owners and default
tracking namespace discovery. Normal/linked worktrees with whitespace path bytes
must still reject stores inside their real root; supported external/default stores
must not be disabled merely because a trimmed sibling is absent. Valid separate
Git metadata owners must preserve their returned pathname bytes. Tests use space/
tab owner suffixes supported by ordinary gitfile pointers; CR/LF are covered on
actual worktree roots and linked worktree names, without assuming gitfile syntax
can represent every arbitrary metadata-owner suffix.

Non-Git fallback is allowed only for genuine repository absence. A failed Git query
plus any .git entry in canonical supplied-directory ancestry is not proof of absence:
valid-format pointer to missing metadata, malformed pointer file, invalid/empty
metadata directory, or broken static .git symlink must all execute unrecorded.
Check presence without following a broken symlink into nonexistence. Nested supplied
cwd must inspect ancestor metadata evidence; do not restrict the check to cwd.
Indeterminate ancestry/read/discovery errors fail open unrecorded before any store
mkdir or publication. Successful Git discovery remains authoritative for valid
separate Git dirs/linked worktrees; do not redefine bare-repository handling or
relax existing metadata namespace/no-follow rules.

Failed discovery under caller Git controls is not a grant to guess non-Git status.
Owned fixtures cover GIT_DIR pointing to absent metadata and GIT_CEILING_DIRECTORIES
hiding an ancestor repository. Conservatively disabling observation for indeterminate
controlled discovery is acceptable; never clear caller environment globally or
change launcher semantics. Genuine absent repositories with explicit external store
remain supported. No broad environment policy, Git config rewrite or new authority.

All rejected cases: no selected store/ancestor creation, exact work once, null
currentRunId inside work, original return or thrown object preserved, one existing
generic tracking-unavailable warning without paths/secret work errors. Accepted
cases retain run/event records, exact identities, clean worktree and restored context.
Do not weaken clean-tree checks, insert ignores, stage tracking data, or alter direct
createRunStore. Existing Phase1/P1-13 gates remain unchanged.

Tests are independent Node24 acceptance, portable ROOT using explicit host override
or installed acceptance ../../. Native Git runs only on disposable fixture paths;
no provider calls, filesystem races, credential/config exploration or live sessions.
Git raw-output assertions independently establish actual path bytes so a test-specific
trim convention cannot make wrong-root behavior pass. Ordinary static malformed
metadata cases preserve their input entries. Environment changes restore in finally.

Pre-freeze independent evidence at8a0a7c51e600716e2bf631e298c312cfbc91d2f5:36 cases,3 controls passed and33 expected behavioral failures. Syntax, raw Git path-byte fixture checks and independent review passed. This matrix reproduces final-review findings; no native-hunt disposition or final acceptance is implied.
