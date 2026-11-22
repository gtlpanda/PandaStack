#!/usr/bin/env node
// The /blueprint stage CLI on the native runtime (spec/contracts/codex-parity-cp-04c.md).
//
//   node blueprint-native.mjs <verb> --args-file <absolute path>
//
// What a Codex session drives for SKILL.md sections 1.3 to 5. `start` saves the
// request (CP-04a); `interview`, `design` and `backlog` each run one blueprint-design
// stage on Codex leaves through the CP-02e graph host and store its ledger as run1,
// run2 or run3; `answer`, `gate` and `edit` record the human's answers (CP-04b). The
// session asks every question in chat (W2-6); this CLI does everything else.
//
// Its only process of its own is `git -C <repo> rev-parse --show-toplevel` (argv
// array, no shell); the host starts codex. It makes no git write. On success stdout is
// one JSON line, the report. On failure stdout is empty and stderr is one JSON line,
// `{"error":"<CODE>"}` (plus CP-04b's shape-checked `ids` for three codes): never a
// path, request, answer, prompt, completion, the leaf environment or the args file.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FILES, backlogArgs, designArgs, freshness, initState, readArgsFile, readRequest, redactJSON, resolveStateDir, writeRun,
} from './blueprint-state.mjs'
import { applyApprovalEdit, applyGateAnswers, applyInterviewAnswers } from './blueprint-decisions.mjs'
import { runGraphHost } from '../../../../core/skills/native-runtime/graph-host.mjs'
import { createCodexProvider } from '../../../../core/skills/native-runtime/codex-provider.mjs'

const HOST_KEYS = ['installationRoot', 'codexBin', 'env', 'timeoutMs']
// Per verb: the keys the args file may hold, and those it must hold.
const VERBS = Object.freeze({
  start: { allowed: ['repo', 'request', 'docs', 'restart'], required: ['repo'] },
  interview: { allowed: ['repo', ...HOST_KEYS], required: ['repo', ...HOST_KEYS] },
  answer: { allowed: ['repo', 'answers', 'have', 'overrides'], required: ['repo', 'answers'] },
  design: { allowed: ['repo', ...HOST_KEYS], required: ['repo', ...HOST_KEYS] },
  gate: { allowed: ['repo', 'answers'], required: ['repo', 'answers'] },
  backlog: { allowed: ['repo', ...HOST_KEYS], required: ['repo', ...HOST_KEYS] },
  edit: { allowed: ['repo', 'edit'], required: ['repo', 'edit'] },
})
// The stage verbs: the run number each one writes.
const STAGE_RUN = Object.freeze({ interview: 1, design: 2, backlog: 3 })

const WORKFLOW_ID = 'blueprint-design'
const OFFERING_ID = 'blueprint'
const NATIVE_RUNS = 'native-runs'
// CP-02e's path rule: at most 4096 bytes, no C0/C1 control character.
const MAX_PATH_BYTES = 4096
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
// CP-02b needs timeoutMs > its default graceMs (500) + its 500 ms settle margin.
const MIN_TIMEOUT_MS = 1001
const MAX_TIMEOUT_MS = 86400000
const GIT_TIMEOUT_MS = 10000
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
// CP-04b's id shape, for the `ids` it attaches to three of its refusals.
const ID_SHAPE = /^[A-Z][0-9]{1,9}$/
const CODES_WITH_IDS = ['DUPLICATE_ID', 'UNKNOWN_ID', 'MISSING_ANSWER']
// The CP-04a and CP-04b refusal codes passed through as they are. Exit 2, except
// IO_ERROR (exit 3). Any other throw from those modules is this CLI's IO_ERROR.
const PASS_THROUGH = new Set([
  'INVALID_INPUT', 'NOT_A_REPO', 'NO_REQUEST', 'DOC_INVALID', 'DOC_MISSING', 'STATE_EXISTS', 'NO_STATE_DIR', 'MISSING',
  'MALFORMED', 'NOT_DESIGN_READY', 'NOT_NEEDS_HUMAN', 'NOT_BACKLOG_READY', 'STALE_RUN', 'DUPLICATE_ID', 'UNKNOWN_ID',
  'MISSING_ANSWER', 'BAD_PREFLIGHT', 'GATE_ROUNDS_EXHAUSTED', 'IO_ERROR',
])

// ---------------------------------------------------------------- errors

// A refusal or failure of this CLI: its code, the exit it reports, and CP-04b's ids
// when they apply. No message beyond the code, and no `cause`.
class Refusal extends Error {
  constructor(code, exit, ids) {
    super(`Blueprint native: ${code}.`)
    this.code = code
    this.exit = exit
    if (ids !== undefined) this.ids = ids
  }
}
const refuse = (code, exit, ids) => new Refusal(code, exit, ids)

// A missing entry, or a path component that is not a directory: nothing is there.
const isAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

