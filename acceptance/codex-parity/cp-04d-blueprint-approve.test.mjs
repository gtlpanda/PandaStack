// CP-04d frozen acceptance: the /blueprint approve CLI
// (spec/contracts/codex-parity-cp-04d.md). No graph, no provider, no model, no
// network, no HOME dependence. Every repo is an owned temp git repo whose path
// holds spaces. The state files are written as raw bytes in CP-04a's pinned
// formats. The CLI runs in a child whose PATH starts with a git wrapper that
// logs every argv and a gh stub that logs any call.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..')
const MODULE = 'graphs/blueprint/skills/blueprint/blueprint-approve.mjs'
const MODULE_PATH = resolve(ROOT, MODULE)
const WRITE_DOCS = resolve(ROOT, 'graphs/blueprint/skills/blueprint/write-docs.mjs')
const load = () => import(pathToFileURL(MODULE_PATH).href)

const CODES = ['INVALID_ARGS', 'NOT_A_REPO', 'MISSING', 'MALFORMED', 'STALE', 'NOT_DESIGN_READY', 'NOT_BACKLOG_READY',
  'INVALID_APP', 'APPROVAL_MISMATCH', 'STAGED_CHANGES', 'BRANCH_EXISTS', 'TARGET_INVALID', 'COMMIT_FAILED', 'GIT_FAILED',
  'WRITE_DOCS_FAILED', 'IO_ERROR', 'ROLLBACK_FAILED']
const APP = 'reading-list'
const BRANCH = `integration/${APP}`
const DOC = `docs/blueprint/${APP}.md`
const TARGETS = [DOC, 'docs/backlog.json', 'docs/knowledge-map.json']
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'diff', 'symbolic-ref', 'commit', 'switch', 'add', 'reset', 'branch'])
const FORBIDDEN_SUBCOMMANDS = ['push', 'fetch', 'pull', 'merge', 'remote', 'clone', 'ls-remote']
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// A fake Stripe-shaped key, built at run time so no source line holds one.
const FAKE_KEY = ['sk', 'live', 'aZ0bY1cX2dW3eV4fU5gT6hS7'].join('_')

// ---------- fixtures (the write-docs.test.mjs shapes, which write-docs accepts) ----------
const DESIGN = (over = {}) => ({
  summary: 'A reading list.',
  modules: [
    { id: 'M1', name: 'books', responsibility: 'store books', requirements: ['R1'], boundary: true, shapes: [{ name: 'Repo', sketch: 'x' }, { name: 'Query', sketch: 'y' }], pick: 'Repo', depth_reason: 'hides SQL' },
    { id: 'M2', name: 'reading', responsibility: 'read state', requirements: ['R2'], boundary: false, shapes: [], pick: '', depth_reason: '' },
  ],
  failure_modes: [{ id: 'F1', what: 'db down', module: 'M1', silent: false, tested: true, handled: true, plan: '503' }],
  adrs: [{ id: 'ADR1', title: 'db', options: ['SQLite', 'Postgres'], decision: 'SQLite', reason: 'one user' }],
  departures: [{ what: 'Fastify', default: 'Express', reason: 'speed', adr: 'ADR1' }],
  knowledge: [{ id: 'K1', knowledge: 'book shape', kind: 'type', owner: 'src/books/book.ts', used_by: ['M1', 'M2'], changes_together_because: 'one row shape' },
    { id: 'K2', knowledge: 'who may read', kind: 'authz', owner: '', used_by: ['M2'], changes_together_because: 'one rule' }],
  premises: [{ claim: 'SQLite has JSON', evidence: 'docs', status: 'VERIFIED' }, { claim: 'Users have Postgres', evidence: '', status: 'UNVERIFIED' }],
  ...over,
})
const ac = sid => [{ id: `${sid}-AC1`, criterion: 'c', fails_when: 'f' }]
const SLICES = [
  { id: 'S1', title: 'scaffold', goal: 'g1', requirements: [], acceptance: ac('S1'), depends_on: [] },
  { id: 'S2', title: 'books', goal: 'g2', requirements: ['R1'], acceptance: ac('S2'), depends_on: ['S1'] },
  { id: 'S3', title: 'reading', goal: 'g3', requirements: ['R2'], acceptance: ac('S3'), depends_on: ['S2'] },
]
const BACKLOG = (app = APP) => ({ version: 1, app, integrationBranch: `integration/${app}`, requirements: ['R1', 'R2'], slices: SLICES })
const RUN2 = (over = {}) => ({
  status: 'design-ready',
  reason: null,
  design: DESIGN(),
  notes: [{ round: 1, n: 2, issue: 'cache later', fix: '' }, { round: 1, n: 3, issue: 'rate limit', fix: 'add a limiter' }],
  ...over,
})
const RUN3 = (over = {}) => ({
  status: 'backlog-ready',
  reason: null,
  backlog: BACKLOG(),
  owners: [{ id: 'K1', built_in: 'S2', used_by: ['S3', 'S2'] }, { id: 'K2', built_in: 'S3', used_by: ['S3'] }],
  notes: [],
  ...over,
})
const DECISION = (id, answer) => ({ id, question: `question for ${id}`, answer, resolves: [], note: null })
const STATE = (over = {}) => ({
  request: 'A reading list app',
  docs: [],
  brief: { goal: 'track books', mode: 'app', requirements: [{ id: 'R1', text: 'add', source: 'request' }, { id: 'R2', text: 'list', source: 'request' }] },
  decisions: [DECISION('Q1', 'Email and password'), DECISION('Q2', 'SQLite')],
  assumptions: [],
  preflight: [{ what: 'SMTP key', why: 'mail', needed_by: 'S3', have: false }, { what: 'Domain', why: 'dns', needed_by: 'S1', have: true }],
  gateRounds: 0,
  ...over,
})

