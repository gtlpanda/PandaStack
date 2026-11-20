// CP-04b frozen acceptance: the /blueprint decision rules
// (spec/contracts/codex-parity-cp-04b.md). No graph runs, no git, no network,
// no HOME dependence. Fixtures are written with plain fs (never through
// blueprint-state.mjs) and read back with plain fs. Fake credentials are built
// at run time so this file never holds one.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..'))
const MODULE = 'graphs/blueprint/skills/blueprint/blueprint-decisions.mjs'
const load = () => import(pathToFileURL(resolve(ROOT, MODULE)).href)
const SKILL = () => readFileSync(resolve(ROOT, 'graphs/blueprint/skills/blueprint/SKILL.md'), 'utf8')

const CODES = ['INVALID_INPUT', 'STATE_EXISTS', 'MALFORMED', 'NOT_NEEDS_HUMAN', 'NOT_BACKLOG_READY', 'STALE_RUN',
  'DUPLICATE_ID', 'UNKNOWN_ID', 'MISSING_ANSWER', 'BAD_PREFLIGHT', 'GATE_ROUNDS_EXHAUSTED', 'IO_ERROR']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// ---------- fake credentials and a marker that must never be echoed ----------
const rand = (alphabet, n, seed) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + seed * 13 + 3) % alphabet.length]).join('')
const ALNUM = 'aZ0bY1cX2dW3eV4fU5gT6hS7iR8jQ9kP'
const GH = 'gh' + 'p_' + rand(ALNUM, 36, 5)
const STRIPE = ['sk', 'live', rand(ALNUM, 24, 1)].join('_')
const MARKER = 'ECHO' + 'MARKER' + '7731'

