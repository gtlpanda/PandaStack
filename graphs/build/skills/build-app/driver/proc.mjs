// Process helpers for the /build-app driver. buildEnv follows the autobuild kit
// (~/.autobuild/lib/proc.mjs): a headless session must not inherit the parent
// session's identity or settings env.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// A Claude session exports its settings env (CLAUDE_CODE_*) into its process, so
// a driver started from one would pass on, for example, an old
// CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL that forces every workflow agent onto one
// model (measured 2026-11-05). Nested sessions also misbehave on CLAUDECODE.
// Kept: how this machine authenticates and which provider it uses, the standard
// setup for an unattended box.
const KEEP = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_[A-Z]+|SKIP_[A-Z]+_AUTH|API_KEY_HELPER_TTL_MS|CLIENT_(CERT|KEY|KEY_PASSPHRASE))$/
export function buildEnv(extra = {}, base = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key) && !KEEP.test(key)) delete env[key]
  }
  return Object.assign(env, extra)
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// A pid file outlives a SIGKILL or a reboot, and pids are reused: a live pid
// counts only when its command line is still ours (Linux /proc; elsewhere,
// alive is all we can tell).
export function isOurs(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false
  const cmdline = `/proc/${pid}/cmdline`
  if (!existsSync('/proc/self/cmdline')) return true
  try { return readFileSync(cmdline, 'utf8').split('\0').some(a => a.includes(marker)) } catch { return false }
}

// Runs a command synchronously; never throws.
export function run(cmd, args, { cwd, env, timeoutMs = 10 * 60_000, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env || buildEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, input })
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', error: r.error ? r.error.message : null }
}

export function git(repo, args, opts = {}) {
  return run('git', ['-C', repo, ...args], opts)
}

// The last lines of `text`, for a log or a reason.
export function tail(text, lines = 20) {
  return String(text || '').trimEnd().split('\n').slice(-lines).join('\n')
}
