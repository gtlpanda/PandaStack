// Shared Codex `exec` launcher (spec/contracts/codex-parity-cp-02a.md): how a
// child is built, run in its own process group, and classified. Callers own the
// environment, the prompt, the role-to-sandbox mapping and any retry decision.
import { spawn } from 'node:child_process'
import { closeSync, fchmodSync, openSync } from 'node:fs'
import { readCodexResult } from '../../../graphs/autobuild/tool/lib/codex.mjs'
import { classifyOutcome } from '../../../graphs/autobuild/tool/lib/limits.mjs'
import { codexConcurrencyArgs } from '../../../scripts/agent-config.mjs'
import { fail, fields, record } from './boundary.mjs'

const INPUT = 'INVALID_CODEX_EXEC_INPUT'
const SANDBOXES = ['read-only', 'workspace-write']
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const EFFORT = /^[a-z]+$/
const TIMEOUT_EXIT = 124
const ABORT_EXIT = 130
const SPAWN_FAILED_EXIT = 127
const DEFAULT_GRACE_MS = 5000
const MESSAGE_MAX = 300

export const CODEX_EXEC_CODES = Object.freeze(Object.fromEntries(['PROVIDER_REFUSAL', 'USAGE_LIMIT', 'AUTH', 'BILLING',
  'TURN_FAILED', 'EXIT_NONZERO', 'TIMEOUT', 'NO_OUTPUT', 'SUCCESS'].map(code => [code, code])))
const NOT_RETRYABLE = new Set([CODEX_EXEC_CODES.PROVIDER_REFUSAL, CODEX_EXEC_CODES.BILLING, CODEX_EXEC_CODES.SUCCESS])
const LIMIT_CODES = { billing: CODEX_EXEC_CODES.BILLING, auth: CODEX_EXEC_CODES.AUTH, usage_limit: CODEX_EXEC_CODES.USAGE_LIMIT }

// NUL can never reach spawn, so a string holding one is rejected as input.
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0
const check = ok => { if (!ok) fail(INPUT) }
// `fields` detaches a plain object and rejects proxies, getters and other prototypes.
const options = value => fields(value, INPUT)
const optional = (value, ok) => value === undefined || ok(value)

/** The argv for `codex exec`, prompt on stdin. `--ignore-user-config` has no off switch. */
export function codexExecArgs(input) {
  const o = options(input)
  check(SANDBOXES.includes(o.sandbox) && matches(o.model, MODEL) && matches(o.reasoningEffort, EFFORT))
  check(optional(o.subagentModel, value => matches(value, MODEL)))
  check(optional(o.maxConcurrentSubagents, positiveInteger))
  check(optional(o.skipGitRepoCheck, value => typeof value === 'boolean'))
  check(optional(o.outputFile, text) && optional(o.schemaFile, text))
  // Network access is a workspace-write setting only; it is never a way to widen read-only.
  check(optional(o.networkAccess, value => typeof value === 'boolean'))
  check(o.networkAccess !== true || o.sandbox === 'workspace-write')
  const args = ['exec', '--json', '--color', 'never', '--sandbox', o.sandbox, '--ignore-user-config']
  if (o.skipGitRepoCheck === true) args.push('--skip-git-repo-check')
  args.push('-c', 'approval_policy="never"', '--model', o.model,
    '-c', `model_reasoning_effort=${JSON.stringify(o.reasoningEffort)}`)
  if (o.networkAccess === true) args.push('-c', 'sandbox_workspace_write.network_access=true')
  if (o.subagentModel !== undefined) args.push('-c', `agents.default_subagent_model=${JSON.stringify(o.subagentModel)}`)
  if (o.maxConcurrentSubagents !== undefined) args.push(...codexConcurrencyArgs(o.maxConcurrentSubagents))
  if (o.outputFile !== undefined) args.push('--output-last-message', o.outputFile)
  if (o.schemaFile !== undefined) args.push('--output-schema', o.schemaFile)
  args.push('-')
  return args
}

function runOptions(bin, args, input) {
  check(text(bin) && Array.isArray(args) && args.every(arg => typeof arg === 'string' && !arg.includes('\0')))
  const o = options(input)
  check(text(o.cwd) && text(o.logFile))
  check(optional(o.input, value => typeof value === 'string'))
  check(positiveInteger(o.timeoutMs) && optional(o.graceMs, nonNegativeInteger))
  check(optional(o.signal, value => value instanceof AbortSignal))
  const env = { ...options(o.env) }
  // A nested CLI must not attach itself to its parent's thread.
  delete env.CODEX_THREAD_ID
  return { cwd: o.cwd, env, input: o.input ?? '', logFile: o.logFile, timeoutMs: o.timeoutMs,
    graceMs: o.graceMs ?? DEFAULT_GRACE_MS, signal: o.signal }
}

