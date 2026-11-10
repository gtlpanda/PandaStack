import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { syncBuiltinESMExports } from 'node:module'
import { test, run } from '../../../scripts/workflow-harness.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'

const code = expected => error => error.code === expected && error.message === `Audit journal: ${expected}`
async function fixture(check, limit = 5) {
  const runDir = fs.mkdtempSync(join(tmpdir(), 'dispatch-journal-'))
  const meta = { version: 1, run_id: 'ordinary-run', repo: 'fixture', target: 'fixture',
    source_ref: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false }, run_status: 'in_progress' }
  const metadata = join(runDir, 'run-metadata.json')
  fs.writeFileSync(metadata, JSON.stringify(meta))
  fs.writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'init', wave: 0, critic_kind: null }))
  const handles = []
  const open = () => { const h = openAuditJournal({ runDir, invocationLimit: limit }); handles.push(h); return h }
  try { await check({ runDir, metadata, meta, open, read: () => readAuditJournal(runDir), dir: join(runDir, 'native-dispatch') }) }
  finally { for (const h of handles) h.close(); fs.rmSync(runDir, { recursive: true, force: true }) }
}

await test('canonical replay and detached workflow result preserve complete inputs including special keys', () => fixture(async x => {
  const h = x.open()
  const input = JSON.parse('{"z":[1,true,null],"__proto__":{"inert":1},"a":2}')
  h.prepare({ id: 'a', input })
  assert.equal(h.prepare({ id: 'a', input: { a: 2, ...input } }).created, false)
  const out = await run(async agent => agent('inert', { agentType: 'leaf' }), { leaf: [async () => {
    const result = await h.execute('a', async got => { got.z.push(4); return { outcome: 'returned', result: got } })
    assert.equal(x.read().rows[0].state, 'returned')
    return result.result
  }] })
  out.result.z.push(5)
  assert.deepEqual(x.read().rows[0].input, input)
  assert.equal(x.read().rows[0].result.z.length, 4)
}))

await test('proxy, getter, hook, cycle and sparse input are refused without execution or mutation', () => fixture(x => {
  const h = x.open(), before = x.read(); let calls = 0
  const hook = { toJSON() { calls++; return {} } }
  const accessor = Object.defineProperty({}, 'x', { get() { calls++ } })
  const proxy = new Proxy({}, { ownKeys() { calls++; return [] }, getPrototypeOf() { calls++; return null } })
  const cycle = {}; cycle.x = cycle
  for (const input of [hook, accessor, proxy, cycle, { x: [, 1] }, { x: new Date() }, { x: 1n }, { [Symbol()]: 1 }]) {
    assert.throws(() => h.prepare({ id: 'a', input }), code('INVALID_JOURNAL_INPUT'))
  }
  assert.equal(calls, 0); assert.deepEqual(x.read(), before)
}))

await test('UTF8 byte bounds and invalid failure envelopes retain unknown charges', () => fixture(async x => {
  const h = x.open()
  assert.throws(() => h.prepare({ id: 'large', input: { text: 'é'.repeat(600000) } }), code('INPUT_TOO_LARGE'))
  for (const [id, result] of [['a', { code: 'bad private text' }], ['b', { code: 'FAILED', extra: true }]]) {
    h.prepare({ id, input: {} })
    await assert.rejects(h.execute(id, async () => ({ outcome: 'failed', result })), code('DISPATCH_UNCERTAIN'))
  }
  assert.equal(x.read().heldCalls, 2)
}))

await test('live metadata terminal and full identity changes block admission and execution', () => fixture(async x => {
  const h = x.open(); h.prepare({ id: 'a', input: {} }); const before = x.read(); let calls = 0
  for (const [change, expected] of [[{ repo: 'changed' }, 'CONFLICT'], [{ run_status: 'complete' }, 'TERMINAL_RUN'],
    [{ source_ref: { ...x.meta.source_ref, tree: 'c'.repeat(40) } }, 'CONFLICT'], [{ version: 2 }, 'CORRUPT']]) {
    fs.writeFileSync(x.metadata, JSON.stringify({ ...x.meta, ...change }))
    try {
      assert.throws(() => h.prepare({ id: 'b', input: {} }), code(expected))
      await assert.rejects(h.execute('a', () => { calls++ }), code(expected))
    } finally { fs.writeFileSync(x.metadata, JSON.stringify(x.meta)) }
  }
  assert.equal(calls, 0); assert.deepEqual(x.read(), before)
}))

