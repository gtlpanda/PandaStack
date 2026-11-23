#!/usr/bin/env node
// The /release-pr stage CLI on the native runtime (spec/contracts/codex-parity-cp-08.md).
//
//   node release-native.mjs <verb> --args-file <absolute path>
//
// What a Codex session drives for SKILL.md. `docs`, `ready`, `land` and `verify` each run
// one release-flow stage on Codex leaves through the CP-02e graph host and save its ledger
// to <git-dir>/harness-release/<pr>/ledger.json; `approve` records the human's approval
// for one exact head. The session asks the approval question in chat and does the commits,
// the push and every wait; this CLI never commits, pushes or merges by itself.
//
// Safety, held here and not left to the session:
//   - `land` runs only with an approval that `approve` saved for the head the last `ready`
//     stage reported (the graph then re-checks that head on GitHub: a moved head is stale);
//   - the merger leaf is dispatched at most once per pull request, ever: the marker
//     merge-attempt.json is created (O_EXCL) immediately before its dispatch and never
//     removed, so a failed, timed-out or unknown merge is never retried by this CLI (a later
//     `land` only reads the state back: an already merged pull request is reported, not merged);
//   - no provider fallback: a refused or failed leaf is an `escalate` ledger.
//
// stdout on exit 0 is one JSON line, the report. On failure stdout is empty and stderr
// is one JSON line, {"error":"<CODE>"}: never a path, a prompt, a completion, the leaf
// environment or the args file. Wiring proof, not runtime certification.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGraphHost } from '../../../../core/skills/native-runtime/graph-host.mjs'
import { createCodexProvider } from '../../../../core/skills/native-runtime/codex-provider.mjs'
import { failedCompletion } from '../../../../core/skills/native-runtime/completion.mjs'

const WORKFLOW_ID = 'release-flow'
const OFFERING_ID = 'release-pr'
const MERGER_ROLE = 'merger'
const HOST_KEYS = ['installationRoot', 'codexBin', 'env', 'timeoutMs']
const VERBS = Object.freeze({
  docs: { allowed: ['repo', 'pr', ...HOST_KEYS], required: ['repo', 'pr', ...HOST_KEYS] },
  ready: { allowed: ['repo', 'pr', ...HOST_KEYS], required: ['repo', 'pr', ...HOST_KEYS] },
  approve: { allowed: ['repo', 'pr', 'head', 'base'], required: ['repo', 'pr', 'head', 'base'] },
  land: { allowed: ['repo', 'pr', ...HOST_KEYS], required: ['repo', 'pr', ...HOST_KEYS] },
  verify: { allowed: ['repo', 'pr', ...HOST_KEYS, 'verifyRound', 'prior'], required: ['repo', 'pr', ...HOST_KEYS] },
})
const FILES = Object.freeze({ ledger: 'ledger.json', approval: 'approval.json', attempt: 'merge-attempt.json',
  merged: 'merge.json', runs: 'native-runs' })
const MAX_PATH_BYTES = 4096
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const MAX_ARGS_BYTES = 1048576
const MIN_TIMEOUT_MS = 1001 // CP-02b: timeoutMs must exceed its default grace (500) plus its 500 ms settle margin
const MAX_TIMEOUT_MS = 86400000
const GIT_TIMEOUT_MS = 10000
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const GIT_OID = /^[0-9a-f]{7,64}$/
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

// ---------------------------------------------------------------- errors

class Refusal extends Error {
  constructor(code, exit) {
    super(`Release native: ${code}.`)
    this.code = code
    this.exit = exit
  }
}
const refuse = (code, exit) => new Refusal(code, exit)
const isAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

// ---------------------------------------------------------------- argv and args file

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const isPathValue = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
  !CONTROL.test(value) && isAbsolute(value)
const KEY_RULES = Object.freeze({
  repo: isPathValue, installationRoot: isPathValue, codexBin: isPathValue,
  pr: value => Number.isSafeInteger(value) && value > 0,
  env: value => isPlainObject(value) && Object.values(value).every(item => typeof item === 'string'),
  timeoutMs: value => Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS,
  head: value => typeof value === 'string' && GIT_OID.test(value),
  base: value => typeof value === 'string' && REF_NAME.test(value),
  verifyRound: value => Number.isSafeInteger(value) && value > 0,
  prior: value => Array.isArray(value) && value.every(isPlainObject),
})

