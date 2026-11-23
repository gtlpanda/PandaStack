#!/usr/bin/env node
// The /dev driver for Codex (the `## Codex runner` section of SKILL.md). It does what
// SKILL.md section 2 does for the Workflow tool and nothing else: it builds the host
// args for the `dev-build` workflow from the saved state in `<git dir>/harness-dev`,
// runs the native graph host, and saves the returned ledger (and the plan, when the
// saved-plan rules say to). Preflight, /verify, the touched-files check, commits and
// every question to the human stay with the session.
//   node dev-native.mjs run --args-file <absolute path>
// It starts only `git` (rev-parse) and the host CLI; it imports no repository module,
// so the host's leaf rules (roles, sandboxes, models, refusals) are never copied here.
// Wiring proof only (tests use the fake codex): not runtime certification.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const STATE_GIT_PATH = 'harness-dev'
const MAX_ARGS_BYTES = 1048576
const MAX_PATH_BYTES = 4096
const MIN_TIMEOUT_MS = 1001
const MAX_TIMEOUT_MS = 86400000
const GIT_TIMEOUT_MS = 30000
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const INVOCATION_ID = /^dev-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/
const MODES = ['new', 'plan', 'resume']
const APPROVALS = ['advisor', 'human']
const REQUIRED_KEYS = ['repo', 'mode', 'installationRoot', 'codexBin', 'env', 'timeoutMs']
const OPTIONAL_KEYS = ['task', 'base', 'approval', 'maxFixRounds', 'knownStuckSigs', 'requiredCriteria', 'invocationId']
const DEFAULT_FIX_ROUNDS = 3

// An error with a fixed code and the exit status it maps to.
class Refusal extends Error {
  constructor(code, exitCode, extra = {}) { super(`dev-native: ${code}`); this.code = code; this.exitCode = exitCode; this.extra = extra }
}
const refuse = (code, exitCode, extra) => new Refusal(code, exitCode, extra)

// ---------------------------------------------------------------- args file

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const isPath = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
  !CONTROL.test(value) && isAbsolute(value)
const isText = value => typeof value === 'string' && value.trim() !== ''
const isCriterion = value => isPlainObject(value) && isText(value.id) && isText(value.criterion)

// One rule per key. A key absent from the file is never checked here.
const KEY_RULES = Object.freeze({
  repo: isPath, installationRoot: isPath, codexBin: isPath,
  mode: value => MODES.includes(value),
  env: value => isPlainObject(value) && Object.values(value).every(item => typeof item === 'string'),
  timeoutMs: value => Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS,
  task: isText,
  base: isText,
  approval: value => APPROVALS.includes(value),
  maxFixRounds: value => Number.isSafeInteger(value) && value > 0,
  knownStuckSigs: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  requiredCriteria: value => Array.isArray(value) && value.every(isCriterion),
  invocationId: value => typeof value === 'string' && INVOCATION_ID.test(value),
})

// A regular file of at most MAX_ARGS_BYTES, opened non-blocking so a FIFO cannot hang.
function readArgsFile(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_ARGS_BYTES) throw new Error('not a small regular file')
    const buffer = Buffer.alloc(MAX_ARGS_BYTES + 1)
    let length = 0
    for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
    if (length > MAX_ARGS_BYTES) throw new Error('too large')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// argv is exactly `run --args-file <absolute path>`. Returns the checked args.
function parseInput(argv) {
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--args-file' || !isPath(argv[2])) throw refuse('INVALID_ARGS', 1)
  let args
  try { args = readArgsFile(argv[2]) } catch { throw refuse('INVALID_ARGS', 1) }
  const allowed = [...REQUIRED_KEYS, ...OPTIONAL_KEYS]
  if (!isPlainObject(args) || !Object.keys(args).every(key => allowed.includes(key))) throw refuse('INVALID_ARGS', 1)
  if (!REQUIRED_KEYS.every(key => Object.hasOwn(args, key))) throw refuse('INVALID_ARGS', 1)
  for (const key of Object.keys(args)) if (!KEY_RULES[key](args[key])) throw refuse('INVALID_ARGS', 1)
  // A new task needs its text and who approves the plan; the other modes run a saved plan.
  if (args.mode === 'new' && !(Object.hasOwn(args, 'task') && Object.hasOwn(args, 'approval'))) throw refuse('INVALID_ARGS', 1)
  if (args.mode !== 'new' && (Object.hasOwn(args, 'task') || Object.hasOwn(args, 'approval'))) throw refuse('INVALID_ARGS', 1)
  return args
}