const isIdList = value => Array.isArray(value) && value.every(id => typeof id === 'string' && ID_SHAPE.test(id))

// A throw from CP-04a or CP-04b as this CLI's refusal: a known code passes through
// (IO_ERROR at exit 3, the rest at exit 2, the three id codes with their ids); anything
// else is IO_ERROR.
function libraryRefusal(error) {
  const code = error?.code
  if (typeof code !== 'string' || !PASS_THROUGH.has(code)) return refuse('IO_ERROR', 3)
  if (code === 'IO_ERROR') return refuse(code, 3)
  const ids = CODES_WITH_IDS.includes(code) && isIdList(error.ids) ? [...error.ids] : undefined
  return refuse(code, 2, ids)
}

// Runs fn; a Refusal is kept, any other throw becomes libraryRefusal's.
function library(fn) {
  try {
    return fn()
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw libraryRefusal(error)
  }
}

// ---------------------------------------------------------------- argv and args file

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isPathValue = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
  !CONTROL.test(value) && isAbsolute(value)
const isEnv = value => isPlainObject(value) && Object.values(value).every(item => typeof item === 'string')
const isTimeout = value => Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS

// The rule for each key this CLI checks itself. The others (request, docs, restart,
// answers, have, overrides, edit) are CP-04a's and CP-04b's to check.
const KEY_RULES = Object.freeze({ repo: isPathValue, installationRoot: isPathValue, codexBin: isPathValue, env: isEnv, timeoutMs: isTimeout })

// argv is exactly: the verb, `--args-file`, the path. Returns { verb, args }. Runs
// before any git call or file access in the repository.
function parseInput(argv) {
  if (argv.length !== 3 || !Object.hasOwn(VERBS, argv[0]) || argv[1] !== '--args-file') throw refuse('INVALID_ARGS', 1)
  const verb = argv[0]
  const { allowed, required } = VERBS[verb]
  let args
  try {
    args = readArgsFile(argv[2], allowed)
  } catch {
    throw refuse('INVALID_ARGS', 1)
  }
  if (!required.every(key => Object.hasOwn(args, key))) throw refuse('INVALID_ARGS', 1)
  for (const [key, rule] of Object.entries(KEY_RULES)) {
    if (Object.hasOwn(args, key) && !rule(args[key])) throw refuse('INVALID_ARGS', 1)
  }
  return { verb, args }
}

// Only the listed keys the args file has, in that order.
const present = (args, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]))

// ---------------------------------------------------------------- the checks every verb runs

// One trailing newline removed, nothing else.
const chompOne = text => (text.endsWith('\n') ? text.slice(0, -1) : text)

// 1. Repo: git's top level must be this exact directory. 2. Its state directory.
// Returns { top, dir }.
function locate(repo) {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', shell: false, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw refuse('NOT_A_REPO', 2)
  let real
  try { real = realpathSync(repo) } catch { throw refuse('NOT_A_REPO', 2) }
  const top = chompOne(result.stdout)
  if (top !== real) throw refuse('NOT_A_REPO', 2)
  const dir = library(() => resolveStateDir(top))
  return { top, dir }
}

// ---------------------------------------------------------------- start, answer, gate, edit

function start(dir, args) {
  const stored = library(() => initState(dir, present(args, ['request', 'docs', 'restart'])))
  // CP-04a stores the trimmed request, redacted, or null when there is none.
  const given = typeof args.request === 'string' ? args.request.trim() : ''
  const redacted = given !== '' && stored.request !== given
  return { stateDir: dir, redacted }
}

// Whether redaction changes the verb's own keys from the args file (repo excluded).
function ownKeysRedacted(args) {
  const own = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'repo'))
  return library(() => JSON.stringify(redactJSON(own)) !== JSON.stringify(own))
}

function answer(dir, args) {
  const state = library(() => applyInterviewAnswers(dir, present(args, ['answers', 'have', 'overrides'])))
  return {
    decisions: state.decisions.length,
    assumptions: state.assumptions.length,
    owed: state.preflight.filter(item => item.have === false).length,
    redacted: ownKeysRedacted(args),
  }
}

function gate(dir, args) {
  const state = library(() => applyGateAnswers(dir, present(args, ['answers'])))
  return { gateRounds: state.gateRounds, redacted: ownKeysRedacted(args) }
}

function edit(dir, args) {
  const state = library(() => applyApprovalEdit(dir, present(args, ['edit'])))
  return { decisions: state.decisions.length, redacted: ownKeysRedacted(args) }
}

// ---------------------------------------------------------------- the stages

