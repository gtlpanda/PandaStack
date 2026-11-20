// CP-05c frozen acceptance: QA loop ledger rules as code
// (spec/contracts/codex-parity-cp-05c.md). Offline: owned temp directories, no HOME,
// git, network or provider. The module is imported lazily in each case, so a
// missing module fails every case on its own. The drift case reads loop.md and
// harness-repair.js from the same root: the Claude path follows that prose.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const MODULE_URL = pathToFileURL(resolve(ROOT, 'graphs/qa/tool/qa-ledger.mjs')).href
const load = () => import(MODULE_URL)
const IS_ROOT = process.getuid?.() === 0
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const THROWN_CODES = ['INVALID_LEDGER', 'INVALID_RESULT', 'INVALID_ARGS', 'LEDGER_IO_ERROR']

// ---------- helpers ----------

function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05c-')))
  t.after(() => {
    const open = dir => {
      try { chmodSync(dir, 0o700) } catch { /* best effort */ }
      let names = []
      try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of names) if (entry.isDirectory()) open(join(dir, entry.name))
    }
    open(root)
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

const empty = () => ({ runs: [], stuckSigs: [], blockedOn: null, idleRuns: 0 })
const ledgerOf = (extra = {}) => ({ ...empty(), ...extra })
const result = (status, extra = {}) => ({ status, reason: 'r', fixRounds: 1, stuckSig: null, lastVerify: 'VERIFY: PASS',
  touched: ['a.js'], fixed: ['x'], noted: [], refuted: [], history: [{ node: 'check' }], ...extra })
const mode = path => statSync(path).mode & 0o777
const listing = dir => readdirSync(dir).sort()

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

// Fixed code, fixed message, and no input value in the message.
function throwsCode(fn, code, ...secrets) {
  assert.ok(THROWN_CODES.includes(code))
  assert.throws(fn, error => {
    assert.ok(error instanceof Error, 'an Error is thrown')
    assert.equal(error.code, code)
    assert.equal(error.message, `qa-ledger: ${code}.`)
    for (const secret of secrets) assert.ok(!error.message.includes(String(secret)), 'the message echoes no input')
    return true
  })
}

// ---------- constants and drift ----------

test('constants and codes are exactly the pinned values', async () => {
  const m = await load()
  assert.equal(m.RUNS_KEPT, 20)
  assert.equal(m.IDLE_STOP_RUNS, 2)
  assert.equal(m.DEFAULT_MAX_FIX_ROUNDS, 3)
  assert.equal(m.LEDGER_GIT_PATH, 'harness-loop')
  assert.equal(m.LEDGER_FILE_NAME, 'ledger.json')
  assert.ok(Object.isFrozen(m.QA_LEDGER_CODES))
  const codes = ['LEDGER_UNPARSEABLE', ...THROWN_CODES]
  assert.deepEqual(Object.keys(m.QA_LEDGER_CODES).sort(), [...codes].sort())
  for (const code of codes) assert.equal(m.QA_LEDGER_CODES[code], code)
  for (const name of ['emptyLedger', 'readLedger', 'writeLedger', 'applyResult', 'workflowArgs', 'applyIdle', 'shouldStop', 'setBlockedOn']) {
    assert.equal(typeof m[name], 'function', `${name} is exported`)
  }
})

test('drift: exported numbers, names and default ledger equal loop.md and harness-repair.js', async () => {
  const m = await load()
  const loop = readFileSync(resolve(ROOT, 'loop.md'), 'utf8')
  const one = (pattern, what) => {
    const hits = [...loop.matchAll(pattern)]
    assert.equal(hits.length, 1, `loop.md states ${what} exactly once`)
    return hits[0]
  }
  assert.equal(Number(one(/keep the last (\d+)\b/g, 'the kept run count')[1]), m.RUNS_KEPT)
  assert.equal(Number(one(/When it reaches (\d+)\b/g, 'the idle stop count')[1]), m.IDLE_STOP_RUNS)
  assert.equal(Number(one(/"maxFixRounds": (\d+)\b/g, 'the maxFixRounds argument')[1]), m.DEFAULT_MAX_FIX_ROUNDS)
  const path = one(/--git-path ([a-z-]+)\)\/([a-z.]+)"/g, 'the ledger path')
  assert.equal(path[1], m.LEDGER_GIT_PATH)
  assert.equal(path[2], m.LEDGER_FILE_NAME)
  const defaults = one(/Missing or unparseable means\s+`(\{[^`]*\})`/g, 'the default ledger')
  assert.deepEqual(JSON.parse(defaults[1]), m.emptyLedger())
  for (const key of ['runs', 'stuckSigs', 'blockedOn', 'idleRuns']) assert.ok(loop.includes(`\`${key}\``), `loop.md names ${key}`)

  const graph = readFileSync(resolve(ROOT, 'graphs/qa/workflows/harness-repair.js'), 'utf8')
  const graphDefault = [...graph.matchAll(/const DEFAULT_MAX_FIX_ROUNDS = (\d+)\b/g)]
  assert.equal(graphDefault.length, 1)
  assert.equal(Number(graphDefault[0][1]), m.DEFAULT_MAX_FIX_ROUNDS)
  const statuses = new Set([...graph.matchAll(/\bfinish\('([a-z]+)'/g)].map(hit => hit[1]))
  assert.deepEqual([...statuses].sort(), ['done', 'escalate'], 'the graph finishes only with done or escalate')
  assert.match(graph, /\{ stuckSig: sig \}/, 'the graph result names its signature stuckSig')
})

