// audit-run-state.test.mjs - audit-run.mjs beyond init: the budget gate and its upstream reason strings, earlier
// runs found and judged by upstream's validators, `next` for every stage-state fixture, `status`, and `check`.
import { join, basename } from 'node:path'
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, symlinkSync, appendFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import {
  REASONS, RECON_CALLS, STATUSES, STEPS, RUNNERS, EXECUTION_BLOCKERS, EXECUTION_POLICY, SUPPORTED_PROFILES,
  budgetGate, minimumBudget, criticReserve, validationReserve, waveAllowance, countStatuses, nextStep, formatNext, advanceState, writeJson, makeWritable,
} from '../skills/security-audit/audit-run.mjs'
import { VENDOR_SKILL_DIR, canonicalCoverageId } from '../skills/security-audit/upstream.mjs'
import { fresh, put, mkRepo, init, audit, meta } from './audit-fixtures.mjs'

const vendored = name => readFileSync(join(VENDOR_SKILL_DIR, name), 'utf8')
const SKILL = vendored('SKILL.md')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

// Valid upstream documents, so an earlier run can pass both validators.
const FINDINGS = () => [{
  verdict: 'rejected', fingerprint: 'src-router-auth-bypass', title: 'Authorization bypass in router', description: 'The candidate claimed a route bypassed authorization.',
  claimed_root_cause: 'dispatch was claimed to skip the authorization wrapper.', reason: 'All routes pass through the wrapper first.',
  trace: [{ kind: 'sink', file: 'src/router.ts', line: 10, scope: 'dispatch', description: 'Attacker data reaches the operation.' }],
  evidence: [{ file: 'src/router.ts', line: 10, description: 'The source performs the operation without a check.' }],
}]
const REFS = { surface: 'src/router.ts#POST /users/:id', boundary: 'src/authz.ts#requireOwner', subsystem: 'packages/api', attack_class: 'ATTACK-CLASSES.md#Access control' }
const LEDGER = () => [{
  coverage_id: canonicalCoverageId(REFS), canonical_refs: REFS, surface: 'Update-user route', boundary: 'Object ownership', subsystem: 'API', attack_class: 'Access control',
  starting_paths: ['src/router.ts'], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', selected_companion_blocks: [], excluded_blocks: [],
  prior_status: 'new', attempts: [], wave: 1, status: 'planned', agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [],
}]
const N_ERRORS = text => text.replace(/\d+ validation error\(s\)/, 'N validation error(s)')