// 1 and 2. The stage's inputs, refused before anything is created, then its workflow args.
function stageArgs(stage, top, dir) {
  if (stage === 'interview') {
    let stateThere = true
    try {
      lstatSync(join(dir, FILES.state)) // a symlink counts
    } catch (error) {
      if (!isAbsent(error)) throw refuse('IO_ERROR', 3)
      stateThere = false
    }
    if (stateThere) throw refuse('STATE_EXISTS', 2)
    const { request, docs } = library(() => readRequest(dir))
    // SKILL.md section 2: no request key when only documents were given.
    return request === null ? { repo: top, docs } : { repo: top, request, docs }
  }
  const statePath = join(dir, FILES.state)
  if (stage === 'design') return { ...library(() => designArgs(dir)), repo: top, stage: 'design', statePath }
  const base = library(() => backlogArgs(dir))
  if (library(() => freshness(dir)).design !== 'fresh') throw refuse('STALE', 2)
  return { ...base, repo: top, stage: 'backlog', statePath, designPath: join(dir, FILES.run2) }
}

// `bp-<stage>-<UTC yyyymmddThhmmssZ>-<8 lowercase hex>`.
function newInvocationId(stage) {
  const stamp = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
  return `bp-${stage}-${stamp}-${randomBytes(4).toString('hex')}`
}

// <dir>/native-runs, a real directory, 0700. Only the host creates the run directory.
function prepareNativeRuns(dir) {
  const path = join(dir, NATIVE_RUNS)
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (!lstatSync(path).isDirectory()) throw new Error('not a directory')
    chmodSync(path, 0o700)
  } catch {
    throw refuse('IO_ERROR', 3)
  }
}

// The host, with SIGINT and SIGTERM aborting it while it runs. Never rejects.
async function runHost(options) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    return await runGraphHost({ ...options, signal: controller.signal })
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

// The host's own failure, passed through: its code and exit 1 to 4.
function hostRefusal(outcome) {
  const valid = Number.isInteger(outcome?.exitCode) && outcome.exitCode >= 1 && outcome.exitCode <= 4 &&
    typeof outcome.error === 'string' && ERROR_CODE.test(outcome.error)
  return valid ? refuse(outcome.error, outcome.exitCode) : refuse('IO_ERROR', 3)
}

// 5. The ledger through CP-04a's writeRun. INVALID_INPUT (a status this run may not
// hold) is INVALID_RESULT; any other refusal keeps its code. Every failure is exit 3.
function storeRun(dir, n, result) {
  try {
    return writeRun(dir, n, result)
  } catch (error) {
    if (error?.code === 'INVALID_INPUT') throw refuse('INVALID_RESULT', 3)
    throw refuse(libraryRefusal(error).code, 3)
  }
}

async function stage(verb, top, dir, args) {
  const n = STAGE_RUN[verb]
  const workflowArgs = stageArgs(verb, top, dir)
  const invocationId = newInvocationId(verb)
  const runDir = join(dir, NATIVE_RUNS, invocationId)
  // Built before native-runs exists: the factory touches no file and starts no process,
  // so a provider it refuses leaves nothing behind.
  let provider
  try {
    provider = createCodexProvider({ codexBin: args.codexBin, cwd: top, env: args.env, runDir: join(runDir, 'provider') })
  } catch {
    throw refuse('INVALID_ARGS', 1)
  }
  prepareNativeRuns(dir)
  const outcome = await runHost({
    installationRoot: args.installationRoot, workflowId: WORKFLOW_ID, offeringId: OFFERING_ID, invocationId,
    args: workflowArgs, runDir, timeoutMs: args.timeoutMs, maxConcurrentSubagents: 1, provider,
  })
  if (outcome?.exitCode !== 0) throw hostRefusal(outcome)
  const stored = storeRun(dir, n, outcome.result)
  return {
    status: stored.status,
    file: FILES[`run${n}`],
    invocationId,
    redacted: JSON.stringify(stored) !== JSON.stringify(outcome.result),
  }
}

// ---------------------------------------------------------------- CLI

const PLAIN_VERBS = Object.freeze({ start, answer, gate, edit })

// Returns { exit, stdout, stderr }. A throw that is not a Refusal is IO_ERROR, exit 3.
async function run(argv) {
  try {
    const { verb, args } = parseInput(argv)
    const { top, dir } = locate(args.repo)
    const report = Object.hasOwn(STAGE_RUN, verb) ? await stage(verb, top, dir, args) : PLAIN_VERBS[verb](dir, args)
    return { exit: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' }
  } catch (error) {
    const failure = error instanceof Refusal ? error : refuse('IO_ERROR', 3)
    const body = failure.ids === undefined ? { error: failure.code } : { error: failure.code, ids: failure.ids }
    return { exit: failure.exit, stdout: '', stderr: `${JSON.stringify(body)}\n` }
  }
}

function isMainModule() {
  try {
    return typeof process.argv[1] === 'string' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// process.exitCode, never process.exit(): stdout to a pipe may still be flushing.
if (isMainModule()) {
  const { exit, stdout, stderr } = await run(process.argv.slice(2))
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = exit
}
