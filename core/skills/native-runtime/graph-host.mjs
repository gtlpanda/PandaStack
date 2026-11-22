#!/usr/bin/env node
// Native graph host (spec/contracts/codex-parity-cp-02e.md). Runs ONE registered
// graph workflow on the native runtime: workflow pins come from the v2 catalog,
// every refusal happens before the run directory exists, each role's instructions
// go in front of its leaf prompt, the CP-02d store's lock is the run lock, and the
// graph's return value is persisted as result.json. Composes existing seams only.
//   node graph-host.mjs --args-file <absolute path>
// Wiring proof only (fake providers and stub codex): not runtime certification.
import { closeSync, constants, fstatSync, mkdirSync, chmodSync, openSync, readSync, realpathSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { loadOfferingCatalog, providerImplementation } from './catalog.mjs'
import { assembleRoleInstructions } from './role-files.mjs'
import { resolveLeaf, CODEX_REFUSED_WORKFLOWS } from './codex-selection.mjs'
import { createCodexProvider } from './codex-provider.mjs'
import { createFileCheckpointStore, checkpointDirOf } from './checkpoint-store.mjs'
import { failedCompletion } from './completion.mjs'
import { createNativeRuntime } from './runtime.mjs'
import { loadWorkflowRegistry, registryWorkflow } from './registry.mjs'
import { fields, json, record, ownErrorCode } from './boundary.mjs'

const INPUT = 'INVALID_HOST_INPUT'
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const WORKFLOW_SOURCE = /^graphs\/([a-z0-9][a-z0-9-]*)\/workflows\/([a-z0-9][a-z0-9-]*)\.js$/
const MAX_PATH_BYTES = 4096
const MAX_TIMEOUT_MS = 86400000
const MAX_SUBAGENTS = 64
const RESULT = 'result.json'
const RESULT_VERSION = 1
// CP-02g: the Codex provider's own prompt limit, applied to the combined leaf prompt.
const MAX_LEAF_PROMPT_BYTES = 1048576
// The library keys besides `provider` and `signal`; the CLI args file carries the same.
const VALUE_KEYS = ['installationRoot', 'workflowId', 'offeringId', 'invocationId', 'args', 'runDir', 'timeoutMs', 'maxConcurrentSubagents']
const LIBRARY_KEYS = [...VALUE_KEYS, 'provider']

class HostInputError extends Error {
  constructor() { super(`Graph host: ${INPUT}.`); this.code = INPUT }
}
const check = ok => { if (!ok) throw new HostInputError() }
const outcomeError = (exitCode, error) => ({ exitCode, error })
// A thrown value's own fixed code, else the fallback. Never a message or a path.
function codeOf(e, fallback) {
  const code = ownErrorCode(e)
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : fallback
}

// ---------------------------------------------------------------- input (step 1)

const absolutePath = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES && !CONTROL.test(value) && isAbsolute(value)
const integerIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
function isAbortSignal(value) {
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(value); return true } catch { return false }
}

// The rules shared by the library options and the CLI args file. Returns detached values.
function hostValues(input) {
  check(absolutePath(input.installationRoot) && absolutePath(input.runDir))
  check(typeof input.workflowId === 'string' && ID.test(input.workflowId))
  check(typeof input.offeringId === 'string' && ID.test(input.offeringId))
  check(typeof input.invocationId === 'string' && INVOCATION_ID.test(input.invocationId))
  check(integerIn(input.timeoutMs, 1, MAX_TIMEOUT_MS))
  check(integerIn(input.maxConcurrentSubagents, 1, MAX_SUBAGENTS))
  const args = json(input.args, INPUT)
  return { installationRoot: input.installationRoot, workflowId: input.workflowId, offeringId: input.offeringId,
    invocationId: input.invocationId, args, runDir: input.runDir, timeoutMs: input.timeoutMs,
    maxConcurrentSubagents: input.maxConcurrentSubagents }
}

function hostInput(options) {
  const input = fields(options, INPUT)
  const keys = Object.keys(input)
  check(keys.every(key => LIBRARY_KEYS.includes(key) || key === 'signal') && LIBRARY_KEYS.every(key => Object.hasOwn(input, key)))
  const values = hostValues(input)
  const provider = fields(input.provider, INPUT)
  // Read once here: the wrapped provider never looks the method up again.
  check(typeof provider.runLeaf === 'function')
  if (Object.hasOwn(input, 'signal')) check(isAbortSignal(input.signal))
  return { ...values, provider: input.provider, runLeaf: provider.runLeaf, signal: input.signal }
}

