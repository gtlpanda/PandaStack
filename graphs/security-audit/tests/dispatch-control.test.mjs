import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from '../../../scripts/workflow-harness.mjs'
import * as journal from '../skills/security-audit/dispatch-journal.mjs'
import * as report from '../skills/security-audit/audit-report.mjs'
import { META, STATE } from './report-fixtures.mjs'

const code = expected => e => e?.code === expected
// Inert owning artifacts, actual journal and actual publisher; no source export,
// target execution, provider, process, race or injected freshness authority.
async function fixture(check, { maximum = 4, grant = 2, legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-control-'))
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value))
  put('run-metadata.json', META({ run_status: 'in_progress' }))
  put('stage-state.json', STATE({ last: 'init', critic_kind: null }))
  let h = journal.openAuditJournal({ runDir: dir, invocationLimit: maximum })
  const inspect = () => {
    const db = new DatabaseSync(join(dir, 'native-dispatch/journal.sqlite'), { readOnly: true })
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version
      return { version, schema: db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
        header: db.prepare('SELECT * FROM header').get(),
        control: version === 2 ? JSON.parse(db.prepare('SELECT body FROM control').get().body) : null,
        history: version === 2 ? db.prepare('SELECT revision,body FROM control_history ORDER BY revision').all().map(r => ({ revision: r.revision, ...JSON.parse(r.body) })) : [] }
    } finally { db.close() }
  }
  const fresh = () => {
    const out = report.publishPartialReport(dir)
    assert.ok(['published', 'replayed'].includes(out.status), JSON.stringify(out))
    h.acknowledgeReport({ expectedRevision: h.getControl().revision })
    assert.equal(report.readPartialReport(dir).status, 'current')
    return out
  }
  try {
    if (!legacy) h.initControl({ initialGrant: grant })
    await check({ dir, put, get h() { return h }, fresh, inspect,
      reopen() { h.close(); h = journal.openAuditJournal({ runDir: dir, invocationLimit: maximum }); return h } })
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }) }
}

await test('control explicit opt-in is atomic, detached, immutable and persistent; legacy stays v1', () => fixture(x => {
  assert.equal(x.h.getControl(), null)
  assert.equal(journal.readAuditControl(x.dir), null)
  assert.equal(journal.readAuditBudgetEvidence(x.dir), null)
  const before = x.inspect()
  for (const initialGrant of [-1, 5, null, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => x.h.initControl({ initialGrant }), code('INVALID_CONTROL_INPUT'))
    assert.deepEqual(x.inspect(), before)
  }
  const control = x.h.initControl({ initialGrant: 2 })
  assert.deepEqual(control, { version: 1, revision: 1, maximum: 4, currentGrant: 2, blockers: ['report_stale'], acknowledgedGeneration: null })
  control.blockers.length = 0
  assert.equal(x.h.getControl().blockers.length, 1)
  const after = x.inspect()
  assert.equal(after.version, 2)
  assert.deepEqual(after.header, before.header)
  assert.deepEqual(after.schema.filter(r => /CREATE TABLE (header|attempts) /.test(r.sql)), before.schema)
  assert.throws(() => x.h.initControl({ initialGrant: 2 }), code('CONFLICT'))
  assert.deepEqual(x.reopen().getControl(), journal.readAuditControl(x.dir))
}, { legacy: true }))

await test('control current publication acknowledges without a digest cycle; grant changes stale it', () => fixture(x => {
  assert.throws(() => x.h.acknowledgeReport({ expectedRevision: 1 }), code('REPORT_NOT_CURRENT'))
  const first = x.fresh(), c = x.h.getControl()
  assert.equal(c.acknowledgedGeneration, first.generationKey)
  const before = report.partialReportContext(x.dir)
  x.h.pauseControl({ expectedRevision: c.revision, reason: 'paused_budget' })
  assert.deepEqual(report.partialReportContext(x.dir), before)
  x.h.adjustGrant({ expectedRevision: x.h.getControl().revision, currentGrant: 3, reason: 'operator_increase' })
  assert.equal(report.readPartialReport(x.dir).status, 'stale')
  assert.throws(() => x.h.acknowledgeReport({ expectedRevision: x.h.getControl().revision }), code('REPORT_NOT_CURRENT'))
  const next = x.fresh()
  assert.notEqual(next.generationKey, first.generationKey)
  assert.deepEqual(x.h.getControl().blockers, ['paused_budget'])
  const text = readFileSync(next.currentPath, 'utf8')
  assert.match(text, /Maximum invocations: 4/)
  assert.match(text, /Current authorized grant: 3/)
  assert.doesNotMatch(text, /paused_budget|acknowledgedGeneration|reservedHistorySlots/)
  assert.deepEqual(report.partialReportContext(x.dir).budgetEvidence, { version: 1, maximum: 4, currentGrant: 3 })
}))

