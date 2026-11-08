// audit-ledger-carry.test.mjs - audit-ledger.mjs carry-forward: an earlier run's evidence is carried only while `git diff --quiet`
// says the source it rests on is unchanged; stale evidence is invalidated, never reused; a prior unit recon did not seed is added.
// Earlier runs here are hand-made ledgers and findings that pass both upstream validators, beside throwaway git repos.
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, loadPriors, planWave, seed, sourceUnchanged } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { canonicalCoverageId as canonicalIdOf, validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { audit, fresh, init, mkRepo, sh } from './audit-fixtures.mjs'
import { commitChange, confirmedRecord, ledgerBytes, ledgerValid, needsValidationRecord, priorRun, priorUnit, readJsonFile, readLedger, reconInput, refsOf, rejectedRecord, unitInput } from './ledger-fixtures.mjs'

const FILES = { 'src/app.js': 'export const a = 1\n', 'src/db.js': 'export const q = s => s\n', 'src/a[1].js': 'bracket\n', 'src/a1.js': 'one\n', 'src/old.js': 'old\n', 'docs/guide.md': 'guide\n', 'README.md': '# r\n' }
const names = runDir => Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u]))
const labels = runDir => Object.fromEntries(Object.entries(names(runDir)).map(([k, u]) => [k, u.prior_status]))
const pool = runDir => readJsonFile(runDir, 'candidates.json')
// The prior run's units: one per state upstream's state table has and one per kind of record, all citing src/app.js.
const priorUnits = () => [
  priorUnit('conf', 'candidate', { result_fingerprints: ['fp-conf'] }), priorUnit('nv', 'candidate', { result_fingerprints: ['fp-nv'] }),
  priorUnit('rej', 'candidate', { result_fingerprints: ['fp-rej'] }), priorUnit('cov'), priorUnit('blk', 'blocked'), priorUnit('def', 'deferred'),
  priorUnit('oos', 'out_of_scope'), priorUnit('na', 'not_applicable'), priorUnit('only'),
]
const priorFindings = () => [confirmedRecord('fp-conf'), needsValidationRecord('fp-nv'), rejectedRecord('fp-rej')]
// repo -> prior run -> (optional) change -> a new run at the point `seed` is next. `tamper(priorRunDir)` runs before the new init.
function scenario({ units = priorUnits(), findings = priorFindings(), files = FILES, change, tamper, args = [] } = {}) {
  const repo = mkRepo(files)
  const prior = priorRun(repo, units, findings)
  if (tamper) tamper(prior)
  if (change) commitChange(repo, change)
  const r = init([repo, '--full', ...args])
  assert.ok(r.ok, r.stdout + r.stderr)
  advanceState(r.runDir, 'recon')
  return { repo, prior, runDir: r.runDir }
}
const recon = (extra = []) => reconInput([...['conf', 'nv', 'rej', 'cov', 'blk', 'def', 'oos', 'na', 'fresh'].map(n => unitInput(n)), ...extra])
const setCommit = commit => run => { const f = join(run, 'run-metadata.json'); const m = JSON.parse(readFileSync(f, 'utf8')); m.source_ref.commit = commit; writeFileSync(f, JSON.stringify(m)) }

