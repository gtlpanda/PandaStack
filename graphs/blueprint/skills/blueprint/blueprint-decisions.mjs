// The /blueprint decision rules (spec/contracts/codex-parity-cp-04b.md).
//
// SKILL.md's answer rules (3.4-3.5, the 4.2 and 5.2 `needs-human` gates, and 6.4) as
// code: apply the human's interview, gate and approval-edit answers to state.json, then
// delete the design and backlog runs that a changed answer makes wrong. It runs no
// graph, asks no question and makes no git change.
//
// Synchronous. It reads through CP-04a's readers and writes only through CP-04a's
// writeState; its own filesystem calls are lstat and unlink. Every refusal of this
// module is an Error whose message is the fixed `Blueprint decisions: <CODE>.`, with a
// fixed file name or a list of checked ids at most. CP-04a errors pass through as they
// are.
import { lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  FILES, freshness, readRequest, readRun, readState, redactSecrets, validateState, writeState,
} from './blueprint-state.mjs'

export const BLUEPRINT_DECISION_CODES = Object.freeze(Object.fromEntries([
  'INVALID_INPUT', 'STATE_EXISTS', 'MALFORMED', 'NOT_NEEDS_HUMAN', 'NOT_BACKLOG_READY', 'STALE_RUN',
  'DUPLICATE_ID', 'UNKNOWN_ID', 'MISSING_ANSWER', 'BAD_PREFLIGHT', 'GATE_ROUNDS_EXHAUSTED', 'IO_ERROR',
].map(code => [code, code])))

// The only id shape blueprint-design.js mints (Q<n>, A<n>, D<n>), plus this module's G<n>.
const ID_SHAPE = /^[A-Z][0-9]{1,9}$/
const D_ID = /^D([0-9]{1,9})$/
const GATE_NOTE = 'design gate'
const OVERRIDE_NOTE = 'override'
const APPROVAL_EDIT = 'approval edit'
const MAX_GATE_ROUNDS = 2
// The runs a changed answer makes wrong, then meta.json (which holds only their basis).
const DOWNSTREAM_FILES = [FILES.run3, FILES.run2, FILES.meta]

// ---------------------------------------------------------------- errors

// The code, the fixed message and, when it applies, one fixed file name or the
// offending ids (each already matched ID_SHAPE). No `cause`: a filesystem error
// carries paths.
function refuse(code, { file, ids } = {}) {
  const error = new Error(`Blueprint decisions: ${code}.`)
  error.code = code
  if (file !== undefined) error.file = file
  if (ids !== undefined) error.ids = ids
  return error
}

// A missing entry, or a path component that is not a directory: nothing is there.
const isAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

// ---------------------------------------------------------------- small predicates

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const isNonBlank = value => typeof value === 'string' && value.trim() !== ''
const isId = value => typeof value === 'string' && ID_SHAPE.test(value)
// Array.from first: `every` skips the holes of a sparse array, which read as undefined.
const everyItem = (array, predicate) => Array.from(array).every(predicate)
const isStringArray = value => Array.isArray(value) && everyItem(value, item => typeof item === 'string')
const hasExactKeys = (value, keys) => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
const freeText = text => redactSecrets(text.trim())

// ---------------------------------------------------------------- caller input

// `opts` as a plain object with only `allowed` keys and every `required` key present
// (an undefined value counts as absent), else INVALID_INPUT.
function checkOptions(opts, allowed, required) {
  if (!isPlainObject(opts) || !Object.keys(opts).every(key => allowed.includes(key))) throw refuse('INVALID_INPUT')
  if (!required.every(key => opts[key] !== undefined)) throw refuse('INVALID_INPUT')
}

const isAnswerEntry = entry => isPlainObject(entry) && hasExactKeys(entry, ['id', 'answer']) && isId(entry.id) &&
  isNonBlank(entry.answer)

// An answer list: an array of {id, answer} with an id of the id shape and a non-blank
// answer. `undefined` takes the default, an empty list.
function answerList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !everyItem(value, isAnswerEntry)) throw refuse('INVALID_INPUT')
  return value
}

// ---------------------------------------------------------------- id checks

// Each `lists` entry is { entries, allowed: Set }; `asked` are the ids lists[0] must
// answer, in question order. Duplicate, then unknown, then missing: the first that
// fails is thrown, naming each offending id once.
function checkIds(lists, asked) {
  const duplicates = []
  for (const { entries } of lists) {
    const seen = new Set()
    for (const { id } of entries) {
      if (seen.has(id) && !duplicates.includes(id)) duplicates.push(id)
      seen.add(id)
    }
  }
  if (duplicates.length > 0) throw refuse('DUPLICATE_ID', { ids: duplicates })

  const unknown = []
  for (const { entries, allowed } of lists) {
    for (const { id } of entries) {
      if (!allowed.has(id) && !unknown.includes(id)) unknown.push(id)
    }
  }
  if (unknown.length > 0) throw refuse('UNKNOWN_ID', { ids: unknown })

  const answered = new Set(lists[0].entries.map(entry => entry.id))
  const missing = asked.filter(id => !answered.has(id))
  if (missing.length > 0) throw refuse('MISSING_ANSWER', { ids: missing })
}

