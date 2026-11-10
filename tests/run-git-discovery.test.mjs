import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { withTrackedRun, currentRunId } from '../core/skills/run-records/tracking.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

const warning = 'PandaStack: run tracking unavailable; execution continues.\n'
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function init(root, metadata) {
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', ...(metadata ? ['--separate-git-dir', metadata] : []))
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'initial')
}
async function env(patch, work) {
  const before = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]))
  const apply = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try { apply(patch); return await work() } finally { apply(before) }
}
async function fixture(work) {
  const base = fs.mkdtempSync(join(tmpdir(), 'run-git-discovery-'))
  try {
    await env({ PANDASTACK_RUNS_DIR: undefined }, () => work({ base, workflow: 'autobuild', backend: 'codex', settings: {} }))
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
}
async function capture(work) {
  const original = process.stderr.write
  let warnings = ''
  process.stderr.write = text => { warnings += String(text); return true }
  try { return { value: await work(), warnings } } finally { process.stderr.write = original }
}
async function refused(options, absent, thrown) {
  let calls = 0
  const before = currentRunId()
  const result = await capture(async () => {
    const invoke = () => withTrackedRun(options, async () => {
      calls++
      assert.equal(currentRunId(), null)
      assert.equal(fs.existsSync(absent), false, 'no parent directory created before work')
      if (thrown) throw thrown
      return 23
    })
    if (thrown) await assert.rejects(invoke, error => error === thrown)
    else assert.equal(await invoke(), 23)
  })
  assert.equal(calls, 1)
  assert.equal(result.warnings, warning)
  assert.equal(fs.existsSync(absent), false)
  assert.equal(currentRunId(), before)
}
async function recorded(options, location) {
  const result = await capture(() => withTrackedRun(options, async () => {
    assert.equal(currentRunId(), options.runId)
    return 130
  }))
  assert.deepEqual(result, { value: 130, warnings: '' })
  const store = createRunStore(location), record = store.readRun(options.runId)
  assert.equal(record.repo, options.repo)
  assert.equal(record.runnerRoot, options.runnerRoot)
  assert.deepEqual(store.readEvents(options.runId).map(e => e.type).sort(), ['cancelled', 'started'])
  assert.equal(currentRunId(), null)
  return record
}

await test('Git root bytes protect both roles and survive external/default tracking without a trimmed sibling', () => fixture(async o => {
  const normal = join(o.base, 'normal'); init(normal)
  let index = 0
  for (const suffix of [' ', '\t', '\r', '\n', ' \t\r\n\n']) {
    const trimmed = join(o.base, `tree-${index++}`), actual = trimmed + suffix
    init(actual)
    assert.equal(git(actual, 'rev-parse', '--show-toplevel'), actual + '\n')
    for (const role of ['repo', 'runnerRoot']) {
      const options = { ...o, repo: normal, runnerRoot: normal, [role]: actual }
      fs.mkdirSync(trimmed)
      const absent = join(actual, 'uncreated')
      await refused({ ...options, storeDir: join(absent, 'records') }, absent)
      assert.deepEqual(fs.readdirSync(trimmed), [])
      fs.rmdirSync(trimmed)
      const external = join(o.base, 'external')
      const record = await recorded({ ...options, storeDir: external, runId: `${role}-${index}` }, external)
      assert.equal(record.revision, git(options.repo, 'rev-parse', 'HEAD').trim())
      assert.equal(record.runnerRevision, git(options.runnerRoot, 'rev-parse', 'HEAD').trim())
      const location = git(options.repo, 'rev-parse', '--path-format=absolute', '--git-path', 'pandastack-runs').slice(0, -1)
      await recorded({ ...options, runId: `default-${role}-${index}` }, location)
      assert.equal(fs.existsSync(trimmed), false)
    }
    assert.equal(git(actual, 'status', '--porcelain'), '')
  }
}))

await test('linked roots and separate metadata owners preserve exact Git path bytes', () => fixture(async o => {
  const main = join(o.base, 'main'); init(main)
  for (const [i, suffix] of [' ', '\t', '\r', '\n'].entries()) {
    const linked = join(o.base, `linked-${i}`) + suffix
    git(main, 'worktree', 'add', '-qb', `linked-${i}`, linked)
    assert.equal(git(linked, 'rev-parse', '--show-toplevel'), linked + '\n')
    const location = git(linked, 'rev-parse', '--absolute-git-dir').slice(0, -1) + '/pandastack-runs'
    await recorded({ ...o, repo: linked, runnerRoot: main, runId: `linked-${i}` }, location)
  }
  for (const [i, suffix] of [' ', '\t'].entries()) {
    const repo = join(o.base, `separate-${i}`), owner = join(o.base, `owner-${i}`) + suffix
    init(repo, owner)
    assert.equal(git(repo, 'rev-parse', '--absolute-git-dir'), owner + '\n')
    await recorded({ ...o, repo, runnerRoot: main, runId: `owner-${i}` }, join(owner, 'pandastack-runs'))
  }
}))

await test('invalid ancestor metadata refuses publication and preserves nested context and work errors', () => fixture(async o => {
  const repo = join(o.base, 'valid'); init(repo)
  const external = join(o.base, 'parent-store')
  await withTrackedRun({ ...o, repo, runnerRoot: repo, storeDir: external, runId: 'parent' }, async () => {
    for (const kind of ['pointer', 'file', 'directory', 'symlink']) {
      const damaged = join(o.base, kind), nested = join(damaged, 'deep', 'nested')
      fs.mkdirSync(nested, { recursive: true })
      const entry = join(damaged, '.git'), missing = join(o.base, `missing-${kind}`)
      if (kind === 'pointer') fs.writeFileSync(entry, `gitdir: ${missing}\n`)
      if (kind === 'file') fs.writeFileSync(entry, 'invalid metadata\n')
      if (kind === 'directory') fs.mkdirSync(entry)
      if (kind === 'symlink') fs.symlinkSync(missing, entry)
      const before = fs.lstatSync(entry)
      for (const role of ['repo', 'runnerRoot']) {
        const absent = join(o.base, `absent-${kind}-${role}`)
        await refused({ ...o, repo, runnerRoot: repo, [role]: nested, storeDir: join(absent, 'records') }, absent, Error('PRIVATE_WORK_DETAIL'))
        assert.equal(currentRunId(), 'parent')
      }
      assert.equal(fs.lstatSync(entry).ino, before.ino)
      assert.equal(fs.existsSync(missing), false)
    }
    return 0
  })
  assert.equal(currentRunId(), null)
  assert.deepEqual(createRunStore(external).listRuns().map(r => r.id), ['parent'])
}))

await test('failed caller-controlled discovery refuses without changing caller environment', () => fixture(async o => {
  const repo = join(o.base, 'project'), nested = join(repo, 'packages', 'app'); init(repo)
  fs.mkdirSync(nested, { recursive: true })
  for (const [key, value] of Object.entries({ GIT_DIR: join(o.base, 'missing'), GIT_CEILING_DIRECTORIES: repo })) {
    await env({ [key]: value }, async () => {
      const absent = join(o.base, key)
      await refused({ ...o, repo: nested, runnerRoot: repo, storeDir: join(absent, 'records') }, absent)
      assert.equal(process.env[key], value)
    })
  }
  // Successful controlled discovery still uses Git's actual metadata owner.
  const location = join(repo, '.git', 'pandastack-runs')
  await env({ GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo }, () => recorded({ ...o, repo, runnerRoot: repo, runId: 'controlled' }, location))
}))

await test('ancestry I/O uncertainty refuses before mutation', () => fixture(async o => {
  const repo = join(o.base, 'plain', 'nested'), runnerRoot = join(o.base, 'runner')
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(runnerRoot)
  const original = fs.lstatSync
  let injected = 0
  fs.lstatSync = function (path, ...args) {
    if (path === join(o.base, 'plain', '.git')) { injected++; throw Object.assign(Error('PRIVATE_IO_DETAIL'), { code: 'EACCES' }) }
    return original.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const absent = join(o.base, 'uncreated')
    await refused({ ...o, repo, runnerRoot, storeDir: join(absent, 'records') }, absent)
    assert.equal(injected, 1)
  } finally { fs.lstatSync = original; syncBuiltinESMExports() }
}))

await test('genuine non-Git directories retain external tracking with unknown revisions', () => fixture(async o => {
  const repo = join(o.base, 'plain', 'nested'), runnerRoot = join(o.base, 'runner')
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(runnerRoot)
  const storeDir = join(o.base, 'external')
  const record = await recorded({ ...o, repo, runnerRoot, storeDir, runId: 'nongit' }, storeDir)
  assert.equal(record.revision, null); assert.equal(record.runnerRevision, null)
}))

await test('malformed caller config never reaches absence fallback even with diagnostic words in its filename', () => fixture(async o => {
  const repo = join(o.base, 'project'), runnerRoot = join(o.base, 'runner')
  fs.mkdirSync(repo); fs.mkdirSync(runnerRoot)
  for (const [index, filename] of ['ordinary.config', 'not a git repository.config',
    'fatal: not a git repository (or any of the parent directories): .git\n'].entries()) {
    const config = join(o.base, filename), contents = '[broken\n'
    fs.writeFileSync(config, contents)
    const patch = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
    const before = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]))
    await env(patch, async () => {
      assert.throws(() => git(repo, 'rev-parse', '--show-toplevel'), error => {
        assert.equal(error.status, 128)
        assert.equal(error.stdout, '')
        assert.equal(error.stderr, `fatal: bad config line 1 in file ${config}\n`)
        return true
      })
      // Assert classification directly at the ancestry boundary so ambient
      // metadata cannot hide a mistaken non-Git fallback in this regression.
      const original = fs.lstatSync
      let ancestryChecks = 0
      fs.lstatSync = function (path, ...args) {
        if (path === join(repo, '.git')) ancestryChecks++
        return original.call(this, path, ...args)
      }
      syncBuiltinESMExports()
      try {
        const absent = join(o.base, `absent-config-${index}`)
        await refused({ ...o, repo, runnerRoot, storeDir: join(absent, 'records') }, absent, Error('PRIVATE_WORK_DETAIL'))
        assert.equal(ancestryChecks, 0, 'config error must be rejected before absence ancestry checks')
      } finally { fs.lstatSync = original; syncBuiltinESMExports() }
      assert.equal(process.env.GIT_CONFIG_GLOBAL, config)
    })
    for (const [key, value] of Object.entries(before)) assert.equal(process.env[key], value)
    assert.equal(fs.readFileSync(config, 'utf8'), contents)
  }
}))

await test('valid explicit caller config preserves successful discovery and recording', () => fixture(async o => {
  const repo = join(o.base, 'project'); init(repo)
  const config = join(o.base, 'not a git repository.config')
  fs.writeFileSync(config, '')
  const previous = process.env.GIT_CONFIG_GLOBAL
  await env({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, async () => {
    const location = join(repo, '.git', 'pandastack-runs')
    const record = await recorded({ ...o, repo, runnerRoot: repo, runId: 'valid-config' }, location)
    assert.equal(record.revision, git(repo, 'rev-parse', 'HEAD').trim())
    assert.equal(process.env.GIT_CONFIG_GLOBAL, config)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })
  assert.equal(process.env.GIT_CONFIG_GLOBAL, previous)
  assert.equal(fs.readFileSync(config, 'utf8'), '')
}))
