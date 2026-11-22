#!/usr/bin/env node
// The /blueprint approve CLI (spec/contracts/codex-parity-cp-04d.md).
//
//   node blueprint-approve.mjs <show|approve> --args-file <absolute path>
//
// SKILL.md section 6 (the one approval) as one command. `show` prints the compact
// design and backlog report, ending with approvalSha256 (the sha256 of run3.json).
// `approve` takes that hash back, creates integration/<app>, writes the docs with
// write-docs.mjs and commits them. A failure after the branch is created is rolled
// back. It makes no model call, runs no graph, and never pushes, fetches or merges.
//
// Synchronous. Every git call is `git -C <repo> ...` with an argv array and no shell.
// On success the output is the report (show) or one JSON line (approve). On failure
// stdout is empty and stderr is exactly `{"error":"<CODE>"}`: no message, path, args
// file content, state content, git output or write-docs output is ever printed.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES, freshness, readArgsFile, readRun, readState, redactSecrets, resolveStateDir } from './blueprint-state.mjs'
import { BACKLOG, KNOWLEDGE_MAP, designDoc, main as writeDocs } from './write-docs.mjs'

export const BLUEPRINT_APPROVE_CODES = Object.freeze(Object.fromEntries([
  'INVALID_ARGS', 'NOT_A_REPO', 'MISSING', 'MALFORMED', 'STALE', 'NOT_DESIGN_READY', 'NOT_BACKLOG_READY', 'INVALID_APP',
  'APPROVAL_MISMATCH', 'STAGED_CHANGES', 'BRANCH_EXISTS', 'TARGET_INVALID', 'COMMIT_FAILED', 'GIT_FAILED',
  'WRITE_DOCS_FAILED', 'IO_ERROR', 'ROLLBACK_FAILED', 'UNEXPECTED_COMMIT_PATHS',
].map(code => [code, code])))

const VERBS = ['show', 'approve']
const ALLOWED_KEYS = Object.freeze({ show: ['repo'], approve: ['repo', 'approvalSha256'] })
// backlog.mjs's app rule.
const APP_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const WRITE_DOCS_PREFIX = 'write-docs: wrote '
const HEADS = 'refs/heads/'
const DOCS_DIRS = ['docs', 'docs/blueprint']
// Never follow a final symlink; O_NONBLOCK so a FIFO cannot hang a read.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const RESTORE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

// ---------------------------------------------------------------- errors

// A refusal or failure of this CLI: its code and the exit it reports. No message
// beyond the code, and no `cause`.
class Refusal extends Error {
  constructor(code, exit) {
    super(`Blueprint approve: ${code}.`)
    this.code = code
    this.exit = exit
  }
}
const refuse = (code, exit) => new Refusal(code, exit)

// A missing entry, or a path component that is not a directory: nothing is there.
const isAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

// A CP-04a error from a state read: MISSING and MALFORMED pass through, any other
// code (or a throw that is not CP-04a's) is IO_ERROR.
function stateError(error) {
  const code = error?.code === 'MISSING' || error?.code === 'MALFORMED' ? error.code : 'IO_ERROR'
  return refuse(code, 2)
}

// ---------------------------------------------------------------- git

// `git -C <repo> ...args` from PATH with the caller's environment. stdout is piped
// only when the caller parses it; stderr is never kept, so a chatty hook cannot fill
// a buffer. Returns { status, stdout }; status is null when git could not run.
function git(repo, args, { capture = false } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', shell: false, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
  })
  if (result.error) return { status: null, stdout: '' }
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' }
}

// One trailing newline removed, nothing else.
const chompOne = text => (text.endsWith('\n') ? text.slice(0, -1) : text)

// ---------------------------------------------------------------- files

// Every byte of a regular file, never following a final symlink. Throws on any failure,
// with the raw fs error (the caller maps it to a code and never prints it).
function readRegularFile(path) {
  const fd = openSync(path, READ_FLAGS)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
    const chunks = []
    const chunk = Buffer.alloc(65536)
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) chunks.push(Buffer.from(chunk.subarray(0, n)))
    return Buffer.concat(chunks)
  } finally {
    closeSync(fd)
  }
}

