// Codex leaf provider on the NR-01 wire (spec/contracts/codex-parity-cp-02b.md).
// One runLeaf call runs one `codex exec` child through the CP-02a launcher and
// resolves one NR-02 completion envelope. A malformed request rejects before any
// file or process exists; once valid, every outcome resolves to an envelope.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CODEX_EXEC_CODES, classifyCodexExec, codexExecArgs, runCodexExec } from './codex-exec.mjs'
import { PROFILES } from './runtime.mjs'
import { encodeOutputContract } from './schema.mjs'
import { canonical, exact, fail, fields, record } from './boundary.mjs'

const INPUT = 'INVALID_RUNTIME_INPUT'
const MIB = 1048576
const DEFAULT_GRACE_MS = 500
// Time left after SIGKILL for the child to exit and the envelope to settle
// before the runtime's own deadline. Fixed by the contract; not an option.
const SETTLE_MARGIN_MS = 500
const CALL_ID = /^nr-[0-9a-f]{64}$/
const FACTORY_KEYS = ['codexBin', 'cwd', 'env', 'runDir', 'graceMs', 'skipGitRepoCheck', 'nowMs']
const REQUEST_KEYS = ['callId', 'workflowId', 'workflowPath', 'agentType', 'label', 'phase', 'requestedModel',
  'requestedEffort', 'invocationId', 'prompt', 'selection', 'profile', 'schema', 'wireSchema', 'deadlineMs', 'signal']
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
const SANDBOXES = Object.freeze(Object.assign(Object.create(null), {
  'source-review': 'read-only', 'build-workspace': 'workspace-write', 'audit-source-only': null, 'release-controlled': null,
}))
// The NR-01 wire schema is the same for every leaf schema; any valid one yields it.
const WIRE_SCHEMA = canonical(encodeOutputContract({ type: 'object' }).wireSchema)
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const CODEX_PROVIDER = 'codex'

export const CODEX_PROVIDER_CODES = Object.freeze(Object.fromEntries([
  ...Object.values(CODEX_EXEC_CODES).filter(code => code !== CODEX_EXEC_CODES.SUCCESS),
  'INVALID_WIRE', 'PROFILE_UNSUPPORTED', 'IO_ERROR',
].map(code => [code, code])))
const CODES = CODEX_PROVIDER_CODES

const check = ok => { if (!ok) fail(INPUT) }
const optional = (value, ok) => value === undefined || ok(value)
const noNul = value => typeof value === 'string' && !value.includes('\0')
const absolutePath = value => noNul(value) && isAbsolute(value)
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0
// A real AbortSignal: the brand check rejects an object that only inherits its prototype.
function isAbortSignal(value) {
  if (!(value instanceof AbortSignal)) return false
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(value); return true } catch { return false }
}

/** The Codex sandbox for a runtime profile, or null when Codex cannot honor it. */
export function sandboxForProfile(profile) {
  check(PROFILES.has(profile))
  return SANDBOXES[profile]
}

/** A frozen `{runLeaf}` for createNativeRuntime. Touches no file and starts no process. */
export function createCodexProvider(options) {
  const config = providerConfig(options)
  const runLeaf = async request => runValidLeaf(config, leafRequest(config, request))
  return Object.freeze({ runLeaf })
}

function providerConfig(options) {
  const o = fields(options)
  check(Object.keys(o).every(key => FACTORY_KEYS.includes(key)))
  check(absolutePath(o.codexBin) && absolutePath(o.cwd) && absolutePath(o.runDir))
  const env = fields(o.env)
  check(Object.entries(env).every(([key, value]) => noNul(key) && noNul(value)))
  check(optional(o.graceMs, nonNegativeInteger))
  check(optional(o.skipGitRepoCheck, value => typeof value === 'boolean'))
  check(optional(o.nowMs, value => typeof value === 'function'))
  return Object.freeze({ codexBin: o.codexBin, cwd: o.cwd, runDir: o.runDir, env: Object.freeze({ ...env }),
    graceMs: o.graceMs ?? DEFAULT_GRACE_MS, skipGitRepoCheck: o.skipGitRepoCheck ?? false, nowMs: o.nowMs ?? Date.now })
}

// Validates the runtime's request and reads the clock. Every rejection here is a
// caller contract violation and happens before any file or process exists.
function leafRequest(config, request) {
  const r = fields(request)
  exact(r, REQUEST_KEYS, INPUT)
  check(typeof r.callId === 'string' && CALL_ID.test(r.callId))
  check(typeof r.prompt === 'string' && Buffer.byteLength(r.prompt, 'utf8') <= MIB)
  const selection = fields(r.selection)
  exact(selection, ['provider', 'model', 'effort'], INPUT)
  check(selection.provider === CODEX_PROVIDER)
  // codexExecArgs owns the model and effort rules; any supported sandbox probes them.
  try { codexExecArgs({ sandbox: 'read-only', model: selection.model, reasoningEffort: selection.effort }) } catch { fail(INPUT) }
  check(PROFILES.has(r.profile))
  // Compare the exact bytes that will be written, so the file is what was checked.
  let wireBytes
  try { wireBytes = JSON.stringify(r.wireSchema); check(canonical(JSON.parse(wireBytes)) === WIRE_SCHEMA) } catch { fail(INPUT) }
  check(typeof r.deadlineMs === 'number' && Number.isFinite(r.deadlineMs))
  check(isAbortSignal(r.signal))
  const { nowMs } = config
  let now
  try { now = nowMs() } catch { fail(INPUT) }
  check(typeof now === 'number' && Number.isFinite(now))
  return { callId: r.callId, prompt: r.prompt, profile: r.profile, wireBytes,
    signal: r.signal, timeoutMs: Math.floor(r.deadlineMs - now - config.graceMs - SETTLE_MARGIN_MS),
    receipt: { provider: selection.provider, model: selection.model, effort: selection.effort, invocationId: r.callId } }
}

