// Codex leaf provider on the NR-01 wire (spec/contracts/codex-parity-cp-02b.md,
// amended by codex-parity-cp-02h.md). One runLeaf call runs one `codex exec` child
// through the CP-02a launcher and resolves one NR-02 completion envelope. Codex is
// handed the leaf's strict schema and writes one bare object, which the provider
// wraps as the wire {json}. A malformed request rejects before any file or process
// exists; once valid, every outcome resolves to an envelope.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CODEX_EXEC_CODES, classifyCodexExec, codexExecArgs, runCodexExec } from './codex-exec.mjs'
import { PROFILES } from './runtime.mjs'
import { copyJSON, encodeOutputContract, strictOutputSchema } from './schema.mjs'
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
  'source-review': 'read-only', 'build-workspace': 'workspace-write', 'audit-source-only': null,
  // CP-08: workspace-write plus network access (NETWORK_PROFILES), never danger-full-access.
  'release-controlled': 'workspace-write',
}))
// The only profile that may reach the network: release leaves run `gh` against GitHub.
const NETWORK_PROFILES = Object.freeze(['release-controlled'])
// The NR-01 wire schema is the same for every leaf schema; any valid one yields it.
const WIRE_SCHEMA = canonical(encodeOutputContract({ type: 'object' }).wireSchema)
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const CODEX_PROVIDER = 'codex'

