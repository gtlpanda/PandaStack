import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'
import { withTrackedRun, currentRunId } from '../core/skills/run-records/tracking.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'
import { autobuildTracking, buildTracking, runnerRoot } from '../core/skills/run-records/adapters.mjs'
import { runClaude, sliceArgs } from '../graphs/build/skills/build-app/driver/session.mjs'
import { runCodex } from '../graphs/autobuild/tool/lib/codex.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'

async function fixture(work) {
  const base = mkdtempSync(join(tmpdir(), 'tracking-'))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  const storeDir = join(base, 'store')
  const options = { repo, runnerRoot, storeDir, workflow: 'autobuild', backend: 'codex', settings: {} }
  try { await work(options, createRunStore(storeDir)) } finally { rmSync(base, { recursive: true, force: true }) }
}
await test('tracking isolates concurrent parents, assigns fresh IDs and preserves terminal codes', () => fixture(async (o, store) => {
  await Promise.all(['a', 'b'].map(runId => withTrackedRun({ ...o, runId }, async () => {
    await new Promise(r => setTimeout(r, 2))
    assert.equal(currentRunId(), runId)
    return withTrackedRun({ ...o, runId: `${runId}-child`, workflow: 'session' }, async () => 0)
  })))
  for (const id of ['a', 'b']) assert.equal(store.readRun(`${id}-child`).parentRunId, id)
  for (const code of [0, 7, 130]) {
    assert.equal(await withTrackedRun(o, async () => code), code)
  }
  assert.equal(store.listRuns().length, 7)
  assert.equal(currentRunId(), null)
  const terminals = store.listRuns().flatMap(r => store.readEvents(r.id)).map(e => e.type)
  assert.ok(terminals.includes('failed')); assert.ok(terminals.includes('cancelled'))
}))
await test('conflicts leave existing records/events unchanged; errors retain identity without secrets', () => fixture(async (o, s) => {
  await withTrackedRun({ ...o, runId: 'same' }, async () => 0)
  const before = s.readEvents('same')
  let calls = 0
  assert.equal(await withTrackedRun({ ...o, runId: 'same', backend: 'claude' }, async () => { calls++; return 9 }), 9)
  assert.equal(calls, 1); assert.deepEqual(s.readEvents('same'), before)
  const error = new Error('SECRET_SENTINEL')
  await assert.rejects(withTrackedRun({ ...o, runId: 'throws' }, async () => { throw error }), e => e === error)
  assert.ok(s.readEvents('throws').some(e => e.type === 'failed' && e.exitCode === 1))
  assert.ok(!JSON.stringify(s.readEvents('throws')).includes(error.message))
}))
await test('storage failure executes once, preserves errors and bounds safe warnings', () => fixture(async o => {
  const file = join(dirname(o.storeDir), 'file'); writeFileSync(file, 'not a directory')
  const original = process.stderr.write
  const messages = []
  process.stderr.write = text => { messages.push(text); return true }
  try {
    let calls = 0
    const error = new Error('SECRET_SENTINEL')
    await assert.rejects(withTrackedRun({ ...o, storeDir: file }, async () => { calls++; throw error }), e => e === error)
    assert.equal(calls, 1); assert.equal(messages.length, 1)
    assert.ok(!messages.join('').includes('SECRET_SENTINEL'))
  } finally { process.stderr.write = original }
}))
await test('canonical paths and Git per-worktree default; explicit store wins environment', () => fixture(async o => {
  execFileSync('git', ['init', '-q', o.repo], { stdio: ['ignore', 'pipe', 'pipe'] })
  const alias = join(o.repo, 'alias'); symlinkSync(o.repo, alias)
  const { storeDir, ...defaults } = o
  const old = process.env.PANDASTACK_RUNS_DIR
  try {
    delete process.env.PANDASTACK_RUNS_DIR
    await withTrackedRun({ ...defaults, repo: alias, runId: 'default' }, async () => 0)
    const s = createRunStore(join(o.repo, '.git', 'pandastack-runs'))
    assert.equal(s.readRun('default').repo, o.repo)
    assert.equal(s.readRun('default').revision, null)
    process.env.PANDASTACK_RUNS_DIR = join(o.repo, 'env-store')
    await withTrackedRun({ ...o, runId: 'explicit' }, async () => 0)
    assert.ok(createRunStore(storeDir).readRun('explicit'))
  } finally { if (old === undefined) delete process.env.PANDASTACK_RUNS_DIR; else process.env.PANDASTACK_RUNS_DIR = old }
}))
await test('managed snapshots honor effective models, force and Codex effort', () => {
  const cfg = { root: '/tmp', backend: 'codex', model: 'gpt-6.1-sol', subagentModel: 'gpt-6-luna', codex: { reasoningEffort: 'high' }, maxConcurrentSubagents: 2 }
  assert.equal(autobuildTracking(cfg, 'session').settings.effort, 'high')
  assert.equal(autobuildTracking(cfg, 'session').settings.model, cfg.model)
  assert.equal(autobuildTracking(cfg, 'session').settings.sources.model, 'runtime')
  const claude = autobuildTracking({ ...cfg, backend: 'claude', subagentModelForce: true }, 'session').settings
  assert.equal(claude.advisorModel, cfg.subagentModel)
  assert.equal(buildTracking('/tmp', 'sonnet', 'build-app').settings.model, 'sonnet')
})
await test('actual fake Claude and Codex sessions retain parent IDs, flags, failure codes and probe exclusion', () => fixture(async (o, store) => {
  const old = process.env.PANDASTACK_RUNS_DIR
  process.env.PANDASTACK_RUNS_DIR = o.storeDir
  try {
    const script = join(o.repo, 'steps.json')
    writeFileSync(script, JSON.stringify([{ ok: true }]))
    writeFileSync(join(o.repo, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'low', env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3' } }))
    const claudeOptions = { bin: join(runnerRoot, 'graphs/build/tests/fixtures/fake-claude.mjs'), repo: o.repo,
      args: sliceArgs({ prompt: 'SECRET_PROMPT', model: 'sonnet', settingsFile: join(o.repo, 'settings.json') }),
      env: { ...process.env, FAKE_CLAUDE_SCRIPT: script }, logFile: join(o.repo, 'claude.log'), timeoutMs: 3000 }
    await withTrackedRun({ ...o, runId: 'parent' }, async () => {
      assert.equal(await runClaude(claudeOptions), 0)
      writeFileSync(join(o.repo, 'autobuild.json'), '{}')
      const config = loadConfig(o.repo, { AUTOBUILD_BACKEND: 'codex' })
      config.codexBin = join(runnerRoot, 'graphs/autobuild/tool/test-fixtures/fake-codex.mjs')
      config.env.vars = { FAKE_CLAUDE_SCRIPT: script }
      writeFileSync(script, JSON.stringify([{ error: 'SECRET_FAILURE' }]))
      assert.equal(await runCodex(config, { prompt: 'SECRET_PROMPT', role: 'builder', logFile: join(o.repo, 'codex.log') }), 1)
      writeFileSync(script, JSON.stringify([{ ok: true }]))
      assert.equal(await runCodex(config, { prompt: 'OK', role: 'probe', logFile: join(o.repo, 'probe.log') }), 0)
      return 0
    })
    const children = store.listRuns({ parentRunId: 'parent' })
    assert.equal(children.length, 2)
    assert.equal(children.find(r => r.backend === 'claude').settings.model, 'sonnet')
    assert.equal(children.find(r => r.backend === 'claude').settings.effort, 'low')
    assert.equal(children.find(r => r.backend === 'claude').settings.maxConcurrentSubagents, 3)
    assert.ok(children.every(r => r.workflow === 'session'))
    assert.ok(store.readEvents(children.find(r => r.backend === 'codex').id).some(e => e.type === 'failed' && e.exitCode === 1))
    assert.ok(!JSON.stringify(store.listRuns()).includes('SECRET'))
  } finally { if (old === undefined) delete process.env.PANDASTACK_RUNS_DIR; else process.env.PANDASTACK_RUNS_DIR = old }
}))