// lstat, or null when nothing is there. Any other failure throws.
function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

// ---------------------------------------------------------------- argv and args file

// argv is exactly: the verb, `--args-file`, the path. Returns { verb, repo, args }.
function parseInput(argv) {
  if (argv.length !== 3 || !VERBS.includes(argv[0]) || argv[1] !== '--args-file') throw refuse('INVALID_ARGS', 1)
  const verb = argv[0]
  let args
  try {
    args = readArgsFile(argv[2], ALLOWED_KEYS[verb])
  } catch {
    throw refuse('INVALID_ARGS', 1)
  }
  const { repo } = args
  if (typeof repo !== 'string' || repo.includes('\0') || !isAbsolute(repo)) throw refuse('INVALID_ARGS', 1)
  return { verb, repo, args }
}

// ---------------------------------------------------------------- the checks both verbs run

// Checks 1 to 7 in order; the first refusal wins. Returns what show and approve need.
function runChecks(repo) {
  // 1. Repo: git's top level must be this exact directory.
  const top = git(repo, ['rev-parse', '--show-toplevel'], { capture: true })
  if (top.status !== 0) throw refuse('NOT_A_REPO', 2)
  let real
  try { real = realpathSync(repo) } catch { throw refuse('NOT_A_REPO', 2) }
  if (chompOne(top.stdout) !== real) throw refuse('NOT_A_REPO', 2)

  // 2. State directory.
  let dir
  try { dir = resolveStateDir(repo) } catch { throw refuse('NOT_A_REPO', 2) }

  // 3. Read.
  let state, run2, run3
  try {
    state = readState(dir)
    run2 = readRun(dir, 2)
    run3 = readRun(dir, 3)
  } catch (error) {
    throw stateError(error)
  }

  // 4. Fresh.
  let fresh
  try { fresh = freshness(dir) } catch { throw refuse('IO_ERROR', 2) }
  if (fresh.design !== 'fresh' || fresh.backlog !== 'fresh') throw refuse('STALE', 2)

  // 5. Ready.
  if (run2.status !== 'design-ready') throw refuse('NOT_DESIGN_READY', 2)
  if (run3.status !== 'backlog-ready') throw refuse('NOT_BACKLOG_READY', 2)

  // 6. App.
  const app = run3.backlog.app
  if (typeof app !== 'string' || !APP_SLUG.test(app)) throw refuse('INVALID_APP', 2)

  // 7. Hash: run3.json's bytes, read once.
  let bytes
  try { bytes = readRegularFile(join(dir, FILES.run3)) } catch { throw refuse('IO_ERROR', 2) }
  const hash = createHash('sha256').update(bytes).digest('hex')

  return { dir, state, run2, run3, app, hash }
}

// ---------------------------------------------------------------- the report

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// A missing list (or anything that is not an array) is an empty list.
const list = value => (Array.isArray(value) ? value : [])
// A field of a list item; an item that is not an object has no fields.
const field = (item, key) => (item !== null && typeof item === 'object' ? item[key] : undefined)

// One value on one line: a string as is, null/undefined as '', anything else as
// JSON; then redacted, every whitespace run made one space, and trimmed.
function value(raw) {
  let text
  if (typeof raw === 'string') text = raw
  else if (raw === null || raw === undefined) text = ''
  else text = JSON.stringify(raw) ?? ''
  return redactSecrets(text).replace(/\s+/g, ' ').trim()
}
const orWord = (text, word) => (text === '' ? word : text)
// An id list: each item as a value, joined with ', '; an empty list prints `empty`.
const idList = (raw, empty = 'none') => (list(raw).length ? list(raw).map(value).join(', ') : empty)
// A section's lines, or the one line `- None.`.
const section = (items, line) => (items.length ? items.flatMap(line) : ['- None.'])

