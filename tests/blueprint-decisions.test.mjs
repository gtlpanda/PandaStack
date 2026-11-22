// CP-04b implementation edges the frozen acceptance does not pin: errors that carry
// nothing but the code, message and a fixed file or checked ids; explicit undefined
// options taking their defaults and a null-prototype options object; sparse input
// arrays refused before any read; an override of a non-text assumption; an exact option
// label holding a secret still redacted on disk; G0 and G01 as unknown gate ids; a gate
// whose about names a D id in the assumptions; the next D<n> skipping a taken id; and a
// design gate, a backlog gate and a third gate in sequence. Fake credentials are
// assembled at run time.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../graphs/blueprint/skills/blueprint/blueprint-decisions.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'blueprint-decisions-')))
let caseNo = 0
function makeDir() {
  const base = join(WORK, `case-${++caseNo}`)
  const dir = join(base, 'harness-blueprint')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { base, dir }
}
const sha = text => createHash('sha256').update(text).digest('hex')
const put = (dir, file, value) => writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const readBack = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
const listing = dir => readdirSync(dir).sort()
const GH = 'gh' + 'p_' + Array.from({ length: 36 }, (_, i) => 'aZ0bY1cX2dW3eV4f'[(i * 5 + 3) % 16]).join('')

const BRIEF = { mode: 'feature', requirements: [{ id: 'R1', text: 'x' }] }
const RUN1 = (over = {}) => ({
  status: 'needs-human',
  brief: BRIEF,
  questions: [{ id: 'Q1', question: 'Which token store?', options: [{ label: 'Vault' }, { label: `Inline ${GH}` }], resolves: [] }],
  preflight: [{ what: 'Vault token', why: 'secrets', needed_by: 'S1' }],
  assumptions: [{ id: 'A1', assumption: { not: 'text' } }, { id: 'A2', assumption: 'Single region' }],
  ...over,
})
function interviewDir(run1 = RUN1()) {
  const c = makeDir()
  put(c.dir, 'request.json', { request: 'Add secrets', docs: [] })
  put(c.dir, 'run1.json', run1)
  return c
}
const STATE = (over = {}) => ({
  request: 'Add secrets', docs: [], brief: BRIEF,
  decisions: [{ id: 'Q1', question: 'Which token store?', answer: 'Vault', resolves: [], note: null }],
  assumptions: [{ id: 'A2', assumption: 'Single region' }],
  preflight: [], gateRounds: 0,
  ...over,
})
// The state plus its runs, with a meta.json basis matching their bytes as writeRun records it.
function stagedDir(state, run2, run3) {
  const c = makeDir()
  const stateText = JSON.stringify(state, null, 2)
  put(c.dir, 'state.json', stateText)
  const basis = {}
  const run2Text = JSON.stringify(run2, null, 2)
  put(c.dir, 'run2.json', run2Text)
  basis['run2.json'] = { 'state.json': sha(stateText) }
  if (run3) {
    put(c.dir, 'run3.json', run3)
    basis['run3.json'] = { 'state.json': sha(stateText), 'run2.json': sha(run2Text) }
  }
  put(c.dir, 'meta.json', { version: 1, basis })
  return c
}
const RUN2_READY = { status: 'design-ready', design: {} }
const gate = questions => ({ status: 'needs-human', questions })

function throwsCode(fn, code, base) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.equal(caught.code, code)
  assert.equal(caught.message, `Blueprint decisions: ${code}.`)
  assert.deepEqual(Object.keys(caught).filter(k => !['code', 'file', 'ids'].includes(k)), [], 'no other own fields')
  assert.equal(caught.cause, undefined)
  if (base) assert.ok(!String(caught.stack).includes(base), 'no case path in the stack')
  return caught
}