console.log('== upstream is the authority for names and reason strings')
await test('every reason string is in the vendored text, in the file upstream puts it in, and no other reason-like string exists there', () => {
  const where = {
    fund: ['SKILL.md', /incomplete_reason: "budget_cannot_fund_reconnaissance_and_reserves"/],
    reserve: ['SKILL.md', /with reason `budget_cannot_reserve_critics_and_validation`/],
    critic: ['SKILL.md', /with reason `critic_budget_exhausted`/],
    validation: ['SKILL.md', /incomplete_reason: "validation_budget_exhausted"/],
    quick: ['HUNTING.md', /with reason `quick_profile_final_critic`/],
  }
  assert.deepEqual(Object.keys(REASONS).sort(), Object.keys(where).sort())
  for (const [key, [file, re]] of Object.entries(where)) {
    assert.match(vendored(file), re, `${key}: ${file}`)
    assert.ok(re.source.includes(REASONS[key]), `${key}: the pattern and the constant name different strings`)
  }
  const found = new Set(['SKILL.md', 'HUNTING.md', 'RECONNAISSANCE.md', 'VALIDATION-AND-REPORTING.md'].flatMap(f => vendored(f).match(/\b(?:budget_[a-z_]+|[a-z]+_budget_[a-z_]+|[a-z_]+_exhausted|quick_profile_[a-z_]+)\b/g) || []))
  assert.deepEqual([...found].sort(), Object.values(REASONS).sort(), 'upstream mentions a reason this file does not know, or the reverse')
})
await test('STATUSES are the eight states in upstream\'s state table and in the validator\'s own STATUSES set', () => {
  const set = vendored('validate-coverage-ledger.cjs').match(/const STATUSES = new Set\(\[([^\]]*)\]\)/)
  assert.ok(set, 'the validator no longer defines STATUSES as a Set literal')
  assert.deepEqual([...set[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort(), [...STATUSES].sort())
  const table = vendored('RECONNAISSANCE.md').split('Enforce this state table exactly:')[1].split('\n\n')[1]
  const firstColumn = table.split('\n').slice(2).map(row => row.split('|')[1]).join(' ')
  assert.deepEqual([...firstColumn.matchAll(/`([a-z_]+)`/g)].map(m => m[1]).sort(), [...STATUSES].sort())
  assert.equal(STATUSES.length, 8)
})
await test('the execution blockers quote upstream\'s controls, and the policy string is upstream\'s', () => {
  for (const b of EXECUTION_BLOCKERS) assert.ok(SKILL.includes(b), `not in SKILL.md: ${b}`)
  assert.ok(SKILL.includes(`execution_policy: "${EXECUTION_POLICY}"`))
  assert.ok(SKILL.includes('`run_status: "in_progress"`'))
})
await test('RUNNERS names every step but init, and STEPS has no duplicates', () => {
  assert.deepEqual(Object.keys(RUNNERS).sort(), STEPS.filter(s => s !== 'init').sort())
  assert.equal(new Set(STEPS).size, STEPS.length)
  assert.deepEqual(SUPPORTED_PROFILES, ['standard'])
})

console.log('== the budget gate')
await test('the minimum is the four recon calls, the critics, and one verifier: 7 for standard and deep, 6 for quick', () => {
  assert.equal(RECON_CALLS, 4)
  assert.deepEqual([criticReserve('quick'), criticReserve('standard'), criticReserve('deep')], [1, 2, 2])
  assert.deepEqual([minimumBudget('quick'), minimumBudget('standard'), minimumBudget('deep')], [6, 7, 7])
})
await test('budgetGate refuses below the minimum with upstream\'s reason, passes at it, and never gates an unset budget', () => {
  for (const [profile, budget, ok] of [['standard', null, true], ['standard', 7, true], ['standard', 6, false], ['standard', 0, false], ['standard', 1000, true],
    ['deep', 6, false], ['deep', 7, true], ['quick', 5, false], ['quick', 6, true]]) {
    const g = budgetGate(profile, budget)
    assert.equal(g.ok, ok, `${profile} ${budget}`)
    assert.equal(g.reason, ok ? null : 'budget_cannot_fund_reconnaissance_and_reserves', `${profile} ${budget}`)
    assert.equal(g.minimum, minimumBudget(profile))
  }
  for (const bad of [-1, 1.5, NaN, Infinity, '7', undefined, {}, [], true]) assert.throws(() => budgetGate('standard', bad), TypeError, String(bad))
  for (const bad of ['fast', null, undefined, 'Standard', 5]) assert.throws(() => budgetGate(bad, 10), TypeError, String(bad))
})
await test('waveAllowance never puts a hunter into a reserve, and zero room carries the reserve reason', () => {
  for (const profile of ['quick', 'standard', 'deep']) {
    for (const candidates of [null, 0, 1, 3, 10]) {
      for (let remaining = 0; remaining <= 80; remaining++) {
        const w = waveAllowance(profile, remaining, candidates)
        const label = `${profile} remaining=${remaining} candidates=${candidates}`
        assert.ok(Number.isInteger(w.hunters) && w.hunters >= 0, label)
        assert.ok(w.hunters === 0 || w.hunters + w.critics + w.validation === remaining, `${label}: hunters plus reserves must be the whole balance`)
        assert.equal(w.reason, w.hunters === 0 ? 'budget_cannot_reserve_critics_and_validation' : null, label)
        assert.equal(w.critics, criticReserve(profile), label)
        assert.ok(w.validation >= 1, `${label}: at least one verifier call`)
      }
    }
  }
  assert.deepEqual(waveAllowance('standard', 20), { critics: 2, validation: 6, hunters: 12, reason: null })     // 30% of the 18 left after the critics, rounded up
  assert.deepEqual(waveAllowance('standard', 10, 3), { critics: 2, validation: 6, hunters: 2, reason: null })   // two verifiers per expected candidate
  assert.deepEqual(waveAllowance('quick', 10, 3), { critics: 1, validation: 3, hunters: 6, reason: null })      // one verifier does both phases
  assert.deepEqual(waveAllowance('standard', 8, 3), { critics: 2, validation: 6, hunters: 0, reason: 'budget_cannot_reserve_critics_and_validation' })
  assert.equal(validationReserve('standard', 0), 1)
})
await test('init with a budget below the minimum launches nothing and records the run incomplete with upstream\'s reason', () => {
  const repo = mkRepo()
  const r = init([repo, '--full', '--budget', '6'])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL budget_cannot_fund_reconnaissance_and_reserves: --budget 6 cannot fund the 7 calls profile standard needs first \(4 reconnaissance, 2 critics, 1 verifier\); no agent was launched\./)
  const runDir = join(repo, '.git', 'security-audit', 'run-1')
  const m = meta(runDir)
  assert.deepEqual([m.budget, m.run_status, m.incomplete_reason, m.agents_spent], [6, 'incomplete', 'budget_cannot_fund_reconnaissance_and_reserves', 0])
  assert.equal(m.snapshot, null)
  assert.ok(!existsSync(join(runDir, 'tree')), 'no snapshot is made for a run that cannot be funded')
  const e = JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8'))
  assert.deepEqual([e.cmd, e.result, e.reason], ['init', 'refused', 'budget_cannot_fund_reconnaissance_and_reserves'])
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  assert.equal(audit(['next', runDir]).last, 'NEXT: report run=helper reason=budget_cannot_fund_reconnaissance_and_reserves')
  assert.equal(init([repo, '--full', '--budget', '0']).status, 1)
  const ok = init([repo, '--full', '--budget', '7'])
  assert.equal(ok.status, 0, ok.stdout)
  assert.equal(meta(ok.runDir).budget, 7)
  assert.equal(ok.runDir, join(repo, '.git', 'security-audit', 'run-3'), 'each refused attempt keeps its number')
  assert.equal(meta(init([repo, '--full']).runDir).budget, null)
})

