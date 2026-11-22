#!/usr/bin/env node
// Held-call reconcile CLI (spec/contracts/codex-parity-cp-05b.md), the operator's
// half of CP-05a's checkpoint store API:
//   node graph-reconcile.mjs list   --run-dir <abs>
//   node graph-reconcile.mjs fail   --run-dir <abs> --call-id <id> --confirm <id>
//   node graph-reconcile.mjs unlock --run-dir <abs> --token <token>
// W2-1: `fail` only, plus an explicit `unlock`. It never spawns a process, calls a
// provider, writes a `returned` completion, deletes or renames a row (only `.lock`,
// through CP-05a), creates a directory, acts while `.lock` is held or without the
// confirm token, or prints prompt or completion text. It exports nothing; importing
// it runs nothing.
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { breakCheckpointLock, checkpointDirOf, failHeldCheckpoint, inspectCheckpoints } from './checkpoint-store.mjs'
import { failedCompletion } from './completion.mjs'
import { fail, ownErrorCode } from './boundary.mjs'

const INPUT = 'INVALID_RECONCILE_INPUT'
const OPERATOR_CODE = 'OPERATOR_ABANDONED'
const CALL_ID = /^nr-[0-9a-f]{64}$/
const TOKEN = /^[0-9a-f]{16}$/
// The CP-02e path rule, restated: graph-host.mjs is outside this CLI's import closure.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const MAX_PATH_BYTES = 4096

// Verb -> its flags, each required exactly once. A Map, so no inherited name is a verb.
const VERBS = new Map([
  ['list', ['--run-dir']],
  ['fail', ['--run-dir', '--call-id', '--confirm']],
  ['unlock', ['--run-dir', '--token']],
])

// Printed code -> exit code (the CP-02e host numbering). Any other thrown value is
// exit 3 IO_ERROR. The store's INVALID_RUNTIME_INPUT is unreachable after the argv
// checks; if it ever escapes, it is the usage error.
const EXIT = new Map([
  [INPUT, 1],
  ['NOT_FOUND', 2], ['CORRUPT', 2], ['NOT_HELD', 2], ['SELECTION_MISSING', 2],
  ['CONFIRM_MISMATCH', 2], ['OWNER_UNKNOWN', 2], ['OWNER_ALIVE', 2],
  ['IO_ERROR', 3],
  ['OWNER_BUSY', 4],
])

function errorCodeOf(thrown) {
  const code = ownErrorCode(thrown)
  if (code === 'INVALID_RUNTIME_INPUT') return INPUT
  return typeof code === 'string' && EXIT.has(code) ? code : 'IO_ERROR'
}

const absolutePath = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES && !CONTROL.test(value) && isAbsolute(value)

// Each flag's value rule. --confirm takes any value: `fail` compares it to --call-id.
const VALUE_RULES = new Map([
  ['--run-dir', absolutePath],
  ['--call-id', value => CALL_ID.test(value)],
  ['--confirm', () => true],
  ['--token', value => TOKEN.test(value)],
])

// argv -> {verb, values: Map<flag, value>}, or INVALID_RECONCILE_INPUT. Pure: it
// runs before any filesystem access. Flags sit at odd positions; each value is
// the next argument, even when it looks like a flag.
function parseArgv(argv) {
  const flags = VERBS.get(argv[0])
  if (flags === undefined || argv.length !== 1 + 2 * flags.length) fail(INPUT)
  const values = new Map()
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1]
    if (!flags.includes(flag) || values.has(flag) || !VALUE_RULES.get(flag)(value)) fail(INPUT)
    values.set(flag, value)
  }
  return { verb: argv[0], values }
}

async function listVerb(values) {
  return inspectCheckpoints({ dir: checkpointDirOf(values.get('--run-dir')) })
}

// The read-only preview (steps 3-5): names the refusal and supplies the selection.
// The write in failVerb re-checks the row under the store's lock.
async function heldSelection(dir, callId) {
  const report = await inspectCheckpoints({ dir })
  if (report.lock !== null) fail('OWNER_BUSY') // whatever its owner, before any row check
  const row = report.rows.find(candidate => candidate.callId === callId)
  if (row === undefined) fail('NOT_FOUND')
  if (row.state === 'corrupt') fail('CORRUPT')
  if (row.state !== 'prepared' && row.state !== 'uncertain') fail('NOT_HELD')
  if (row.selection === null) fail('SELECTION_MISSING')
  return row.selection
}

// A stored selection failedCompletion refuses (a blank provider, model or effort)
// cannot get a conformant failed completion either: SELECTION_MISSING, never stored.
function operatorCompletion(selection, callId) {
  try {
    return failedCompletion({ selection, code: OPERATOR_CODE, invocationId: 'reconcile:' + callId })
  } catch { fail('SELECTION_MISSING') }
}

async function failVerb(values) {
  const callId = values.get('--call-id')
  if (values.get('--confirm') !== callId) fail('CONFIRM_MISMATCH')
  const dir = checkpointDirOf(values.get('--run-dir'))
  const selection = await heldSelection(dir, callId)
  const completion = operatorCompletion(selection, callId)
  await failHeldCheckpoint({ dir, callId, completion }) // the only write, under the lock
  return { callId, state: 'failed', code: OPERATOR_CODE }
}

async function unlockVerb(values) {
  await breakCheckpointLock({ dir: checkpointDirOf(values.get('--run-dir')), token: values.get('--token') })
  return { unlocked: true }
}

const VERB_RUNNERS = new Map([['list', listVerb], ['fail', failVerb], ['unlock', unlockVerb]])

// One line on stdout (exit 0) or one `{error}` line on stderr (exits 1-4); never a
// message, path, call id, token, pid, binding or completion.
async function reconcileMain(argv, out = process.stdout, err = process.stderr) {
  let value
  try {
    const { verb, values } = parseArgv(argv)
    value = await VERB_RUNNERS.get(verb)(values)
  } catch (thrown) {
    const code = errorCodeOf(thrown)
    err.write(JSON.stringify({ error: code }) + '\n')
    return EXIT.get(code)
  }
  out.write(JSON.stringify(value) + '\n')
  return 0
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// Only process.exitCode is set; the event loop drains, so a piped stdout flushes.
if (isEntryPoint()) process.exitCode = await reconcileMain(process.argv.slice(2))
