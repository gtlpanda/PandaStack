// autobuild.json lists scripts/test.sh's suites as separate gate steps, so the gate can spread
// them over CI shards. scripts/test.sh stays the one-command run (verify.sh uses it). This keeps
// the two lists from drifting: a suite added to test.sh but not to the gate would silently stop
// running in CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, test } from '../scripts/workflow-harness.mjs'

const testSh = readFileSync(join(REPO, 'scripts', 'test.sh'), 'utf8')
const gate = JSON.parse(readFileSync(join(REPO, 'autobuild.json'), 'utf8')).gate

await test('every suite scripts/test.sh runs is exactly one gate step, and no gate step runs test.sh itself', () => {
  const loop = /^for t in ([^;]+); do$/m.exec(testSh)
  assert.ok(loop, 'scripts/test.sh still lists its suites in one `for t in ...; do` loop')
  const suites = loop[1].trim().split(/\s+/)
  assert.ok(suites.length >= 5 && suites.every(s => /^scripts\/[\w-]+\.sh$/.test(s)), `suites: ${suites}`)
  for (const suite of suites) {
    const steps = gate.filter(entry => entry.command === `bash ${suite}`)
    assert.equal(steps.length, 1, `${suite} is the command of exactly one gate step`)
  }
  assert.ok(!gate.some(entry => /scripts\/test\.sh/.test(entry.command)), 'no gate step runs scripts/test.sh (its suites would run twice)')
})

await test('the workflow suite is the shardable step and every other gate step has a weight', () => {
  const shardable = gate.filter(entry => entry.shardable === true)
  assert.deepEqual(shardable.map(entry => entry.command), ['bash scripts/test-workflow.sh'])
  for (const entry of gate.filter(entry => entry.shardable !== true)) {
    assert.ok(Number.isInteger(entry.shardWeight) && entry.shardWeight >= 1, `${entry.name} has a shardWeight`)
  }
})
