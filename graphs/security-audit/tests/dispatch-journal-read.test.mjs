import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from '../../../scripts/workflow-harness.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { BODY_LIMIT, ROW_LIMIT } from '../skills/security-audit/journal-data.mjs'

const code = expected => error => error.code === expected && error.message === `Audit journal: ${expected}`
// Inert metadata accepted by loadRun; no target export, source execution or child.
async function fixture(check) {
  const runDir = mkdtempSync(join(tmpdir(), 'journal-reader-'))
  const metadata = join(runDir, 'run-metadata.json')
  const meta = { version: 1, run_id: 'reader-run', repo: 'fixture', target: 'fixture',
    source_ref: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false,
      uncommitted: { tracked: 0, untracked: 0 } }, run_status: 'in_progress' }
  writeFileSync(metadata, JSON.stringify(meta) + '\n')
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'init', wave: 0, critic_kind: null }))
  const original = readFileSync(metadata)
  let handle
  try {
    handle = openAuditJournal({ runDir, invocationLimit: ROW_LIMIT + 1 })
    handle.prepare({ id: 'ordinary', input: { text: 'inert input' } })
    await handle.execute('ordinary', () => ({ outcome: 'returned', result: { text: 'retained result' } }))
    handle.close()
    await check({ meta, metadata, original, runDir, read: () => readAuditJournal(runDir),
      file: join(runDir, 'native-dispatch', 'journal.sqlite') })
  } finally {
    writeFileSync(metadata, original)
    handle?.close()
    rmSync(runDir, { recursive: true, force: true })
  }
}

await test('journal reader binds every current identity field and preserves exact restored receipts', () => fixture(x => {
  const before = x.read(), database = readFileSync(x.file)
  const source = x.meta.source_ref
  const patches = [
    { run_id: 'changed' }, { repo: 'changed' }, { target: 'changed' },
    ...[{ commit: 'c'.repeat(40) }, { tree: 'd'.repeat(40) }, { dirty: true },
      { uncommitted: { tracked: 1, untracked: 0 } }, { uncommitted: { tracked: 0, untracked: 1 } }]
      .map(patch => ({ source_ref: { ...source, ...patch } })),
  ]
  for (const patch of patches) {
    try {
      writeFileSync(x.metadata, JSON.stringify({ ...x.meta, ...patch }))
      assert.throws(x.read, code('CONFLICT'))
    } finally { writeFileSync(x.metadata, x.original) }
    assert.deepEqual(x.read(), before)
    assert.deepEqual(readFileSync(x.file), database)
  }
}))

await test('journal reader permits matching terminal identity and rejects malformed current metadata', () => fixture(x => {
  const before = x.read()
  for (const run_status of ['complete', 'incomplete']) {
    writeFileSync(x.metadata, JSON.stringify({ ...x.meta, run_status,
      incomplete_reason: run_status === 'incomplete' ? 'ordinary fixture limit' : null }))
    assert.deepEqual(x.read(), before)
  }
  for (const patch of [{ version: 2 }, { run_id: '' }, { source_ref: { ...x.meta.source_ref, dirty: null } }]) {
    writeFileSync(x.metadata, JSON.stringify({ ...x.meta, ...patch }))
    assert.throws(x.read, code('CORRUPT'))
  }
}))

// Observe actual SQLite result columns, not source text or query spelling.
// A corrupt length/count must refuse before any stored body is materialized.
function withoutBodyReads(read) {
  const prepare = DatabaseSync.prototype.prepare, reads = []
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = prepare.apply(this, args)
    const bodies = statement.columns().map(c => c.name).filter(n => ['identity', 'id', 'input', 'state', 'result'].includes(n))
    if (bodies.length) for (const method of ['all', 'get']) {
      const original = statement[method]
      statement[method] = function (...values) {
        reads.push(...bodies)
        return original.apply(this, values)
      }
    }
    return statement
  }
  try { assert.throws(read, code('CORRUPT')); assert.deepEqual(reads, []) }
  finally { DatabaseSync.prototype.prepare = prepare }
}

for (const [name, sql, value] of [
  ['identity', 'UPDATE header SET identity=?', 'x'.repeat(BODY_LIMIT + 1)],
  ['id', 'UPDATE attempts SET id=?', 'a'.repeat(81)],
  ['empty id', 'UPDATE attempts SET id=?', ''],
  ['state', 'UPDATE attempts SET state=?', 'x'.repeat(11)],
  ['empty state', 'UPDATE attempts SET state=?', ''],
  ['input UTF8', 'UPDATE attempts SET input=?', JSON.stringify({ text: 'é'.repeat(BODY_LIMIT / 2) })],
  ['result UTF8', 'UPDATE attempts SET result=?', JSON.stringify('é'.repeat(BODY_LIMIT / 2))],
]) await test(`journal reader refuses ${name} size before materializing stored bodies`, () => fixture(x => {
  const db = new DatabaseSync(x.file)
  try { db.prepare(sql).run(value) } finally { db.close() }
  withoutBodyReads(x.read)
}))

await test('journal reader refuses excess small rows before materializing stored bodies', () => fixture(x => {
  const db = new DatabaseSync(x.file)
  try {
    db.exec('BEGIN')
    const insert = db.prepare("INSERT INTO attempts(id,input,state,result) VALUES (?,'{}','prepared',NULL)")
    for (let i = 0; i < ROW_LIMIT; i++) insert.run(`row${i}`)
    db.exec('COMMIT')
  } finally { db.close() }
  withoutBodyReads(x.read)
}))

await test('journal reader accepts exact byte and ID boundaries with detached replay and unchanged counters', () => fixture(x => {
  const db = new DatabaseSync(x.file), id = 'a'.repeat(80)
  const input = { text: 'x'.repeat(BODY_LIMIT - Buffer.byteLength('{"text":""}')) }
  const result = 'é'.repeat((BODY_LIMIT - 2) / 2)
  try {
    db.prepare('UPDATE attempts SET id=?,input=?,result=?').run(id, JSON.stringify(input), JSON.stringify(result))
    db.prepare("INSERT INTO attempts(id,input,state,result) VALUES ('held','{}','uncertain',NULL)").run()
  } finally { db.close() }
  const before = readFileSync(x.file), value = x.read()
  assert.deepEqual(value.rows, [{ id, input, state: 'returned', result }, { id: 'held', input: {}, state: 'uncertain', result: null }])
  assert.deepEqual([value.settledCalls, value.heldCalls, value.available], [1, 1, ROW_LIMIT - 1])
  value.rows[0].input.text = 'local mutation'
  assert.deepEqual(x.read().rows[0].input, input)
  assert.deepEqual(readFileSync(x.file), before)
}))
