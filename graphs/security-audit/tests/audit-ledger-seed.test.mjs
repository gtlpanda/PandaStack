// audit-ledger-seed.test.mjs - audit-ledger.mjs: seed, the one write path (commitLedger), and canonical IDs. Every ledger it
// writes passes upstream's validator; one that would not is refused and the file is left as it was.
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { ARCHITECTURE_WORD_CAP, byId, commitLedger, seed } from '../skills/security-audit/audit-ledger.mjs'
import { VENDOR_SKILL_DIR, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { companions, ordinary } from '../skills/security-audit/blocks.mjs'
import { audit, newRun } from './audit-fixtures.mjs'
import { ARCH, ledgerBytes, ledgerValid, readJsonFile, readLedger, reconInput, refsOf, seeded, unitInput, LEDGER_PATH } from './ledger-fixtures.mjs'

const vendored = createRequire(import.meta.url)(join(VENDOR_SKILL_DIR, 'validate-coverage-ledger.cjs'))
const seedRefused = (runDir, input, pattern) => {
  const before = existsSync(LEDGER_PATH(runDir)) ? ledgerBytes(runDir) : null
  assert.throws(() => seed(runDir, input), e => pattern.test(`${e.message}\n${(e.problems ?? []).join('\n')}`), `expected a refusal matching ${pattern}`)
  assert.equal(existsSync(LEDGER_PATH(runDir)) ? ledgerBytes(runDir) : null, before, 'a refused seed must leave the ledger as it was')
  assert.ok(!existsSync(join(runDir, 'architecture.md')) || before !== null, 'a refused first seed writes no architecture.md')
  assert.deepEqual(readdirSync(runDir).filter(f => f.includes('.tmp') || f.includes('.candidate')), [], 'no scratch file is left behind')
}

console.log('== seed: a validator-passing, sorted ledger; the step saved')
await test('seed writes a ledger upstream accepts, architecture.md, the saved step and one event; `next` then says plan-wave', () => {
  const { runDir } = seeded([unitInput('A'), unitInput('B', { priority_class: 1 })])
  assert.ok(ledgerValid(runDir))
  assert.equal(readFileSync(join(runDir, 'architecture.md'), 'utf8'), `${ARCH}\n`)
  const state = readJsonFile(runDir, 'stage-state.json')
  assert.deepEqual([state.version, state.last, state.wave], [1, 'seed', 0])
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual([events.at(-1).cmd, events.at(-1).stage, events.at(-1).result, events.at(-1).counts.planned], ['seed', 'seed', 'ok', 2])
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=1')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  const [u] = readLedger(runDir)
  assert.deepEqual([u.status, u.wave, u.agent_id, u.prior_status, u.attempts, u.reviewed_paths, u.local_checks, u.result_fingerprints, u.unresolved], ['planned', 1, null, 'none', [], [], [], [], []])
})
await test('units are sorted by coverage_id in code-unit order, which is not localeCompare order (the validator compares code units)', () => {
  const upper = unitInput('Zeta'), lower = unitInput('alpha')
  assert.ok('src%2Fapp.js%23Zeta' < 'src%2Fapp.js%23alpha' && 'alpha'.localeCompare('Zeta') < 0, 'the fixture must separate the two orders')
  const { runDir, ids } = seeded([lower, upper])
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)))
  assert.ok(ids[0].includes('Zeta'))
  assert.ok(ledgerValid(runDir))
  assert.equal(byId({ coverage_id: 'a' }, { coverage_id: 'B' }), 1)
})

