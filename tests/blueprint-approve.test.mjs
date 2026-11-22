// CP-04d implementation edges the frozen acceptance does not pin: the module exports
// only its codes; every report section's `- None.` line, values that are not strings,
// list items that are not objects, blank owner/evidence/fix values and an empty shape
// list; a repo given through a symlink or with a trailing slash; docs/blueprint as a
// file and knowledge-map.json as a directory; write-docs refusing a backlog.json that
// is not a backlog; a snapshot that fails midway never touching the target it could
// not record; a deleted target restored with its recorded mode; and a successful
// approve from a detached HEAD. Every repo is an owned temp repo; the CLI runs in a
// child with an owned HOME and no global git config. Fake keys are built at run time.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const MODULE_PATH = resolve(import.meta.dirname, '..', 'graphs/blueprint/skills/blueprint/blueprint-approve.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'blueprint approve ')))
const HOME_DIR = join(WORK, 'home')
mkdirSync(HOME_DIR)
const APP = 'shelf'
const BRANCH = `integration/${APP}`
const DOC = `docs/blueprint/${APP}.md`
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const FAKE_KEY = ['sk', 'test', 'Qw3Er5Ty7Ui9Op1As2'].join('_')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const ENV = {
  HOME: HOME_DIR, PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'CP Test', GIT_AUTHOR_EMAIL: 'cp-test@example.invalid',
  GIT_COMMITTER_NAME: 'CP Test', GIT_COMMITTER_EMAIL: 'cp-test@example.invalid',
}
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
const gitStatus = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: ENV }).status

let caseNo = 0
function makeRepo() {
  const repo = join(WORK, `repo ${++caseNo}`)
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), '# app\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}
function put(repo, rel, text) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true })
  writeFileSync(join(repo, rel), text)
}
const hook = (repo, body) => writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

const STATE = (over = {}) => ({
  request: 'A shelf', docs: [], brief: { goal: 'g', mode: 'app', requirements: [{ id: 'R1', text: 'add', source: 'request' }] },
  decisions: [], assumptions: [], preflight: [], gateRounds: 0, ...over,
})
const SLICES = [{ id: 'S1', title: 'scaffold', goal: 'g1', requirements: ['R1'], acceptance: [{ id: 'S1-AC1', criterion: 'c', fails_when: 'f' }], depends_on: [] }]
const RUN2 = (design = {}, over = {}) => ({ status: 'design-ready', reason: null, design: { summary: 'A shelf.', knowledge: [], ...design }, notes: [], ...over })
const RUN3 = (over = {}) => ({
  status: 'backlog-ready', reason: null,
  backlog: { version: 1, app: APP, integrationBranch: BRANCH, requirements: ['R1'], slices: SLICES }, owners: [], notes: [], ...over,
})

// The state files in CP-04a's pinned formats, with a fresh meta.json basis.
function writeState(repo, { state = STATE(), run2 = RUN2(), run3 = RUN3() } = {}) {
  const dir = join(repo, '.git', 'harness-blueprint')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bytes = {
    state: `${JSON.stringify(state, null, 2)}\n`, run2: `${JSON.stringify(run2, null, 2)}\n`, run3: `${JSON.stringify(run3, null, 2)}\n`,
  }
  writeFileSync(join(dir, 'request.json'), `${JSON.stringify({ request: state.request, docs: state.docs })}\n`, { mode: 0o600 })
  for (const [name, text] of Object.entries(bytes)) writeFileSync(join(dir, `${name}.json`), text, { mode: 0o600 })
  const meta = { version: 1, basis: { 'run2.json': { 'state.json': sha(bytes.state) }, 'run3.json': { 'state.json': sha(bytes.state), 'run2.json': sha(bytes.run2) } } }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
  return sha(bytes.run3)
}

