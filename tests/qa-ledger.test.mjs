// CP-05c implementation edges the frozen acceptance does not pin: errors that carry only
// code and message; a valid-shaped ledger that does not serialize (BigInt, cycle,
// toJSON) refused before any filesystem step; a result judged on its JSON copy; dirs
// created 0700 under a restrictive umask; a parent that is a file; a BOM; null-prototype
// and symbol/non-enumerable keys; the year range of `now`; the idle count ceiling.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../graphs/qa/tool/qa-ledger.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'qa-ledger-')))
let caseNo = 0
function makeCase() {
  const base = join(WORK, `case-${++caseNo}`)
  mkdirSync(base)
  return base
}
const empty = () => ({ runs: [], stuckSigs: [], blockedOn: null, idleRuns: 0 })
const mode = path => statSync(path).mode & 0o777
const listing = dir => readdirSync(dir).sort()
const NOW = { now: new Date('2026-11-20T00:00:00Z') }

function throwsCode(fn, code, base) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof Error, `expected ${code}`)
  assert.equal(caught.code, code)
  assert.equal(caught.message, `qa-ledger: ${code}.`)
  assert.deepEqual(Object.keys(caught), ['code'], 'no other own fields')
  assert.equal(caught.cause, undefined)
  if (base) assert.ok(!String(caught.stack).includes(base), 'no case path in the stack')
  return caught
}

