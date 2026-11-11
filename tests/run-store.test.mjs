import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

const run = (id = 'run-1') => ({ schemaVersion: 1, id, repo: '/tmp/project', revision: null,
  runnerRoot: '/tmp/runner', runnerRevision: null, workflow: 'autobuild', backend: 'codex',
  parentRunId: null, startedAt: '2026-11-09T12:00:00Z', settings: {} })
const event = (id = 'event-1', runId = 'run-1', at = '2026-11-09T12:00:00Z') => ({
  schemaVersion: 1, id, runId, type: 'started', at, exitCode: null,
})
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'run-store-'))
  try { await work(createRunStore(join(dir, 'store')), dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const rejects = (fn, code) => assert.throws(fn, { code })

await test('store is lazy and rejects invalid IDs and records before filesystem access', () => fixture((s, dir) => {
  for (const id of ['../escape', '', 'a/b', null, 42, 'a\n']) {
    rejects(() => s.readRun(id), 'INVALID_RECORD')
    rejects(() => s.readEvents(id), 'INVALID_RECORD')
    rejects(() => s.putRun({ ...run(), id }), 'INVALID_RECORD')
    rejects(() => s.appendEvent({ ...event(), runId: id }), 'INVALID_RECORD')
  }
  rejects(() => s.putRun({ ...run(), prompt: 'SECRET' }), 'INVALID_RECORD')
  rejects(() => s.appendEvent({ ...event(), output: 'SECRET' }), 'INVALID_RECORD')
  assert.equal(s.readRun('missing'), null)
  assert.deepEqual(s.listRuns(), [])
  rejects(() => s.readEvents('missing'), 'NOT_FOUND')
  rejects(() => s.appendEvent(event()), 'NOT_FOUND')
  assert.equal(existsSync(join(dir, 'store')), false)
}))

await test('immutable replay ignores property order, filters exactly, and event IDs belong to runs', () => fixture(s => {
  s.putRun(run('z')); s.putRun(run()); s.putRun({ ...run('A'), backend: 'claude', parentRunId: 'z' })
  assert.deepEqual(s.putRun(Object.fromEntries(Object.entries(run()).reverse())), { created: false })
  rejects(() => s.putRun({ ...run(), settings: { model: 'changed' } }), 'CONFLICT')
  assert.deepEqual(s.listRuns().map(r => r.id), ['A', 'run-1', 'z'])
  assert.deepEqual(s.listRuns({ parentRunId: null, repo: '/tmp/project', backend: 'codex' }).map(r => r.id), ['run-1', 'z'])
  assert.deepEqual(s.listRuns({ repo: '/tmp/proj' }), [])
  s.appendEvent(event('z')); s.appendEvent(event('a')); s.appendEvent(event('A')); s.appendEvent(event('a-')); s.appendEvent(event('a_')); s.appendEvent(event('first', 'run-1', '2026-11-09T11:00:00Z'))
  assert.deepEqual(s.appendEvent(event('a')), { created: false })
  assert.deepEqual(s.appendEvent(event('a', 'z')), { created: true })
  rejects(() => s.appendEvent({ ...event('a'), type: 'failed', exitCode: 1 }), 'CONFLICT')
  assert.deepEqual(s.readEvents('run-1').map(e => e.id), ['first', 'A', 'a', 'a-', 'a_', 'z'])
  assert.deepEqual(s.readRun('run-1'), run())
  const read = s.readRun('run-1'); read.settings.model = 'changed'
  assert.deepEqual(s.readRun('run-1'), run())
}))

await test('corrupt committed data and mismatched filenames fail while abandoned temp files are ignored', () => fixture((s, dir) => {
  s.putRun(run()); s.appendEvent(event())
  const events = join(dir, 'store/events/run-1')
  writeFileSync(join(events, '.tmp-abandoned'), '{partial')
  assert.equal(s.readEvents('run-1').length, 1)
  for (const content of ['{broken', JSON.stringify(event('other')), JSON.stringify(event('event-1', 'other')), JSON.stringify({ ...event(), extra: true })]) {
    writeFileSync(join(events, 'event-1.json'), content)
    rejects(() => s.readEvents('run-1'), 'CORRUPT')
    rejects(() => s.appendEvent(event()), 'CORRUPT')
  }
  writeFileSync(join(dir, 'store/runs/run-1.json'), JSON.stringify(run('other')))
  rejects(() => s.readRun('run-1'), 'CORRUPT')
  rejects(() => s.listRuns({ repo: '/unrelated' }), 'CORRUPT')
}))

await test('symlinked roots, ancestor directories, event directories and event files are refused', () => fixture((s, dir) => {
  const outside = join(dir, 'outside'); mkdirSync(outside)
  const alias = join(dir, 'alias'); symlinkSync(outside, alias)
  const unsafe = createRunStore(join(alias, 'nested'))
  rejects(() => unsafe.putRun(run()), 'CORRUPT')
  rejects(() => unsafe.listRuns(), 'CORRUPT')
  rejects(() => unsafe.readRun('../invalid'), 'INVALID_RECORD')
  assert.deepEqual(readdirSync(outside), [])
  s.putRun(run())
  symlinkSync(outside, join(dir, 'store/events'))
  rejects(() => s.appendEvent(event()), 'CORRUPT')
  rejects(() => s.readEvents('run-1'), 'CORRUPT')
  rmSync(join(dir, 'store/events')); mkdirSync(join(dir, 'store/events/run-1'), { recursive: true })
  const target = join(outside, 'event.json'); writeFileSync(target, JSON.stringify(event()))
  symlinkSync(target, join(dir, 'store/events/run-1/event-1.json'))
  rejects(() => s.readEvents('run-1'), 'CORRUPT')
  rejects(() => s.appendEvent(event()), 'CORRUPT')
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify(event()))
}))

await test('independent writers preserve every run and event and arbitrate conflicting publication', () => fixture(async (s, dir) => {
  const moduleUrl = new URL('../core/skills/run-records/store.mjs', import.meta.url).href
  const code = `import {createRunStore} from ${JSON.stringify(moduleUrl)};
    const s=createRunStore(process.argv[1]); const r=JSON.parse(process.argv[2]);
    s.putRun(r); s.putRun({...r,id:process.argv[3]});
    s.appendEvent(JSON.parse(process.argv[4]));
    try { s.appendEvent({...JSON.parse(process.argv[4]), id:'contested', at:process.argv[5]}); }
    catch(e) { if(e.code!=='CONFLICT') throw e; }`
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, join(dir, 'store'),
      JSON.stringify(run()), `run-${i + 2}`, JSON.stringify(event(`event-${i}`)), `2026-11-09T12:00:0${i}Z`], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })))
  assert.equal(s.listRuns().length, 9)
  assert.equal(s.readEvents('run-1').length, 9)
  assert.ok(readdirSync(join(dir, 'store/runs')).every(name => name.endsWith('.json')))
  assert.ok(readdirSync(join(dir, 'store/events/run-1')).every(name => name.endsWith('.json')))
}))