console.log('== canonical IDs are the vendored encoder\'s, for tricky inputs')
await test('IDs equal the validator\'s own encoder joined with :: and differ from encodeURIComponent where that is not RFC 3986', () => {
  const tricky = [
    { surface: 'src/a b.ts#GET /users/:id', boundary: "b!*'()", subsystem: 'pkg/é', attack_class: 'ATTACK-CLASSES.md#Access control' },
    { surface: 'src/日本語/ルート.ts#POST /x', boundary: 'a::b', subsystem: 'emoji-\u{1F600}', attack_class: 'ATTACK-CLASSES.md#Injection' },
    { surface: 'a%20b', boundary: 'tilde~dot.under_score-dash', subsystem: 'Mixed/Case', attack_class: '100% a/b\\c' },
  ]
  const units = tricky.map((refs, i) => unitInput(`t${i}`, { canonical_refs: refs, surface: `Surface ${i}` }))
  const { runDir } = seeded(units)
  const ledger = readLedger(runDir)
  assert.equal(ledger.length, 3)
  for (const refs of tricky) {
    const expected = ['surface', 'boundary', 'subsystem', 'attack_class'].map(f => vendored.encodeCanonicalRef(refs[f])).join('::')
    const unit = ledger.find(u => u.canonical_refs.surface === refs.surface)
    assert.equal(unit.coverage_id, expected)
    assert.equal(unit.coverage_id, vendored.canonicalCoverageId(refs))
  }
  const first = ledger.find(u => u.canonical_refs.boundary === "b!*'()")
  assert.equal(first.coverage_id, 'src%2Fa%20b.ts%23GET%20%2Fusers%2F%3Aid::b%21%2A%27%28%29::pkg%2F%C3%A9::ATTACK-CLASSES.md%23Access%20control')
  assert.notEqual(first.coverage_id, ['surface', 'boundary', 'subsystem', 'attack_class'].map(f => encodeURIComponent(first.canonical_refs[f])).join('::'))
  assert.ok(ledger.find(u => u.canonical_refs.boundary === 'a::b').coverage_id.includes('::a%3A%3Ab::'), 'a :: inside a ref is escaped, so the join is unambiguous')
  assert.ok(ledgerValid(runDir))
})
await test('a lifecycle ref joins the ID and needs the display field too; the ID matches the encoder', () => {
  const refs = { ...refsOf('life'), lifecycle: 'upload/finalize' }
  const { runDir } = seeded([unitInput('life', { canonical_refs: refs, lifecycle: 'Upload finalize' })])
  const [u] = readLedger(runDir)
  assert.equal(u.coverage_id, vendored.canonicalCoverageId(refs))
  assert.ok(u.coverage_id.endsWith('::upload%2Ffinalize'))
  assert.ok(ledgerValid(runDir))
  const { runDir: other } = newRun()
  seedRefused(other, reconInput([unitInput('life', { canonical_refs: refs })]), /lifecycle and canonical_refs.lifecycle must appear together/)
})
await test('a ref that is not NFC, has a control character or surrounding space is refused with its unit named, never normalized or crashed on', () => {
  for (const [label, bad] of [['NFD e-acute', 'e\u0301'], ['trailing space', 'x '], ['control character', 'a\u0007b'], ['zero-width space', 'a\u200bb'], ['empty', ''], ['lone surrogate', 'a\ud800']]) {
    const { runDir } = newRun()
    seedRefused(runDir, reconInput([unitInput('ok'), unitInput('bad', { canonical_refs: refsOf('bad', { subsystem: bad }) })]), /unit 1 \("Route bad"\): .*canonical_refs\.subsystem: invalid canonical reference/)
    assert.equal(audit(['next', runDir]).last, 'NEXT: seed run=helper', label)
  }
  const { runDir } = newRun()
  seedRefused(runDir, reconInput([unitInput('x', { canonical_refs: { ...refsOf('x'), extra: 'y' } })]), /canonical_refs/)
  seedRefused(runDir, reconInput([unitInput('x', { canonical_refs: { surface: 'only' } })]), /unit 0/)
  seedRefused(runDir, reconInput([unitInput('x', { canonical_refs: null })]), /unit 0/)
})