await test('control CAS and no-op pauses validate inputs without hooks or mutation', () => fixture(x => {
  const before = x.inspect(); let hooks = 0
  for (const arg of [null, {}, { expectedRevision: 1, reason: 'other' }, { expectedRevision: 0, reason: 'report_stale' },
    new Proxy({}, { ownKeys() { hooks++; throw Error('trap') } }),
    { get expectedRevision() { hooks++; return 1 }, reason: 'report_stale' }]) {
    assert.throws(() => x.h.pauseControl(arg), code('INVALID_CONTROL_INPUT'))
  }
  assert.equal(hooks, 0)
  assert.equal(x.h.pauseControl({ expectedRevision: 1, reason: 'report_stale' }).revision, 1)
  assert.throws(() => x.h.pauseControl({ expectedRevision: 2, reason: 'report_stale' }), code('CONFLICT'))
  assert.deepEqual(x.inspect(), before)
  assert.throws(() => x.h.adjustGrant({ expectedRevision: 1, currentGrant: 3, reason: 'operator_increase' }), code('CONTROL_BUSY'))
  x.h.pauseControl({ expectedRevision: 1, reason: 'paused_budget' })
  for (const currentGrant of [2, 1, 5, NaN]) assert.throws(() => x.h.adjustGrant({ expectedRevision: 2, currentGrant, reason: 'operator_increase' }), code('INVALID_CONTROL_INPUT'))
}))

await test('control exhausted reservation persists pause without a row and does not double charge dispatch', () => fixture(async x => {
  x.fresh()
  const rev = x.h.getControl().revision
  x.h.prepare({ id: 'a', input: {} })
  x.h.prepare({ id: 'b', input: {} })
  assert.equal(x.h.getControl().revision, rev)
  assert.equal(x.inspect().control.reservedHistorySlots, 2)
  await x.h.execute('a', () => ({ outcome: 'returned', result: 'full grant dispatch' }))
  x.fresh()
  assert.throws(() => x.h.prepare({ id: 'c', input: {} }), code('BUDGET_EXHAUSTED'))
  assert.deepEqual(x.h.getControl().blockers, ['paused_budget'])
  assert.equal(journal.readAuditJournal(x.dir).rows.length, 2)
  assert.equal(x.h.prepare({ id: 'a', input: {} }).created, false)
  assert.throws(() => x.h.prepare({ id: 'a', input: { changed: true } }), code('CONFLICT'))
  await assert.rejects(x.h.execute('b', () => assert.fail('paused')), code('CONTROL_PAUSED'))
  assert.equal((await x.h.execute('a', () => assert.fail('replay'))).replayed, true)
  const before = x.h.getControl()
  x.h.cancelPrepared('b')
  assert.deepEqual(x.h.getControl(), before)
  assert.equal(x.inspect().control.reservedHistorySlots, 0)
  x.h.resumeBudget({ expectedRevision: before.revision })
  assert.deepEqual(x.h.getControl().blockers, [])
}))

await test('control two admitted callbacks settle while paused; unknown holds cannot be cleared', () => fixture(async x => {
  x.fresh()
  for (const id of ['a', 'b']) x.h.prepare({ id, input: {} })
  let finishA, finishB
  const a = x.h.execute('a', () => new Promise(r => { finishA = r }))
  const b = x.h.execute('b', () => new Promise(r => { finishB = r }))
  x.h.pauseControl({ expectedRevision: x.h.getControl().revision, reason: 'paused_budget' })
  assert.throws(() => x.h.adjustGrant({ expectedRevision: x.h.getControl().revision, currentGrant: 3, reason: 'operator_increase' }), code('CONTROL_BUSY'))
  finishA({ outcome: 'returned', result: 'kept' }); finishB({ outcome: 'unknown', result: null })
  await a; await assert.rejects(b, code('DISPATCH_UNCERTAIN'))
  const saved = x.inspect()
  assert.equal(saved.control.reservedHistorySlots, 0)
  assert.equal(saved.history.filter(r => r.reason === 'settled').length, 2)
  assert.deepEqual(x.h.getControl().blockers, ['paused_budget', 'paused_uncertain', 'report_stale'])
  x.fresh()
  assert.throws(() => x.h.resumeBudget({ expectedRevision: x.h.getControl().revision }), code('CONTROL_BUSY'))
  const before = x.h.getControl()
  x.reopen()
  assert.deepEqual(x.h.getControl(), before)
  await assert.rejects(x.h.execute('b', () => assert.fail('unknown replay')), code('DISPATCH_UNCERTAIN'))
  assert.equal(journal.readAuditJournal(x.dir).heldCalls, 1)
}))

