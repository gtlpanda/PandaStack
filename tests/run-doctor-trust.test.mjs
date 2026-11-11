import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'
import { main } from '../scripts/pandastack.mjs'

async function fixture(work) {
  const repo = mkdtempSync(join(tmpdir(), 'doctor trust ')), home = join(repo, 'home')
  mkdirSync(home)
  const methods = ['spawnSync', 'spawn', 'execSync', 'exec', 'execFileSync', 'execFile', 'fork']
  const saved = Object.fromEntries(methods.map(key => [key, cp[key]])), calls = []
  try {
    for (const key of methods) cp[key] = () => { calls.push(key); throw Error('Unexpected subprocess') }
    syncBuiltinESMExports()
    for (const backend of ['claude', 'codex']) writeFileSync(join(repo, backend), 'inert executable fixture\n', { mode: 0o700 })
    await work({ repo, pandaRoot: ROOT, env: { HOME: home, PATH: repo } }, project => {
      writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(project))
    })
    assert.deepEqual(calls, [], 'inspection must never invoke a subprocess')
  } finally {
    Object.assign(cp, saved)
    syncBuiltinESMExports()
    rmSync(repo, { recursive: true, force: true })
  }
}

function assertUnexecuted(report, status = 'degraded') {
  assert.equal(report.status, status)
  assert.equal(report.runtime.version, null)
  for (const control of Object.values(report.runtime.controls)) {
    assert.equal(control.status, 'unknown')
    assert.match(control.evidence, /execution was not performed/i)
  }
  assert.ok(report.checks.some(c => c.id === 'binary' && c.status === (status === 'blocked' ? 'fail' : 'pass')))
  assert.ok(!report.checks.some(c => /probe completed/i.test(c.message)))
}

await test('default doctor never executes either provider across managed binary and PATH selection', async () => {
  await fixture(async (args, project) => {
    for (const backend of ['claude', 'codex']) {
      const binKey = `${backend}Bin`, envKey = `AUTOBUILD_${backend.toUpperCase()}_BIN`
      for (const [config, env] of [
        [{ [binKey]: join(args.repo, backend) }, {}],
        [{ [binKey]: `./${backend}` }, {}],
        [{ [binKey]: backend, env: { vars: { PATH: args.repo } } }, { PATH: '/absent' }],
        [{ env: { pathPrepend: [args.repo] } }, { PATH: '/absent' }],
        [{ [binKey]: '/absent' }, { [envKey]: join(args.repo, backend) }],
        [{}, {}],
      ]) {
        project(config)
        const report = await inspectDoctor({ ...args, backend, env: { ...args.env, ...env } })
        assertUnexecuted(report)
        assert.equal(report.checks.find(c => c.id === 'configuration').status, 'pass')
        assert.equal(report.checks.find(c => c.id === 'generated').status, 'pass')
      }
    }
  })
})

await test('default doctor blocks missing and nonexecutable selections without fallback or project evidence', async () => {
  await fixture(async (args, project) => {
    const nonexec = join(args.repo, 'nonexec')
    writeFileSync(nonexec, 'inert fixture', { mode: 0o600 })
    for (const backend of ['claude', 'codex']) {
      for (const bin of [join(args.repo, 'missing'), 'missing-provider', nonexec, args.repo]) {
        project({ [`${backend}Bin`]: bin, runtime: { version: '1.2.3' }, capabilityProbe: { controls: 'supported' } })
        assertUnexecuted(await inspectDoctor({ ...args, backend }), 'blocked')
      }
      project({ [`${backend}Bin`]: join(args.repo, backend) })
      assertUnexecuted(await inspectDoctor({ ...args, backend,
        env: { ...args.env, [`AUTOBUILD_${backend.toUpperCase()}_BIN`]: join(args.repo, 'missing') } }), 'blocked')
    }
  })
})

await test('trusted injected doctor probes retain callback context, normalization and safe failures', async () => {
  await fixture(async (args, project) => {
    const supported = { version: 'fixture-1.0', controls: Object.fromEntries(['model', 'effort', 'concurrency']
      .map(key => [key, { status: 'supported', evidence: 'Explicit trusted test evidence.' }])) }
    for (const backend of ['claude', 'codex']) {
      project({ [`${backend}Bin`]: backend, env: { vars: { PATH: '/explicit/path' } } })
      const received = []
      const report = await inspectDoctor({ ...args, backend, capabilityProbe: async input => { received.push(input); return supported } })
      assert.equal(report.status, 'ready')
      assert.deepEqual(report.runtime, supported)
      assert.deepEqual(received, [{ backend, bin: backend, repo: args.repo, path: '/explicit/path' }])
      for (const output of [null, { version: '1.2.3' }, { controls: { model: { status: 'supported', evidence: '' } } }]) {
        assert.equal((await inspectDoctor({ ...args, backend, capabilityProbe: async () => output })).status, 'degraded')
      }
      const failed = await inspectDoctor({ ...args, backend, capabilityProbe: async () => { throw Error('PRIVATE_PROBE_DETAIL') } })
      assert.equal(failed.status, 'blocked')
      assert.ok(!JSON.stringify(failed).includes('PRIVATE_PROBE_DETAIL'))
      project({ [`${backend}Bin`]: join(args.repo, 'missing') })
      assert.equal((await inspectDoctor({ ...args, backend, capabilityProbe: async () => supported })).status, 'blocked')
    }
  })
})

await test('doctor CLI reports default nonexecution in JSON and human output', async () => {
  await fixture(async (args, project) => {
    project({ codexBin: join(args.repo, 'codex') })
    const log = console.log, lines = []
    console.log = line => lines.push(line)
    try {
      assert.equal(await main(['doctor', '--repo', args.repo, '--backend', 'codex', '--json']), 2)
      assertUnexecuted(JSON.parse(lines.pop()))
      assert.equal(await main(['doctor', '--repo', args.repo, '--backend', 'codex']), 2)
      assert.match(lines.pop(), /execution was not performed/i)
    } finally { console.log = log }
  })
})
