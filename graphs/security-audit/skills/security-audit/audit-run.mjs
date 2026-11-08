#!/usr/bin/env node
// audit-run.mjs - a run's directory, state and gates for the security-audit graph. Upstream's text
// (vendor/cloudflare-security-audit/skills/security-audit/SKILL.md) is the authority for names and
// reason strings; nothing here paraphrases it.
//
//   node audit-run.mjs init [<target>] --full [--out <dir>] [--profile standard] [--scope <path,...>]
//                           [--budget N] [--prior <run dir>]... [--max-parallel N] [--max-units-per-hunter N]
//   node audit-run.mjs next|status|check <run dir>
//
// init gates, then claims a new run directory (default <git common dir>/security-audit/run-<N>/, decision
// D4 A) and writes into it: tree/ (a read-only snapshot of the committed HEAD), run-metadata.json,
// stage-state.json, events.jsonl. Gates: --full given; target is a git working tree with a commit;
// profile supported; --scope paths safe and committed; --prior is a directory; --out new and either outside
// the target, under the git directory, or wholly ignored by version control. A refusal creates nothing.
// The budget gate runs after the directory is claimed: a --budget below the minimum launches nothing and
// records the run as incomplete, so the refusal is disclosed rather than lost (SKILL.md, "Cost budget").
// Earlier runs (default: run-* beside this one; plus each --prior) are validated with upstream's two
// validators and recorded in prior-runs.json, compatible or not: never treated as empty coverage.
//
// next prints one line from stage-state.json, the ledger and findings.json, so a crashed run resumes from disk:
//   NEXT: <step> run=<workflow|helper> [kind=..] [wave=N] [reason=..]   |   NEXT: done status=..   |   NEXT: FAIL <why>
//
// stage-state.json is { version: 1, last: <STEPS entry>, wave: <int>, critic_kind: null | 'post-wave' |
// 'final-clean', updated: <ISO time> }. `last` is the last step whose result is saved; the helper or the
// session that saves a step's result calls advanceState. plan-wave sets wave to the wave it planned; critic_kind
// is set when a critic result is saved and read by the step that applies it.
//
// Every line this prints ends the run of a command: "AUDIT: OK ..." and exit 0, "AUDIT: FAIL <reason>" and
// exit 1 (a gate refused or a check failed), or usage on stderr and exit 2.
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEnv, git as rawGit, tail } from '../../../build/skills/build-app/driver/proc.mjs'
import { VENDOR_DIR, isSafeRelativePath, validateFindingsFile, validateLedgerFile } from './upstream.mjs'

// Every git call here runs without the target's hooks or fsmonitor: both are config a repo may set with a
// relative path, which resolves inside the checkout, the code under audit. A local copy of the flags in
// graphs/hunt/skills/bughunt/evidence.mjs (decision D8 B); tests/audit-run-init.test.mjs fails if they drift.
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const git = (dir, args, opts) => rawGit(dir, [...SAFE_GIT, ...args], opts)

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'   // git knows it without an object
export const KNOWN_PROFILES = ['quick', 'standard', 'deep']
export const SUPPORTED_PROFILES = ['standard']                          // plan section 0: the others wait for PR 9
export const DEFAULTS = { maxParallel: 8, maxUnitsPerHunter: 4 }        // decision D9
export const EXECUTION_POLICY = 'sandboxed-source-and-local-only'       // SKILL.md, "run-metadata.json" paragraph
// The controls upstream requires before any target code runs (SKILL.md, "Universal execution safety").
// None is enforced in v1 (plan section 6), so a run says so and executes nothing.
export const EXECUTION_BLOCKERS = [
  'no external network; use only an isolated loopback namespace when the check needs local client/server traffic',
  'an empty environment populated from an explicit allowlist with safe values, with scratch-local `HOME`, temporary directories, and caches',
  'a read-only target and toolchain, with the target-controlled process able to write only inside its assigned `scratch/` directory',
  'explicit low CPU, memory, process, file-size, disk, and wall-clock limits',
  'trusted parent-side code may promote the minimum non-secret result to retained `artifacts/` using the procedure under Write isolation',
]
// Who writes each shared file (SKILL.md: "the parent ... is the only writer"); plan section 5 names the helpers.
export const SHARED_FILE_OWNERS = {
  'run-metadata.json': 'audit-run.mjs', 'architecture.md': 'audit-ledger.mjs', 'coverage-ledger.json': 'audit-ledger.mjs',
  'findings.json': 'audit-findings.mjs', 'REPORT.md': 'audit-report.mjs', 'FINDINGS-DETAIL.md': 'audit-report.mjs', 'NEEDS-VALIDATION.md': 'audit-report.mjs',
}
export const RUN_STATUSES = ['in_progress', 'complete', 'incomplete']
export const STEPS = ['init', 'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report']
const MAX_SKIPPED_LISTED = 200

class Usage extends Error {}
class Refusal extends Error {}
const refuse = message => { throw new Refusal(message) }