console.log('== earlier runs')
const priorFiles = (repo, n, files) => {
  const d = join(repo, '.git', 'security-audit', `run-${n}`)
  mkdirSync(d, { recursive: true })
  for (const [f, v] of Object.entries(files)) put(join(d, f), typeof v === 'string' ? v : JSON.stringify(v))
  return d
}
await test('earlier runs are found, numbered, and judged by upstream\'s validators; every one is recorded, compatible or not', () => {
  const repo = mkRepo()
  const good = init([repo, '--full']).runDir                                   // run-1: a real run
  put(join(good, 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(good, 'findings.json'), JSON.stringify(FINDINGS()))
  const ledgerOnly = priorFiles(repo, 2, { 'coverage-ledger.json': LEDGER() })                    // stopped before Phase 4: no findings
  priorFiles(repo, 3, { 'coverage-ledger.json': [{ ...LEDGER()[0], coverage_id: 'wrong' }] })     // invalid ledger
  priorFiles(repo, 4, { 'coverage-ledger.json': LEDGER(), 'findings.json': [{ verdict: 'confirmed' }] })   // invalid findings
  priorFiles(repo, 5, { 'coverage-ledger.json': '[' })                                            // not JSON
  priorFiles(repo, 6, {})                                                                          // nothing at all
  priorFiles(repo, 7, { 'coverage-ledger.json': LEDGER(), 'run-metadata.json': { repo: 'renamed-since', run_status: 'complete' } })   // same git directory, so same repository whatever name it had
  priorFiles(repo, 8, { 'run-metadata.json': { repo: 5, run_status: ['x'], source_ref: 'abc', scope_paths: {}, profile: null } })   // metadata of the wrong types
  mkdirSync(join(repo, '.git', 'security-audit', 'notes')); mkdirSync(join(repo, '.git', 'security-audit', 'run-x'))   // not run directories
  const linked = fresh('linked-run')                                                              // a link to a perfectly good run elsewhere: never followed
  put(join(linked, 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(linked, 'findings.json'), JSON.stringify(FINDINGS()))
  symlinkSync(linked, join(repo, '.git', 'security-audit', 'run-9'))
  priorFiles(repo, 10, {})
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(basename(r.runDir), 'run-11', 'numbered past the highest earlier run, even an empty or incompatible one')
  const priors = readJson(join(r.runDir, 'prior-runs.json'))
  assert.deepEqual(priors.map(p => p.number), [1, 2, 3, 4, 5, 6, 7, 8, 10], 'numeric order, not run-10 before run-2; run-9 (a symlink) and run-x are not runs')
  const by = n => priors.find(p => p.number === n)
  assert.deepEqual(priors.map(p => p.compatible), [true, true, false, false, false, false, true, false, false])
  assert.deepEqual([by(1).ledger, by(1).findings], [{ state: 'pass', last_line: 'PASS: 1 coverage units valid' }, { state: 'pass', last_line: 'PASS: 1 findings valid' }])
  assert.deepEqual([by(2).ledger.state, by(2).findings.state], ['pass', 'missing'])
  assert.match(by(3).reasons[0], /^coverage-ledger\.json did not validate: FAIL: \d+ validation error/)
  assert.match(by(4).reasons[0], /^findings\.json did not validate: FAIL: /)
  assert.match(by(5).reasons[0], /^coverage-ledger\.json did not validate: /)
  assert.deepEqual(by(6).reasons, ['coverage-ledger.json is missing'])
  assert.deepEqual([by(7).reasons, by(7).repo], [[], 'renamed-since'])
  assert.deepEqual([by(8).run_status, by(8).repo, by(8).source_commit, by(8).scope_paths, by(8).profile], [null, null, null, null, null])
  assert.deepEqual([by(1).run_status, by(1).profile, by(1).repo, by(1).source_commit.length, by(1).scope_paths, by(1).source], ['in_progress', 'standard', meta(good).repo, 40, [], 'default'])
  assert.equal(by(2).path, ledgerOnly)
  assert.deepEqual(meta(r.runDir).prior_run_paths, priors.map(p => p.path))
  assert.match(r.stdout, /earlier_runs=9 compatible=3$/m)
  assert.match(r.stdout, /note: earlier run run-3 is incompatible \(coverage-ledger\.json did not validate: .*it is recorded in prior-runs\.json, never treated as empty coverage/)
  assert.equal(r.stdout.split('\n').filter(l => l.startsWith('note: earlier run')).length, 5, 'at most five notes')
})
await test('a prior run\'s source_ref.commit is kept only when it is a 40 or 64 hex commit ID; anything else is null and makes the run incompatible', () => {
  const repo = mkRepo()
  const commit40 = 'a'.repeat(40), commit64 = 'b'.repeat(64)
  const cases = [
    [1, { source_ref: { commit: commit40 } }, commit40, true],
    [2, { source_ref: { commit: commit64 } }, commit64, true],
    [3, { source_ref: { commit: '--output=/tmp/x' } }, null, false],       // an option, were it ever passed to git as a revision
    [4, { source_ref: { commit: 'main' } }, null, false],
    [5, { source_ref: { commit: 'A'.repeat(40) } }, null, false],          // upper case is not what git prints
    [6, { source_ref: { commit: 'a'.repeat(39) } }, null, false],
    [7, { source_ref: { commit: `${commit40}\n` } }, null, false],         // the anchors reject a trailing newline
    [8, { source_ref: { commit: 5 } }, null, false],
    [9, { source_ref: { commit: null } }, null, false],
    [10, { source_ref: { commit: { $ne: 1 } } }, null, false],
    [11, { source_ref: { commit: [commit40] } }, null, false],
    [12, { source_ref: {} }, null, true],                                  // absent: a Cloudflare-style run says nothing about its commit
    [13, { source_ref: 'abc' }, null, true],
    [14, {}, null, true],
  ]
  for (const [n, metadata, , ] of cases) priorFiles(repo, n, { 'coverage-ledger.json': LEDGER(), 'run-metadata.json': metadata })
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  const priors = readJson(join(r.runDir, 'prior-runs.json'))
  for (const [n, , commit, compatible] of cases) {
    const p = priors.find(x => x.number === n)
    assert.equal(p.source_commit, commit, `run-${n}`)
    assert.equal(p.compatible, compatible, `run-${n}`)
    if (!compatible) assert.match(p.reasons.join('; '), /source_ref\.commit is not a 40 or 64 hex commit ID/, `run-${n}`)
    else assert.deepEqual(p.reasons, [], `run-${n}`)
  }
  assert.match(priors.find(x => x.number === 3).reasons[0], /^its source_ref\.commit is not a 40 or 64 hex commit ID \("--output=\/tmp\/x"\), so the run is incompatible$/)
  assert.match(priors.find(x => x.number === 11).reasons[0], /is not a 40 or 64 hex commit ID \(.{1,60}\)/, 'the reason shows a bounded rendering, never the raw value')
  assert.ok(priors.find(x => x.number === 10).reasons[0].length < 200, 'a hostile value cannot flood the reason')
})
await test('--prior adds a run directory from anywhere (a Cloudflare-style one has no run-metadata.json), once, and must be a directory', () => {
  const repo = mkRepo()
  const own = init([repo, '--full']).runDir
  const foreign = fresh('foreign')
  put(join(foreign, 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(foreign, 'findings.json'), JSON.stringify(FINDINGS()))
  const stranger = fresh('stranger')                                                // another repository's run: valid files, a different name
  put(join(stranger, 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(stranger, 'run-metadata.json'), JSON.stringify({ repo: 'some-other-repo' }))
  const r = init([repo, '--full', '--prior', foreign, '--prior', own, '--prior', foreign, '--prior', stranger])
  assert.equal(r.status, 0, r.stdout)
  const priors = readJson(join(r.runDir, 'prior-runs.json'))
  assert.deepEqual(priors.map(p => [p.path, p.source, p.compatible]), [[own, 'default', false], [foreign, '--prior', true], [stranger, '--prior', false]])
  assert.deepEqual(priors[2].reasons, ['it audited a different repository (some-other-repo)'])
  assert.equal(priors[1].number, null)
  assert.match(init([repo, '--full', '--prior', join(foreign, 'coverage-ledger.json')]).last, /^AUDIT: FAIL --prior .* is not a directory$/)
  assert.match(init([repo, '--full', '--prior', join(foreign, 'nope')]).last, /^AUDIT: FAIL --prior .* is not a directory$/)
  const outside = join(fresh('elsewhere'), 'run')
  const viaOut = init([repo, '--full', '--out', outside])
  assert.equal(viaOut.runDir, outside)
  assert.equal(readJson(join(outside, 'prior-runs.json')).length, 2, '--out does not hide the runs beside the git directory')
})
await test('with no earlier run, prior-runs.json is an empty list and prior_run_paths is empty', () => {
  const r = init([mkRepo(), '--full'])
  assert.deepEqual(readJson(join(r.runDir, 'prior-runs.json')), [])
  assert.deepEqual(meta(r.runDir).prior_run_paths, [])
  assert.match(r.last, /earlier_runs=0 compatible=0$/)
})

console.log('== next: every stage-state fixture')
const unit = (status, extra = {}) => ({ status, result_fingerprints: [], ...extra })
const units = (status, n = 1) => Array.from({ length: n }, () => unit(status))
const cand = (...fps) => unit('candidate', { result_fingerprints: fps })
const M = (extra = {}) => ({ run_status: 'in_progress', incomplete_reason: null, ...extra })
const S = (last, wave = 0, critic_kind = null) => ({ version: 1, last, wave, critic_kind })
const refused = message => ({ refused: message })
const carried = status => unit('planned', { prior_status: status })
const INCOMPLETE = (reason = 'critic_budget_exhausted') => M({ run_status: 'incomplete', incomplete_reason: reason })
const HUNTING = ['plan-wave', 'hunt', 'merge-wave', 'critic', 'mint', 'apply-critic']
// [name, { meta, state, ledger?, findings? }, the exact line `next` prints, or { refused: message }]
const FIXTURES = [
  ['a fresh run starts with recon', { meta: M(), state: S('init') }, 'NEXT: recon run=workflow'],
  ['recon is followed by seed', { meta: M(), state: S('recon') }, 'NEXT: seed run=helper'],
  ['seed with planned units plans wave 1', { meta: M(), state: S('seed'), ledger: [...units('planned', 3), ...units('out_of_scope')] }, 'NEXT: plan-wave run=helper wave=1'],
  ['seed with nothing planned (out_of_scope, not_applicable, deferred) goes straight to the final-clean critic', { meta: M(), state: S('seed'), ledger: [...units('out_of_scope'), ...units('not_applicable'), ...units('deferred')] }, 'NEXT: critic run=workflow kind=final-clean wave=0'],
  ['seed with an empty ledger has nothing to hunt either', { meta: M(), state: S('seed'), ledger: [] }, 'NEXT: critic run=workflow kind=final-clean wave=0'],
  ['seed with an in_progress unit: plan-wave died before saving, so run the wave it planned', { meta: M(), state: S('seed'), ledger: [...units('in_progress', 2), ...units('planned')] }, 'NEXT: hunt run=workflow wave=1'],
  ['plan-wave with in_progress units hunts that wave', { meta: M(), state: S('plan-wave', 1), ledger: [...units('in_progress', 2), ...units('planned')] }, 'NEXT: hunt run=workflow wave=1'],
  ['plan-wave that deferred everything (no hunter fit) goes to the final-clean critic', { meta: M(), state: S('plan-wave', 2), ledger: [...units('deferred', 3), ...units('covered')] }, 'NEXT: critic run=workflow kind=final-clean wave=2'],
  ['plan-wave that assigned nothing and left units planned is refused: units the budget cannot reach must be deferred', { meta: M(), state: S('plan-wave', 2), ledger: units('planned', 2) }, refused('plan-wave left 2 unit(s) planned and assigned none: units the budget cannot reach are deferred')],
  ['hunt is followed by merge-wave', { meta: M(), state: S('hunt', 2) }, 'NEXT: merge-wave run=helper wave=2'],
  ['merge-wave is followed by the post-wave critic', { meta: M(), state: S('merge-wave', 2), ledger: [...units('covered', 2), ...units('planned'), cand('a')] }, 'NEXT: critic run=workflow kind=post-wave wave=2'],
  ['merge-wave with a unit still in_progress is refused', { meta: M(), state: S('merge-wave', 2), ledger: units('in_progress') }, refused('1 unit(s) are still in_progress after merge-wave: a merged wave leaves none')],
  ['critic is followed by mint', { meta: M(), state: S('critic', 2, 'post-wave') }, 'NEXT: mint run=workflow wave=2'],
  ['mint is followed by apply-critic', { meta: M(), state: S('mint', 2, 'post-wave') }, 'NEXT: apply-critic run=helper wave=2'],
  ['apply-critic that queued work plans the next wave', { meta: M(), state: S('apply-critic', 2, 'post-wave'), ledger: [...units('planned', 2), ...units('covered')] }, 'NEXT: plan-wave run=helper wave=3'],
  ['apply-critic of a post-wave critic that queued nothing asks for the distinct final-clean critic', { meta: M(), state: S('apply-critic', 2, 'post-wave'), ledger: [...units('covered', 4), cand('a')] }, 'NEXT: critic run=workflow kind=final-clean wave=2'],
  ['apply-critic of the final-clean critic that queued work starts the loop again', { meta: M(), state: S('apply-critic', 2, 'final-clean'), ledger: [...units('planned'), ...units('covered')] }, 'NEXT: plan-wave run=helper wave=3'],
  ['apply-critic with an in_progress unit hunts it', { meta: M(), state: S('apply-critic', 2, 'post-wave'), ledger: units('in_progress') }, 'NEXT: hunt run=workflow wave=3'],
  ['apply-critic with no critic_kind is refused', { meta: M(), state: S('apply-critic', 2, null), ledger: units('covered') }, refused('a critic result was applied but stage-state.json has no critic_kind')],
  ['coverage complete with no candidate: write the (empty) findings', { meta: M(), state: S('apply-critic', 3, 'final-clean'), ledger: [...units('covered', 3), ...units('blocked'), ...units('deferred'), ...units('out_of_scope'), ...units('not_applicable')] }, 'NEXT: write-findings run=helper'],
  ['coverage complete with one candidate fingerprint: nothing to consolidate, validate', { meta: M(), state: S('apply-critic', 3, 'final-clean'), ledger: [cand('a'), cand('a'), ...units('covered')] }, 'NEXT: validate run=workflow'],
  ['coverage complete with two candidate fingerprints: consolidate', { meta: M(), state: S('apply-critic', 3, 'final-clean'), ledger: [cand('a'), cand('b'), ...units('covered')] }, 'NEXT: consolidate run=workflow'],
  ['two fingerprints on one unit also consolidate', { meta: M(), state: S('apply-critic', 3, 'final-clean'), ledger: [cand('a', 'b')] }, 'NEXT: consolidate run=workflow'],
  ['consolidate is followed by validate', { meta: M(), state: S('consolidate', 3, 'final-clean') }, 'NEXT: validate run=workflow'],
  ['validate is followed by write-findings', { meta: M(), state: S('validate', 3, 'final-clean') }, 'NEXT: write-findings run=helper'],
  ['written findings with a needs_validation record are verified', { meta: M(), state: S('write-findings', 3), findings: [{ verdict: 'rejected' }, { verdict: 'needs_validation' }] }, 'NEXT: verify run=workflow'],
  ['written findings with a confirmed record are verified', { meta: M(), state: S('write-findings', 3), findings: [{ verdict: 'confirmed' }] }, 'NEXT: verify run=workflow'],
  ['written findings with only rejected records skip verify', { meta: M(), state: S('write-findings', 3), findings: [{ verdict: 'rejected' }, { verdict: 'rejected' }] }, 'NEXT: report run=helper'],
  ['an empty findings file skips verify', { meta: M(), state: S('write-findings', 3), findings: [] }, 'NEXT: report run=helper'],
  ['write-findings with no findings file is refused', { meta: M(), state: S('write-findings', 3) }, refused('findings.json is missing or not an array after write-findings')],
  ['write-findings with a findings object (not an array) is refused', { meta: M(), state: S('write-findings', 3), findings: { verdict: 'confirmed' } }, refused('findings.json is missing or not an array after write-findings')],
  ['verify is followed by the report', { meta: M({ run_status: 'complete' }), state: S('verify', 3) }, 'NEXT: report run=helper'],
  ['a written report of a complete run is done', { meta: M({ run_status: 'complete' }), state: S('report', 3) }, 'NEXT: done status=complete'],
  ['a written report of an incomplete run is done too, with its reason', { meta: M({ run_status: 'incomplete', incomplete_reason: 'validation_budget_exhausted' }), state: S('report', 3) }, 'NEXT: done status=incomplete reason=validation_budget_exhausted'],
  ['a written report with run_status still in_progress is refused', { meta: M(), state: S('report', 3) }, refused('the report is written but run_status is still in_progress: a finished run is complete or incomplete')],
  // An incomplete run stops hunting but is not reported until what it validated is written and verified (VALIDATION-AND-REPORTING.md
  // Phase 3 "after ... an explicitly recorded early stop", and Phase 6 "only after Phase 5 passes for every record retained").
  ...['init', 'recon', 'seed'].map(last => [`an incomplete run with no hunting behind it goes straight to the report from ${last}`,
    { meta: INCOMPLETE('budget_cannot_fund_reconnaissance_and_reserves'), state: S(last), ledger: [...units('planned', 2)] }, 'NEXT: report run=helper reason=budget_cannot_fund_reconnaissance_and_reserves']),
  ...HUNTING.map(last => [`an incomplete run stops hunting at ${last} and writes the findings of an empty candidate set`,
    { meta: INCOMPLETE(), state: S(last, 2, 'post-wave'), ledger: [...units('planned'), ...units('in_progress'), ...units('covered')] }, 'NEXT: write-findings run=helper']),
  ...HUNTING.map(last => [`an incomplete run stops hunting at ${last} and still validates the one candidate it has`,
    { meta: INCOMPLETE('validation_budget_exhausted'), state: S(last, 2, 'post-wave'), ledger: [cand('a'), ...units('planned')] }, 'NEXT: validate run=workflow']),
  ['an incomplete run with two candidates consolidates them first', { meta: INCOMPLETE(), state: S('merge-wave', 2), ledger: [cand('a'), cand('b')] }, 'NEXT: consolidate run=workflow'],
  ['an incomplete run still follows consolidate with validate', { meta: INCOMPLETE(), state: S('consolidate', 2) }, 'NEXT: validate run=workflow'],
  ['an incomplete run still follows validate with write-findings', { meta: INCOMPLETE(), state: S('validate', 2) }, 'NEXT: write-findings run=helper'],
  ['an incomplete run still verifies the records it keeps', { meta: INCOMPLETE(), state: S('write-findings', 2), findings: [{ verdict: 'confirmed' }] }, 'NEXT: verify run=workflow'],
  ['an incomplete run with nothing to verify goes to the report', { meta: INCOMPLETE(), state: S('write-findings', 2), findings: [{ verdict: 'rejected' }] }, 'NEXT: report run=helper reason=critic_budget_exhausted'],
  ['an incomplete run reports after verify', { meta: INCOMPLETE('record_verification_unresolved'), state: S('verify', 2) }, 'NEXT: report run=helper reason=record_verification_unresolved'],
  ['an incomplete run that stopped hunting needs its ledger', { meta: INCOMPLETE(), state: S('hunt', 2) }, refused('coverage-ledger.json is missing after hunt')],
  // A carried prior record is a planned unit its Phase 3 verifier owns (RECONNAISSANCE.md "Prior-run input"), not hunter work.
  ['a planned unit carrying a prior confirmed record is the verifier\'s, so nothing is left to hunt', { meta: M(), state: S('seed'), ledger: [carried('prior_confirmed_same_source'), ...units('covered')] }, 'NEXT: critic run=workflow kind=final-clean wave=0'],
  ['a planned unit carrying a prior needs_validation record is the verifier\'s too', { meta: M(), state: S('seed'), ledger: [carried('prior_needs_validation')] }, 'NEXT: critic run=workflow kind=final-clean wave=0'],
  ['planned units revalidating changed source, or that were deferred, blocked or out of scope before, are hunter work', { meta: M(), state: S('seed'), ledger: [carried('prior_confirmed_changed_source'), carried('prior_deferred'), carried('prior_blocked'), carried('prior_out_of_scope'), carried('new'), carried('none'), carried(undefined)] }, 'NEXT: plan-wave run=helper wave=1'],
  ['a plan-wave that left only carried units planned is not stuck', { meta: M(), state: S('plan-wave', 1), ledger: [carried('prior_confirmed_same_source'), ...units('covered')] }, 'NEXT: critic run=workflow kind=final-clean wave=1'],
  ['coverage complete with only a carried record: validate it', { meta: M(), state: S('apply-critic', 2, 'final-clean'), ledger: [carried('prior_confirmed_same_source'), ...units('covered')] }, 'NEXT: validate run=workflow'],
  ['coverage complete with a carried record and a candidate: consolidate', { meta: M(), state: S('apply-critic', 2, 'final-clean'), ledger: [carried('prior_needs_validation'), cand('a')] }, 'NEXT: consolidate run=workflow'],
  ['a reason with a newline still prints one line', { meta: M({ run_status: 'incomplete', incomplete_reason: 'two\nlines  here' }), state: S('recon', 0) }, 'NEXT: report run=helper reason=two lines here'],
  ['a ledger is required once seed has run', { meta: M(), state: S('seed') }, refused('coverage-ledger.json is missing after seed')],
  ['a ledger that is not an array is refused', { meta: M(), state: S('seed'), ledger: { units: [] } }, refused('coverage-ledger.json is not an array of units')],
  ['a unit with a status upstream does not define is refused', { meta: M(), state: S('seed'), ledger: [unit('weird')] }, refused('coverage-ledger.json unit 0 has no known status (got "weird"; upstream\'s are planned, not_applicable, out_of_scope, in_progress, covered, candidate, blocked, deferred)')],
]
const outcome = fx => { try { return formatNext(nextStep(fx)) } catch (e) { return refused(e.message) } }
await test(`nextStep gives the exact line for each of ${FIXTURES.length} stage-state fixtures`, () => {
  for (const [name, fx, want] of FIXTURES) assert.deepEqual(outcome(fx), want, name)
})
await test('after seed, each of the eight ledger statuses by itself decides: planned plans, in_progress hunts, the other six are settled', () => {
  const want = { planned: 'plan-wave', in_progress: 'hunt', not_applicable: 'critic', out_of_scope: 'critic', deferred: 'critic', covered: 'critic', blocked: 'critic', candidate: 'critic' }
  assert.deepEqual(Object.keys(want).sort(), [...STATUSES].sort())
  for (const status of STATUSES) assert.equal(nextStep({ meta: M(), state: S('seed'), ledger: [unit(status, status === 'candidate' ? { result_fingerprints: ['a'] } : {})] }).step, want[status], status)
})
await test('countStatuses counts all eight and refuses what is not a unit with a known string status (null, numbers, objects, arrays, prototype names)', () => {
  assert.deepEqual(countStatuses([]), Object.fromEntries(STATUSES.map(s => [s, 0])))
  assert.deepEqual(countStatuses([unit('planned'), unit('planned'), unit('not_applicable'), unit('in_progress')]), { planned: 2, not_applicable: 1, out_of_scope: 0, in_progress: 1, covered: 0, candidate: 0, blocked: 0, deferred: 0 })
  for (const bad of [null, undefined, 5, 'planned', [], {}, { status: null }, { status: 5 }, { status: ['planned'] }, { status: '__proto__' }, { status: 'constructor' }, { status: 'toString' }, { status: 'Planned' }, { status: 'planned ' }]) {
    assert.throws(() => countStatuses([unit('planned'), bad]), /unit 1 has no known status/, JSON.stringify(bad))
  }
  for (const bad of [null, {}, 'x', 5]) assert.throws(() => countStatuses(bad), /not an array of units/)
})
await test('walking a whole run through nextStep, as the helpers would leave the disk, visits every step and ends at done', () => {
  const ledger = [...units('planned', 3), ...units('deferred')]
  let state = S('init'), run = M(), findings
  const steps = []
  const set = (last, extra = {}) => { state = { ...state, last, ...extra } }
  for (let i = 0; i < 40; i++) {
    const n = nextStep({ meta: run, state, ledger, findings })
    steps.push(n.step + (n.kind ? `:${n.kind}` : ''))
    if (n.step === 'done') break
    if (n.step === 'plan-wave') { ledger.filter(u => u.status === 'planned').slice(0, 2).forEach(u => { u.status = 'in_progress' }); set('plan-wave', { wave: n.wave }) }
    else if (n.step === 'merge-wave') { ledger.filter(u => u.status === 'in_progress').forEach(u => { u.status = 'covered' }); ledger.push(cand(`f${state.wave}`)); set('merge-wave') }
    else if (n.step === 'critic') set('critic', { critic_kind: n.kind })
    else if (n.step === 'write-findings') { findings = [{ verdict: 'needs_validation' }]; set('write-findings') }
    else if (n.step === 'verify') { run = M({ run_status: 'complete' }); set('verify') }
    else set(n.step)
  }
  assert.deepEqual(steps, [
    'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic',
    'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic',
    'critic:final-clean', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report', 'done',
  ])
})
await test('the next command prints one NEXT line (or NEXT: FAIL and exit 1) from what is on disk', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  assert.deepEqual([audit(['next', runDir]).status, audit(['next', runDir]).stdout], [0, 'NEXT: recon run=workflow\n'])
  advanceState(runDir, 'recon')
  assert.equal(audit(['next', runDir]).last, 'NEXT: seed run=helper')
  advanceState(runDir, 'seed')
  const missing = audit(['next', runDir])
  assert.deepEqual([missing.status, missing.stdout], [1, 'NEXT: FAIL coverage-ledger.json is missing after seed\n'])
  put(join(runDir, 'coverage-ledger.json'), JSON.stringify(LEDGER()))
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=1')
  writeJson(join(runDir, 'coverage-ledger.json'), [{ ...LEDGER()[0], status: 'in_progress', agent_id: 'h1-01' }])
  advanceState(runDir, 'plan-wave', { wave: 1 })
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1')
  advanceState(runDir, 'critic', { critic_kind: 'final-clean', wave: 4 })
  assert.equal(audit(['next', runDir]).last, 'NEXT: mint run=workflow wave=4')
  const nowhere = join(runDir, 'nope')
  assert.equal(audit(['next', nowhere]).last, `NEXT: FAIL ${nowhere} has no run-metadata.json: it is not a run directory`)
  for (const [args, status] of [[[], 2], [['x', 'y'], 2], [[nowhere], 1]]) assert.equal(audit(['next', ...args]).status, status, args.join(' '))
  writeFileSync(join(runDir, 'stage-state.json'), '{"version": 1, "last": "bogus", "wave": 0, "critic_kind": null}')
  assert.match(audit(['next', runDir]).last, /^NEXT: FAIL stage-state\.json is not \{ version: 1, last: <step>/)
  writeFileSync(join(runDir, 'stage-state.json'), '{')
  assert.match(audit(['next', runDir]).last, /^NEXT: FAIL .*stage-state\.json is not valid JSON/)
  assert.equal(audit(['bogus']).status, 2)
  assert.equal(audit([]).status, 2)
})

console.log('== status and check')
await test('status prints the run, all eight ledger counts, the findings counts, the budget, and the next step', () => {
  const repo = mkRepo()
  init([repo, '--full'])
  const runDir = init([repo, '--full', '--budget', '40']).runDir
  writeJson(join(runDir, 'run-metadata.json'), { ...meta(runDir), agents_spent: 12 })
  writeJson(join(runDir, 'coverage-ledger.json'), [...units('planned', 2), ...units('not_applicable'), ...units('in_progress'), cand('a')])
  writeJson(join(runDir, 'findings.json'), [{ verdict: 'needs_validation' }, { verdict: 'rejected' }, { verdict: 'rejected' }])
  advanceState(runDir, 'plan-wave', { wave: 1 })
  const r = audit(['status', runDir])
  assert.equal(r.status, 0)
  assert.deepEqual(r.lines, [
    `run run-2 (${meta(runDir).repo}): profile standard, in_progress`,
    `source: ${meta(runDir).source_ref.commit.slice(0, 12)}`,
    'last step: plan-wave, wave 1',
    'ledger: 5 units: planned 2, not_applicable 1, out_of_scope 0, in_progress 1, covered 0, candidate 1, blocked 0, deferred 0',
    'findings: 3 records: confirmed 0, needs_validation 1, rejected 2',
    'agents: 12 of 40 (28 left)',
    'earlier runs: 1 found, 0 compatible',
    'events: 1',
    'NEXT: hunt run=workflow wave=1',
  ])
  assert.equal(audit(['status', join(repo, 'nope')]).status, 1)
})
await test('check passes a fresh run, and a run whose ledger and findings pass upstream\'s validators', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  put(join(runDir, 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(runDir, 'findings.json'), JSON.stringify(FINDINGS()))
  assert.equal(audit(['check', runDir]).status, 0)
})
await test('check names each problem: a writable or non-regular tree, bad metadata, a torn events file, invalid upstream files', () => {
  const repo = mkRepo({ 'a.txt': 'x\n' })
  const problems = mutate => {
    const runDir = init([repo, '--full']).runDir
    mutate(runDir)
    const r = audit(['check', runDir])
    assert.equal(r.status, 1, r.stdout)
    assert.equal(r.last, `AUDIT: FAIL ${runDir} has ${r.lines.length - 1} problem(s)`)
    return r.lines.slice(0, -1).map(l => { assert.ok(l.startsWith('check: '), l); return N_ERRORS(l.slice(7)) })
  }
  const edit = (runDir, fn) => writeJson(join(runDir, 'run-metadata.json'), fn(meta(runDir)))
  const dropTree = d => { makeWritable(join(d, 'tree')); rmSync(join(d, 'tree'), { recursive: true }) }
  const reason = 'run-metadata.json: incomplete_reason is set exactly when run_status is incomplete'
  assert.deepEqual(problems(d => chmodSync(join(d, 'tree', 'a.txt'), 0o644)), ['tree/: 1 problem(s), first: a.txt is writable'])
  assert.deepEqual(problems(d => { chmodSync(join(d, 'tree'), 0o755); symlinkSync('/etc/hostname', join(d, 'tree', 'link')); chmodSync(join(d, 'tree'), 0o555) }), ['tree/: 1 problem(s), first: link is neither a file nor a directory'])
  assert.deepEqual(problems(d => chmodSync(join(d, 'tree'), 0o755)), ['tree/: 1 problem(s), first: tree/ is writable'])
  assert.deepEqual(problems(dropTree), ['tree/ is missing'])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, execution_policy: 'anything-goes' }))), [`run-metadata.json: execution_policy must be "${EXECUTION_POLICY}"`])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, run_status: 'incomplete' }))), [reason])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, run_status: 'in_progress', incomplete_reason: 'x' }))), [reason])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, budget: 10, agents_spent: 11 }))), ['run-metadata.json: 11 agents spent against a budget of 10, and the run is not marked incomplete'])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, profile: 'quick' }))), ['run-metadata.json: profile must be one of standard'])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, scope_paths: ['../x'], limits: { max_parallel: 17, max_units_per_hunter: 0 } }))), ['run-metadata.json: scope_paths must be safe repository-relative paths', 'run-metadata.json: limits.max_parallel is 1-16 and limits.max_units_per_hunter at least 1'])
  assert.deepEqual(problems(d => edit(d, m => ({ ...m, execution_blockers: [] }))), ['run-metadata.json: execution_capability must be none (with its blockers) or sandboxed'])
  assert.deepEqual(problems(d => appendFileSync(join(d, 'events.jsonl'), '{"at": "x"')), ['events.jsonl ends in the middle of a line'])
  const notEvent = n => `events.jsonl line ${n} is not an event object (at, cmd, stage, result, reason)`
  assert.deepEqual(problems(d => appendFileSync(join(d, 'events.jsonl'), '[1]\n{"at":"x","cmd":"c","stage":"s","result":"r","reason":5}\n')), [notEvent(2), notEvent(3)])
  assert.deepEqual(problems(d => rmSync(join(d, 'events.jsonl'))), ['events.jsonl is missing'])
  assert.deepEqual(problems(d => put(join(d, 'coverage-ledger.json'), JSON.stringify([{ ...LEDGER()[0], coverage_id: 'wrong' }]))), ['coverage-ledger.json: FAIL: N validation error(s)'])
  assert.deepEqual(problems(d => put(join(d, 'findings.json'), '[{"verdict":"confirmed"}]')), ['findings.json: FAIL: N validation error(s)'])
  assert.deepEqual(problems(d => { advanceState(d, 'write-findings'); put(join(d, 'findings.json'), '{}') }), ['findings.json: FAIL: N validation error(s)', 'next: findings.json is missing or not an array after write-findings'])
})
await test('check refuses a directory that is not a run, and a file that is not JSON, instead of reporting an empty run', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  const nowhere = audit(['check', fresh('empty')])
  assert.equal(nowhere.status, 1)
  assert.match(nowhere.last, /^AUDIT: FAIL .* has no run-metadata\.json: it is not a run directory$/)
  put(join(runDir, 'findings.json'), '[')
  assert.match(audit(['check', runDir]).last, /^AUDIT: FAIL .*findings\.json is not valid JSON/)
  put(join(runDir, 'findings.json'), '[]')
  put(join(runDir, 'run-metadata.json'), '[]')
  assert.match(audit(['check', runDir]).last, /^AUDIT: FAIL .*run-metadata\.json has no valid run_status/)
  put(join(runDir, 'run-metadata.json'), '{"run_status": "done"}')
  assert.match(audit(['check', runDir]).last, /no valid run_status \(in_progress, complete, incomplete\)/)
})

