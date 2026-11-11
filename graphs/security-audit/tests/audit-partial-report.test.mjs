import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, lstatSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import * as api from '../skills/security-audit/audit-report.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { META, STATE, NV, RJ, UNIT, DECISIONS } from './report-fixtures.mjs'
import { validateLedgerDocument, validateFindingsDocument } from '../skills/security-audit/upstream.mjs'

// Inert owning data and local journal only: no target tree, subprocess or provider.
async function fixture(check) {
  const dir = mkdtempSync(join(tmpdir(), 'partial-report-'))
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value))
  put('run-metadata.json', META({ run_status: 'in_progress' }))
  put('stage-state.json', STATE({ last: 'init', critic_kind: null }))
  const journal = openAuditJournal({ runDir: dir, invocationLimit: 8 })
  const before = ['run-metadata.json', 'stage-state.json'].map(n => readFileSync(join(dir, n)))
  try { await check({ dir, put, journal, context: () => api.partialReportContext(dir), publish: () => api.publishPartialReport(dir), read: () => api.readPartialReport(dir) }) }
  finally {
    journal.close()
    // Tests that alter authority explicitly restore it before returning.
    for (const [i, n] of ['run-metadata.json', 'stage-state.json'].entries()) assert.deepEqual(readFileSync(join(dir, n)), before[i])
    rmSync(dir, { recursive: true, force: true })
  }
}
const accepted = result => { assert.ok(['published', 'replayed'].includes(result.status), JSON.stringify(result)); return result }
const putLeads = x => {
  const records = [NV('nv'), RJ('rj')]
  assert.deepEqual(validateFindingsDocument(records), [])
  const ledger = [UNIT('a', 'candidate', { result_fingerprints: ['nv', 'rj'] })]
  assert.deepEqual(validateLedgerDocument(ledger), [])
  x.put('coverage-ledger.json', ledger)
  x.put('candidates.json', records.map(r => ({ fingerprint: r.fingerprint, proposed_verdict: 'needs_validation', hunter_ids: ['h1-01'], units: [ledger[0].coverage_id], record: r })))
  return { records, ledger }
}

await test('partial checkpoint preserves receipts and distinguishes held, returned, failed and unknown work', () => fixture(async x => {
  for (const id of ['returned', 'failed', 'held', 'uncertain']) x.journal.prepare({ id, input: { role: 'analyst', prompt: 'PRIVATE PROMPT' } })
  await x.journal.execute('returned', () => ({ outcome: 'returned', result: { verdict: 'confirmed', fingerprint: 'invented' } }))
  await x.journal.execute('failed', () => ({ outcome: 'failed', result: { code: 'ORDINARY_FAILURE' } }))
  await assert.rejects(x.journal.execute('uncertain', () => { throw Error('PRIVATE ERROR') }))
  const before = readAuditJournal(x.dir), c = x.context(), out = accepted(x.publish())
  assert.deepEqual(c.journal.states, { prepared: 1, dispatched: 0, returned: 1, failed: 1, uncertain: 1 })
  assert.equal(c.journal.pendingAgents, 2)
  assert.equal(c.journal.settledCalls, 2)
  assert.equal(c.journal.available, 4)
  const text = readFileSync(out.currentPath, 'utf8')
  for (const s of ['PARTIAL', 'NOT FINAL', c.identity.sourceRef.tree, c.generationKey, 'unknown', 'returned']) assert.ok(text.includes(s), s)
  for (const s of ['PRIVATE PROMPT', 'PRIVATE ERROR', 'invented']) assert.equal(text.includes(s), false)
  assert.deepEqual(readAuditJournal(x.dir), before)
  assert.equal(x.read().status, 'current')
  assert.equal(x.publish().status, 'replayed')
}))

await test('partial leads retain every fingerprint and validated dispositions without raw-result promotion', () => fixture(x => {
  const { records } = putLeads(x)
  x.put('decisions.json', DECISIONS(records.map((r, i) => ({ fingerprint: r.fingerprint, n: i + 1, decision: r.verdict, record: r, verifier_id: `v${i + 1}` }))))
  x.put('findings.json', records)
  const c = x.context()
  assert.deepEqual(c.leads.map(l => [l.fingerprint, l.disposition]), [['nv', 'needs_validation'], ['rj', 'rejected']])
  assert.deepEqual(c.leads[0].blockers, records[0].blockers)
  assert.equal(c.coverage.counts.candidate, 1)
  x.put('decisions.json', { entries: 'bad' })
  rmSync(join(x.dir, 'findings.json'))
  const bad = x.context()
  assert.ok(bad.leads.every(l => l.disposition === 'pending'))
  assert.ok(bad.blockers.some(b => b.artifact === 'decisions.json'))
}))