// ---------- files ----------
export function writeJson(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

// events.jsonl is append-only: one JSON object per line, never rewritten.
export function appendEvent(runDir, event) {
  if (typeof event !== 'object' || event === null) throw new TypeError('an event is an object')
  const { cmd, stage, result, reason = null, ...extra } = event
  for (const [k, v] of Object.entries({ cmd, stage, result })) if (typeof v !== 'string' || v === '') throw new TypeError(`event.${k} must be a non-empty string`)
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), cmd, stage, result, reason, ...extra }) + '\n')
}

// A JSON file's value, or undefined when there is no such file. One that is there but unreadable or malformed is
// a refusal, never "empty".
function readJson(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return undefined; refuse(`${file}: ${e.code || e.message}`) }
  try { return JSON.parse(text) } catch (e) { return refuse(`${file} is not valid JSON: ${e.message}`) }
}

export function advanceState(runDir, step, extra = {}) {
  if (!STEPS.includes(step)) throw new TypeError(`unknown step ${JSON.stringify(step)}`)
  const state = { wave: 0, critic_kind: null, ...readJson(join(runDir, 'stage-state.json')) }
  writeJson(join(runDir, 'stage-state.json'), { ...state, ...extra, version: 1, last: step, updated: new Date().toISOString() })
}