console.log('== review findings')
await test('a hunt saved right after apply-critic carries the wave next announced, so the next wave is a new number', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  advanceState(runDir, 'recon'); advanceState(runDir, 'seed')
  writeJson(join(runDir, 'coverage-ledger.json'), [...units('planned', 2)])
  advanceState(runDir, 'plan-wave', { wave: 1 })
  writeJson(join(runDir, 'coverage-ledger.json'), [...units('in_progress', 2)])
  advanceState(runDir, 'hunt'); advanceState(runDir, 'merge-wave', {})
  writeJson(join(runDir, 'coverage-ledger.json'), [...units('covered', 2), ...units('planned')])
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint'); advanceState(runDir, 'apply-critic')
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
  // plan-wave ran (the ledger shows it) but died before saving its step: next says hunt wave 2 ...
  writeJson(join(runDir, 'coverage-ledger.json'), [...units('covered', 2), ...units('in_progress')])
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=2')
  advanceState(runDir, 'hunt')                                                  // ... and saving the hunt step keeps that number
  assert.equal(readJson(join(runDir, 'stage-state.json')).wave, 2)
  assert.equal(audit(['next', runDir]).last, 'NEXT: merge-wave run=helper wave=2')
  writeJson(join(runDir, 'coverage-ledger.json'), units('covered', 3))
  advanceState(runDir, 'merge-wave')
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=post-wave wave=2')
  advanceState(runDir, 'plan-wave', { wave: 5 }); advanceState(runDir, 'hunt')
  assert.equal(readJson(join(runDir, 'stage-state.json')).wave, 5, 'a hunt after plan-wave leaves the wave plan-wave set')
})
await test('with --out, the run-<N> directories beside it are found too, and earlier runs of the same repository still are', () => {
  const repo = mkRepo()
  const own = init([repo, '--full']).runDir
  const parent = fresh('mine')
  const first = init([repo, '--full', '--out', join(parent, 'run-1')]).runDir
  const second = init([repo, '--full', '--out', join(parent, 'run-2')]).runDir
  const third = init([repo, '--full', '--out', join(parent, 'audit-3')]).runDir
  assert.deepEqual(readJson(join(second, 'prior-runs.json')).map(p => [p.path, p.source]), [[own, 'default'], [first, 'beside --out']])
  assert.deepEqual(readJson(join(third, 'prior-runs.json')).map(p => [p.path, p.source]), [[own, 'default'], [first, 'beside --out'], [second, 'beside --out']])
  put(join(parent, 'run-7', 'coverage-ledger.json'), JSON.stringify(LEDGER())); put(join(parent, 'run-7', 'run-metadata.json'), JSON.stringify({ repo: 'another-project' }))
  const fourth = readJson(join(init([repo, '--full', '--out', join(parent, 'run-8')]).runDir, 'prior-runs.json'))
  assert.deepEqual(fourth.find(p => p.run_id === 'run-7').reasons, ['it audited a different repository (another-project)'], 'a directory shared with other work is checked by name')
})
await test('init rejects an empty or repeated option instead of picking one silently, and says when --max-parallel was clamped', () => {
  const repo = mkRepo()
  for (const args of [['--out', ''], ['--profile', ''], ['--scope', 'a', '--scope', 'b'], ['--out', '/tmp/x', '--out', '/tmp/y'], ['--budget', '8', '--budget', '9']]) {
    assert.equal(init([repo, '--full', ...args]).status, 2, args.join(' '))
  }
  const r = init([repo, '--full', '--max-parallel', '99'])
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^note: --max-parallel 99 is above 16: using 16 \(/m)
  assert.ok(!/--max-parallel/.test(init([repo, '--full', '--max-parallel', '16']).stdout), 'no note when nothing was clamped')
})
