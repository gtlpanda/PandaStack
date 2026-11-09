// profile-init.test.mjs - P-02: `audit-run.mjs init --profile quick|deep` starts a run, behind the same gates as standard, each with its own budget minimum. Acceptance
// test of the PR 9 profile contract (retro.md, entry 43), section P-02.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { AUDIT_RUN, ENV, audit, init, meta, mkRepo, runsOf } from './audit-fixtures.mjs'
import { PROFILES, asProfile, lazy } from './profile-support.mjs'

console.log('== P-02: init takes the quick and deep profiles')
const minimum = { quick: 8, standard: 10, deep: 10 }
const refusal = { quick: '(4 reconnaissance, 1 synthesis, 1 critic, 1 minter, 1 verifier)', standard: '(4 reconnaissance, 1 synthesis, 2 critics, 2 minters, 1 verifier)', deep: '(4 reconnaissance, 1 synthesis, 2 critics, 2 minters, 1 verifier)' }

await test('SUPPORTED_PROFILES is all three profiles, in upstream\'s order, and is what KNOWN_PROFILES is', async () => {
  const run = await lazy('audit-run.mjs')
  assert.deepEqual(run.SUPPORTED_PROFILES, ['quick', 'standard', 'deep'])
  assert.deepEqual(run.SUPPORTED_PROFILES, run.KNOWN_PROFILES)
})
for (const profile of ['quick', 'deep']) {
  await test(`init --profile ${profile} starts a run: it prints AUDIT: OK with the profile, records it, and the run passes check, status and next`, () => {
    const repo = mkRepo()
    const r = init([repo, '--full', '--profile', profile])
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.last, new RegExp(`^AUDIT: OK run=run-1 profile=${profile} commit=[0-9a-f]{12} files=\\d+ earlier_runs=0 compatible=0$`))
    assert.doesNotMatch(r.stdout, /not available yet/)
    const m = meta(r.runDir)
    assert.deepEqual([m.profile, m.run_status, m.incomplete_reason, m.budget, m.agents_spent], [profile, 'in_progress', null, null, 0])
    assert.equal(audit(['check', r.runDir]).last, `AUDIT: OK ${r.runDir} passes check`)
    assert.equal(audit(['next', r.runDir]).last, 'NEXT: recon run=workflow')
    assert.match(audit(['status', r.runDir]).lines[0], new RegExp(`: profile ${profile}, in_progress$`))
  })
}
await test('the profile is never run as another: with no --profile the run is standard, and none of the three prints a refusal about availability', () => {
  const repo = mkRepo()
  const r = init([repo, '--full'])
  assert.equal(meta(r.runDir).profile, 'standard')
  assert.match(r.last, /^AUDIT: OK run=run-1 profile=standard /)
})
await test('a profile that is not exactly one of the three is a usage error (exit 2, nothing created), as it was', () => {
  const repo = mkRepo()
  for (const bad of ['fast', 'Quick', 'DEEP', 'standard,deep', 'quick ']) {
    const r = init([repo, '--full', '--profile', bad])
    assert.equal(r.status, 2, `--profile ${JSON.stringify(bad)}`)
  }
  assert.deepEqual(runsOf(repo), [], 'no run directory was made')
})
await test('the usage text names the three profiles', () => {
  const r = spawnSync(process.execPath, [AUDIT_RUN], { encoding: 'utf8', env: { ...process.env, ...ENV } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /\[--profile quick\|standard\|deep\]/)
  assert.doesNotMatch(r.stderr, /\[--profile standard\]/)
})
for (const profile of PROFILES) {
  await test(`the budget gate for ${profile}: ${minimum[profile]} agent invocations is the least init accepts, one fewer is refused with upstream's reason, naming the calls the profile needs first, and records the run incomplete`, () => {
    const repo = mkRepo()
    const low = init([repo, '--full', '--profile', profile, '--budget', String(minimum[profile] - 1)])
    assert.equal(low.status, 1, `${low.stdout}${low.stderr}`)
    assert.match(low.last, new RegExp(`^AUDIT: FAIL budget_cannot_fund_reconnaissance_and_reserves: --budget ${minimum[profile] - 1} cannot fund the ${minimum[profile]} calls profile ${profile} needs first ${refusal[profile].replace(/[()]/g, '\\$&')}; no agent was launched`))
    const refused = join(repo, '.git', 'security-audit', 'run-1')
    assert.deepEqual([meta(refused).profile, meta(refused).run_status, meta(refused).incomplete_reason], [profile, 'incomplete', 'budget_cannot_fund_reconnaissance_and_reserves'])
    const ok = init([repo, '--full', '--profile', profile, '--budget', String(minimum[profile])])
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`)
    assert.equal(meta(ok.runDir).budget, minimum[profile])
    assert.equal(audit(['check', ok.runDir]).last, `AUDIT: OK ${ok.runDir} passes check`)
  })
}
await test('the note init prints about what runs is honest for the profile: quick says one verifier per surviving lead (it does both passes), standard and deep keep one or two', () => {
  const repo = mkRepo()
  const noteOf = profile => init([repo, '--full', '--profile', profile]).stdout.split('\n').find(l => l.startsWith('note: what runs:')) ?? ''
  assert.match(noteOf('quick'), /then one verifier per surviving lead/)
  assert.doesNotMatch(noteOf('quick'), /one or two verifiers/)
  for (const profile of ['standard', 'deep']) assert.match(noteOf(profile), /then one or two verifiers per surviving lead/, profile)
})
await test('check flags a run whose metadata names a profile that is not one of the three, and says which are', () => {
  const repo = mkRepo()
  const r = init([repo, '--full'])
  asProfile(r.runDir, 'fast')
  const checked = audit(['check', r.runDir])
  assert.equal(checked.status, 1)
  assert.ok(checked.lines.includes('check: run-metadata.json: profile must be one of quick, standard, deep'), checked.stdout)
})