await test('control ordinary publication failure preserves terminal receipt and blocks only new dispatch', () => fixture(async x => {
  x.fresh()
  x.h.prepare({ id: 'done', input: {} })
  await x.h.execute('done', () => ({ outcome: 'failed', result: { code: 'ORDINARY_FAILURE' } }))
  const pointer = join(x.dir, 'partial-reports/current.json'), bytes = readFileSync(pointer)
  writeFileSync(pointer, 'inert invalid pointer')
  assert.equal(report.publishPartialReport(x.dir).status, 'failed')
  assert.throws(() => x.h.acknowledgeReport({ expectedRevision: x.h.getControl().revision }), code('REPORT_NOT_CURRENT'))
  assert.throws(() => x.h.prepare({ id: 'new', input: {} }), code('CONTROL_PAUSED'))
  assert.equal((await x.h.execute('done', () => assert.fail('must replay'))).outcome, 'failed')
  writeFileSync(pointer, bytes)
  x.fresh()
  assert.deepEqual(x.h.getControl().blockers, [])
}))

await test('control readers and owner bind current identity and closed handles cannot mutate', () => fixture(x => {
  const file = join(x.dir, 'run-metadata.json'), bytes = readFileSync(file)
  x.put('run-metadata.json', { ...JSON.parse(bytes), repo: 'changed' })
  for (const read of [() => journal.readAuditControl(x.dir), () => journal.readAuditBudgetEvidence(x.dir), () => x.h.getControl(),
    () => x.h.pauseControl({ expectedRevision: 1, reason: 'paused_budget' })]) assert.throws(read, code('CONFLICT'))
  writeFileSync(file, bytes)
  assert.equal(x.h.getControl().revision, 1)
  x.h.close()
  assert.throws(() => x.h.getControl(), code('CLOSED'))
  assert.throws(() => x.h.initControl({ initialGrant: 2 }), code('CLOSED'))
}))

await test('control zero grant and maximum are known values, while populated legacy opt-in refuses', async () => {
  await fixture(x => {
    x.fresh()
    assert.deepEqual(journal.readAuditBudgetEvidence(x.dir), { version: 1, maximum: 0, currentGrant: 0 })
    assert.throws(() => x.h.prepare({ id: 'a', input: {} }), code('BUDGET_EXHAUSTED'))
    assert.throws(() => x.h.resumeBudget({ expectedRevision: x.h.getControl().revision }), code('BUDGET_EXHAUSTED'))
    assert.equal(x.inspect().control.reservedHistorySlots, 0)
  }, { maximum: 0, grant: 0 })
  await fixture(x => {
    x.h.prepare({ id: 'legacy', input: {} })
    const before = x.inspect()
    assert.throws(() => x.h.initControl({ initialGrant: 2 }), code('CONTROL_INIT_REFUSED'))
    assert.deepEqual(x.inspect(), before)
  }, { legacy: true })
})

// A one-shot local SQLite write fault, not a crash/lock/race reproduction.
// The journal still executes its real transaction and rollback on the same owner.
async function withWriteFault(pattern, check) {
  const prepare = DatabaseSync.prototype.prepare
  let faults = 0
  DatabaseSync.prototype.prepare = function(sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest)
    if (pattern.test(sql)) statement.run = () => { faults++; throw Object.assign(new Error('inert IO fault'), { code: 'EIO' }) }
    return statement
  }
  try { await check() } finally { DatabaseSync.prototype.prepare = prepare }
  assert.ok(faults > 0)
}

await test('control failed opt-in rolls schema and version back atomically', () => fixture(async x => {
  const before = x.inspect()
  await withWriteFault(/^INSERT INTO control_history/, () => {
    assert.throws(() => x.h.initControl({ initialGrant: 2 }), code('IO_ERROR'))
  })
  assert.deepEqual(x.inspect(), before)
  assert.equal(journal.readAuditControl(x.dir), null)
  assert.equal(x.h.initControl({ initialGrant: 2 }).revision, 1)
}, { legacy: true }))

