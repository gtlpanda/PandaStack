#!/usr/bin/env node
// intake.mjs - the deterministic first step of /bughunt. It resolves what to
// review (a pull request, a branch against its base, or a commit range), the
// exact commits, the changed files and hunks, and which lenses the change's own
// lines call for. It also checks out a detached analysis worktree at the head,
// so every agent reads the code under review, never whatever the user has
// checked out.
//   node intake.mjs <repo> [--pr <n> | --branch <name> | --range <base>..<head>] [--base <ref>] [--skip <glob>]...
// Writes <git common dir>/bughunt/<key>/intake.json and the worktree
// <git common dir>/bughunt/<key>/tree, prints the intake path, then
// INTAKE: OK|FAIL. Exit 0 ok, 1 fail, 2 usage.
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync, mkdtempSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { git as rawGit, run } from '../../../build/skills/build-app/driver/proc.mjs'
import { TEST_FILE } from '../../../build/skills/build-app/driver/checks.mjs'
import { defaultBase } from '../../../build/skills/build-app/driver/finish.mjs'

export const ALWAYS = ['logic', 'regression']
// No hooks or fsmonitor in any git call: a relative core.hooksPath or
// core.fsmonitor in the user's config resolves inside the checkout, which may be
// the PR's own code (the analysis worktree always is). Measured 2026-11-06: a
// committed fsmonitor script ran on `git status` without these flags.
const git = (dir, args, opts) => rawGit(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], opts)
const MAX_HITS = 5
const MAX_DESCRIPTION = 4000
// Only these non-code kinds may be skipped. A script or source file is always
// hunted, wherever it lives and however it is marked.
const SKIPPABLE = /\.(json|jsonl|ndjson|txt|log|md|csv|tsv|png|jpe?g|gif|webp|pdf|patch|diff|zip|gz|tgz|tar)$/i
const NOT_CODE = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf|lock)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i

// What in a change's own lines calls for each optional lens. Matched against
// code files only (never tests or docs), on added lines, and for `contract` on
// removed lines too: a deleted export is a contract change.
export const SIGNALS = {
  concurrency: {
    line: /\b(async|await|Promise\.(all|allSettled|race|any)|setTimeout|setInterval|setImmediate|nextTick|Mutex|Semaphore|lock|unlock|transaction|BEGIN|COMMIT|ROLLBACK|retry|retries|backoff|queue|worker|threading|asyncio|goroutine|go func|sync\.|atomic|concurrent|debounce|throttle)\b/i,
  },
  security: {
    line: /\b(auth\w*|permission\w*|roles?|admin|token|password|passwd|secret|credential\w*|session|cookie|jwt|bearer|exec|execSync|execFile|spawn|child_process|subprocess|os\.system|eval|shell|sql|query|SELECT|INSERT INTO|DELETE FROM|readFile\w*|writeFile\w*|createReadStream|sendFile|upload|deserializ\w*|pickle|yaml\.load|innerHTML|dangerouslySetInnerHTML|redirect|cors|csrf|crypto|hmac|encrypt\w*|decrypt\w*|sanitiz\w*)\b/i,
    path: /(^|\/)(auth|security|permissions?|middleware|login|session)/i,
  },
  errors: {
    line: /\b(try|catch|finally|throw|reject|except|raise|panic|recover|defer|close|dispose|cleanup|rollback|fallback|timeout)\b|\.catch\(|on\(['"]error/i,
  },
  contract: {
    line: /^\s*(export\s|module\.exports|exports\.|def\s|class\s|public\s|func\s|interface\s|type\s+\w+\s*=|@(Get|Post|Put|Delete|Patch)\b|router\.|app\.(get|post|put|delete|patch)\()|\b(JSON\.(parse|stringify)|serializ\w*|deserializ\w*|marshal|unmarshal|schema|proto)\b/i,
    removed: true,
    path: /(\.proto$|schema|openapi|swagger|\.d\.ts$|(^|\/)api\/|(^|\/)routes?\/|(^|\/)migrations?\/|\.graphql$)/i,
  },
}

// The readable part of a key: lowercase, safe in a path, starting with a
// letter or digit.
export function slug(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 48)
  return out || 'head'
}
// A ledger key for a branch or range: the slug plus a short hash of the exact
// name, so feat/x, feat-x, and FEAT-X never share a ledger or a worktree. Never
// a commit: a new head must find the same ledger.
export function nameKey(prefix, name) {
  return `${prefix}${slug(name)}-${createHash('sha1').update(String(name)).digest('hex').slice(0, 6)}`
}

export function parseArgs(argv) {
  const [repo, ...rest] = argv
  if (!repo || repo.startsWith('--')) throw new Error('usage')
  const opts = { repo, skip: [] }
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!['--pr', '--branch', '--range', '--base', '--skip'].includes(flag) || value === undefined || value.startsWith('--')) throw new Error('usage')
    if (flag === '--skip') {
      if (!value.trim() || value.length > 512 || /[\0\n]/.test(value)) throw new Error('usage')
      opts.skip.push(value)
    } else opts[flag.slice(2)] = value
  }
  if (['pr', 'branch', 'range'].filter(k => opts[k] !== undefined).length > 1) throw new Error('usage')
  if (opts.pr !== undefined && !/^[1-9][0-9]*$/.test(opts.pr)) throw new Error('usage')
  return opts
}

function must(r, what) {
  // A spawn error (ENOBUFS, ETIMEDOUT) explains the failure; partial output does not.
  if (!r.ok) throw new Error(`${what} failed: ${(r.error || r.out.trim() || `exit ${r.status}`).split('\n').slice(-3).join(' ')}`)
  return r.stdout.trim()
}
const commitOf = (repo, ref) => must(git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]), `resolving ${ref}`)
const hasCommit = (repo, sha) => git(repo, ['cat-file', '-e', `${sha}^{commit}`]).ok
// Prefer the remote-tracking branch, so the base is what the PR merges into.
function baseRef(repo, name) {
  if (name.startsWith('origin/')) return name
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok ? `origin/${name}` : name
}

