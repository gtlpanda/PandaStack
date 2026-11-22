// CP-04a implementation edges the frozen acceptance does not pin: errors that carry
// nothing but the code, message and file; modes under any umask; a failed write that
// leaves no temp file; the 40/64-hex exemptions and the redaction length boundaries;
// redactJSON's own-key and symbol handling; a BOM-prefixed state refused as SKILL.md's
// command refuses it; meta.json kept, replaced and left alone; freshness of a run
// file that is not a regular file; a linked worktree's state dir; and the args-file
// rules shared with graph-host. Fake credentials are assembled at run time.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../graphs/blueprint/skills/blueprint/blueprint-state.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'blueprint-state-')))
let caseNo = 0
function makeCase() {
  const base = join(WORK, `case-${++caseNo}`)
  mkdirSync(base)
  return { base, dir: join(base, 'harness-blueprint') }
}
const mode = path => statSync(path).mode & 0o777
const listing = dir => readdirSync(dir).sort()
const repeatTo = (alphabet, n) => Array.from({ length: n }, (_, i) => alphabet[(i * 5 + 1) % alphabet.length]).join('')
const MIXED = 'aB3cD5eF7gH9iJ2kL4mN6pQ8rS1tU0vW'
const HEX = '0123456789abcdef'
const STATE = { request: 'r', docs: [], brief: { mode: 'app', requirements: [{ id: 'R1' }] }, decisions: [], assumptions: [], preflight: [], gateRounds: 0 }
const RUN2 = { status: 'design-ready', design: {} }
const RUN3 = { status: 'backlog-ready', backlog: {} }

function throwsCode(fn, code, base) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.equal(caught.code, code)
  assert.equal(caught.message, `Blueprint state: ${code}.`)
  assert.deepEqual(Object.keys(caught).filter(k => k !== 'code' && k !== 'file'), [], 'no other own fields')
  assert.equal(caught.cause, undefined)
  if (base) assert.ok(!String(caught.stack).includes(base), 'no case path in the stack')
  return caught
}

async function built() {
  const m = await api()
  const c = makeCase()
  m.initState(c.dir, { request: 'x' })
  m.writeState(c.dir, STATE)
  m.writeRun(c.dir, 2, RUN2)
  m.writeRun(c.dir, 3, RUN3)
  return { m, c }
}

