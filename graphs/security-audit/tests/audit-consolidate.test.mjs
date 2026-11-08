// audit-consolidate.test.mjs - the consolidate stage (audit-verdicts.mjs, wired in audit-stage.mjs): the rule for a grouping, the input, the stage end to end with
// the real vendored validator on the ledger, a grouping discarded, the crash window, the skips, and the aliases a merge leaves for an archived attempt.
// The workflow side is in security-audit-verdicts.test.mjs.
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { MAX_CONSOLIDATE_BYTES, consolidateInput, groupingProblems, readPool } from '../skills/security-audit/audit-verdicts.mjs'
import { applyCritic, mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState, loadRun, recordSpend } from '../skills/security-audit/audit-run.mjs'
import { parts, resolve as block } from '../skills/security-audit/blocks.mjs'
import { audit, meta } from './audit-fixtures.mjs'
import { candidateOf, hunterResult, hunterUnit, ledgerBytes, ledgerValid, needsValidationRecord, priorRun, priorUnit, readJsonFile, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'
import { files, fuzzApply, returnedFile, runScript, runStage, snapshot, restore, stage, stageDirs } from './stage-fixtures.mjs'
import { atValidation, closeCoverage, events, next, pool, unitByName } from './verdict-fixtures.mjs'

const GROUPS = (...gs) => gs.map(([keep, merge = [], reason = merge.length ? 'one missing owner check' : '']) => ({ keep, merge, reason }))
const poolOf = fps => fps.map(fingerprint => ({ fingerprint, proposed_verdict: 'needs_validation', hunter_ids: ['h1-01'], units: ['u'], record: {} }))
const ok = runDir => { assert.ok(ledgerValid(runDir), 'upstream\'s validator passes the ledger'); assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`) }

console.log('== a grouping is applied only if it covers every fingerprint exactly once')
await test('a grouping that names every candidate once, as a keep or in a merge list, has no problem; singletons are groups of their own', () => {
  const pool = poolOf(['a', 'b', 'c', 'd'])
  assert.deepEqual(groupingProblems(pool, GROUPS(['a', ['b']], ['c', ['d']])), [])
  assert.deepEqual(groupingProblems(pool, GROUPS(['a'], ['b'], ['c'], ['d'])), [])
  assert.deepEqual(groupingProblems(pool, GROUPS(['d', ['a', 'b', 'c']])), [])
  assert.deepEqual(groupingProblems(poolOf(['only']), GROUPS(['only'])), [])
})
await test('a missing, repeated or unknown fingerprint, a keep inside its own merge list, and a merge with no reason are each a problem', () => {
  const pool = poolOf(['a', 'b', 'c'])
  const cases = [
    ['a missing fingerprint', GROUPS(['a', ['b']]), /candidate "c" is in no group/],
    ['a fingerprint in two groups', GROUPS(['a', ['b']], ['b'], ['c']), /"b" appears in group 0 and in group 1/],
    ['a fingerprint twice in one list', GROUPS(['a', ['b', 'b']], ['c']), /"b" appears in group 0 and in group 0/],
    ['a keep inside its own merge list', GROUPS(['a', ['a']], ['b'], ['c']), /"a" appears in group 0 and in group 0/],
    ['an unknown fingerprint', GROUPS(['a', ['zzz']], ['b'], ['c']), /group 0 names "zzz", which is not a candidate/],
    ['an unknown keep', GROUPS(['zzz'], ['a'], ['b'], ['c']), /names "zzz"/],
    ['a merge with no reason', [{ keep: 'a', merge: ['b'], reason: '  ' }, { keep: 'c', merge: [], reason: '' }], /group 0 merges without saying why/],
    ['a fingerprint with a line number added', GROUPS(['a:12', ['b']], ['c']), /"a:12", which is not a candidate/],
  ]
  for (const [name, groups, re] of cases) assert.ok(groupingProblems(pool, groups).some(p => re.test(p)), `${name}: ${groupingProblems(pool, groups).join(' | ')}`)
})
await test('a grouping that is not a list of {keep, merge, reason}, or is wrapped in prose, is a problem and never an exception', () => {
  const pool = poolOf(['a', 'b'])
  for (const bad of [null, undefined, 0, 7, 'groups: a, b', {}, { groups: [] }, [], [null], [7], ['a'], [[]], [{}], [{ keep: 'a' }], [{ keep: 'a', merge: 'b', reason: 'x' }], [{ keep: 'a', merge: [null], reason: 'x' }], [{ keep: 7, merge: [], reason: '' }],
    [{ keep: 'a', merge: [], reason: null }], [{ keep: '', merge: [], reason: '' }], [{ keep: ['a'], merge: [], reason: '' }]]) {
    const problems = groupingProblems(pool, bad)
    assert.ok(problems.length > 0, JSON.stringify(bad))
    assert.ok(problems.every(p => typeof p === 'string'))
  }
})
await test('a carried prior record is never merged away (its unit waits for its own verifier), though another candidate may be merged into it', () => {
  const pool = [...poolOf(['a', 'b']), { ...poolOf(['carried'])[0], carried_from: { run_id: 'run-1', commit: 'c'.repeat(40) } }]
  assert.ok(groupingProblems(pool, GROUPS(['a', ['carried']], ['b'])).some(p => /"carried" is a carried prior record: it is verified as itself and is never merged away/.test(p)))
  assert.deepEqual(groupingProblems(pool, GROUPS(['carried', ['a']], ['b'])), [])
})

console.log('== the input')
await test('the input has each candidate\'s fingerprint, verdict, title, root cause, trace shape and units, the architecture, and the consolidation method verbatim; nothing else of the hunters\' work', () => {
  const run = atValidation([{ name: 'a', candidates: [['fp-a', { title: 'Title A', hunterNote: 'SENTINEL-NOTE' }]] }, { name: 'b', candidates: [['fp-b', { claimed_root_cause: 'B root.' }]] }, { name: 'c', candidates: [] }])
  const input = consolidateInput(run.runDir, loadRun(run.runDir))
  assert.deepEqual([input.stage, input.part, input.tree], ['consolidate', 'consolidate', join(run.runDir, 'tree')])
  assert.deepEqual(input.candidates.map(c => c.fingerprint), ['fp-a', 'fp-b'])
  assert.deepEqual(Object.keys(input.candidates[0]).sort(), ['fingerprint', 'proposed_verdict', 'root_cause', 'title', 'trace', 'units'])
  assert.deepEqual(input.candidates[0].trace, [{ file: 'src/app.js', kind: 'sink', scope: 'a' }], 'the (file, kind, scope) of each step, not its line or description')
  assert.equal(input.candidates[1].root_cause, 'B root.')
  assert.equal(input.parts.consolidation, block('HUNTING.md#Parent consolidation and ledger update').text)
  assert.equal(input.architecture_md, readFileSync(join(run.runDir, 'architecture.md'), 'utf8'))
  assert.ok(!JSON.stringify(input).includes('SENTINEL-NOTE'), 'a field of a hunter\'s record that grouping does not need never reaches the grouper')
  assert.ok(!JSON.stringify(input).includes('hunter_ids'))
  assert.deepEqual(consolidateInput(run.runDir, loadRun(run.runDir)), input, 'the same pool gives the same input')
})
await test('long text from a hunter is cut, so a record cannot inflate the grouping input', () => {
  const run = atValidation([{ name: 'a', candidates: [['fp-a', { title: 'T'.repeat(5000), claimed_root_cause: 'R'.repeat(5000) }]] }, { name: 'b', candidates: ['fp-b'] }])
  const [a] = consolidateInput(run.runDir, loadRun(run.runDir)).candidates
  assert.ok(a.title.length <= 301 && a.title.endsWith('…') && a.root_cause.length <= 301)
})
await test('a pool that is not what merge-wave wrote is refused by name, not read as empty: not an array, an entry with no fingerprint, a verdict that is not proposable, a repeat', () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const good = pool => pool
  for (const bad of ['x', {}, [null], [{}], [{ fingerprint: 'a', proposed_verdict: 'rejected', hunter_ids: [], units: [], record: {} }], [{ fingerprint: 'a', proposed_verdict: 'confirmed', hunter_ids: 'h1', units: [], record: {} }],
    [{ fingerprint: 'a', proposed_verdict: 'confirmed', hunter_ids: [], units: [], record: [] }], [{ fingerprint: 'a', proposed_verdict: 'confirmed', hunter_ids: [], units: [7], record: {} }], [{ fingerprint: '', proposed_verdict: 'confirmed', hunter_ids: [], units: [], record: {} }],
    [...poolOf(['a']), ...poolOf(['a'])]]) {
    writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(good(bad)))
    assert.throws(() => readPool(run.runDir), /candidates\.json is not what merge-wave wrote/, JSON.stringify(bad).slice(0, 70))
  }
})

console.log('== the stage, end to end')
await test('a grouping that covers every fingerprint merges the candidates: one entry keeps the hunters and units of both, the units that held the other now hold the kept one, the ledger passes, and next says validate', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }])
  const { runDir } = run
  assert.equal(next(runDir), 'NEXT: consolidate run=workflow')
  const before = pool(runDir)
  const res = await runStage(runDir, { 'audit-synthesizer': [{ groups: [{ keep: 'fp-a', merge: ['fp-b'], reason: 'both skip the owner check' }, { keep: 'fp-c', merge: [], reason: '' }] }] })
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.match(res.apply.last, /^AUDIT: OK apply consolidate candidates=3 groups=2 merged=1 applied=true agents=1$/)
  assert.equal(next(runDir), 'NEXT: validate run=workflow')
  const now = pool(runDir)
  assert.deepEqual(now.map(c => c.fingerprint), ['fp-a', 'fp-c'])
  const a = now[0]
  assert.deepEqual(a.hunter_ids, [run.owners.a, run.owners.b].sort(), 'a hunter of either fingerprint is a hunter of the root cause')
  assert.deepEqual(a.units, [unitByName(runDir).a.coverage_id, unitByName(runDir).b.coverage_id].sort())
  assert.deepEqual(a.merged, [{ fingerprint: 'fp-b', proposed_verdict: 'needs_validation', reason: 'both skip the owner check' }])
  assert.deepEqual(a.record, before[0].record, 'the kept entry keeps its own record')
  const ledger = unitByName(runDir)
  assert.deepEqual([ledger.a.result_fingerprints, ledger.b.result_fingerprints, ledger.c.result_fingerprints], [['fp-a'], ['fp-a'], ['fp-c']])
  assert.deepEqual(ledger.b.merged_fingerprints, [{ fingerprint: 'fp-b', into: 'fp-a', reason: 'both skip the owner check' }])
  assert.equal(ledger.a.merged_fingerprints, undefined)
  ok(runDir)
  assert.equal(meta(runDir).agents_spent, 1)
  const saved = readJsonFile(runDir, 'consolidation.json')
  assert.deepEqual([saved.applied, saved.problems, saved.stage.endsWith('consolidate')], [true, [], true])
  assert.deepEqual(events(runDir).filter(e => e.cmd === 'apply').map(e => [e.stage, e.result, e.counts]), [['consolidate', 'ok', { candidates: 3, groups: 2, merged: 1 }]])
})
await test('a unit that held both the merged and the kept fingerprint holds the kept one once (the validator rejects a repeat)', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a', 'fp-b'] }, { name: 'b', candidates: ['fp-c'] }])
  const res = await runStage(run.runDir, { 'audit-synthesizer': [{ groups: [{ keep: 'fp-a', merge: ['fp-b'], reason: 'one root cause, two effects' }, { keep: 'fp-c', merge: [], reason: '' }] }] })
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.deepEqual(unitByName(run.runDir).a.result_fingerprints, ['fp-a'])
  ok(run.runDir)
})
await test('an archived attempt that holds the merged fingerprint is not rewritten: the unit keeps an alias, and the pool entry is gone', async () => {
  const run = seeded([unitInput('a', { canonical_refs: refsOf('a', { subsystem: 'a' }) }), unitInput('b', { canonical_refs: refsOf('b', { subsystem: 'b' }) })])
  const { runDir } = run
  planWave(runDir); advanceState(runDir, 'hunt')
  const [ua, ub] = [unitByName(runDir).a, unitByName(runDir).b]
  mergeWave(runDir, {
    [ua.agent_id]: hunterResult([hunterUnit(ua.coverage_id, ua.agent_id, { disposition: 'candidate', candidate_fingerprints: ['fp-a'] })], { candidates: [candidateOf('fp-a')] }),
    [ub.agent_id]: hunterResult([hunterUnit(ub.coverage_id, ub.agent_id, { disposition: 'candidate', candidate_fingerprints: ['fp-b'] })], { candidates: [candidateOf('fp-b')] }),
  })
  // the critic reopens unit a: its candidate moves into attempts, wave 2 closes it as covered
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint')
  applyCritic(runDir, { missing_units: [], reassign_ids: [ua.coverage_id], resolved_prior_leads: [], stop: false }, { units: [] })
  planWave(runDir); advanceState(runDir, 'hunt')
  const again = unitByName(runDir).a
  mergeWave(runDir, { [again.agent_id]: hunterResult([hunterUnit(again.coverage_id, again.agent_id)]) })
  closeCoverage(runDir)
  const held = unitByName(runDir).a
  assert.deepEqual([held.status, held.result_fingerprints, held.attempts.map(a => a.result_fingerprints)], ['covered', [], [['fp-a']]])
  const res = await runStage(runDir, { 'audit-synthesizer': [{ groups: [{ keep: 'fp-b', merge: ['fp-a'], reason: 'the same missing check' }] }] })
  assert.equal(res.apply.status, 0, res.apply.stdout)
  const after = unitByName(runDir).a
  assert.deepEqual(after.attempts, held.attempts, 'the archive is append-only: not one byte of it changes')
  assert.deepEqual(after.merged_fingerprints, [{ fingerprint: 'fp-a', into: 'fp-b', reason: 'the same missing check' }])
  assert.deepEqual(pool(runDir).map(c => c.fingerprint), ['fp-b'])
  assert.deepEqual(pool(runDir)[0].units.length, 2)
  ok(runDir)
})

console.log('== a grouping that cannot be applied is discarded, and the candidates are validated as they stand')
await test('an invalid grouping changes no file but consolidation.json and the step, says why, and next goes on to validate', async () => {
  for (const [name, groups] of [['one fingerprint missing', GROUPS(['fp-a', ['fp-b']])], ['an unknown fingerprint', GROUPS(['fp-a', ['fp-b']], ['fp-c', ['fp-ghost']])], ['one fingerprint twice', GROUPS(['fp-a', ['fp-b']], ['fp-b'], ['fp-c'])], ['no groups', []]]) {
    const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }])
    const poolBefore = readFileSync(join(run.runDir, 'candidates.json'), 'utf8'), ledgerBefore = ledgerBytes(run.runDir)
    const res = await runStage(run.runDir, { 'audit-synthesizer': [{ groups }] })
    assert.equal(res.apply.status, 0, `${name}: ${res.apply.stdout}`)
    assert.match(res.apply.stdout, /^note: the grouping was discarded \(\d+ problem\(s\), first: .*\); the 3 candidate\(s\) are validated as they stand$/m, name)
    assert.match(res.apply.last, /merged=0 applied=false agents=1$/, name)
    assert.equal(readFileSync(join(run.runDir, 'candidates.json'), 'utf8'), poolBefore, `${name}: the pool is untouched`)
    assert.equal(ledgerBytes(run.runDir), ledgerBefore, `${name}: the ledger is untouched`)
    assert.equal(readJsonFile(run.runDir, 'consolidation.json').applied, false)
    assert.equal(next(run.runDir), 'NEXT: validate run=workflow', name)
    assert.equal(meta(run.runDir).agents_spent, 1, `${name}: the agent ran, so it is spent`)
    assert.equal(events(run.runDir).filter(e => e.cmd === 'apply').at(-1).reason, 'grouping discarded')
  }
})
await test('a carried prior record cannot be merged away: such a grouping is discarded whole', async () => {
  const before = repo => priorRun(repo, [priorUnit('carry', 'candidate', { result_fingerprints: ['fp-carry'] })], [needsValidationRecord('fp-carry')])
  const run = seeded([unitInput('x', { canonical_refs: refsOf('x', { subsystem: 'x' }) }), unitInput('carry')], { before })
  const { runDir } = run
  planWave(runDir); advanceState(runDir, 'hunt')
  const x = unitByName(runDir).x
  mergeWave(runDir, { [x.agent_id]: hunterResult([hunterUnit(x.coverage_id, x.agent_id, { disposition: 'candidate', candidate_fingerprints: ['fp-x'] })], { candidates: [candidateOf('fp-x')] }) })
  closeCoverage(runDir)
  const carried = pool(runDir).find(c => c.carried_from)
  assert.deepEqual([carried.fingerprint, carried.hunter_ids, carried.proposed_verdict], ['fp-carry', [], 'needs_validation'], 'the prior record is in the pool with no hunter')
  assert.equal(next(runDir), 'NEXT: consolidate run=workflow')
  const bad = await runStage(runDir, { 'audit-synthesizer': [{ groups: [{ keep: 'fp-x', merge: ['fp-carry'], reason: 'same root cause' }] }] })
  assert.equal(bad.apply.status, 0, bad.apply.stdout)
  assert.match(bad.apply.stdout, /is a carried prior record: it is verified as itself and is never merged away/)
  assert.deepEqual(pool(runDir).map(c => c.fingerprint), ['fp-carry', 'fp-x'])
})

console.log('== the skips: nothing to group, no room, too big')
await test('with fewer than two candidates nothing is asked: the plan says so, closes the step with no merge, and next goes on to validate', () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(pool(run.runDir).slice(0, 1)))   // the ledger names two leads and the pool holds one
  assert.equal(next(run.runDir), 'NEXT: consolidate run=workflow')
  const res = stage(['plan', run.runDir])
  assert.equal(res.status, 1)
  assert.match(res.last, /^AUDIT: FAIL consolidation skipped: 1 candidate\(s\): fewer than two have nothing to group; no agent was launched and nothing was merged\./)
  assert.equal(readJsonFile(run.runDir, 'consolidation.json').applied, false)
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  assert.deepEqual(stageDirs(run.runDir), [], 'no stage directory, no script')
})
await test('with one agent left of the budget grouping is skipped: it would take the one a verifier needs; with two it runs', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 39)
  const res = stage(['plan', run.runDir])
  assert.match(res.last, /consolidation skipped: 1 agent\(s\) left of the budget: the grouping would take the one a verifier needs/)
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const run2 = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { args: ['--budget', '40'] })
  recordSpend(run2.runDir, 'earlier', 38)
  assert.match(stage(['plan', run2.runDir]).last, /^AUDIT: OK plan consolidate /)
})
await test('an input that cannot fit one script skips grouping instead of ending the run', () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const entry = i => ({ fingerprint: `fp-${String(i).padStart(4, '0')}`, proposed_verdict: 'needs_validation', hunter_ids: ['h1-01'], units: [`u${'x'.repeat(300)}`], record: { title: 'T'.repeat(250), claimed_root_cause: 'R'.repeat(250), trace: [] } })
  writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(Array.from({ length: 900 }, (_, i) => entry(i))))
  assert.throws(() => consolidateInput(run.runDir, loadRun(run.runDir)), /consolidation skipped: the 900 candidates would make an input of \d+ bytes, over the 300000 one script can carry/)
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  assert.ok(MAX_CONSOLIDATE_BYTES < 500_000)
})

console.log('== crash windows')
await test('a crash after the effects landed and before the step was saved is finished by applying the same result again, with the cost recorded once and nothing merged twice', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }])
  const { runDir } = run
  const snap = snapshot(runDir)
  const plan = stage(['plan', runDir])
  const dir = join(runDir, 'stages', plan.last.match(/stages\/([^/]+)\/run\.js/)[1])
  const ran = await runScript(join(dir, 'run.js'), { 'audit-synthesizer': [{ groups: [{ keep: 'fp-a', merge: ['fp-b'], reason: 'one cause' }, { keep: 'fp-c', merge: [], reason: '' }] }] })
  const file = returnedFile(dir, ran.result)
  assert.equal(stage(['apply', runDir, file]).status, 0)
  const afterPool = readFileSync(join(runDir, 'candidates.json'), 'utf8'), afterLedger = ledgerBytes(runDir)
  const stateBefore = JSON.parse(snap.get('stage-state.json').toString())
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ ...stateBefore, updated: stateBefore.updated }))   // the step save never happened
  assert.equal(next(runDir), 'NEXT: consolidate run=workflow')
  const again = stage(['apply', runDir, file])
  assert.equal(again.status, 0, again.stdout)
  assert.equal(next(runDir), 'NEXT: validate run=workflow')
  assert.equal(readFileSync(join(runDir, 'candidates.json'), 'utf8'), afterPool)
  assert.equal(ledgerBytes(runDir), afterLedger)
  assert.equal(meta(runDir).agents_spent, 1, 'recorded once')
  ok(runDir)
})
await test('applying a result to a pool that is not the one planned is refused, and a result of the wrong shape is refused, changing nothing', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = join(run.runDir, 'stages', plan.last.match(/stages\/([^/]+)\/run\.js/)[1])
  const good = (await runScript(join(dir, 'run.js'), { 'audit-synthesizer': [{ groups: GROUPS(['fp-a', ['fp-b']]) }] })).result
  for (const bad of [{ ...good, results: { part: 'consolidate' } }, { ...good, results: { part: 'consolidate', groups: 'all of them' } }, { ...good, results: { part: 'consolidate', groups: null } }, { ...good, results: { part: 'critic', groups: [] } }]) {
    const file = returnedFile(dir, bad)
    const before = snapshot(run.runDir)
    const r = stage(['apply', run.runDir, file])
    assert.equal(r.status, 1, JSON.stringify(bad.results))
    assert.match(r.last, /^AUDIT: FAIL /)
    assert.deepEqual(snapshot(run.runDir), before, 'not one byte of the run changed, and no file appeared')
  }
  writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(pool(run.runDir).slice(1)))
  const stale = stage(['apply', run.runDir, returnedFile(dir, good)])
  assert.match(stale.last, /^AUDIT: FAIL candidates\.json is not the pool this stage was planned for: plan the stage again/)
  assert.ok(files(run.runDir).includes('stage-state.json'))
  assert.equal(existsSync(join(run.runDir, 'consolidation.json')), false)
})

console.log('== apply under mutation')
await test('a good result with one field of any depth deleted or replaced by the wrong type is refused or applied, never a crash, and the run still passes check', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }])
  const plan = stage(['plan', run.runDir])
  const dir = join(run.runDir, 'stages', plan.last.match(/stages\/([^/]+)\/run\.js/)[1])
  const good = (await runScript(join(dir, 'run.js'), { 'audit-synthesizer': [{ groups: [{ keep: 'fp-a', merge: ['fp-b'], reason: 'one cause' }, { keep: 'fp-c', merge: [], reason: '' }] }] })).result
  const outcomes = fuzzApply(run.runDir, good, dir, 80)
  assert.equal(outcomes.ok + outcomes.refused, 80)
  assert.ok(outcomes.refused > 0 && outcomes.ok > 0, `both outcomes happen: ${JSON.stringify(outcomes)}`)
})
await test('a pool deleted after the stage was planned is a plain refusal, and a ledger or consolidation file deleted after the step was saved does not move `next`', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = join(run.runDir, 'stages', plan.last.match(/stages\/([^/]+)\/run\.js/)[1])
  const good = (await runScript(join(dir, 'run.js'), { 'audit-synthesizer': [{ groups: GROUPS(['fp-a', ['fp-b']]) }] })).result
  const snap = snapshot(run.runDir)
  rmSync(join(run.runDir, 'candidates.json'))
  assert.match(stage(['apply', run.runDir, returnedFile(dir, good)]).last, /^AUDIT: FAIL candidates\.json is not the pool this stage was planned for/)
  restore(run.runDir, snap)
  assert.equal(stage(['apply', run.runDir, returnedFile(dir, good)]).status, 0)
  for (const name of ['consolidation.json', 'candidates.json']) {
    const keep = readFileSync(join(run.runDir, name))
    rmSync(join(run.runDir, name))
    assert.equal(next(run.runDir), 'NEXT: validate run=workflow', `${name} deleted`)
    writeFileSync(join(run.runDir, name), keep)
  }
})