// ------------------------------------------------------- refusals (steps 2 to 7)

// Step 3: the catalog's workflow rows, keyed by workflow id. A v1 catalog has no pins.
function workflowRows(catalog) {
  if (catalog.schemaVersion !== 2) throw Object.assign(new Error('Graph host: CATALOG_NO_PINS.'), { code: 'CATALOG_NO_PINS' })
  const rows = new Map()
  for (const row of catalog.workflows) {
    const match = WORKFLOW_SOURCE.exec(row.source)
    if (!match || rows.has(match[2])) throw Object.assign(new Error('Graph host: REGISTRY_MISMATCH.'), { code: 'REGISTRY_MISMATCH' })
    rows.set(match[2], { graph: match[1], sha256: row.sha256, roles: row.roles })
  }
  return rows
}

// Step 5: the workflow and every registered child, transitively, in discovery order.
function reachOf(registry, workflowId) {
  const reach = []
  const pending = [workflowId]
  while (pending.length) {
    const id = pending.shift()
    if (reach.includes(id)) continue
    reach.push(id)
    pending.push(...registryWorkflow(registry, id).children)
  }
  return reach
}

// Step 6: true when this offering may run the workflow on Codex.
function offeringSupports(catalog, offeringId, graph, reach) {
  const offering = catalog.offerings.find(row => row.id === offeringId)
  if (!offering) return false
  const owners = catalog.offerings.filter(row => row.entrySkill === true && row.source.startsWith(`graphs/${graph}/skills/`))
  if (owners.length > 0 && !owners.includes(offering)) return false
  if (providerImplementation(offering, 'codex') === 'unavailable') return false
  return !reach.some(id => CODEX_REFUSED_WORKFLOWS.includes(id))
}

// Step 7: each role of every reached workflow, assembled once. Name -> instructions.
function roleInstructions(installationRoot, rows, reach) {
  const instructions = new Map()
  for (const id of reach) {
    for (const name of rows.get(id).roles) {
      if (!instructions.has(name)) instructions.set(name, assembleRoleInstructions({ installationRoot, name }).instructions)
    }
  }
  return instructions
}

const refusal = (e, fallback) => outcomeError(2, codeOf(e, fallback))

// Steps 2 to 7. Returns {registry, instructions} or an exit-2 outcome. Nothing is created.
function admit(input) {
  let catalog, rows, registry, reach
  try { catalog = loadOfferingCatalog({ installationRoot: input.installationRoot }) } catch (e) { return refusal(e, 'IO_ERROR') }
  try { rows = workflowRows(catalog) } catch (e) { return refusal(e, 'REGISTRY_MISMATCH') }
  const pins = {}
  for (const [id, row] of rows) pins[id] = row.sha256
  try { registry = loadWorkflowRegistry({ installationRoot: input.installationRoot, workflowHashes: pins }) }
  catch (e) { return refusal(e, 'IO_ERROR') }
  try { reach = reachOf(registry, input.workflowId) } catch (e) { return refusal(e, 'UNKNOWN_WORKFLOW') }
  // Every registered id has a row: the registry accepted exactly the catalog's pin ids.
  let supported
  try { supported = offeringSupports(catalog, input.offeringId, rows.get(input.workflowId).graph, reach) } catch { supported = false }
  if (!supported) return outcomeError(2, 'OFFERING_UNSUPPORTED')
  let instructions
  try { instructions = roleInstructions(input.installationRoot, rows, reach) } catch (e) { return refusal(e, 'IO_ERROR') }
  return { registry, instructions }
}

// ------------------------------------------------------------ the run (8 to 12)

// Step 8. An existing directory keeps its mode; one this call creates is 0700
// whatever the umask (mkdirSync returns a path only when it created something).
function makeRunDir(runDir) {
  const created = mkdirSync(runDir, { recursive: true, mode: 0o700 })
  if (created !== undefined) chmodSync(runDir, 0o700)
}

