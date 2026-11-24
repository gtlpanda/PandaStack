#!/usr/bin/env node
// codex-hook.mjs - registers the review gate (gate.mjs) as a Codex PreToolUse hook,
// for install.sh --codex. Codex reads user hooks from $CODEX_HOME/hooks.json in the
// same shape as Claude Code's settings hooks, and sends the gate the same input
// (tool_name "Bash", tool_input.command, cwd), so gate.mjs runs unchanged.
//
// Codex runs a hook only once it is trusted: config.toml's hooks.state."<key>".trusted_hash
// must equal the hook's current hash. An untrusted hook, or one whose hooks.json entry
// changed after it was trusted ("modified"), is skipped without a word. So the install
// ends with `status`, and anything but "trusted" means the gate is NOT active.
//
//   node codex-hook.mjs merge   [--dry-run] [--codex-home DIR] --gate ABS_PATH
//     adds our one entry to hooks.json, keeping everything else; an entry of ours that is
//     already there is left exactly as it is (rewriting it would make Codex skip it)
//   node codex-hook.mjs unmerge [--dry-run] [--codex-home DIR] --gate ABS_PATH
//     removes only our entry
//   node codex-hook.mjs status  [--codex-home DIR] --gate ABS_PATH
//     asks `codex app-server` (hooks/list); prints CODEX-GATE: <missing|untrusted|modified|trusted|managed>
//     and exits 0 only for trusted
//   node codex-hook.mjs trust   [--codex-home DIR] --gate ABS_PATH
//     trusts only the user-level entry that is exactly ours, through the app-server's
//     config/batchWrite (the call the Codex UI makes); prints its key and hash
//
// --codex-home defaults to $CODEX_HOME, then $HOME/.codex. PANDASTACK_CODEX_BIN names the
// codex binary (default: codex on PATH). Exit 0 on success, 1 on any failure, 2 on bad usage.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const MATCHER = 'Bash'
export const TIMEOUT_SECONDS = 30
const APP_SERVER_TIMEOUT_MS = 20_000
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export class HookFileError extends Error {}

// The gate path goes inside double quotes in a command a shell runs: refuse anything
// that would be read as shell syntax there.
export function gateCommand(gate) {
  if (typeof gate !== 'string' || !isAbsolute(gate)) throw new HookFileError(`the gate path must be absolute: ${gate}`)
  if (/["$`\\\n\r]/.test(gate)) throw new HookFileError(`the gate path holds a character a shell would read inside double quotes: ${gate}`)
  return `node "${gate}"`
}

export function ourHook(gate) {
  return { type: 'command', command: gateCommand(gate), timeout: TIMEOUT_SECONDS }
}

const isOurs = (group, hook, command) => isObject(group) && group.matcher === MATCHER && isObject(hook) && hook.command === command

// hooks.json parsed and shape-checked: an object whose `hooks` (if any) is an object whose
// `PreToolUse` (if any) is an array. Anything else is refused, never rewritten.
export function parseHooksFile(text) {
  let parsed
  try { parsed = JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch (e) { throw new HookFileError(`hooks.json is not valid JSON: ${e.message}`) }
  if (!isObject(parsed)) throw new HookFileError('hooks.json is valid JSON but not an object')
  if ('hooks' in parsed && !isObject(parsed.hooks)) throw new HookFileError('hooks.json: "hooks" is not an object')
  if (isObject(parsed.hooks) && 'PreToolUse' in parsed.hooks && !Array.isArray(parsed.hooks.PreToolUse)) throw new HookFileError('hooks.json: "hooks.PreToolUse" is not an array')
  return parsed
}

// Returns { config, added }: config with our entry appended as its own group, or unchanged
// (added false) when an entry of ours (matcher Bash, our exact command) is already there.
export function mergeHooks(config, gate) {
  const hook = ourHook(gate)
  const out = config === null ? {} : JSON.parse(JSON.stringify(config))
  if (!isObject(out.hooks)) out.hooks = {}
  if (!Array.isArray(out.hooks.PreToolUse)) out.hooks.PreToolUse = []
  const present = out.hooks.PreToolUse.some(g => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(h => isOurs(g, h, hook.command)))
  if (present) return { config: config === null ? out : config, added: false }
  out.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [hook] })
  return { config: out, added: true }
}

// Returns { config, removed, shifted }: config without our entry (PreToolUse is dropped when it
// ends up empty). Everything else is kept as it was.
// Codex keys a hook's trust by its place ("pre_tool_use:<group>:<hook>"), so removing a group
// would move every later group to a new key and leave it untrusted. A group we emptied is
// therefore kept, empty, when any group follows it (Codex accepts an empty group), and dropped
// only from the end. `shifted` counts other hooks that still moved: ones after ours in a group
// they shared with it.
export function unmergeHooks(config, gate) {
  const command = gateCommand(gate)
  const out = JSON.parse(JSON.stringify(config))
  if (!isObject(out.hooks) || !Array.isArray(out.hooks.PreToolUse)) return { config: out, removed: 0, shifted: 0 }
  let removed = 0
  let shifted = 0
  const emptied = new Set()
  out.hooks.PreToolUse = out.hooks.PreToolUse.map((g, i) => {
    if (!isObject(g) || !Array.isArray(g.hooks)) return g
    const keep = g.hooks.filter(h => !isOurs(g, h, command))
    if (keep.length === g.hooks.length) return g
    removed += g.hooks.length - keep.length
    shifted += keep.filter((h, k) => g.hooks.indexOf(h) !== k).length
    if (keep.length === 0) emptied.add(i)
    return { ...g, hooks: keep }
  })
  while (out.hooks.PreToolUse.length && emptied.has(out.hooks.PreToolUse.length - 1)) out.hooks.PreToolUse.pop()
  if (out.hooks.PreToolUse.length === 0) delete out.hooks.PreToolUse
  return { config: out, removed, shifted }
}

function readHooksFile(file) {
  if (!existsSync(file)) return null
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { throw new HookFileError(`cannot read ${file}: ${e.message}`) }
  return parseHooksFile(text)
}

// Written to a temp file beside it, then renamed over it, so a failed write never leaves half a
// file; on a failure the temp file is removed too, so nothing is left beside the person's config.
export function writeHooksFile(file, config, fs = { writeFileSync, renameSync, rmSync }) {
  const tmp = `${file}.pandastack-${process.pid}.tmp`
  let mode = 0o644
  try { mode = statSync(file).mode & 0o777 } catch { /* a new file */ }
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode })
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort: the error below is what matters */ }
    throw new HookFileError(`cannot write ${file}: ${e.message}`)
  }
}