// ---------------------------------------------------------------- repo and state

const git = (repo, ...argv) => spawnSync('git', ['-C', repo, ...argv], {
  encoding: 'utf8', shell: false, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
const chompOne = text => (text.endsWith('\n') ? text.slice(0, -1) : text)

// Git's top level must be exactly this directory. Returns { top, stateDir }, the state
// directory being `git rev-parse --path-format=absolute --git-path harness-dev` (SKILL.md 1.4).
function locate(repo) {
  const top = git(repo, 'rev-parse', '--show-toplevel')
  let real
  try { real = realpathSync(repo) } catch { throw refuse('NOT_A_REPO', 2) }
  if (top.error || top.status !== 0 || chompOne(top.stdout) !== real) throw refuse('NOT_A_REPO', 2)
  const state = git(real, 'rev-parse', '--path-format=absolute', '--git-path', STATE_GIT_PATH)
  const stateDir = state.error || state.status !== 0 ? '' : chompOne(state.stdout)
  if (!isPath(stateDir)) throw refuse('NOT_A_REPO', 2)
  return { top: real, stateDir }
}

function ensureDirectory(path) {
  try {
    if (mkdirSync(path, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(path, 0o700)
  } catch { throw refuse('IO_ERROR', 3) }
}

// Temp file in the same directory, then rename: a reader sees the old file or the whole new one.
function writeFileAtomic(path, text, mode) {
  const temp = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(temp, text, { mode, flag: 'wx' })
    renameSync(temp, path)
  } catch {
    try { unlinkSync(temp) } catch { /* nothing to clean */ }
    throw refuse('IO_ERROR', 3)
  }
}
const prettyJson = value => JSON.stringify(value, null, 2) + '\n'

// A saved JSON file: absent is `missingCode`, unreadable or not a JSON object is the same.
function readSaved(stateDir, name, missingCode) {
  let value
  try { value = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) } catch { throw refuse(missingCode, 2) }
  if (!isPlainObject(value)) throw refuse(missingCode, 2)
  return value
}

// ---------------------------------------------------------------- the workflow args

// The keys the Claude path passes (SKILL.md 2), only when the caller set them.
function workflowArgs(args, top, stateDir) {
  const tail = {
    maxFixRounds: args.maxFixRounds ?? DEFAULT_FIX_ROUNDS,
    knownStuckSigs: args.knownStuckSigs ?? [],
    ...(args.requiredCriteria === undefined ? {} : { requiredCriteria: args.requiredCriteria }),
  }
  const base = args.base === undefined ? {} : { base: args.base }
  if (args.mode === 'new') return { repo: top, task: args.task.trim(), ...base, approval: args.approval, ...tail }
  const plan = readSaved(stateDir, 'plan.json', 'NO_SAVED_PLAN')
  if (args.mode === 'plan') return { repo: top, ...base, plan, planApproved: true, ...tail }
  const ledger = readSaved(stateDir, 'ledger.json', 'NO_SAVED_LEDGER')
  const completed = Array.isArray(ledger.completed) ? ledger.completed.filter(id => typeof id === 'string') : []
  return { repo: top, ...base, plan, planApproved: true, completed, ...tail }
}

// SKILL.md 2: a new task saves its text and deletes any earlier plan, so `--resume`
// never builds a plan this task did not approve.
function saveNewTask(stateDir, task) {
  writeFileAtomic(join(stateDir, 'task.txt'), task.trim() + '\n', 0o600)
  try { unlinkSync(join(stateDir, 'plan.json')) } catch (e) { if (e?.code !== 'ENOENT') throw refuse('IO_ERROR', 3) }
}

// ---------------------------------------------------------------- the host

const hostPath = () => resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../../../core/skills/native-runtime/graph-host.mjs')

const mintInvocationId = () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `dev-${stamp}-${randomBytes(4).toString('hex')}`
}

// The host's own error line: `{"error": CODE}`, or null.
function hostErrorCode(stderr) {
  try {
    const parsed = JSON.parse(stderr.trim())
    return isPlainObject(parsed) && typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.error) ? parsed.error : null
  } catch { return null }
}