function readArgsFile(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = readFileSync(fd)
    if (buffer.length > MAX_ARGS_BYTES) throw new Error('too large')
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
    if (!isPlainObject(parsed)) throw new Error('not an object')
    return parsed
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// argv is exactly: the verb, `--args-file`, the path. Runs before any git call or file access in the repository.
function parseInput(argv) {
  if (argv.length !== 3 || !Object.hasOwn(VERBS, argv[0]) || argv[1] !== '--args-file' || !isPathValue(argv[2])) {
    throw refuse('INVALID_ARGS', 1)
  }
  const verb = argv[0]
  const { allowed, required } = VERBS[verb]
  let args
  try { args = readArgsFile(argv[2]) } catch { throw refuse('INVALID_ARGS', 1) }
  if (!Object.keys(args).every(key => allowed.includes(key)) || !required.every(key => Object.hasOwn(args, key))) {
    throw refuse('INVALID_ARGS', 1)
  }
  for (const [key, value] of Object.entries(args)) if (!KEY_RULES[key](value)) throw refuse('INVALID_ARGS', 1)
  return { verb, args }
}

// ---------------------------------------------------------------- the repository and its state directory

const gitOut = (repo, ...gitArgs) => {
  const result = spawnSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8', shell: false, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw refuse('NOT_A_REPO', 2)
  return result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
}

// git's top level must be this exact directory. Returns { top, dir }: dir is <git-dir>/harness-release/<pr>.
function locate(repo, pr) {
  let real
  try { real = realpathSync(repo) } catch { throw refuse('NOT_A_REPO', 2) }
  const top = gitOut(repo, 'rev-parse', '--show-toplevel')
  if (top !== real) throw refuse('NOT_A_REPO', 2)
  const base = gitOut(top, 'rev-parse', '--path-format=absolute', '--git-path', 'harness-release')
  if (!isAbsolute(base)) throw refuse('NOT_A_REPO', 2)
  return { top, dir: join(base, String(pr)) }
}

function ensureDir(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (!lstatSync(path).isDirectory()) throw new Error('not a directory')
    chmodSync(path, 0o700)
  } catch { throw refuse('IO_ERROR', 3) }
}

// A state file as a parsed object, or null when absent. Anything unreadable is IO_ERROR.
function readState(dir, name) {
  let text
  try { text = readFileSync(join(dir, name), 'utf8') } catch (error) {
    if (isAbsent(error)) return null
    throw refuse('IO_ERROR', 3)
  }
  try {
    const value = JSON.parse(text)
    if (!isPlainObject(value)) throw new Error('not an object')
    return value
  } catch { throw refuse('IO_ERROR', 3) }
}

// Write through a unique 0600 temp file and a rename, so a state file is never half written.
function writeState(dir, name, value) {
  const final = join(dir, name)
  const temp = `${final}.tmp-${randomBytes(8).toString('hex')}`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, final)
  } catch {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* nothing to remove */ }
    throw refuse('IO_ERROR', 3)
  }
}

function removeState(dir, name) {
  try { unlinkSync(join(dir, name)) } catch (error) { if (!isAbsent(error)) throw refuse('IO_ERROR', 3) }
}

// ---------------------------------------------------------------- the host

function newInvocationId(verb) {
  const stamp = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
  return `rel-${verb}-${stamp}-${randomBytes(4).toString('hex')}`
}

