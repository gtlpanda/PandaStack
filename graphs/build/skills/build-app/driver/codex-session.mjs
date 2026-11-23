// codex-session.mjs: the Codex side of the /build-app driver (--backend codex).
// Wiring only; the driver keeps the lifecycle, the lock, the ledger and the PR flow.
//
//   slice session   one `codex exec` through autobuild's runCodex (graphs/autobuild/tool/lib/codex.mjs),
//                   report taken from --output-last-message under a strict --output-schema
//   host commit     the driver commits what the session wrote (`S<n>: ...`); no Claude hooks exist here
//   final QA        graphs/qa/tool/qa-loop.mjs (the native harness-repair iteration), then a host commit
//   bug hunt        graphs/hunt/skills/bughunt/native-cli.mjs --backend codex --mode fix
//
// No function here starts `claude`, and none falls back to it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, loadConfig, codexModel } from '../../../../autobuild/tool/lib/config.mjs'
import { runCodex, readCodexResult } from '../../../../autobuild/tool/lib/codex.mjs'
import { gitControlDigest, gitControlChanges } from '../../../../autobuild/tool/lib/gate.mjs'
import { sliceTask } from '../../../../../core/skills/backlog/backlog.mjs'
import { classifyOutcome } from './limits.mjs'
import { git } from './proc.mjs'
import { trackSession, readText } from './session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// The checkout this driver runs from: its core/ and graphs/ hold the native CLIs and the catalog.
export const INSTALL_ROOT = resolve(HERE, '..', '..', '..', '..', '..')
export const QA_LOOP_CLI = join(INSTALL_ROOT, 'graphs', 'qa', 'tool', 'qa-loop.mjs')
export const HUNT_CLI = join(INSTALL_ROOT, 'graphs', 'hunt', 'skills', 'bughunt', 'native-cli.mjs')
const MAX_NATIVE_TIMEOUT_MS = 86_400_000

// The autobuild-style config runCodex needs. Same selection as the native hunt CLI: the repo's
// autobuild.json when it has one, else the defaults with Codex models.
export function codexRunConfig(repo, { bin, sessionTimeoutMs, env = process.env }) {
  const config = existsSync(join(repo, 'autobuild.json'))
    ? loadConfig(repo, env, { backend: 'codex' })
    : { ...structuredClone(DEFAULTS), root: repo, backend: 'codex', codexBin: env.AUTOBUILD_CODEX_BIN || DEFAULTS.codexBin,
      model: codexModel('opus'), subagentModel: codexModel('sonnet'), probeModel: codexModel(DEFAULTS.probeModel) }
  if (bin) config.codexBin = bin
  config.codex = { ...config.codex, sessionTimeoutMinutes: Math.max(1, sessionTimeoutMs / 60_000) }
  return config
}

// ---------- the slice session ----------

// The report the session ends with; the driver reads it the way it reads /dev's ledger (checks.mjs devReport).
export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'needs-human', 'escalate'] },
    reason: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'reason', 'questions'],
  additionalProperties: false,
}

// The session rules, in place of autobuild's (runCodex's `rules` option). The driver, not the session, commits.
export function sliceRules({ sliceId, frozen }) {
  return [
    'UNATTENDED BUILD (PandaStack /build-app, Codex). No human is present. Do exactly the slice above and stop when you report.',
    'Read AGENTS.md and CLAUDE.md if present, and docs/ for the design the slice names. Tests first: write a test for every acceptance criterion (a file under tests/ or named *.test.* or *_test.go or test_*.py), watch it fail, make it pass with the smallest real change, then run the project\'s own tests until they pass.',
    `Never run git add, commit, checkout, switch, branch, reset, rebase or push, never edit anything under .git, never ask a question, never launch Claude. The driver commits your work as "${sliceId}: ..." and runs its own checks.`,
    `Frozen paths from earlier slices (never edit): ${JSON.stringify(frozen)}.`,
    'Your final message is one JSON object and nothing else: {"status": "done"|"needs-human"|"escalate", "reason": "...", "questions": [...]}. done only when every criterion has a passing test. needs-human only when a decision the slice needs is missing: list each question. escalate when you cannot finish: say why.',
  ].join('\n')
}

// The slice as the Codex session is told it. It starts with a fixed line, so a fake codex can match it.
export function slicePrompt({ backlog, ledger, sliceId }) {
  const t = sliceTask(backlog, sliceId, ledger)
  return [
    `UNATTENDED BUILD (PandaStack /build-app, Codex). Slice ${sliceId}: build this slice of docs/backlog.json on the current branch.`,
    '',
    t.task,
    '',
    `Required criteria, ids and wording unchanged: ${JSON.stringify(t.requiredCriteria)}`,
  ].join('\n')
}

// One `codex exec` for a slice. Resolves its exit code; the report is in `reportFile`, the events in `logFile`.
export async function runSliceSession({ config, prompt, rules, logFile, reportFile, pidFile }) {
  const schemaFile = `${logFile}.schema.json`
  writeFileSync(schemaFile, `${JSON.stringify(REPORT_SCHEMA)}\n`)
  return runCodex(config, { role: 'builder', prompt, rules, logFile, outputFile: reportFile, schemaFile }, child => trackSession(child, { pidFile, group: true }))
}