// The leaf prompt is the role's instructions, a blank line, then the workflow's
// own prompt. The runtime has already hashed the workflow's prompt for its binding.
// CP-02g: a combined prompt over the limit is a failed leaf that the runtime settles
// like any other; the caller's provider is never called and the prompt is never cut.
function wrapProvider(input, instructions) {
  return Object.freeze({
    runLeaf(request) {
      const text = instructions.get(request.agentType)
      if (text === undefined) throw Object.assign(new Error('Graph host: INVALID_SELECTION.'), { code: 'INVALID_SELECTION' })
      const prompt = text + '\n\n' + request.prompt
      if (Buffer.byteLength(prompt, 'utf8') > MAX_LEAF_PROMPT_BYTES) {
        return failedCompletion({ selection: request.selection, code: 'PROMPT_TOO_LARGE', invocationId: 'host:' + request.callId })
      }
      return input.runLeaf.call(input.provider, { ...request, prompt })
    },
  })
}

// A role outside step 7's set is refused here, which the runtime turns into
// INVALID_SELECTION before any reserve.
function wrapResolveLeaf(instructions) {
  return context => {
    if (!instructions.has(context?.agentType)) throw Object.assign(new Error('Graph host: INVALID_SELECTION.'), { code: 'INVALID_SELECTION' })
    return resolveLeaf(context)
  }
}

async function syncDirectory(dir) {
  const handle = await open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

// Step 11: unique 0600 temp file (exclusive, no symlink follow), fsync, rename,
// fsync the directory. On any failure this invocation leaves no result.json.
async function writeResult(runDir, bytes) {
  const final = join(runDir, RESULT)
  const temp = `${final}.tmp-${randomBytes(16).toString('hex')}`
  let handle, created = false, renamed = false
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, final)
    renamed = true
    await syncDirectory(runDir)
  } catch {
    await handle?.close().catch(() => {})
    if (created && !renamed) await unlink(temp).catch(() => {})
    if (renamed) await unlink(final).catch(() => {})
    throw Object.assign(new Error('Graph host: IO_ERROR.'), { code: 'IO_ERROR' })
  }
}

function resultRecord(input, returned) {
  let result
  try { result = returned === undefined ? null : json(returned, 'INVALID_RESULT') }
  catch { throw Object.assign(new Error('Graph host: INVALID_RESULT.'), { code: 'INVALID_RESULT' }) }
  const status = record(result) && typeof result.status === 'string' && result.status.length > 0 ? result.status : null
  const bytes = JSON.stringify({ schemaVersion: RESULT_VERSION, workflowId: input.workflowId, offeringId: input.offeringId,
    invocationId: input.invocationId, status, result }, null, 2) + '\n'
  return { status, result, bytes }
}

// Steps 10 and 11 under the lock. Returns the outcome before the closes.
async function execute(input, admitted, store) {
  let runtime
  try {
    runtime = createNativeRuntime({ registry: admitted.registry, provider: wrapProvider(input, admitted.instructions),
      resolveLeaf: wrapResolveLeaf(admitted.instructions), checkpoints: store,
      maxConcurrentSubagents: input.maxConcurrentSubagents, deadlineMs: Date.now() + input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }) })
  } catch (e) { return { outcome: outcomeError(3, codeOf(e, 'WORKFLOW_ERROR')) } }
  let returned
  try { returned = await runtime.run(input.workflowId, input.args, { invocationId: input.invocationId }) }
  catch (e) { return { runtime, outcome: outcomeError(3, codeOf(e, 'WORKFLOW_ERROR')) } }
  try {
    const { status, result, bytes } = resultRecord(input, returned)
    await writeResult(input.runDir, bytes)
    return { runtime, outcome: { exitCode: 0, status, result } }
  } catch (e) { return { runtime, outcome: outcomeError(3, codeOf(e, 'IO_ERROR')) } }
}

// Step 12: runtime first, then the store (which releases the run lock). An
// earlier error keeps its code; a close failure turns a success into exit 3.
async function closeAll(runtime, store, outcome) {
  let failure = null
  try { await runtime?.close() } catch { failure = 'CLEANUP_UNCONFIRMED' }
  try { await store.close() } catch (e) { failure ??= codeOf(e, 'IO_ERROR') }
  if (outcome.exitCode !== 0 || failure === null) return outcome
  return outcomeError(3, failure)
}