// The merge marker, created exclusively (O_EXCL) immediately before the merger is dispatched
// and never removed: the merge is attempted at most once per pull request. Returns false when
// a marker already exists or cannot be written, which refuses the dispatch.
function claimMergeAttempt(dir, record) {
  let fd
  try {
    fd = openSync(join(dir, FILES.attempt), 'wx', 0o600)
    writeSync(fd, `${JSON.stringify(record)}\n`)
    fsyncSync(fd)
    return true
  } catch { return false } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Wraps the Codex provider so the merger leaf is dispatched only if it wins the marker.
// A refused dispatch is a failed leaf the graph turns into an escalation; nothing is spawned.
function mergeGuardedProvider(inner, dir, attempt) {
  return Object.freeze({
    async runLeaf(request) {
      if (request?.agentType === MERGER_ROLE && !claimMergeAttempt(dir, attempt)) {
        return failedCompletion({ selection: request.selection, code: 'MERGE_ALREADY_ATTEMPTED', invocationId: `release:${request.callId}` })
      }
      return inner.runLeaf(request)
    },
  })
}

async function runHost(options) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try { return await runGraphHost({ ...options, signal: controller.signal }) } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

function hostRefusal(outcome) {
  const valid = Number.isInteger(outcome?.exitCode) && outcome.exitCode >= 1 && outcome.exitCode <= 4 &&
    typeof outcome.error === 'string' && ERROR_CODE.test(outcome.error)
  return valid ? refuse(outcome.error, outcome.exitCode) : refuse('IO_ERROR', 3)
}

// One release-flow stage. Returns the host's result (the ledger).
async function runStage(verb, top, dir, args, workflowArgs, attempt) {
  const invocationId = newInvocationId(verb)
  const runDir = join(dir, FILES.runs, invocationId)
  let inner
  try {
    inner = createCodexProvider({ codexBin: args.codexBin, cwd: top, env: args.env, runDir: join(runDir, 'provider') })
  } catch { throw refuse('INVALID_ARGS', 1) }
  ensureDir(join(dir, FILES.runs))
  const provider = attempt === null ? inner : mergeGuardedProvider(inner, dir, attempt)
  const outcome = await runHost({ installationRoot: args.installationRoot, workflowId: WORKFLOW_ID, offeringId: OFFERING_ID,
    invocationId, args: { repo: top, pr: args.pr, stage: verb, ...workflowArgs }, runDir, timeoutMs: args.timeoutMs,
    maxConcurrentSubagents: 1, provider })
  if (outcome?.exitCode !== 0) throw hostRefusal(outcome)
  if (!isPlainObject(outcome.result) || typeof outcome.result.status !== 'string') throw refuse('INVALID_RESULT', 3)
  return { ledger: outcome.result, invocationId }
}

// ---------------------------------------------------------------- the verbs

// A stage that reads the pull request. A new reading makes any earlier approval stale, so it is removed.
async function readStage(verb, top, dir, args) {
  removeState(dir, FILES.approval)
  return runStage(verb, top, dir, args, {}, null)
}

// Saves the approval for one exact head. Only for the head and base the last `ready` stage reported.
function approve(dir, args) {
  const ledger = readState(dir, FILES.ledger)
  if (ledger === null || ledger.stage !== 'ready' || ledger.status !== 'ready-to-merge' || ledger.pr !== args.pr) {
    throw refuse('NOT_READY', 2)
  }
  if (ledger.head !== args.head || ledger.base !== args.base) throw refuse('HEAD_MISMATCH', 2)
  if (readState(dir, FILES.attempt) !== null) throw refuse('MERGE_ALREADY_ATTEMPTED', 2)
  writeState(dir, FILES.approval, { pr: args.pr, head: args.head, base: args.base })
  return { approved: true, head: args.head }
}

// The merge. Needs the saved approval. It may be run again after a merge attempt only to read the
// state back: the graph reports a pull request that is already MERGED without calling the merger,
// and mergeGuardedProvider refuses every later merger dispatch, so a second merge cannot start.
async function land(top, dir, args) {
  const approval = readState(dir, FILES.approval)
  if (approval === null || approval.pr !== args.pr) throw refuse('NO_APPROVAL', 2)
  const attempt = { pr: args.pr, head: approval.head, base: approval.base, at: new Date().toISOString() }
  const result = await runStage('land', top, dir, args, { approval: { pr: approval.pr, head: approval.head, base: approval.base } }, attempt)
  const { ledger } = result
  if (ledger.status === 'stale') removeState(dir, FILES.approval) // the old approval never carries over
  if (ledger.status === 'merged' && ledger.merge?.merge_sha) {
    writeState(dir, FILES.merged, { mergeSha: ledger.merge.merge_sha, targets: Array.isArray(ledger.targets) ? ledger.targets : [] })
  }
  return result
}

async function verify(top, dir, args) {
  const merged = readState(dir, FILES.merged)
  if (merged === null) throw refuse('NOT_MERGED', 2)
  const extra = { mergeSha: merged.mergeSha, targets: merged.targets }
  if (args.verifyRound !== undefined) extra.verifyRound = args.verifyRound
  if (args.prior !== undefined) extra.prior = args.prior
  return runStage('verify', top, dir, args, extra, null)
}

// ---------------------------------------------------------------- CLI

// Returns { exit, stdout, stderr }. A throw that is not a Refusal is IO_ERROR, exit 3.
async function run(argv) {
  try {
    const { verb, args } = parseInput(argv)
    const { top, dir } = locate(args.repo, args.pr)
    ensureDir(dir)
    let report
    if (verb === 'approve') report = approve(dir, args)
    else {
      const result = verb === 'land' ? await land(top, dir, args)
        : verb === 'verify' ? await verify(top, dir, args) : await readStage(verb, top, dir, args)
      writeState(dir, FILES.ledger, result.ledger)
      report = { status: result.ledger.status, file: FILES.ledger, stateDir: dir, invocationId: result.invocationId }
    }
    return { exit: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' }
  } catch (error) {
    const failure = error instanceof Refusal ? error : refuse('IO_ERROR', 3)
    return { exit: failure.exit, stdout: '', stderr: `${JSON.stringify({ error: failure.code })}\n` }
  }
}

function isMainModule() {
  try {
    return typeof process.argv[1] === 'string' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch { return false }
}

// process.exitCode, never process.exit(): stdout to a pipe may still be flushing.
if (isMainModule()) {
  const { exit, stdout, stderr } = await run(process.argv.slice(2))
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = exit
}
