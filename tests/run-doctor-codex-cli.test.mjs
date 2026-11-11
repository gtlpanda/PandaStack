import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'
import { npmCodex } from '../graphs/autobuild/tool/test-fixtures/codex-installs.mjs'

// Doctor reads versions from package.json only; any subprocess here is a regression.
async function noSubprocess(work) {
  const methods = ['spawnSync', 'spawn', 'execSync', 'exec', 'execFileSync', 'execFile', 'fork']
  const saved = Object.fromEntries(methods.map(key => [key, cp[key]])), calls = []
  try {
    for (const key of methods) cp[key] = () => { calls.push(key); throw Error('Unexpected subprocess') }
    syncBuiltinESMExports()
    await work()
  } finally {
    Object.assign(cp, saved)
    syncBuiltinESMExports()
  }
  assert.deepEqual(calls, [], 'doctor must never invoke a subprocess')
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'doctor codex cli ')), home = join(repo, 'home')
  mkdirSync(home)
  writeFileSync(join(repo, 'autobuild.json'), '{}')
  const old = npmCodex(join(repo, 'usr'), '0.154.0'), fresh = npmCodex(join(repo, 'npm-global'), '0.167.0')
  return { repo, home, old, fresh }
}
const codexCheck = report => report.checks.find(c => c.id === 'codex-cli')

await test('doctor names the Codex in use and warns about an older one shadowing a newer one', async () => {
  const { repo, home, old, fresh } = fixture()
  try {
    await noSubprocess(async () => {
      const shadowed = await inspectDoctor({ repo, pandaRoot: ROOT, backend: 'codex', env: { HOME: home, PATH: [old, fresh].join(delimiter) } })
      assert.equal(codexCheck(shadowed)?.status, 'pass', 'informational: readiness never depends on other installs')
      assert.match(codexCheck(shadowed).message, /^Codex in use: .*usr\/bin\/codex \(0\.154\.0\)\. Warning: 1 more on PATH: .*npm-global\/bin\/codex \(0\.167\.0\)\. The one in use is older/)
      const single = await inspectDoctor({ repo, pandaRoot: ROOT, backend: 'codex', env: { HOME: home, PATH: fresh } })
      assert.match(codexCheck(single).message, /^Codex in use: .*npm-global\/bin\/codex \(0\.167\.0\)\.$/)
      assert.equal(shadowed.status, single.status, 'a second install does not change overall readiness')
    })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

await test('doctor adds no Codex check for the Claude backend or when no Codex is found', async () => {
  const { repo, home, old } = fixture()
  try {
    await noSubprocess(async () => {
      writeFileSync(join(repo, 'claude'), 'inert fixture\n', { mode: 0o700 })
      const claude = await inspectDoctor({ repo, pandaRoot: ROOT, backend: 'claude', env: { HOME: home, PATH: [repo, old].join(delimiter) } })
      assert.equal(codexCheck(claude), undefined)
      const missing = await inspectDoctor({ repo, pandaRoot: ROOT, backend: 'codex', env: { HOME: home, PATH: join(repo, 'absent') } })
      assert.equal(codexCheck(missing), undefined)
      assert.equal(missing.status, 'blocked')
    })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