// The error is the expected one, and nothing the caller wrote is in it.
function throwsCode(fn, code, { file, ids, own = true } = {}) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}, nothing was thrown`)
  assert.equal(caught.code, code)
  assert.equal(caught.message, own ? `Blueprint decisions: ${code}.` : `Blueprint state: ${code}.`)
  if (file !== undefined) assert.equal(caught.file, file)
  if (ids !== undefined) assert.deepEqual(caught.ids, ids)
  else assert.equal(caught.ids, undefined)
  const shown = JSON.stringify({ message: caught.message, file: caught.file, ids: caught.ids, code: caught.code })
  for (const secret of [MARKER, GH, STRIPE]) assert.ok(!shown.includes(secret), 'no input echoed')
  return caught
}

let WORK
before(() => { WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-04b-'))) })
after(() => rmSync(WORK, { recursive: true, force: true }))

let caseNo = 0
function makeDir() {
  const dir = join(WORK, `case-${++caseNo}`, 'harness-blueprint')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
const put = (dir, file, value) => writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const readBack = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
const listDir = dir => (existsSync(dir) ? readdirSync(dir).sort() : [])
const snapshot = dir => Object.fromEntries(listDir(dir).map(f => [f, readFileSync(join(dir, f), 'utf8')]))
const mode = path => statSync(path).mode & 0o777

// ---------- fixtures ----------
const REQUEST = { request: 'A reading list app', docs: [] }
const BRIEF = {
  goal: 'track books',
  mode: 'app',
  requirements: [{ id: 'R1', text: 'add a book', source: 'request' }, { id: 'R2', text: 'list books', source: 'request' }],
  contradictions: [{ id: 'C1', a: 'email', b: 'magic link', sources: ['doc'] }],
}
const QUESTION = (id, question, labels, resolves = []) => ({
  id, question, stakes: `stakes of ${id}`,
  options: labels.map(label => ({ label, description: `about ${label}` })),
  recommended: labels[0], default_if_unasked: labels[0], resolves,
})
const RUN1 = (over = {}) => ({
  status: 'needs-human',
  reason: '3 question(s) for the human; 1 more assumed',
  brief: BRIEF,
  questions: [
    QUESTION('Q1', 'How do people sign in?', ['Email and password', 'Magic link'], ['C1']),
    QUESTION('Q2', 'Which database?', ['SQLite', 'Postgres']),
    QUESTION('Q3', 'Where does it deploy?', ['Render', 'Fly.io']),
  ],
  preflight: [
    { what: 'SMTP key', why: 'mail', needed_by: 'S3' },
    { what: 'Stripe account', why: 'billing', needed_by: 'S5' },
  ],
  assumptions: [
    { id: 'A1', assumption: 'One user per account', why: 'stated' },
    { id: 'A2', assumption: 'English only', why: 'no i18n asked' },
    { id: 'Q13', from: 'Q13', assumption: 'No offline mode', why: 'not asked (ranked below the 12-question cap): Offline?' },
  ],
  history: [],
  ...over,
})
function interviewDir(run1 = RUN1(), request = REQUEST) {
  const dir = makeDir()
  put(dir, 'request.json', request)
  put(dir, 'run1.json', run1)
  return dir
}
const ALL_ANSWERS = [{ id: 'Q1', answer: 'Email and password' }, { id: 'Q2', answer: 'SQLite' }, { id: 'Q3', answer: 'Render' }]

const DECISION = (id, answer, extra = {}) => ({ id, question: `question for ${id}`, answer, resolves: [], note: null, ...extra })
const STATE = (over = {}) => ({
  request: 'A reading list app',
  docs: [],
  brief: BRIEF,
  decisions: [DECISION('Q1', 'Email and password', { resolves: ['C1'] }), DECISION('D1', 'Keep it small', { note: 'design gate' }),
    DECISION('D3', 'Add tags', { note: 'approval edit', question: 'approval edit' })],
  assumptions: [{ id: 'A1', assumption: 'One user per account', why: 'stated' }, { id: 'Q13', from: 'Q13', assumption: 'No offline mode', why: 'w' }],
  preflight: [{ what: 'SMTP key', why: 'mail', needed_by: 'S3', have: false }],
  gateRounds: 0,
  ...over,
})
const GATE_QUESTIONS = [
  { about: 'Q1', question: 'Email cannot meet the SSO requirement. How do people sign in?' },
  { about: 'A1', question: 'Is one user per account enough?' },
  { about: null, question: 'Do you need an audit log?' },
  { about: null, question: 'Do you need an export?' },
]
const RUN2_NH = (questions = GATE_QUESTIONS) => ({ status: 'needs-human', reason: 'the advisor needs answers', design: { summary: 's' }, questions })
const RUN2_READY = () => ({ status: 'design-ready', reason: null, design: { summary: 's', knowledge: [{ id: 'K1', kind: 'type' }] } })
const RUN3_NH = (questions = GATE_QUESTIONS) => ({ status: 'needs-human', reason: 'the advisor needs answers', questions })
const RUN3_READY = () => ({ status: 'backlog-ready', reason: null, backlog: { version: 1, app: 'reading-list', slices: [] } })

// state.json, run2.json and (optionally) run3.json with a meta.json basis that
// matches their bytes, the way CP-04a's writeRun records it.
function stagedDir(state, run2, run3) {
  const dir = makeDir()
  const stateText = JSON.stringify(state, null, 2)
  put(dir, 'state.json', stateText)
  const basis = {}
  if (run2) {
    const run2Text = JSON.stringify(run2, null, 2)
    put(dir, 'run2.json', run2Text)
    basis['run2.json'] = { 'state.json': sha(stateText) }
    if (run3) {
      put(dir, 'run3.json', run3)
      basis['run3.json'] = { 'state.json': sha(stateText), 'run2.json': sha(run2Text) }
    }
  }
  put(dir, 'meta.json', { version: 1, basis })
  return dir
}
const gateAnswers = n => Array.from({ length: n }, (_, i) => ({ id: `G${i + 1}`, answer: `answer ${i + 1}` }))

// The stored state: returned value equals the file, the file is 0600, and no id
// is both a decision and an assumption.
function storedState(dir, returned) {
  const onDisk = readBack(dir, 'state.json')
  assert.deepEqual(returned, onDisk)
  assert.equal(mode(join(dir, 'state.json')), 0o600)
  const ids = [...onDisk.decisions.map(d => d.id), ...onDisk.assumptions.map(a => a.id)]
  assert.equal(new Set(ids).size, ids.length, 'no id is both a decision and an assumption')
  return onDisk
}
// SKILL.md's quoted values, read from SKILL.md so a drift there is caught.
function skillQuoted(pattern) {
  const m = SKILL().match(pattern)
  assert.ok(m, `SKILL.md still says ${pattern}`)
  return m[1]
}

// =====================================================================
describe('exports', () => {
  test('names and codes are pinned', async () => {
    const m = await load()
    assert.ok(Object.isFrozen(m.BLUEPRINT_DECISION_CODES))
    assert.deepEqual(Object.keys(m.BLUEPRINT_DECISION_CODES).sort(), [...CODES].sort())
    for (const code of CODES) assert.equal(m.BLUEPRINT_DECISION_CODES[code], code)
    for (const name of ['applyInterviewAnswers', 'applyGateAnswers', 'applyApprovalEdit']) assert.equal(typeof m[name], 'function', name)
  })

  test('it imports only node built-ins and blueprint-state.mjs, writes only through writeState, and the catalog stays clean', async () => {
    await load()
    const source = readFileSync(resolve(ROOT, MODULE), 'utf8')
    const imports = [...source.matchAll(/^[ \t]*(?:import|export)\b([^;'"`]*?)\bfrom[ \t]*(['"])([^'"\n]+)\2|^[ \t]*import[ \t]*(['"])([^'"\n]+)\4/gm)]
    const specifiers = imports.map(m => m[3] ?? m[5])
    assert.ok(specifiers.includes('./blueprint-state.mjs'))
    assert.deepEqual(specifiers.filter(s => !s.startsWith('node:') && s !== './blueprint-state.mjs'), [])
    assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic import')
    const fromState = imports.filter(m => m[3] === './blueprint-state.mjs').map(m => m[1]).join(' ')
    assert.match(fromState, /\bwriteState\b/)
    assert.ok(!/\b(writeFileSync|writeSync|appendFileSync|renameSync|copyFileSync|createWriteStream|writeFile|rename|openSync)\s*\(/.test(source),
      'no file is written except through writeState')
    const { checkCatalogDrift } = await import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')).href)
    const { problems } = checkCatalogDrift({ installationRoot: ROOT })
    assert.deepEqual(problems.filter(p => p.ref === 'blueprint' || p.dependency === 'blueprint'), [])
  })
})