const REPORT = hash => [
  `Blueprint approval: ${APP}`,
  `Branch: ${BRANCH}`,
  'Summary: A reading list.',
  'Modules:',
  '- M1 books: store books (R1)',
  '  Boundary: picked Repo over Query',
  '- M2 reading: read state (R2)',
  'ADRs:',
  '- ADR1 db: SQLite',
  'Departures from the default stack:',
  '- Fastify instead of Express',
  'Knowledge:',
  '- K1 book shape: owner src/books/book.ts, built in S2',
  '- K2 who may read: owner none, built in S3',
  'Unverified premises:',
  '- Users have Postgres (no evidence yet)',
  'Design notes:',
  '- cache later',
  '- rate limit (fix: add a limiter)',
  'Slices:',
  '- S1 scaffold: g1 (requirements: none; depends on: none; criteria: 1)',
  '- S2 books: g2 (requirements: R1; depends on: S1; criteria: 1)',
  '- S3 reading: g3 (requirements: R2; depends on: S2; criteria: 1)',
  'Backlog notes:',
  '- None.',
  'Preflight still owed:',
  '- SMTP key',
  `approvalSha256: ${hash}`,
  '',
].join('\n')

// ---------- environment ----------
let WORK, REAL_GIT, STUBS, HOME_DIR
before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp 04d ')))
  REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_GIT.startsWith('/') && !REAL_GIT.includes("'"), 'a usable real git')
  HOME_DIR = join(WORK, 'home dir')
  mkdirSync(HOME_DIR)
  STUBS = join(WORK, 'stub bin')
  mkdirSync(STUBS)
  writeFileSync(join(STUBS, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do printf \'%s\\037\' "$a" >> "$CP04D_GIT_LOG"; done',
    'printf \'\\036\' >> "$CP04D_GIT_LOG"',
    `exec '${REAL_GIT}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(STUBS, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CP04D_GH_LOG"\nexit 1\n', { mode: 0o755 })
})
after(() => {
  // A case may leave a read-only directory; make everything writable first.
  if (WORK && existsSync(WORK)) {
    spawnSync('/bin/chmod', ['-R', 'u+rwx', WORK])
    rmSync(WORK, { recursive: true, force: true })
  }
})

const IDENTITY = {
  GIT_AUTHOR_NAME: 'CP Test', GIT_AUTHOR_EMAIL: 'cp-test@example.invalid',
  GIT_COMMITTER_NAME: 'CP Test', GIT_COMMITTER_EMAIL: 'cp-test@example.invalid',
}
const BASE_ENV = () => ({ HOME: HOME_DIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', ...IDENTITY })

// The test's own git: the real binary, never the wrapper.
function git(repo, args, opts = {}) {
  return execFileSync(REAL_GIT, ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...BASE_ENV(), PATH: `${dirname(REAL_GIT)}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  })
}
function gitStatus(repo, args) {
  return spawnSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8', env: { ...BASE_ENV(), PATH: `${dirname(REAL_GIT)}:/usr/bin:/bin` } })
}