console.log('== carry-forward: unchanged source is carried')
await test('with the source unchanged, each prior state carries its own label, a confirmed or needs_validation record is carried into a planned unit, and the ledger passes the validator', () => {
  const { runDir, prior } = scenario()
  const out = seed(runDir, recon())
  assert.match(out.summary, /earlier_runs=1 carried_records=2/)
  assert.deepEqual(labels(runDir), {
    conf: 'prior_confirmed_same_source', nv: 'prior_needs_validation', rej: 'prior_covered_same_source', cov: 'prior_covered_same_source', blk: 'prior_blocked',
    def: 'prior_deferred', oos: 'prior_out_of_scope', na: 'new', fresh: 'new', only: 'prior_covered_same_source',
  })
  const u = names(runDir)
  assert.ok(Object.values(u).every(x => x.status === 'planned' && x.agent_id === null && x.reviewed_paths.length === 0 && x.local_checks.length === 0 && x.result_fingerprints.length === 0 && x.unresolved.length === 0), 'a carried unit is planned, with no live evidence of its own')
  assert.deepEqual(u.conf.prior_leads, [{ fingerprint: 'fp-conf', verdict: 'confirmed', carried: true }])
  assert.deepEqual(u.conf.carried_exclusions, [{ fingerprint: 'fp-conf', title: 'Confirmed fp-conf', root_cause: 'fp-conf omits the ownership check.' }])
  assert.deepEqual(u.nv.prior_leads, [{ fingerprint: 'fp-nv', verdict: 'needs_validation', carried: true }])
  assert.equal(u.nv.carried_exclusions, undefined, 'only a confirmed record goes on the hunter exclusion list')
  assert.deepEqual(u.rej.suppressed_claims, ['fp-rej'])
  assert.equal(u.rej.prior_leads, undefined)
  assert.deepEqual([u.cov.prior_evidence.run_id, u.cov.prior_evidence.status, u.cov.prior_evidence.reviewed_paths, u.cov.prior_evidence.local_checks[0].agent_id], ['run-1', 'covered', ['src/app.js'], 'h1-01'])
  assert.equal(u.cov.prior_invalidated, undefined)
  assert.deepEqual([u.only.force_added_from, u.only.status], ['run-1', 'planned'])
  const [c1, c2] = pool(runDir)
  assert.deepEqual([c1.fingerprint, c1.proposed_verdict, c1.units, c1.hunter_ids, c1.carried_from, c1.record.verdict], ['fp-conf', 'confirmed', [u.conf.coverage_id], [], { run_id: 'run-1', commit: readJsonFile(prior, 'run-metadata.json').source_ref.commit }, undefined])
  assert.deepEqual([c2.fingerprint, c2.proposed_verdict, c2.record.title], ['fp-nv', 'needs_validation', 'Lead fp-nv'])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=1')
})
await test('plan-wave leaves a carried unit to its verifier: the hunters get every other planned unit', () => {
  const { runDir } = scenario()
  seed(runDir, recon())
  planWave(runDir)
  const u = names(runDir)
  assert.deepEqual([u.conf, u.nv].map(x => [x.status, x.agent_id]), [['planned', null], ['planned', null]])
  for (const n of ['rej', 'cov', 'blk', 'def', 'oos', 'na', 'fresh', 'only']) assert.deepEqual([n, u[n].status, /^h1-0[12]$/.test(u[n].agent_id)], [n, 'in_progress', true])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1')
})
await test('a change to a file nothing cites leaves everything carried', () => {
  const { runDir } = scenario({ change: { 'README.md': '# changed\n', 'docs/guide.md': 'new guide\n', 'src/brand-new.js': 'x\n' } })
  seed(runDir, recon())
  assert.equal(labels(runDir).conf, 'prior_confirmed_same_source')
  assert.equal(pool(runDir).length, 2)
})