await test('static unsafe private directory refuses without mode adoption', () => fixture(x => {
  fs.mkdirSync(x.dir, { mode: 0o755 }); fs.chmodSync(x.dir, 0o755)
  assert.throws(x.open, code('CORRUPT'))
  assert.equal(fs.statSync(x.dir).mode & 0o777, 0o755)
  assert.deepEqual(fs.readdirSync(x.dir), [])
}))

await test('private files, read-only inspection and closed operations have exact lifecycle', () => fixture(async x => {
  const h = x.open(); h.prepare({ id: 'a', input: {} }); h.close(); h.close()
  const before = fs.readdirSync(x.dir).map(n => [n, fs.readFileSync(join(x.dir, n)), fs.statSync(join(x.dir, n)).mtimeMs])
  assert.equal(x.read().heldCalls, 1)
  assert.deepEqual(fs.readdirSync(x.dir).map(n => [n, fs.readFileSync(join(x.dir, n)), fs.statSync(join(x.dir, n)).mtimeMs]), before)
  assert.equal(fs.statSync(x.dir).mode & 0o777, 0o700)
  for (const n of fs.readdirSync(x.dir)) assert.equal(fs.statSync(join(x.dir, n)).mode & 0o777, 0o600)
  assert.throws(() => h.cancelPrepared('a'), code('CLOSED'))
  await assert.rejects(h.execute('a', () => {}), code('CLOSED'))
}))

await test('dispatched persisted rows become uncertain on clean reopen without callback', () => fixture(async x => {
  let h = x.open(); h.prepare({ id: 'a', input: {} }); h.close()
  const db = new DatabaseSync(join(x.dir, 'journal.sqlite'))
  db.prepare("UPDATE attempts SET state='dispatched' WHERE id='a'").run(); db.close()
  h = x.open(); assert.equal(x.read().rows[0].state, 'uncertain')
  await assert.rejects(h.execute('a', () => assert.fail('no dispatch')), code('DISPATCH_UNCERTAIN'))
}))

await test('malformed persisted row refuses read and open, releasing only newly acquired owner', () => fixture(x => {
  const h = x.open(); h.prepare({ id: 'a', input: {} }); h.close()
  const db = new DatabaseSync(join(x.dir, 'journal.sqlite'))
  db.prepare("UPDATE attempts SET state='invented' WHERE id='a'").run(); db.close()
  assert.throws(x.read, code('CORRUPT')); assert.throws(x.open, code('CORRUPT'))
  assert.equal(fs.existsSync(join(x.dir, 'owner.lock')), false)
}))

await test('synthetic completion persistence failure never acknowledges success or repeats callback', () => fixture(async x => {
  const h = x.open(); h.prepare({ id: 'a', input: {} }); let calls = 0
  const original = DatabaseSync.prototype.exec
  try {
    await assert.rejects(h.execute('a', async () => {
      calls++
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === 'COMMIT') throw new Error('private synthetic I/O detail')
        return original.call(this, sql)
      }
      return { outcome: 'returned', result: 'retained only if committed' }
    }), code('IO_ERROR'))
  } finally { DatabaseSync.prototype.exec = original }
  assert.equal(x.read().rows[0].state, 'dispatched')
  await assert.rejects(h.execute('a', () => { calls++ }), code('DISPATCH_UNCERTAIN'))
  assert.equal(calls, 1)
}))

await test('synthetic initialization I/O error releases new lease without raw diagnostics', () => fixture(x => {
  const original = fs.fsyncSync
  fs.fsyncSync = () => { throw new Error('private synthetic I/O detail') }; syncBuiltinESMExports()
  try { assert.throws(x.open, code('IO_ERROR')) }
  finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(join(x.dir, 'owner.lock')), false)
  x.open()
}))

