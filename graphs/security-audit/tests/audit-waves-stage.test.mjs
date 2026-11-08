// audit-waves-stage.test.mjs - audit-stage.mjs for the wave stages hunt, critic and mint: the inputs it builds from a real ledger, the whole path
// recon -> seed -> two waves -> critics -> the final-clean critic with the real vendored validator on every ledger the helpers write, one hunter
// failing without stopping the others, the pool bound through the generated script, the budget gates, a minter result apply-critic would
// refuse, and every crash window. The recon stages are in audit-stage.test.mjs.
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { criticInput, huntInput, mintInput } from '../skills/security-audit/audit-stage.mjs'
import { loadRun, nextStep, recordSpend, REASONS } from '../skills/security-audit/audit-run.mjs'
import { parts, resolve as block } from '../skills/security-audit/blocks.mjs'
import { audit, ledgerCli, meta } from './audit-fixtures.mjs'
import { assignments, candidateOf, ledgerValid, readJsonFile, readLedger } from './ledger-fixtures.mjs'
import { UNIT, files, reconToSeed, returnedFile, runScript, runStage, stage, stageDirs } from './stage-fixtures.mjs'

const P = parts()
const three = () => [UNIT('a', { subsystemRef: 'one' }), UNIT('b', { subsystemRef: 'two' }), UNIT('c', { subsystemRef: 'three' })]
const covered = (agent, ids, over = {}) => ({
  units: ids.map(id => ({ coverage_id: id, disposition: 'covered', reviewed_paths: ['src/app.js'], checks: [{ agent_id: agent, reviewed_paths: ['src/app.js'], invariant: 'the owner check', method: 'source', result: 'the handler calls it', artifact: null }], candidate_fingerprints: [], unresolved: [] })),
  candidates: [], hardening: [], uncovered: [], ...over,
})
const CRITIC = (over = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true, ...over })
const GAP = (name = 'g') => ({ surface: `gap ${name}`, boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'a parallel path nobody owns' })
const MINTED = names => ({ units: names.map(n => UNIT(n, { subsystemRef: `m-${n}`, starting_paths: ['src/db.js'] })) })
const ok = runDir => { assert.ok(ledgerValid(runDir), 'upstream\'s validator passes the ledger'); assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`) }
const next = runDir => audit(['next', runDir]).last
// One scripted analyst answer per hunter, by the label of the call (the order of a pool is not the contract).
const hunters = (runDir, answer) => { const asg = assignments(runDir); return Object.keys(asg).map(() => (p, opts) => answer(opts.label, asg[opts.label])) }
const plain = (label, ids) => covered(label, ids)

console.log('== the wave stages: the inputs')
await test('the hunt input has one hunter per assigned owner in numeric order, each with its units, only the fingerprint, title and root cause of its carried exclusions, and its peers; the blocks and parts are upstream\'s text', async () => {
  const { runDir } = await reconToSeed(three())
  assert.match(ledgerCli(['plan-wave', runDir]).last, /^AUDIT: OK plan-wave wave=1 hunters=3 assigned=3 deferred=0$/)
  const run = loadRun(runDir)
  const n = nextStep(run)
  const input = huntInput(runDir, run, n)
  assert.deepEqual([input.stage, input.part, input.wave, input.tree, input.maxParallel], ['hunt', 'hunt', 1, join(runDir, 'tree'), 8])
  assert.deepEqual(input.hunters.map(h => h.agent_id), ['h1-01', 'h1-02', 'h1-03'])
  const ids = input.hunters.map(h => h.units.map(u => u.coverage_id))
  input.hunters.forEach((h, i) => assert.deepEqual(h.peers, ids.filter((_, j) => j !== i).flat().sort(), 'every other hunter\'s units, sorted'))
  const unit = input.hunters[0].units[0]
  assert.deepEqual(Object.keys(unit).sort(), ['attack_class', 'boundary', 'coverage_id', 'excluded_blocks', 'ordinary_attack_class_block', 'prior_status', 'selected_companion_blocks', 'starting_paths', 'subsystem', 'surface'])
  assert.deepEqual(Object.keys(input.blocks), ['ATTACK-CLASSES.md#Access control'])
  assert.equal(input.blocks['ATTACK-CLASSES.md#Access control'], block('ATTACK-CLASSES.md#Access control').text)
  for (const k of ['hunterMethod', 'promotion', 'validationRules', 'hunterResult', 'schema_confirmed', 'schema_needs_validation']) assert.equal(input.parts[k], P[k].text, k)
  assert.equal(input.architecture_md, readFileSync(join(runDir, 'architecture.md'), 'utf8'))
  assert.deepEqual(huntInput(runDir, run, n), input, 'the same ledger gives the same input')
})
await test('hunters sort numerically (h1-100 follows h1-99), a carried exclusion is cut to three fields and deduplicated, a unit no hunter owns is refused, and a block that does not resolve is named', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const run = loadRun(runDir)
  const unit = (id, agent, over = {}) => ({ ...run.ledger[0], coverage_id: id, status: 'in_progress', agent_id: agent, ...over })
  const ex = { fingerprint: 'fp-1', title: 'T', root_cause: 'R', verdict: 'confirmed', trace: [{ kind: 'sink' }], severity: 'x' }
  const ledger = [...[1, 2, 99, 100, 101].map(n => unit(`u${n}`, `h1-${String(n).padStart(2, '0')}`)), unit('v', 'h1-02', { carried_exclusions: [ex] }), unit('w', 'h1-02', { carried_exclusions: [ex, { ...ex, fingerprint: 'fp-2' }] }), unit('done', null, { status: 'covered' })]
  const input = huntInput(runDir, { ...run, ledger }, { wave: 1 })
  assert.deepEqual(input.hunters.map(h => h.agent_id), ['h1-01', 'h1-02', 'h1-99', 'h1-100', 'h1-101'])
  assert.deepEqual(input.hunters[1].exclusions, [{ fingerprint: 'fp-1', title: 'T', root_cause: 'R' }, { fingerprint: 'fp-2', title: 'T', root_cause: 'R' }])
  assert.deepEqual(input.hunters[0].exclusions, [])
  assert.ok(!input.hunters.flatMap(h => h.units).some(u => u.coverage_id === 'done'), 'a unit that is not in_progress is not assigned')
  assert.throws(() => huntInput(runDir, { ...run, ledger: [unit('x', null, { status: 'covered' })] }, { wave: 1 }), /no unit is in_progress/)
  assert.throws(() => huntInput(runDir, { ...run, ledger: [unit('x', 'h1-01', { ordinary_attack_class_block: 'ATTACK-CLASSES.md#Made up' })] }, { wave: 1 }), /the ledger names a block that does not resolve: unknown block ATTACK-CLASSES\.md#Made up/)
})

console.log('== the wave stages: init -> recon -> seed -> two waves -> the final-clean critic, from disk')
await test('the whole path, with the real vendored validator on every ledger: wave 1 finds a lead and a gap, critic 1 reopens a unit and names a gap, mint, wave 2, critic 2 finds nothing, one distinct final-clean critic', async () => {
  const { runDir } = await reconToSeed(three(), ['--max-parallel', '2'])
  const spent = () => meta(runDir).agents_spent
  assert.equal(spent(), 5)
  assert.equal(next(runDir), 'NEXT: plan-wave run=helper wave=1')
  // wave 1
  assert.match(ledgerCli(['plan-wave', runDir]).last, /hunters=3 assigned=3 deferred=0$/); ok(runDir)
  assert.equal(next(runDir), 'NEXT: hunt run=workflow wave=1')
  const asg1 = assignments(runDir)
  const fp = 'fixture-lead-1'
  let inflight = 0, peak = 0
  const answer1 = async (label, ids) => {
    inflight += 1; peak = Math.max(peak, inflight)
    await new Promise(r => setTimeout(r, label === 'h1-01' ? 20 : label === 'h1-02' ? 10 : 0))   // the first hunter finishes last
    inflight -= 1
    if (label === 'h1-01') return covered(label, ids, { units: covered(label, ids).units.map(u => ({ ...u, disposition: 'candidate', candidate_fingerprints: [fp] })), candidates: [candidateOf(fp)] })
    if (label === 'h1-02') return covered(label, ids, { uncovered: [{ surface: 'queued gap', boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'an entry nobody owns' }], hardening: ['rate limits are absent'] })
    return covered(label, ids)
  }
  const hunt1 = await runStage(runDir, { 'audit-analyst': hunters(runDir, answer1) })
  assert.equal(hunt1.apply.status, 0, hunt1.apply.stdout)
  assert.equal(peak, 2, 'never more than --max-parallel hunters in flight, and the pool was used')
  assert.match(hunt1.apply.last, /^AUDIT: OK apply hunt wave=1 hunters=3 usable=3 agents=3$/)
  assert.deepEqual(Object.keys(readJsonFile(runDir, 'hunter-results.json')), ['h1-01', 'h1-02', 'h1-03'], 'in hunter order, not finishing order')
  assert.equal(next(runDir), 'NEXT: merge-wave run=helper wave=1')
  assert.match(hunt1.apply.stdout, new RegExp(`^then: node audit-ledger\\.mjs merge-wave ${runDir} ${runDir}/hunter-results\\.json$`, 'm'))
  assert.match(ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')]).last, /merged=3 failed=0 deferred=0 candidates=1 uncovered_queued=1$/); ok(runDir)
  assert.deepEqual(readJsonFile(runDir, 'candidates.json').map(c => c.fingerprint), [fp])
  // critic 1 (post-wave): reopens h1-03's unit, names a gap
  assert.equal(next(runDir), 'NEXT: critic run=workflow kind=post-wave wave=1')
  const reopen = asg1['h1-03'][0]
  const c1 = await runStage(runDir, { 'audit-researcher': [CRITIC({ stop: false, missing_units: [GAP('from-critic')], reassign_ids: [reopen] })] })
  assert.equal(c1.apply.status, 0, c1.apply.stdout)
  assert.match(c1.apply.last, /^AUDIT: OK apply critic kind=post-wave id=c1 missing_units=1 reassign_ids=1 resolved_prior_leads=0 stop=false agents=1$/)
  assert.equal(readJsonFile(runDir, 'critic.json').reassign_ids[0], reopen)
  const criticStage = stageDirs(runDir).filter(d => d.includes('critic'))
  assert.deepEqual(criticStage, ['04-critic-post-wave-w1'])
  assert.equal(next(runDir), 'NEXT: mint run=workflow wave=1')
  // mint: two proposals (the critic's and the hunter's queued gap), two units
  const m1 = await runStage(runDir, { 'audit-synthesizer': [MINTED(['m1', 'm2'])] })
  assert.equal(m1.apply.status, 0, m1.apply.stdout)
  assert.match(m1.apply.last, /^AUDIT: OK apply mint wave=1 proposals=2 units=2 agents=1$/)
  assert.deepEqual(readJsonFile(m1.dir, 'input.json').proposals.map(p => p.source), ['the wave 1 critic', 'hunter h1-02, wave 1'])
  assert.equal(next(runDir), 'NEXT: apply-critic run=helper wave=1')
  const ac1 = ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')])
  assert.match(ac1.last, /^AUDIT: OK apply-critic wave=1 kind=post-wave units_added=2 out_of_scope=0 reassigned=1 resolved=0 rejected=0$/); ok(runDir)
  assert.equal(readLedger(runDir).length, 5)
  // wave 2: the reopened unit and the two minted ones, a fresh owner each
  assert.equal(next(runDir), 'NEXT: plan-wave run=helper wave=2')
  assert.match(ledgerCli(['plan-wave', runDir]).last, /^AUDIT: OK plan-wave wave=2 hunters=3 assigned=3 deferred=0$/); ok(runDir)
  const hunt2 = await runStage(runDir, { 'audit-analyst': hunters(runDir, plain) })
  assert.match(hunt2.apply.last, /^AUDIT: OK apply hunt wave=2 hunters=3 usable=3 agents=3$/)
  assert.match(ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')]).last, /merged=3 failed=0/); ok(runDir)
  // critic 2 finds nothing; mint with nothing calls nobody and costs nothing
  const c2 = await runStage(runDir, { 'audit-researcher': [CRITIC()] })
  assert.match(c2.apply.last, /id=c2 missing_units=0 reassign_ids=0 resolved_prior_leads=0 stop=true agents=1$/)
  const m2 = await runStage(runDir, {})
  assert.match(m2.apply.last, /^AUDIT: OK apply mint wave=2 proposals=0 units=0 agents=0$/)
  assert.deepEqual(readJsonFile(runDir, 'mint.json'), { units: [] })
  assert.match(ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')]).last, /^AUDIT: OK apply-critic wave=2 kind=post-wave units_added=0/); ok(runDir)
  // nothing is planned and the post-wave critic accepted nothing: the one distinct final-clean critic
  assert.equal(next(runDir), 'NEXT: critic run=workflow kind=final-clean wave=2')
  const cf = await runStage(runDir, { 'audit-researcher': [CRITIC()] })
  assert.match(cf.apply.last, /^AUDIT: OK apply critic kind=final-clean id=cf2 /)
  assert.ok(cf.dir.endsWith('critic-final-clean-w2'))
  assert.equal(next(runDir), 'NEXT: mint run=workflow wave=2')
  assert.match((await runStage(runDir, {})).apply.last, /proposals=0 units=0 agents=0$/)
  assert.match(ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')]).last, /kind=final-clean units_added=0/); ok(runDir)
  assert.equal(stageDirs(runDir).filter(d => d.includes('final-clean') && d.startsWith('0') && d.includes('critic')).length, 1, 'exactly one final-clean critic')
  assert.equal(next(runDir), 'NEXT: validate run=workflow', 'coverage is over; the one lead is validated next')
  assert.equal(spent(), 5 + 3 + 1 + 1 + 3 + 1 + 0 + 1 + 0, 'every invocation was recorded, a stage with no agent cost nothing')
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.cmd === 'apply')
  assert.deepEqual(events.map(e => `${e.stage}:${e.result}`), ['recon:ok', 'recon:ok', 'hunt:ok', 'critic:ok', 'mint:ok', 'hunt:ok', 'critic:ok', 'mint:ok', 'critic:ok', 'mint:ok'])
})
await test('the merge is deterministic: two runs whose hunters finish in opposite orders leave byte-identical results and ledgers', async () => {
  const bytes = async delays => {
    const { runDir } = await reconToSeed(three())
    ledgerCli(['plan-wave', runDir])
    const asg = assignments(runDir)
    const ans = async (label, ids) => { await new Promise(r => setTimeout(r, delays[label])); return covered(label, ids, { hardening: [`note ${label}`] }) }
    await runStage(runDir, { 'audit-analyst': hunters(runDir, ans) })
    ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
    const norm = t => t.replaceAll(runDir, '<run>')
    return { results: norm(readFileSync(join(runDir, 'hunter-results.json'), 'utf8')), ledger: norm(readFileSync(join(runDir, 'coverage-ledger.json'), 'utf8')).replace(/"[0-9a-f]{12,}"/g, 'X'), asg: Object.keys(asg) }
  }
  const one = await bytes({ 'h1-01': 0, 'h1-02': 10, 'h1-03': 20 })
  const two = await bytes({ 'h1-01': 20, 'h1-02': 10, 'h1-03': 0 })
  assert.deepEqual(one.asg, two.asg)
  assert.equal(one.results.replace(/\/tmp\/audit-run-test-[A-Za-z0-9]+\/[^"]*/g, 'P'), two.results.replace(/\/tmp\/audit-run-test-[A-Za-z0-9]+\/[^"]*/g, 'P'))
  assert.equal(one.ledger.replace(/\/tmp\/audit-run-test-[A-Za-z0-9]+\/[^"]*/g, 'P'), two.ledger.replace(/\/tmp\/audit-run-test-[A-Za-z0-9]+\/[^"]*/g, 'P'))
})

console.log('== a hunter failing, and a result that is not what the stage planned')
await test('one hunter throwing leaves its units planned while the rest merge; the wave still moves on to the critic', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  const h = await runStage(runDir, { 'audit-analyst': [covered('h1-01', asg['h1-01']), { throws: 'boom' }, covered('h1-03', asg['h1-03'])] })
  assert.equal(h.apply.status, 0, h.apply.stdout)
  assert.match(h.apply.stdout, /^note: 1 of 3 hunter\(s\) returned nothing usable \(2 of 3 hunter\(s\) returned a result: audit-analyst failed h1-02: boom\); merge-wave returns their units to planned and counts the failure$/m)
  assert.match(h.apply.last, /hunters=3 usable=2 agents=3$/)
  assert.equal(readJsonFile(runDir, 'hunter-results.json')['h1-02'], null)
  assert.match(ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')]).last, /merged=2 failed=1 deferred=0/); ok(runDir)
  assert.deepEqual(Object.values(readLedger(runDir)).map(u => u.status).sort(), ['covered', 'covered', 'planned'])
  assert.equal(readLedger(runDir).find(u => u.status === 'planned').failed_attempts, 1)
  assert.equal(next(runDir), 'NEXT: critic run=workflow kind=post-wave wave=1')
})
await test('a hunt result with a missing, extra or malformed hunter entry is refused and changes nothing; so is a critic of the wrong kind or shape, and a mint without a units list', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  const plan = stage(['plan', runDir])
  const dir = join(runDir, 'stages', '03-hunt-w1')
  assert.match(plan.last, /03-hunt-w1/)
  const good = (await runScript(join(dir, 'run.js'), { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })).result
  const before = files(runDir)
  for (const hunters of [{}, { 'h1-01': good.results.hunters['h1-01'] }, { ...good.results.hunters, 'h1-09': null }, { ...good.results.hunters, 'h1-02': 'prose' }, { ...good.results.hunters, 'h1-02': [] }, [], null, 'x']) {
    const r = stage(['apply', runDir, returnedFile(dir, { ...good, results: { ...good.results, hunters } })])
    assert.equal(r.status, 1, JSON.stringify(hunters)?.slice(0, 60))
    assert.match(r.last, /^AUDIT: FAIL results\.hunters must have exactly one entry per planned hunter \(h1-01, h1-02, h1-03\), each a result object or null; nothing was changed$/)
  }
  assert.deepEqual(files(runDir).filter(f => !f.endsWith('returned.json')), before.filter(f => !f.endsWith('returned.json')))
  assert.equal(meta(runDir).agents_spent, 5)
  assert.equal(next(runDir), 'NEXT: hunt run=workflow wave=1')
  assert.equal(stage(['apply', runDir, returnedFile(dir, good)]).status, 0)
  ledgerCli(['merge-wave', runDir, join(dir, '..', '..', 'hunter-results.json')])
  // the critic
  const cp = stage(['plan', runDir])
  const cdir = join(runDir, 'stages', '04-critic-post-wave-w1')
  assert.match(cp.last, /04-critic-post-wave-w1/)
  const cgood = (await runScript(join(cdir, 'run.js'), { 'audit-researcher': [CRITIC()] })).result
  const cbefore = files(runDir)
  for (const results of [{ ...cgood.results, kind: 'final-clean' }, { ...cgood.results, critic: { ...cgood.results.critic, stop: 'no' } }, { ...cgood.results, critic: { missing_units: [] } }, { ...cgood.results, critic: 'prose' }, { ...cgood.results, critic: null }]) {
    const r = stage(['apply', runDir, returnedFile(cdir, { ...cgood, results })])
    assert.equal(r.status, 1, JSON.stringify(results).slice(0, 80))
    assert.match(r.last, /^AUDIT: FAIL the critic result is not upstream's JSON for a post-wave critic: /)
  }
  assert.deepEqual(files(runDir).filter(f => !f.endsWith('returned.json')), cbefore.filter(f => !f.endsWith('returned.json')))
  assert.equal(stage(['apply', runDir, returnedFile(cdir, cgood)]).status, 0)
  // the mint
  stage(['plan', runDir])
  const mdir = join(runDir, 'stages', '05-mint-w1')
  const mgood = (await runScript(join(mdir, 'run.js'), {})).result
  for (const units of ['x', {}, [null], [[]], null]) {
    const r = stage(['apply', runDir, returnedFile(mdir, { ...mgood, results: { part: 'mint', units } })])
    assert.equal(r.status, 1, JSON.stringify(units))
    assert.match(r.last, /^AUDIT: FAIL the minter result needs a units list of objects; nothing was changed$/)
  }
  assert.ok(!existsSync(join(runDir, 'mint.json')))
})
await test('a stage applied against the wrong plan is refused: a hunt result for a critic stage, and a plan that went stale', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  const h = await runStage(runDir, { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  stage(['plan', runDir])   // critic
  const r = stage(['apply', runDir, join(h.dir, 'returned.json')])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL the result is not the workflow's: stage is "hunt", but the stage planned is critic/)
})

console.log('== crash windows')
await test('a crash before the step was saved leaves `next` at the stage, and applying the same result finishes it, for hunt, critic and mint, with the cost recorded once', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  const state = () => readFileSync(join(runDir, 'stage-state.json'), 'utf8')
  const redo = async (step, script) => {
    const before = state(), spentBefore = meta(runDir).agents_spent
    const plan = stage(['plan', runDir])
    assert.equal(plan.status, 0, plan.stdout)
    const dir = join(runDir, 'stages', plan.last.match(/stages\/([^/]+)\/run\.js/)[1])
    const ran = await runScript(join(dir, 'run.js'), script)
    const file = returnedFile(dir, ran.result)
    assert.equal(stage(['apply', runDir, file]).status, 0)
    const after = files(runDir), spentAfter = meta(runDir).agents_spent, stateAfter = state()
    writeFileSync(join(runDir, 'stage-state.json'), before)   // the step was not saved
    assert.match(next(runDir), new RegExp(`^NEXT: ${step} `), `${step}: the crash leaves \`next\` at the stage`)
    const again = stage(['apply', runDir, file])
    assert.equal(again.status, 0, `${step}: ${again.stdout}`)
    assert.deepEqual(files(runDir), after, `${step}: nothing changed the second time`)
    assert.equal(meta(runDir).agents_spent, spentAfter)
    assert.equal(state().replace(/"updated": "[^"]+"/, ''), stateAfter.replace(/"updated": "[^"]+"/, ''))
    assert.ok(spentAfter >= spentBefore)
    return dir
  }
  await redo('hunt', { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  await redo('critic', { 'audit-researcher': [CRITIC({ missing_units: [GAP()] })] })
  await redo('mint', { 'audit-synthesizer': [MINTED(['m1'])] })
  assert.match(ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')]).last, /^AUDIT: OK apply-critic/); ok(runDir)
})
await test('an artifact deleted after its step was saved stops the next helper with a plain refusal and corrupts nothing; deleted before, the stage can be applied again', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  await runStage(runDir, { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
  const ledgerBefore = readFileSync(join(runDir, 'coverage-ledger.json'), 'utf8')
  rmSync(join(runDir, 'hunter-results.json'))
  assert.equal(next(runDir), 'NEXT: merge-wave run=helper wave=1', 'the step is saved: `next` does not read the artifact')
  const r = ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL .*hunter-results\.json does not exist$/)
  assert.equal(readFileSync(join(runDir, 'coverage-ledger.json'), 'utf8'), ledgerBefore)
  ok(runDir)
})

console.log('== the budget gates')
await test('when the budget no longer covers the critic, no agent is launched, the planned units are deferred with upstream\'s reason, and the run ends incomplete; check passes and `next` goes on', async () => {
  const { runDir } = await reconToSeed(three(), ['--budget', '40'])
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  await runStage(runDir, { 'audit-analyst': [covered('h1-01', asg['h1-01']), { throws: 'boom' }, covered('h1-03', asg['h1-03'])] })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  assert.equal(readLedger(runDir).filter(u => u.status === 'planned').length, 1)
  recordSpend(runDir, 'burned', 40 - meta(runDir).agents_spent)
  assert.equal(meta(runDir).agents_spent, 40)
  const before = stageDirs(runDir)
  const r = stage(['plan', runDir])
  assert.equal(r.status, 1)
  assert.equal(r.last, 'AUDIT: FAIL critic_budget_exhausted: the budget no longer covers the critic (--budget 40, 40 spent); no agent was launched, 1 planned unit(s) were deferred and the run is marked incomplete')
  assert.deepEqual(stageDirs(runDir), before, 'no stage directory and no script for a stage that cannot run')
  assert.deepEqual([meta(runDir).run_status, meta(runDir).incomplete_reason], ['incomplete', REASONS.critic])
  assert.deepEqual(readLedger(runDir).filter(u => u.status === 'deferred').map(u => u.unresolved), [[REASONS.critic]])
  ok(runDir)
  assert.equal(next(runDir), 'NEXT: write-findings run=helper')
  assert.match(stage(['plan', runDir]).last, /^AUDIT: FAIL the next step is not a Workflow stage: NEXT: write-findings/)
})
await test('the minter is gated only when there is something to mint: with the budget gone and proposals, the run ends incomplete; with none, the empty stage runs for free', async () => {
  const run = async () => {
    const { runDir } = await reconToSeed(three(), ['--budget', '40'])
    ledgerCli(['plan-wave', runDir])
    const asg = assignments(runDir)
    await runStage(runDir, { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
    ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
    return { runDir, asg }
  }
  const a = await run()
  await runStage(a.runDir, { 'audit-researcher': [CRITIC({ stop: false, missing_units: [GAP()] })] })
  recordSpend(a.runDir, 'burned', 40 - meta(a.runDir).agents_spent)
  const r = stage(['plan', a.runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL critic_budget_exhausted: the budget no longer covers the minter \(--budget 40, 40 spent\); no agent was launched, 0 planned unit\(s\) were deferred and the run is marked incomplete$/)
  assert.equal(meta(a.runDir).run_status, 'incomplete')
  ok(a.runDir)
  const b = await run()
  await runStage(b.runDir, { 'audit-researcher': [CRITIC()] })
  recordSpend(b.runDir, 'burned', 40 - meta(b.runDir).agents_spent)
  const free = stage(['plan', b.runDir])
  assert.equal(free.status, 0, free.stdout)
  assert.equal(meta(b.runDir).run_status, 'in_progress')
})

console.log('== a minter result apply-critic would refuse')
await test('more units than proposals is refused by apply with the reason, the cost recorded and the step kept; the next plan sends the reason back, a corrected result applies, and apply-critic then agrees', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  await runStage(runDir, { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  await runStage(runDir, { 'audit-researcher': [CRITIC({ stop: false, missing_units: [GAP()] })] })
  const spent = meta(runDir).agents_spent
  const first = await runStage(runDir, { 'audit-synthesizer': [MINTED(['x', 'y', 'z'])] })
  assert.equal(first.apply.status, 1, first.apply.stdout)
  assert.match(first.apply.last, /^AUDIT: FAIL the minter's units would not apply \(1 problem\(s\)\): apply-critic refused: mint returned 3 unit\(s\) for 1 proposal\(s\)[^]* \(attempt 1 of 2; plan the stage again: it is sent these reasons\)$/)
  assert.ok(!existsSync(join(runDir, 'mint.json')))
  assert.equal(next(runDir), 'NEXT: mint run=workflow wave=1')
  assert.equal(meta(runDir).agents_spent, spent + 1)
  const fb = readJsonFile(runDir, 'mint-feedback.json')
  assert.deepEqual([fb.attempts.length, fb.attempts[0].wave, fb.attempts[0].stage], [1, 1, '05-mint-w1'])
  const second = await runStage(runDir, { 'audit-synthesizer': [MINTED(['x'])] })
  assert.deepEqual(readJsonFile(second.dir, 'input.json').feedback, { attempt: 1, of: 2, problems: fb.attempts[0].problems })
  assert.equal(second.apply.status, 0, second.apply.stdout)
  assert.match(ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')]).last, /^AUDIT: OK apply-critic wave=1 kind=post-wave units_added=1/); ok(runDir)
})
await test('a second refused minter result ends the run incomplete with ledger_validation_failed and defers the planned units; the attempts of one wave do not count against the next', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  await runStage(runDir, { 'audit-analyst': [covered('h1-01', asg['h1-01']), { throws: 'boom' }, covered('h1-03', asg['h1-03'])] })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  await runStage(runDir, { 'audit-researcher': [CRITIC({ stop: false, missing_units: [GAP()] })] })
  // an attempt recorded for another wave is not this wave's feedback, and does not count against it
  writeFileSync(join(runDir, 'mint-feedback.json'), JSON.stringify({ version: 1, attempts: [{ stage: '99-mint-w7', wave: 7, problems: ['old'] }] }))
  assert.equal(mintInput(runDir, loadRun(runDir), { wave: 1 }).feedback, undefined)
  const bad = () => ({ 'audit-synthesizer': [MINTED(['x', 'y'])] })
  const first = await runStage(runDir, bad())
  assert.equal(first.apply.status, 1)
  assert.match(first.apply.last, /\(attempt 1 of 2; plan the stage again/, 'the wave 7 entry did not make this the second attempt')
  assert.equal(meta(runDir).run_status, 'in_progress')
  assert.deepEqual(readJsonFile(runDir, 'mint-feedback.json').attempts.map(a => [a.wave, a.stage]), [[7, '99-mint-w7'], [1, '05-mint-w1']], 'the other wave\'s entry is kept')
  const last = await runStage(runDir, bad())
  assert.match(last.apply.last, /\(attempt 2 of 2: the run is marked incomplete \(ledger_validation_failed\), and the reasons are in mint-feedback\.json\)$/)
  assert.deepEqual([meta(runDir).run_status, meta(runDir).incomplete_reason], ['incomplete', 'ledger_validation_failed'])
  assert.deepEqual(readLedger(runDir).filter(u => u.status === 'deferred').map(u => u.unresolved), [['ledger_validation_failed']])
  ok(runDir)
  assert.equal(next(runDir), 'NEXT: write-findings run=helper')
})

console.log('== the script a wave stage generates')
await test('the hunt script is the workflow with the seam line replaced and is far under the ceiling; one too big is refused with what to do, and no script is left', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const r = stage(['plan', runDir])
  assert.equal(r.status, 0, r.stdout)
  const bytes = Number(r.last.match(/bytes=(\d+)/)[1])
  assert.ok(bytes > 30_000 && bytes < 150_000, `${bytes} bytes: the shared upstream parts plus one block`)
  writeFileSync(join(runDir, 'architecture.md'), `${'architecture '.repeat(60_000)}\n`)   // a hand-edit: seed caps it at 1,100 words
  const big = stage(['plan', runDir])
  assert.equal(big.status, 1)
  assert.match(big.last, /^AUDIT: FAIL the run script would be \d{6,} bytes; the Workflow tool refuses a script file over 524288 bytes and this version stops at 500000 \(input: \d+ bytes\)\. The stage input is the ledger and its blocks: a wave of fewer units, or --max-units-per-hunter, makes it smaller$/)
  assert.ok(!existsSync(join(runDir, 'stages', '03-hunt-w1', 'run.js')))
})
await test('the critic input trims a check\'s result prose and nothing else, carries every candidate with its units, and the ledger it sends is the ledger on disk', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const fp = 'fixture-lead-1'
  await runStage(runDir, { 'audit-analyst': hunters(runDir, (label, ids) => (label === 'h1-01' ? covered(label, ids, { units: covered(label, ids).units.map(u => ({ ...u, disposition: 'candidate', candidate_fingerprints: [fp] })), candidates: [candidateOf(fp)] }) : covered(label, ids))) })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  const run = loadRun(runDir)
  const input = criticInput(runDir, run, nextStep(run))
  assert.deepEqual([input.stage, input.kind, input.wave], ['critic', 'post-wave', 1])
  assert.equal(input.ledger.length, run.ledger.length)
  for (const [i, u] of run.ledger.entries()) {
    const c = input.ledger[i]
    assert.deepEqual([c.coverage_id, c.status, c.agent_id, c.reviewed_paths, c.result_fingerprints, c.unresolved], [u.coverage_id, u.status, u.agent_id, u.reviewed_paths, u.result_fingerprints, u.unresolved])
    assert.deepEqual(c.checks, u.local_checks.map(({ result, artifact, ...rest }) => rest))
    assert.ok(!('local_checks' in c) && !JSON.stringify(c).includes('the handler calls it'), 'the prose of a check\'s result is not sent')
  }
  assert.deepEqual(input.candidates, [{ fingerprint: fp, proposed_verdict: 'needs_validation', units: [readLedger(runDir).find(u => u.status === 'candidate').coverage_id], hunter_ids: ['h1-01'] }])
  assert.equal(input.parts.criticSection, block('HUNTING.md#Coverage-critic waves').text)
})
await test('mint needs the critic\'s result on disk: without critic.json, or with one that is not the critic JSON, the plan says to apply the critic again', async () => {
  const { runDir } = await reconToSeed(three())
  ledgerCli(['plan-wave', runDir])
  const asg = assignments(runDir)
  await runStage(runDir, { 'audit-analyst': Object.keys(asg).map(l => covered(l, asg[l])) })
  ledgerCli(['merge-wave', runDir, join(runDir, 'hunter-results.json')])
  await runStage(runDir, { 'audit-researcher': [CRITIC()] })
  for (const bad of [null, '{"stop":true}', '[]', 'not json']) {
    if (bad === null) rmSync(join(runDir, 'critic.json')); else writeFileSync(join(runDir, 'critic.json'), bad)
    const r = stage(['plan', runDir])
    assert.equal(r.status, 1, String(bad))
    assert.match(r.last, /^AUDIT: FAIL (critic\.json is missing or not what apply wrote|.*critic\.json is not valid JSON)/)
  }
})