function moduleLines(m) {
  const lines = [`- ${value(field(m, 'id'))} ${value(field(m, 'name'))}: ${value(field(m, 'responsibility'))} (${idList(field(m, 'requirements'), 'no requirement')})`]
  if (field(m, 'boundary')) {
    const pick = field(m, 'pick')
    const others = list(field(m, 'shapes')).map(s => field(s, 'name')).filter(name => name !== pick)
    lines.push(`  Boundary: picked ${value(pick)} over ${idList(others)}`)
  }
  return lines
}

function noteLine(note) {
  if (!isPlainObject(note)) return `- ${value(note)}`
  const fix = value(note.fix)
  return `- ${value(note.issue)}${fix === '' ? '' : ` (fix: ${fix})`}`
}

function knowledgeLine(k, owners) {
  const id = field(k, 'id')
  const entry = owners.find(o => field(o, 'id') === id)
  return `- ${value(id)} ${value(field(k, 'knowledge'))}: owner ${orWord(value(field(k, 'owner')), 'none')}, built in ${orWord(value(field(entry, 'built_in')), 'none')}`
}

function sliceLine(s) {
  return `- ${value(field(s, 'id'))} ${value(field(s, 'title'))}: ${value(field(s, 'goal'))} (requirements: ${idList(field(s, 'requirements'))}; ` +
    `depends on: ${idList(field(s, 'depends_on'))}; criteria: ${list(field(s, 'acceptance')).length})`
}

function renderReport({ state, run2, run3, app, hash }) {
  const design = run2.design
  const owners = list(run3.owners)
  const lines = [
    `Blueprint approval: ${app}`,
    `Branch: integration/${app}`,
    `Summary: ${value(design.summary)}`,
    'Modules:',
    ...section(list(design.modules), moduleLines),
    'ADRs:',
    ...section(list(design.adrs), a => `- ${value(field(a, 'id'))} ${value(field(a, 'title'))}: ${value(field(a, 'decision'))}`),
    'Departures from the default stack:',
    ...section(list(design.departures), d => `- ${value(field(d, 'what'))} instead of ${value(field(d, 'default'))}`),
    'Knowledge:',
    ...section(list(design.knowledge), k => knowledgeLine(k, owners)),
    'Unverified premises:',
    ...section(list(design.premises).filter(p => field(p, 'status') === 'UNVERIFIED'),
      p => `- ${value(field(p, 'claim'))} (${orWord(value(field(p, 'evidence')), 'no evidence yet')})`),
    'Design notes:',
    ...section(list(run2.notes), noteLine),
    'Slices:',
    ...section(list(run3.backlog.slices), sliceLine),
    'Backlog notes:',
    ...section(list(run3.notes), noteLine),
    'Preflight still owed:',
    ...section(state.preflight.filter(p => p.have !== true), p => `- ${value(p.what)}`),
    `approvalSha256: ${hash}`,
  ]
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- approve, before the switch

// Steps 1 to 7. Every failure here is exit 2. Returns the place HEAD comes back to.
function prepare(repo, checked, args) {
  const { app } = checked
  const branch = `integration/${app}`

  // 1. Hash.
  if (typeof args.approvalSha256 !== 'string' || args.approvalSha256 !== checked.hash) throw refuse('APPROVAL_MISMATCH', 2)

  // 2. Nothing staged.
  const staged = git(repo, ['diff', '--cached', '--quiet']).status
  if (staged === 1) throw refuse('STAGED_CHANGES', 2)
  if (staged !== 0) throw refuse('GIT_FAILED', 2)

  // 3. New branch.
  const existing = git(repo, ['rev-parse', '--verify', '-q', `${HEADS}${branch}`]).status
  if (existing === 0) throw refuse('BRANCH_EXISTS', 2)
  if (existing !== 1) throw refuse('GIT_FAILED', 2)

  // 4. Targets: docs dirs absent or real directories, targets absent or regular files.
  try {
    for (const rel of DOCS_DIRS) {
      const stat = lstatOrNull(join(repo, rel))
      if (stat !== null && !stat.isDirectory()) throw refuse('TARGET_INVALID', 2)
    }
    for (const rel of targetsOf(app)) {
      const stat = lstatOrNull(join(repo, rel))
      if (stat !== null && !stat.isFile()) throw refuse('TARGET_INVALID', 2)
    }
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw refuse('IO_ERROR', 2)
  }

  // 5. Start commit in a repo with no commit yet. Hooks run.
  const head = git(repo, ['rev-parse', '-q', '--verify', 'HEAD']).status
  if (head === 1) {
    if (git(repo, ['commit', '--allow-empty', '-m', `blueprint: start ${app}`]).status !== 0) throw refuse('COMMIT_FAILED', 2)
  } else if (head !== 0) {
    throw refuse('GIT_FAILED', 2)
  }

  // 6. Where HEAD is: a branch (its short name) or a detached commit.
  const symbolic = git(repo, ['symbolic-ref', '-q', 'HEAD'], { capture: true })
  let place
  if (symbolic.status === 0) {
    const ref = chompOne(symbolic.stdout)
    if (!ref.startsWith(HEADS) || ref.length === HEADS.length || ref.includes('\n')) throw refuse('GIT_FAILED', 2)
    place = { branch: ref.slice(HEADS.length) }
  } else if (symbolic.status === 1) {
    const commit = git(repo, ['rev-parse', 'HEAD'], { capture: true })
    const id = chompOne(commit.stdout)
    if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) throw refuse('GIT_FAILED', 2)
    place = { commit: id }
  } else {
    throw refuse('GIT_FAILED', 2)
  }

  // 7. Switch. A refused switch created no branch, so nothing is deleted.
  if (git(repo, ['switch', '-c', branch]).status !== 0) throw refuse('GIT_FAILED', 2)
  return place
}

