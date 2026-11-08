// audit-fixtures.mjs - shared by the audit-run tests: a sandbox of throwaway git repos (removed at exit), and the
// audit-run.mjs command line. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, chmodSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { makeWritable, SAFE_GIT, advanceState } from '../skills/security-audit/audit-run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const AUDIT_RUN = join(here, '..', 'skills', 'security-audit', 'audit-run.mjs')
export const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

// Fixtures live in one sandbox, removed at exit: a sealed tree/ needs its write bits back first.
export const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'audit-run-test-')))
process.on('exit', () => { makeWritable(sandbox); rmSync(sandbox, { recursive: true, force: true }) })
let counter = 0
export const fresh = name => { const d = join(sandbox, `${name}-${++counter}`); mkdirSync(d); return d }

// The fixtures' own git calls run without hooks or fsmonitor, so only the code under test can trip a trap.
export const sh = (cwd, ...args) => {
  const r = spawnSync('git', [...SAFE_GIT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
export const put = (file, text, mode) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode) }
export const FILES = { 'src/app.js': 'export const a = 1\n', 'src/db.js': 'export const q = s => s\n', 'README.md': '# fixture\n' }
export function mkRepo(files = FILES, name = 'repo') {
  const dir = fresh(name)
  sh(dir, 'init', '-q', '-b', 'main')
  for (const [p, text] of Object.entries(files)) put(join(dir, p), text)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'base')
  return dir
}
export const init = (args, cwd = sandbox) => {
  const r = spawnSync(process.execPath, [AUDIT_RUN, 'init', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), runDir: lines[0], ok: r.status === 0 }
}
export const runsOf = repo => { const d = join(repo, '.git', 'security-audit'); return existsSync(d) ? readdirSync(d) : [] }
export const meta = runDir => JSON.parse(readFileSync(join(runDir, 'run-metadata.json'), 'utf8'))
export const listFiles = (root, dir = root) => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(root, join(dir, e.name)) : [join(dir, e.name).slice(root.length + 1)]))


// Any audit-run.mjs command: { status, stdout, stderr, last, lines }.
export const audit = (args, cwd = sandbox) => {
  const r = spawnSync(process.execPath, [AUDIT_RUN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), lines }
}

// A run directory at the point audit-ledger.mjs starts: init done, recon saved (so `next` says seed). { repo, runDir }.
export function newRun({ files = FILES, args = [], before = () => {} } = {}) {
  const repo = mkRepo(files)
  before(repo)   // where an earlier run is made, so this run finds it
  const r = init([repo, '--full', ...args])
  if (!r.ok) throw new Error(`init failed: ${r.stdout}${r.stderr}`)
  advanceState(r.runDir, 'recon')
  return { repo, runDir: r.runDir }
}

// audit-ledger.mjs on the command line: { status, stdout, stderr, last, lines }.
export const AUDIT_LEDGER = join(here, '..', 'skills', 'security-audit', 'audit-ledger.mjs')
export const ledgerCli = (args, cwd = sandbox) => {
  const r = spawnSync(process.execPath, [AUDIT_LEDGER, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), lines }
}