test('emptyLedger returns a fresh default ledger on every call', async () => {
  const { emptyLedger } = await load()
  const a = emptyLedger()
  const b = emptyLedger()
  assert.deepEqual(a, empty())
  assert.notEqual(a, b)
  assert.notEqual(a.runs, b.runs)
  assert.notEqual(a.stuckSigs, b.stuckSigs)
  a.runs.push({ status: 'done' })
  assert.deepEqual(emptyLedger(), empty())
})

// ---------- readLedger ----------

test('readLedger: a missing file gives the default ledger with no warning', async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  assert.deepEqual(readLedger(join(root, 'ledger.json')), { ledger: empty(), warning: null })
  assert.deepEqual(readLedger(join(root, 'no', 'such', 'dir', 'ledger.json')), { ledger: empty(), warning: null })
  assert.deepEqual(listing(root), [], 'reading creates nothing')
})

test('readLedger: every unparseable form gives the default ledger and LEDGER_UNPARSEABLE', async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  const bodies = {
    'not-json': 'runs: []',
    'empty': '',
    'truncated': '{"runs": [',
    'array': '[]',
    'null': 'null',
    'number': '7',
    'string': '"ledger"',
    'runs-object': JSON.stringify(ledgerOf({ runs: {} })),
    'runs-number-item': JSON.stringify(ledgerOf({ runs: [{ status: 'done' }, 3] })),
    'runs-array-item': JSON.stringify(ledgerOf({ runs: [[]] })),
    'runs-null-item': JSON.stringify(ledgerOf({ runs: [null] })),
    'runs-null': JSON.stringify(ledgerOf({ runs: null })),
    'sigs-number-item': JSON.stringify(ledgerOf({ stuckSigs: ['a', 1] })),
    'sigs-string': JSON.stringify(ledgerOf({ stuckSigs: 'a' })),
    'blocked-number': JSON.stringify(ledgerOf({ blockedOn: 5 })),
    'blocked-object': JSON.stringify(ledgerOf({ blockedOn: {} })),
    'idle-negative': JSON.stringify(ledgerOf({ idleRuns: -1 })),
    'idle-fraction': JSON.stringify(ledgerOf({ idleRuns: 1.5 })),
    'idle-string': JSON.stringify(ledgerOf({ idleRuns: '2' })),
    'idle-null': JSON.stringify(ledgerOf({ idleRuns: null })),
  }
  for (const [name, body] of Object.entries(bodies)) {
    const file = join(root, name + '.json')
    writeFileSync(file, body)
    assert.deepEqual(readLedger(file), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' }, name)
    assert.equal(readFileSync(file, 'utf8'), body, `${name}: the file is left as it was`)
  }
  const binary = join(root, 'binary.json')
  writeFileSync(binary, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]))
  assert.deepEqual(readLedger(binary), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' }, 'invalid UTF-8')
})