await test('sibling receipts and more than 1MiB combined bodies survive reopen without callbacks', () => fixture(async x => {
  let h = x.open(), calls = 0
  for (const id of ['good', 'failed', 'unknown']) h.prepare({ id, input: { text: 'a'.repeat(600000) } })
  await h.execute('good', async () => ({ outcome: 'returned', result: { text: 'b'.repeat(600000) } }))
  await h.execute('failed', async () => ({ outcome: 'failed', result: { code: 'REMOTE_FAILED' } }))
  await assert.rejects(h.execute('unknown', () => { throw new Error('private detail') }), code('DISPATCH_UNCERTAIN'))
  h.close(); h = x.open()
  assert.equal((await h.execute('good', () => { calls++ })).result.text.length, 600000)
  assert.equal((await h.execute('failed', () => { calls++ })).outcome, 'failed')
  await assert.rejects(h.execute('unknown', () => { calls++ }), code('DISPATCH_UNCERTAIN'))
  assert.equal(calls, 0)
  assert.deepEqual([x.read().settledCalls, x.read().heldCalls, x.read().available], [2, 1, 2])
}))

await test('same-process busy owner and duplicate execution retain ownership until callback settles', () => fixture(async x => {
  const h = x.open(); h.prepare({ id: 'a', input: {} })
  let finish
  const pending = h.execute('a', () => new Promise(resolve => { finish = resolve }))
  try {
    assert.throws(x.open, code('OWNER_BUSY')); assert.throws(() => h.close(), code('BUSY'))
    await assert.rejects(h.execute('a', () => assert.fail('duplicate')), code('DISPATCH_UNCERTAIN'))
    assert.equal(x.read().rows[0].state, 'dispatched')
  } finally { finish({ outcome: 'returned', result: null }); await pending }
  h.close(); x.open()
}))

await test('zero budget, prepared cancellation and stable creation order preserve capacity', () => fixture(async x => {
  let h = x.open(); h.prepare({ id: 'a', input: {} }); h.prepare({ id: 'b', input: {} })
  assert.deepEqual(h.cancelPrepared('a'), { changed: true }); h.prepare({ id: 'a', input: {} })
  assert.deepEqual(x.read().rows.map(r => r.id), ['b', 'a'])
  await h.execute('a', () => ({ outcome: 'returned', result: 1 }))
  assert.throws(() => h.cancelPrepared('a'), code('CONFLICT'))
  await assert.rejects(h.execute('missing', () => {}), code('NOT_FOUND'))
  h.close()
  assert.throws(() => openAuditJournal({ runDir: x.runDir, invocationLimit: 9 }), code('CONFLICT'))
  h = x.open(); assert.equal(x.read().rows.length, 2)
  await fixture(y => { const z = y.open(); assert.throws(() => z.prepare({ id: 'a', input: {} }), code('BUDGET_EXHAUSTED')) }, 0)
}))

await test('row admission cap refuses without mutation and corrupt count refuses on read', () => fixture(x => {
  const h = x.open(); h.close()
  const db = new DatabaseSync(join(x.dir, 'journal.sqlite'))
  db.exec('BEGIN')
  const insert = db.prepare("INSERT INTO attempts(id,input,state,result) VALUES (?,'{}','prepared',NULL)")
  for (let i = 0; i < 10000; i++) insert.run(`leaf${i}`)
  db.exec('COMMIT'); db.close()
  const next = x.open()
  assert.throws(() => next.prepare({ id: 'overflow', input: {} }), code('INPUT_TOO_LARGE'))
  assert.equal(x.read().rows.length, 10000)
  next.close()
  const changed = new DatabaseSync(join(x.dir, 'journal.sqlite'))
  changed.prepare("INSERT INTO attempts(id,input,state,result) VALUES ('extra','{}','prepared',NULL)").run(); changed.close()
  assert.throws(x.read, code('CORRUPT'))
}, 10001))

await test('pure aggregate accounting reserves transitions and bounds content above 1GiB', async () => {
  const { contentBytes, TOTAL_LIMIT, BODY_LIMIT } = await import('../skills/security-audit/journal-data.mjs')
  const body = JSON.stringify('a'.repeat(BODY_LIMIT - 2))
  const row = { id: 'a', input: body, state: 'prepared', result: null }
  const before = contentBytes({}, 2000, [row])
  for (const state of ['dispatched', 'uncertain']) assert.equal(contentBytes({}, 2000, [{ ...row, state }]), before)
  // The pending reserve exceeds both possible state deltas and all counter digits.
  const terminal = { ...row, state: 'returned', result: 'null' }
  assert.ok(before - contentBytes({}, 2000, [terminal]) > 60)
  assert.ok(contentBytes({}, 2000, Array(1024).fill(row)) > TOTAL_LIMIT)
  assert.ok(contentBytes({}, 2000, Array(1023).fill(row)) < TOTAL_LIMIT)
})