// { kind, key, label, base, head, pr?, title?, url?, description? }
export function resolveTarget(repo, opts) {
  if (opts.pr !== undefined) {
    const out = must(run('gh', ['pr', 'view', opts.pr, '--json', 'number,title,body,baseRefName,headRefOid,url'], { cwd: repo }), `gh pr view ${opts.pr}`)
    let pr
    try { pr = JSON.parse(out) } catch { throw new Error(`gh pr view ${opts.pr} printed no JSON`) }
    if (!hasCommit(repo, pr.headRefOid)) must(git(repo, ['fetch', '--no-tags', '--quiet', 'origin', `pull/${pr.number}/head`]), `fetching PR #${pr.number}`)
    // A stale origin/<base> would put other people's merged work into the
    // review, so the base the PR merges into is refreshed first. Offline, the
    // local copy is used and the intake says so.
    const baseName = opts.base || pr.baseRefName
    const fetched = /^[A-Za-z0-9._/-]+$/.test(baseName) && !baseName.startsWith('origin/')
      ? git(repo, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`]).ok
      : false
    return {
      kind: 'pr', key: `pr-${pr.number}`, label: `PR #${pr.number}`, pr: pr.number, title: pr.title, url: pr.url,
      base: baseRef(repo, baseName), baseFetched: fetched, head: pr.headRefOid, description: String(pr.body || '').slice(0, MAX_DESCRIPTION),
    }
  }
  if (opts.range !== undefined) {
    const m = opts.range.match(/^(.+?)\.{2,3}(.+)$/)
    if (!m) throw new Error(`--range must look like <base>..<head>, got ${opts.range}`)
    return { kind: 'range', key: nameKey('range-', opts.range), label: `${m[1]}..${m[2]}`, base: m[1], head: m[2] }
  }
  let branch = opts.branch
  if (branch === undefined) branch = must(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'reading the current branch')
  const base = baseRef(repo, opts.base || defaultBase(repo))
  if (branch === 'HEAD') {
    const sha = commitOf(repo, 'HEAD')
    return { kind: 'detached', key: `detached-${sha.slice(0, 12)}`, label: `the detached HEAD at ${sha.slice(0, 12)}`, base, head: sha }
  }
  return { kind: 'branch', key: nameKey('', branch), label: `branch ${branch}`, base, head: branch }
}

