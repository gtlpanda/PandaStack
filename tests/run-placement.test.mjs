import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'
import { withTrackedRun, currentRunId } from '../core/skills/run-records/tracking.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

const warning = 'PandaStack: run tracking unavailable; execution continues.\n'
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function init(root) {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'initial')
}
function snapshot(root) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path)
    return [name, stat.isDirectory() ? snapshot(path) : stat.isSymbolicLink() ? 'symlink' : readFileSync(path, 'utf8')]
  })
}
async function fixture(work) {
  const base = mkdtempSync(join(tmpdir(), 'run-placement-'))
  const repo = join(base, 'project'), runnerRoot = join(base, 'runner')
  mkdirSync(repo); mkdirSync(runnerRoot)
  const previous = process.env.PANDASTACK_RUNS_DIR
  delete process.env.PANDASTACK_RUNS_DIR
  try { await work({ base, repo, runnerRoot, workflow: 'autobuild', backend: 'codex', settings: {} }) }
  finally {
    if (previous === undefined) delete process.env.PANDASTACK_RUNS_DIR
    else process.env.PANDASTACK_RUNS_DIR = previous
    rmSync(base, { recursive: true, force: true })
  }
}
async function capture(work) {
  const original = process.stderr.write
  let warnings = ''
  process.stderr.write = text => { warnings += String(text); return true }
  try { return { value: await work(), warnings } }
  finally { process.stderr.write = original }
}
async function refused(options, checkRoot) {
  const before = snapshot(checkRoot)
  let calls = 0
  const result = await capture(() => withTrackedRun(options, async () => {
    calls++
    assert.equal(currentRunId(), null)
    assert.deepEqual(snapshot(checkRoot), before, 'placement checked before work and any mutation')
    return 17
  }))
  assert.deepEqual(result, { value: 17, warnings: warning })
  assert.equal(calls, 1)
  assert.equal(currentRunId(), null)
  assert.deepEqual(snapshot(checkRoot), before)
}

await test('managed placement protects full Git roots, ignored paths and non-Git roots', () => fixture(async o => {
  for (const root of [o.repo, o.runnerRoot]) init(root)
  writeFileSync(join(o.repo, '.gitignore'), 'ignored/\n')
  const sub = join(o.repo, 'packages', 'app'), runnerSub = join(o.runnerRoot, 'lib')
  mkdirSync(sub, { recursive: true }); mkdirSync(runnerSub)
  for (const storeDir of [o.repo, join(o.repo, 'new', 'records'), join(o.repo, 'ignored'), o.runnerRoot, join(o.runnerRoot, 'records'), join(o.repo, '.git', 'pandastack-runs-other')]) {
    await refused({ ...o, repo: sub, runnerRoot: runnerSub, storeDir }, o.base)
  }
  const plain = join(o.base, 'plain'); mkdirSync(plain)
  await refused({ ...o, repo: plain, storeDir: join(plain, 'records') }, o.base)
}))

await test('environment placement and explicit precedence preserve errors without fallback or disclosure', () => fixture(async o => {
  process.env.PANDASTACK_RUNS_DIR = join(o.repo, 'env-records')
  await refused(o, o.base)
  process.env.PANDASTACK_RUNS_DIR = join(o.base, 'external')
  const before = snapshot(o.base), original = Error('PRIVATE_WORK_MESSAGE')
  let calls = 0
  const result = await capture(async () => {
    await assert.rejects(withTrackedRun({ ...o, storeDir: join(o.runnerRoot, 'records') }, async () => {
      calls++; assert.equal(currentRunId(), null); throw original
    }), error => error === original)
  })
  assert.equal(calls, 1); assert.equal(result.warnings, warning)
  assert.deepEqual(snapshot(o.base), before)
}))