await test('control failed reservation, cancellation and adjustment preserve both rows and reservations', () => fixture(async x => {
  x.fresh()
  let before = x.inspect()
  await withWriteFault(/^UPDATE control SET/, () => assert.throws(() => x.h.prepare({ id: 'a', input: {} }), code('IO_ERROR')))
  assert.deepEqual(x.inspect(), before)
  assert.equal(journal.readAuditJournal(x.dir).rows.length, 0)
  x.h.prepare({ id: 'a', input: {} })
  before = x.inspect()
  await withWriteFault(/^UPDATE control SET/, () => assert.throws(() => x.h.cancelPrepared('a'), code('IO_ERROR')))
  assert.deepEqual(x.inspect(), before)
  assert.equal(journal.readAuditJournal(x.dir).rows[0].state, 'prepared')
  x.h.pauseControl({ expectedRevision: x.h.getControl().revision, reason: 'paused_budget' })
  before = x.inspect()
  await withWriteFault(/^UPDATE control SET/, () => assert.throws(() => x.h.adjustGrant({ expectedRevision: x.h.getControl().revision, currentGrant: 3, reason: 'operator_increase' }), code('IO_ERROR')))
  assert.deepEqual(x.inspect(), before)
}))

await test('control failed settlement retains dispatched charge; ordinary close/reopen consumes one recovery slot', () => fixture(async x => {
  x.fresh()
  x.h.prepare({ id: 'a', input: {} })
  const before = x.h.getControl()
  let calls = 0
  await withWriteFault(/^INSERT INTO control_history/, async () => {
    await assert.rejects(x.h.execute('a', () => { calls++; return { outcome: 'returned', result: 'not persisted' } }), code('IO_ERROR'))
  })
  assert.equal(journal.readAuditJournal(x.dir).rows[0].state, 'dispatched')
  assert.equal(x.inspect().control.reservedHistorySlots, 1)
  assert.deepEqual(x.h.getControl(), before)
  x.reopen()
  const recovered = x.inspect()
  assert.equal(recovered.control.reservedHistorySlots, 0)
  assert.deepEqual(x.h.getControl().blockers, ['paused_uncertain', 'report_stale'])
  assert.equal(recovered.history.at(-1).reason, 'recovered_uncertain')
  assert.equal(recovered.history.length, before.revision + 1)
  assert.equal(journal.readAuditJournal(x.dir).rows[0].state, 'uncertain')
  x.reopen()
  assert.deepEqual(x.inspect(), recovered)
  await assert.rejects(x.h.execute('a', () => { calls++; assert.fail('never retry') }), code('DISPATCH_UNCERTAIN'))
  assert.equal(calls, 1)
}))

await test('control acknowledgement write failure keeps stale barrier and current generation retryable', () => fixture(async x => {
  const out = report.publishPartialReport(x.dir)
  assert.equal(out.status, 'published')
  const before = x.inspect()
  await withWriteFault(/^UPDATE control SET/, () => assert.throws(() => x.h.acknowledgeReport({ expectedRevision: 1 }), code('IO_ERROR')))
  assert.deepEqual(x.inspect(), before)
  assert.equal(report.readPartialReport(x.dir).status, 'current')
  x.h.acknowledgeReport({ expectedRevision: 1 })
  assert.equal(x.h.getControl().acknowledgedGeneration, out.generationKey)
  const stable = x.inspect()
  x.h.acknowledgeReport({ expectedRevision: 2 })
  assert.deepEqual(x.inspect(), stable)
}))