const targetsOf = app => [designDoc(app), BACKLOG, KNOWLEDGE_MAP]

// ---------------------------------------------------------------- approve, after the switch

// 8. Snapshot, filled in as it goes: a target is only in `files` once its bytes (or
// its absence) were recorded, and a directory only in `dirs` once its existence was.
// A rollback never acts on a target or directory it has no record of.
function takeSnapshot(repo, app, snapshot) {
  for (const rel of targetsOf(app)) {
    const path = join(repo, rel)
    const stat = lstatOrNull(path)
    if (stat === null) snapshot.files.set(rel, { absent: true })
    else snapshot.files.set(rel, { absent: false, bytes: readRegularFile(path), mode: stat.mode & 0o7777 })
  }
  for (const rel of DOCS_DIRS) snapshot.dirs.set(rel, lstatOrNull(join(repo, rel)) !== null)
}

// 9. write-docs in this process. Returns the paths it printed, or throws WRITE_DOCS_FAILED.
function runWriteDocs(repo, dir, app) {
  let result
  try {
    result = writeDocs([join(dir, FILES.run2), join(dir, FILES.run3), repo])
  } catch {
    throw refuse('WRITE_DOCS_FAILED', 3)
  }
  const out = result?.out
  if (result?.code !== 0 || typeof out !== 'string' || !out.startsWith(WRITE_DOCS_PREFIX)) throw refuse('WRITE_DOCS_FAILED', 3)
  const paths = out.slice(WRITE_DOCS_PREFIX.length).split(' ')
  const targets = targetsOf(app)
  if (!paths.every(p => targets.includes(p)) || new Set(paths).size !== paths.length) throw refuse('WRITE_DOCS_FAILED', 3)
  return paths
}

function restoreFile(path, record) {
  if (record.absent) {
    if (lstatOrNull(path) !== null) unlinkSync(path)
    return
  }
  const fd = openSync(path, RESTORE_FLAGS, record.mode)
  try {
    for (let at = 0; at < record.bytes.length;) at += writeSync(fd, record.bytes, at, record.bytes.length - at)
  } finally {
    closeSync(fd)
  }
}

// rmdir a directory the snapshot found absent, when it is now empty. Nothing there,
// or a directory with entries, is left as it is; anything else there is a failure.
function removeIfEmpty(path) {
  const stat = lstatOrNull(path)
  if (stat === null) return
  if (!stat.isDirectory()) throw new Error('not a directory')
  if (readdirSync(path).length === 0) rmdirSync(path)
}