// A path glob as a whole-path match: `*` and `?` stay within a path segment,
// `**` crosses segments, and `dir/**` matches everything below dir.
export function globRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Why a changed file is left out of the hunt, or null to hunt it. Skips are only
// ever declared: by the merge-base's .gitattributes (`declared`: path -> the
// attribute that marked it) or by the operator's --skip globs. Only non-code
// kinds qualify, whatever the declaration says.
export function skipReason(path, declared, operatorGlobs = []) {
  if (!SKIPPABLE.test(path)) return null
  if (declared.has(path)) return declared.get(path)
  const glob = operatorGlobs.find(g => globRegex(g).test(path))
  return glob ? `--skip ${glob}` : null
}

// Attributes that declare a file not worth hunting, read as of the merge-base so
// a PR cannot declare its own files skippable: the de facto `linguist-generated`
// and PandaStack's own `bughunt-skip`. Git older than 2.40 has no --source;
// then no attribute skips apply.
const SKIP_ATTRIBUTES = ['bughunt-skip', 'linguist-generated']
export function declaredAtBase(repo, mergeBase, paths) {
  const declared = new Map()
  if (!paths.length) return { declared, read: true }
  const r = git(repo, ['check-attr', `--source=${mergeBase}`, '-z', '--stdin', ...SKIP_ATTRIBUTES], { input: paths.join('\0') + '\0' })
  if (!r.ok) return { declared, read: false }
  const parts = r.stdout.split('\0')
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if ((parts[i + 2] === 'set' || parts[i + 2] === 'true') && !declared.has(parts[i])) declared.set(parts[i], parts[i + 1])
  }
  return { declared, read: true }
}

// Calls fn on each line of a file, reading it in bounded chunks: a range's
// patch can be larger than any buffer or string a process may hold.
function eachLine(file, fn) {
  const fd = openSync(file, 'r')
  const chunk = Buffer.alloc(1 << 20)
  let rest = Buffer.alloc(0)
  try {
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      let data = Buffer.concat([rest, chunk.subarray(0, n)])
      let start = 0
      for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
        fn(data.toString('utf8', start, nl))
        start = nl + 1
      }
      rest = Buffer.from(data.subarray(start))
    }
    if (rest.length) fn(rest.toString('utf8'))
  } finally { closeSync(fd) }
}