test('readLedger: a directory, a symlink or a FIFO is unparseable and never followed or opened', async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  const dir = join(root, 'dir.json')
  mkdirSync(dir)
  assert.deepEqual(readLedger(dir), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' }, 'directory')

  const real = join(root, 'real.json')
  writeFileSync(real, JSON.stringify(ledgerOf({ stuckSigs: ['followed'] })))
  const link = join(root, 'link.json')
  symlinkSync(real, link)
  assert.deepEqual(readLedger(link), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' }, 'symlink to a valid ledger')

  const fifo = join(root, 'fifo.json')
  const made = spawnSync(existsSync('/usr/bin/mkfifo') ? '/usr/bin/mkfifo' : 'mkfifo', [fifo])
  assert.equal(made.status, 0, 'mkfifo is available')
  assert.deepEqual(readLedger(fifo), { ledger: empty(), warning: 'LEDGER_UNPARSEABLE' }, 'FIFO')
})

test('readLedger: missing keys take their defaults silently; other keys are dropped; runs are not trimmed', async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  const file = join(root, 'ledger.json')
  const run = { status: 'escalate', stuckSig: 's1', at: '2026-11-20T00:00:00Z' }

  writeFileSync(file, JSON.stringify({ runs: [run], stuckSigs: ['s1'] }))
  assert.deepEqual(readLedger(file), { ledger: { runs: [run], stuckSigs: ['s1'], blockedOn: null, idleRuns: 0 }, warning: null })

  writeFileSync(file, '{}')
  assert.deepEqual(readLedger(file), { ledger: empty(), warning: null })

  writeFileSync(file, JSON.stringify({ blockedOn: 'merge #1 (abc)', idleRuns: 1, extra: true, __proto__x: 1 }))
  const read = readLedger(file)
  assert.equal(read.warning, null)
  assert.deepEqual(read.ledger, { runs: [], stuckSigs: [], blockedOn: 'merge #1 (abc)', idleRuns: 1 })
  assert.deepEqual(Object.keys(read.ledger).sort(), ['blockedOn', 'idleRuns', 'runs', 'stuckSigs'])

  const many = Array.from({ length: 25 }, (_, i) => ({ status: 'done', n: i }))
  writeFileSync(file, JSON.stringify(ledgerOf({ runs: many, blockedOn: '', stuckSigs: ['', 'b'] })))
  const full = readLedger(file)
  assert.equal(full.warning, null)
  assert.deepEqual(full.ledger, ledgerOf({ runs: many, blockedOn: '', stuckSigs: ['', 'b'] }))
})

test('readLedger: a bad path argument is INVALID_ARGS; other filesystem errors are LEDGER_IO_ERROR', async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  for (const bad of ['ledger.json', './ledger.json', '', 42, null, undefined, {}, `${root}/a\0b.json`]) {
    throwsCode(() => readLedger(bad), 'INVALID_ARGS', 'ledger.json')
  }
  const file = join(root, 'plain')
  writeFileSync(file, 'x')
  throwsCode(() => readLedger(join(file, 'ledger.json')), 'LEDGER_IO_ERROR', root)
})

test('readLedger: an unreadable file is LEDGER_IO_ERROR', { skip: IS_ROOT && 'uid 0 reads a mode 000 file' }, async t => {
  const { readLedger } = await load()
  const root = sandbox(t)
  const file = join(root, 'ledger.json')
  writeFileSync(file, JSON.stringify(empty()))
  chmodSync(file, 0o000)
  throwsCode(() => readLedger(file), 'LEDGER_IO_ERROR', root)
})

// ---------- writeLedger ----------

test('writeLedger: creates the directory 0700 and the file 0600, round-trips, leaves no temp file', async t => {
  const { readLedger, writeLedger } = await load()
  const root = sandbox(t)
  const dir = join(root, 'git', 'harness-loop')
  const file = join(dir, 'ledger.json')
  const ledger = ledgerOf({ runs: [{ status: 'done', at: '2026-11-20T01:02:03Z', touched: [] }], stuckSigs: ['s'], blockedOn: 'merge #2 (b)', idleRuns: 1 })
  assert.equal(writeLedger(file, ledger), undefined)
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(join(root, 'git')), 0o700)
  assert.equal(mode(file), 0o600)
  assert.ok(lstatSync(file).isFile())
  assert.deepEqual(listing(dir), ['ledger.json'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ledger)
  assert.deepEqual(readLedger(file), { ledger, warning: null })
})

