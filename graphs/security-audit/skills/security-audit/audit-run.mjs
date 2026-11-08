#!/usr/bin/env node
// audit-run.mjs - a run's directory, state and gates for the security-audit graph. Upstream's text
// (vendor/cloudflare-security-audit/skills/security-audit/SKILL.md) is the authority for names and
// reason strings; nothing here paraphrases it.
//
//   node audit-run.mjs init [<target>] --full [--out <dir>] [--profile standard] [--scope <path,...>]
//                           [--max-parallel N] [--max-units-per-hunter N]
//
// init gates, then claims a new run directory (default <git common dir>/security-audit/run-<N>/, decision
// D4 A) and writes into it: tree/ (a read-only snapshot of the committed HEAD), run-metadata.json,
// stage-state.json, events.jsonl. Gates: --full given; target is a git working tree with a commit;
// profile supported; --scope paths safe and committed; --out new and either outside the target, under the
// git directory, or wholly ignored by version control. A refusal creates nothing.
//
// stage-state.json is { version: 1, last: <STEPS entry>, wave: <int>, critic_kind: null | 'post-wave' |
// 'final-clean', updated: <ISO time> }. `last` is the last step whose result is saved; the helper or the
// session that saves a step's result calls advanceState. critic_kind is set when a critic result is saved.
//
// Every line this prints ends the run of a command: "AUDIT: OK ..." and exit 0, "AUDIT: FAIL <reason>" and
// exit 1 (a gate refused or a check failed), or usage on stderr and exit 2.
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEnv, git as rawGit, tail } from '../../../build/skills/build-app/driver/proc.mjs'
import { VENDOR_DIR, isSafeRelativePath } from './upstream.mjs'

// Every git call here runs without the target's hooks or fsmonitor: both are config a repo may set with a
// relative path, which resolves inside the checkout, the code under audit. A local copy of the flags in
// graphs/hunt/skills/bughunt/evidence.mjs (decision D8 B); tests/audit-run.test.mjs fails if they drift.
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

export function advanceState(runDir, step, extra = {}) {
  if (!STEPS.includes(step)) throw new TypeError(`unknown step ${JSON.stringify(step)}`)
  let state = { wave: 0, critic_kind: null }
  try { state = { ...state, ...JSON.parse(readFileSync(join(runDir, 'stage-state.json'), 'utf8')) } } catch (e) { if (e.code !== 'ENOENT') throw e }
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

// ---------- init ----------
export function init(opts) {
  const started = Date.now()
  if (!opts.full) refuse('a full audit needs --full: it is the explicit request upstream requires, and guidance mode creates no run')
  if (!SUPPORTED_PROFILES.includes(opts.profile)) refuse(`profile ${opts.profile} is not available yet (only ${SUPPORTED_PROFILES.join(', ')}); it is never run as a different profile`)
  const f = repoFacts(opts.target)
  const scope_paths = scopePaths(f, opts.scope)
  const { runDir, runId } = newRunDir(opts.out, f)
  try {
    const snapshot = exportTree(f.top, f.commit, join(runDir, 'tree'))
    const pin = JSON.parse(readFileSync(join(VENDOR_DIR, 'UPSTREAM.json'), 'utf8'))
    const dirty = f.uncommitted.tracked + f.uncommitted.untracked > 0
    const metadata = {
      version: 1, run_id: runId, repo: f.repo, target: f.top,
      source_ref: { commit: f.commit, tree: f.tree, dirty, uncommitted: f.uncommitted },
      profile: opts.profile, scope_paths, budget: null,
      limits: { max_parallel: opts.maxParallel, max_units_per_hunter: opts.maxUnitsPerHunter },
      execution_policy: EXECUTION_POLICY, execution_capability: 'none', execution_blockers: EXECUTION_BLOCKERS,
      selected_companion_files: [], prior_run_paths: [], shared_file_owners: SHARED_FILE_OWNERS,
      upstream_pin: { repo: pin.repo, commit: pin.commit },
      snapshot: { path: 'tree', files: snapshot.files, bytes: snapshot.bytes, skipped_total: snapshot.skipped.length, skipped: snapshot.skipped.slice(0, MAX_SKIPPED_LISTED) },
      agents_spent: 0, agents_planned: null, run_status: 'in_progress', incomplete_reason: null, created: new Date().toISOString(),
    }
    writeJson(join(runDir, 'run-metadata.json'), metadata)
    advanceState(runDir, 'init')
    appendEvent(runDir, { cmd: 'init', stage: 'init', result: 'ok', duration_ms: Date.now() - started, counts: { files: snapshot.files, skipped: snapshot.skipped.length } })
    return { runDir, metadata }
  } catch (e) {
    makeWritable(runDir)
    rmSync(runDir, { recursive: true, force: true })   // ours: this call created it
    throw e
  }
}

// ---------- command line ----------
const INT = /^(0|[1-9][0-9]*)$/
const USAGE = 'usage: audit-run.mjs init [<target>] --full [--out <dir>] [--profile standard] [--scope <path,...>] [--max-parallel N] [--max-units-per-hunter N]'
// flag -> [option, parse]; a parse error is a Usage error.
const int = (min, max) => v => { if (!INT.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Usage(); return Math.min(Number(v), max) }
const FLAGS = {
  '--out': ['out', v => v],
  '--profile': ['profile', v => { if (!KNOWN_PROFILES.includes(v)) throw new Usage(); return v }],
  '--scope': ['scope', v => { const l = v.split(','); if (l.some(p => p === '')) throw new Usage(); return l }],
  '--max-parallel': ['maxParallel', int(1, 16)],
  '--max-units-per-hunter': ['maxUnitsPerHunter', int(1, Infinity)],
}

export function parseInitArgs(argv) {
  const o = { target: null, full: false, out: null, profile: 'standard', scope: [], ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--full') o.full = true
    else if (Object.hasOwn(FLAGS, a)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Usage()
      o[FLAGS[a][0]] = FLAGS[a][1](v)
    } else if (a.startsWith('-') || o.target !== null) throw new Usage()
    else o.target = a
  }
  o.target = resolve(o.target ?? '.')
  return o
}

function runInit(argv) {
  const opts = parseInitArgs(argv)
  const { runDir, metadata } = init(opts)
  const { source_ref: s, snapshot } = metadata
  console.log(runDir)
  if (s.dirty) console.log(`note: the working tree has uncommitted changes (${s.uncommitted.tracked} tracked, ${s.uncommitted.untracked} untracked); only the committed snapshot ${s.commit.slice(0, 12)} is audited`)
  if (snapshot.skipped_total) console.log(`note: ${snapshot.skipped_total} symlink(s) and submodule(s) are not in tree/ (listed in run-metadata.json)`)
  console.log(`AUDIT: OK run=${metadata.run_id} profile=${metadata.profile} commit=${s.commit.slice(0, 12)} files=${snapshot.files}`)
  return 0
}

export function main(argv) {
  try {
    if (argv[0] === 'init') return runInit(argv.slice(1))
    throw new Usage()
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    console.log(`AUDIT: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
