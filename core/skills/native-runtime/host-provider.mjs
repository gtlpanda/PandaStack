// Which app is the user working in: Codex CLI or Claude Code. PandaStack uses that provider (and its
// models) by default, with no flag. detectHostProvider never throws except for a bad override.
//
// Precedence, first match wins:
//   1. PANDASTACK_PROVIDER: `claude` or `codex`. Any other non-empty value is a usage error. An empty
//      value counts as unset.
//   2. The nearest ancestor process whose executable is `codex` or `claude` (the process tree, not the
//      environment, because one host can launch the other: Claude Code's CLAUDECODE, CLAUDE_CODE_* and
//      other variables leak into a Codex sandbox started from a Claude shell, so an env check alone
//      would call that shell Claude). Observed with the real `codex sandbox` (Codex CLI 0.167.0, Linux,
//      npm install, started from a Claude Code shell): the sandbox is its own PID namespace in which
//      the codex process is PID 1 and the command's parent, so the walk includes PID 1 and finds comm
//      `codex`; a stub `codex` and a real `claude` parent are also found.
//   3. Environment signals, for a sandbox that hides its process tree: CODEX_THREAD_ID or
//      CODEX_SANDBOX_NETWORK_DISABLED -> codex, then CLAUDECODE -> claude. CODEX_SANDBOX_NETWORK_DISABLED
//      was observed set inside `codex sandbox` (and absent from a plain Claude Code shell). CODEX_THREAD_ID
//      is an UNTESTED HYPOTHESIS about what a Codex session exports: the repo deletes it before nested
//      codex sessions (core/skills/native-runtime/codex-exec.mjs, graphs/autobuild/tool/lib/codex.mjs,
//      graphs/hunt/skills/bughunt/native-runner.mjs), which implies Codex sets it, but `codex sandbox` did
//      not set it and no model session was run here. Codex wins this tie because Claude variables leak
//      into Codex, not the other way round.
//   4. `claude`.
//
// Not observed: a real Codex model session (`codex exec`, never run here), a Codex install that is not the npm
// package, and the macOS `ps` path (written, unrun).
//
// `ancestry` is injectable for tests: an array, or a function returning an array, of processes nearest
// first. Each is an executable name (string) or `{ comm, argv }`. When `env` is not the real
// process.env the real process tree is not consulted (an injected env describes a synthetic process),
// so a test that passes its own env never sees the machine's real ancestry.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

export const HOST_PROVIDERS = Object.freeze(['claude', 'codex'])
export const PROVIDER_ENV = 'PANDASTACK_PROVIDER'
const MAX_DEPTH = 32
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno'])
// Variables Codex puts in its commands' environment, strongest first (see the header for what was observed).
const CODEX_ENV_SIGNALS = ['CODEX_THREAD_ID', 'CODEX_SANDBOX_NETWORK_DISABLED']

export class HostProviderUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostProviderUsageError'
    this.code = 'USAGE'
  }
}

// `codex.js` and `codex.mjs` name the same executable as `codex`: an npm shim is a script run by node.
const executableName = path => basename(String(path)).replace(/\.[cm]?js$/, '')

/** `'claude'`, `'codex'` or null: which host one process is. Exact executable-name matches only. */
export function classifyProcess(proc) {
  const { comm, argv } = typeof proc === 'string' ? { comm: proc, argv: [] } : (proc ?? {})
  const args = Array.isArray(argv) ? argv.filter(a => typeof a === 'string') : []
  const names = [comm, args[0]].filter(v => typeof v === 'string' && v !== '').map(executableName)
  for (const name of names) if (HOST_PROVIDERS.includes(name)) return name
  // `node /path/to/codex.js ...`: an interpreter running a script that carries the host's name.
  if (names.some(name => INTERPRETERS.has(name))) {
    const script = args.slice(1).find(a => !a.startsWith('-'))
    const name = script === undefined ? null : executableName(script)
    if (HOST_PROVIDERS.includes(name)) return name
  }
  return null
}

function procFsProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm) S ppid ...": comm may hold spaces and parentheses, so split after the last ")".
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[1])
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').replace(/\n$/, '')
    let argv = []
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { /* comm alone is enough */ }
    return Number.isInteger(ppid) ? { ppid, comm, argv } : null
  } catch { return null }
}

function psProcess(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
    if (r.status !== 0 || !r.stdout) return null
    const match = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.split('\n')[0])
    if (!match) return null
    const argv = match[2].split(/\s+/).filter(Boolean)
    return { ppid: Number(match[1]), comm: argv[0] ?? '', argv }
  } catch { return null }
}

/** The real parent chain of this process, nearest first, at most MAX_DEPTH deep. Never throws. */
export function readProcessAncestry({ start = process.ppid, readProcess } = {}) {
  const read = readProcess ?? (process.platform === 'linux' ? procFsProcess : psProcess)
  const chain = []
  const seen = new Set()
  let pid = start
  // PID 1 is walked too: inside Codex's sandbox it is the codex process itself. A normal init classifies as no host.
  while (Number.isInteger(pid) && pid >= 1 && chain.length < MAX_DEPTH && !seen.has(pid)) {
    seen.add(pid)
    let proc
    try { proc = read(pid) } catch { break }
    if (!proc) break
    chain.push({ comm: proc.comm, argv: proc.argv })
    pid = proc.ppid
  }
  return chain
}

function ancestorProvider(ancestry) {
  let chain
  try { chain = typeof ancestry === 'function' ? ancestry() : ancestry } catch { return null }
  if (!Array.isArray(chain)) return null
  for (const proc of chain.slice(0, MAX_DEPTH)) {
    const host = classifyProcess(proc)
    if (host) return host
  }
  return null
}

const present = value => typeof value === 'string' && value !== ''

/** `{ provider: 'claude' | 'codex', source }`. Throws HostProviderUsageError for a bad PANDASTACK_PROVIDER. */
export function detectHostProvider({ env = process.env, ancestry } = {}) {
  const override = env?.[PROVIDER_ENV]
  if (present(override)) {
    if (!HOST_PROVIDERS.includes(override)) {
      throw new HostProviderUsageError(`${PROVIDER_ENV} must be "claude" or "codex" (got ${JSON.stringify(override.slice(0, 40))})`)
    }
    return { provider: override, source: PROVIDER_ENV }
  }
  const chain = ancestry ?? (env === process.env ? () => readProcessAncestry() : [])
  const host = ancestorProvider(chain)
  if (host) return { provider: host, source: 'ancestor' }
  for (const name of CODEX_ENV_SIGNALS) if (present(env?.[name])) return { provider: 'codex', source: name }
  if (present(env?.CLAUDECODE)) return { provider: 'claude', source: 'CLAUDECODE' }
  return { provider: 'claude', source: 'default' }
}
