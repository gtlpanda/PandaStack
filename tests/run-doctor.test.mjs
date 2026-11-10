import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readdirSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { readAgentConfig } from '../scripts/agent-config.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { inspectDoctor, resolveSettings } from '../core/skills/run-records/doctor.mjs'
import { main } from '../scripts/pandastack.mjs'

const central = readAgentConfig()
const probe = async () => ({ version: 'fixture-1.0', controls: Object.fromEntries(['model', 'effort', 'concurrency'].map(k => [k, { status: 'supported', evidence: 'Trusted fixture proves control.' }])) })
async function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'doctor tests '))
  const repo = join(root, 'project'), pandaRoot = join(root, 'panda'), home = join(root, 'home')
  for (const dir of [repo, pandaRoot, home]) mkdirSync(dir)
  try {
    for (const file of ['agent-config.json', 'settings.json', 'core/agents']) cpSync(join(ROOT, file), join(pandaRoot, file), { recursive: true })
    mkdirSync(join(pandaRoot, 'graphs'))
    for (const graph of readdirSync(join(ROOT, 'graphs'))) for (const dir of ['agents', 'workflows']) {
      try { cpSync(join(ROOT, 'graphs', graph, dir), join(pandaRoot, 'graphs', graph, dir), { recursive: true }) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await work({ repo, pandaRoot, env: { HOME: home }, capabilityProbe: probe })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

await test('doctor models match managed launch precedence and provenance without mutating inputs', async () => {
  await fixture(async ({ repo }) => {
    for (const backend of ['claude', 'codex']) for (const [project, env, overrides, source] of [
      [{}, {}, {}, backend === 'codex' ? 'default' : 'central'],
      [{ model: 'haiku', subagentModel: 'opus' }, {}, {}, 'project'],
      [{ model: 'haiku' }, { MODEL: 'sonnet', SUBAGENT_MODEL: 'haiku' }, {}, 'env'],
      [{ model: 'haiku' }, { MODEL: 'haiku', AUTOBUILD_MODEL: 'sonnet', AUTOBUILD_SUBAGENT_MODEL: 'opus' }, { model: 'opus' }, 'cli'],
    ]) {
      const input = { backend, central, project, env, overrides }, before = structuredClone(input)
      writeFileSync(join(repo, 'autobuild.json'), JSON.stringify({ ...project, backend }))
      const managed = loadConfig(repo, env, overrides), settings = resolveSettings(input)
      for (const key of ['model', 'subagentModel', 'probeModel', 'maxConcurrentSubagents']) assert.equal(settings.values[key], managed[key])
      assert.equal(settings.sources.model, source)
      assert.deepEqual(input, before)
    }
  })
})

await test('doctor resolves role effort, force, and stripped inherited Claude settings', () => {
  const args = { central, backend: 'claude' }
  const inherited = resolveSettings({ ...args, env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })
  assert.equal(inherited.values.effort, central.claude.orchestrator.effort)
  assert.equal(inherited.sources.effort, 'central')
  const forced = resolveSettings({ ...args, project: { subagentModelForce: true, subagentModel: 'haiku' } })
  assert.equal(forced.values.advisorModel, 'haiku'); assert.equal(forced.values.advisorEffort, central.claude.advisor.effort)
  for (const value of ['auto', '', 'unrecognized']) {
    const setting = resolveSettings({ ...args, project: { env: { vars: { CLAUDE_CODE_EFFORT_LEVEL: value } } } })
    assert.equal(setting.values.effort, null); assert.equal(setting.sources.effort, 'unknown')
  }
  const codex = resolveSettings({ central, backend: 'codex', project: { codex: { reasoningEffort: 'high' } }, env: { AUTOBUILD_PROBE_MODEL: 'haiku' } })
  assert.equal(codex.values.advisorEffort, 'high'); assert.equal(codex.values.subagentEffort, null)
  assert.equal(codex.sources.subagentEffort, 'unknown'); assert.equal(codex.values.probeEffort, 'high')
  assert.equal(codex.values.probeModel, 'gpt-6-luna'); assert.equal(codex.sources.probeModel, 'env')
})

await test('doctor rejects malformed known config and unsupported overrides', () => {
  for (const project of [null, [], { model: 'SECRET invalid' }, { maxConcurrentSubagents: 0 }, { subagentModelForce: 1 }, { env: [] }, { env: { vars: [] } }, { env: { pathPrepend: 'bad' } }, { codex: 'bad' }, { codex: { reasoningEffort: null } }]) {
    assert.throws(() => resolveSettings({ central, backend: 'codex', project }))
  }
  assert.throws(() => resolveSettings({ central, backend: 'codex', overrides: { effort: 'low' } }))
  assert.throws(() => resolveSettings({ central, backend: 'codex', env: { MODEL: {} } }))
})

await test('doctor normalizes malformed probes and requires positive evidence for every control', async () => {
  await fixture(async args => {
    assert.equal((await inspectDoctor(args)).status, 'ready')
    for (const output of [null, [], {}, { version: '1.2.3' }, { controls: { model: { status: 'supported', evidence: '' } } }]) {
      assert.equal((await inspectDoctor({ ...args, capabilityProbe: async () => output })).status, 'degraded')
    }
    const unsupported = await probe(); unsupported.controls.effort.status = 'unsupported'
    assert.equal((await inspectDoctor({ ...args, capabilityProbe: async () => unsupported })).status, 'blocked')
    const failed = await inspectDoctor({ ...args, capabilityProbe: async () => { throw Error('SECRET') } })
    assert.equal(failed.status, 'blocked'); assert.ok(!JSON.stringify(failed).includes('SECRET'))
    writeFileSync(join(args.repo, 'autobuild.json'), JSON.stringify({ env: { vars: { CLAUDE_CODE_EFFORT_LEVEL: 'auto' } } }))
    const automatic = await inspectDoctor({ ...args, backend: 'claude' })
    assert.equal(automatic.status, 'degraded'); assert.ok(automatic.checks.some(c => c.id === 'effort-setting'))
  })
})

await test('doctor checks generated drift without writing and redacts config failures', async () => {
  await fixture(async args => {
    const file = join(args.pandaRoot, 'settings.json'), original = readFileSync(file, 'utf8')
    const changed = original.replace('"effortLevel": "high"', '"effortLevel": "low"')
    writeFileSync(file, changed)
    assert.equal((await inspectDoctor(args)).status, 'blocked'); assert.equal(readFileSync(file, 'utf8'), changed)
    writeFileSync(join(args.repo, 'autobuild.json'), '{"model":"SECRET invalid"}')
    const report = await inspectDoctor(args)
    assert.equal(report.status, 'blocked'); assert.ok(!JSON.stringify(report).includes('SECRET'))
    assert.deepEqual(report.settings, { values: {}, sources: {} })
  })
})

await test('doctor passes managed binary and effective PATH to probes and blocks absent executables', async () => {
  await fixture(async args => {
    const project = { codexBin: '/project/bin', env: { vars: { PATH: '/explicit/path' } } }
    writeFileSync(join(args.repo, 'autobuild.json'), JSON.stringify(project))
    let received
    await inspectDoctor({ ...args, env: { ...args.env, AUTOBUILD_CODEX_BIN: '/env/bin' }, capabilityProbe: async input => { received = input; return probe() } })
    assert.equal(received.bin, '/env/bin'); assert.equal(received.path, '/explicit/path')
    assert.equal((await inspectDoctor(args)).status, 'blocked')
    const missing = await inspectDoctor({ ...args, capabilityProbe: undefined })
    assert.equal(missing.status, 'blocked'); assert.ok(missing.checks.some(c => c.id === 'binary' && c.status === 'fail'))
    assert.deepEqual(readdirSync(args.env.HOME), [])
  })
})

await test('doctor CLI validates arguments in-process and prints safe JSON for paths with spaces', async () => {
  const log = console.log, error = console.error, lines = []
  console.log = value => lines.push(value); console.error = () => {}
  try {
    for (const args of [[], ['doctor'], ['doctor', '--repo'], ['doctor', '--repo', '/tmp', '--json', '--json'], ['doctor', '--repo', '/tmp', '--effort', 'high'], ['doctor', '--repo', '/tmp', '--backend', 'bad']]) assert.equal(await main(args), 1)
    await fixture(async ({ repo }) => {
      writeFileSync(join(repo, 'autobuild.json'), JSON.stringify({ model: 'invalid model' }))
      assert.equal(await main(['doctor', '--repo', repo, '--json']), 2)
      assert.equal(JSON.parse(lines.at(-1)).status, 'blocked')
    })
  } finally { console.log = log; console.error = error }
})
