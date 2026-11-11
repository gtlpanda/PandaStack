// Durable leaf receipts only. No scheduler, retries, providers or spend projection.
import { readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { loadRun, isCommitId } from './audit-run.mjs'
import { openStorage } from './journal-storage.mjs'
import { BODY_LIMIT, TOTAL_LIMIT, ROW_LIMIT, fail, need, guarded, fields, record,
  canonical, parseCanonical, validId, pending, terminalEnvelope, contentBytes } from './journal-data.mjs'

const nonempty = v => typeof v === 'string' && v.trim().length > 0
const natural = n => Number.isSafeInteger(n) && n >= 0
function readOwnedJson(file, optional = false) {
  try {
    need(lstatSync(file).isFile())
    const bytes = readFileSync(file, 'utf8')
    try { return JSON.parse(bytes) } catch { fail('CORRUPT') }
  } catch (e) {
    if (e.code === 'ENOENT') { if (optional) return; fail('CORRUPT') }
    throw e
  }
}
export function validIdentity(identity) {
  const m = fields(identity, ['version', 'run_id', 'repo', 'target', 'source_ref'], 'CORRUPT')
  need(m.version === 1 && [m.run_id, m.repo, m.target].every(nonempty))
  const s = m.source_ref
  need(record(s) && isCommitId(s.commit) && isCommitId(s.tree) && s.commit.length === s.tree.length && typeof s.dirty === 'boolean')
  if (Object.hasOwn(s, 'uncommitted')) need(record(s.uncommitted) && natural(s.uncommitted.tracked) && natural(s.uncommitted.untracked))
  return m
}
function runIdentity(runDir, grant = true) {
  need(typeof runDir === 'string' && runDir.length > 0 && !runDir.includes('\0') &&
    !runDir.split('/').some(p => p === '.' || p === '..'), 'INVALID_JOURNAL_INPUT')
  const meta = readOwnedJson(join(runDir, 'run-metadata.json'))
  need(record(meta))
  const identity = validIdentity(Object.fromEntries(['version', 'run_id', 'repo', 'target', 'source_ref'].map(k => [k, meta[k]])))
  // Preserve the owning run validator; stricter journal identity is additive.
  // Pre-read its remaining files so operational errors retain IO_ERROR instead
  // of being flattened into the owner's content-validation Refusal.
  readOwnedJson(join(runDir, 'stage-state.json'))
  for (const name of ['coverage-ledger.json', 'findings.json']) readOwnedJson(join(runDir, name), true)
  try { loadRun(runDir) } catch { fail('CORRUPT') }
  if (grant && ['complete', 'incomplete'].includes(meta.run_status)) fail('TERMINAL_RUN')
  return canonical(identity, BODY_LIMIT, 'CORRUPT', 'CORRUPT')
}

function snapshot(db) {
  // Admit every variable-width field using byte lengths only, before fetching
  // even the identity body. The transaction keeps both query phases consistent.
  const headers = db.prepare(`SELECT singleton, length(CAST(identity AS BLOB)) AS bytes,
    length(CAST(invocation_limit AS BLOB)) AS limit_bytes FROM header LIMIT 2`).all()
  need(headers.length === 1 && headers[0].singleton === 1)
  let storedBytes = 0
  const countBytes = (bytes, maximum, minimum = 0) => {
    need(natural(bytes) && bytes >= minimum && bytes <= maximum)
    // Subtract before adding: no unsafe sum or aggregate body allocation.
    need(bytes <= TOTAL_LIMIT - storedBytes)
    storedBytes += bytes
  }
  countBytes(headers[0].bytes, BODY_LIMIT, 1)
  // The unchanged STRICT schema bounds integer text to signed int64 (20 bytes).
  countBytes(headers[0].limit_bytes, 20, 1)
  const bounded = db.prepare(`SELECT CAST(seq AS TEXT) AS position,
    length(CAST(id AS BLOB)) AS id_bytes, length(CAST(state AS BLOB)) AS state_bytes,
    length(CAST(input AS BLOB)) AS input_bytes, length(CAST(result AS BLOB)) AS result_bytes
    FROM attempts ORDER BY seq LIMIT 10001`).all()
  need(bounded.length <= ROW_LIMIT)
  let last = 0
  for (const row of bounded) {
    const seq = Number(row.position)
    need(Number.isSafeInteger(seq) && seq > last)
    countBytes(row.id_bytes, 80, 1)
    countBytes(row.state_bytes, 10, 6) // failed through dispatched; validate vocabulary below.
    countBytes(row.input_bytes, BODY_LIMIT)
    if (row.result_bytes !== null) countBytes(row.result_bytes, BODY_LIMIT)
    last = seq
  }
  const header = db.prepare('SELECT identity, CAST(invocation_limit AS TEXT) AS invocation_limit FROM header WHERE singleton=1').get()
  need(header)
  header.invocation_limit = Number(header.invocation_limit)
  need(natural(header.invocation_limit))
  const identity = validIdentity(parseCanonical(header.identity))
  const rows = db.prepare('SELECT id, input, state, result FROM attempts ORDER BY seq LIMIT 10001').all()
  const ids = new Set(), detached = []
  let settledCalls = 0, heldCalls = 0
  for (const row of rows) {
    need(validId(row.id) && !ids.has(row.id)); ids.add(row.id)
    const input = parseCanonical(row.input)
    need(record(input))
    let result = null
    if (pending(row.state)) { need(row.result === null); heldCalls++ }
    else {
      need(['returned', 'failed'].includes(row.state) && row.result !== null)
      result = parseCanonical(row.result)
      if (row.state === 'failed') {
        try { terminalEnvelope({ outcome: 'failed', result }) } catch { fail('CORRUPT') }
      }
      settledCalls++
    }
    detached.push({ id: row.id, input, state: row.state, result })
  }
  // The length subtotal is only a lower bound; retain exact logical accounting
  // including JSON envelopes and reserved pending control-state expansion.
  need(rows.length <= header.invocation_limit && contentBytes(identity, header.invocation_limit, rows) <= TOTAL_LIMIT)
  return { identity: header.identity, rows, public: { version: 1, runId: identity.run_id, sourceRef: identity.source_ref,
    invocationLimit: header.invocation_limit, settledCalls, heldCalls,
    available: header.invocation_limit - settledCalls - heldCalls, rows: detached } }
}

export function readAuditJournal(runDir) {
  return guarded(() => {
    const identity = runIdentity(runDir, false)
    const storage = openStorage(runDir, false)
    try {
      return storage.transaction(false, db => {
        const s = snapshot(db)
        need(s.identity === identity, 'CONFLICT')
        return s.public
      })
    }
    finally { storage.close() }
  })
}

export function openAuditJournal(options) {
  return guarded(() => {
    const { runDir, invocationLimit } = fields(options, ['runDir', 'invocationLimit'])
    need(natural(invocationLimit), 'INVALID_JOURNAL_INPUT')
    const identity = runIdentity(runDir)
    const storage = openStorage(runDir, true, db => {
      db.prepare('INSERT INTO header VALUES (1, ?, ?)').run(identity, invocationLimit)
    })
    let closed = false, active = 0
    const live = () => need(!closed, 'CLOSED')
    function bound(db) {
      const s = snapshot(db)
      need(s.identity === identity && s.public.invocationLimit === invocationLimit, 'CONFLICT')
      return s
    }
    const grant = () => need(runIdentity(runDir) === identity, 'CONFLICT')
    try {
      storage.transaction(true, db => {
        bound(db)
        db.prepare("UPDATE attempts SET state='uncertain' WHERE state='dispatched'").run()
      })
    } catch (e) { try { storage.close() } catch { /* Preserve original failure. */ } throw e }
    return {
      prepare(options) {
        return guarded(() => {
          live()
          const { id, input } = fields(options, ['id', 'input'])
          need(validId(id) && record(input), 'INVALID_JOURNAL_INPUT')
          const body = canonical(input)
          grant()
          return storage.transaction(true, db => {
            const s = bound(db), existing = s.rows.findIndex(r => r.id === id)
            if (existing !== -1) {
              need(s.rows[existing].input === body, 'CONFLICT')
              return { created: false, row: s.public.rows[existing] }
            }
            need(s.public.available > 0, 'BUDGET_EXHAUSTED')
            const row = { id, input: body, state: 'prepared', result: null }
            need(s.rows.length < ROW_LIMIT && contentBytes(JSON.parse(identity), invocationLimit, [...s.rows, row]) <= TOTAL_LIMIT, 'INPUT_TOO_LARGE')
            db.prepare("INSERT INTO attempts (id,input,state,result) VALUES (?,?,'prepared',NULL)").run(id, body)
            return { created: true, row: { ...row, input: JSON.parse(body) } }
          })
        })
      },
      async execute(id, invoke) {
        const start = guarded(() => {
          live(); need(validId(id) && typeof invoke === 'function', 'INVALID_JOURNAL_INPUT'); grant()
          return storage.transaction(true, db => {
            const s = bound(db), row = s.public.rows.find(r => r.id === id)
            need(row, 'NOT_FOUND')
            if (['returned', 'failed'].includes(row.state)) return { replayed: true, outcome: row.state, result: row.result }
            need(row.state === 'prepared', 'DISPATCH_UNCERTAIN')
            db.prepare("UPDATE attempts SET state='dispatched' WHERE id=?").run(id)
            return { input: row.input }
          })
        })
        if (start.replayed) return start
        active++
        try {
          let terminal
          try { terminal = terminalEnvelope(await invoke(start.input)) }
          catch { terminal = null }
          return guarded(() => storage.transaction(true, db => {
            const s = bound(db), row = s.rows.find(r => r.id === id)
            need(row?.state === 'dispatched')
            if (terminal) {
              const proposed = s.rows.map(r => r.id === id ? { ...r, ...terminal } : r)
              if (contentBytes(JSON.parse(identity), invocationLimit, proposed) > TOTAL_LIMIT) terminal = null
            }
            db.prepare('UPDATE attempts SET state=?, result=? WHERE id=?').run(terminal?.state ?? 'uncertain', terminal?.result ?? null, id)
            return terminal ? { replayed: false, outcome: terminal.state, result: JSON.parse(terminal.result) } : null
          })) ?? fail('DISPATCH_UNCERTAIN')
        } finally { active-- }
      },
      cancelPrepared(id) {
        return guarded(() => {
          live(); need(validId(id), 'INVALID_JOURNAL_INPUT')
          return storage.transaction(true, db => {
            const row = bound(db).rows.find(r => r.id === id)
            if (!row) return { changed: false }
            need(row.state === 'prepared', 'CONFLICT')
            db.prepare('DELETE FROM attempts WHERE id=?').run(id)
            return { changed: true }
          })
        })
      },
      close() {
        return guarded(() => {
          if (closed) return
          need(active === 0, 'BUSY')
          try { storage.close() } finally { closed = true }
        })
      },
    }
  })
}