await test('control pure capacity boundary keeps settlement slots and full pending result allowances', async () => {
  const { controlledBytes, requireHistoryCapacity, HISTORY_LIMIT, CONTROL_BYTES } = await import('../skills/security-audit/journal-control.mjs')
  const { BODY_LIMIT, TOTAL_LIMIT, contentBytes, canonical } = await import('../skills/security-audit/journal-data.mjs')
  const c = { revision: HISTORY_LIMIT - 2, reservedHistorySlots: 2 }
  assert.throws(() => requireHistoryCapacity(c), code('CONTROL_CAPACITY'))
  assert.doesNotThrow(() => requireHistoryCapacity(c, true))
  assert.doesNotThrow(() => requireHistoryCapacity({ revision: HISTORY_LIMIT - 1, reservedHistorySlots: 1 }, true))
  assert.throws(() => requireHistoryCapacity({ revision: HISTORY_LIMIT, reservedHistorySlots: 0 }), code('CONTROL_CAPACITY'))
  const identity = { version: 1 }, row = { id: 'a', input: '{}', state: 'prepared', result: null }
  const pending = controlledBytes(identity, 2, [row], true)
  assert.equal(pending, contentBytes(identity, 2, [row]) + CONTROL_BYTES + BODY_LIMIT)
  assert.equal(controlledBytes(identity, 2, [{ ...row, state: 'uncertain' }], true), pending)
  const returned = { ...row, state: 'returned', result: canonical('x'.repeat(BODY_LIMIT - 2)) }
  assert.ok(controlledBytes(identity, 2, [returned], true) <= pending)
  assert.equal(controlledBytes(identity, 2, [], true), contentBytes(identity, 2, []) + CONTROL_BYTES)
  assert.equal(controlledBytes(identity, 2, [row], false), contentBytes(identity, 2, [row]))
  // Tiny inert rows only; no large database, payload or live callbacks.
  const rows = Array.from({ length: 992 }, (_, i) => ({ ...row, id: `r${i}` }))
  assert.ok(controlledBytes(identity, 1000, rows.slice(0, -1), true) <= TOTAL_LIMIT)
  assert.ok(controlledBytes(identity, 1000, rows, true) > TOTAL_LIMIT)
})

await test('control failed budget projection invalidates context rather than becoming legacy null', () => fixture(x => {
  const prepare = DatabaseSync.prototype.prepare
  let bodyReads = 0
  DatabaseSync.prototype.prepare = function(sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest)
    if (sql === 'SELECT body FROM control WHERE singleton=1') {
      const get = statement.get
      statement.get = function(...args) {
        bodyReads++
        if (bodyReads % 2 === 0) throw Object.assign(new Error('inert budget read failure'), { code: 'EIO' })
        return get.apply(this, args)
      }
    }
    return statement
  }
  try {
    assert.throws(() => report.partialReportContext(x.dir), code('INVALID_CONTEXT'))
    assert.equal(report.readPartialReport(x.dir).status, 'invalid')
    assert.equal(report.publishPartialReport(x.dir).reason, 'INVALID_CONTEXT')
  } finally { DatabaseSync.prototype.prepare = prepare }
  assert.equal(bodyReads, 6)
  const good = report.partialReportContext(x.dir)
  for (const budgetEvidence of [{ version: 1, maximum: 4, currentGrant: -1 }, { version: 1, maximum: 4, currentGrant: 5 },
    { version: 1, maximum: 4, currentGrant: 2, blockers: [] }, null]) {
    assert.throws(() => report.buildPartialReport({ ...good, budgetEvidence }), code('INVALID_CONTEXT'))
  }
}))

await test('control malformed stored schema/data refuses rather than falling back to legacy', () => fixture(x => {
  const prepare = DatabaseSync.prototype.prepare, original = x.inspect().control
  const patches = [{ version: 2 }, { revision: 0 }, { maximum: 5 }, { currentGrant: -1 }, { currentGrant: 5 },
    { blockers: ['report_stale', 'paused_budget'] }, { blockers: ['report_stale', 'report_stale'] },
    { blockers: ['unknown'] }, { acknowledgedGeneration: 'bad' }, { reservedHistorySlots: 1 }, { extra: 0 }]
  return import('../skills/security-audit/journal-data.mjs').then(({ canonical }) => {
    for (const patch of patches) {
      DatabaseSync.prototype.prepare = function(sql, ...rest) {
        const statement = prepare.call(this, sql, ...rest)
        if (sql === 'SELECT body FROM control WHERE singleton=1') statement.get = () => ({ body: canonical({ ...original, ...patch }) })
        return statement
      }
      try {
        for (const read of [journal.readAuditJournal, journal.readAuditControl, journal.readAuditBudgetEvidence]) assert.throws(() => read(x.dir), code('CORRUPT'))
      } finally { DatabaseSync.prototype.prepare = prepare }
    }
    DatabaseSync.prototype.prepare = function(sql, ...rest) {
      const statement = prepare.call(this, sql, ...rest)
      if (sql === 'PRAGMA user_version') statement.get = () => ({ user_version: 3 })
      return statement
    }
    try { assert.throws(() => journal.readAuditControl(x.dir), code('CORRUPT')) }
    finally { DatabaseSync.prototype.prepare = prepare }
    assert.deepEqual(x.inspect().control, original)
  })
}))