function cli(verb, args) {
  const argsPath = join(WORK, `args ${++caseNo}.json`)
  writeFileSync(argsPath, JSON.stringify(args))
  const r = spawnSync(process.execPath, [MODULE_PATH, verb, '--args-file', argsPath], { encoding: 'utf8', env: ENV, timeout: 60000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
function assertError(r, code, exit) {
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, `${JSON.stringify({ error: code })}\n`)
  assert.equal(r.status, exit)
}
const sectionOf = (stdout, header, next) => {
  const lines = stdout.split('\n')
  return lines.slice(lines.indexOf(header) + 1, lines.indexOf(next))
}

try {
  await test('the module exports only BLUEPRINT_APPROVE_CODES', async () => {
    const m = await import(MODULE_PATH)
    assert.deepEqual(Object.keys(m), ['BLUEPRINT_APPROVE_CODES'])
    assert.equal(Object.keys(m.BLUEPRINT_APPROVE_CODES).length, 18)
  })

  await test('every empty section prints - None., and a missing or non-list value is an empty list', () => {
    const repo = makeRepo()
    const hash = writeState(repo, { run2: RUN2({ modules: 'not a list', summary: null }, { notes: undefined }), run3: RUN3({ notes: {} }) })
    const r = cli('show', { repo })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, [
      `Blueprint approval: ${APP}`, `Branch: ${BRANCH}`, 'Summary: ',
      'Modules:', '- None.', 'ADRs:', '- None.', 'Departures from the default stack:', '- None.', 'Knowledge:', '- None.',
      'Unverified premises:', '- None.', 'Design notes:', '- None.',
      'Slices:', '- S1 scaffold: g1 (requirements: R1; depends on: none; criteria: 1)',
      'Backlog notes:', '- None.', 'Preflight still owed:', '- None.', `approvalSha256: ${hash}`, '',
    ].join('\n'))
  })

  await test('values that are not strings are JSON, items that are not objects have empty fields, and blanks take their words', () => {
    const repo = makeRepo()
    const design = {
      modules: [
        { id: 7, name: { n: 1 }, responsibility: 'r', requirements: [], boundary: 1, shapes: [{ name: 'Only' }], pick: 'Only' },
        { id: 'M2', name: 'n', responsibility: 'r', requirements: [1, `key ${FAKE_KEY}`], boundary: 0, shapes: [{ name: 'X' }], pick: 'Y' },
        null,
      ],
      adrs: [5],
      knowledge: [{ id: 'K1', knowledge: '  spaced\n out ', owner: ' \t ' }, { id: 'K2', knowledge: 'k', owner: 'src/k.ts' }],
      premises: [{ claim: 'c', evidence: '  \n', status: 'UNVERIFIED' }, { claim: 'v', evidence: '', status: 'VERIFIED' }],
    }
    const run2 = RUN2(design, { notes: [{ issue: 'i', fix: ' \n ' }, ['a', 1], null] })
    const run3 = RUN3({ owners: [{ id: 'K2', built_in: '' }, { id: 'K1', built_in: 'S1' }, { id: 'K1', built_in: 'S9' }] })
    const state = STATE({ preflight: [{ what: 'Key', why: 'w', needed_by: 'S1', have: false }, { what: 'Done', why: 'w', needed_by: 'S1', have: true }] })
    const hash = writeState(repo, { state, run2, run3 })
    const r = cli('show', { repo })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(FAKE_KEY), 'an id list item is redacted')
    assert.deepEqual(sectionOf(r.stdout, 'Modules:', 'ADRs:'), [
      '- 7 {"n":1}: r (no requirement)',
      '  Boundary: picked Only over none',
      '- M2 n: r (1, key <redacted: API key>)',
      '-  :  (no requirement)',
    ])
    assert.deepEqual(sectionOf(r.stdout, 'ADRs:', 'Departures from the default stack:'), ['-  : '])
    assert.deepEqual(sectionOf(r.stdout, 'Knowledge:', 'Unverified premises:'),
      ['- K1 spaced out: owner none, built in S1', '- K2 k: owner src/k.ts, built in none'])
    assert.deepEqual(sectionOf(r.stdout, 'Unverified premises:', 'Design notes:'), ['- c (no evidence yet)'])
    assert.deepEqual(sectionOf(r.stdout, 'Design notes:', 'Slices:'), ['- i', '- ["a",1]', '- '])
    assert.deepEqual(sectionOf(r.stdout, 'Preflight still owed:', `approvalSha256: ${hash}`), ['- Key'])
  })

  await test('a repo given through a symlink or with a trailing slash is the same top level', () => {
    const repo = makeRepo()
    const hash = writeState(repo)
    const link = join(WORK, `link ${caseNo}`)
    symlinkSync(repo, link)
    for (const given of [link, `${repo}/`]) {
      const r = cli('show', { repo: given })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.endsWith(`approvalSha256: ${hash}\n`))
    }
  })

  await test('docs/blueprint as a file and knowledge-map.json as a directory are TARGET_INVALID, exit 2', () => {
    for (const setup of [repo => put(repo, 'docs/blueprint', 'file\n'), repo => mkdirSync(join(repo, 'docs', 'knowledge-map.json'), { recursive: true })]) {
      const repo = makeRepo()
      const hash = writeState(repo)
      setup(repo)
      assertError(cli('approve', { repo, approvalSha256: hash }), 'TARGET_INVALID', 2)
      assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main')
      assert.equal(gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]), 1)
    }
  })

  await test('write-docs refusing a backlog.json that is not a backlog is WRITE_DOCS_FAILED, exit 3, with the file as it was', () => {
    const repo = makeRepo()
    const hash = writeState(repo)
    put(repo, 'docs/backlog.json', '{"not": "a backlog"}\n')
    assertError(cli('approve', { repo, approvalSha256: hash }), 'WRITE_DOCS_FAILED', 3)
    assert.equal(readFileSync(join(repo, 'docs', 'backlog.json'), 'utf8'), '{"not": "a backlog"}\n')
    assert.ok(!existsSync(join(repo, 'docs', 'blueprint')))
    assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main')
    assert.equal(gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]), 1)
  })

  await test('a snapshot read that fails is IO_ERROR, exit 3, and the rollback never touches the target it could not record',
    { skip: IS_ROOT ? 'root reads a mode-000 file' : false }, () => {
      const repo = makeRepo()
      const hash = writeState(repo)
      put(repo, 'docs/knowledge-map.json', 'unreadable\n')
      chmodSync(join(repo, 'docs', 'knowledge-map.json'), 0o000)
      try {
        assertError(cli('approve', { repo, approvalSha256: hash }), 'IO_ERROR', 3)
      } finally {
        chmodSync(join(repo, 'docs', 'knowledge-map.json'), 0o644)
      }
      assert.equal(readFileSync(join(repo, 'docs', 'knowledge-map.json'), 'utf8'), 'unreadable\n')
      assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main')
      assert.equal(gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]), 1)
    })

  await test('a target the hook deletes is recreated with its prior bytes and mode', () => {
    const repo = makeRepo()
    put(repo, 'docs/backlog.json', `${JSON.stringify(RUN3({}).backlog)}\n`)
    chmodSync(join(repo, 'docs', 'backlog.json'), 0o600)
    const hash = writeState(repo)
    hook(repo, 'rm -f docs/backlog.json\nexit 1')
    assertError(cli('approve', { repo, approvalSha256: hash }), 'COMMIT_FAILED', 3)
    assert.equal(readFileSync(join(repo, 'docs', 'backlog.json'), 'utf8'), `${JSON.stringify(RUN3({}).backlog)}\n`)
    assert.equal(statSync(join(repo, 'docs', 'backlog.json')).mode & 0o777, 0o600)
    assert.equal(gitStatus(repo, ['diff', '--cached', '--quiet']), 0)
  })

  await test('approve from a detached HEAD branches from that commit and leaves every branch where it was', () => {
    const repo = makeRepo()
    git(repo, ['checkout', '-q', '--detach'])
    const start = git(repo, ['rev-parse', 'HEAD']).trim()
    const hash = writeState(repo)
    const r = cli('approve', { repo, approvalSha256: hash })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.paths, [DOC, 'docs/backlog.json'])
    assert.equal(git(repo, ['symbolic-ref', 'HEAD']).trim(), `refs/heads/${BRANCH}`)
    assert.equal(git(repo, ['rev-parse', 'HEAD^']).trim(), start)
    assert.equal(git(repo, ['rev-parse', 'refs/heads/main']).trim(), start)
  })
} finally {
  spawnSync('/bin/chmod', ['-R', 'u+rwx', WORK])
  rmSync(WORK, { recursive: true, force: true })
}