console.log('== seed: refusals leave nothing behind')
await test('a duplicate ID, a canonical identity collision and one semantic tuple under two IDs are all refused, never merged', () => {
  const { runDir } = newRun()
  seedRefused(runDir, reconInput([unitInput('d'), unitInput('d')]), /unit 1 .*already unit 0's/)
  seedRefused(runDir, reconInput([unitInput('d'), unitInput('d', { surface: 'Different display label' })]), /unit 1 .*canonical identity collision/)
  seedRefused(runDir, reconInput([unitInput('d'), unitInput('e', { surface: 'Route d', boundary: 'Query helper', subsystem: 'Source', attack_class: 'Access control' })]), /semantic tuple already uses coverage ID/)
})
await test('input that is not { architecture_md, units } is refused: null, numbers, arrays, strings, no units, a bad architecture', () => {
  const { runDir } = newRun()
  for (const bad of [null, 0, 42, 'recon', [], [unitInput('a')], true]) seedRefused(runDir, bad, /recon\.json must be an object/)
  seedRefused(runDir, { architecture_md: ARCH }, /units must be a non-empty array/)
  seedRefused(runDir, reconInput([]), /units must be a non-empty array/)
  seedRefused(runDir, reconInput('units'), /units must be a non-empty array/)
  seedRefused(runDir, { units: [unitInput('a')] }, /architecture_md is missing/)
  seedRefused(runDir, reconInput([unitInput('a')], { architecture_md: '   \n' }), /architecture_md is missing/)
  seedRefused(runDir, reconInput([unitInput('a')], { architecture_md: 7 }), /architecture_md is missing/)
  seedRefused(runDir, reconInput([unitInput('a')], { architecture_md: Array(ARCHITECTURE_WORD_CAP + 1).fill('word').join(' ') }), /has 1101 words/)
  seedRefused(runDir, reconInput([42, null, 'u', []]), /unit 0 \(""\): is not an object[\s\S]*unit 3/)
})
await test('the architecture cap is 1,100 words: 1,100 passes, 1,101 does not', () => {
  const { runDir } = newRun()
  seed(runDir, reconInput([unitInput('a')], { architecture_md: `${Array(ARCHITECTURE_WORD_CAP).fill('word').join('\n')}` }))
  assert.ok(ledgerValid(runDir))
})
await test('a unit starts untouched: seeding covered, in_progress, candidate or an unknown status is refused; a bad priority or a missing reason too', () => {
  for (const status of ['covered', 'in_progress', 'candidate', 'blocked', 'done', 7, null]) {
    const { runDir } = newRun()
    seedRefused(runDir, reconInput([unitInput('a', { status, reason: 'because' })]), /is not one of planned, not_applicable, out_of_scope, deferred/)
  }
  const { runDir } = newRun()
  for (const status of ['deferred', 'not_applicable', 'out_of_scope']) {
    seedRefused(runDir, reconInput([unitInput('a', { status })]), new RegExp(`a ${status} unit needs a reason`))
    seedRefused(runDir, reconInput([unitInput('a', { status, reason: '  ' })]), /needs a reason/)
  }
  for (const priority_class of [0, 5, 1.5, '1', NaN, {}]) seedRefused(runDir, reconInput([unitInput('a', { priority_class })]), /priority_class must be an integer from 1 to 4/)
})
await test('a starting path outside tree/, a path upstream calls unsafe, and a missing field are refused by name', () => {
  const { runDir } = newRun()
  seedRefused(runDir, reconInput([unitInput('a', { starting_paths: ['src/nope.js'] })]), /starting path src\/nope\.js is not in tree\//)
  for (const unsafe of ['../x', '/etc/passwd', 'src/aux.ts', 'src\\app.js', 'src/app.js ', 'c:/x']) {
    seedRefused(runDir, reconInput([unitInput('a', { starting_paths: [unsafe] })]), /starting_paths\[0\]: invalid repository-relative path/)
  }
  seedRefused(runDir, reconInput([unitInput('a', { starting_paths: [] })]), /starting_paths: must not be empty/)
  seedRefused(runDir, reconInput([unitInput('a', { starting_paths: 'src/app.js' })]), /starting_paths: expected array/)
  const noBlock = unitInput('a'); delete noBlock.excluded_blocks
  seedRefused(runDir, reconInput([noBlock]), /missing required field "excluded_blocks"/)
  const noSurface = unitInput('a'); delete noSurface.surface
  seedRefused(runDir, reconInput([noSurface]), /missing required field "surface"/)
})
await test('seed runs only as the next step: twice, or before recon, is refused and the ledger is unchanged', () => {
  const { runDir } = seeded([unitInput('a')])
  const before = ledgerBytes(runDir)
  assert.throws(() => seed(runDir, reconInput([unitInput('b')])), /seed is not the next step of this run: NEXT: plan-wave/)
  assert.equal(ledgerBytes(runDir), before)
  const fresh = newRun()
  writeFileSync(join(fresh.runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'init', wave: 0, critic_kind: null, updated: 'x' }))
  assert.throws(() => seed(fresh.runDir, reconInput([unitInput('a')])), /seed is not the next step of this run: NEXT: recon/)
  assert.ok(!existsSync(LEDGER_PATH(fresh.runDir)))
})

console.log('== seed: every block a unit names resolves through blocks.mjs')
const AI = companions().find(c => c.file === 'AI-AND-LLM.md')
await test('a unit that selects real blocks (an ordinary class, a companion class with its three fixed sections) seeds, and a null ordinary block is allowed', () => {
  const selected = [AI.core, AI.classes[1], AI.universal, AI.validation]
  const { runDir } = seeded([
    unitInput('real', { selected_companion_blocks: selected, excluded_blocks: [{ block: AI.classes[0], reason: 'no retrieval in this app' }, { block: AI.whenToUse, reason: 'the whole file was considered' }, { block: ordinary()[7], reason: 'no wildcard pass here' }] }),
    unitInput('none', { ordinary_attack_class_block: null }),
  ])
  assert.deepEqual(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u.ordinary_attack_class_block, u.selected_companion_blocks.length]), [['none', null, 0], ['real', 'ATTACK-CLASSES.md#Access control', 4]])
  assert.ok(ledgerValid(runDir))
})
await test('a block that does not resolve, or resolves but is the wrong kind of block, refuses the seed naming the field and the reference', () => {
  const { runDir } = newRun()
  const bad = (over, pattern) => seedRefused(runDir, reconInput([unitInput('a', over)]), pattern)
  // the ordinary field
  bad({ ordinary_attack_class_block: 'ATTACK-CLASSES.md#Chained vulnerabilities' }, /ordinary_attack_class_block: unknown block ATTACK-CLASSES\.md#Chained vulnerabilities/)   // the plan's short form
  bad({ ordinary_attack_class_block: 'ATTACK-CLASSES.md#access control' }, /unknown block/)                                  // case matters
  bad({ ordinary_attack_class_block: 'ACCESS' }, /ordinary_attack_class_block: malformed block reference/)
  bad({ ordinary_attack_class_block: '' }, /malformed block reference/)
  bad({ ordinary_attack_class_block: 'NOPE.md#Access control' }, /unknown block file NOPE\.md/)
  bad({ ordinary_attack_class_block: AI.core }, /ordinary_attack_class_block AI-AND-LLM\.md#Core discipline resolves but is not an ordinary attack-class block/)
  // the selected companion blocks
  bad({ selected_companion_blocks: ['WEB-PROTOCOL-AND-AUTH.md#Cache behavior'] }, /selected_companion_blocks\[0\]: unknown block WEB-PROTOCOL-AND-AUTH\.md#Cache behavior/)   // upstream's own test fixture, which its validator accepts
  bad({ selected_companion_blocks: [AI.core, 'AI-AND-LLM.md#Tool calls'] }, /selected_companion_blocks\[1\]: unknown block AI-AND-LLM\.md#Tool calls/)
  bad({ selected_companion_blocks: [ordinary()[1]] }, /selected_companion_blocks\[0\] ATTACK-CLASSES\.md#Access control resolves but is not a companion block/)
  bad({ selected_companion_blocks: [AI.whenToUse] }, /resolves but is not a companion block/)   // recon reads it to choose a file; a unit never selects it
  // the excluded blocks
  bad({ excluded_blocks: [{ block: 'AI-AND-LLM.md#Nope', reason: 'r' }] }, /excluded_blocks\[0\]\.block: unknown block AI-AND-LLM\.md#Nope/)
  bad({ excluded_blocks: [{ block: 'RECONNAISSANCE.md#Phase 1: Map the source and plan coverage', reason: 'r' }] }, /excluded_blocks\[0\]\.block RECONNAISSANCE\.md#Phase 1: Map the source and plan coverage resolves but is not an attack-class block/)
})
await test('a block field of the wrong type is refused, never coerced: null or a number in a list, an object, a string where a list belongs', () => {
  const { runDir } = newRun()
  const bad = (over, pattern) => seedRefused(runDir, reconInput([unitInput('a', over)]), pattern)
  bad({ ordinary_attack_class_block: 7 }, /ordinary_attack_class_block/)
  bad({ ordinary_attack_class_block: { ref: 'ATTACK-CLASSES.md#Access control' } }, /ordinary_attack_class_block/)
  bad({ ordinary_attack_class_block: ['ATTACK-CLASSES.md#Access control'] }, /ordinary_attack_class_block/)
  bad({ selected_companion_blocks: [null] }, /selected_companion_blocks\[0\]/)
  bad({ selected_companion_blocks: [7] }, /selected_companion_blocks\[0\]/)
  bad({ selected_companion_blocks: [{ block: AI.core }] }, /selected_companion_blocks\[0\]/)
  bad({ selected_companion_blocks: AI.core }, /selected_companion_blocks/)
  bad({ excluded_blocks: [{ block: null, reason: 'r' }] }, /excluded_blocks\[0\]/)
  bad({ excluded_blocks: [AI.core] }, /excluded_blocks\[0\]/)
  bad({ excluded_blocks: 'AI-AND-LLM.md#Core discipline' }, /excluded_blocks/)
})
await test('every problem of every unit is reported in one refusal, and nothing is written', () => {
  const { runDir } = newRun()
  assert.throws(() => seed(runDir, reconInput([unitInput('a', { ordinary_attack_class_block: 'ATTACK-CLASSES.md#Nope' }), unitInput('b', { selected_companion_blocks: ['X.md#y'] })])), e => e.problems.length === 2 && /unit 0 /.test(e.problems[0]) && /unit 1 /.test(e.problems[1]))
  assert.ok(!existsSync(LEDGER_PATH(runDir)))
})

console.log('== seed: scope, and every upstream state kept distinct')
await test('a scoped run seeds in-scope units planned and the rest out_of_scope with a reason; deferred and not_applicable stay what they are', () => {
  const files = { 'src/app.js': 'a\n', 'src/db.js': 'b\n', 'docs/guide.md': 'c\n', 'README.md': 'd\n' }
  const { runDir } = newRun({ files, args: ['--scope', 'src'] })
  seed(runDir, reconInput([
    unitInput('in', { starting_paths: ['src/app.js'] }),
    unitInput('mixed', { starting_paths: ['docs/guide.md', 'src/db.js'] }),
    unitInput('out', { starting_paths: ['docs/guide.md'] }),
    unitInput('outReason', { starting_paths: ['README.md'], reason: 'the README is outside --scope src' }),
    unitInput('parent', { starting_paths: ['src'] }),
    unitInput('def', { status: 'deferred', reason: 'budget_cannot_reserve_critics_and_validation' }),
    unitInput('na', { status: 'not_applicable', reason: 'the app has no uploads' }),
  ]))
  const byName = Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u]))
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([k, u]) => [k, u.status])), { in: 'planned', mixed: 'planned', out: 'out_of_scope', outReason: 'out_of_scope', parent: 'planned', def: 'deferred', na: 'not_applicable' })
  assert.deepEqual(byName.out.unresolved, ['outside this run\'s scope_paths'])
  assert.deepEqual(byName.outReason.unresolved, ['the README is outside --scope src'])
  assert.deepEqual(byName.def.unresolved, ['budget_cannot_reserve_critics_and_validation'])
  assert.deepEqual(byName.na.unresolved, ['the app has no uploads'])
  for (const u of Object.values(byName)) assert.deepEqual([u.agent_id, u.reviewed_paths, u.local_checks, u.result_fingerprints], [null, [], [], []])
  assert.ok(ledgerValid(runDir))
})
await test('an unscoped run keeps every planned unit planned, whatever its paths', () => {
  const { runDir } = seeded([unitInput('a', { starting_paths: ['README.md'] }), unitInput('b', { starting_paths: ['src/db.js'] })])
  assert.deepEqual(readLedger(runDir).map(u => u.status), ['planned', 'planned'])
})

console.log('== the write path: a ledger upstream would reject is refused and the file is untouched')
await test('commitLedger refuses each way a ledger can be invalid, leaving the bytes and the directory exactly as they were', () => {
  const { runDir } = seeded([unitInput('a'), unitInput('b')])
  const before = ledgerBytes(runDir), files = readdirSync(runDir).sort()
  const [a, b] = readLedger(runDir)
  const tampered = {
    'a wrong coverage_id': [{ ...a, coverage_id: 'x::y::z::w' }, b],
    'a duplicate unit': [a, a],
    'a covered unit with no checks': [{ ...a, status: 'covered', agent_id: 'h1-01' }, b],
    'an in_progress unit with no owner': [{ ...a, status: 'in_progress' }, b],
    'a planned unit with an owner': [{ ...a, agent_id: 'h1-01' }, b],
    'a deferred unit with no reason': [{ ...a, status: 'deferred' }, b],
    'a candidate with no fingerprint': [{ ...a, status: 'candidate', agent_id: 'h1-01', reviewed_paths: ['src/app.js'], local_checks: [{ agent_id: 'h1-01', reviewed_paths: ['src/app.js'], invariant: 'i', method: 'source', result: 'r', artifact: null }] }, b],
    'a status upstream does not have': [{ ...a, status: 'untested' }, b],
    'a prior_status upstream does not have': [{ ...a, prior_status: 'prior_covered' }, b],
    'a local check with no promoted artifact': [{ ...a, status: 'covered', agent_id: 'h1-01', reviewed_paths: ['src/app.js'], local_checks: [{ agent_id: 'h1-01', reviewed_paths: ['src/app.js'], invariant: 'i', method: 'local', result: 'r', artifact: null }] }, b],
    'not an array of units': { 0: a },
  }
  for (const [what, ledger] of Object.entries(tampered)) {
    assert.throws(() => commitLedger(runDir, ledger), e => /unchanged/.test(e.message) && Array.isArray(e.problems), what)
    assert.equal(ledgerBytes(runDir), before, what)
    assert.deepEqual(readdirSync(runDir).sort(), files, `${what}: no stray file`)
  }
})
await test('the validator CLI is the gate, not only the in-memory check: a ledger over its 5 MiB read limit is refused though every unit is valid', () => {
  const { runDir } = seeded([unitInput('a')])
  const before = ledgerBytes(runDir)
  const [a] = readLedger(runDir)
  const fat = { ...a, note: 'x'.repeat(6 * 1024 * 1024) }   // an extra field is allowed; the file is not
  assert.throws(() => commitLedger(runDir, [fat]), /said "Failed to read coverage ledger: input exceeds 5242880 byte limit" \(exit 1\); coverage-ledger\.json is unchanged/)
  assert.equal(ledgerBytes(runDir), before)
  assert.deepEqual(readdirSync(runDir).filter(f => f.endsWith('.candidate') || f.includes('.tmp')), [])
})
await test('beforePublish runs only after the ledger passed, so a refusal writes no side file; a pass writes the ledger last', () => {
  const { runDir } = seeded([unitInput('a')])
  const [a] = readLedger(runDir)
  let ran = 0
  assert.throws(() => commitLedger(runDir, [{ ...a, status: 'untested' }], () => { ran += 1 }))
  assert.equal(ran, 0)
  commitLedger(runDir, [{ ...a, wave: 2, note: 'kept' }], () => { ran += 1; assert.equal(readLedger(runDir)[0].wave, 1, 'the old ledger is still in place while side files are written') })
  assert.equal(ran, 1)
  assert.equal(readLedger(runDir)[0].wave, 2)
  assert.equal(validateLedgerFile(LEDGER_PATH(runDir)).valid, true)
})
await test('a side-file failure in beforePublish leaves the old ledger in place', () => {
  const { runDir } = seeded([unitInput('a')])
  const before = ledgerBytes(runDir), [a] = readLedger(runDir)
  assert.throws(() => commitLedger(runDir, [{ ...a, wave: 9 }], () => { throw new Error('disk full') }), /disk full/)
  assert.equal(ledgerBytes(runDir), before)
  assert.deepEqual(readdirSync(runDir).filter(f => f.endsWith('.candidate')), [])
})