// The one-turn availability probe (the Claude driver's Haiku probe).
export const runProbeSession = ({ config, logFile, pidFile }) =>
  runCodex(config, { role: 'probe', prompt: 'Reply OK.', logFile, outputFile: `${logFile}.last` }, child => trackSession(child, { pidFile, group: true }))

// How the session ended, in the terms the driver already has: the limits.mjs kinds plus provider_refusal,
// which is never retried (AGENTS.md).
export function codexVerdict(logFile) {
  const result = readCodexResult(logFile)
  if (result && result.providerRefusal) return { result, kind: 'provider_refusal', message: 'the provider declined this work; automatic retry is blocked' }
  const errored = result && result.is_error ? result : null
  return { result, ...classifyOutcome({ result: errored, text: readText(`${logFile}.stderr`) }) }
}

// Codex reports tokens, never dollars (no invented budgets). The sum over every turn of one session log.
export function tokenUsage(logFile) {
  const total = { input: 0, output: 0 }
  if (!existsSync(logFile)) return total
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event && event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      total.input += Number.isFinite(Number(event.usage.input_tokens)) ? Number(event.usage.input_tokens) : 0
      total.output += Number.isFinite(Number(event.usage.output_tokens)) ? Number(event.usage.output_tokens) : 0
    }
  }
  return total
}

// ---------- host-owned git ----------

// The git control files (config, hooks, info) as a digest, taken before a session and compared after it.
// `config` is codexRunConfig's (autobuild's git helper reads its env and root).
export const controlDigest = config => gitControlDigest(config)
export const controlChanges = (config, before) => gitControlChanges(config, before)

// Commits what the session left, so the driver's checks see commits as they do in Claude mode.
// `paths` limits it to those paths (the final QA's touched files); without it, everything git does not ignore.
// Returns {ok, committed, message}.
export function hostCommit(repo, subject, body = '', paths = null) {
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim()
  if (!dirty) return { ok: true, committed: false }
  const added = git(repo, paths ? ['add', '--', ...paths] : ['add', '-A'])
  if (!added.ok) return { ok: false, committed: false, message: `git add failed: ${added.out.trim().slice(0, 300)}` }
  const identity = git(repo, ['config', 'user.email']).stdout.trim() ? [] : ['-c', 'user.name=build-app', '-c', 'user.email=build-app@localhost']
  const made = git(repo, [...identity, 'commit', '-q', '--no-verify', '-m', subject, ...(body ? ['-m', body] : [])])
  return made.ok ? { ok: true, committed: true } : { ok: false, committed: false, message: `git commit failed: ${made.out.trim().slice(0, 300)}` }
}

// ---------- the native CLIs ----------

// The leaf's whole environment for the QA loop: HOME, CODEX_HOME when set, and PATH, as the blueprint runner does.
export function leafEnv(env = process.env) {
  const leaf = {}
  for (const key of ['HOME', 'CODEX_HOME', 'PATH']) if (typeof env[key] === 'string' && env[key]) leaf[key] = env[key]
  return leaf
}

// The args file qa-loop.mjs reads (spec/contracts/codex-parity-cp-05d.md). Written 0600 beside the logs.
export function writeQaArgs(file, { repo, base, codexBin, timeoutMs, env = process.env }) {
  const args = {
    schemaVersion: 1, repo, installationRoot: INSTALL_ROOT, codexBin, env: leafEnv(env),
    timeoutMs: Math.min(Math.max(Math.floor(timeoutMs), 1001), MAX_NATIVE_TIMEOUT_MS), base, maxFixRounds: 3,
  }
  writeFileSync(file, `${JSON.stringify(args)}\n`, { mode: 0o600 })
  return args
}

// qa-loop's one stdout line: its report, or null when it printed none.
export function readQaReport(stdout) {
  const line = String(stdout || '').trim().split('\n').pop() || ''
  try {
    const r = JSON.parse(line)
    return r && typeof r === 'object' && typeof r.status === 'string' ? r : null
  } catch { return null }
}

// qa-loop's one stderr line ({"error": CODE}), for the message when it exits non-zero.
export function readQaError(stderr) {
  try { return String(JSON.parse(String(stderr || '').trim().split('\n').pop() || '').error || '') } catch { return '' }
}

// The native hunt CLI's argv: fix mode on the checked-out integration branch, Codex only.
export function huntArgs({ repo, base, codexBin, cli = HUNT_CLI }) {
  return [cli, '--repo', repo, '--base', base, '--backend', 'codex', '--mode', 'fix', '--codex-bin', codexBin]
}

// The state directory the hunt CLI prints ("Native hunt: ...; state=<dir>"), or null.
export function huntStateDir(stdout) {
  const m = /^Native hunt: .*; state=(.+)$/m.exec(String(stdout || ''))
  return m ? m[1].trim() : null
}

// What landHunt needs, rebuilt from the state dir the CLI used (it makes the fix worktree itself).
export function huntPrep(stateDir, head) {
  let key
  try { key = JSON.parse(readFileSync(join(stateDir, 'intake.json'), 'utf8')).key } catch { return null }
  if (typeof key !== 'string' || !key) return null
  return { stateDir, key, branch: `bughunt/${key}`, fixDir: join(stateDir, 'fix'), head }
}