async function runValidLeaf(config, leaf) {
  const failed = (code, usage = null) => ({ outcome: 'failed', code, usage, receipt: { ...leaf.receipt } })
  const sandbox = sandboxForProfile(leaf.profile)
  if (sandbox === null) return failed(CODES.PROFILE_UNSUPPORTED)
  if (leaf.timeoutMs < 1) return failed(CODES.TIMEOUT)
  const files = { schemaFile: join(config.runDir, `${leaf.callId}.schema.json`),
    outputFile: join(config.runDir, `${leaf.callId}.output.json`), logFile: join(config.runDir, `${leaf.callId}.log.jsonl`) }
  // From here every filesystem or process error is an envelope, never a rejection.
  let usage = null
  try {
    prepareRunDir(config.runDir, files, leaf.wireBytes)
    // runCodexExec returns 130 for an already-aborted signal without truncating
    // the log, so a log left by an earlier attempt must not be classified.
    if (leaf.signal.aborted) return failed(CODES.EXIT_NONZERO)
    const args = codexExecArgs({ sandbox, model: leaf.receipt.model, reasoningEffort: leaf.receipt.effort,
      skipGitRepoCheck: config.skipGitRepoCheck, schemaFile: files.schemaFile, outputFile: files.outputFile })
    const exitCode = await runCodexExec(config.codexBin, args, { cwd: config.cwd, env: config.env, input: leaf.prompt,
      logFile: files.logFile, timeoutMs: Math.min(leaf.timeoutMs, Number.MAX_SAFE_INTEGER), graceMs: config.graceMs,
      signal: leaf.signal })
    const classified = classifyCodexExec({ exitCode, logFile: files.logFile })
    usage = usageOf(classified.result)
    if (!classified.ok) return failed(classified.code, usage)
    const read = readWire(files.outputFile)
    if (read.code) return failed(read.code, usage)
    const envelope = { outcome: 'returned', wire: { json: read.json }, usage, receipt: { ...leaf.receipt } }
    // The runtime bounds the whole completion; never return one it would reject.
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MIB) return failed(CODES.INVALID_WIRE, usage)
    return envelope
  } catch {
    return failed(CODES.IO_ERROR, usage)
  }
}

// Creates the run directory, writes a fresh private schema file and removes any
// stale output so it can never be read as this run's. A symlink at either name is
// removed, never followed.
function prepareRunDir(runDir, files, wireBytes) {
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  removeIfPresent(files.schemaFile)
  const fd = openSync(files.schemaFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    fchmodSync(fd, 0o600)
    const bytes = Buffer.from(wireBytes, 'utf8')
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at)
  } finally { closeSync(fd) }
  removeIfPresent(files.outputFile)
}

function removeIfPresent(file) {
  try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

// Reads the --output-last-message file as an NR-01 wire object. Returns {json} or
// {code}. Filesystem errors other than the classified ones propagate (IO_ERROR).
function readWire(file) {
  let stat
  try { stat = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return { code: CODES.NO_OUTPUT }; throw error }
  const sized = s => !s.isFile() || s.size > MIB ? { code: CODES.INVALID_WIRE } : s.size === 0 ? { code: CODES.NO_OUTPUT } : null
  const refused = sized(stat)
  if (refused) return refused
  let fd
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    if (error.code === 'ENOENT') return { code: CODES.NO_OUTPUT }
    if (error.code === 'ELOOP') return { code: CODES.INVALID_WIRE }
    throw error
  }
  try {
    // The name may have been replaced between lstat and open: check what was opened.
    const opened = sized(fstatSync(fd))
    if (opened) return opened
    fchmodSync(fd, 0o600)
    return parseWire(readBounded(fd))
  } finally { closeSync(fd) }
}

// Reads at most MIB + 1 bytes, so a file that grew past the limit is still refused.
function readBounded(fd) {
  const buffer = Buffer.alloc(MIB + 1)
  let length = 0
  for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
  return length > MIB ? null : buffer.subarray(0, length)
}

// Exactly {"json": <string>}. A bare result is never wrapped and extra keys are
// never stripped; the inner string is the runtime's to decode.
function parseWire(bytes) {
  if (bytes === null) return { code: CODES.INVALID_WIRE }
  let wire
  try { wire = JSON.parse(UTF8.decode(bytes)) } catch { return { code: CODES.INVALID_WIRE } }
  if (!record(wire) || Object.keys(wire).length !== 1 || !Object.hasOwn(wire, 'json') || typeof wire.json !== 'string') {
    return { code: CODES.INVALID_WIRE }
  }
  return { json: wire.json }
}

// Only Codex token counters, each a non-negative safe integer. Never a cost field.
function usageOf(result) {
  const reported = record(result) ? result.usage : null
  if (!record(reported)) return null
  const usage = {}
  for (const key of USAGE_KEYS) {
    const value = Object.hasOwn(reported, key) ? reported[key] : undefined
    if (Number.isSafeInteger(value) && value >= 0) usage[key] = value
  }
  return Object.keys(usage).length ? usage : null
}