// =====================================================================
describe('applyInterviewAnswers', () => {
  test('writes the SKILL.md 3.5 state: labels kept, free text redacted, preflight by name, overrides become decisions', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    for (const f of ['run2.json', 'run3.json', 'meta.json']) put(dir, f, '{"left":"over"}')
    const returned = applyInterviewAnswers(dir, {
      answers: [{ id: 'Q3', answer: `  Fly.io, deploy token ${GH}  ` }, { id: 'Q1', answer: 'Magic link' }, { id: 'Q2', answer: 'SQLite' }],
      have: ['Stripe account'],
      overrides: [{ id: 'Q13', answer: 'Offline first' }, { id: 'A2', answer: `English and French, key ${STRIPE}` }],
    })
    const state = storedState(dir, returned)
    assert.deepEqual(state, {
      request: 'A reading list app',
      docs: [],
      brief: BRIEF,
      decisions: [
        { id: 'Q1', question: 'How do people sign in?', answer: 'Magic link', resolves: ['C1'], note: null },
        { id: 'Q2', question: 'Which database?', answer: 'SQLite', resolves: [], note: null },
        { id: 'Q3', question: 'Where does it deploy?', answer: 'Fly.io, deploy token <redacted: GitHub token>', resolves: [], note: null },
        { id: 'A2', question: 'English only', answer: 'English and French, key <redacted: API key>', resolves: [], note: 'override' },
        { id: 'Q13', question: 'No offline mode', answer: 'Offline first', resolves: [], note: 'override' },
      ],
      assumptions: [{ id: 'A1', assumption: 'One user per account', why: 'stated' }],
      preflight: [
        { what: 'SMTP key', why: 'mail', needed_by: 'S3', have: false },
        { what: 'Stripe account', why: 'billing', needed_by: 'S5', have: true },
      ],
      gateRounds: 0,
    })
    const text = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.ok(!text.includes(GH) && !text.includes(STRIPE), 'the secrets are gone')
    assert.deepEqual(listDir(dir), ['request.json', 'run1.json', 'state.json'], 'run2, run3 and meta.json are deleted; run1 stays')
  })

  test('a "none" reply keeps every assumption and marks every preflight item owed', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir(RUN1(), { request: null, docs: ['/abs/design.md'] })
    const state = storedState(dir, applyInterviewAnswers(dir, { answers: ALL_ANSWERS }))
    assert.equal(state.request, null)
    assert.deepEqual(state.docs, ['/abs/design.md'])
    assert.deepEqual(state.assumptions, RUN1().assumptions)
    assert.deepEqual(state.preflight.map(p => p.have), [false, false])
    assert.deepEqual(state.decisions.map(d => [d.id, d.answer, d.note]), [['Q1', 'Email and password', null], ['Q2', 'SQLite', null], ['Q3', 'Render', null]])
    const explicit = interviewDir()
    assert.deepEqual(applyInterviewAnswers(explicit, { answers: ALL_ANSWERS, have: [], overrides: [] }),
      { ...state, request: 'A reading list app', docs: [] }, 'empty have and overrides equal leaving them out')
  })

  test('a near-label answer is free text: trimmed, kept as written, " (Recommended)" not stripped', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const state = storedState(dir, applyInterviewAnswers(dir, {
      answers: [{ id: 'Q1', answer: 'Email and password (Recommended)' }, { id: 'Q2', answer: '  sqlite  ' }, { id: 'Q3', answer: 'Render' }],
    }))
    assert.deepEqual(state.decisions.map(d => d.answer), ['Email and password (Recommended)', 'sqlite', 'Render'])
  })

  test('a preflight name shared by two items marks both', async () => {
    const { applyInterviewAnswers } = await load()
    const run1 = RUN1({ preflight: [{ what: 'API key', why: 'a', needed_by: 'S1' }, { what: 'Other', why: 'b', needed_by: 'S2' }, { what: 'API key', why: 'c', needed_by: 'S3' }] })
    const dir = interviewDir(run1)
    const state = storedState(dir, applyInterviewAnswers(dir, { answers: ALL_ANSWERS, have: ['API key'] }))
    assert.deepEqual(state.preflight.map(p => p.have), [true, false, true])
  })

  test('duplicate ids are refused, naming every duplicated id once, and nothing is written', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const before = snapshot(dir)
    throwsCode(() => applyInterviewAnswers(dir, {
      answers: [...ALL_ANSWERS, { id: 'Q2', answer: MARKER }, { id: 'Q1', answer: GH }, { id: 'Q2', answer: 'again' }],
      overrides: [{ id: 'A1', answer: 'x' }, { id: 'A1', answer: MARKER }],
    }), 'DUPLICATE_ID', { ids: ['Q2', 'Q1', 'A1'] })
    assert.deepEqual(snapshot(dir), before)
  })

  test('unknown ids are refused, naming them in input order; a past-the-cap id is an override, not an answer', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const before = snapshot(dir)
    throwsCode(() => applyInterviewAnswers(dir, {
      answers: [...ALL_ANSWERS, { id: 'Q13', answer: MARKER }, { id: 'Q9', answer: GH }],
      overrides: [{ id: 'Q2', answer: MARKER }, { id: 'A1', answer: 'fine' }, { id: 'Q9', answer: 'again, once named' }],
    }), 'UNKNOWN_ID', { ids: ['Q13', 'Q9', 'Q2'] })
    assert.deepEqual(snapshot(dir), before)
  })

  test('missing answers are refused, naming the unanswered question ids in question order', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const before = snapshot(dir)
    throwsCode(() => applyInterviewAnswers(dir, { answers: [{ id: 'Q2', answer: MARKER }] }), 'MISSING_ANSWER', { ids: ['Q1', 'Q3'] })
    throwsCode(() => applyInterviewAnswers(dir, { answers: [] }), 'MISSING_ANSWER', { ids: ['Q1', 'Q2', 'Q3'] })
    assert.deepEqual(snapshot(dir), before)
  })

  test('precedence: duplicate, then unknown, then missing', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    throwsCode(() => applyInterviewAnswers(dir, { answers: [{ id: 'Q1', answer: 'a' }, { id: 'Q1', answer: 'b' }, { id: 'Q7', answer: 'c' }] }),
      'DUPLICATE_ID', { ids: ['Q1'] })
    throwsCode(() => applyInterviewAnswers(dir, { answers: [{ id: 'Q1', answer: 'a' }, { id: 'Q7', answer: 'c' }] }), 'UNKNOWN_ID', { ids: ['Q7'] })
  })

  test('an unknown or repeated preflight name is refused without echoing it', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const before = snapshot(dir)
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS, have: [`${MARKER} ${GH}`] }), 'BAD_PREFLIGHT')
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS, have: ['smtp key'] }), 'BAD_PREFLIGHT')
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS, have: ['SMTP key', 'SMTP key'] }), 'BAD_PREFLIGHT')
    assert.deepEqual(snapshot(dir), before)
  })

  test('malformed caller input is INVALID_INPUT with nothing echoed or written', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    const before = snapshot(dir)
    const bad = [
      undefined, null, [], 'answers', { }, { answers: ALL_ANSWERS, extra: 1 }, { answers: {} },
      { answers: [...ALL_ANSWERS, null] }, { answers: [{ id: 'Q1', answer: 'a', why: MARKER }] }, { answers: [{ id: 'Q1' }] },
      { answers: [{ id: 'q1', answer: 'a' }] }, { answers: [{ id: `Q1${MARKER}`, answer: 'a' }] }, { answers: [{ id: GH, answer: 'a' }] },
      { answers: [{ id: 'Q', answer: 'a' }] }, { answers: [{ id: ' Q1', answer: 'a' }] }, { answers: [{ id: 1, answer: 'a' }] },
      { answers: [{ id: 'Q1', answer: '   ' }] }, { answers: [{ id: 'Q1', answer: 7 }] }, { answers: [{ id: 'Q1', answer: null }] },
      { answers: ALL_ANSWERS, have: 'SMTP key' }, { answers: ALL_ANSWERS, have: [1] }, { answers: ALL_ANSWERS, have: [null] },
      { answers: ALL_ANSWERS, overrides: {} }, { answers: ALL_ANSWERS, overrides: [{ id: 'A1', answer: '' }] },
      { answers: ALL_ANSWERS, overrides: [{ id: `A1 ${MARKER}`, answer: 'x' }] },
    ]
    for (const opts of bad) throwsCode(() => applyInterviewAnswers(dir, opts), 'INVALID_INPUT')
    assert.deepEqual(snapshot(dir), before)
  })

  test('an existing state.json (or a symlink by that name) is STATE_EXISTS', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    put(dir, 'state.json', JSON.stringify(STATE()))
    const before = snapshot(dir)
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS }), 'STATE_EXISTS', { file: 'state.json' })
    assert.deepEqual(snapshot(dir), before)
    const linked = interviewDir()
    symlinkSync(join(WORK, 'nowhere.json'), join(linked, 'state.json'))
    throwsCode(() => applyInterviewAnswers(linked, { answers: ALL_ANSWERS }), 'STATE_EXISTS', { file: 'state.json' })
  })

  test('a run1 that is not needs-human is NOT_NEEDS_HUMAN', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir({ status: 'escalate', reason: 'fix the documents' })
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS }), 'NOT_NEEDS_HUMAN', { file: 'run1.json' })
    assert.deepEqual(listDir(dir), ['request.json', 'run1.json'])
  })

  test('a run1 without a usable interview is MALFORMED (run1.json), with nothing written', async () => {
    const { applyInterviewAnswers } = await load()
    const q = RUN1().questions
    const bad = [
      RUN1({ questions: [] }), RUN1({ questions: undefined }), RUN1({ questions: [...q, null] }),
      RUN1({ questions: [{ ...q[0], resolves: undefined }, q[1], q[2]] }), RUN1({ questions: [{ ...q[0], resolves: [1] }, q[1], q[2]] }),
      RUN1({ questions: [{ ...q[0], id: 'question one' }, q[1], q[2]] }), RUN1({ questions: [q[0], q[0], q[2]] }),
      RUN1({ questions: [{ ...q[0], options: 'Email' }, q[1], q[2]] }), RUN1({ questions: [{ ...q[0], question: 5 }, q[1], q[2]] }),
      RUN1({ preflight: [{ what: 'x', needed_by: 'S1' }] }), RUN1({ preflight: undefined }),
      RUN1({ assumptions: [{ id: 'Q2', assumption: 'collides with a question' }] }), RUN1({ assumptions: [{ assumption: 'no id' }] }),
      RUN1({ assumptions: [{ id: 'A1' }, { id: 'A1' }] }),
      RUN1({ brief: { mode: 'app', requirements: [] } }), RUN1({ brief: { mode: 'web', requirements: [{ id: 'R1' }] } }), RUN1({ brief: undefined }),
    ]
    for (const run1 of bad) {
      const dir = interviewDir(run1)
      throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS }), 'MALFORMED', { file: 'run1.json' })
      assert.deepEqual(listDir(dir), ['request.json', 'run1.json'])
    }
  })

  test('CP-04a refusals pass through unchanged: a bad dir, a missing request.json or run1.json', async () => {
    const { applyInterviewAnswers } = await load()
    throwsCode(() => applyInterviewAnswers(join(WORK, 'not-the-state-dir'), { answers: ALL_ANSWERS }), 'INVALID_INPUT', { own: false })
    throwsCode(() => applyInterviewAnswers('relative/harness-blueprint', { answers: ALL_ANSWERS }), 'INVALID_INPUT', { own: false })
    const noRequest = makeDir()
    put(noRequest, 'run1.json', RUN1())
    throwsCode(() => applyInterviewAnswers(noRequest, { answers: ALL_ANSWERS }), 'MISSING', { own: false, file: 'request.json' })
    const noRun1 = makeDir()
    put(noRun1, 'request.json', REQUEST)
    throwsCode(() => applyInterviewAnswers(noRun1, { answers: ALL_ANSWERS }), 'MISSING', { own: false, file: 'run1.json' })
    const badRun1 = interviewDir()
    put(badRun1, 'run1.json', '{"status":')
    throwsCode(() => applyInterviewAnswers(badRun1, { answers: ALL_ANSWERS }), 'MALFORMED', { own: false, file: 'run1.json' })
  })

  test('state.json is written before the downstream files go: a delete failure is IO_ERROR after the write', async () => {
    const { applyInterviewAnswers } = await load()
    const dir = interviewDir()
    mkdirSync(join(dir, 'run2.json'))
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS }), 'IO_ERROR', { file: 'run2.json' })
    assert.deepEqual(readBack(dir, 'state.json').decisions.map(d => d.id), ['Q1', 'Q2', 'Q3'])
    throwsCode(() => applyInterviewAnswers(dir, { answers: ALL_ANSWERS }), 'STATE_EXISTS', { file: 'state.json' })
  })
})