await test('all bound artifact changes stale a publication while unbound history is ignored', () => fixture(x => {
  for (const name of ['run-metadata.json', 'stage-state.json', 'coverage-ledger.json', 'candidates.json', 'decisions.json', 'critic.json', 'findings.json']) {
    const old = accepted(x.publish())
    let before
    try { before = readFileSync(join(x.dir, name)) } catch { before = null }
    try {
      if (before) writeFileSync(join(x.dir, name), Buffer.concat([before, Buffer.from(' ')]))
      else x.put(name, name === 'critic.json' ? { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true } : [])
      assert.equal(x.read().status, 'stale', name)
      assert.notEqual(x.read().expectedGenerationKey, old.generationKey)
    } finally { if (before) writeFileSync(join(x.dir, name), before); else rmSync(join(x.dir, name)) }
  }
  const before = x.context()
  for (const name of ['prior-runs.json', 'events.jsonl', 'architecture.md']) writeFileSync(join(x.dir, name), 'UNBOUND PROSE')
  assert.deepEqual(x.context(), before)
}))

await test('malformed optional evidence is bound and rejected; journal unavailability never becomes zero or current', () => fixture(x => {
  const old = accepted(x.publish())
  writeFileSync(join(x.dir, 'coverage-ledger.json'), '[broken')
  const c = x.context()
  assert.equal(c.coverage.status, 'rejected')
  assert.equal(c.coverage.counts, null)
  assert.equal(c.journal.status, 'unavailable')
  assert.equal(c.journal.pendingAgents, null)
  assert.ok(c.blockers.some(b => b.code === 'JOURNAL_UNAVAILABLE'))
  assert.notEqual(accepted(x.publish()).generationKey, old.generationKey)
  assert.equal(x.read().status, 'invalid')
  assert.equal(x.read().expectedGenerationKey, null)
}))

await test('ordinary output conflict preserves receipt and render-only recovery does not dispatch', () => fixture(async x => {
  let calls = 0
  x.journal.prepare({ id: 'leaf', input: {} })
  await x.journal.execute('leaf', () => { calls++; return { outcome: 'returned', result: 'saved' } })
  const dir = join(x.dir, 'partial-reports')
  writeFileSync(dir, 'ordinary conflict')
  assert.equal(x.publish().reason, 'IO_ERROR')
  assert.equal(readFileSync(dir, 'utf8'), 'ordinary conflict')
  rmSync(dir)
  accepted(x.publish())
  assert.equal((await x.journal.execute('leaf', () => { calls++; throw Error('never') })).replayed, true)
  assert.equal(calls, 1)
}))

await test('generation corruption refuses replay and a failed new generation leaves prior pointer stale', () => fixture(x => {
  const a = accepted(x.publish())
  x.journal.prepare({ id: 'later', input: {} })
  const path = join(x.dir, 'partial-reports', x.context().generationKey + '.md')
  mkdirSync(path)
  assert.equal(x.publish().reason, 'IO_ERROR')
  assert.equal(x.read().status, 'stale')
  assert.equal(x.read().generationKey, a.generationKey)
  rmSync(path, { recursive: true })
  const b = accepted(x.publish())
  writeFileSync(b.currentPath, 'tampered')
  assert.equal(x.read().status, 'invalid')
  assert.equal(x.publish().reason, 'CORRUPT')
  assert.equal(readFileSync(b.currentPath, 'utf8'), 'tampered')
}))

await test('private output policy refuses unsafe modes and static symlink destinations without adoption', () => fixture(x => {
  const dir = join(x.dir, 'partial-reports')
  mkdirSync(dir, { mode: 0o755 })
  assert.equal(x.publish().status, 'failed')
  assert.equal(lstatSync(dir).mode & 0o777, 0o755)
  rmSync(dir, { recursive: true })
  const other = join(x.dir, 'ordinary-other'); mkdirSync(other)
  symlinkSync(other, dir)
  assert.equal(x.publish().status, 'failed')
  assert.equal(lstatSync(dir).isSymbolicLink(), true)
  rmSync(dir)
  const out = accepted(x.publish())
  chmodSync(out.currentPath, 0o644)
  assert.equal(x.read().status, 'invalid')
  assert.equal(x.publish().status, 'failed')
}))