console.log('== carry-forward: changed source is invalidated, never reused')
await test('a commit that edits the cited file turns every record and unit to changed-source work: nothing is carried, no exclusion, no evidence', () => {
  const { runDir } = scenario({ change: { 'src/app.js': 'export const a = 2 // edited\n' } })
  seed(runDir, recon())
  assert.deepEqual(labels(runDir), {
    conf: 'prior_confirmed_changed_source', nv: 'prior_blocked', rej: 'prior_rejected_claim_changed', cov: 'prior_covered_changed_source', blk: 'prior_blocked',
    def: 'prior_deferred', oos: 'prior_out_of_scope', na: 'new', fresh: 'new', only: 'prior_covered_changed_source',
  })
  assert.deepEqual(pool(runDir), [], 'a stale record is not brought in as a candidate')
  const u = names(runDir)
  for (const n of ['conf', 'nv', 'rej', 'cov', 'blk', 'only']) {
    assert.equal(u[n].prior_evidence, undefined, `${n}: stale evidence is not kept`)
    assert.equal(u[n].carried_exclusions, undefined, n)
    assert.equal(u[n].suppressed_claims, undefined, n)
  }
  assert.deepEqual(u.conf.prior_invalidated.fingerprints, ['fp-conf'])
  assert.match(u.conf.prior_invalidated.reason, /the source it rests on changed/)
  assert.deepEqual(u.conf.prior_leads, [{ fingerprint: 'fp-conf', verdict: 'confirmed', carried: false }])
  assert.deepEqual([u.cov.prior_invalidated.run_id, u.cov.prior_invalidated.fingerprints], ['run-1', []])
  assert.equal(u.def.prior_invalidated, undefined, 'a deferred unit had no evidence to invalidate')
  assert.ok(Object.values(u).every(x => x.status === 'planned'))
  assert.ok(ledgerValid(runDir))
  planWave(runDir)
  assert.ok(Object.values(names(runDir)).every(x => x.status === 'in_progress'), 'changed-source units are hunter work, none left to a verifier')
})
await test('a record whose own cited file changed is stale even when its unit\'s paths did not: the unit keeps its evidence, the record is not carried', () => {
  const units = [priorUnit('conf', 'candidate', { result_fingerprints: ['fp-conf'], starting_paths: ['src/db.js'], reviewed_paths: ['src/db.js'] })]
  const { runDir } = scenario({ units, findings: [confirmedRecord('fp-conf', 'src/app.js')], change: { 'src/app.js': 'edited\n' } })
  seed(runDir, reconInput([unitInput('conf', { starting_paths: ['src/db.js'] })]))
  const [u] = readLedger(runDir)
  assert.equal(u.prior_status, 'prior_confirmed_changed_source')
  assert.deepEqual(pool(runDir), [])
  assert.deepEqual([u.prior_evidence.reviewed_paths, u.prior_invalidated.fingerprints], [['src/db.js'], ['fp-conf']])
  assert.equal(u.carried_exclusions, undefined)
})
await test('the boundary file counts as relevant source: editing it stales a unit that only cites it as its boundary', () => {
  const { runDir } = scenario({ units: [priorUnit('cov', 'covered', { starting_paths: ['src/app.js'] })], findings: [], change: { 'src/db.js': 'export const q = s => s + 1\n' } })
  seed(runDir, reconInput([unitInput('cov')]))
  assert.equal(readLedger(runDir)[0].prior_status, 'prior_covered_changed_source')
})
await test('a deleted file is a change, and a new file elsewhere is not', () => {
  const { runDir } = scenario({ units: [priorUnit('cov', 'covered', { starting_paths: ['src/old.js'], reviewed_paths: ['src/old.js'] }), priorUnit('keep')], findings: [], change: { 'src/old.js': null, 'src/other.js': 'x\n' } })
  seed(runDir, reconInput([unitInput('keep')]))
  const u = names(runDir)
  assert.equal(u.keep.prior_status, 'prior_covered_same_source')
  assert.deepEqual([u.cov.status, u.cov.prior_status, u.cov.force_added_from], ['not_applicable', 'prior_covered_changed_source', 'run-1'])
  assert.match(u.cov.unresolved[0], /none of its starting paths is in the audited snapshot; it was a unit of earlier run run-1/)
  assert.ok(ledgerValid(runDir))
})
await test('paths are literal: a change to src/a1.js is not a change to src/a[1].js, and a change to src/a[1].js is', () => {
  const unit = () => [priorUnit('cov', 'covered', { starting_paths: ['src/a[1].js'], reviewed_paths: ['src/a[1].js'] })]
  const globby = scenario({ units: unit(), findings: [], change: { 'src/a1.js': 'changed one\n' } })
  seed(globby.runDir, reconInput([unitInput('cov', { starting_paths: ['src/a[1].js'] })]))
  assert.equal(readLedger(globby.runDir)[0].prior_status, 'prior_covered_same_source')
  const real = scenario({ units: unit(), findings: [], change: { 'src/a[1].js': 'changed bracket\n' } })
  seed(real.runDir, reconInput([unitInput('cov', { starting_paths: ['src/a[1].js'] })]))
  assert.equal(readLedger(real.runDir)[0].prior_status, 'prior_covered_changed_source')
})
await test('a prior commit this clone does not have counts as changed; a value that is not a commit ID never reaches git, even when prior-runs.json is edited after init', () => {
  const marker = join(fresh('hostile'), 'written-by-git')
  const absent = scenario({ tamper: setCommit('a'.repeat(40)) })
  seed(absent.runDir, recon())
  assert.equal(labels(absent.runDir).conf, 'prior_confirmed_changed_source', 'a well-formed commit this clone lacks')
  assert.deepEqual(pool(absent.runDir), [])
  for (const commit of ['a'.repeat(40), 'abc123', 'main', '', null, `--output=${marker}`, '-p', 'A'.repeat(40), 7, ['a'.repeat(40)]]) {
    // init refuses to call such a run compatible (so a hostile value is never carried); the file it writes is still a file on disk.
    const { runDir } = scenario({ tamper: setCommit('b'.repeat(40)) })
    const file = join(runDir, 'prior-runs.json')
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map(p => ({ ...p, source_commit: commit }))))
    seed(runDir, recon())
    assert.equal(labels(runDir).conf, 'prior_confirmed_changed_source', String(commit))
    assert.deepEqual(pool(runDir), [], String(commit))
    assert.ok(ledgerValid(runDir))
  }
  assert.ok(!existsSync(marker), 'a prior run\'s metadata never reaches git as an option')
  for (const commit of ['abc123', `--output=${marker}`, 7, ['b'.repeat(40)]]) {
    const { runDir } = scenario({ tamper: setCommit(commit) })
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'prior-runs.json'), 'utf8')).map(p => p.compatible), [false], `init: ${JSON.stringify(commit)}`)
    seed(runDir, recon())
    assert.equal(labels(runDir).conf, 'none', 'no compatible earlier run: the unit starts as new work with no prior label')
    assert.deepEqual(pool(runDir), [], 'an incompatible run carries nothing')
  }
})
await test('sourceUnchanged: same bytes only; an empty path list, a missing repository and an unknown commit are never "same"', () => {
  const repo = mkRepo({ 'a.txt': '1\n', 'b.txt': '1\n' })
  const first = sh(repo, 'rev-parse', 'HEAD')
  const second = commitChange(repo, { 'b.txt': '2\n' })
  assert.equal(sourceUnchanged(repo, first, second, ['a.txt']), true)
  assert.equal(sourceUnchanged(repo, first, second, ['b.txt']), false)
  assert.equal(sourceUnchanged(repo, first, second, ['a.txt', 'b.txt']), false)
  assert.equal(sourceUnchanged(repo, first, second, ['no-such-file']), true, 'a path in neither commit did not change')
  assert.equal(sourceUnchanged(repo, first, first, ['b.txt']), true)
  assert.equal(sourceUnchanged(repo, first, second, []), false, 'git reads an empty path list as the whole tree')
  assert.equal(sourceUnchanged(repo, first, second, [null, '', 7]), false)
  assert.equal(sourceUnchanged(repo, 'f'.repeat(40), second, ['a.txt']), false)
  assert.equal(sourceUnchanged(repo, [first], second, ['a.txt']), false, 'a one-element array coerces to its string: a regex test alone would call it a commit')
  assert.equal(sourceUnchanged(repo, first, { toString: () => second }, ['a.txt']), false, 'so does an object with a toString')
  assert.equal(sourceUnchanged(join(repo, 'nowhere'), first, second, ['a.txt']), false)
  const many = Array.from({ length: 450 }, (_, i) => `absent/${i}.txt`)
  assert.equal(sourceUnchanged(repo, first, second, many), true)
  assert.equal(sourceUnchanged(repo, first, second, [...many, 'b.txt']), false, 'a change in the last chunk of paths is found')
})