export const CODEX_PROVIDER_CODES = Object.freeze(Object.fromEntries([
  ...Object.values(CODEX_EXEC_CODES).filter(code => code !== CODEX_EXEC_CODES.SUCCESS),
  'INVALID_WIRE', 'PROFILE_UNSUPPORTED', 'IO_ERROR', 'SCHEMA_UNSUPPORTED',
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

/**
 * A frozen `{runLeaf}` for createNativeRuntime. Touches no file and starts no process.
 *
 * `launchers` is for a host that owns a profile this provider cannot launch by itself. Its only key is
 * `audit-source-only`: an async function `({callId, model, effort, files, signal}) => {args, env, cwd, release?}`
 * (or `{code}` to fail the leaf), which supplies the argv, the environment and the working directory of a
 * source-only leaf (codex-source-only.mjs) and any resource that leaf holds. Without it, that profile stays
 * PROFILE_UNSUPPORTED with zero spawns, exactly as before.
 */
export function createCodexProvider(options, launchers) {
  const config = providerConfig(options, launchers)
  const runLeaf = async request => runValidLeaf(config, leafRequest(config, request))
  return Object.freeze({ runLeaf })
}

function providerConfig(options, launchers) {
  const o = fields(options)
  const extra = launchers === undefined ? {} : fields(launchers)
  check(Object.keys(extra).every(key => key === 'audit-source-only' && typeof extra[key] === 'function'))
  check(Object.keys(o).every(key => FACTORY_KEYS.includes(key)))
  check(absolutePath(o.codexBin) && absolutePath(o.cwd) && absolutePath(o.runDir))
  const env = fields(o.env)
  check(Object.entries(env).every(([key, value]) => noNul(key) && noNul(value)))
  check(optional(o.graceMs, nonNegativeInteger))
  check(optional(o.skipGitRepoCheck, value => typeof value === 'boolean'))
  check(optional(o.nowMs, value => typeof value === 'function'))
  return Object.freeze({ codexBin: o.codexBin, cwd: o.cwd, runDir: o.runDir, env: Object.freeze({ ...env }),
    graceMs: o.graceMs ?? DEFAULT_GRACE_MS, skipGitRepoCheck: o.skipGitRepoCheck ?? false, nowMs: o.nowMs ?? Date.now,
    sourceOnlyLauncher: extra['audit-source-only'] ?? null })
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
  // The wire schema is the runtime contract: it is checked, never written.
  try { check(canonical(JSON.parse(JSON.stringify(r.wireSchema))) === WIRE_SCHEMA) } catch { fail(INPUT) }
  // A source-only audit leaf is handed the NR-01 wire schema itself: its result schemas are advisory in the Workflow tool (a verifier's record names four
  // properties and carries a dozen), so Codex's strict subset (no extra property) would forbid a valid record, and three audit schemas have optional properties
  // it cannot express at all. The leaf answers {"json": <the result as text>} and the runtime's decode judges the text against the leaf's own schema.
  const wireMode = r.profile === 'audit-source-only' && config.sourceOnlyLauncher !== null
  const schemaBytes = wireMode ? JSON.stringify(r.wireSchema) : strictSchemaBytes(r.schema)
  check(typeof r.deadlineMs === 'number' && Number.isFinite(r.deadlineMs))
  check(isAbortSignal(r.signal))
  const { nowMs } = config
  let now
  try { now = nowMs() } catch { fail(INPUT) }
  check(typeof now === 'number' && Number.isFinite(now))
  return { callId: r.callId, prompt: r.prompt, profile: r.profile, schemaBytes, wireMode,
    signal: r.signal, timeoutMs: Math.floor(r.deadlineMs - now - config.graceMs - SETTLE_MARGIN_MS),
    receipt: { provider: selection.provider, model: selection.model, effort: selection.effort, invocationId: r.callId } }
}

// The bytes Codex gets as --output-schema, or null when the strict subset cannot
// express the leaf schema (a valid request that Codex cannot run). Any other
// schema failure is a caller contract violation: the runtime encoded it first.
function strictSchemaBytes(schema) {
  try { return JSON.stringify(strictOutputSchema(schema)) } catch (error) {
    if (error?.code === 'UNSUPPORTED_SCHEMA') return null
    return fail(INPUT)
  }
}

async function runValidLeaf(config, leaf) {
  const failed = (code, usage = null) => ({ outcome: 'failed', code, usage, receipt: { ...leaf.receipt } })
  const sandbox = sandboxForProfile(leaf.profile)
  const launcher = leaf.profile === 'audit-source-only' ? config.sourceOnlyLauncher : null
  if (sandbox === null && launcher === null) return failed(CODES.PROFILE_UNSUPPORTED)
  if (leaf.schemaBytes === null) return failed(CODES.SCHEMA_UNSUPPORTED)
  if (leaf.timeoutMs < 1) return failed(CODES.TIMEOUT)
  const files = { schemaFile: join(config.runDir, `${leaf.callId}.schema.json`),
    outputFile: join(config.runDir, `${leaf.callId}.output.json`), logFile: join(config.runDir, `${leaf.callId}.log.jsonl`) }
  // From here every filesystem or process error is an envelope, never a rejection.
  let usage = null, launch = null
  try {
    prepareRunDir(config.runDir, files, leaf.schemaBytes)
    // runCodexExec returns 130 for an already-aborted signal without truncating
    // the log, so a log left by an earlier attempt must not be classified.
    if (leaf.signal.aborted) return failed(CODES.EXIT_NONZERO)
    if (launcher === null) {
      launch = { cwd: config.cwd, env: config.env, release: null,
        args: codexExecArgs({ sandbox, networkAccess: NETWORK_PROFILES.includes(leaf.profile),
          model: leaf.receipt.model, reasoningEffort: leaf.receipt.effort, skipGitRepoCheck: config.skipGitRepoCheck,
          schemaFile: files.schemaFile, outputFile: files.outputFile }) }
    } else {
      launch = await launcher({ callId: leaf.callId, model: leaf.receipt.model, effort: leaf.receipt.effort, files, signal: leaf.signal })
      if (typeof launch?.code === 'string' && CODES[launch.code] !== undefined) return failed(launch.code)
      check(Array.isArray(launch?.args) && absolutePath(launch.cwd))
    }
    const exitCode = await runCodexExec(config.codexBin, launch.args, { cwd: launch.cwd, env: launch.env, input: leaf.prompt,
      logFile: files.logFile, timeoutMs: Math.min(leaf.timeoutMs, Number.MAX_SAFE_INTEGER), graceMs: config.graceMs,
      signal: leaf.signal })
    const classified = classifyCodexExec({ exitCode, logFile: files.logFile })
    usage = usageOf(classified.result)
    if (!classified.ok) return failed(classified.code, usage)
    const read = readWire(files.outputFile, leaf.wireMode)
    if (read.code) return failed(read.code, usage)
    const envelope = { outcome: 'returned', wire: { json: read.json }, usage, receipt: { ...leaf.receipt } }
    // The runtime bounds the whole completion; never return one it would reject.
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MIB) return failed(CODES.INVALID_WIRE, usage)
    return envelope
  } catch {
    return failed(CODES.IO_ERROR, usage)
  } finally {
    // A resource the launcher handed out (a reader server) is released whatever the leaf did. A release failure cannot change the envelope.
    try { await launch?.release?.() } catch { /* the leaf's own outcome stands */ }
  }
}

// Creates the run directory, writes a fresh private schema file and removes any
// stale output so it can never be read as this run's. A symlink at either name is
// removed, never followed.
function prepareRunDir(runDir, files, schemaBytes) {
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  removeIfPresent(files.schemaFile)
  const fd = openSync(files.schemaFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    fchmodSync(fd, 0o600)
    const bytes = Buffer.from(schemaBytes, 'utf8')
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at)
  } finally { closeSync(fd) }
  removeIfPresent(files.outputFile)
}

function removeIfPresent(file) {
  try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

// Reads the --output-last-message file as one bare object. Returns {json} or
// {code}. Filesystem errors other than the classified ones propagate (IO_ERROR).
function readWire(file, wireMode = false) {
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
    return wireMode ? passWire(readBounded(fd)) : wrapBareObject(readBounded(fd))
  } finally { closeSync(fd) }
}

// Reads at most MIB + 1 bytes, so a file that grew past the limit is still refused.
function readBounded(fd) {
  const buffer = Buffer.alloc(MIB + 1)
  let length = 0
  for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
  return length > MIB ? null : buffer.subarray(0, length)
}

// One plain JSON object, wrapped as the wire string of its re-serialization. It is
// never unwrapped or repaired: a non-finite number, nesting past 64 levels or an
// oversize value is INVALID_WIRE. The runtime's decode judges the semantics.
function wrapBareObject(bytes) {
  if (bytes === null) return { code: CODES.INVALID_WIRE }
  let value
  try { value = JSON.parse(UTF8.decode(bytes)) } catch { return { code: CODES.INVALID_WIRE } }
  if (!record(value)) return { code: CODES.INVALID_WIRE }
  let copy
  try { copy = copyJSON(value, CODES.INVALID_WIRE) } catch (error) {
    if (error?.code === CODES.INVALID_WIRE) return { code: CODES.INVALID_WIRE }
    throw error
  }
  return { json: JSON.stringify(copy) }
}

// The wire-mode answer: exactly {"json": <string>}, passed on as the wire. The text inside is never parsed or repaired here: the runtime's decode
// parses it and judges it against the leaf's own schema.
function passWire(bytes) {
  if (bytes === null) return { code: CODES.INVALID_WIRE }
  let value
  try { value = JSON.parse(UTF8.decode(bytes)) } catch { return { code: CODES.INVALID_WIRE } }
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.json !== 'string') return { code: CODES.INVALID_WIRE }
  return { json: value.json }
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