test('writeLedger: replaces the file by rename (new inode, 0644 becomes 0600, umask ignored), never in place', async t => {
  const { writeLedger } = await load()
  const root = sandbox(t)
  chmodSync(root, 0o755)
  const file = join(root, 'ledger.json')
  writeFileSync(file, JSON.stringify(empty()))
  chmodSync(file, 0o644)
  const before = statSync(file).ino
  const old = process.umask(0)
  try { writeLedger(file, ledgerOf({ idleRuns: 2 })) } finally { process.umask(old) }
  assert.notEqual(statSync(file).ino, before, 'a new inode: the file was renamed into place')
  assert.equal(mode(file), 0o600)
  assert.equal(mode(root), 0o755, 'an existing directory keeps its mode')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ledgerOf({ idleRuns: 2 }))
  assert.deepEqual(listing(root), ['ledger.json'])
})

test('writeLedger: a symlink at the path is replaced; its target is never written', async t => {
  const { writeLedger } = await load()
  const root = sandbox(t)
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'keep me')
  const dir = join(root, 'loop')
  mkdirSync(dir)
  const file = join(dir, 'ledger.json')
  symlinkSync(outside, file)
  assert.equal(readlinkSync(file), outside)
  writeLedger(file, ledgerOf({ stuckSigs: ['x'] }))
  assert.ok(lstatSync(file).isFile(), 'the path is now a regular file')
  assert.equal(readFileSync(outside, 'utf8'), 'keep me')
  assert.deepEqual(listing(dir), ['ledger.json'])
})

test('writeLedger: a bad path or ledger is refused before any filesystem step', async t => {
  const { writeLedger } = await load()
  const root = sandbox(t)
  const file = join(root, 'new', 'ledger.json')
  for (const bad of ['ledger.json', '', 7, null, `${root}/a\0b`]) throwsCode(() => writeLedger(bad, empty()), 'INVALID_ARGS', root)
  const bads = [
    null, [], 'ledger', {}, { runs: [], stuckSigs: [], blockedOn: null }, { ...empty(), extra: 1 },
    ledgerOf({ runs: [1] }), ledgerOf({ runs: {} }), ledgerOf({ stuckSigs: [1] }), ledgerOf({ blockedOn: 0 }),
    ledgerOf({ blockedOn: undefined }), ledgerOf({ idleRuns: -1 }), ledgerOf({ idleRuns: 0.5 }), ledgerOf({ idleRuns: Number.MAX_SAFE_INTEGER + 1 }),
    Object.assign(new (class Ledger {})(), empty()), new Map(Object.entries(empty())),
  ]
  for (const bad of bads) throwsCode(() => writeLedger(file, bad), 'INVALID_LEDGER', root)
  assert.equal(existsSync(join(root, 'new')), false, 'no directory was created')
  assert.deepEqual(listing(root), [])
})

test('writeLedger: a failed rename throws LEDGER_IO_ERROR, keeps what was there and leaves no temp file', async t => {
  const { writeLedger } = await load()
  const root = sandbox(t)
  const file = join(root, 'ledger.json')
  mkdirSync(file)
  writeFileSync(join(file, 'inside'), 'x')
  throwsCode(() => writeLedger(file, empty()), 'LEDGER_IO_ERROR', root)
  assert.ok(statSync(file).isDirectory())
  assert.deepEqual(listing(file), ['inside'])
  assert.deepEqual(listing(root), ['ledger.json'], 'no temp file remains')
})

test('writeLedger: a read-only directory throws LEDGER_IO_ERROR and the previous bytes are unchanged', { skip: IS_ROOT && 'uid 0 writes into a mode 0500 directory' }, async t => {
  const { writeLedger } = await load()
  const root = sandbox(t)
  const dir = join(root, 'loop')
  mkdirSync(dir)
  const file = join(dir, 'ledger.json')
  const previous = JSON.stringify(ledgerOf({ stuckSigs: ['old'] }))
  writeFileSync(file, previous)
  chmodSync(dir, 0o500)
  throwsCode(() => writeLedger(file, ledgerOf({ stuckSigs: ['new'] })), 'LEDGER_IO_ERROR', root)
  chmodSync(dir, 0o700)
  assert.equal(readFileSync(file, 'utf8'), previous)
  assert.deepEqual(listing(dir), ['ledger.json'])
})

// ---------- applyResult ----------