await test('failed atomic publication leaves no committed or temporary record and exposes only safe errors', () => fixture(async (s, dir) => {
  const fs = (await import('node:fs')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const original = fs.linkSync
  try {
    fs.linkSync = () => { throw Object.assign(new Error('SECRET filesystem detail'), { code: 'EIO' }) }
    syncBuiltinESMExports()
    assert.throws(() => s.putRun(run()), e => e.code === 'IO_ERROR' && !e.message.includes('SECRET'))
    assert.deepEqual(readdirSync(join(dir, 'store/runs')), [])
    assert.equal(s.readRun('run-1'), null)
  } finally { fs.linkSync = original; syncBuiltinESMExports() }
  assert.deepEqual(s.putRun(run()), { created: true })
}))

await test('event ordering preserves fractional precision and compares equivalent timestamps by ID', () => fixture(s => {
  s.putRun(run())
  s.appendEvent(event('a', 'run-1', '2026-11-09T12:00:00.0002Z'))
  s.appendEvent(event('z', 'run-1', '2026-11-09T12:00:00.0001Z'))
  s.appendEvent(event('b', 'run-1', '2026-11-09T12:00:00Z'))
  s.appendEvent(event('A', 'run-1', '2026-11-09T12:00:00.000Z'))
  s.appendEvent(event('d', 'run-1', '2026-11-09T12:00:00.10Z'))
  s.appendEvent(event('c', 'run-1', '2026-11-09T12:00:00.1Z'))
  assert.deepEqual(s.readEvents('run-1').map(e => e.id), ['A', 'b', 'z', 'a', 'c', 'd'])
}))
