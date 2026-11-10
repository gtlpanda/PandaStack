import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { sessionSettings } from '../graphs/autobuild/tool/lib/loop.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'

async function fixture(work) {
  const repo = mkdtempSync(join(tmpdir(), 'launch parity '))
  const write = project => writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(project))
  try { await work(repo, write) } finally { rmSync(repo, { recursive: true, force: true }) }
}
const supported = { version: 'fixture', controls: Object.fromEntries(['model', 'effort', 'concurrency']
  .map(key => [key, { status: 'supported', evidence: 'Trusted test evidence.' }])) }

await test('doctor shares selected role validation and provenance without validating shadowed model values', () => fixture(async (repo, write) => {
  for (const backend of ['claude', 'codex']) {
    const expected = backend === 'claude' ? 'sonnet' : 'gpt-6.1-sol'
    for (const [key, primary, legacy] of [
      ['model', 'AUTOBUILD_MODEL', 'MODEL'],
      ['subagentModel', 'AUTOBUILD_SUBAGENT_MODEL', 'SUBAGENT_MODEL'],
      ['probeModel', 'AUTOBUILD_PROBE_MODEL', 'PROBE_MODEL'],
    ]) {
      for (const bad of ['', null, false, 0, [], {}, 'PRIVATE MODEL', 'opus\n']) {
        write({ backend, [key]: bad })
        const env = { [primary]: 'sonnet', [legacy]: 'PRIVATE SHADOWED' }
        let calls = 0
        const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env,
          capabilityProbe: async () => { calls++; return supported } })
        assert.equal(loadConfig(repo, env)[key], expected)
        assert.equal(report.status, 'ready')
        assert.equal(report.settings.values[key], expected)
        assert.equal(report.settings.sources[key], 'env')
        assert.equal(calls, 1)
        assert.ok(!JSON.stringify(report).includes('PRIVATE'))

        assert.throws(() => loadConfig(repo, {}))
        const invalid = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env: {},
          capabilityProbe: async () => { calls++; return supported } })
        assert.equal(invalid.status, 'blocked')
        assert.equal(calls, 1)
      }
    }
    write({ backend, model: 'PRIVATE PROJECT' })
    const env = { AUTOBUILD_MODEL: 'PRIVATE AUTO', MODEL: 'PRIVATE LEGACY' }
    const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env, overrides: { model: 'sonnet' }, capabilityProbe: async () => supported })
    assert.equal(report.status, 'ready')
    assert.equal(report.settings.values.model, expected)
    assert.equal(report.settings.sources.model, 'cli')
    write({ backend, model: 'sonnet' })
    assert.equal((await inspectDoctor({ repo, backend, pandaRoot: ROOT, env: { AUTOBUILD_MODEL: '' },
      overrides: { model: '' }, capabilityProbe: async () => supported })).settings.sources.model, 'project')
    for (const project of [{ maxConcurrentSubagents: 0 }, { hooks: 'invalid' }, { env: { vars: { PATH: 3 } } }, { subagentModelForce: 'yes' }]) {
      write({ backend, ...project })
      let calls = 0
      const invalid = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env, overrides: { model: 'sonnet' },
        capabilityProbe: async () => { calls++; return supported } })
      assert.equal(invalid.status, 'blocked')
      assert.equal(calls, 0)
    }
  }
}))

await test('Claude session settings preserve selected CLI model on hook reload while retaining hook and permission policy', () => fixture((repo, write) => {
  const parentBefore = { ...process.env }
  for (const hooks of ['inject', 'project']) for (const model of [null, 'sonnet', 'PRIVATE MODEL']) {
    write({ backend: 'claude', model, hooks, frozen: ['tests'], env: { vars: { AUTOBUILD_MODEL: 'haiku' } } })
    const inherited = { AUTOBUILD_MODEL: 'haiku', MODEL: 'PRIVATE LEGACY', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }
    const config = loadConfig(repo, inherited, { model: 'opus' })
    const before = structuredClone(config), settings = sessionSettings(config)
    const childEnv = { ...inherited, ...config.env.vars, ...settings.env }
    assert.equal(settings.model, 'opus')
    assert.equal(loadConfig(repo, childEnv).model, settings.model)
    assert.equal(childEnv.CLAUDE_CODE_OAUTH_TOKEN, inherited.CLAUDE_CODE_OAUTH_TOKEN)
    assert.ok(!JSON.stringify(settings).includes('fixture-token'))
    assert.ok(settings.permissions.deny.includes('Edit(/tests/**)'))
    assert.ok(settings.permissions.deny.includes('Bash(git push *)'))
    assert.ok(settings.hooks.StopFailure)
    if (hooks === 'inject') {
      assert.match(settings.hooks.Stop[0].hooks[0].command, /stop-gate\.mjs/)
      const guard = settings.hooks.PreToolUse[0].hooks[0]
      assert.match(guard.command, /guard\.mjs/)
      assert.equal(guard.onFailure, 'block')
    } else {
      assert.equal(settings.hooks.Stop, undefined)
      assert.equal(settings.hooks.PreToolUse, undefined)
    }
    assert.deepEqual(config, before)
  }
  assert.deepEqual({ ...process.env }, parentBefore)
}))

await test('doctor resolves relative PATH from target repo and never executes discovered providers', () => fixture(async (repo, write) => {
  mkdirSync(join(repo, 'local bin'))
  mkdirSync(join(repo, 'outside'))
  writeFileSync(join(repo, 'local bin', 'fixture-provider'), 'inert fixture', { mode: 0o700 })
  const cwd = process.cwd(), saved = {}, calls = []
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    saved[key] = cp[key]
    cp[key] = () => { calls.push(key); throw Error('Unexpected provider execution') }
  }
  syncBuiltinESMExports()
  try {
    process.chdir(join(repo, 'outside'))
    for (const backend of ['claude', 'codex']) {
      for (const [configEnv, env, found] of [
        [{ pathPrepend: ['missing', 'local bin'] }, { PATH: '' }, true],
        [{ pathPrepend: [join(repo, 'local bin')] }, { PATH: '' }, true],
        [{ pathPrepend: ['local bin'], vars: { PATH: 'absent' } }, { PATH: 'local bin' }, false],
        [{ vars: { PATH: 'local bin' } }, { PATH: '' }, true],
        [{}, { PATH: 'local bin' }, true],
        [{ pathPrepend: ['outside'] }, { PATH: '' }, false],
      ]) {
        write({ backend, [`${backend}Bin`]: 'fixture-provider', env: configEnv })
        const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env })
        assert.equal(report.status, found ? 'degraded' : 'blocked')
        assert.equal(report.checks.find(c => c.id === 'binary').status, found ? 'pass' : 'fail')
        assert.equal(report.runtime.version, null)
        assert.ok(Object.values(report.runtime.controls).every(c => c.status === 'unknown'))
      }
    }
    assert.deepEqual(calls, [])
  } finally { process.chdir(cwd); Object.assign(cp, saved); syncBuiltinESMExports() }
}))