test('applyResult: done appends the run with at and clears stuckSigs; nothing else changes', async () => {
  const { applyResult } = await load()
  const ledger = deepFreeze(ledgerOf({ runs: [{ status: 'escalate', at: '2026-11-19T00:00:00Z' }], stuckSigs: ['a', 'b'], blockedOn: 'merge #3 (c)', idleRuns: 1 }))
  const done = deepFreeze(result('done'))
  const next = applyResult(ledger, done, { now: new Date('2026-11-20T01:02:03.456Z') })
  assert.notEqual(next, ledger)
  assert.deepEqual(next, {
    runs: [{ status: 'escalate', at: '2026-11-19T00:00:00Z' }, { ...result('done'), at: '2026-11-20T01:02:03Z' }],
    stuckSigs: [], blockedOn: 'merge #3 (c)', idleRuns: 1,
  })
  assert.deepEqual(ledger.stuckSigs, ['a', 'b'], 'the input ledger is unchanged')
})

test('applyResult: escalate adds a string stuckSig once, in order; without one stuckSigs stay', async () => {
  const { applyResult } = await load()
  const now = new Date('2026-11-20T00:00:00Z')
  const base = deepFreeze(ledgerOf({ stuckSigs: ['a'] }))
  assert.deepEqual(applyResult(base, result('escalate', { stuckSig: 'b' }), { now }).stuckSigs, ['a', 'b'])
  assert.deepEqual(applyResult(base, result('escalate', { stuckSig: 'a' }), { now }).stuckSigs, ['a'], 'unique')
  for (const sig of [null, undefined, '', 7, ['b'], { b: 1 }]) {
    assert.deepEqual(applyResult(base, result('escalate', { stuckSig: sig }), { now }).stuckSigs, ['a'], `stuckSig ${JSON.stringify(sig)}`)
  }
  const { stuckSig, ...noSig } = result('escalate')
  assert.equal(stuckSig, null)
  const next = applyResult(base, noSig, { now })
  assert.deepEqual(next.stuckSigs, ['a'])
  assert.deepEqual(next.runs, [{ ...noSig, at: '2026-11-20T00:00:00Z' }])
})

test('applyResult: at is date -u +%FT%TZ, seconds truncated, replacing the result own at; default now is the clock', async () => {
  const { applyResult } = await load()
  const at = now => applyResult(empty(), result('done', { at: 'stale' }), { now }).runs[0].at
  assert.equal(at(new Date('2026-01-02T03:04:05.999Z')), '2026-01-02T03:04:05Z')
  assert.equal(at(new Date('2026-11-20T23:59:59.000Z')), '2026-11-20T23:59:59Z')
  const start = Math.floor(Date.now() / 1000) * 1000
  const stamped = applyResult(empty(), result('done')).runs[0].at
  const stampedNoOptions = applyResult(empty(), result('done'), {}).runs[0].at
  const end = Date.now()
  for (const value of [stamped, stampedNoOptions]) {
    assert.match(value, AT)
    const ms = Date.parse(value)
    assert.ok(ms >= start && ms <= end, 'the default clock is used')
  }
})

test('applyResult: keeps only the last 20 runs', async () => {
  const { applyResult } = await load()
  const now = new Date('2026-11-20T00:00:00Z')
  const runs = n => Array.from({ length: n }, (_, i) => ({ status: 'done', n: i }))
  const nineteen = applyResult(ledgerOf({ runs: runs(19) }), result('done', { n: 'new' }), { now })
  assert.equal(nineteen.runs.length, 20)
  assert.deepEqual(nineteen.runs[0], { status: 'done', n: 0 })
  const twenty = applyResult(deepFreeze(ledgerOf({ runs: runs(20) })), result('done', { n: 'new' }), { now })
  assert.equal(twenty.runs.length, 20)
  assert.deepEqual(twenty.runs[0], { status: 'done', n: 1 })
  assert.equal(twenty.runs[19].n, 'new')
  const thirty = applyResult(ledgerOf({ runs: runs(30) }), result('escalate', { n: 'new' }), { now })
  assert.equal(thirty.runs.length, 20)
  assert.deepEqual(thirty.runs[0], { status: 'done', n: 11 })
})

test('applyResult: the run is a JSON copy, so later changes to the result do not reach the ledger', async () => {
  const { applyResult } = await load()
  const live = result('done', { touched: ['a.js'], when: new Date('2026-11-20T00:00:00Z'), skip: undefined })
  const next = applyResult(empty(), live, { now: new Date('2026-11-20T00:00:00Z') })
  live.touched.push('b.js')
  live.reason = 'changed'
  const run = next.runs[0]
  assert.deepEqual(run.touched, ['a.js'])
  assert.equal(run.reason, 'r')
  assert.equal(run.when, '2026-11-20T00:00:00.000Z')
  assert.equal('skip' in run, false)
})