// Changed files at head versus the merge-base, each with its head-side hunk
// ranges and the lines each optional lens should look at, plus the files left
// out (skipReason) with why. Paths come from `--name-status -z`, exactly as git
// stores them (no quoting, no trailing tab after a space, no /dev/null for a
// deleted file); the patch, in the same order, gives each file its hunks. The
// patch is written to a temporary file and read line by line, never buffered.
export function changedFiles(repo, mergeBase, head, { skip = [] } = {}) {
  const DIFF = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames']
  const names = git(repo, [...DIFF, '--name-status', '-z', mergeBase, head])
  if (!names.ok) throw new Error(`git diff --name-status failed: ${(names.error || names.out.trim()).split('\n').slice(-3).join(' ')}`)
  const parts = names.stdout.split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  const all = []
  for (let i = 0; i + 1 < parts.length; i += 2) all.push({ path: parts[i + 1], status: parts[i].charAt(0), added: 0, deleted: 0, hunks: [], addedLines: [], removedLines: [] })
  const attributes = declaredAtBase(repo, mergeBase, all.map(f => f.path))
  for (const f of all) {
    f.skip = skipReason(f.path, attributes.declared, skip)
    f.isTest = TEST_FILE.test(f.path)
    f.isCode = !f.isTest && !NOT_CODE.test(f.path)
  }
  const dir = mkdtempSync(join(tmpdir(), 'bughunt-intake-'))
  try {
    const patchFile = join(dir, 'patch')
    must(git(repo, [...DIFF, '-U0', `--output=${patchFile}`, mergeBase, head]), 'git diff')
    let index = -1
    let cur = null
    let newLine = 0
    let oldLine = 0
    let header = false   // between "diff --git" and the first hunk: "--- " there is a path, not a removed "-- " line
    eachLine(patchFile, line => {
      if (line.startsWith('diff --git ')) {
        index += 1
        cur = all[index] || null
        header = true
        return
      }
      if (!cur || cur.skip) return
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (h) {
        header = false
        oldLine = Number(h[1])
        newLine = Number(h[3])
        const len = h[4] === undefined ? 1 : Number(h[4])
        const start = Math.max(newLine, 1)
        cur.hunks.push(len > 0 ? [start, start + len - 1] : [start, start])
        return
      }
      if (header) return   // index, mode, ---, +++, and Binary lines: the path came from --name-status
      // Only code lines feed the lens signals; counting is enough for the rest.
      if (line.startsWith('+')) { cur.added += 1; if (cur.isCode) cur.addedLines.push([newLine, line.slice(1)]); newLine += 1; return }
      if (line.startsWith('-')) { cur.deleted += 1; if (cur.isCode) cur.removedLines.push([oldLine, line.slice(1)]); oldLine += 1 }
    })
    if (index + 1 !== all.length) throw new Error(`git diff listed ${all.length} file(s) but its patch has ${index + 1}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const strip = ({ skip, ...f }) => f
  return {
    files: all.filter(f => !f.skip).map(strip),
    skipped: all.filter(f => f.skip).map(f => ({ path: f.path, status: f.status, reason: f.skip })),
    attributes: attributes.read ? 'merge-base' : 'unavailable',
  }
}

// Which optional lenses the change calls for, with up to MAX_HITS example
// lines each. logic and regression always run when code changed; a change with
// no code (tests or docs only) runs regression when tests changed, else nothing.
export function routeLenses(files) {
  const signals = {}
  for (const [lens, rule] of Object.entries(SIGNALS)) {
    const hits = []
    let count = 0
    for (const f of files.filter(x => x.isCode)) {
      if (rule.path && rule.path.test(f.path)) { count += 1; if (hits.length < MAX_HITS) hits.push({ file: f.path, line: f.hunks.length ? f.hunks[0][0] : 1, text: '(path)' }) }
      const lines = [...f.addedLines, ...(rule.removed ? f.removedLines : [])]
      for (const [n, text] of lines) {
        if (!rule.line.test(text)) continue
        count += 1
        if (hits.length < MAX_HITS) hits.push({ file: f.path, line: n, text: text.trim().slice(0, 120) })
      }
    }
    signals[lens] = { count, hits }
  }
  const code = files.some(f => f.isCode)
  const tests = files.some(f => f.isTest)
  const always = code ? ALWAYS : tests ? ['regression'] : []
  const reasons = {}
  for (const l of always) reasons[l] = code ? 'always runs on a code change' : 'the change touches tests only'
  for (const [lens, s] of Object.entries(signals)) if (code && s.count && !reasons[lens]) reasons[lens] = `${s.count} matching line(s) in the change`
  return { routed: Object.keys(reasons), reasons, signals }
}

// A detached worktree at `head` for the agents to read. Ours alone, inside the
// state directory: rebuilt when it cannot move cleanly.
export function analysisTree(repo, stateDir, head) {
  const tree = join(stateDir, 'tree')
  if (existsSync(tree) && git(tree, ['checkout', '--quiet', '--detach', '--force', head]).ok && git(tree, ['clean', '-fdq']).ok) return tree
  if (existsSync(tree)) {
    git(repo, ['worktree', 'remove', '--force', tree])
    rmSync(tree, { recursive: true, force: true })
  }
  git(repo, ['worktree', 'prune'])
  must(git(repo, ['worktree', 'add', '--quiet', '--detach', tree, head]), 'creating the analysis worktree')
  return tree
}

export function intake(opts, at) {
  const repo = must(git(opts.repo, ['rev-parse', '--show-toplevel']), `${opts.repo} is not a git repository:`)
  const t = resolveTarget(repo, opts)
  const head = commitOf(repo, t.head)
  const baseSha = commitOf(repo, t.base)
  const mergeBase = must(git(repo, ['merge-base', baseSha, head]), `finding the merge-base of ${t.base} and ${t.head}`)
  if (mergeBase === head) throw new Error(`${t.label} has no commits beyond ${t.base}: nothing to review`)
  const { files, skipped, attributes } = changedFiles(repo, mergeBase, head, { skip: opts.skip || [] })
  const lenses = routeLenses(files)
  const common = must(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'finding the git directory')
  const stateDir = join(common, 'bughunt', t.key)
  mkdirSync(stateDir, { recursive: true })
  const checkedOut = git(repo, ['rev-parse', 'HEAD']).stdout.trim()
  const dirty = checkedOut === head && git(repo, ['status', '--porcelain', '--untracked-files=no']).stdout.trim() !== ''
  const tree = analysisTree(repo, stateDir, head)
  // The full list stays in its own file; the target carries counts, which the
  // ledger and the report keep. The hunted head is still the real head.
  const skippedList = join(stateDir, 'skipped.json')
  writeFileSync(skippedList, JSON.stringify({ head, mergeBase, attributes, operatorGlobs: opts.skip || [], files: skipped }, null, 2) + '\n')
  const reasons = {}
  for (const f of skipped) reasons[f.reason] = (reasons[f.reason] || 0) + 1
  const doc = {
    version: 1, key: t.key, at, repo, tree, stateDir,
    target: { kind: t.kind, label: t.label, pr: t.pr || null, title: t.title || null, url: t.url || null, base: t.base, baseSha, head, mergeBase, dirty, baseFetched: t.baseFetched === undefined ? null : t.baseFetched,
      skipped: { count: skipped.length, reasons, attributes, operatorGlobs: opts.skip || [], list: skippedList } },
    stats: {
      files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0),
      code: files.filter(f => f.isCode).length, tests: files.filter(f => f.isTest).length,
    },
    files: files.map(f => ({ path: f.path, status: f.status, added: f.added, deleted: f.deleted, isTest: f.isTest, isCode: f.isCode, hunks: f.hunks })),
    lenses: { routed: lenses.routed, reasons: lenses.reasons },
    signals: lenses.signals,
    // Written by the PR's author: data for the agents, never instructions.
    untrusted: { description: t.description || '' },
  }
  const path = join(stateDir, 'intake.json')
  writeFileSync(`${path}.tmp`, JSON.stringify(doc, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
  return { path, doc }
}

const USAGE = 'usage: intake.mjs <repo> [--pr <n> | --branch <name> | --range <base>..<head>] [--base <ref>] [--skip <glob>]...'

function main(argv) {
  let opts
  try { opts = parseArgs(argv) } catch { console.error(USAGE); return 2 }
  try {
    const { path, doc } = intake(opts, new Date().toISOString())
    console.log(path)
    if (doc.target.dirty) console.log('note: the checked-out branch has uncommitted changes; only committed work is reviewed')
    if (doc.target.baseFetched === false) console.log(`note: could not refresh ${doc.target.base} from origin; the review uses the local copy, which may be behind`)
    const s = doc.target.skipped
    if (s.count) console.log(`skipped ${s.count} non-code file(s) declared not worth hunting (${Object.entries(s.reasons).sort().map(([k, n]) => `${k} ${n}`).join(', ')}); every path is listed in ${s.list}`)
    if (s.attributes === 'unavailable') console.log('note: this git cannot read .gitattributes at the merge-base (needs 2.40+); no attribute-declared files were skipped')
    console.log(`INTAKE: OK key=${doc.key} files=${doc.stats.files} skipped=${s.count} lenses=${doc.lenses.routed.join(',') || 'none'}`)
    return 0
  } catch (e) {
    console.log(`INTAKE: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