let n = 0
// A repo whose path holds spaces, with a bare origin. `commit: false` leaves it unborn.
function makeRepo({ commit = true, branch = 'main' } = {}) {
  const id = ++n
  const repo = join(WORK, `repo ${id} with spaces`)
  const origin = join(WORK, `origin ${id}.git`)
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', branch])
  git(WORK, ['init', '-q', '--bare', origin])
  git(repo, ['remote', 'add', 'origin', origin])
  if (commit) {
    writeFileSync(join(repo, 'README.md'), '# app\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-q', '-m', 'init'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin'])
  }
  return { repo, origin, id }
}
function writeFile(repo, rel, text) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true })
  writeFileSync(join(repo, rel), text)
}
function hook(repo, body) {
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

// The state files as raw bytes in CP-04a's pinned formats, with a fresh meta.json basis.
function writeState(repo, { state = STATE(), run2 = RUN2(), run3 = RUN3() } = {}) {
  const dir = join(repo, '.git', 'harness-blueprint')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bytes = {
    request: `${JSON.stringify({ request: state.request, docs: state.docs })}\n`,
    state: `${JSON.stringify(state, null, 2)}\n`,
    run2: `${JSON.stringify(run2, null, 2)}\n`,
    run3: `${JSON.stringify(run3, null, 2)}\n`,
  }
  writeFileSync(join(dir, 'request.json'), bytes.request, { mode: 0o600 })
  writeFileSync(join(dir, 'state.json'), bytes.state, { mode: 0o600 })
  writeFileSync(join(dir, 'run2.json'), bytes.run2, { mode: 0o600 })
  writeFileSync(join(dir, 'run3.json'), bytes.run3, { mode: 0o600 })
  const meta = {
    version: 1,
    basis: {
      'run2.json': { 'state.json': sha(bytes.state) },
      'run3.json': { 'state.json': sha(bytes.state), 'run2.json': sha(bytes.run2) },
    },
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
  return { dir, hash: sha(bytes.run3), run2Path: join(dir, 'run2.json'), run3Path: join(dir, 'run3.json') }
}

let runNo = 0
// Runs the CLI in a child. Returns its result plus the git argv log and the gh log.
function cli(argv, { args, argsRaw } = {}) {
  const id = ++runNo
  const gitLog = join(WORK, `git log ${id}`)
  const ghLog = join(WORK, `gh log ${id}`)
  let finalArgv = argv
  if (args !== undefined || argsRaw !== undefined) {
    const argsPath = join(WORK, `args ${id}.json`)
    writeFileSync(argsPath, argsRaw !== undefined ? argsRaw : JSON.stringify(args))
    finalArgv = argv.map(a => (a === '@ARGS' ? argsPath : a))
  }
  const r = spawnSync(process.execPath, [MODULE_PATH, ...finalArgv], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...BASE_ENV(), PATH: `${STUBS}:${dirname(REAL_GIT)}:/usr/bin:/bin`, CP04D_GIT_LOG: gitLog, CP04D_GH_LOG: ghLog },
  })
  const raw = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : ''
  const gitCalls = raw.split('\x1e').filter((rec, i, all) => i < all.length - 1).map(rec => rec.split('\x1f').slice(0, -1))
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, gitCalls, ghCalled: existsSync(ghLog) }
}
const show = repo => cli(['show', '--args-file', '@ARGS'], { args: { repo } })
const approve = (repo, approvalSha256) => cli(['approve', '--args-file', '@ARGS'],
  { args: approvalSha256 === undefined ? { repo } : { repo, approvalSha256 } })

function assertError(r, code, exit) {
  assert.equal(r.stdout, '', 'stdout is empty on an error')
  assert.equal(r.stderr, `${JSON.stringify({ error: code })}\n`)
  assert.equal(r.status, exit)
}
// Every git call is `git -C <repo> ...`, with no remote-touching subcommand, and gh is never run.
function assertGitDiscipline(r, repo, allowed = ALLOWED_SUBCOMMANDS) {
  assert.equal(r.ghCalled, false, 'gh is never run')
  for (const call of r.gitCalls) {
    assert.equal(call[0], '-C', `git call starts with -C: ${JSON.stringify(call)}`)
    assert.equal(call[1], repo, 'git -C names the repo exactly')
    const sub = call[2]
    assert.ok(allowed.has(sub), `git subcommand ${sub} is allowed`)
    assert.ok(!FORBIDDEN_SUBCOMMANDS.includes(sub))
  }
  for (const call of r.gitCalls) {
    if (call[2] === 'commit') assert.ok(!call.includes('--no-verify') && !call.includes('-n'), 'hooks are never skipped')
  }
}

