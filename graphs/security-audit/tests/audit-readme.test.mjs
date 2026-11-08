// audit-readme.test.mjs - the graph README cannot drift from the code: it names the pin UPSTREAM.json holds, only files that exist, the three agents and the workflow,
// and the limitations a reader needs.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { minimumBudget } from '../skills/security-audit/audit-run.mjs'
import { skillText } from './skill-commands.mjs'

const README = readFileSync(join(REPO, 'graphs', 'security-audit', 'README.md'), 'utf8')

console.log('== the graph README')
await test('the README names the pin that UPSTREAM.json holds, a test-updated list of validation commands that exist, and the skill, agents and workflow by name', () => {
  const pin = JSON.parse(readFileSync(join(REPO, 'graphs', 'security-audit', 'vendor', 'cloudflare-security-audit', 'UPSTREAM.json'), 'utf8'))
  assert.ok(README.includes(pin.commit), 'the README names the pinned commit')
  for (const hex of README.match(/\b[0-9a-f]{40}\b/g) ?? []) assert.equal(hex, pin.commit, 'a commit the README names that is not the pin')
  assert.ok(README.includes(pin.commitDate.slice(0, 10)), 'and its date')
  for (const path of new Set(README.match(/graphs\/security-audit\/[A-Za-z0-9_./-]+\.mjs/g))) assert.ok(existsSync(join(REPO, path)), `${path} is named and does not exist`)
  for (const path of new Set(README.match(/`tests\/[A-Za-z0-9_.-]+\.mjs`/g)?.map(t => t.slice(1, -1)))) assert.ok(existsSync(join(REPO, 'graphs', 'security-audit', path)), `${path} is named and does not exist`)
  for (const s of ['scripts/test.sh', 'scripts/validate.sh', 'scripts/test-workflow.mjs']) assert.ok(existsSync(join(REPO, s)) && README.includes(s), s)
  for (const name of ['audit-researcher', 'audit-analyst', 'audit-synthesizer', 'security-audit-flow', 'blocks.mjs guidance', 'check-vendor.mjs', 'UPSTREAM.json', 'Completion-report template', 'Limitations']) assert.ok(README.includes(name), `the README mentions ${name}`)
  for (const agent of ['audit-researcher', 'audit-analyst', 'audit-synthesizer']) assert.ok(existsSync(join(REPO, 'graphs', 'security-audit', 'agents', `${agent}.md`)))
})
await test('the README states the limitations a reader needs: source only, no confirmed, reads not isolated, cost, model pins, and that a zero-confirmed report is not clean', () => {
  for (const need of ['source only', 'not a clean bill of health', 'Agents are not isolated from your files', '**Cost.**', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'other than `standard`'])
    assert.ok(README.includes(need), `the README says: ${need}`)
})

await test('what the docs say about the smallest budget is the code\'s number, and the top-level README lists the graph, its row and the state it keeps', () => {
  const min = minimumBudget('standard')
  assert.ok(README.replace(/\s+/g, ' ').includes(`(the smallest it accepts, ${min}, funds no hunter)`), 'the graph README names the minimum')
  assert.ok(skillText().replace(/\s+/g, ' ').includes(`the smallest \`init\` accepts, ${min}, funds no hunter`), 'the skill names the minimum')
  const top = readFileSync(join(REPO, 'README.md'), 'utf8')
  assert.ok(top.includes('](graphs/security-audit/README.md) | `/security-audit --full`'), 'the table row')
  assert.ok(top.includes('(blueprint, dev, qa, release, hunt, build, seo, security-audit)') && top.includes('`security-audit/run-<N>/` (an audit run)'), 'the pieces table lists the graph and its state')
})
