// profile-docs.test.mjs - P-08: the entry skill, the graph README and the helper's own text say what the code now does: quick and deep are supported, each with its rules and its minimum
// budget (read from the code, not typed twice), and nothing still says init refuses them. Acceptance test of the PR 9 profile contract (retro.md, entry 43), section P-08.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { REPO, test } from '../../../scripts/workflow-harness.mjs'
import { INIT_FLAGS, minimumBudget } from '../skills/security-audit/audit-run.mjs'
import { SKILL_DIR, skillText, usageFlags } from './skill-commands.mjs'

console.log('== P-08: the docs')
const README = readFileSync(join(REPO, 'graphs', 'security-audit', 'README.md'), 'utf8')
const RUN_SOURCE = readFileSync(join(SKILL_DIR, 'audit-run.mjs'), 'utf8')
const SKILL = skillText()
const flat = text => text.replace(/\s+/g, ' ')
// The profile list item for `profile`: the list item that starts with the profile name in code, through its wrapped lines, up to the next item or a blank line.
function itemOf(text, profile) {
  const rows = text.split('\n')
  const start = rows.findIndex(l => new RegExp(`^\\s*- \`${profile}\``).test(l))
  if (start < 0) return ''
  let end = start + 1
  while (end < rows.length && rows[end].trim() !== '' && !/^\s*- /.test(rows[end])) end += 1
  return flat(rows.slice(start, end).join(' '))
}
const budgetSentence = profile => `\`init\` accepts a \`--budget\` of ${minimumBudget(profile)} or more`
const NEEDS = {
  quick: ['one hunter wave', 'one final critic', 'one verifier per lead', 'quick_profile_final_critic', 'A partial pass'],
  standard: ['(the default)', 'the whole method'],
  deep: ['subsystem and lifecycle mode', 'critics until a clean pass', 'two separate verification passes', 'independent second pass', 'an earlier run covered on unchanged source'],
}

await test('the skill\'s usage block names the three profiles, and its flags are still exactly the ones init takes', () => {
  assert.ok(SKILL.includes('[--profile quick|standard|deep]'), 'the usage block')
  assert.ok(!SKILL.includes('[--profile standard]'))
  assert.deepEqual(usageFlags(SKILL).filter(f => !['--unattended', '--guidance'].includes(f)).sort(), INIT_FLAGS.slice().sort())
})
for (const [name, text] of [['SKILL.md', SKILL], ['the graph README', README]]) {
  await test(`${name} lists each profile with its rules and the smallest budget init accepts for it (8, 10 and 10: the code's numbers)`, () => {
    for (const profile of ['quick', 'standard', 'deep']) {
      const item = itemOf(text, profile)
      assert.ok(item, `${name} has a list item for \`${profile}\``)
      for (const need of [...NEEDS[profile], budgetSentence(profile)]) assert.ok(item.includes(need), `${name}, ${profile}: "${need}"`)
    }
    assert.ok(flat(text).includes('Each profile keeps the same evidence bar'), `${name} says a profile never lowers the evidence bar`)
  })
}
await test('nothing says init refuses quick or deep any more: not the skill\'s "not supported" bullet, its rule about profiles, the README\'s status paragraph, or the helper\'s comments', () => {
  const skill = flat(SKILL), readme = flat(README)
  assert.ok(/Not supported in this version: `--changed`, `--model`, `--limits`, `--fresh`, `--resume`\./.test(skill), 'the bullet keeps the flags that really are unsupported')
  assert.ok(!/--profile quick`? and `?deep/.test(skill) && !/init refuses them/.test(skill) && !/they are a later change/.test(skill))
  assert.ok(!skill.includes('Do not set a profile, model or limit this version does not take') && /Do not set a model or limit this version does not take/.test(skill), 'the closing rule')
  assert.ok(!readme.includes('other than `standard`') && !/profiles `quick` and `deep` and the hardened sandbox are later changes/.test(readme), 'the README status paragraph')
  assert.ok(readme.includes('`--profile quick`') && readme.includes('`--profile deep`'), 'the README names both')
  assert.ok(readme.includes('the hardened sandbox is a later change'), 'the README still says what is later')
  assert.ok(!RUN_SOURCE.includes('wait for PR 9') && !RUN_SOURCE.includes('is not available yet') && !RUN_SOURCE.includes('[--profile standard]'), 'audit-run.mjs: its comments, its usage and its refusal')
  assert.ok(RUN_SOURCE.includes('[--profile quick|standard|deep]'), 'audit-run.mjs: its usage')
})
await test('the skill tells the session how to report a quick run: a partial pass, with what it deferred named', () => {
  assert.ok(flat(SKILL).includes('a `quick` run is a partial pass') && flat(SKILL).includes('name what it deferred'), 'section 6')
})