try {
  await test('qa-ledger: errors carry only the code and the fixed message', async () => {
    const m = await api()
    const base = makeCase()
    const plain = join(base, 'plain')
    writeFileSync(plain, 'x')
    throwsCode(() => m.readLedger(join(plain, 'ledger.json')), 'LEDGER_IO_ERROR', base)
    throwsCode(() => m.writeLedger(join(plain, 'ledger.json'), empty()), 'LEDGER_IO_ERROR', base)
    throwsCode(() => m.writeLedger(base, null), 'INVALID_LEDGER', base)
    throwsCode(() => m.applyResult(empty(), { status: 'nope' }), 'INVALID_RESULT')
    throwsCode(() => m.workflowArgs(empty(), { repo: base, extra: base }), 'INVALID_ARGS', base)
  })

  await test('qa-ledger: a parent that is a file fails the write and leaves the file as it was', async () => {
    const m = await api()
    const base = makeCase()
    const plain = join(base, 'plain')
    writeFileSync(plain, 'keep')
    throwsCode(() => m.writeLedger(join(plain, 'sub', 'ledger.json'), empty()), 'LEDGER_IO_ERROR', base)
    assert.equal(readFileSync(plain, 'utf8'), 'keep')
    assert.deepEqual(listing(base), ['plain'])
  })

  await test('qa-ledger: a ledger that does not serialize is INVALID_LEDGER before any filesystem step', async () => {
    const m = await api()
    const base = makeCase()
    const file = join(base, 'new', 'ledger.json')
    const cyclic = { status: 'done' }
    cyclic.self = cyclic
    const runs = [
      [{ status: 'done', size: 10n }],
      [cyclic],
      [{ status: 'done', toJSON: () => 'flat' }],
      [{ status: 'done', toJSON: () => undefined }],
    ]
    for (const r of runs) throwsCode(() => m.writeLedger(file, { ...empty(), runs: r }), 'INVALID_LEDGER', base)
    assert.deepEqual(listing(base), [], 'no directory was created')
  })

  await test('qa-ledger: a result is judged on its JSON copy', async () => {
    const m = await api()
    const flips = { status: 'done', toJSON: () => ({ status: 'DONE' }) }
    throwsCode(() => m.applyResult(empty(), flips, NOW), 'INVALID_RESULT')
    for (const toJSON of [() => 'done', () => undefined, () => ['done'], () => null]) {
      throwsCode(() => m.applyResult(empty(), { status: 'done', toJSON }, NOW), 'INVALID_RESULT')
    }
    const cyclic = { status: 'done' }
    cyclic.self = cyclic
    throwsCode(() => m.applyResult(empty(), cyclic, NOW), 'INVALID_RESULT')
    // The copy's stuckSig is the one recorded: a toJSON that names one is honoured.
    const named = { status: 'escalate', toJSON: () => ({ status: 'escalate', stuckSig: 'copied' }) }
    const next = m.applyResult({ ...empty(), stuckSigs: ['a'] }, named, NOW)
    assert.deepEqual(next.stuckSigs, ['a', 'copied'])
    assert.deepEqual(next.runs, [{ status: 'escalate', stuckSig: 'copied', at: '2026-11-20T00:00:00Z' }])
    const nullProto = Object.assign(Object.create(null), { status: 'done' })
    assert.equal(m.applyResult(empty(), nullProto, NOW).runs[0].status, 'done')
  })

  await test('qa-ledger: now outside years 0000-9999 is refused; an undefined now is the clock', async () => {
    const m = await api()
    for (const now of [new Date('+010000-01-01T00:00:00Z'), new Date('-000001-01-01T00:00:00Z')]) {
      throwsCode(() => m.applyResult(empty(), { status: 'done' }, { now }), 'INVALID_ARGS')
    }
    const forged = Object.create(Date.prototype)
    throwsCode(() => m.applyResult(empty(), { status: 'done' }, { now: forged }), 'INVALID_ARGS')
    assert.equal(m.applyResult(empty(), { status: 'done' }, { now: new Date('0000-01-01T00:00:00Z') }).runs[0].at, '0000-01-01T00:00:00Z')
    const at = m.applyResult(empty(), { status: 'done' }, { now: undefined }).runs[0].at
    assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  await test('qa-ledger: created directories are 0700 and the file 0600 under a restrictive umask', async () => {
    const m = await api()
    const base = makeCase()
    const file = join(base, 'a', 'b', 'ledger.json')
    const old = process.umask(0o277)
    try { m.writeLedger(file, empty()) } finally { process.umask(old) }
    assert.equal(mode(join(base, 'a')), 0o700)
    assert.equal(mode(join(base, 'a', 'b')), 0o700)
    assert.equal(mode(file), 0o600)
    m.writeLedger(file, { ...empty(), idleRuns: 1 })
    assert.deepEqual(listing(join(base, 'a', 'b')), ['ledger.json'], 'a second write leaves no temp file')
    assert.deepEqual(m.readLedger(file), { ledger: { ...empty(), idleRuns: 1 }, warning: null })
  })

  await test('qa-ledger: a BOM-prefixed ledger is unparseable; a __proto__ key is ignored', async () => {
    const m = await api()
    const base = makeCase()
    const file = join(base, 'ledger.json')
    writeFileSync(file, `﻿${JSON.stringify(empty())}`)
    assert.deepEqual(m.readLedger(file), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' })
    writeFileSync(file, '{"__proto__": {"idleRuns": 5}, "stuckSigs": ["s"]}')
    const read = m.readLedger(file)
    assert.deepEqual(read, { ledger: { ...empty(), stuckSigs: ['s'] }, warning: null })
    assert.equal(Object.getPrototypeOf(read.ledger), Object.prototype)
  })

  await test('qa-ledger: a null-prototype ledger is valid; symbol and non-enumerable extra keys are not', async () => {
    const m = await api()
    const nullProto = Object.assign(Object.create(null), empty())
    assert.equal(m.shouldStop(nullProto), false)
    const withSymbol = { ...empty(), [Symbol('x')]: 1 }
    throwsCode(() => m.shouldStop(withSymbol), 'INVALID_LEDGER')
    const hidden = empty()
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false })
    throwsCode(() => m.shouldStop(hidden), 'INVALID_LEDGER')
    throwsCode(() => m.shouldStop({ ...empty(), runs: [Object.assign(new (class Run {})(), { status: 'done' })] }), 'INVALID_LEDGER')
    throwsCode(() => m.shouldStop({ ...empty(), runs: new Array(1) }), 'INVALID_LEDGER')
  })

  await test('qa-ledger: the idle count cannot pass the safe-integer ceiling', async () => {
    const m = await api()
    const top = { ...empty(), idleRuns: Number.MAX_SAFE_INTEGER }
    throwsCode(() => m.applyIdle(top, true), 'INVALID_LEDGER')
    assert.equal(m.applyIdle(top, false).idleRuns, 0)
  })

  await test('qa-ledger: pure functions return new arrays and never share them with the input', async () => {
    const m = await api()
    const ledger = { ...empty(), runs: [{ status: 'done' }], stuckSigs: ['s'] }
    for (const next of [m.applyIdle(ledger, true), m.setBlockedOn(ledger, 'x').ledger, m.applyResult(ledger, { status: 'escalate' }, NOW)]) {
      assert.notEqual(next.runs, ledger.runs)
      assert.notEqual(next.stuckSigs, ledger.stuckSigs)
      next.stuckSigs.push('later')
    }
    assert.deepEqual(ledger.stuckSigs, ['s'])
    assert.equal(ledger.runs.length, 1)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