await test('prospective placement resolves static aliases, missing suffixes and lexical dot segments', () => fixture(async o => {
  init(o.repo)
  const alias = join(o.base, 'alias'); symlinkSync(o.repo, alias)
  await refused({ ...o, storeDir: join(alias, 'missing', 'records') }, o.base)
  const owner = git(o.repo, 'rev-parse', '--absolute-git-dir')
  symlinkSync(o.repo, join(owner, 'pandastack-runs'))
  await refused(o, o.base)
  // Match path.resolve before resolving existing ancestors, as createRunStore does.
  const storeDir = `${alias}/../project-records`
  const result = await capture(() => withTrackedRun({ ...o, storeDir, runId: 'lexical' }, async () => 0))
  assert.equal(result.warnings, '')
  assert.equal(createRunStore(resolve(storeDir)).readRun('lexical').id, 'lexical')
}))

await test('non-directory, broken and looping ancestors refuse without creating suffixes', () => fixture(async o => {
  const file = join(o.base, 'file'); writeFileSync(file, 'keep')
  const broken = join(o.base, 'broken'); symlinkSync(join(o.base, 'absent'), broken)
  const loop = join(o.base, 'loop'); symlinkSync(loop, loop)
  for (const ancestor of [file, broken, loop]) {
    await refused({ ...o, storeDir: join(ancestor, 'new', 'records') }, o.base)
  }
}))

await test('indeterminate Git roots and external symlinks fail unrecorded without weakening store policy', () => fixture(async o => {
  const external = join(o.base, 'external'); mkdirSync(external)
  const alias = join(o.base, 'alias'); symlinkSync(external, alias)
  await refused({ ...o, storeDir: join(alias, 'records') }, o.base)
  writeFileSync(join(o.runnerRoot, '.git'), 'invalid metadata pointer\n')
  await refused({ ...o, storeDir: join(external, 'not-created', 'records') }, o.base)
}))

await test('default and linked metadata namespaces work inside another protected tree', () => fixture(async o => {
  init(o.repo)
  const linked = join(o.base, 'linked')
  git(o.repo, 'worktree', 'add', '-qb', 'linked', linked)
  for (const repo of [o.repo, linked]) {
    const namespace = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'pandastack-runs')
    for (const storeDir of [undefined, join(namespace, 'shared')]) {
      const result = await capture(() => withTrackedRun({ ...o, repo, runnerRoot: o.repo, storeDir, runId: 'metadata' }, async () => {
        assert.equal(currentRunId(), 'metadata'); return 0
      }))
      assert.equal(result.warnings, '')
      assert.deepEqual(createRunStore(storeDir ?? namespace).readEvents('metadata').map(e => e.type).sort(), ['finished', 'started'])
      assert.equal(git(repo, 'status', '--porcelain'), '')
    }
  }
}))

await test('external shared stores retain concurrent parents, rejected nested context and terminal events', () => fixture(async o => {
  const storeDir = join(o.base, 'project-records'), store = createRunStore(storeDir)
  const result = await capture(() => Promise.all(['one', 'two'].map(runId => withTrackedRun({ ...o, storeDir, runId }, async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(currentRunId(), runId)
    await withTrackedRun({ ...o, storeDir: join(o.repo, 'rejected') }, async () => {
      assert.equal(currentRunId(), null); return 130
    })
    assert.equal(currentRunId(), runId)
    return withTrackedRun({ ...o, storeDir, runId: `${runId}-child`, workflow: 'session' }, async () => 130)
  }))))
  assert.deepEqual(result.value, [130, 130]); assert.equal(result.warnings, warning.repeat(2))
  assert.equal(currentRunId(), null); assert.equal(store.listRuns().length, 4)
  for (const id of ['one', 'two']) {
    assert.equal(store.readRun(`${id}-child`).parentRunId, id)
    assert.equal(store.readRun(id).revision, null)
    assert.ok(store.readEvents(id).some(event => event.type === 'cancelled'))
  }
}))

await test('direct store API continues to support caller-selected worktree directories', () => fixture(async o => {
  const store = createRunStore(join(o.repo, 'records'))
  store.putRun({ schemaVersion: 1, id: 'direct', repo: o.repo, runnerRoot: o.runnerRoot, revision: null,
    runnerRevision: null, workflow: 'session', backend: 'claude', parentRunId: null,
    startedAt: '2026-11-10T00:00:00.000Z', settings: {} })
  assert.equal(store.readRun('direct').id, 'direct')
}))