// =====================================================================
describe('applyGateAnswers', () => {
  test('design gate: each answer replaces what it challenges (SKILL.md 4.2), gateRounds + 1, run2 and meta.json deleted', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE(), RUN2_NH())
    const returned = applyGateAnswers(dir, { answers: [
      { id: 'G3', answer: 'Yes, an audit log' }, { id: 'G1', answer: `  SSO through Okta, client ${GH}  ` },
      { id: 'G4', answer: 'No export' }, { id: 'G2', answer: 'No: teams of up to 5' },
    ] })
    const state = storedState(dir, returned)
    const note = skillQuoted(/`about` is a decision id: set that decision's `answer`, and\s+`note: "([^"]+)"`/)
    assert.equal(note, 'design gate')
    assert.deepEqual(state.decisions, [
      { id: 'Q1', question: 'question for Q1', answer: 'SSO through Okta, client <redacted: GitHub token>', resolves: ['C1'], note },
      DECISION('D1', 'Keep it small', { note: 'design gate' }),
      DECISION('D3', 'Add tags', { note: 'approval edit', question: 'approval edit' }),
      { id: 'A1', question: 'Is one user per account enough?', answer: 'No: teams of up to 5', resolves: [], note },
      { id: 'D4', question: 'Do you need an audit log?', answer: 'Yes, an audit log', resolves: [], note },
      { id: 'D5', question: 'Do you need an export?', answer: 'No export', resolves: [], note },
    ])
    assert.deepEqual(state.assumptions, [{ id: 'Q13', from: 'Q13', assumption: 'No offline mode', why: 'w' }])
    assert.equal(state.gateRounds, 1)
    assert.deepEqual({ ...state, decisions: null, assumptions: null, gateRounds: null }, { ...STATE(), decisions: null, assumptions: null, gateRounds: null })
    assert.deepEqual(listDir(dir), ['state.json'])
  })

  test('backlog gate: run3 needs-human is answered the same way (note "design gate"), and run2, run3 and meta.json go', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE({ gateRounds: 1 }), RUN2_READY(), RUN3_NH([{ about: 'Q13', question: 'Offline after all?' }, { about: null, question: 'CSV import?' }]))
    const state = storedState(dir, applyGateAnswers(dir, { answers: gateAnswers(2) }))
    assert.deepEqual(state.decisions.slice(3), [
      { id: 'Q13', question: 'Offline after all?', answer: 'answer 1', resolves: [], note: 'design gate' },
      { id: 'D4', question: 'CSV import?', answer: 'answer 2', resolves: [], note: 'design gate' },
    ])
    assert.deepEqual(state.assumptions.map(a => a.id), ['A1'])
    assert.equal(state.gateRounds, 2)
    assert.deepEqual(listDir(dir), ['state.json'])
  })

  test('two questions about one id apply in order: the later answer wins and the old one never stays', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE(), RUN2_NH([
      { about: 'A1', question: 'first' }, { about: 'A1', question: 'second' }, { about: 'D1', question: 'third' }, { about: 'D1', question: 'fourth' },
    ]))
    const state = storedState(dir, applyGateAnswers(dir, { answers: gateAnswers(4) }))
    assert.deepEqual(state.decisions.find(d => d.id === 'A1'), { id: 'A1', question: 'first', answer: 'answer 2', resolves: [], note: 'design gate' })
    assert.deepEqual(state.decisions.find(d => d.id === 'D1'), DECISION('D1', 'answer 4', { note: 'design gate' }))
    assert.equal(state.decisions.length, 4)
  })

  test('the next D<n> follows the highest D id in decisions and assumptions, never filling a gap', async () => {
    const { applyGateAnswers } = await load()
    const cases = [
      [STATE({ decisions: [DECISION('Q1', 'a')] }), ['D1', 'D2']],
      [STATE({ decisions: [DECISION('D2', 'a'), DECISION('D10', 'b')] }), ['D11', 'D12']],
      [STATE({ assumptions: [{ id: 'D7', assumption: 'odd but legal' }] }), ['D8', 'D9']],
    ]
    for (const [state, expected] of cases) {
      const dir = stagedDir(state, RUN2_NH([{ about: null, question: 'one' }, { about: null, question: 'two' }]))
      const out = storedState(dir, applyGateAnswers(dir, { answers: gateAnswers(2) }))
      assert.deepEqual(out.decisions.slice(-2).map(d => d.id), expected)
    }
  })

  test('a gate answered once is not applied again if its run survived the deletes', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE(), RUN2_NH())
    const kept = { run2: readFileSync(join(dir, 'run2.json')), meta: readFileSync(join(dir, 'meta.json')) }
    storedState(dir, applyGateAnswers(dir, { answers: gateAnswers(4) }))
    writeFileSync(join(dir, 'run2.json'), kept.run2)
    writeFileSync(join(dir, 'meta.json'), kept.meta)
    const before = snapshot(dir)
    throwsCode(() => applyGateAnswers(dir, { answers: gateAnswers(4) }), 'STALE_RUN', { file: 'run2.json' })
    assert.deepEqual(snapshot(dir), before)
    assert.equal(readBack(dir, 'state.json').gateRounds, 1)
  })

  test('at gateRounds 2 (both gates together) it refuses GATE_ROUNDS_EXHAUSTED and changes nothing', async () => {
    const { applyGateAnswers } = await load()
    const skill = SKILL()
    assert.match(skill, /The gates ask at most twice per request, both gates together/)
    for (const [run2, run3] of [[RUN2_NH(), undefined], [RUN2_READY(), RUN3_NH()]]) {
      const dir = stagedDir(STATE({ gateRounds: 2 }), run2, run3)
      const before = snapshot(dir)
      throwsCode(() => applyGateAnswers(dir, { answers: gateAnswers(4) }), 'GATE_ROUNDS_EXHAUSTED')
      assert.deepEqual(snapshot(dir), before)
    }
  })

  test('no pending gate: run3 that is not needs-human, run2 that is not needs-human, or no run at all', async () => {
    const { applyGateAnswers } = await load()
    const backlogReady = stagedDir(STATE(), RUN2_READY(), RUN3_READY())
    throwsCode(() => applyGateAnswers(backlogReady, { answers: gateAnswers(1) }), 'NOT_NEEDS_HUMAN', { file: 'run3.json' })
    const designReady = stagedDir(STATE(), RUN2_READY())
    throwsCode(() => applyGateAnswers(designReady, { answers: gateAnswers(1) }), 'NOT_NEEDS_HUMAN', { file: 'run2.json' })
    const escalated = stagedDir(STATE(), { status: 'escalate', reason: 'r' })
    throwsCode(() => applyGateAnswers(escalated, { answers: gateAnswers(1) }), 'NOT_NEEDS_HUMAN', { file: 'run2.json' })
    const none = stagedDir(STATE())
    throwsCode(() => applyGateAnswers(none, { answers: gateAnswers(1) }), 'MISSING', { own: false, file: 'run2.json' })
    for (const dir of [backlogReady, designReady, escalated]) assert.ok(existsSync(join(dir, 'run2.json')), 'refused calls keep the runs')
  })

  test('a gate run whose basis no longer matches is STALE_RUN, with nothing changed', async () => {
    const { applyGateAnswers } = await load()
    const edited = stagedDir(STATE(), RUN2_NH())
    put(edited, 'state.json', STATE({ preflight: [] }))
    const noMeta = stagedDir(STATE(), RUN2_NH())
    rmSync(join(noMeta, 'meta.json'))
    const run2Edited = stagedDir(STATE(), RUN2_READY(), RUN3_NH())
    put(run2Edited, 'run2.json', { ...RUN2_READY(), reason: 'edited' })
    for (const [dir, file] of [[edited, 'run2.json'], [noMeta, 'run2.json'], [run2Edited, 'run3.json']]) {
      const before = snapshot(dir)
      throwsCode(() => applyGateAnswers(dir, { answers: gateAnswers(4) }), 'STALE_RUN', { file })
      assert.deepEqual(snapshot(dir), before)
    }
  })

  test('gate questions that do not fit are MALFORMED, naming the run', async () => {
    const { applyGateAnswers } = await load()
    const bad = [
      [], undefined, [{ about: 'Q9', question: 'unknown id' }], [{ about: 'Q1', question: '  ' }], [{ about: 'Q1' }],
      [{ about: 'Q1', question: 'q', extra: 1 }], [{ about: 7, question: 'q' }], ['Q1: as a string'],
    ]
    for (const questions of bad) {
      const dir = stagedDir(STATE(), { ...RUN2_NH(), questions })
      const before = snapshot(dir)
      throwsCode(() => applyGateAnswers(dir, { answers: gateAnswers(1) }), 'MALFORMED', { file: 'run2.json' })
      assert.deepEqual(snapshot(dir), before)
    }
    const backlog = stagedDir(STATE(), RUN2_READY(), RUN3_NH([{ about: 'nope', question: 'q' }]))
    throwsCode(() => applyGateAnswers(backlog, { answers: gateAnswers(1) }), 'MALFORMED', { file: 'run3.json' })
  })

  test('gate question k is answered as G<k>, each exactly once', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE(), RUN2_NH())
    const before = snapshot(dir)
    throwsCode(() => applyGateAnswers(dir, { answers: [...gateAnswers(4), { id: 'G2', answer: MARKER }] }), 'DUPLICATE_ID', { ids: ['G2'] })
    throwsCode(() => applyGateAnswers(dir, { answers: [...gateAnswers(4), { id: 'G5', answer: MARKER }, { id: 'Q1', answer: GH }] }), 'UNKNOWN_ID', { ids: ['G5', 'Q1'] })
    throwsCode(() => applyGateAnswers(dir, { answers: gateAnswers(4).filter(a => a.id !== 'G3' && a.id !== 'G1') }), 'MISSING_ANSWER', { ids: ['G1', 'G3'] })
    throwsCode(() => applyGateAnswers(dir, { answers: [{ id: 'G0', answer: 'x' }, ...gateAnswers(4)] }), 'UNKNOWN_ID', { ids: ['G0'] })
    assert.deepEqual(snapshot(dir), before)
  })

  test('malformed caller input is INVALID_INPUT; CP-04a refusals pass through', async () => {
    const { applyGateAnswers } = await load()
    const dir = stagedDir(STATE(), RUN2_NH())
    const before = snapshot(dir)
    for (const opts of [undefined, null, [], {}, { answers: gateAnswers(4), have: [] }, { answers: 'G1' },
      { answers: [{ id: 'g1', answer: 'x' }] }, { answers: [{ id: 'G1', answer: '' }] }, { answers: [{ id: `G1-${MARKER}`, answer: 'x' }] },
      { answers: [{ id: 'G1', answer: 'x', about: 'Q1' }] }]) {
      throwsCode(() => applyGateAnswers(dir, opts), 'INVALID_INPUT')
    }
    assert.deepEqual(snapshot(dir), before)
    throwsCode(() => applyGateAnswers(join(WORK, 'harness'), { answers: gateAnswers(1) }), 'INVALID_INPUT', { own: false })
    const noState = makeDir()
    throwsCode(() => applyGateAnswers(noState, { answers: gateAnswers(1) }), 'MISSING', { own: false, file: 'state.json' })
    const badState = stagedDir(STATE(), RUN2_NH())
    put(badState, 'state.json', { ...STATE(), assumptions: [{ id: 'Q1' }] })
    throwsCode(() => applyGateAnswers(badState, { answers: gateAnswers(4) }), 'MALFORMED', { own: false, file: 'state.json' })
  })
})