const answersById = entries => new Map(entries.map(entry => [entry.id, entry.answer]))

// ---------------------------------------------------------------- files

// Whether `file` exists in `dir`, by lstat so a symlink (even a dangling one) counts.
function exists(dir, file) {
  try {
    lstatSync(join(dir, file))
    return true
  } catch (error) {
    if (isAbsent(error)) return false
    throw refuse('IO_ERROR', { file })
  }
}

function unlinkIfPresent(dir, file) {
  try {
    unlinkSync(join(dir, file))
  } catch (error) {
    if (!isAbsent(error)) throw refuse('IO_ERROR', { file })
  }
}

// The state first (CP-04a's atomic write), then the runs it makes wrong. A failure
// after the write leaves runs that freshness reports stale.
function save(dir, state) {
  const stored = writeState(dir, state)
  for (const file of DOWNSTREAM_FILES) unlinkIfPresent(dir, file)
  return stored
}

// ---------------------------------------------------------------- next D<n>

// One more than the highest D<n> among the decisions and the assumptions, or D1. A gap
// is never filled; an id already taken is skipped (D_ID counts at most nine digits, so
// D999999999 next to D1000000000 gives D1000000001).
function nextDecisionId(state) {
  const ids = new Set([...state.decisions, ...state.assumptions].map(item => item.id))
  let highest = 0
  for (const id of ids) {
    const match = typeof id === 'string' ? D_ID.exec(id) : null
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  let n = highest + 1
  while (ids.has(`D${n}`)) n += 1
  return `D${n}`
}

// ---------------------------------------------------------------- interview (SKILL.md 3.4-3.5)

const isOption = option => isPlainObject(option) && typeof option.label === 'string'
const isQuestion = q => isPlainObject(q) && isId(q.id) && typeof q.question === 'string' &&
  Array.isArray(q.options) && q.options.every(isOption) && isStringArray(q.resolves)
const isPreflightItem = p => isPlainObject(p) && typeof p.what === 'string' && typeof p.why === 'string' &&
  typeof p.needed_by === 'string'
const isRun1Assumption = a => isPlainObject(a) && isId(a.id)

function isInterview(run1) {
  const { questions, preflight, assumptions } = run1
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(isQuestion)) return false
  if (!Array.isArray(preflight) || !preflight.every(isPreflightItem)) return false
  if (!Array.isArray(assumptions) || !assumptions.every(isRun1Assumption)) return false
  const ids = [...questions, ...assumptions].map(item => item.id)
  return new Set(ids).size === ids.length
}

// Every name must be some item's `what`, with no name twice. The name is never echoed.
function checkHave(have, preflight) {
  const names = new Set(preflight.map(item => item.what))
  const seen = new Set()
  for (const name of have) {
    if (!names.has(name) || seen.has(name)) throw refuse('BAD_PREFLIGHT')
    seen.add(name)
  }
}

// An exact option label is kept as written; anything else is free text.
function interviewAnswer(question, answer) {
  return question.options.some(option => option.label === answer) ? answer : freeText(answer)
}

function buildInterviewState(request, run1, answers, have, overrides) {
  const answerOf = answersById(answers)
  const overrideOf = answersById(overrides)
  const owned = new Set(have)
  const asked = run1.questions.map(q => ({
    id: q.id, question: q.question, answer: interviewAnswer(q, answerOf.get(q.id)), resolves: [...q.resolves], note: null,
  }))
  const overridden = run1.assumptions.filter(a => overrideOf.has(a.id)).map(a => ({
    id: a.id,
    question: typeof a.assumption === 'string' ? a.assumption : '',
    answer: freeText(overrideOf.get(a.id)),
    resolves: [],
    note: OVERRIDE_NOTE,
  }))
  return {
    request: request.request,
    docs: request.docs,
    brief: run1.brief,
    decisions: [...asked, ...overridden],
    assumptions: run1.assumptions.filter(a => !overrideOf.has(a.id)),
    preflight: run1.preflight.map(p => ({ what: p.what, why: p.why, needed_by: p.needed_by, have: owned.has(p.what) })),
    gateRounds: 0,
  }
}

function interviewOptions(opts) {
  checkOptions(opts, ['answers', 'have', 'overrides'], ['answers'])
  const answers = answerList(opts.answers)
  const overrides = answerList(opts.overrides)
  const have = opts.have === undefined ? [] : opts.have
  if (!isStringArray(have)) throw refuse('INVALID_INPUT')
  return { answers, have, overrides }
}