test('applyResult: refuses any other status, a non-object result, a bad ledger and bad options', async () => {
  const { applyResult } = await load()
  const now = new Date('2026-11-20T00:00:00Z')
  for (const status of ['DONE', 'Escalate', 'pass', 'running', '', null, undefined, 1, true]) {
    throwsCode(() => applyResult(empty(), result(status), { now }), 'INVALID_RESULT', status === '' ? undefined : status)
  }
  for (const bad of [null, undefined, 'done', ['done'], 5, Object.assign(new (class R {})(), { status: 'done' })]) {
    throwsCode(() => applyResult(empty(), bad, { now }), 'INVALID_RESULT')
  }
  throwsCode(() => applyResult(empty(), result('done', { size: 10n }), { now }), 'INVALID_RESULT')
  for (const bad of [null, {}, ledgerOf({ stuckSigs: [1] }), { ...empty(), extra: 1 }]) {
    throwsCode(() => applyResult(bad, result('done'), { now }), 'INVALID_LEDGER')
  }
  for (const options of [{ now: '2026-11-20T00:00:00Z' }, { now: Date.now() }, { now: new Date('nope') }, { now, at: 'x' }, null, 'now', []]) {
    throwsCode(() => applyResult(empty(), result('done'), options), 'INVALID_ARGS', 'nope')
  }
})

// ---------- workflowArgs ----------

test('workflowArgs: builds exactly repo, base, maxFixRounds and knownStuckSigs', async () => {
  const { workflowArgs } = await load()
  const ledger = deepFreeze(ledgerOf({ stuckSigs: ['s1', 's2'] }))
  const args = workflowArgs(ledger, { repo: '/work/repo', base: 'main', maxFixRounds: 5 })
  assert.deepEqual(args, { repo: '/work/repo', base: 'main', maxFixRounds: 5, knownStuckSigs: ['s1', 's2'] })
  assert.deepEqual(Object.keys(args).sort(), ['base', 'knownStuckSigs', 'maxFixRounds', 'repo'])
  assert.notEqual(args.knownStuckSigs, ledger.stuckSigs, 'a new array')
  assert.ok(args.knownStuckSigs.every(sig => typeof sig === 'string'))

  const noPr = workflowArgs(ledger, { repo: '/work/repo' })
  assert.deepEqual(noPr, { repo: '/work/repo', maxFixRounds: 3, knownStuckSigs: ['s1', 's2'] })
  assert.equal('base' in noPr, false)
  for (const base of [undefined, null, '']) {
    const args2 = workflowArgs(empty(), { repo: '/r', base, maxFixRounds: undefined })
    assert.deepEqual(args2, { repo: '/r', maxFixRounds: 3, knownStuckSigs: [] })
    assert.equal('base' in args2, false, `base ${JSON.stringify(base)} means no PR`)
  }
})

test('workflowArgs: maxFixRounds takes positive integers only; repo must be absolute; unknown keys refused', async () => {
  const { workflowArgs } = await load()
  for (const n of [1, 2, 3, 10]) assert.equal(workflowArgs(empty(), { repo: '/r', maxFixRounds: n }).maxFixRounds, n)
  for (const n of [0, -1, 1.5, '3', NaN, Infinity, null, true, Number.MAX_SAFE_INTEGER + 1]) {
    throwsCode(() => workflowArgs(empty(), { repo: '/r', maxFixRounds: n }), 'INVALID_ARGS')
  }
  for (const repo of ['repo', './repo', '', undefined, null, 7, ['/r'], '/r\0x']) {
    throwsCode(() => workflowArgs(empty(), { repo }), 'INVALID_ARGS', 'repo')
  }
  for (const base of [7, true, ['main'], {}]) throwsCode(() => workflowArgs(empty(), { repo: '/r', base }), 'INVALID_ARGS')
  throwsCode(() => workflowArgs(empty(), { repo: '/r', knownStuckSigs: ['x'] }), 'INVALID_ARGS')
  for (const options of [null, undefined, '/r', []]) throwsCode(() => workflowArgs(empty(), options), 'INVALID_ARGS')
  for (const bad of [null, ledgerOf({ stuckSigs: ['a', 2] }), ledgerOf({ stuckSigs: 'a' })]) {
    throwsCode(() => workflowArgs(bad, { repo: '/r' }), 'INVALID_LEDGER')
  }
})

// ---------- idle ----------