await test('control and history byte bounds reject before any journal body read', () => fixture(x => {
  const prepare = DatabaseSync.prototype.prepare
  for (const [table, bytes] of [['control', 4097], ['control_history', 1025]]) {
    let reads = 0, altered = 0
    DatabaseSync.prototype.prepare = function(sql, ...rest) {
      const statement = prepare.call(this, sql, ...rest)
      if (sql.includes(`FROM ${table} `) && sql.includes('length(CAST(body AS BLOB))')) {
        const all = statement.all
        statement.all = function(...args) { altered++; return all.apply(this, args).map(r => ({ ...r, bytes })) }
      }
      if (statement.columns().some(c => ['identity', 'input', 'result', 'body'].includes(c.name))) {
        for (const method of ['get', 'all']) {
          const call = statement[method]
          statement[method] = function(...args) { reads++; return call.apply(this, args) }
        }
      }
      return statement
    }
    try { assert.throws(() => journal.readAuditControl(x.dir), code('CORRUPT')) }
    finally { DatabaseSync.prototype.prepare = prepare }
    assert.equal(altered, 1)
    assert.equal(reads, 0)
  }
}))

await test('control history discontinuity, wrong reasons and mismatched grant/ack are corruption', () => fixture(async x => {
  x.fresh()
  const prepare = DatabaseSync.prototype.prepare, before = x.inspect()
  const { canonical } = await import('../skills/security-audit/journal-data.mjs')
  for (const patch of [{ reason: 'other' }, { oldGrant: 1 }, { newGrant: 3 }, { beforeBlockers: [] },
    { afterBlockers: ['report_stale'] }, { acknowledgedGeneration: null }]) {
    DatabaseSync.prototype.prepare = function(sql, ...rest) {
      const statement = prepare.call(this, sql, ...rest)
      if (sql.startsWith('SELECT revision, body FROM control_history')) {
        const all = statement.all
        statement.all = function(...args) {
          return all.apply(this, args).map((r, i) => i === 1 ? { ...r, body: canonical({ ...JSON.parse(r.body), ...patch }) } : r)
        }
      }
      return statement
    }
    try { assert.throws(() => journal.readAuditControl(x.dir), code('CORRUPT')) }
    finally { DatabaseSync.prototype.prepare = prepare }
  }
  assert.deepEqual(x.inspect(), before)
}))

await test('control full-size result fits its admitted allowance and oversized result remains held', () => fixture(async x => {
  const { BODY_LIMIT } = await import('../skills/security-audit/journal-data.mjs')
  x.fresh()
  x.h.prepare({ id: 'full', input: { text: 'x'.repeat(BODY_LIMIT - 11) } })
  x.h.prepare({ id: 'oversized', input: {} })
  const result = 'é'.repeat((BODY_LIMIT - 2) / 2)
  assert.equal((await x.h.execute('full', () => ({ outcome: 'returned', result }))).result, result)
  assert.equal(x.inspect().control.reservedHistorySlots, 1)
  x.fresh()
  await assert.rejects(x.h.execute('oversized', () => ({ outcome: 'returned', result: result + 'é' })), code('DISPATCH_UNCERTAIN'))
  assert.equal(x.inspect().control.reservedHistorySlots, 0)
  assert.equal(journal.readAuditJournal(x.dir).heldCalls, 1)
  assert.deepEqual(x.h.getControl().blockers, ['paused_uncertain', 'report_stale'])
}))

await test('control opt-in leaves legacy settlement/cancellation identity semantics unchanged', () => fixture(async x => {
  const file = join(x.dir, 'run-metadata.json'), bytes = readFileSync(file)
  x.h.prepare({ id: 'active', input: {} })
  x.h.prepare({ id: 'held', input: {} })
  try {
    // A sequential valid metadata edit during a local fake callback, not a
    // filesystem race. The v1 journal historically binds settlement to storage.
    const out = await x.h.execute('active', () => {
      x.put('run-metadata.json', { ...JSON.parse(bytes), repo: 'changed' })
      return { outcome: 'returned', result: 'legacy receipt' }
    })
    assert.equal(out.outcome, 'returned')
    assert.equal(x.h.cancelPrepared('held').changed, true)
    // New control APIs still require the current identity, even in legacy mode.
    assert.throws(() => x.h.getControl(), code('CONFLICT'))
  } finally { writeFileSync(file, bytes) }
  assert.deepEqual(journal.readAuditJournal(x.dir).rows.map(r => [r.id, r.state]), [['active', 'returned']])
}, { legacy: true }))