// Every step runs, in order, even when an earlier one fails. Returns true when all succeeded.
function rollback(repo, app, { snapshot, printed, added, place }) {
  let ok = true
  const step = fn => {
    try {
      if (fn() === false) ok = false
    } catch {
      ok = false
    }
  }
  // 1. The index back to HEAD's entries for the printed paths.
  if (added) step(() => git(repo, ['reset', '-q', '--', ...printed]).status === 0)
  // 2. Each recorded target back to its snapshot.
  for (const [rel, record] of snapshot.files) step(() => restoreFile(join(repo, rel), record))
  // 3. docs/blueprint, then docs, when the snapshot found it absent.
  for (const rel of [...DOCS_DIRS].reverse()) {
    if (snapshot.dirs.get(rel) === false) step(() => removeIfEmpty(join(repo, rel)))
  }
  // 4. Back to the step 6 place.
  const back = place.branch !== undefined ? ['switch', place.branch] : ['switch', '--detach', place.commit]
  step(() => git(repo, back).status === 0)
  // 5. The new branch.
  step(() => git(repo, ['branch', '-D', `integration/${app}`]).status === 0)
  return ok
}

// Steps 8 to 10, rolled back on any failure. Returns the printed paths once committed.
function writeAndCommit(repo, checked, place) {
  const { app, dir } = checked
  const progress = { snapshot: { files: new Map(), dirs: new Map() }, printed: [], added: false, place }
  try {
    try { takeSnapshot(repo, app, progress.snapshot) } catch { throw refuse('IO_ERROR', 3) }
    progress.printed = runWriteDocs(repo, dir, app)
    progress.added = true
    if (git(repo, ['add', '--', ...progress.printed]).status !== 0) throw refuse('COMMIT_FAILED', 3)
    if (git(repo, ['commit', '-m', `blueprint: design and backlog for ${app}`]).status !== 0) throw refuse('COMMIT_FAILED', 3)
    return progress.printed
  } catch (error) {
    const failure = error instanceof Refusal ? error : refuse('IO_ERROR', 3)
    if (!rollback(repo, app, progress)) throw refuse('ROLLBACK_FAILED', 4)
    throw failure
  }
}

// Steps 11 and 12: no rollback once the commit exists.
function checkCommit(repo, printed) {
  const head = git(repo, ['rev-parse', 'HEAD'], { capture: true })
  const commit = chompOne(head.stdout)
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw refuse('GIT_FAILED', 3)
  const tree = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', `${commit}^`, commit], { capture: true })
  if (tree.status !== 0) throw refuse('GIT_FAILED', 3)
  const committed = tree.stdout.split('\0')
  if (committed.at(-1) === '') committed.pop()
  const same = committed.length === printed.length && new Set(committed).size === committed.length &&
    committed.every(p => printed.includes(p))
  if (!same) throw refuse('UNEXPECTED_COMMIT_PATHS', 4)
  return commit
}

function approve(repo, checked, args) {
  const place = prepare(repo, checked, args)
  const paths = writeAndCommit(repo, checked, place)
  const commit = checkCommit(repo, paths)
  return `${JSON.stringify({ branch: `integration/${checked.app}`, commit, paths })}\n`
}

// ---------------------------------------------------------------- CLI

// Returns { exit, stdout, stderr }. Any throw that is not a Refusal is IO_ERROR at
// exit 2: every step after the switch maps its own failures, so only a step before it
// can get here.
function run(argv) {
  try {
    const { verb, repo, args } = parseInput(argv)
    const checked = runChecks(repo)
    const stdout = verb === 'show' ? renderReport(checked) : approve(repo, checked, args)
    return { exit: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error instanceof Refusal ? error : refuse('IO_ERROR', 2)
    return { exit: failure.exit, stdout: '', stderr: `${JSON.stringify({ error: failure.code })}\n` }
  }
}

function isMainModule() {
  try {
    return typeof process.argv[1] === 'string' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  const { exit, stdout, stderr } = run(process.argv.slice(2))
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = exit
}