async function runAdmitted(input, admitted) {
  try { makeRunDir(input.runDir) } catch { return outcomeError(3, 'IO_ERROR') }
  let store
  try { store = await createFileCheckpointStore({ dir: checkpointDirOf(input.runDir) }) }
  catch (e) {
    const code = codeOf(e, 'IO_ERROR')
    return outcomeError(code === 'OWNER_BUSY' ? 4 : 3, code)
  }
  let runtime, outcome
  try { ({ runtime, outcome } = await execute(input, admitted, store)) }
  catch (e) { outcome = outcomeError(3, codeOf(e, 'WORKFLOW_ERROR')) }
  return closeAll(runtime, store, outcome)
}

/** Runs one registered workflow. Never rejects: every result is an outcome. */
export async function runGraphHost(options) {
  let input
  try { input = hostInput(options) } catch { return outcomeError(1, INPUT) }
  try {
    const admitted = admit(input)
    if (admitted.exitCode !== undefined) return admitted
    return await runAdmitted(input, admitted)
  } catch {
    // Not reachable through the steps above, each of which returns its own outcome.
    return outcomeError(3, 'IO_ERROR')
  }
}

// ---------------------------------------------------------------- CLI

const MAX_ARGS_BYTES = 1048576
const DEFAULT_GRACE_MS = 500 // CP-02b's default
const LEAF_START_MS = 500 // CP-02b's settle margin: a leaf needs timeoutMs > graceMs + this
const ARGS_KEYS = ['schemaVersion', ...VALUE_KEYS, 'codexBin', 'cwd', 'env']
const OPTIONAL_ARGS_KEYS = ['graceMs', 'skipGitRepoCheck']

// Exactly `--args-file <absolute path>`.
function argsFilePath(argv) {
  check(argv.length === 2 && argv[0] === '--args-file' && absolutePath(argv[1]))
  return argv[1]
}

// A regular file of at most MAX_ARGS_BYTES, opened non-blocking so a FIFO cannot hang.
function readArgsFile(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size <= MAX_ARGS_BYTES)
    const buffer = Buffer.alloc(MAX_ARGS_BYTES + 1)
    let length = 0
    for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
    check(length <= MAX_ARGS_BYTES)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } catch { throw new HostInputError() } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The args file's library values and the CP-02b provider it describes.
function cliInput(parsed) {
  const file = fields(parsed, INPUT)
  const keys = Object.keys(file)
  check(keys.every(key => ARGS_KEYS.includes(key) || OPTIONAL_ARGS_KEYS.includes(key)))
  check(ARGS_KEYS.every(key => keys.includes(key)))
  check(file.schemaVersion === 1)
  const values = hostValues(file)
  check(absolutePath(file.codexBin) && absolutePath(file.cwd))
  const hasGrace = Object.hasOwn(file, 'graceMs'), hasSkip = Object.hasOwn(file, 'skipGitRepoCheck')
  check(!hasGrace || (Number.isSafeInteger(file.graceMs) && file.graceMs >= 0))
  check(!hasSkip || typeof file.skipGitRepoCheck === 'boolean')
  check(values.timeoutMs > (hasGrace ? file.graceMs : DEFAULT_GRACE_MS) + LEAF_START_MS)
  let provider
  try {
    provider = createCodexProvider({ codexBin: file.codexBin, cwd: file.cwd, env: file.env, runDir: join(values.runDir, 'provider'),
      ...(hasGrace ? { graceMs: file.graceMs } : {}), ...(hasSkip ? { skipGitRepoCheck: file.skipGitRepoCheck } : {}) })
  } catch { throw new HostInputError() }
  return { ...values, provider }
}

async function graphHostMain(argv, out = process.stdout, err = process.stderr) {
  let input
  try { input = cliInput(readArgsFile(argsFilePath(argv))) } catch { input = null }
  let outcome = outcomeError(1, INPUT)
  if (input) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.on('SIGINT', abort)
    process.on('SIGTERM', abort)
    try { outcome = await runGraphHost({ ...input, signal: controller.signal }) }
    finally {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    }
  }
  if (outcome.exitCode === 0) out.write(JSON.stringify({ status: outcome.status }) + '\n')
  else err.write(JSON.stringify({ error: outcome.error }) + '\n')
  return outcome.exitCode
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// process.exitCode, not process.exit(): stdout to a pipe may still be flushing.
if (isEntryPoint()) process.exitCode = await graphHostMain(process.argv.slice(2))