await test('partial own lease write failure cleans up only its newly created lock', () => fixture(x => {
  const original = fs.writeFileSync
  fs.writeFileSync = (path, ...args) => {
    if (typeof path === 'number') { original(path, 'partial'); throw new Error('private I/O detail') }
    return original(path, ...args)
  }; syncBuiltinESMExports()
  try { assert.throws(x.open, code('IO_ERROR')) }
  finally { fs.writeFileSync = original; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(join(x.dir, 'owner.lock')), false)
  x.open()
}))

await test('static symlink database and unsafe modes refuse without touching existing entries', () => fixture(x => {
  let h = x.open(); h.close()
  const file = join(x.dir, 'journal.sqlite'), original = fs.readFileSync(file)
  fs.chmodSync(file, 0o644)
  try { assert.throws(x.open, code('CORRUPT')); assert.throws(x.read, code('CORRUPT')); assert.equal(fs.statSync(file).mode & 0o777, 0o644) }
  finally { fs.chmodSync(file, 0o600) }
  assert.deepEqual(fs.readFileSync(file), original)
  h = x.open(); h.close()
  // Static owned fixture: no replacement during journal access, no race claim.
  const target = join(x.runDir, 'ordinary-database')
  fs.renameSync(file, target); fs.symlinkSync(target, file)
  try { assert.throws(x.open, code('CORRUPT')); assert.deepEqual(fs.readFileSync(target), original) }
  finally { fs.unlinkSync(file); fs.renameSync(target, file) }
}))

await test('metadata operational read failure is IO_ERROR; no lock is acquired', () => fixture(x => {
  const original = fs.readFileSync
  fs.readFileSync = (path, ...args) => {
    if (path === join(x.runDir, 'stage-state.json')) throw Object.assign(new Error('private path'), { code: 'EACCES' })
    return original(path, ...args)
  }; syncBuiltinESMExports()
  try { assert.throws(x.open, code('IO_ERROR')) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(x.dir), false)
  x.open()
}))

await test('unsafe persisted integer counters are corruption rather than operational errors', () => fixture(x => {
  const h = x.open(); h.close()
  const db = new DatabaseSync(join(x.dir, 'journal.sqlite'))
  db.exec('UPDATE header SET invocation_limit=9223372036854775807'); db.close()
  assert.throws(x.read, code('CORRUPT')); assert.throws(x.open, code('CORRUPT'))
  assert.equal(fs.existsSync(join(x.dir, 'owner.lock')), false)
}))

await test('oversized or accessor transport results persist uncertainty with no error text or re-dispatch', () => fixture(async x => {
  const h = x.open(); let getters = 0
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getters++; return 'private text' } })
  for (const [id, result] of [['large', 'x'.repeat(1024 * 1024)], ['accessor', accessor]]) {
    h.prepare({ id, input: {} })
    await assert.rejects(h.execute(id, () => ({ outcome: 'returned', result })), code('DISPATCH_UNCERTAIN'))
    await assert.rejects(h.execute(id, () => assert.fail('no replay')), code('DISPATCH_UNCERTAIN'))
  }
  assert.equal(getters, 0)
  assert.deepEqual(x.read().rows.map(r => [r.state, r.result]), [['uncertain', null], ['uncertain', null]])
}))

await test('invalid identity refuses before private storage creation and does not amend metadata', () => fixture(x => {
  for (const patch of [{ run_id: '' }, { version: 2 }, { source_ref: { ...x.meta.source_ref, tree: undefined } },
    { source_ref: { ...x.meta.source_ref, dirty: 'false' } }, { source_ref: { ...x.meta.source_ref, uncommitted: { tracked: -1, untracked: 0 } } }]) {
    const bytes = JSON.stringify({ ...x.meta, ...patch })
    fs.writeFileSync(x.metadata, bytes)
    assert.throws(x.open, code('CORRUPT')); assert.equal(fs.existsSync(x.dir), false)
    assert.equal(fs.readFileSync(x.metadata, 'utf8'), bytes)
  }
  fs.writeFileSync(x.metadata, JSON.stringify(x.meta))
  x.open()
}))