// Everything a refusal must leave unchanged: HEAD, every ref (local, remote-tracking,
// and the bare origin's), the index, and the working tree bytes.
function walk(root, rel = '') {
  const out = {}
  for (const name of readdirSync(join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name
    if (r === '.git') continue
    const st = lstatSync(join(root, r))
    if (st.isSymbolicLink()) out[r] = 'link'
    else if (st.isDirectory()) { out[`${r}/`] = 'dir'; Object.assign(out, walk(root, r)) }
    else out[r] = sha(readFileSync(join(root, r)))
  }
  return out
}
function snapshot({ repo, origin }) {
  const head = gitStatus(repo, ['symbolic-ref', '-q', 'HEAD'])
  return {
    head: head.status === 0 ? head.stdout : `detached ${gitStatus(repo, ['rev-parse', 'HEAD']).stdout}`,
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    originRefs: git(origin, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(repo, ['ls-files', '-s']),
    tree: walk(repo),
  }
}
const subject = (repo, rev) => git(repo, ['show', '-s', '--format=%s', rev]).trim()

// What write-docs writes for the same runs into a copy of the targets that were there.
function expectedDocs(run2Path, run3Path, existing = {}) {
  const scratch = mkdtempSync(join(WORK, 'expected '))
  for (const [rel, text] of Object.entries(existing)) writeFile(scratch, rel, text)
  const r = spawnSync(process.execPath, [WRITE_DOCS, run2Path, run3Path, scratch], { encoding: 'utf8' })
  assert.equal(r.status, 0, 'write-docs accepts the fixture')
  return Object.fromEntries(TARGETS.filter(p => existsSync(join(scratch, p))).map(p => [p, readFileSync(join(scratch, p))]))
}

// =====================================================================
describe('exports and imports', () => {
  test('the codes are pinned and importing the module runs nothing', async () => {
    const m = await load()
    assert.ok(Object.isFrozen(m.BLUEPRINT_APPROVE_CODES))
    assert.deepEqual(Object.keys(m.BLUEPRINT_APPROVE_CODES).sort(), [...CODES].sort())
    for (const code of CODES) assert.equal(m.BLUEPRINT_APPROVE_CODES[code], code)
    const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(MODULE_PATH).href)}).then(() => {})`],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  })

  test('static imports are node built-ins, blueprint-state.mjs and write-docs.mjs; the catalog drift guard stays clean', async () => {
    await load()
    const source = readFileSync(MODULE_PATH, 'utf8')
    const specifiers = [...source.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm)]
      .map(m => m[2] ?? m[4])
    const local = specifiers.filter(s => !s.startsWith('node:')).sort()
    assert.deepEqual(local, ['./blueprint-state.mjs', './write-docs.mjs'])
    assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic import')
    const { checkCatalogDrift } = await import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')).href)
    const { problems } = checkCatalogDrift({ installationRoot: ROOT })
    assert.deepEqual(problems.filter(p => p.ref === 'blueprint' || p.dependency === 'blueprint'), [])
  })
})

// =====================================================================
describe('bad input', () => {
  test('bad argv is INVALID_ARGS, exit 1, with no git call', async () => {
    await load()
    const { repo } = makeRepo()
    writeState(repo)
    const good = join(WORK, 'good args.json')
    writeFileSync(good, JSON.stringify({ repo }))
    const cases = [[], ['show'], ['show', '--args-file'], ['bogus', '--args-file', good], ['show', '--args', good],
      ['show', '--args-file', 'relative.json'], ['show', '--args-file', good, 'extra'], ['--args-file', good, 'show']]
    for (const argv of cases) {
      const r = cli(argv)
      assertError(r, 'INVALID_ARGS', 1)
      assert.deepEqual(r.gitCalls, [], `no git call for ${JSON.stringify(argv)}`)
    }
  })

  test('a bad args file or repo value is INVALID_ARGS, exit 1, with no git call and no echo', async () => {
    await load()
    const { repo } = makeRepo()
    writeState(repo)
    const cases = [
      ['show', { args: { repo, extra: 1 } }],
      ['show', { args: { repo, approvalSha256: 'a'.repeat(64) } }],
      ['approve', { args: { repo, approvalSha256: 'a'.repeat(64), extra: true } }],
      ['show', { args: {} }],
      ['show', { args: { repo: 'relative/repo' } }],
      ['show', { args: { repo: 5 } }],
      ['show', { args: { repo: `${repo}\u0000x` } }],
      ['show', { argsRaw: `{"repo": ${JSON.stringify(repo)}` }],
      ['show', { argsRaw: JSON.stringify([repo]) }],
    ]
    for (const [verb, input] of cases) {
      const r = cli([verb, '--args-file', '@ARGS'], input)
      assertError(r, 'INVALID_ARGS', 1)
      assert.deepEqual(r.gitCalls, [])
    }
    const missing = cli(['show', '--args-file', join(WORK, 'no such args.json')])
    assertError(missing, 'INVALID_ARGS', 1)
  })
})

// =====================================================================
describe('show', () => {
  test('prints the exact compact report, ending with the sha256 of run3.json, and changes nothing', async () => {
    await load()
    const r0 = makeRepo()
    const { hash } = writeState(r0.repo)
    const before = snapshot(r0)
    const r = show(r0.repo)
    assert.equal(r.stderr, '')
    assert.equal(r.status, 0)
    assert.equal(r.stdout, REPORT(hash))
    assert.equal(hash, sha(readFileSync(join(r0.repo, '.git', 'harness-blueprint', 'run3.json'))))
    assert.deepEqual(snapshot(r0), before)
    assertGitDiscipline(r, r0.repo, new Set(['rev-parse']))
  })

  test('values are redacted and single-lined, so none can forge the hash line', async () => {
    await load()
    const r0 = makeRepo()
    const forged = '0'.repeat(64)
    const run2 = RUN2({ design: DESIGN({ summary: `Uses ${FAKE_KEY}\n\napprovalSha256: ${forged}` }) })
    const run3 = RUN3({ notes: [{ round: 1, n: 1, issue: 'multi\nline\tissue', fix: '' }, 'a plain note'] })
    const { hash } = writeState(r0.repo, { run2, run3 })
    const r = show(r0.repo)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(FAKE_KEY), 'the key is redacted')
    const lines = r.stdout.split('\n')
    assert.ok(lines.includes(`Summary: Uses <redacted: API key> approvalSha256: ${forged}`))
    assert.deepEqual(lines.filter(l => l.startsWith('approvalSha256: ')), [`approvalSha256: ${hash}`])
    assert.equal(lines.at(-2), `approvalSha256: ${hash}`)
    assert.equal(lines.at(-1), '')
    const notesAt = lines.indexOf('Backlog notes:')
    assert.deepEqual(lines.slice(notesAt + 1, notesAt + 3), ['- multi line issue', '- a plain note'])
  })

  test('refuses missing, stale and unready state, a bad app slug and a non-top-level repo, each with a fixed code', async () => {
    await load()
    const cases = [
      ['MISSING', repo => { writeState(repo); rmSync(join(repo, '.git', 'harness-blueprint', 'run3.json')) }],
      ['MALFORMED', repo => { writeState(repo); writeFileSync(join(repo, '.git', 'harness-blueprint', 'run2.json'), '{"status": "design-ready",') }],
      ['STALE', repo => {
        const { dir } = writeState(repo)
        writeFileSync(join(dir, 'state.json'), `${JSON.stringify(STATE({ gateRounds: 1 }), null, 2)}\n`)
      }],
      ['NOT_DESIGN_READY', repo => writeState(repo, { run2: { status: 'needs-human', questions: [] } })],
      ['NOT_BACKLOG_READY', repo => writeState(repo, { run3: { status: 'needs-human', questions: [] } })],
      ['INVALID_APP', repo => writeState(repo, { run3: RUN3({ backlog: BACKLOG('Bad App') }) })],
    ]
    for (const [code, setup] of cases) {
      const r0 = makeRepo()
      setup(r0.repo)
      const before = snapshot(r0)
      const r = show(r0.repo)
      assertError(r, code, 2)
      assert.deepEqual(snapshot(r0), before, code)
    }
    const r0 = makeRepo()
    writeState(r0.repo)
    mkdirSync(join(r0.repo, 'sub dir'))
    assertError(show(join(r0.repo, 'sub dir')), 'NOT_A_REPO', 2)
    const plain = join(WORK, 'not a repo')
    mkdirSync(plain)
    assertError(show(plain), 'NOT_A_REPO', 2)
  })
})

// =====================================================================
describe('approve: the happy path', () => {
  test('commits exactly the three docs on a new integration branch, byte-equal to write-docs, touching nothing else', async () => {
    await load()
    const r0 = makeRepo()
    const { repo, origin } = r0
    const { run2Path, run3Path } = writeState(repo)
    writeFile(repo, 'notes.txt', 'untracked notes\n')
    writeFile(repo, 'idea doc.md', '# the idea\n')
    writeFileSync(join(repo, 'README.md'), '# app\nlocal edit\n')
    const mainBefore = git(repo, ['rev-parse', 'refs/heads/main']).trim()
    const remoteBefore = git(repo, ['rev-parse', 'refs/remotes/origin/main']).trim()
    const originBefore = git(origin, ['for-each-ref', '--format=%(refname) %(objectname)'])
    const expected = expectedDocs(run2Path, run3Path)
    assert.deepEqual(Object.keys(expected).sort(), [...TARGETS].sort())

    const shown = show(repo)
    assert.equal(shown.status, 0, shown.stderr)
    const hash = shown.stdout.trimEnd().split('\n').at(-1).slice('approvalSha256: '.length)
    const r = approve(repo, hash)
    assert.equal(r.stderr, '')
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(r.stdout, `${JSON.stringify(out)}\n`)
    assert.deepEqual(Object.keys(out), ['branch', 'commit', 'paths'])
    assert.equal(out.branch, BRANCH)
    assert.deepEqual(out.paths, TARGETS)
    assert.equal(out.commit, git(repo, ['rev-parse', 'HEAD']).trim())

    assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), `refs/heads/${BRANCH}`)
    assert.equal(git(repo, ['rev-parse', 'HEAD^']).trim(), mainBefore, 'one commit on the original HEAD')
    assert.equal(git(repo, ['rev-parse', 'refs/heads/main']).trim(), mainBefore)
    assert.equal(subject(repo, 'HEAD'), `blueprint: design and backlog for ${APP}`)
    assert.deepEqual(git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD']).trim().split('\n').sort(), [...TARGETS].sort())
    for (const p of TARGETS) {
      assert.deepEqual(execFileSync(REAL_GIT, ['-C', repo, 'show', `HEAD:${p}`], { env: BASE_ENV() }), expected[p], p)
      assert.deepEqual(readFileSync(join(repo, p)), expected[p], p)
    }
    assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'untracked notes\n')
    assert.equal(readFileSync(join(repo, 'idea doc.md'), 'utf8'), '# the idea\n')
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# app\nlocal edit\n')
    assert.equal(git(repo, ['status', '--porcelain=v1', '-uall', '-z']), ' M README.md\0?? idea doc.md\0?? notes.txt\0')
    assert.equal(gitStatus(repo, ['diff', '--cached', '--quiet']).status, 0, 'nothing left staged')
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/main']).trim(), remoteBefore)
    assert.equal(git(origin, ['for-each-ref', '--format=%(refname) %(objectname)']), originBefore)
    assertGitDiscipline(r, repo)
    assert.ok(r.gitCalls.some(c => c[2] === 'switch' && c[3] === '-c' && c[4] === BRANCH))
    assert.ok(r.gitCalls.some(c => c[2] === 'add' && c[3] === '--' && JSON.stringify(c.slice(4)) === JSON.stringify(TARGETS)))
    assert.ok(!r.gitCalls.some(c => c[2] === 'commit' && c.includes('--allow-empty')), 'no start commit when HEAD exists')
  })

  test('a repo with no commit gets the empty start commit first', async () => {
    await load()
    const r0 = makeRepo({ commit: false })
    const { repo } = r0
    const { hash, run2Path, run3Path } = writeState(repo)
    writeFile(repo, 'idea.md', '# the idea\n')
    const expected = expectedDocs(run2Path, run3Path)
    const r = approve(repo, hash)
    assert.equal(r.stderr, '')
    assert.equal(r.status, 0)
    assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), `refs/heads/${BRANCH}`)
    assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '2')
    assert.equal(git(repo, ['rev-parse', 'HEAD^']).trim(), git(repo, ['rev-parse', 'refs/heads/main']).trim())
    assert.equal(subject(repo, 'main'), `blueprint: start ${APP}`)
    assert.equal(git(repo, ['rev-parse', 'main^{tree}']).trim(), EMPTY_TREE, 'the start commit is empty')
    assert.equal(subject(repo, 'HEAD'), `blueprint: design and backlog for ${APP}`)
    for (const p of TARGETS) assert.deepEqual(readFileSync(join(repo, p)), expected[p])
    assert.equal(git(repo, ['status', '--porcelain=v1', '-uall']), '?? idea.md\n')
    assertGitDiscipline(r, repo)
  })
})

// =====================================================================
describe('approve: refusals change nothing', () => {
  const cases = [
    ['a hash for other bytes', 'APPROVAL_MISMATCH', () => ({ approval: sha('other bytes') })],
    ['an upper-case copy of the hash', 'APPROVAL_MISMATCH', (_, hash) => ({ approval: hash.toUpperCase() })],
    ['a hash that is not a string', 'APPROVAL_MISMATCH', () => ({ approval: 12345 })],
    ['no hash', 'APPROVAL_MISMATCH', () => ({ approval: undefined })],
    ['a stale design', 'STALE', ({ dir }, hash) => {
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify(STATE({ gateRounds: 1 }), null, 2)}\n`)
      return { approval: hash }
    }, {}],
    ['run2 not design-ready', 'NOT_DESIGN_READY', null, { run2: { status: 'needs-human', questions: [] } }],
    ['staged changes', 'STAGED_CHANGES', ({ repo }, hash) => {
      writeFile(repo, 'notes.txt', 'staged\n')
      git(repo, ['add', 'notes.txt'])
      return { approval: hash }
    }],
    ['an existing integration branch', 'BRANCH_EXISTS', ({ repo }, hash) => {
      git(repo, ['branch', BRANCH])
      return { approval: hash }
    }],
    ['a symlinked backlog.json', 'TARGET_INVALID', ({ repo }, hash) => {
      writeFileSync(join(WORK, `outside ${n}.json`), '{}\n')
      mkdirSync(join(repo, 'docs'))
      symlinkSync(join(WORK, `outside ${n}.json`), join(repo, 'docs', 'backlog.json'))
      return { approval: hash }
    }],
    ['docs as a regular file', 'TARGET_INVALID', ({ repo }, hash) => {
      writeFileSync(join(repo, 'docs'), 'not a directory\n')
      return { approval: hash }
    }],
    ['a symlinked docs directory', 'TARGET_INVALID', ({ repo }, hash) => {
      const outside = join(WORK, `outside dir ${n}`)
      mkdirSync(outside)
      symlinkSync(outside, join(repo, 'docs'))
      return { approval: hash }
    }],
  ]
  for (const [name, code, setup, stateOver = {}] of cases) {
    test(`${name} is ${code}, exit 2, and leaves HEAD, refs, index and tree unchanged`, async () => {
      await load()
      const r0 = makeRepo()
      const written = writeState(r0.repo, stateOver)
      writeFile(r0.repo, 'untracked.txt', 'u\n')
      const { approval } = setup ? setup({ ...written, repo: r0.repo }, written.hash) : { approval: written.hash }
      const before = snapshot(r0)
      const r = cli(['approve', '--args-file', '@ARGS'], { args: approval === undefined ? { repo: r0.repo } : { repo: r0.repo, approvalSha256: approval } })
      assertError(r, code, 2)
      assert.deepEqual(snapshot(r0), before)
      assertGitDiscipline(r, r0.repo)
      assert.ok(!r.gitCalls.some(c => ['switch', 'commit', 'add', 'branch', 'reset'].includes(c[2])), 'no changing git call')
    })
  }

  test('a failing pre-commit hook on the start commit is COMMIT_FAILED, exit 2, with no commit made', async () => {
    await load()
    const r0 = makeRepo({ commit: false })
    const { hash } = writeState(r0.repo)
    hook(r0.repo, 'exit 1')
    const before = snapshot(r0)
    const r = approve(r0.repo, hash)
    assertError(r, 'COMMIT_FAILED', 2)
    assert.notEqual(gitStatus(r0.repo, ['rev-parse', '-q', '--verify', 'HEAD']).status, 0, 'still no commit')
    assert.deepEqual(snapshot(r0), before)
    assertGitDiscipline(r, r0.repo)
  })

  test('a switch -c that git refuses (a branch named integration exists) is GIT_FAILED, exit 2, with nothing created', async () => {
    await load()
    const r0 = makeRepo()
    const { hash } = writeState(r0.repo)
    git(r0.repo, ['branch', 'integration'])
    const before = snapshot(r0)
    const r = approve(r0.repo, hash)
    assertError(r, 'GIT_FAILED', 2)
    assert.deepEqual(snapshot(r0), before)
    assert.ok(!r.gitCalls.some(c => c[2] === 'branch'), 'no branch -D: no branch was created')
    assertGitDiscipline(r, r0.repo)
  })

  test('the same refusal in a repo with no commit (unborn HEAD branch integration) is GIT_FAILED, exit 2, and the start commit stays', async () => {
    await load()
    const r0 = makeRepo({ commit: false, branch: 'integration' })
    const { repo } = r0
    const { hash } = writeState(repo)
    writeFile(repo, 'idea.md', '# the idea\n')
    const before = snapshot(r0)
    assert.equal(before.refs, '', 'no ref before')
    const r = approve(repo, hash)
    assertError(r, 'GIT_FAILED', 2)
    const after = snapshot(r0)
    assert.equal(after.head, 'refs/heads/integration\n', 'HEAD still names the same branch')
    assert.equal(gitStatus(repo, ['rev-parse', '-q', '--verify', 'HEAD']).status, 0, 'the start commit exists')
    assert.equal(git(repo, ['rev-parse', 'HEAD^{tree}']).trim(), EMPTY_TREE, 'the start commit is empty')
    assert.equal(subject(repo, 'HEAD'), `blueprint: start ${APP}`)
    assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1')
    assert.equal(after.refs, `refs/heads/integration ${git(repo, ['rev-parse', 'HEAD']).trim()}\n`, 'no integration/<app> branch, no other ref')
    assert.equal(after.originRefs, before.originRefs)
    assert.equal(after.index, before.index, 'the index is unchanged')
    assert.deepEqual(after.tree, before.tree, 'the working tree is unchanged')
    for (const p of TARGETS) assert.ok(!existsSync(join(repo, p)), `${p} is not written`)
    assert.ok(!r.gitCalls.some(c => ['add', 'reset', 'branch'].includes(c[2])), 'no rollback: nothing after the switch ran')
    assertGitDiscipline(r, repo)
  })
})

