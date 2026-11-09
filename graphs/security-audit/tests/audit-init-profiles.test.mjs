// audit-init-profiles.test.mjs - init and the three profiles, beyond the P-02 acceptance test: a direct caller of init() with a profile the parser
// would have stopped is refused before anything is created, every profile's what-runs note is the one its rules call for, and parseInitArgs keeps
// a name only when it is exactly one of the three.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { init as initRun, parseInitArgs, Usage, SUPPORTED_PROFILES } from '../skills/security-audit/audit-run.mjs'
import { profileRules } from '../skills/security-audit/audit-profile.mjs'
import { init, meta, mkRepo, runsOf } from './audit-fixtures.mjs'

console.log('== init and the three profiles')
await test('a direct init() call with a profile that is not one of the three is refused naming the three, and creates no run directory', () => {
  const repo = mkRepo()
  for (const profile of ['fast', 'Quick', '', null, undefined, 1]) {
    const opts = { ...parseInitArgs([repo, '--full']), profile }
    assert.throws(() => initRun(opts), e => !(e instanceof TypeError) && e.message === `profile must be one of quick, standard, deep, not ${JSON.stringify(profile)}`, String(profile))
  }
  assert.deepEqual(runsOf(repo), [])
})
await test('parseInitArgs keeps each of the three names as given, defaults to standard, and makes anything near them a usage error', () => {
  assert.equal(parseInitArgs(['--full']).profile, 'standard')
  for (const profile of SUPPORTED_PROFILES) assert.equal(parseInitArgs(['--full', '--profile', profile]).profile, profile)
  for (const bad of ['quick ', ' deep', 'Deep', 'standard,quick', 'quick|standard|deep', '__proto__', 'constructor']) {
    assert.throws(() => parseInitArgs(['--full', '--profile', bad]), Usage, JSON.stringify(bad))
  }
  assert.throws(() => parseInitArgs(['--full', '--profile', 'quick', '--profile', 'deep']), Usage, 'a repeated --profile is never last-one-wins')
})
await test('each profile\'s what-runs note follows its verifiersPerCandidate rule, and the rest of the note is the same for all three', () => {
  const repo = mkRepo()
  const notes = {}
  for (const profile of SUPPORTED_PROFILES) {
    const r = init([repo, '--full', '--profile', profile, '--budget', '20'])
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.equal(meta(r.runDir).profile, profile)
    notes[profile] = r.stdout.split('\n').find(l => l.startsWith('note: what runs:'))
    const expected = profileRules(profile).verifiersPerCandidate === 1 ? 'one verifier' : 'one or two verifiers'
    assert.equal(notes[profile], `note: what runs: about one agent per coverage unit, then ${expected} per surviving lead; a budget of 20 agent invocations is set`, profile)
  }
  assert.equal(notes.standard, notes.deep)
  assert.notEqual(notes.quick, notes.standard)
})