test('applyIdle counts idle iterations, resets on any other, and shouldStop fires at 2', async () => {
  const { applyIdle, shouldStop } = await load()
  const start = deepFreeze(ledgerOf({ stuckSigs: ['s'], blockedOn: 'x', runs: [{ status: 'done' }] }))
  assert.equal(shouldStop(start), false)
  const one = applyIdle(start, true)
  assert.notEqual(one, start)
  assert.deepEqual(one, { ...start, idleRuns: 1 })
  assert.equal(shouldStop(one), false)
  const two = applyIdle(deepFreeze(one), true)
  assert.equal(two.idleRuns, 2)
  assert.equal(shouldStop(two), true)
  assert.equal(shouldStop(ledgerOf({ idleRuns: 3 })), true)
  const reset = applyIdle(deepFreeze(two), false)
  assert.deepEqual(reset, { ...start, idleRuns: 0 })
  assert.equal(shouldStop(reset), false)
  assert.equal(applyIdle(ledgerOf({ idleRuns: 0 }), false).idleRuns, 0)
  assert.equal(start.idleRuns, 0, 'the input is unchanged')
})

test('applyIdle and shouldStop refuse a non-boolean idle and a bad ledger', async () => {
  const { applyIdle, shouldStop } = await load()
  for (const idle of ['true', 1, 0, null, undefined, {}]) throwsCode(() => applyIdle(empty(), idle), 'INVALID_ARGS')
  for (const bad of [null, {}, ledgerOf({ idleRuns: '1' }), ledgerOf({ idleRuns: -2 })]) {
    throwsCode(() => applyIdle(bad, true), 'INVALID_LEDGER')
    throwsCode(() => shouldStop(bad), 'INVALID_LEDGER')
  }
})

// ---------- blockedOn ----------

test('setBlockedOn notifies only when the line differs and clears without notifying', async () => {
  const { setBlockedOn } = await load()
  const line = 'merge #276 (a79b606c); #275 waits on it'
  const start = deepFreeze(ledgerOf({ stuckSigs: ['s'], idleRuns: 1 }))
  const first = setBlockedOn(start, line)
  assert.deepEqual(first, { ledger: { ...start, blockedOn: line }, notify: true })
  assert.notEqual(first.ledger, start)
  const same = setBlockedOn(deepFreeze(first.ledger), line)
  assert.deepEqual(same, { ledger: first.ledger, notify: false })
  const other = setBlockedOn(first.ledger, 'approve #277 (b1)')
  assert.deepEqual(other, { ledger: { ...start, blockedOn: 'approve #277 (b1)' }, notify: true })
  assert.deepEqual(setBlockedOn(first.ledger, null), { ledger: { ...start, blockedOn: null }, notify: false })
  assert.deepEqual(setBlockedOn(start, null), { ledger: start, notify: false })
  assert.equal(start.blockedOn, null, 'the input is unchanged')
})

test('setBlockedOn refuses an empty, multi-line or non-string line and a bad ledger', async () => {
  const { setBlockedOn } = await load()
  for (const line of ['', 'merge #1\nthen #2', 'merge #1\r', undefined, 5, ['x'], {}]) {
    throwsCode(() => setBlockedOn(empty(), line), 'INVALID_ARGS', 'merge #1')
  }
  for (const bad of [null, ledgerOf({ blockedOn: 1 }), { ...empty(), note: 'x' }]) {
    throwsCode(() => setBlockedOn(bad, 'x'), 'INVALID_LEDGER')
  }
})

// ---------- shared file ----------

test('a ledger read, updated by every rule and written is read back the same', async t => {
  const m = await load()
  const root = sandbox(t)
  const file = join(root, m.LEDGER_GIT_PATH, m.LEDGER_FILE_NAME)
  let { ledger, warning } = m.readLedger(file)
  assert.equal(warning, null)
  ledger = m.applyResult(ledger, result('escalate', { stuckSig: 'sig-1' }), { now: new Date('2026-11-20T10:00:00Z') })
  ledger = m.setBlockedOn(ledger, 'answer the question on #9 (deadbee)').ledger
  ledger = m.applyIdle(ledger, false)
  m.writeLedger(file, ledger)
  const back = m.readLedger(file)
  assert.deepEqual(back, { ledger, warning: null })
  assert.deepEqual(m.workflowArgs(back.ledger, { repo: root }), { repo: root, maxFixRounds: 3, knownStuckSigs: ['sig-1'] })
})