try {
  await test('blueprint-decisions: refusals carry only code, message and a fixed file or checked ids', async () => {
    const { applyInterviewAnswers, applyGateAnswers } = await api()
    const c = interviewDir()
    const missing = throwsCode(() => applyInterviewAnswers(c.dir, { answers: [] }), 'MISSING_ANSWER', c.base)
    assert.deepEqual(missing.ids, ['Q1'])
    assert.equal(missing.file, undefined)
    mkdirSync(join(c.dir, 'meta.json'))
    const io = throwsCode(() => applyInterviewAnswers(c.dir, { answers: [{ id: 'Q1', answer: 'Vault' }] }), 'IO_ERROR', c.base)
    assert.equal(io.file, 'meta.json')
    assert.equal(io.ids, undefined)
    const s = stagedDir(STATE({ gateRounds: 2 }), gate([{ about: null, question: 'q' }]))
    const exhausted = throwsCode(() => applyGateAnswers(s.dir, { answers: [{ id: 'G1', answer: 'a' }] }), 'GATE_ROUNDS_EXHAUSTED', s.base)
    assert.equal(exhausted.file, undefined)
  })

  await test('blueprint-decisions: undefined have and overrides take their defaults; a null-prototype options object is plain', async () => {
    const { applyInterviewAnswers } = await api()
    const plain = interviewDir()
    const expected = applyInterviewAnswers(plain.dir, { answers: [{ id: 'Q1', answer: 'Vault' }] })
    const explicit = interviewDir()
    assert.deepEqual(applyInterviewAnswers(explicit.dir, { answers: [{ id: 'Q1', answer: 'Vault' }], have: undefined, overrides: undefined }), expected)
    const nullProto = interviewDir()
    const opts = Object.assign(Object.create(null), { answers: [{ id: 'Q1', answer: 'Vault' }] })
    assert.deepEqual(applyInterviewAnswers(nullProto.dir, opts), expected)
    const noAnswers = interviewDir()
    throwsCode(() => applyInterviewAnswers(noAnswers.dir, { answers: undefined }), 'INVALID_INPUT')
  })

  await test('blueprint-decisions: a sparse answers, overrides or have array is INVALID_INPUT before any read', async () => {
    const { applyInterviewAnswers, applyGateAnswers } = await api()
    const answer = { id: 'Q1', answer: 'Vault' }
    const sparse = (...items) => [, ...items]
    const c = interviewDir()
    const before = listing(c.dir)
    for (const opts of [{ answers: sparse(answer) }, { answers: [answer], overrides: sparse() }, { answers: [answer], have: sparse('Vault token') }]) {
      throwsCode(() => applyInterviewAnswers(c.dir, opts), 'INVALID_INPUT', c.base)
    }
    assert.deepEqual(listing(c.dir), before)
    const s = stagedDir(STATE(), gate([{ about: null, question: 'q' }]))
    throwsCode(() => applyGateAnswers(s.dir, { answers: sparse({ id: 'G1', answer: 'a' }) }), 'INVALID_INPUT', s.base)
    // Before any read: a directory CP-04a would refuse still gets this module's refusal.
    throwsCode(() => applyInterviewAnswers(join(WORK, 'missing', 'harness-blueprint'), { answers: sparse(answer) }), 'INVALID_INPUT')
  })

  await test('blueprint-decisions: an override of a non-text assumption has question ""; an exact label is redacted on disk', async () => {
    const { applyInterviewAnswers } = await api()
    const c = interviewDir()
    const state = applyInterviewAnswers(c.dir, {
      answers: [{ id: 'Q1', answer: `Inline ${GH}` }], have: ['Vault token'], overrides: [{ id: 'A1', answer: 'Text after all' }],
    })
    assert.deepEqual(state.decisions, [
      { id: 'Q1', question: 'Which token store?', answer: 'Inline <redacted: GitHub token>', resolves: [], note: null },
      { id: 'A1', question: '', answer: 'Text after all', resolves: [], note: 'override' },
    ])
    assert.deepEqual(state.assumptions, [{ id: 'A2', assumption: 'Single region' }])
    assert.deepEqual(state.preflight, [{ what: 'Vault token', why: 'secrets', needed_by: 'S1', have: true }])
    assert.ok(!readFileSync(join(c.dir, 'state.json'), 'utf8').includes(GH))
    assert.equal(state.brief.mode, 'feature')
  })

  await test('blueprint-decisions: G0 and G01 are unknown gate ids; duplicates win over unknown ids', async () => {
    const { applyGateAnswers } = await api()
    const c = stagedDir(STATE(), gate([{ about: 'Q1', question: 'Still Vault?' }]))
    const before = listing(c.dir)
    assert.deepEqual(throwsCode(() => applyGateAnswers(c.dir, { answers: [{ id: 'G1', answer: 'a' }, { id: 'G01', answer: 'b' }, { id: 'G0', answer: 'c' }] }),
      'UNKNOWN_ID').ids, ['G01', 'G0'])
    assert.deepEqual(throwsCode(() => applyGateAnswers(c.dir, { answers: [{ id: 'G9', answer: 'a' }, { id: 'G1', answer: 'b' }, { id: 'G1', answer: 'c' }] }),
      'DUPLICATE_ID').ids, ['G1'])
    assert.deepEqual(listing(c.dir), before)
    assert.equal(readBack(c.dir, 'state.json').gateRounds, 0)
  })

  await test('blueprint-decisions: a challenged D-id assumption becomes a decision and the next D<n> still counts it', async () => {
    const { applyGateAnswers } = await api()
    const c = stagedDir(STATE({ assumptions: [{ id: 'D4', assumption: 'Legacy id' }, { id: 'A2', assumption: 'Single region' }] }),
      gate([{ about: 'D4', question: 'Keep the legacy id?' }, { about: null, question: 'Rotate keys?' }]))
    const state = applyGateAnswers(c.dir, { answers: [{ id: 'G1', answer: 'yes' }, { id: 'G2', answer: 'monthly' }] })
    assert.deepEqual(state.decisions.slice(1), [
      { id: 'D4', question: 'Keep the legacy id?', answer: 'yes', resolves: [], note: 'design gate' },
      { id: 'D5', question: 'Rotate keys?', answer: 'monthly', resolves: [], note: 'design gate' },
    ])
    assert.deepEqual(state.assumptions.map(a => a.id), ['A2'])
  })

  await test('blueprint-decisions: the next D<n> skips an id already taken past the nine-digit D shape', async () => {
    const { applyApprovalEdit } = await api()
    const decision = id => ({ id, question: 'q', answer: 'a', resolves: [], note: null })
    const c = stagedDir(STATE({ decisions: [decision('D999999999'), decision('D1000000000')] }), RUN2_READY,
      { status: 'backlog-ready', backlog: {} })
    assert.equal(applyApprovalEdit(c.dir, { edit: 'one more' }).decisions.at(-1).id, 'D1000000001')
  })

  await test('blueprint-decisions: design gate, backlog gate, then a third gate is GATE_ROUNDS_EXHAUSTED', async () => {
    const { applyGateAnswers, applyApprovalEdit } = await api()
    const first = stagedDir(STATE(), gate([{ about: 'A2', question: 'Multi-region?' }]))
    const afterDesign = applyGateAnswers(first.dir, { answers: [{ id: 'G1', answer: 'two regions' }] })
    assert.equal(afterDesign.gateRounds, 1)
    const second = stagedDir(afterDesign, RUN2_READY, gate([{ about: 'A2', question: 'Which two?' }]))
    const afterBacklog = applyGateAnswers(second.dir, { answers: [{ id: 'G1', answer: 'us and eu' }] })
    assert.equal(afterBacklog.gateRounds, 2)
    assert.deepEqual(afterBacklog.decisions.find(d => d.id === 'A2'),
      { id: 'A2', question: 'Multi-region?', answer: 'us and eu', resolves: [], note: 'design gate' })
    const third = stagedDir(afterBacklog, gate([{ about: null, question: 'More?' }]))
    throwsCode(() => applyGateAnswers(third.dir, { answers: [{ id: 'G1', answer: 'x' }] }), 'GATE_ROUNDS_EXHAUSTED')
    const approval = stagedDir(afterBacklog, RUN2_READY, { status: 'backlog-ready', backlog: {} })
    const edited = applyApprovalEdit(approval.dir, { edit: 'Add a key-rotation slice' })
    assert.equal(edited.gateRounds, 2, 'an approval edit is not a gate round')
    assert.deepEqual(edited.decisions.at(-1), { id: 'D1', question: 'approval edit', answer: 'Add a key-rotation slice', resolves: [], note: 'approval edit' })
    assert.deepEqual(listing(approval.dir), ['state.json'])
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