await test('missing or incompatible required authority cannot publish unidentified progress', () => fixture(x => {
  for (const name of ['stage-state.json', 'run-metadata.json']) {
    const before = readFileSync(join(x.dir, name))
    try {
      rmSync(join(x.dir, name))
      assert.throws(x.context, e => e.code === 'INVALID_CONTEXT')
      assert.deepEqual(x.publish(), { status: 'failed', generationKey: null, currentPath: null, reason: 'INVALID_CONTEXT' })
      assert.deepEqual(x.read(), { status: 'invalid', generationKey: null, expectedGenerationKey: null, path: null })
    } finally { writeFileSync(join(x.dir, name), before) }
  }
  const before = readFileSync(join(x.dir, 'run-metadata.json'))
  try {
    x.put('run-metadata.json', { ...JSON.parse(before), run_id: 'different-run' })
    assert.throws(x.context, e => e.code === 'INVALID_CONTEXT')
  } finally { writeFileSync(join(x.dir, 'run-metadata.json'), before) }
}))

await test('pure partial renderer rejects accessors, proxies, malformed shapes and cycles without hooks', () => fixture(x => {
  const c = x.context(); let hooks = 0
  const getter = { ...c }; Object.defineProperty(getter, 'leads', { enumerable: true, get() { hooks++; return [] } })
  const proxy = new Proxy(c, { ownKeys() { hooks++; throw Error('trap') } })
  const cycle = { ...c }; cycle.leads = [cycle]
  for (const value of [getter, proxy, cycle, null, { ...c, leads: [{}] }, { ...c, journal: {} }]) assert.throws(() => api.buildPartialReport(value), e => e.code === 'INVALID_CONTEXT')
  assert.equal(hooks, 0)
  c.blockers.push({ code: 'ARTIFACT_REJECTED', artifact: 'candidates.json', message: '<script>inert</script>\n[link](javascript:inert)' })
  const before = structuredClone(c), a = api.buildPartialReport(c)
  assert.equal(a, api.buildPartialReport(c))
  assert.deepEqual(c, before)
  assert.equal(a.includes('<script>'), false)
  assert.equal(a.includes('[link](javascript:inert)'), false)
}))

await test('partial binding retains more than 1MiB of journal data without exposing raw payloads', () => fixture(async x => {
  for (const id of ['one', 'two']) {
    x.journal.prepare({ id, input: { prompt: 'x'.repeat(300000) } })
    await x.journal.execute(id, () => ({ outcome: 'returned', result: 'y'.repeat(300000) }))
  }
  const c = x.context(), out = accepted(x.publish())
  assert.equal(c.journal.states.returned, 2)
  assert.ok(readFileSync(out.currentPath).length < 10000)
  assert.equal(x.read().status, 'current')
}))

await test('oversized optional inputs are hashed without content and cannot bypass journal admission bounds', () => fixture(x => {
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 32)
  writeFileSync(join(x.dir, 'coverage-ledger.json'), oversized)
  const c = x.context()
  assert.equal(c.binding.artifacts['coverage-ledger.json'].state, 'oversized')
  assert.equal(c.binding.artifacts['coverage-ledger.json'].observedBytes, oversized.length)
  assert.match(c.binding.artifacts['coverage-ledger.json'].sha256, /^[0-9a-f]{64}$/)
  assert.equal(c.coverage.counts, null)
  assert.equal(c.journal.status, 'unavailable')
  accepted(x.publish())
  assert.equal(x.read().status, 'invalid')
}))

await test('partial body limit refuses expansion without dropping pending fingerprints', () => fixture(x => {
  const c = x.context()
  c.leads.push({ fingerprint: 'must-retain', disposition: 'pending', title: '<'.repeat(5 * 1024 * 1024), units: [], blockers: [] })
  assert.throws(() => api.buildPartialReport(c), e => e.code === 'REPORT_TOO_LARGE')
  assert.equal(c.leads[0].fingerprint, 'must-retain')
}))