// Runs the host CLI to its end. SIGINT and SIGTERM go on to it, so its leaves stop cleanly.
function runHost(file) {
  return new Promise(done => {
    const child = spawn(process.execPath, [hostPath(), '--args-file', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const forward = signal => () => child.kill(signal)
    const onInt = forward('SIGINT'), onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    const finish = result => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); done(result) }
    child.on('error', () => finish({ status: null, stderr }))
    child.on('close', status => finish({ status, stderr }))
  })
}

// An invocation to start, or a held one to drive again (same run directory, so the
// store replays finished leaves with zero spawns; a held leaf needs graph-reconcile first).
function chooseInvocation(args, stateDir) {
  const runsDir = join(stateDir, 'native-runs')
  if (args.invocationId === undefined) {
    ensureDirectory(stateDir)
    ensureDirectory(runsDir)
    const invocationId = mintInvocationId()
    return { invocationId, runsDir, runDir: join(runsDir, invocationId) }
  }
  const runDir = join(runsDir, args.invocationId)
  let isDir = false
  try { isDir = lstatSync(runDir).isDirectory() } catch { /* absent */ }
  if (!isDir) throw refuse('NOT_FOUND', 2)
  return { invocationId: args.invocationId, runsDir, runDir }
}

function hostArgs(args, top, invocation, workflow) {
  return { schemaVersion: 1, installationRoot: args.installationRoot, workflowId: 'dev-build', offeringId: 'dev',
    invocationId: invocation.invocationId, args: workflow, runDir: invocation.runDir, codexBin: args.codexBin,
    cwd: top, env: args.env, timeoutMs: args.timeoutMs, maxConcurrentSubagents: 1 }
}

// The host's result.json for this invocation; its `result` is the workflow's ledger.
function readLedger(invocation) {
  let record
  try { record = JSON.parse(readFileSync(join(invocation.runDir, 'result.json'), 'utf8')) } catch { throw refuse('INVALID_RESULT', 3) }
  const ledger = record?.result
  if (!isPlainObject(record) || record.workflowId !== 'dev-build' || record.invocationId !== invocation.invocationId ||
    !isPlainObject(ledger) || typeof ledger.status !== 'string') throw refuse('INVALID_RESULT', 3)
  return ledger
}

// SKILL.md 2 and 3: the ledger is always saved; the plan is saved when it is approved
// (so --resume works) or waiting for approval. A plan that escalated while being made
// is never saved as resumable.
function saveResult(stateDir, ledger) {
  writeFileAtomic(join(stateDir, 'ledger.json'), prettyJson(ledger), 0o600)
  const savable = isPlainObject(ledger.plan) && (ledger.planApproved === true || ledger.status === 'plan-ready')
  if (savable) writeFileAtomic(join(stateDir, 'plan.json'), prettyJson(ledger.plan), 0o600)
}

async function run(args) {
  const { top, stateDir } = locate(args.repo)
  // Every refusal (a missing saved plan, an unknown invocation) comes before anything is created.
  const workflow = workflowArgs(args, top, stateDir)
  const invocation = chooseInvocation(args, stateDir)
  if (args.mode === 'new') saveNewTask(stateDir, args.task)
  const file = join(invocation.runsDir, `${invocation.invocationId}.host-args.json`)
  // It holds the leaf environment the caller chose: 0600 in a 0700 directory, never printed.
  writeFileAtomic(file, JSON.stringify(hostArgs(args, top, invocation, workflow)), 0o600)
  const host = await runHost(file)
  if (host.status !== 0) {
    const code = host.status === null ? null : hostErrorCode(host.stderr)
    const exitCode = code !== null && [1, 2, 3, 4].includes(host.status) ? host.status : 3
    throw refuse(code ?? 'HOST_FAILED', exitCode, { invocationId: invocation.invocationId })
  }
  const ledger = readLedger(invocation)
  saveResult(stateDir, ledger)
  return { status: ledger.status, invocationId: invocation.invocationId, stateDir }
}

// ---------------------------------------------------------------- CLI

async function main(argv, out = process.stdout, err = process.stderr) {
  try {
    const report = await run(parseInput(argv))
    out.write(JSON.stringify(report) + '\n')
    return 0
  } catch (e) {
    const refusal = e instanceof Refusal ? e : refuse('IO_ERROR', 3)
    err.write(JSON.stringify({ error: refusal.code, ...refusal.extra }) + '\n')
    return refusal.exitCode
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// process.exitCode, not process.exit(): stdout to a pipe may still be flushing.
if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2))
