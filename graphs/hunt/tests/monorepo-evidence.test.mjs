import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import assert from 'node:assert/strict'
await test('isolated monorepo evidence executes regression suites', () => {
  const r = spawnSync(process.execPath, ['--test', join(REPO, 'graphs/hunt/test-native/monorepo-evidence.test.mjs')], { encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
})