await test('malformed and path-directed pointer or manifest is invalid and cannot be adopted', () => fixture(x => {
  const out = accepted(x.publish()), dir = join(x.dir, 'partial-reports'), pointer = join(dir, 'current.json')
  const original = readFileSync(pointer)
  for (const contents of ['broken', JSON.stringify({ version: 1, generationKey: out.generationKey, manifest: '../outside.json' }), ' '.repeat(65537)]) {
    writeFileSync(pointer, contents)
    assert.equal(x.read().status, 'invalid')
    assert.equal(x.publish().reason, 'CORRUPT')
    assert.equal(readFileSync(pointer, 'utf8'), contents)
  }
  writeFileSync(pointer, original)
  const manifest = join(dir, out.generationKey + '.json')
  const before = readFileSync(manifest), bad = JSON.parse(before); bad.bytes++
  writeFileSync(manifest, JSON.stringify(bad))
  assert.equal(x.read().status, 'invalid')
  assert.equal(x.publish().reason, 'CORRUPT')
  writeFileSync(manifest, before)
  assert.equal(x.read().status, 'current')
}))

await test('valid shape with inconsistent decision record is rejected without resolving pending leads', () => fixture(x => {
  const { records } = putLeads(x)
  x.put('decisions.json', DECISIONS([{ fingerprint: 'nv', n: 1, decision: 'rejected', record: records[0], verifier_id: 'v1' }]))
  const c = x.context()
  assert.ok(c.blockers.some(b => b.code === 'ARTIFACT_REJECTED' && b.artifact === 'decisions.json'))
  assert.ok(c.leads.every(l => l.disposition === 'pending'))
}))

await test('terminal run status and first reason remain distinct from partial completeness', () => fixture(x => {
  const file = join(x.dir, 'run-metadata.json'), before = readFileSync(file)
  try {
    x.put('run-metadata.json', { ...JSON.parse(before), run_status: 'incomplete', incomplete_reason: 'first_reason' })
    const out = accepted(x.publish())
    assert.match(readFileSync(out.currentPath, 'utf8'), /first\\_reason/)
    assert.equal(x.context().runStatus, 'incomplete')
    assert.equal(JSON.parse(readFileSync(file)).incomplete_reason, 'first_reason')
    assert.equal(x.read().status, 'current')
  } finally { writeFileSync(file, before) }
}))

await test('candidate record identity mismatch rejects the artifact without inventing a lead', () => fixture(x => {
  putLeads(x)
  const path = join(x.dir, 'candidates.json'), pool = JSON.parse(readFileSync(path))
  pool[0].record.fingerprint = 'different-record'
  x.put('candidates.json', pool)
  const c = x.context()
  assert.deepEqual(c.leads, [])
  assert.ok(c.blockers.some(b => b.artifact === 'candidates.json' && b.code === 'ARTIFACT_REJECTED'))
  assert.equal(c.binding.artifacts['candidates.json'].state, 'rejected')
}))

await test('historical confirmed records stay outside provisional leads and preserve their source reference', () => fixture(async x => {
  const { CF } = await import('./report-fixtures.mjs')
  const record = CF('old-confirmation')
  assert.deepEqual(validateFindingsDocument([record]), [])
  x.put('findings.json', [record])
  const c = x.context()
  assert.deepEqual(c.leads, [])
  assert.deepEqual(c.historicalFinalRecords, [{ fingerprint: 'old-confirmation', artifact: 'findings.json' }])
  const text = api.buildPartialReport(c)
  assert.match(text, /historical-final-record: old-confirmation \(findings.json\)/)
  assert.match(text, /no new partial confirmation/)
}))

await test('an interrupted generation pair is historical until manifest recovery and pointer-last publication', () => fixture(x => {
  const a = accepted(x.publish())
  x.journal.prepare({ id: 'later', input: {} })
  const key = x.context().generationKey, dir = join(x.dir, 'partial-reports'), manifest = join(dir, key + '.json')
  mkdirSync(manifest)
  assert.equal(x.publish().reason, 'IO_ERROR')
  const partialMarkdown = readFileSync(join(dir, key + '.md'))
  assert.equal(x.read().status, 'stale')
  assert.equal(x.read().generationKey, a.generationKey)
  rmSync(manifest, { recursive: true })
  accepted(x.publish())
  assert.deepEqual(readFileSync(join(dir, key + '.md')), partialMarkdown)
  assert.equal(x.read().status, 'current')
  assert.equal(x.read().generationKey, key)
}))