// ------------------------------------------------------------------ codex app-server

// Runs one session of `codex app-server` (JSON-RPC over stdio) and hands `work` a `call`.
export async function withAppServer(codexHome, work, { bin = process.env.PANDASTACK_CODEX_BIN || 'codex', timeoutMs = APP_SERVER_TIMEOUT_MS } = {}) {
  const child = spawn(bin, ['app-server'], { cwd: codexHome, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let nextId = 1
  let stderr = ''
  let failure = null
  const fail = err => {
    if (failure) return
    failure = err
    for (const reject of pending.values()) reject(err)
    pending.clear()
  }
  child.on('error', e => fail(new Error(e.code === 'ENOENT' ? `codex was not found (${bin}); install Codex, or set PANDASTACK_CODEX_BIN` : `could not start ${bin} app-server: ${e.message}`)))
  child.on('exit', (code, signal) => fail(new Error(`${bin} app-server exited (${signal || code}) before answering${stderr.trim() ? `: ${stderr.trim().split('\n').pop().slice(0, 300)}` : ''}`)))
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
  child.stdin.on('error', () => { /* the exit or error handler reports it */ })
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (!isObject(msg) || !pending.has(msg.id)) return
    const settle = pending.get(msg.id)
    pending.delete(msg.id)
    settle(msg)
  })
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = nextId++
    pending.set(id, msg => (msg instanceof Error ? reject(msg) : isObject(msg.error) ? reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : resolve(msg.result)))
    send({ id, method, params })
  })
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${bin} app-server did not answer within ${timeoutMs / 1000}s`)), timeoutMs) })
  try {
    return await Promise.race([(async () => {
      await call('initialize', { clientInfo: { name: 'pandastack-install', version: '1' } })
      send({ method: 'initialized' })
      return await work(call)
    })(), timeout])
  } finally {
    clearTimeout(timer)
    child.removeAllListeners('exit')
    child.kill()
  }
}

// Our user-level hook as hooks/list reports it, or null. Only a hook from the user layer whose
// key names this hooks.json and whose command is exactly ours counts: a project-level hook
// with the same command is not ours.
export function findOurHook(listResult, hooksFiles, command) {
  const files = [].concat(hooksFiles)
  const entries = isObject(listResult) && Array.isArray(listResult.data) ? listResult.data : []
  const hooks = entries.flatMap(e => (isObject(e) && Array.isArray(e.hooks) ? e.hooks : []))
  return hooks.find(h => isObject(h) && h.source === 'user' && h.command === command
    && typeof h.key === 'string' && files.some(f => h.key.startsWith(`${f}:`))) || null
}

// The key names the entry's place: "<hooks.json>:pre_tool_use:<group>:<hook>". Trust only when
// that place in the file holds exactly our entry, alone in a group of our matcher.
export function entryIsExactlyOurs(config, key, hooksFiles, gate) {
  const m = [].concat(hooksFiles).map(f => (key.startsWith(`${f}:`) ? /^pre_tool_use:(\d+):(\d+)$/.exec(key.slice(f.length + 1)) : null)).find(Boolean)
  if (!m) return false
  const group = config?.hooks?.PreToolUse?.[Number(m[1])]
  const hook = isObject(group) && Array.isArray(group.hooks) ? group.hooks[Number(m[2])] : undefined
  const canonical = v => JSON.stringify(v, (_, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x))
  return isObject(hook) && canonical(group) === canonical({ matcher: MATCHER, hooks: [ourHook(gate)] })
}

// hooks.json as given and as its real path: Codex may name it either way in a key.
function hooksFileNames(codexHome) {
  const given = join(codexHome, 'hooks.json')
  let real = given
  try { real = join(realpathSync(codexHome), 'hooks.json') } catch { /* no such dir: the given name only */ }
  return real === given ? [given] : [given, real]
}

async function listOurs(call, codexHome, command) {
  return findOurHook(await call('hooks/list', { cwds: [codexHome] }), hooksFileNames(codexHome), command)
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const [verb, ...rest] = argv
  const opts = { verb, dryRun: false, codexHome: null, gate: null }
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--codex-home' && rest[i + 1] !== undefined) opts.codexHome = rest[++i]
    else if (a === '--gate' && rest[i + 1] !== undefined) opts.gate = rest[++i]
    else return null
  }
  if (!['merge', 'unmerge', 'status', 'trust'].includes(verb) || !opts.gate) return null
  if (opts.dryRun && !['merge', 'unmerge'].includes(verb)) return null
  opts.codexHome = opts.codexHome || process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, '.codex') : null)
  return opts
}

export async function main(argv, log = console.log, err = console.error) {
  const opts = parseArgs(argv)
  if (!opts) {
    err('usage: codex-hook.mjs merge|unmerge [--dry-run] | status | trust  [--codex-home DIR] --gate ABS_PATH')
    return 2
  }
  try {
    if (!opts.codexHome || !isAbsolute(opts.codexHome)) throw new HookFileError(`the Codex home must be an absolute path (set CODEX_HOME or HOME): ${opts.codexHome}`)
    const command = gateCommand(opts.gate)
    const hooksFile = join(opts.codexHome, 'hooks.json')
    if (opts.verb === 'merge') {
      if (!existsSync(opts.codexHome)) throw new HookFileError(`no Codex home at ${opts.codexHome}`)
      const { config, added } = mergeHooks(readHooksFile(hooksFile), opts.gate)
      if (!added) { log(`codex hooks: ${hooksFile} already has the review gate`); return 0 }
      if (opts.dryRun) { log(`[dry-run] would add the review gate to ${hooksFile}: PreToolUse ${MATCHER}: ${command}`); return 0 }
      writeHooksFile(hooksFile, config)
      log(`codex hooks: added the review gate to ${hooksFile}: PreToolUse ${MATCHER}: ${command}`)
      return 0
    }
    if (opts.verb === 'unmerge') {
      const current = readHooksFile(hooksFile)
      if (current === null) return 0
      const { config, removed, shifted } = unmergeHooks(current, opts.gate)
      if (!removed) return 0
      const moved = shifted ? `; ${shifted} other hook(s) after it in the same PreToolUse group moved up, so Codex will skip them until you trust them again` : ''
      if (opts.dryRun) { log(`[dry-run] would remove the review gate from ${hooksFile}${moved}`); return 0 }
      writeHooksFile(hooksFile, config)
      log(`codex hooks: removed the review gate from ${hooksFile}`)
      if (shifted) err(`codex-hook: warning${moved}`)
      return 0
    }
    if (opts.verb === 'status') {
      const hook = await withAppServer(opts.codexHome, call => listOurs(call, opts.codexHome, command))
      const state = hook ? String(hook.trustStatus) : 'missing'
      log(`CODEX-GATE: ${state}${hook ? ` (${hook.key})` : ''}`)
      return state === 'trusted' ? 0 : 1
    }
    // trust
    return await withAppServer(opts.codexHome, async call => {
      const hook = await listOurs(call, opts.codexHome, command)
      if (!hook) throw new Error(`Codex does not list the review gate from ${hooksFile}; run merge first`)
      if (hook.trustStatus === 'trusted') { log(`codex hooks: the review gate is already trusted (${hook.key})`); return 0 }
      if (!entryIsExactlyOurs(readHooksFile(hooksFile), hook.key, hooksFileNames(opts.codexHome), opts.gate)) {
        throw new Error(`the entry at ${hook.key} is not exactly the one install adds (it was edited); not trusting it. Remove it and run ./install.sh --codex again, or review and trust it in Codex`)
      }
      if (typeof hook.currentHash !== 'string' || !hook.currentHash) throw new Error(`Codex gave no hash for ${hook.key}`)
      await call('config/batchWrite', { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: { [hook.key]: { trusted_hash: hook.currentHash } } }] })
      const after = await listOurs(call, opts.codexHome, command)
      if (!after || after.trustStatus !== 'trusted') throw new Error(`Codex still reports the review gate as ${after ? after.trustStatus : 'missing'} after trusting it`)
      log(`codex hooks: trusted the review gate (${hook.key}, ${hook.currentHash})`)
      return 0
    })
  } catch (e) {
    err(`codex-hook: ${e.message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