console.log('== carry-forward: units, priors and records')
await test('a prior unit recon did not seed is added planned and ranked as a gap; one with its paths gone is not_applicable with the reason; not_applicable priors are not carried', () => {
  const { runDir } = scenario({ units: [priorUnit('only', 'blocked'), priorUnit('na', 'not_applicable'), priorUnit('vanished', 'covered', { starting_paths: ['src/old.js'], reviewed_paths: ['src/old.js'] })], findings: [], change: { 'src/old.js': null } })
  seed(runDir, reconInput([unitInput('fresh')]))
  const u = names(runDir)
  assert.deepEqual(Object.keys(u).sort(), ['fresh', 'only', 'vanished'])
  assert.deepEqual([u.only.status, u.only.prior_status, u.only.force_added_from, u.only.priority_class, u.fresh.prior_status], ['planned', 'prior_blocked', 'run-1', 2, 'new'])
  assert.deepEqual([u.vanished.status, u.vanished.agent_id, u.vanished.unresolved.length], ['not_applicable', null, 1])
  assert.ok(ledgerValid(runDir))
})
await test('an out_of_scope or scoped run keeps its states: a carried record is not carried into a unit this run\'s scope excludes', () => {
  const { runDir } = scenario({ args: ['--scope', 'docs'] })
  seed(runDir, recon())
  const u = names(runDir)
  assert.deepEqual([u.conf.status, u.conf.prior_status, u.conf.prior_leads[0].carried], ['out_of_scope', 'prior_confirmed_same_source', false])
  assert.deepEqual(pool(runDir), [], 'an out_of_scope unit has no verifier')
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
})
await test('two units that carry one fingerprint are one candidate with both units; a lead with no record in findings.json is a gap to hunt, kept as a lead, never dropped', () => {
  const units = [priorUnit('a', 'candidate', { result_fingerprints: ['fp-shared'] }), priorUnit('b', 'candidate', { result_fingerprints: ['fp-shared'] }), priorUnit('c', 'candidate', { result_fingerprints: ['fp-unrecorded'] })]
  const { runDir } = scenario({ units, findings: [needsValidationRecord('fp-shared')] })
  seed(runDir, reconInput([unitInput('a'), unitInput('b'), unitInput('c')]))
  const [only] = pool(runDir)
  assert.equal(pool(runDir).length, 1)
  assert.deepEqual([only.fingerprint, only.units.length], ['fp-shared', 2])
  const u = names(runDir)
  assert.equal(u.c.prior_status, 'prior_blocked', 'an unvalidated lead is a prior gap: upstream keeps it an unresolved candidate')
  assert.deepEqual(u.c.prior_leads, [{ fingerprint: 'fp-unrecorded', verdict: null, carried: false }])
  assert.equal(pool(runDir).length, 1, 'there is no record to carry, only the fingerprint')
})
await test('when two earlier runs hold the same unit, the later run is the one used', () => {
  const repo = mkRepo(FILES)
  priorRun(repo, [priorUnit('x', 'covered')], [])
  priorRun(repo, [priorUnit('x', 'blocked')], [])
  const r = init([repo, '--full'])
  advanceState(r.runDir, 'recon')
  seed(r.runDir, reconInput([unitInput('x')]))
  assert.equal(readLedger(r.runDir)[0].prior_status, 'prior_blocked')
  assert.equal(readJsonFile(r.runDir, 'prior-runs.json').length, 2)
})
await test('an explicit --prior run outside the repository\'s own runs is carried the same way', () => {
  const repo = mkRepo(FILES)
  const prior = priorRun(repo, [priorUnit('x', 'blocked')], [], ['--out', join(fresh('prior-out'), 'run-1')])
  const r = init([repo, '--full', '--prior', prior])
  assert.ok(r.ok, r.stdout + r.stderr)
  advanceState(r.runDir, 'recon')
  const entry = readJsonFile(r.runDir, 'prior-runs.json').find(p => p.path === prior)
  assert.deepEqual([entry.source, entry.compatible], ['--prior', true])
  seed(r.runDir, reconInput([unitInput('x')]))
  const [u] = readLedger(r.runDir)
  assert.deepEqual([u.prior_status, u.prior_evidence.status, u.prior_evidence.run_id], ['prior_blocked', 'blocked', 'run-1'])
})