try {
  await test('blueprint-state: refusals carry only code, message and a fixed file name', async () => {
    const m = await api()
    const c = makeCase()
    throwsCode(() => m.readState(c.dir), 'MISSING', c.base)
    throwsCode(() => m.initState(c.dir, { request: 'x', docs: [join(c.base, 'gone.md')] }), 'DOC_MISSING', c.base)
    mkdirSync(c.dir)
    writeFileSync(join(c.dir, 'state.json'), `{"leak":"${c.base}"`)
    assert.equal(throwsCode(() => m.readState(c.dir), 'MALFORMED', c.base).file, 'state.json')
  })

  await test('blueprint-state: modes are 0700 and 0600 under a zero or a closed umask', async () => {
    const m = await api()
    const previous = process.umask()
    try {
      for (const mask of [0o000, 0o077]) {
        process.umask(mask)
        const c = makeCase()
        m.initState(c.dir, { request: 'x' })
        m.writeState(c.dir, STATE)
        m.writeRun(c.dir, 2, RUN2)
        assert.equal(mode(c.dir), 0o700)
        for (const file of listing(c.dir)) assert.equal(mode(join(c.dir, file)), 0o600, file)
      }
    } finally { process.umask(previous) }
  })

  await test('blueprint-state: a write that cannot land is IO_ERROR naming the file, with no temp file left', async () => {
    const m = await api()
    const c = makeCase()
    m.initState(c.dir, { request: 'x' })
    mkdirSync(join(c.dir, 'state.json', 'occupied'), { recursive: true })
    assert.equal(throwsCode(() => m.writeState(c.dir, STATE), 'IO_ERROR', c.base).file, 'state.json')
    assert.deepEqual(listing(c.dir), ['request.json', 'state.json'])
  })

  await test('blueprint-state: hex ids are exempt only at exactly 40 and 64; length boundaries hold', async () => {
    const { redactSecrets } = await api()
    const kept = [repeatTo(HEX, 40), repeatTo(HEX, 64), repeatTo(HEX, 31), repeatTo(HEX, 40).toUpperCase(), repeatTo(MIXED, 23),
      `${repeatTo(HEX, 20)}AB${repeatTo(HEX, 18)}`]
    for (const value of kept) assert.equal(redactSecrets(`v=${value}`), `v=${value}`, value)
    for (const value of [repeatTo(HEX, 32), repeatTo(HEX, 41), repeatTo(HEX, 63), repeatTo(MIXED, 24)]) {
      assert.equal(redactSecrets(`v: ${value}`), 'v: <redacted: secret value>', value)
    }
    assert.equal(redactSecrets(`v='${repeatTo(MIXED, 22)}=='`), "v='<redacted: secret value>'", 'padding goes with the run')
    assert.equal(redactSecrets(`x${'sk'}_live_${repeatTo(MIXED, 12)}`), `x${'sk'}_live_${repeatTo(MIXED, 12)}`, 'no match after a letter')
  })

  await test('blueprint-state: a token glued to an earlier one is redacted in the same call, so redaction stays idempotent', async () => {
    const { redactSecrets } = await api()
    const stripe = ['sk', 'live', repeatTo(MIXED, 8)].join('_')
    const glued = [
      ['AK' + 'IA' + repeatTo('Q7W3E9R1T5Y2U8I4', 16) + stripe, '<redacted: AWS access key><redacted: API key>'],
      ['AI' + 'za' + repeatTo(MIXED, 35) + stripe, '<redacted: Google API key><redacted: API key>'],
    ]
    for (const [input, expected] of glued) {
      const once = redactSecrets(input)
      assert.equal(once, expected)
      assert.equal(redactSecrets(once), once)
    }
  })

  await test('blueprint-state: redactJSON keeps __proto__ as an own key and refuses symbol keys and holes', async () => {
    const { redactJSON } = await api()
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}')
    const out = redactJSON(parsed)
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
    assert.deepEqual(Object.keys(out), ['__proto__', 'a'])
    assert.equal(({}).polluted, undefined)
    const bare = Object.assign(Object.create(null), { k: 'v' })
    assert.equal(Object.getPrototypeOf(redactJSON(bare)), Object.prototype)
    for (const bad of [{ [Symbol('s')]: 1 }, [1, , 3]]) throwsCode(() => redactJSON(bad), 'INVALID_INPUT') // eslint-disable-line no-sparse-arrays
  })

  await test('blueprint-state: a BOM-prefixed state.json is MALFORMED, as SKILL.md\'s JSON.parse would fail', async () => {
    const m = await api()
    const c = makeCase()
    mkdirSync(c.dir)
    writeFileSync(join(c.dir, 'state.json'), `﻿${JSON.stringify(STATE)}`)
    throwsCode(() => m.designArgs(c.dir), 'MALFORMED')
    assert.equal(m.freshness(c.dir).design, 'missing', 'freshness only hashes, never parses')
  })

  await test('blueprint-state: writeRun(1) leaves meta.json alone; 2 and 3 keep each other\'s entry; a malformed meta is replaced', async () => {
    const { m, c } = await built()
    const metaPath = join(c.dir, 'meta.json')
    const before = readFileSync(metaPath)
    m.writeRun(c.dir, 1, { status: 'escalate' })
    assert.deepEqual(readFileSync(metaPath), before)
    m.writeRun(c.dir, 2, RUN2)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(metaPath, 'utf8')).basis).sort(), ['run2.json', 'run3.json'])
    writeFileSync(metaPath, '{"version":1,"basis":{"run3.json":{"state.json":"short"}}}')
    m.writeRun(c.dir, 2, RUN2)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(metaPath, 'utf8')).basis), ['run2.json'], 'the malformed entry is not kept')
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'stale' })
  })

  await test('blueprint-state: a run file that is not a regular file is stale, never fresh', async () => {
    const one = await built()
    const real = join(one.c.base, 'run2-copy.json')
    writeFileSync(real, readFileSync(join(one.c.dir, 'run2.json')))
    rmSync(join(one.c.dir, 'run2.json'))
    symlinkSync(real, join(one.c.dir, 'run2.json'))
    assert.deepEqual(one.m.freshness(one.c.dir), { design: 'stale', backlog: 'stale' })
    const two = await built()
    rmSync(join(two.c.dir, 'run3.json'))
    mkdirSync(join(two.c.dir, 'run3.json'))
    assert.deepEqual(two.m.freshness(two.c.dir), { design: 'fresh', backlog: 'stale' })
  })

  await test('blueprint-state: a linked worktree gets git\'s per-worktree state path', async () => {
    const { resolveStateDir } = await api()
    const repo = join(WORK, 'wt-main')
    const linked = join(WORK, 'wt-linked')
    const env = { PATH: process.env.PATH, HOME: join(WORK, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (...args) => execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', repo)
    git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start')
    git('-C', repo, 'worktree', 'add', '-q', linked)
    const path = resolveStateDir(linked)
    assert.equal(path, join(repo, '.git', 'worktrees', 'wt-linked', 'harness-blueprint'))
    assert.equal(resolveStateDir(repo), join(repo, '.git', 'harness-blueprint'))
  })

  await test('blueprint-state: initState treats undefined options as defaults and stores doc paths as given', async () => {
    const m = await api()
    const c = makeCase()
    const doc = join(c.base, 'doc with spaces.md')
    writeFileSync(doc, '# d\n')
    assert.deepEqual(m.initState(c.dir, { request: undefined, docs: [doc], restart: undefined }), { request: null, docs: [doc] })
    throwsCode(() => m.initState(c.dir, { request: 'x', docs: [7] }), 'DOC_INVALID')
    throwsCode(() => m.validateRun('2', RUN2), 'INVALID_INPUT')
  })

  await test('blueprint-state: readArgsFile follows a symlink to a regular file and allows a listed __proto__', async () => {
    const { readArgsFile } = await api()
    const c = makeCase()
    const target = join(c.base, 'target.json')
    writeFileSync(target, '{"repo":"/r"}')
    symlinkSync(target, join(c.base, 'link.json'))
    assert.deepEqual(readArgsFile(join(c.base, 'link.json'), ['repo']), { repo: '/r' })
    writeFileSync(target, '{"__proto__":1}')
    assert.equal(Object.keys(readArgsFile(target, ['__proto__']))[0], '__proto__')
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