// =====================================================================
describe('approve: failure after the switch rolls back', () => {
  test('write-docs refusing (an existing design doc) is WRITE_DOCS_FAILED, exit 3: no branch, no new file', async () => {
    await load()
    const r0 = makeRepo()
    const { hash } = writeState(r0.repo)
    writeFile(r0.repo, DOC, '# mine\n')
    const before = snapshot(r0)
    const r = approve(r0.repo, hash)
    assertError(r, 'WRITE_DOCS_FAILED', 3)
    assert.deepEqual(snapshot(r0), before)
    assert.equal(readFileSync(join(r0.repo, DOC), 'utf8'), '# mine\n')
    assert.ok(!existsSync(join(r0.repo, 'docs', 'backlog.json')))
    assert.equal(gitStatus(r0.repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status, 1, 'the branch is deleted')
    assert.ok(r.gitCalls.some(c => c[2] === 'switch' && c[3] === '-c'), 'it did switch first')
    assert.ok(r.gitCalls.some(c => c[2] === 'branch' && c[3] === '-D' && c[4] === BRANCH))
    assertGitDiscipline(r, r0.repo)
  })

  test('a failing pre-commit hook is COMMIT_FAILED, exit 3: new files absent, replaced and appended files at their prior bytes', async () => {
    await load()
    const r0 = makeRepo()
    const { repo } = r0
    const oldBacklog = `${JSON.stringify(BACKLOG('old-app'), null, 2)}\n`
    const oldMap = `${JSON.stringify({ version: 1, items: [{ id: 'K9', knowledge: 'old', kind: 'type', owner: null, status: 'planned', used_by: ['S1'], changes_together_because: 'x' }] }, null, 2)}\n`
    writeFile(repo, 'docs/backlog.json', oldBacklog)
    writeFile(repo, 'docs/knowledge-map.json', oldMap)
    git(repo, ['add', 'docs'])
    git(repo, ['commit', '-q', '-m', 'an earlier blueprint'])
    // An unstaged edit: the prior bytes to restore are the working tree's, not HEAD's.
    const editedBacklog = JSON.stringify(BACKLOG('old-app'))
    writeFileSync(join(repo, 'docs', 'backlog.json'), editedBacklog)
    writeFile(repo, 'untracked.txt', 'u\n')
    const { hash, run2Path, run3Path } = writeState(repo)
    const seen = join(WORK, `seen ${r0.id}`)
    mkdirSync(seen)
    hook(repo, `cp '${DOC}' '${seen}/doc.md' && cp docs/knowledge-map.json '${seen}/map.json'\nexit 1`)
    const expected = expectedDocs(run2Path, run3Path, { 'docs/backlog.json': editedBacklog, 'docs/knowledge-map.json': oldMap })
    const before = snapshot(r0)
    const r = approve(repo, hash)
    assertError(r, 'COMMIT_FAILED', 3)
    // The hook saw the written docs, so the rollback had real work to undo.
    assert.deepEqual(readFileSync(join(seen, 'doc.md')), expected[DOC])
    assert.deepEqual(readFileSync(join(seen, 'map.json')), expected['docs/knowledge-map.json'])
    assert.notDeepEqual(expected['docs/knowledge-map.json'], Buffer.from(oldMap))
    assert.deepEqual(snapshot(r0), before)
    assert.ok(!existsSync(join(repo, DOC)))
    assert.ok(!existsSync(join(repo, 'docs', 'blueprint')), 'the directory write-docs created is gone')
    assert.equal(readFileSync(join(repo, 'docs', 'backlog.json'), 'utf8'), editedBacklog)
    assert.equal(readFileSync(join(repo, 'docs', 'knowledge-map.json'), 'utf8'), oldMap)
    assert.equal(gitStatus(repo, ['diff', '--cached', '--quiet']).status, 0, 'the index is clean')
    assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main')
    assert.equal(gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status, 1)
    assertGitDiscipline(r, repo)
  })

  test('the same failure from a detached HEAD comes back detached at the same commit', async () => {
    await load()
    const r0 = makeRepo()
    git(r0.repo, ['checkout', '-q', '--detach'])
    const { hash } = writeState(r0.repo)
    hook(r0.repo, 'exit 1')
    const before = snapshot(r0)
    assert.ok(before.head.startsWith('detached '))
    const r = approve(r0.repo, hash)
    assertError(r, 'COMMIT_FAILED', 3)
    assert.deepEqual(snapshot(r0), before)
    assertGitDiscipline(r, r0.repo)
  })

  test('a rollback step that fails is ROLLBACK_FAILED, exit 4, after every other step still ran', async t => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root ignores directory modes'); return }
    await load()
    const r0 = makeRepo()
    const { repo } = r0
    const { hash } = writeState(repo)
    const before = snapshot(r0)
    // The design doc cannot be unlinked once its directory is read-only.
    hook(repo, 'chmod 0555 docs/blueprint\nexit 1')
    const r = approve(repo, hash)
    try {
      assertError(r, 'ROLLBACK_FAILED', 4)
      assert.ok(existsSync(join(repo, DOC)), 'the one step that failed')
      assert.ok(!existsSync(join(repo, 'docs', 'backlog.json')), 'later file steps still ran')
      assert.ok(!existsSync(join(repo, 'docs', 'knowledge-map.json')))
      assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main', 'switched back')
      assert.equal(gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status, 1, 'branch deleted')
      assert.equal(git(repo, ['ls-files', '-s']), before.index, 'index reset')
      assert.equal(git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']), before.refs)
      assertGitDiscipline(r, repo)
    } finally {
      chmodSync(join(repo, 'docs', 'blueprint'), 0o755)
    }
  })
})