console.log('== carry-forward: found by an independent audit, each reproduced by a failing test first')
await test('a later run that never closed or never saw a unit does not erase an earlier run\'s confirmed record on it', () => {
  const repo = mkRepo(FILES)
  priorRun(repo, [priorUnit('conf', 'candidate', { result_fingerprints: ['fp-conf'] })], [confirmedRecord('fp-conf')])
  priorRun(repo, [priorUnit('conf', 'out_of_scope')], [])
  const r = init([repo, '--full'])
  advanceState(r.runDir, 'recon')
  seed(r.runDir, reconInput([unitInput('conf')]))
  const [u] = readLedger(r.runDir)
  assert.deepEqual([u.prior_status, u.prior_leads, pool(r.runDir).map(c => c.fingerprint)], ['prior_confirmed_same_source', [{ fingerprint: 'fp-conf', verdict: 'confirmed', carried: true }], ['fp-conf']])
  assert.equal(u.carried_exclusions.length, 1)
})
await test('a record the later run re-verified replaces the earlier run\'s for the same fingerprint, and records on one unit from two runs are both carried', () => {
  const repo = mkRepo(FILES)
  priorRun(repo, [priorUnit('conf', 'candidate', { result_fingerprints: ['fp-a', 'fp-same'] })], [confirmedRecord('fp-a'), confirmedRecord('fp-same')])
  priorRun(repo, [priorUnit('conf', 'candidate', { result_fingerprints: ['fp-b', 'fp-same'] })], [needsValidationRecord('fp-b'), needsValidationRecord('fp-same')])
  const r = init([repo, '--full'])
  advanceState(r.runDir, 'recon')
  seed(r.runDir, reconInput([unitInput('conf')]))
  assert.deepEqual(pool(r.runDir).map(c => [c.fingerprint, c.proposed_verdict, c.carried_from.run_id]), [['fp-a', 'confirmed', 'run-1'], ['fp-b', 'needs_validation', 'run-2'], ['fp-same', 'needs_validation', 'run-2']])
})
await test('prior units that differ only in source ref from a seeded unit are the same unit, not a collision that refuses the seed for good', () => {
  const renamed = { ...priorUnit('moved', 'covered'), canonical_refs: refsOf('old-name') }
  renamed.coverage_id = canonicalIdOf(renamed.canonical_refs)
  renamed.surface = 'Route moved'   // the label recon will use again
  const { runDir } = scenario({ units: [renamed], findings: [] })
  const out = seed(runDir, reconInput([unitInput('moved')]))
  const units = readLedger(runDir)
  assert.equal(units.length, 1, 'one semantic tuple is one unit')
  assert.equal(units[0].canonical_refs.surface, 'src/app.js#moved', 'the refs recon derived win')
  assert.deepEqual([units[0].prior_status, units[0].prior_evidence?.run_id], ['prior_covered_same_source', 'run-1'])
  assert.match(out.notes.join('\n'), /matched this run's unit .* by its labels/)
  assert.ok(ledgerValid(runDir))
})
await test('a unit with a carried record and a changed one is hunted, and the carried record is not left in the pool with no verifier to own it', () => {
  const units = [priorUnit('mixed', 'candidate', { result_fingerprints: ['fp-conf', 'fp-nv'], starting_paths: ['src/db.js'], reviewed_paths: ['src/db.js'] })]
  const { runDir } = scenario({ units, findings: [confirmedRecord('fp-conf', 'src/db.js'), needsValidationRecord('fp-nv', 'src/app.js')], change: { 'src/app.js': 'edited\n' } })
  seed(runDir, reconInput([unitInput('mixed', { starting_paths: ['src/db.js'] })]))
  const [u] = readLedger(runDir)
  assert.equal(u.prior_status, 'prior_blocked')
  assert.deepEqual(u.prior_leads.map(l => [l.fingerprint, l.carried]), [['fp-conf', false], ['fp-nv', false]])
  assert.equal(u.carried_exclusions, undefined, 'a root cause is excluded from hunters only when its record is carried')
  assert.deepEqual(pool(runDir), [])
  planWave(runDir)
  assert.equal(readLedger(runDir)[0].status, 'in_progress')
})
await test('a changed rejected claim is current work even beside a carried record: the unit is hunted', () => {
  const units = [priorUnit('both', 'candidate', { result_fingerprints: ['fp-conf', 'fp-rej'], starting_paths: ['src/db.js'], reviewed_paths: ['src/db.js'] })]
  const { runDir } = scenario({ units, findings: [confirmedRecord('fp-conf', 'src/db.js'), rejectedRecord('fp-rej', 'src/app.js')], change: { 'src/app.js': 'edited\n' } })
  seed(runDir, reconInput([unitInput('both', { starting_paths: ['src/db.js'] })]))
  assert.equal(readLedger(runDir)[0].prior_status, 'prior_rejected_claim_changed')
  assert.deepEqual(pool(runDir), [])
})
await test('a replace ref cannot make edited source look unchanged: git is run without replacement objects', () => {
  const repo = mkRepo({ 'a.txt': '1\n' })
  const first = sh(repo, 'rev-parse', 'HEAD')
  const second = commitChange(repo, { 'a.txt': '2\n' })
  assert.equal(sourceUnchanged(repo, first, second, ['a.txt']), false)
  sh(repo, 'replace', second, first)   // refs/replace/<second> -> <first>: plain git now reads <second> as <first>
  assert.equal(sh(repo, 'show', `${second}:a.txt`), '1', 'the probe: without --no-replace-objects git sees the old bytes')
  assert.equal(sourceUnchanged(repo, first, second, ['a.txt', 'a.txt ']), false, 'the replace ref did not hide the edit')
})

console.log('== carry-forward: earlier runs that do not validate are never read as empty')
await test('a prior run that failed upstream\'s validators at init is recorded incompatible and contributes nothing: every unit is none, not new', () => {
  const { runDir, prior } = scenario({ tamper: run => writeFileSync(join(run, 'coverage-ledger.json'), '[{"not":"a unit"}]') })
  assert.equal(readJsonFile(runDir, 'prior-runs.json')[0].compatible, false)
  const out = seed(runDir, recon())
  assert.ok(!/earlier_runs/.test(out.summary))
  assert.ok(Object.values(labels(runDir)).every(l => l === 'none'))
  assert.deepEqual(pool(runDir), [])
  assert.equal(validateLedgerFile(join(prior, 'coverage-ledger.json')).valid, false)
})
await test('a prior run that was compatible at init and was damaged since is skipped and said, not treated as empty', () => {
  const { runDir, prior } = scenario()
  writeFileSync(join(prior, 'findings.json'), '[{"verdict": "rejected"}]')
  const out = seed(runDir, recon())
  assert.match(out.notes.join('\n'), /earlier run run-1 no longer validates; it is skipped, not treated as empty coverage/)
  assert.ok(Object.values(labels(runDir)).every(l => l === 'none'))
  assert.equal(validateFindingsFile(join(prior, 'findings.json')).valid, false)
  assert.deepEqual(loadPriors(runDir, []).length, 0)
})
await test('a prior ledger damaged after init is skipped and said, not read: no garbage unit reaches the new ledger', () => {
  const { runDir, prior } = scenario()
  writeFileSync(join(prior, 'coverage-ledger.json'), JSON.stringify([{ coverage_id: 'x', status: 'covered' }]))
  const out = seed(runDir, recon())
  assert.match(out.notes.join('\n'), /earlier run run-1 no longer validates/)
  assert.ok(Object.values(labels(runDir)).every(l => l === 'none'))
  assert.equal(readLedger(runDir).length, 9)
  assert.ok(ledgerValid(runDir))
})
await test('a prior run without a findings.json (it stopped before Phase 4) still carries its units, with no records', () => {
  const repo = mkRepo(FILES)
  const prior = priorRun(repo, [priorUnit('cov')], [])
  rmSync(join(prior, 'findings.json'))
  const r = init([repo, '--full'])
  advanceState(r.runDir, 'recon')
  seed(r.runDir, reconInput([unitInput('cov')]))
  assert.equal(readLedger(r.runDir)[0].prior_status, 'prior_covered_same_source')
})

console.log('== carry-forward: the critic and what it adds')
await test('a lead carried from an earlier run can be resolved by the critic, and a unit minted in a run with earlier runs is new', () => {
  const { runDir } = scenario()
  seed(runDir, recon())
  advanceState(runDir, 'plan-wave', { wave: 1 })
  advanceState(runDir, 'hunt'); advanceState(runDir, 'merge-wave'); advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint')
  const before = ledgerBytes(runDir)
  const out = applyCritic(runDir, { missing_units: [{}], reassign_ids: [], resolved_prior_leads: ['fp-conf', 'fp-nv'], stop: false }, { units: [unitInput('late', { reason: 'a gap' })] })
  assert.match(out.summary, /units_added=1 .*resolved=2/)
  const u = names(runDir)
  assert.deepEqual([u.late.prior_status, u.conf.prior_leads[0].resolved, u.nv.prior_leads[0].resolved.by], ['new', { by: 'post-wave critic of wave 1', wave: 1 }, 'post-wave critic of wave 1'])
  assert.notEqual(ledgerBytes(runDir), before)
  assert.ok(ledgerValid(runDir))
})
await test('without earlier runs a minted unit is none', () => {
  const run = scenario({ tamper: run => writeFileSync(join(run, 'coverage-ledger.json'), '[]x') })
  seed(run.runDir, recon())
  advanceState(run.runDir, 'plan-wave', { wave: 1 })
  advanceState(run.runDir, 'hunt'); advanceState(run.runDir, 'merge-wave'); advanceState(run.runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(run.runDir, 'mint')
  applyCritic(run.runDir, { missing_units: [{}], reassign_ids: [], resolved_prior_leads: [], stop: false }, { units: [unitInput('late', { reason: 'a gap' })] })
  assert.equal(names(run.runDir).late.prior_status, 'none')
})