// ---------- the target ----------
function repoFacts(target) {
  if (!lexists(target)) refuse(`${target} does not exist`)
  const probe = git(target, ['rev-parse', '--show-toplevel'])
  if (!probe.ok) refuse(`${target} is not inside a git working tree: a full audit reads a committed snapshot`)
  const top = realpathSync(probe.stdout.trim())
  const ask = (args, what) => { const r = git(top, args); if (!r.ok) refuse(`${what}: ${tail(r.out, 2)}`); return r.stdout.trim() }
  const commit = git(top, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!commit.ok) refuse(`${top} has no commits: there is nothing to audit`)
  const status = git(top, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'])
  if (!status.ok) refuse(`reading the working tree status: ${tail(status.out, 2)}`)
  const lines = status.stdout.split('\n').filter(Boolean)
  const untracked = lines.filter(l => l.startsWith('??')).length
  const origin = git(top, ['config', '--get', 'remote.origin.url']).stdout.trim()
  return {
    top, commit: commit.stdout.trim(), tree: ask(['rev-parse', 'HEAD^{tree}'], 'reading the head tree'),
    common: ask(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'finding the git directory'),
    repo: ((origin.match(/([^/\\:]+?)(?:\.git)?\/*$/) || [])[1] || basename(top)).replace(/[^A-Za-z0-9._-]/g, '_'),
    uncommitted: { tracked: lines.length - untracked, untracked },
  }
}

// Scope paths: upstream's own rule for a repository-relative path, and present in the committed snapshot.
function scopePaths(f, wanted) {
  const paths = [...new Set(wanted.map(p => p.replace(/\/+$/, '')))].sort()
  for (const p of paths) {
    if (!isSafeRelativePath(p)) refuse(`--scope ${JSON.stringify(p)} is not a safe repository-relative path (upstream's rule)`)
    if (!git(f.top, ['cat-file', '-e', `${f.commit}:${p}`]).ok) refuse(`--scope ${p} is not in the committed snapshot ${f.commit.slice(0, 12)}`)
  }
  return paths
}

// ---------- where the run goes ----------
const lexists = p => { try { lstatSync(p); return true } catch { return false } }
const inside = (path, dir) => path === dir || path.startsWith(dir + sep)

// `p` with its longest existing prefix resolved through symlinks, so a link cannot hide where it leads.
function realish(p) {
  const rest = []
  let cur = p
  while (!lexists(cur) && dirname(cur) !== cur) { rest.unshift(basename(cur)); cur = dirname(cur) }
  return join(realpathSync(cur), ...rest)
}

// Throws unless `want` (absolute, may not exist yet) is a safe place for run files: outside the target, under
// the git directory (git never tracks it), or inside the target and wholly ignored (SKILL.md "Output directory").
function placeRefusal(want, top, common) {
  let real
  try { real = realish(want) } catch (e) { refuse(`cannot resolve ${want}: ${e.code || e.message}`) }
  if (inside(real, join(realpathSync(common), 'security-audit')) || !inside(real, top)) return
  // A trailing slash asks about the directory itself, which is what a rule like `out/` or `out/*` matches.
  const r = git(top, ['check-ignore', '-q', '--no-index', '--', `${relative(top, real)}/`])
  if (r.status === 1) refuse(`${want} is inside the target and version control does not ignore it: use a path outside ${top}, or ignore the whole directory`)
  if (r.status !== 0) refuse(`could not ask git whether ${want} is ignored: ${tail(r.out, 2)}`)
}

function newRunDir(out, f) {
  if (out) {
    const want = resolve(out)
    if (lexists(want)) refuse(`${want} already exists: a full audit writes to a new directory`)
    placeRefusal(want, f.top, f.common)
    mkdirSync(dirname(want), { recursive: true })
    mkdirSync(want)
    return { runDir: want, runId: basename(want) }
  }
  const parent = join(f.common, 'security-audit')
  placeRefusal(parent, f.top, f.common)
  mkdirSync(parent, { recursive: true })
  return claimRunDir(parent, nextRunNumber(parent))
}

// One more than the highest run-<N> in `parent` (anything named like one counts, so no number is reused).
export function nextRunNumber(parent) {
  const numbers = readdirSync(parent).filter(n => /^run-[1-9][0-9]*$/.test(n)).map(n => Number(n.slice(4)))
  return Math.max(0, ...numbers) + 1
}

// mkdir without recursive is the claim: a second init racing for the same number gets EEXIST and takes the next.
export function claimRunDir(parent, start) {
  for (let n = start; ; n++) {
    try { mkdirSync(join(parent, `run-${n}`)); return { runDir: join(parent, `run-${n}`), runId: `run-${n}` } } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
}

// ---------- the snapshot ----------
// The committed `commit`, exactly as git stores it, in `dir` (which must not exist): read into a private index
// and checked out with checkout-index, so the target is never touched. Not evidence.mjs's call as it stands:
// checkout-index applies .gitattributes from the WORKING TREE (eol, working-tree-encoding, filters), so the
// bytes would depend on uncommitted files; --attr-source=<empty tree> and core.autocrlf=false turn that off.
export function exportTree(repo, commit, dir) {
  mkdirSync(dir)
  const index = join(dirname(dir), `.index-${process.pid}`)
  const env = buildEnv({ GIT_INDEX_FILE: index })
  try {
    const read = git(repo, ['read-tree', commit], { env })
    if (!read.ok) throw new Error(`reading ${commit} failed: ${tail(read.out, 3)}`)
    const out = git(repo, ['-c', 'core.autocrlf=false', `--attr-source=${EMPTY_TREE}`, 'checkout-index', '-a', '-f', `--prefix=${dir}/`], { env })
    if (!out.ok) throw new Error(`checking out ${commit} failed: ${tail(out.out, 3)}`)
  } finally {
    rmSync(index, { force: true })
  }
  const skipped = []
  const ls = git(repo, ['ls-tree', '-r', '-z', commit])
  if (!ls.ok) throw new Error(`listing ${commit} failed: ${tail(ls.out, 3)}`)
  for (const entry of ls.stdout.split('\0')) if (entry.startsWith('160000 ')) skipped.push({ path: entry.slice(entry.indexOf('\t') + 1), kind: 'submodule' })
  return { ...sealTree(dir, skipped), skipped }
}

// Leaves tree/ with regular files and directories only, none writable. A committed symlink is not kept: an agent
// that can Read would follow it out of the snapshot (and chmod would follow it too, onto someone else's file).
function sealTree(root, skipped) {
  const stats = { files: 0, bytes: 0 }
  const visit = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else if (e.isFile()) { const st = lstatSync(p); stats.files += 1; stats.bytes += st.size; chmodSync(p, st.mode & 0o555) }
      else {
        skipped.push({ path: relative(root, p), kind: e.isSymbolicLink() ? 'symlink' : 'special', ...(e.isSymbolicLink() && { target: readlinkSync(p) }) })
        unlinkSync(p)
      }
    }
    chmodSync(dir, lstatSync(dir).mode & 0o555)   // last: a sealed directory cannot lose the entries above
  }
  visit(root)
  return stats
}

// Undoes sealTree so a run directory can be deleted.
export function makeWritable(dir) {
  if (!lexists(dir)) return
  const visit = d => {
    chmodSync(d, lstatSync(d).mode | 0o700)
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) visit(join(d, e.name))
  }
  visit(dir)
}

// ---------- the budget ----------
// A budget is a maximum number of agent invocations (SKILL.md, "Cost budget"). These are upstream's reason strings,
// character for character; tests read each one back out of the vendored text.
export const REASONS = Object.freeze({
  fund: 'budget_cannot_fund_reconnaissance_and_reserves',    // the strict gate before any recon agent: no agent runs, the run is incomplete
  reserve: 'budget_cannot_reserve_critics_and_validation',   // a wave (or a focused recon agent) the reserves leave no room for: its units are deferred
  critic: 'critic_budget_exhausted',                         // the final critic's reserve is gone: run incomplete, planned work deferred
  validation: 'validation_budget_exhausted',                 // candidates outnumber the validation reserve: run incomplete
  quick: 'quick_profile_final_critic',                       // quick's accepted discoveries and reassignments, deferred
})
export const RECON_CALLS = 4
// Critics the gate reserves: quick, its one final post-wave critic; standard and deep, a post-wave critic plus a
// distinct final-clean critic.
export const criticReserve = profile => { if (!KNOWN_PROFILES.includes(profile)) throw new TypeError(`unknown profile ${JSON.stringify(profile)}`); return profile === 'quick' ? 1 : 2 }
export const minimumBudget = profile => RECON_CALLS + criticReserve(profile) + 1   // + at least one verifier call
const checkBudget = b => { if (b !== null && !(Number.isSafeInteger(b) && b >= 0)) throw new TypeError(`a budget is null or a non-negative integer, not ${JSON.stringify(b)}`); return b }

// The strict gate, applied before any reconnaissance agent. An unset budget (null) is never gated.
export function budgetGate(profile, budget) {
  const minimum = minimumBudget(profile)
  const ok = checkBudget(budget) === null || budget >= minimum
  return { ok, minimum, reason: ok ? null : REASONS.fund }
}

// Verifier cost to hold back: about 1 or 2 agents per expected candidate (quick: 1, one verifier does both
// phases), and when the candidates are unknown 30% of the balance after the critic reserve. Rounding up is my reading.
export function validationReserve(profile, balanceAfterCritics, expectedCandidates = null) {
  if (expectedCandidates === null) return Math.max(1, Math.ceil(0.3 * balanceAfterCritics))
  return Math.max(1, expectedCandidates * (profile === 'quick' ? 1 : 2))
}

// Hunters a wave may launch: what remains after the post-wave critic, the retained final-clean critic and the
// validation reserve (HUNTING.md, "A budget bounds it the same way"). No hunter fits: launch none, defer the
// wave's planned units with REASONS.reserve. My reading: zero room counts as "do not fit", even when the reserves
// themselves exactly fit.
export function waveAllowance(profile, remaining, expectedCandidates = null) {
  const critics = criticReserve(profile)
  const validation = validationReserve(profile, Math.max(0, remaining - critics), expectedCandidates)
  const hunters = Math.max(0, remaining - critics - validation)
  return { critics, validation, hunters, reason: hunters === 0 ? REASONS.reserve : null }
}

// ---------- earlier runs ----------
const RUN_NAME = /^run-[1-9][0-9]*$/
const str = v => (typeof v === 'string' ? v : null)

function fileVerdict(file, validate) {
  if (!lexists(file)) return { state: 'missing', last_line: null }
  try { const r = validate(file); return { state: r.valid ? 'pass' : 'fail', last_line: r.lastLine } } catch (e) { return { state: 'error', last_line: e.message } }
}

// What one earlier run is worth: both upstream validators on its files. A missing ledger or a failing file makes it
// incompatible. A missing findings.json does not: a run that stopped before Phase 4 never wrote one.
function describePrior(path, source, repo) {
  let m
  try { m = readJson(join(path, 'run-metadata.json')) } catch { m = undefined }
  if (typeof m !== 'object' || m === null) m = {}
  const ledger = fileVerdict(join(path, 'coverage-ledger.json'), validateLedgerFile)
  const findings = fileVerdict(join(path, 'findings.json'), validateFindingsFile)
  const reasons = []
  if (ledger.state !== 'pass') reasons.push(ledger.state === 'missing' ? 'coverage-ledger.json is missing' : `coverage-ledger.json did not validate: ${ledger.last_line}`)
  if (findings.state === 'fail' || findings.state === 'error') reasons.push(`findings.json did not validate: ${findings.last_line}`)
  if (str(m.repo) && m.repo !== repo) reasons.push(`it audited a different repository (${m.repo})`)
  return {
    path, run_id: basename(path), number: RUN_NAME.test(basename(path)) ? Number(basename(path).slice(4)) : null, source,
    run_status: str(m.run_status), profile: str(m.profile), scope_paths: Array.isArray(m.scope_paths) ? m.scope_paths : null,
    repo: str(m.repo), source_commit: str(m.source_ref?.commit), ledger, findings, compatible: reasons.length === 0, reasons,
  }
}

// run-<N> directories beside the claimed one (numerically), then each --prior directory not already among them.
export function discoverPriors(parent, current, explicit, repo) {
  const found = new Map()
  const own = lexists(parent) ? readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory() && RUN_NAME.test(e.name)) : []
  for (const e of own.sort((a, b) => Number(a.name.slice(4)) - Number(b.name.slice(4)))) found.set(realpathSync(join(parent, e.name)), 'default')
  for (const dir of explicit) if (!found.has(realpathSync(dir))) found.set(realpathSync(dir), '--prior')
  found.delete(realpathSync(current))
  return [...found].map(([path, source]) => describePrior(path, source, repo))
}

// ---------- the next step ----------
// The ledger's eight states, as the state table in RECONNAISSANCE.md and the validator's STATUSES list them.
export const STATUSES = ['planned', 'not_applicable', 'out_of_scope', 'in_progress', 'covered', 'candidate', 'blocked', 'deferred']
// Who runs each step: a Workflow stage (the session starts it) or a helper command.
export const RUNNERS = {
  recon: 'workflow', seed: 'helper', 'plan-wave': 'helper', hunt: 'workflow', 'merge-wave': 'helper', critic: 'workflow', mint: 'workflow',
  'apply-critic': 'helper', consolidate: 'workflow', validate: 'workflow', 'write-findings': 'helper', verify: 'workflow', report: 'helper',
}
const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min
const isStr = v => typeof v === 'string' && v !== ''

export function countStatuses(ledger) {
  if (!Array.isArray(ledger)) refuse('coverage-ledger.json is not an array of units')
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]))
  ledger.forEach((u, i) => {
    if (typeof u !== 'object' || u === null || typeof u.status !== 'string' || !Object.hasOwn(counts, u.status)) refuse(`coverage-ledger.json unit ${i} has no known status (got ${JSON.stringify(u?.status)}; upstream's are ${STATUSES.join(', ')})`)
    counts[u.status] += 1
  })
  return counts
}
const candidateFingerprints = ledger => new Set(ledger.filter(u => u.status === 'candidate').flatMap(u => (Array.isArray(u.result_fingerprints) ? u.result_fingerprints.filter(isStr) : [])))

// The one next step, from what is on disk: the last saved step, the ledger's unit states, the findings records.
// `ledger` and `findings` are undefined when the file does not exist. Throws a refusal when disk is inconsistent.
export function nextStep({ meta, state, ledger, findings }) {
  const go = (step, extra = {}) => ({ step, ...extra })
  if (state.last === 'report') {
    if (meta.run_status === 'in_progress') refuse('the report is written but run_status is still in_progress: a finished run is complete or incomplete')
    return go('done', { status: meta.run_status, reason: meta.incomplete_reason })
  }
  if (meta.run_status === 'incomplete') return go('report', { reason: meta.incomplete_reason })   // terminal state (b): disclose the gap
  const needLedger = () => { if (ledger === undefined) refuse(`coverage-ledger.json is missing after ${state.last}`); return countStatuses(ledger) }
  const coverageDone = () => {   // after the final-clean critic accepted nothing: validate what hunting produced
    const candidates = candidateFingerprints(ledger).size
    return candidates === 0 ? go('write-findings') : candidates === 1 ? go('validate') : go('consolidate')   // one candidate has nothing to group
  }
  switch (state.last) {
    case 'init': return go('recon')
    case 'recon': return go('seed')
    case 'hunt': return go('merge-wave', { wave: state.wave })
    case 'merge-wave': {
      const c = needLedger()
      if (c.in_progress > 0) refuse(`${c.in_progress} unit(s) are still in_progress after merge-wave: a merged wave leaves none`)
      return go('critic', { kind: 'post-wave', wave: state.wave })
    }
    case 'critic': return go('mint', { wave: state.wave })
    case 'mint': return go('apply-critic', { wave: state.wave })
    case 'seed': case 'plan-wave': case 'apply-critic': {
      const c = needLedger()
      if (state.last === 'apply-critic' && state.critic_kind === null) refuse('a critic result was applied but stage-state.json has no critic_kind')
      // Planned but not merged: run (or re-run) the wave. After seed or apply-critic, plan-wave died before saving its
      // step, so the wave it planned is the next one.
      if (c.in_progress > 0) return go('hunt', { wave: state.last === 'plan-wave' ? state.wave : state.wave + 1 })
      if (state.last === 'plan-wave' && c.planned > 0) refuse(`plan-wave left ${c.planned} unit(s) planned and assigned none: units the budget cannot reach are deferred`)
      if (c.planned > 0) return go('plan-wave', { wave: state.wave + 1 })
      if (state.last === 'apply-critic' && state.critic_kind === 'final-clean') return coverageDone()
      return go('critic', { kind: 'final-clean', wave: state.wave })        // nothing left to hunt: the retained final-clean critic
    }
    case 'consolidate': return go('validate')
    case 'validate': return go('write-findings')
    case 'write-findings': {
      if (!Array.isArray(findings)) refuse('findings.json is missing or not an array after write-findings')
      return findings.some(r => r?.verdict === 'confirmed' || r?.verdict === 'needs_validation') ? go('verify') : go('report')
    }
    case 'verify': return go('report')
    default: return refuse(`unknown step ${JSON.stringify(state.last)}`)
  }
}

const oneLine = v => String(v).replace(/\s+/g, ' ').trim()
export function formatNext(n) {
  if (n.step === 'done') return `NEXT: done status=${n.status}${n.reason ? ` reason=${oneLine(n.reason)}` : ''}`
  const fields = { run: RUNNERS[n.step], kind: n.kind, wave: n.wave, reason: n.reason }
  return `NEXT: ${n.step} ${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${oneLine(v)}`).join(' ')}`
}

// ---------- reading a run back ----------
export function loadRun(runDir) {
  const meta = readJson(join(runDir, 'run-metadata.json'))
  if (meta === undefined) refuse(`${runDir} has no run-metadata.json: it is not a run directory`)
  if (typeof meta !== 'object' || meta === null || !RUN_STATUSES.includes(meta.run_status)) refuse(`${runDir}/run-metadata.json has no valid run_status (${RUN_STATUSES.join(', ')})`)
  const state = readJson(join(runDir, 'stage-state.json'))
  if (state === undefined) refuse(`${runDir} has no stage-state.json`)
  if (typeof state !== 'object' || state === null || state.version !== 1 || !STEPS.includes(state.last) || !isInt(state.wave) || ![null, 'post-wave', 'final-clean'].includes(state.critic_kind)) {
    refuse('stage-state.json is not { version: 1, last: <step>, wave: <integer>, critic_kind: null | post-wave | final-clean }')
  }
  return { meta, state, ledger: readJson(join(runDir, 'coverage-ledger.json')), findings: readJson(join(runDir, 'findings.json')) }
}

function statusLines(runDir) {
  const run = loadRun(runDir)
  const { meta, state, ledger, findings } = run
  const tally = (items, keys, of) => keys.map(k => `${k} ${items.filter(i => of(i) === k).length}`).join(', ')
  const spent = `${meta.agents_spent}${meta.budget === null ? ' (no budget set)' : ` of ${meta.budget} (${Math.max(0, meta.budget - meta.agents_spent)} left)`}`
  let next
  try { next = formatNext(nextStep(run)) } catch (e) { next = `NEXT: FAIL ${e.message}` }
  const priors = readJson(join(runDir, 'prior-runs.json'))
  const events = lexists(join(runDir, 'events.jsonl')) ? readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
  return [
    `run ${meta.run_id} (${meta.repo}): profile ${meta.profile}, ${meta.run_status}${meta.incomplete_reason ? ` (${meta.incomplete_reason})` : ''}`,
    `source: ${str(meta.source_ref?.commit)?.slice(0, 12)}${meta.source_ref?.dirty ? ' (the working tree had uncommitted changes, not audited)' : ''}`,
    `last step: ${state.last}, wave ${state.wave}`,
    `ledger: ${Array.isArray(ledger) ? `${ledger.length} units: ${tally(ledger, STATUSES, u => u?.status)}` : 'not written yet'}`,
    `findings: ${Array.isArray(findings) ? `${findings.length} records: ${tally(findings, ['confirmed', 'needs_validation', 'rejected'], r => r?.verdict)}` : 'not written yet'}`,
    `agents: ${spent}`,
    `earlier runs: ${Array.isArray(priors) ? `${priors.length} found, ${priors.filter(p => p.compatible).length} compatible` : 'not recorded'}`,
    `events: ${events}`,
    next,
  ]
}

// ---------- check ----------
function metadataProblems(m) {
  const p = []
  const need = (ok, what) => { if (!ok) p.push(`run-metadata.json: ${what}`) }
  need(isStr(m.run_id) && isStr(m.repo) && isStr(m.target), 'run_id, repo and target must be non-empty strings')
  need(/^[0-9a-f]{40}$/.test(m.source_ref?.commit) && typeof m.source_ref?.dirty === 'boolean', 'source_ref needs a 40-hex commit and a boolean dirty')
  need(SUPPORTED_PROFILES.includes(m.profile), `profile must be one of ${SUPPORTED_PROFILES.join(', ')}`)
  need(Array.isArray(m.scope_paths) && m.scope_paths.every(isSafeRelativePath), 'scope_paths must be safe repository-relative paths')
  need(m.budget === null || isInt(m.budget), 'budget must be null or a non-negative integer')
  need(m.execution_policy === EXECUTION_POLICY, `execution_policy must be "${EXECUTION_POLICY}"`)
  need(['none', 'sandboxed'].includes(m.execution_capability) && Array.isArray(m.execution_blockers) && (m.execution_capability === 'sandboxed' || m.execution_blockers.length > 0), 'execution_capability must be none (with its blockers) or sandboxed')
  need(Array.isArray(m.selected_companion_files) && Array.isArray(m.prior_run_paths), 'selected_companion_files and prior_run_paths must be arrays')
  need(Object.keys(SHARED_FILE_OWNERS).every(f => isStr(m.shared_file_owners?.[f])), 'shared_file_owners must name an owner for every shared file')
  need(isInt(m.limits?.max_parallel, 1) && m.limits.max_parallel <= 16 && isInt(m.limits?.max_units_per_hunter, 1), 'limits.max_parallel is 1-16 and limits.max_units_per_hunter at least 1')
  need(isInt(m.agents_spent), 'agents_spent must be a non-negative integer')
  need((m.run_status === 'incomplete') === isStr(m.incomplete_reason), 'incomplete_reason is set exactly when run_status is incomplete')
  need(m.budget === null || !isInt(m.agents_spent) || m.agents_spent <= m.budget || m.run_status === 'incomplete', `${m.agents_spent} agents spent against a budget of ${m.budget}, and the run is not marked incomplete`)
  return p
}

function treeProblems(runDir, meta) {
  const root = join(runDir, 'tree')
  if (!lexists(root)) return meta.incomplete_reason === REASONS.fund ? [] : ['tree/ is missing']   // that refusal ran before the snapshot
  const bad = []
  const visit = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name)
      if (!e.isDirectory() && !e.isFile()) bad.push(`${relative(root, path)} is neither a file nor a directory`)
      else if (lstatSync(path).mode & 0o222) bad.push(`${relative(root, path)} is writable`)
      if (e.isDirectory()) visit(path)
    }
  }
  if (lstatSync(root).mode & 0o222) bad.push('tree/ is writable')
  visit(root)
  return bad.length ? [`tree/: ${bad.length} problem(s), first: ${bad[0]}`] : []
}

function eventsProblems(runDir) {
  let text
  try { text = readFileSync(join(runDir, 'events.jsonl'), 'utf8') } catch { return ['events.jsonl is missing'] }
  const lines = text.split('\n')
  const p = lines.pop() === '' ? [] : ['events.jsonl ends in the middle of a line']
  lines.forEach((line, i) => {
    let e
    try { e = JSON.parse(line) } catch { e = null }
    const ok = e && typeof e === 'object' && !Array.isArray(e) && isStr(e.at) && isStr(e.cmd) && isStr(e.stage) && isStr(e.result) && (e.reason === null || typeof e.reason === 'string')
    if (!ok) p.push(`events.jsonl line ${i + 1} is not an event object (at, cmd, stage, result, reason)`)
  })
  return p
}

// Everything wrong with a run directory; empty when it is sound. Upstream validates neither run-metadata.json nor
// stage-state.json nor events.jsonl, so this does; the ledger and findings go through upstream's own validators.
export function checkRun(runDir) {
  const run = loadRun(runDir)   // a refusal here is the one problem
  const problems = [...metadataProblems(run.meta), ...treeProblems(runDir, run.meta), ...eventsProblems(runDir)]
  for (const [file, validate, present] of [['coverage-ledger.json', validateLedgerFile, run.ledger], ['findings.json', validateFindingsFile, run.findings]]) {
    if (present === undefined) continue
    try { const r = validate(join(runDir, file)); if (!r.valid) problems.push(`${file}: ${r.lastLine}`) } catch (e) { problems.push(`${file}: ${e.message}`) }
  }
  try { nextStep(run) } catch (e) { problems.push(`next: ${e.message}`) }
  return problems
}

// ---------- init ----------
export function init(opts) {
  const started = Date.now()
  if (!opts.full) refuse('a full audit needs --full: it is the explicit request upstream requires, and guidance mode creates no run')
  if (!SUPPORTED_PROFILES.includes(opts.profile)) refuse(`profile ${opts.profile} is not available yet (only ${SUPPORTED_PROFILES.join(', ')}); it is never run as a different profile`)
  const f = repoFacts(opts.target)
  const scope_paths = scopePaths(f, opts.scope)
  for (const dir of opts.prior) if (!isDirectory(dir)) refuse(`--prior ${dir} is not a directory`)
  const { runDir, runId } = newRunDir(opts.out, f)
  try {
    const gate = budgetGate(opts.profile, opts.budget)   // before any snapshot or agent: a run that cannot be funded does no work
    const snapshot = gate.ok ? exportTree(f.top, f.commit, join(runDir, 'tree')) : null
    const priors = gate.ok ? discoverPriors(join(f.common, 'security-audit'), runDir, opts.prior, f.repo) : null
    const pin = JSON.parse(readFileSync(join(VENDOR_DIR, 'UPSTREAM.json'), 'utf8'))
    const metadata = {
      version: 1, run_id: runId, repo: f.repo, target: f.top,
      source_ref: { commit: f.commit, tree: f.tree, dirty: f.uncommitted.tracked + f.uncommitted.untracked > 0, uncommitted: f.uncommitted },
      profile: opts.profile, scope_paths, budget: opts.budget,
      limits: { max_parallel: opts.maxParallel, max_units_per_hunter: opts.maxUnitsPerHunter },
      execution_policy: EXECUTION_POLICY, execution_capability: 'none', execution_blockers: EXECUTION_BLOCKERS,
      selected_companion_files: [], prior_run_paths: (priors || []).map(p => p.path), shared_file_owners: SHARED_FILE_OWNERS,
      upstream_pin: { repo: pin.repo, commit: pin.commit },
      snapshot: snapshot && { path: 'tree', files: snapshot.files, bytes: snapshot.bytes, skipped_total: snapshot.skipped.length, skipped: snapshot.skipped.slice(0, MAX_SKIPPED_LISTED) },
      agents_spent: 0, agents_planned: null, run_status: gate.ok ? 'in_progress' : 'incomplete', incomplete_reason: gate.reason, created: new Date().toISOString(),
    }
    writeJson(join(runDir, 'run-metadata.json'), metadata)
    if (priors) writeJson(join(runDir, 'prior-runs.json'), priors)
    advanceState(runDir, 'init')
    appendEvent(runDir, {
      cmd: 'init', stage: 'init', result: gate.ok ? 'ok' : 'refused', reason: gate.reason, duration_ms: Date.now() - started,
      counts: { files: snapshot?.files ?? 0, skipped: snapshot?.skipped.length ?? 0, prior_runs: priors?.length ?? 0 },
    })
    return { runDir, metadata, gate, priors: priors || [] }
  } catch (e) {
    makeWritable(runDir)
    rmSync(runDir, { recursive: true, force: true })   // ours: this call created it
    throw e
  }
}

const isDirectory = p => { try { return statSync(p).isDirectory() } catch { return false } }

// ---------- command line ----------
const INT = /^(0|[1-9][0-9]*)$/
const USAGE = `usage: audit-run.mjs init [<target>] --full [--out <dir>] [--profile standard] [--scope <path,...>] [--budget N] [--prior <run dir>]... [--max-parallel N] [--max-units-per-hunter N]
       audit-run.mjs next|status|check <run dir>`
// flag -> [option, parse, repeatable]; a parse error is a Usage error.
const int = (min, max) => v => { if (!INT.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Usage(); return Math.min(Number(v), max) }
const FLAGS = {
  '--out': ['out', v => v],
  '--profile': ['profile', v => { if (!KNOWN_PROFILES.includes(v)) throw new Usage(); return v }],
  '--scope': ['scope', v => { const l = v.split(','); if (l.some(p => p === '')) throw new Usage(); return l }],
  '--budget': ['budget', int(0, Infinity)],
  '--prior': ['prior', v => resolve(v), true],
  '--max-parallel': ['maxParallel', int(1, 16)],
  '--max-units-per-hunter': ['maxUnitsPerHunter', int(1, Infinity)],
}

export function parseInitArgs(argv) {
  const o = { target: null, full: false, out: null, profile: 'standard', scope: [], budget: null, prior: [], ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--full') o.full = true
    else if (Object.hasOwn(FLAGS, a)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Usage()
      const [option, parse, repeatable] = FLAGS[a]
      if (repeatable) o[option].push(parse(v)); else o[option] = parse(v)
    } else if (a.startsWith('-') || o.target !== null) throw new Usage()
    else o.target = a
  }
  o.target = resolve(o.target ?? '.')
  return o
}

function runInit(argv) {
  const { runDir, metadata, gate, priors } = init(parseInitArgs(argv))
  const { source_ref: s, snapshot } = metadata
  if (!gate.ok) {
    const c = criticReserve(metadata.profile)
    return refuse(`${gate.reason}: --budget ${metadata.budget} cannot fund the ${gate.minimum} calls profile ${metadata.profile} needs first (${RECON_CALLS} reconnaissance, ${c} critic${c === 1 ? '' : 's'}, 1 verifier); no agent was launched. Give a larger budget, a narrower --scope or a different profile; as it stands ${runDir} is recorded incomplete`)
  }
  console.log(runDir)
  if (s.dirty) console.log(`note: the working tree has uncommitted changes (${s.uncommitted.tracked} tracked, ${s.uncommitted.untracked} untracked); only the committed snapshot ${s.commit.slice(0, 12)} is audited`)
  if (snapshot.skipped_total) console.log(`note: ${snapshot.skipped_total} symlink(s) and submodule(s) are not in tree/ (listed in run-metadata.json)`)
  for (const p of priors.filter(p => !p.compatible).slice(0, 5)) console.log(`note: earlier run ${p.run_id} is incompatible (${p.reasons[0]}); it is recorded in prior-runs.json, never treated as empty coverage`)
  console.log(`AUDIT: OK run=${metadata.run_id} profile=${metadata.profile} commit=${s.commit.slice(0, 12)} files=${snapshot.files} earlier_runs=${priors.length} compatible=${priors.filter(p => p.compatible).length}`)
  return 0
}

function runOnRun(cmd, argv) {
  if (argv.length !== 1) throw new Usage()
  const runDir = resolve(argv[0])
  if (cmd === 'next') { console.log(formatNext(nextStep(loadRun(runDir)))); return 0 }
  if (cmd === 'status') { const lines = statusLines(runDir); console.log(lines.join('\n')); return 0 }
  const problems = checkRun(runDir)
  for (const p of problems) console.log(`check: ${p}`)
  if (problems.length) return refuse(`${runDir} has ${problems.length} problem(s)`)
  console.log(`AUDIT: OK ${runDir} passes check`)
  return 0
}

export function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'init') return runInit(rest)
    if (['next', 'status', 'check'].includes(cmd)) return runOnRun(cmd, rest)
    throw new Usage()
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    console.log(`${cmd === 'next' ? 'NEXT' : 'AUDIT'}: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