// =====================================================================
describe('applyApprovalEdit', () => {
  test('adds the next D<n> as an "approval edit" decision (SKILL.md 6.4), gateRounds unchanged, downstream deleted', async () => {
    const { applyApprovalEdit } = await load()
    const question = skillQuoted(/`question: "([^"]+)"`, `resolves` empty, and\s+`note: "approval edit"`/)
    const note = skillQuoted(/`resolves` empty, and\s+`note: "([^"]+)"`, saved in `state.json`/)
    assert.deepEqual([question, note], ['approval edit', 'approval edit'])
    const dir = stagedDir(STATE({ gateRounds: 1 }), RUN2_READY(), RUN3_READY())
    const state = storedState(dir, applyApprovalEdit(dir, { edit: `  Use Postgres instead; DSN key ${STRIPE}  ` }))
    assert.deepEqual(state, { ...STATE({ gateRounds: 1 }), decisions: [...STATE().decisions,
      { id: 'D4', question, answer: 'Use Postgres instead; DSN key <redacted: API key>', resolves: [], note }] })
    assert.deepEqual(listDir(dir), ['state.json'])
  })

  test('it applies only at the approval: run3 backlog-ready and fresh', async () => {
    const { applyApprovalEdit } = await load()
    const pending = stagedDir(STATE(), RUN2_READY(), RUN3_NH())
    throwsCode(() => applyApprovalEdit(pending, { edit: 'x' }), 'NOT_BACKLOG_READY', { file: 'run3.json' })
    const noRun3 = stagedDir(STATE(), RUN2_READY())
    throwsCode(() => applyApprovalEdit(noRun3, { edit: 'x' }), 'MISSING', { own: false, file: 'run3.json' })
    const stale = stagedDir(STATE(), RUN2_READY(), RUN3_READY())
    put(stale, 'state.json', STATE({ gateRounds: 1 }))
    const before = snapshot(stale)
    throwsCode(() => applyApprovalEdit(stale, { edit: 'x' }), 'STALE_RUN', { file: 'run3.json' })
    assert.deepEqual(snapshot(stale), before)
    assert.ok(existsSync(join(pending, 'run3.json')) && existsSync(join(pending, 'run2.json')))
  })

  test('malformed caller input is INVALID_INPUT with nothing echoed or written', async () => {
    const { applyApprovalEdit } = await load()
    const dir = stagedDir(STATE(), RUN2_READY(), RUN3_READY())
    const before = snapshot(dir)
    for (const opts of [undefined, null, 'edit', [], {}, { edit: '' }, { edit: '  \n ' }, { edit: 3 }, { edit: null },
      { edit: 'x', id: 'D9' }, { edit: [MARKER] }]) {
      throwsCode(() => applyApprovalEdit(dir, opts), 'INVALID_INPUT')
    }
    assert.deepEqual(snapshot(dir), before)
  })
})
