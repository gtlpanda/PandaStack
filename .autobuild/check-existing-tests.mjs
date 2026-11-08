#!/usr/bin/env node
// check-existing-tests.mjs - a gate step of the PR 9 build (autobuild.json "gate"): the security-audit tests that existed when the build started may only GROW. A loop session must not
// weaken a test about standard behavior to get a new profile through, so a file under graphs/security-audit/tests/ that exists at BASE (the branch point) fails the step when a line of it
// was deleted or changed, or the file was deleted, unless it is one of the four tests SPEC.md section 7 names (three assert what this build ends, one pins a script size) (SPEC.md section 7). A line added to any of them, a new file, and
// a change to the profile-* acceptance files (frozen anyway) are not looked at. Ends with EXISTING-TESTS: PASS|FAIL; exit 0|1.
import { spawnSync } from 'node:child_process'

const START = 'a503e8db0e72712712303cb9f0e8eb3f7dfa11ea'   // feat/security-audit-9-skill, where this branch started
const BASE_BRANCH = 'feat/security-audit-9-skill'
const DIR = 'graphs/security-audit/tests'
// File -> how many lines of it may be deleted or changed. The three that assert what this build ends are open; the script-size pin is one number on one line.
const EDITABLE = new Map([['audit-run-init.test.mjs', Infinity], ['audit-run-state.test.mjs', Infinity], ['audit-readme.test.mjs', Infinity], ['audit-stage.test.mjs', 1]].map(([f, n]) => [`${DIR}/${f}`, n]))

const git = args => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8' })
// Where this branch left its base branch: the merge base, which is START until the branch is rebased onto a base branch that has moved on, and then the new tip. The fallback is START.
const mergeBase = git(['merge-base', 'HEAD', BASE_BRANCH])
const BASE = mergeBase.status === 0 && /^[0-9a-f]{40}$/.test(mergeBase.stdout.trim()) ? mergeBase.stdout.trim() : START
const diff = git(['diff', '--numstat', '--no-renames', BASE, '--', DIR])
if (diff.status !== 0) {
  console.log(`existing-tests: git diff against ${BASE.slice(0, 8)} failed: ${(diff.stderr || diff.stdout).trim().split('\n')[0]}`)
  console.log('EXISTING-TESTS: FAIL')
  process.exit(1)
}
const changed = []
for (const row of diff.stdout.split('\n').filter(Boolean)) {
  const [added, removed, ...rest] = row.split('\t')
  const file = rest.join('\t')
  const binary = added === '-' || removed === '-'
  if (file.startsWith(`${DIR}/profile-`)) continue
  if (!binary && Number(removed) <= (EDITABLE.get(file) ?? 0)) continue
  if (binary || Number(removed) > 0) changed.push(`${file}: ${binary ? 'a binary file changed' : `${removed} line(s) deleted or changed (+${added})`}`)
}
for (const line of changed) console.log(`existing-tests: ${line}`)
if (changed.length) console.log('existing-tests: an existing test may only grow (SPEC.md section 7). If this change is required by the contract, log a decision or a BLOCKER; do not weaken a test.')
console.log(changed.length ? 'EXISTING-TESTS: FAIL' : 'EXISTING-TESTS: PASS')
process.exit(changed.length ? 1 : 0)
