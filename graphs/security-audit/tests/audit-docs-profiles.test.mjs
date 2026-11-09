// audit-docs-profiles.test.mjs - what the docs say about the three profiles, beyond the P-08 acceptance test: the strings the README quotes are the code's
// own constants, the file it names as the profile table exists, the skill's init note and budget clause say what the code prints for each profile, and the
// README's topology and roles name quick's one critic and its merged verification.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { REPO, test } from '../../../scripts/workflow-harness.mjs'
import { QUICK_DEFERRED, QUICK_SUBSYSTEM_REF } from '../skills/security-audit/audit-profile.mjs'
import { minimumBudget } from '../skills/security-audit/audit-run.mjs'
import { SKILL_DIR, skillText } from './skill-commands.mjs'

console.log('== the docs and the three profiles')
const GRAPH = join(REPO, 'graphs', 'security-audit')
const README = readFileSync(join(GRAPH, 'README.md'), 'utf8')
const flat = text => text.replace(/\s+/g, ' ')
const SKILL = flat(skillText())
const sectionOf = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`)
  assert.ok(start >= 0, `the README has a "## ${heading}" section`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end < 0 ? text.length : end)
}

await test('the README\'s Profiles section quotes the code\'s quick subsystem reference and reason, and names a profile table that exists', () => {
  const profiles = flat(sectionOf(README, 'Profiles'))
  assert.ok(profiles.includes(`\`${QUICK_SUBSYSTEM_REF}\``), 'the fixed subsystem reference')
  assert.ok(profiles.includes(`\`${QUICK_DEFERRED}\``), 'the deferral reason')
  const table = profiles.match(/`skills\/security-audit\/([a-z-]+\.mjs)`/)
  assert.ok(table, 'the README names the profile table')
  assert.ok(existsSync(join(SKILL_DIR, table[1])), `${table[1]} exists`)
  assert.ok(/this graph's reading of upstream, not its text: deep's second pass/.test(profiles), 'the readings are disclosed as readings')
})
await test('the skill\'s init note says quick has one verifier per lead, and its budget clause says the smallest budget it names is standard\'s', () => {
  assert.ok(SKILL.includes('then one or two verifiers per surviving lead; one under `quick`'), 'section 3, the what-runs note')
  assert.ok(SKILL.includes(`the smallest \`init\` accepts, ${minimumBudget('standard')}, funds no hunter: that is \`standard\`'s smallest, and section 2 gives each profile's`), 'section 4, the budget clause')
  assert.notEqual(minimumBudget('quick'), minimumBudget('standard'), 'fixture: the clause matters only while quick\'s minimum differs')
})
await test('the README\'s topology and roles say what quick does instead: one critic, the Phase 5 checks in the validator, no verify stage', () => {
  const topology = sectionOf(README, 'Topology')
  for (const need of ['(quick: critic 1 is its one critic; what is left is deferred and the run goes to validation)', '(quick: the same verifier also makes the Phase 5 checks)', '(not in quick: write-findings goes to the report)'])
    assert.ok(topology.includes(need), `topology: ${need}`)
  const roles = sectionOf(README, 'Roles')
  assert.ok(roles.includes('the Phase 5 verifier of each final record (not in `quick`)'), 'the researcher row')
  assert.ok(roles.includes('the Phase 3 verifier of each candidate (in `quick`, also its final record check)'), 'the analyst row')
})
await test('negative: neither document still lists a profile as refused or unsupported', () => {
  for (const [name, text] of [['SKILL.md', SKILL], ['README', flat(README)]]) {
    assert.ok(!/refuses? (a )?profile|profile \S+ is not available|`--profile (quick|deep)`[^.]*not supported/i.test(text), `${name} says a profile is refused`)
    assert.ok(!/Not supported in this version:[^.]*profile/.test(text), `${name}: the not-supported list names a profile`)
  }
})