export function applyInterviewAnswers(dir, opts) {
  const { answers, have, overrides } = interviewOptions(opts)
  const request = readRequest(dir)
  // Answers become binding once; starting over is CP-04a's initState with restart.
  if (exists(dir, FILES.state)) throw refuse('STATE_EXISTS', { file: FILES.state })
  const run1 = readRun(dir, 1)
  if (run1.status !== 'needs-human') throw refuse('NOT_NEEDS_HUMAN', { file: FILES.run1 })
  if (!isInterview(run1)) throw refuse('MALFORMED', { file: FILES.run1 })

  const questionIds = run1.questions.map(q => q.id)
  // An assumption past the question cap (Q13) is an override, never an answer.
  checkIds([
    { entries: answers, allowed: new Set(questionIds) },
    { entries: overrides, allowed: new Set(run1.assumptions.map(a => a.id)) },
  ], questionIds)
  checkHave(have, run1.preflight)

  const state = buildInterviewState(request, run1, answers, have, overrides)
  if (!validateState(state)) throw refuse('MALFORMED', { file: FILES.run1 })
  return save(dir, state)
}

// ---------------------------------------------------------------- gates (SKILL.md 4.2, 5.2)

// The gate the human is answering: run3 (the backlog gate) when present, else run2.
function pendingGate(dir) {
  const n = exists(dir, FILES.run3) ? 3 : 2
  const file = n === 3 ? FILES.run3 : FILES.run2
  const run = readRun(dir, n)
  if (run.status !== 'needs-human') throw refuse('NOT_NEEDS_HUMAN', { file })
  const { design, backlog } = freshness(dir)
  if ((n === 3 ? backlog : design) !== 'fresh') throw refuse('STALE_RUN', { file })
  return { run, file }
}

// blueprint-design.js gateQuestions: exactly {about, question}, a non-blank question,
// and `about` null or an id the state already holds.
function checkGateQuestions(questions, state, file) {
  const known = new Set([...state.decisions, ...state.assumptions].map(item => item.id))
  const fits = q => isPlainObject(q) && hasExactKeys(q, ['about', 'question']) && isNonBlank(q.question) &&
    (q.about === null || (typeof q.about === 'string' && known.has(q.about)))
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(fits)) throw refuse('MALFORMED', { file })
}

// One gate answer, in place on `state`. `about` is resolved now, not when the questions
// were checked, so a second question about a just-converted assumption sets the new
// decision's answer.
function applyGateAnswer(state, { about, question }, answer) {
  const decision = about === null ? undefined : state.decisions.find(d => d.id === about)
  if (decision) {
    decision.answer = answer
    decision.note = GATE_NOTE
    return
  }
  let id = about
  if (about === null) id = nextDecisionId(state)
  else state.assumptions = state.assumptions.filter(a => a.id !== about)
  state.decisions.push({ id, question, answer, resolves: [], note: GATE_NOTE })
}

export function applyGateAnswers(dir, opts) {
  checkOptions(opts, ['answers'], ['answers'])
  const answers = answerList(opts.answers)
  const state = readState(dir)
  // SKILL.md: the gates ask at most twice per request, both gates together.
  if (state.gateRounds >= MAX_GATE_ROUNDS) throw refuse('GATE_ROUNDS_EXHAUSTED')
  const { run, file } = pendingGate(dir)
  checkGateQuestions(run.questions, state, file)

  // The ledger gives gate questions no id: question k (1-based) is answered as G<k>.
  const gateIds = run.questions.map((_question, i) => `G${i + 1}`)
  checkIds([{ entries: answers, allowed: new Set(gateIds) }], gateIds)
  const answerOf = answersById(answers)
  run.questions.forEach((question, i) => applyGateAnswer(state, question, freeText(answerOf.get(gateIds[i]))))
  state.gateRounds += 1
  return save(dir, state)
}

// ---------------------------------------------------------------- approval edit (SKILL.md 6.4)

export function applyApprovalEdit(dir, opts) {
  checkOptions(opts, ['edit'], ['edit'])
  if (!isNonBlank(opts.edit)) throw refuse('INVALID_INPUT')
  const state = readState(dir)
  const run3 = readRun(dir, 3)
  // An edit answers the one approval, which only a ready backlog reaches.
  if (run3.status !== 'backlog-ready') throw refuse('NOT_BACKLOG_READY', { file: FILES.run3 })
  if (freshness(dir).backlog !== 'fresh') throw refuse('STALE_RUN', { file: FILES.run3 })
  // gateRounds is unchanged: SKILL.md 6.4 does not count an edit as a gate round.
  state.decisions.push({ id: nextDecisionId(state), question: APPROVAL_EDIT, answer: freeText(opts.edit), resolves: [], note: APPROVAL_EDIT })
  return save(dir, state)
}