// Private log files: the mode is forced even when the file already existed.
function openPrivateLog(file) {
  const fd = openSync(file, 'w', 0o600)
  try { fchmodSync(fd, 0o600) } catch (error) { closeSync(fd); throw error }
  return fd
}

// setTimeout fires at once above 2^31-1 ms, so a longer wait is armed in steps.
// Returns the function that cancels it.
const TIMER_MAX_MS = 2 ** 31 - 1
function startTimer(ms, onDone) {
  let timer
  const arm = remaining => {
    timer = setTimeout(() => remaining > TIMER_MAX_MS ? arm(remaining - TIMER_MAX_MS) : onDone(), Math.min(remaining, TIMER_MAX_MS))
  }
  arm(ms)
  return () => clearTimeout(timer)
}

// Signal the whole group. ESRCH (group gone) and EPERM (id no longer ours) leave
// nothing to do; throwing here would escape from a timer as an uncaught error.
function signalGroup(child, signal) {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error }
}

/**
 * Run `bin args` in its own process group and resolve to an exit code: the child's
 * code, 1 when it ended on a signal, 124 on timeout, 130 on abort, 127 when it
 * could not start. Invalid input rejects before any file or process exists.
 */
export async function runCodexExec(bin, args, input) {
  const o = runOptions(bin, args, input)
  if (o.signal?.aborted) return ABORT_EXIT
  const out = openPrivateLog(o.logFile)
  let err
  try {
    err = openPrivateLog(`${o.logFile}.stderr`)
    return await new Promise(resolveExit => superviseChild(bin, args, o, [out, err], resolveExit))
  } finally {
    closeSync(out)
    if (err !== undefined) closeSync(err)
  }
}

function superviseChild(bin, args, o, [out, err], resolveExit) {
  let child, reason = null, settled = false, cancelForce = () => {}
  const finish = code => {
    if (settled) return
    settled = true
    cancelDeadline()
    cancelForce()
    o.signal?.removeEventListener('abort', onAbort)
    // A descendant that stayed in the group must not outlive the run.
    signalGroup(child, 'SIGKILL')
    resolveExit(reason ?? code)
  }
  // The first reason wins; SIGKILL follows SIGTERM after the grace period.
  const stop = code => {
    if (reason !== null || settled) return
    reason = code
    signalGroup(child, 'SIGTERM')
    cancelForce = startTimer(o.graceMs, () => signalGroup(child, 'SIGKILL'))
  }
  const onAbort = () => stop(ABORT_EXIT)
  const cancelDeadline = startTimer(o.timeoutMs, () => stop(TIMEOUT_EXIT))
  try {
    child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', out, err] })
  } catch {
    finish(SPAWN_FAILED_EXIT)
    return
  }
  o.signal?.addEventListener('abort', onAbort, { once: true })
  child.once('error', () => finish(SPAWN_FAILED_EXIT))
  child.once('close', code => finish(code ?? 1))
  // A child that exits before reading its prompt closes stdin early (EPIPE).
  child.stdin.on('error', () => {})
  child.stdin.end(o.input)
}

// Provider text is bounded and kept on one line so it cannot forge log lines.
const oneLine = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, MESSAGE_MAX)

function classifyResult(exitCode, result) {
  if (result?.providerRefusal) return { code: CODEX_EXEC_CODES.PROVIDER_REFUSAL, message: result.result }
  if (exitCode === TIMEOUT_EXIT) return { code: CODEX_EXEC_CODES.TIMEOUT, message: 'Codex exec timed out.' }
  if (result?.is_error) {
    const outcome = classifyOutcome({ result })
    const limit = Object.hasOwn(LIMIT_CODES, outcome.kind) ? LIMIT_CODES[outcome.kind] : null
    if (limit) return { code: limit, message: oneLine(outcome.message) }
    return { code: CODEX_EXEC_CODES.TURN_FAILED, message: oneLine(result.result) }
  }
  if (exitCode !== 0) return { code: CODEX_EXEC_CODES.EXIT_NONZERO, message: `Codex exec exited ${exitCode}.` }
  if (!record(result)) return { code: CODEX_EXEC_CODES.NO_OUTPUT, message: 'Codex exec produced no protocol result.' }
  return { code: CODEX_EXEC_CODES.SUCCESS, message: '' }
}

/** Classify a finished run from its exit code and protocol log only. Read errors propagate. */
export function classifyCodexExec(input) {
  const o = options(input)
  check(Number.isInteger(o.exitCode) && text(o.logFile))
  const result = readCodexResult(o.logFile)
  const { code, message } = classifyResult(o.exitCode, result)
  return { code, ok: code === CODEX_EXEC_CODES.SUCCESS, retryable: !NOT_RETRYABLE.has(code), exitCode: o.exitCode,
    message: message.slice(0, MESSAGE_MAX), result }
}
