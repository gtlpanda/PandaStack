import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

async function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'run-followup-'))
  try { await work(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

await test('explicit central config is isolated from absent and invalid source defaults with precedence intact', () => fixture(async root => {
  for (const file of ['graphs/autobuild/tool/lib/config.mjs', 'scripts/agent-config.mjs',
    'core/skills/decisions/config.mjs', 'core/skills/decisions/records.mjs']) {
    const target = join(root, file)
    fs.mkdirSync(dirname(target), { recursive: true })
    fs.copyFileSync(new URL(`../${file}`, import.meta.url), target)
  }
  const { DEFAULTS, resolveManagedConfig, loadConfig } = await import(pathToFileURL(join(root, 'graphs/autobuild/tool/lib/config.mjs')))
  const central = { maxConcurrentSubagents: 3, claude: {
    orchestrator: { model: 'opus', effort: 'high' }, subagents: { model: 'sonnet', effort: 'high' },
    advisor: { model: 'fable', effort: 'high' }, agentOverrides: {},
  } }
  for (const malformed of [false, true]) {
    if (malformed) fs.writeFileSync(join(root, 'agent-config.json'), '{invalid')
    assert.throws(() => DEFAULTS.model)
    for (const backend of ['claude', 'codex']) {
      const base = resolveManagedConfig({ root, central, overrides: { backend } })
      assert.equal(base.model, backend === 'claude' ? 'opus' : 'gpt-6-astra')
      assert.equal(base.subagentModel, backend === 'claude' ? 'sonnet' : 'gpt-6.1-sol')
      assert.equal(base.maxConcurrentSubagents, 3)
      const selected = resolveManagedConfig({ root, central,
        project: { model: 'haiku', maxConcurrentSubagents: 7 },
        env: { MODEL: 'sonnet', SUBAGENT_MODEL: 'haiku' }, overrides: { backend, model: 'opus' } })
      assert.equal(selected.model, base.model)
      assert.equal(selected.subagentModel, backend === 'claude' ? 'haiku' : 'gpt-6-luna')
      assert.equal(selected.maxConcurrentSubagents, 7)
    }
  }
  fs.writeFileSync(join(root, 'agent-config.json'), JSON.stringify(central))
  fs.writeFileSync(join(root, 'autobuild.json'), '{}')
  assert.equal(DEFAULTS.model, 'opus')
  assert.equal(DEFAULTS.subagentModel, 'sonnet')
  assert.equal(DEFAULTS.maxConcurrentSubagents, 3)
  assert.equal(loadConfig(root, {}).model, 'opus')
  assert.equal(loadConfig(root, { MODEL: 'haiku' }).model, 'haiku')
}))

const run = { schemaVersion: 1, id: 'followup', repo: '/tmp/project', revision: null,
  runnerRoot: '/tmp/runner', runnerRevision: null, workflow: 'autobuild', backend: 'codex',
  parentRunId: null, startedAt: '2026-11-09T12:00:00Z', settings: {} }

await test('run and event publication clean up after close EIO, including cleanup after a write error', () => fixture(root => {
  for (const event of [false, true]) for (const writeFailure of [false, true]) {
    const directory = join(root, `${event}-${writeFailure}`), store = createRunStore(directory)
    if (event) store.putRun(run)
    const saved = Object.fromEntries(['openSync', 'closeSync', 'writeFileSync', 'unlinkSync'].map(k => [k, fs[k]]))
    const active = new Set()
    let tempFd, closeCalls = 0, removals = 0
    try {
      fs.openSync = (...args) => {
        const fd = saved.openSync(...args)
        active.add(fd)
        if (String(args[0]).includes('/.tmp-')) tempFd = fd
        return fd
      }
      fs.closeSync = fd => {
        assert.ok(active.delete(fd), 'descriptor is closed exactly once')
        saved.closeSync(fd)
        if (fd === tempFd) {
          closeCalls++
          throw Object.assign(new Error('SECRET close error'), { code: 'EIO' })
        }
      }
      fs.writeFileSync = (...args) => {
        if (writeFailure && args[0] === tempFd) throw Object.assign(new Error('SECRET write error'), { code: 'EIO' })
        return saved.writeFileSync(...args)
      }
      fs.unlinkSync = path => {
        assert.match(path, /^\/proc\/self\/fd\/\d+\/\.tmp-/)
        removals++
        return saved.unlinkSync(path)
      }
      syncBuiltinESMExports()
      const publish = () => event ? store.appendEvent({ schemaVersion: 1, id: 'start', runId: run.id,
        type: 'started', at: run.startedAt, exitCode: null }) : store.putRun(run)
      assert.throws(publish, e => e.code === 'IO_ERROR' && e.message === 'Run store: IO_ERROR')
      assert.equal(closeCalls, 1)
      assert.equal(removals, 1)
      assert.equal(active.size, 0)
    } finally {
      Object.assign(fs, saved)
      syncBuiltinESMExports()
    }
    assert.deepEqual(fs.readdirSync(join(directory, event ? `events/${run.id}` : 'runs')), [])
    if (event) assert.deepEqual(store.readEvents(run.id), [])
    else assert.equal(store.readRun(run.id), null)
  }
}))
