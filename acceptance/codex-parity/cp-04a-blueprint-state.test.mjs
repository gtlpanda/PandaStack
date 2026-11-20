// CP-04a frozen acceptance: the /blueprint state library
// (spec/contracts/codex-parity-cp-04a.md). No graph runs, no provider, no
// network, no HOME dependence: every file lives in an owned temp directory, and
// git runs in a child with an explicit environment and no user config. Fake
// credentials are built at run time so this file never holds one.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..')
const MODULE = 'graphs/blueprint/skills/blueprint/blueprint-state.mjs'
const load = () => import(pathToFileURL(resolve(ROOT, MODULE)).href)
const SKILL = () => readFileSync(resolve(ROOT, 'graphs/blueprint/skills/blueprint/SKILL.md'), 'utf8')

const CODES = ['INVALID_INPUT', 'NOT_A_REPO', 'NO_REQUEST', 'DOC_INVALID', 'DOC_MISSING', 'STATE_EXISTS', 'NO_STATE_DIR',
  'MISSING', 'MALFORMED', 'NOT_DESIGN_READY', 'INVALID_ARGS', 'IO_ERROR']
const FIVE = ['request.json', 'run1.json', 'state.json', 'run2.json', 'run3.json']
const SIX = [...FIVE, 'meta.json']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const mode = path => statSync(path).mode & 0o777

// The error is ours: a fixed code, the fixed message, and at most a fixed file name.
function throwsCode(fn, code, file) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}, nothing was thrown`)
  assert.equal(caught.code, code)
  assert.equal(caught.message, `Blueprint state: ${code}.`)
  if (file !== undefined) assert.equal(caught.file, file)
  return caught
}

// ---------- fake credentials, assembled so no source line holds one ----------
const rand = (alphabet, n, seed) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + seed * 13 + 3) % alphabet.length]).join('')
const ALNUM = 'aZ0bY1cX2dW3eV4fU5gT6hS7iR8jQ9kP'
const UPPER = 'Q7W3E9R1T5Y2U8I4O6P0ASDFGHJKLZXC'
const HEX = '0123456789abcdef'
const SECRETS = {
  stripe: ['sk', 'live', rand(ALNUM, 24, 1)].join('_'),
  stripeTest: ['rk', 'test', rand(ALNUM, 20, 2)].join('_'),
  skDigit: 'sk' + '_' + rand(ALNUM, 18, 3),
  openai: 'sk' + '-proj-' + rand(ALNUM, 40, 4),
  github: 'gh' + 'p_' + rand(ALNUM, 36, 5),
  githubServer: 'gh' + 's_' + rand(ALNUM, 36, 6),
  githubPat: 'github' + '_pat_' + rand(ALNUM, 30, 7),
  aws: 'AK' + 'IA' + rand(UPPER, 16, 8),
  slack: 'xo' + 'xb-' + rand(ALNUM, 24, 9),
  google: 'AI' + 'za' + rand(ALNUM, 35, 10),
  jwt: 'ey' + 'J' + rand(ALNUM, 20, 11) + '.ey' + 'J' + rand(ALNUM, 20, 12) + '.' + rand(ALNUM, 16, 13),
  urlPassword: 'Pw' + rand(ALNUM, 14, 14),
  assigned: rand(ALNUM, 32, 15),
  assignedSlash: rand(ALNUM, 12, 16) + '/' + rand(ALNUM, 14, 17) + '+' + rand(ALNUM, 10, 18),
  hexSecret: rand(HEX, 32, 19),
  keyBody: rand(ALNUM, 64, 20),
}
const BEGIN = kind => '-----' + 'BEGIN ' + kind + '-----'
const END = kind => '-----' + 'END ' + kind + '-----'
const PEM = kind => `${BEGIN(kind)}\n${SECRETS.keyBody}\n${rand(ALNUM, 40, 21)}\n${END(kind)}`

// [name, input, the secret that must vanish, exact expected output]
const POSITIVE = [
  ['Stripe live key', `STRIPE_KEY=${SECRETS.stripe}`, SECRETS.stripe, 'STRIPE_KEY=<redacted: API key>'],
  ['restricted test key in prose', `use ${SECRETS.stripeTest} here`, SECRETS.stripeTest, 'use <redacted: API key> here'],
  ['sk_ key with a digit', `(${SECRETS.skDigit})`, SECRETS.skDigit, '(<redacted: API key>)'],
  ['sk- project key', `key ${SECRETS.openai}.`, SECRETS.openai, 'key <redacted: API key>.'],
  ['GitHub classic token', `token ${SECRETS.github}`, SECRETS.github, 'token <redacted: GitHub token>'],
  ['GitHub server token', SECRETS.githubServer, SECRETS.githubServer, '<redacted: GitHub token>'],
  ['GitHub fine-grained token', `pat ${SECRETS.githubPat} end`, SECRETS.githubPat, 'pat <redacted: GitHub token> end'],
  ['AWS access key id', `aws ${SECRETS.aws}`, SECRETS.aws, 'aws <redacted: AWS access key>'],
  ['Slack token', `slack ${SECRETS.slack}`, SECRETS.slack, 'slack <redacted: Slack token>'],
  ['Google API key', `g ${SECRETS.google}`, SECRETS.google, 'g <redacted: Google API key>'],
  ['JSON web token', `Bearer ${SECRETS.jwt}`, SECRETS.jwt, 'Bearer <redacted: JSON web token>'],
  ['URL password', `postgres://admin:${SECRETS.urlPassword}@db:5432/app`, SECRETS.urlPassword, 'postgres://admin:<redacted: URL password>@db:5432/app'],
  ['private key block', `before\n${PEM('RSA PRIVATE KEY')}\nafter`, SECRETS.keyBody, 'before\n<redacted: private key>\nafter'],
  ['PGP private key block', `${PEM('PGP PRIVATE KEY BLOCK')} done`, SECRETS.keyBody, '<redacted: private key> done'],
  ['cut-off private key block', `x ${BEGIN('PRIVATE KEY')}\n${SECRETS.keyBody}\nmore`, SECRETS.keyBody, 'x <redacted: private key>'],
  ['long random string after =', `api_key=${SECRETS.assigned}`, SECRETS.assigned, 'api_key=<redacted: secret value>'],
  ['long random string after : in quotes', `password: "${SECRETS.assigned}"`, SECRETS.assigned, 'password: "<redacted: secret value>"'],
  ['random string with / and +', `aws_secret = ${SECRETS.assignedSlash}`, SECRETS.assignedSlash, 'aws_secret = <redacted: secret value>'],
  ['32-hex value after =', `secret=${SECRETS.hexSecret}`, SECRETS.hexSecret, 'secret=<redacted: secret value>'],
]

const GIT_SHA = rand(HEX, 40, 30)
const NEGATIVE = [
  ['a 40-hex git SHA in prose', `Fixed in ${GIT_SHA} last week.`],
  ['a 40-hex git SHA after a colon', `commit: ${GIT_SHA}`],
  ['a sha256 digest after a colon', `sha256: ${rand(HEX, 64, 31)}`],
  ['a UUID', 'run 123e4567-e89b-12d3-a456-426614174000 done'],
  ['a UUID after a colon', 'id: 123e4567-e89b-12d3-a456-426614174000'],
  ['an upper-case UUID after =', 'id=123E4567-E89B-12D3-A456-426614174000'],
  ['short key=value pairs', 'mode=app retries: 3 token=abc123 port=5432'],
  ['a sentence mentioning the prefixes', 'Redacting means finding a token prefix such as `sk_`, `ghp_`, `AKIA`, a private key block, or sk_live_ keys.'],
  ['prefixes followed by short words', 'see sk_test_ and ghp_x and AKIA alone'],
  ['a snake_case identifier after sk_', 'sk_some_long_identifier_name is a function'],
  ['a hyphenated word after sk-', 'the sk' + '-learn-compatible-estimator-interface'],
  ['a repo path after a colon', 'evidence: graphs/blueprint/workflows/blueprint-design.js:143'],
  ['a URL', 'see https://github.com/gtlpanda/PandaStack/pull/74?tab=files'],
  ['an empty string', ''],
]

let WORK
before(() => { WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-04a-'))) })
after(() => rmSync(WORK, { recursive: true, force: true }))

// A fresh case directory; the state dir inside it is not created.
let caseNo = 0
function makeCase() {
  const base = join(WORK, `case-${++caseNo}`)
  mkdirSync(base)
  return { base, dir: join(base, 'harness-blueprint') }
}
function makeDoc(c, name = 'design.md') {
  const path = join(c.base, name)
  writeFileSync(path, '# design\n')
  return path
}
const listDir = dir => (existsSync(dir) ? readdirSync(dir).sort() : [])
const snapshot = dir => Object.fromEntries(listDir(dir).map(f => [f, readFileSync(join(dir, f), 'utf8')]))

// ---------- fixtures ----------
const DECISION = (id, answer, extra = {}) => ({ id, question: `question for ${id}`, answer, resolves: [], note: null, ...extra })
const STATE = (over = {}) => ({
  request: 'A reading list app',
  docs: [],
  brief: { goal: 'track books', mode: 'app', requirements: [{ id: 'R1', text: 'add', source: 'request' }, { id: 'R2', text: 'list', source: 'request' }] },
  decisions: [DECISION('Q1', 'Email and password', { resolves: ['C1'] }), DECISION('Q2', 'SQLite')],
  assumptions: [],
  preflight: [{ what: 'SMTP key', why: 'mail', needed_by: 'S3', have: false }],
  gateRounds: 0,
  ...over,
})
const RUN2 = (over = {}) => ({ status: 'design-ready', reason: null, design: { summary: 's', modules: [], knowledge: [{ id: 'K1', kind: 'type' }, { id: 'K2', kind: 'authz' }] }, ...over })
const RUN3 = (over = {}) => ({ status: 'backlog-ready', reason: null, backlog: { version: 1, app: 'reading-list', slices: [] }, ...over })

// Three states covering the branches the SKILL.md commands have.
const DRIFT_FIXTURES = [
  ['app mode, no assumptions, interview decisions only, knowledge out of id order', STATE({ decisions: [DECISION('Q2', 'SQLite'), DECISION('Q1', 'Email')] }),
    RUN2({ design: { summary: 's', knowledge: [{ id: 'K2', kind: 'authz' }, { id: 'K10', kind: 'type' }, { id: 'K1', kind: 'type' }] } })],
  ['feature mode, override and gate decisions, assumption objects with extra keys, text needing escapes', STATE({
    request: null,
    docs: ['/abs/design doc.md'],
    brief: { mode: 'feature', requirements: [{ id: 'R3' }, { id: 'R1' }, { id: 'R10' }], gaps: ['x'] },
    decisions: [DECISION('Q1', 'Use "Postgres" \\ not SQLite'), DECISION('A2', 'override: café   🚀', { note: 'override' }),
      DECISION('D1', 'Tabs\tand\nnewlines', { question: 'approval edit', note: 'design gate' })],
    assumptions: [{ id: 'Q13', from: 'Q13', assumption: 'no i18n', why: 'not asked' }, { id: 'A1', assumption: 'one user', why: 'stated' }],
    preflight: [],
    gateRounds: 2,
  }), RUN2({ design: { summary: 's', knowledge: [] } })],
  ['app mode, no decisions, a design with no knowledge key', STATE({ decisions: [], assumptions: [{ id: 'A1', assumption: 'a', why: 'b' }] }),
    RUN2({ design: { summary: 'no knowledge here' } })],
]

function writeJSON(dir, file, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2))
}

// The two pinned commands, taken from SKILL.md itself so a drift there is caught.
function skillCommands() {
  const found = [...SKILL().matchAll(/`node -e '([^']*)'((?: "\$S\/[a-z0-9]+\.json")+)`/g)]
  assert.equal(found.length, 2, 'SKILL.md pins exactly two node -e commands')
  return found.map(m => ({ script: m[1], files: [...m[2].matchAll(/"\$S\/([a-z0-9]+\.json)"/g)].map(f => f[1]) }))
}
function runSkillCommand(command, dir) {
  return spawnSync(process.execPath, ['-e', command.script, ...command.files.map(f => join(dir, f))],
    { encoding: 'utf8', env: {}, timeout: 10000 })
}

// git in a child with no user or system config and an owned HOME.
const GIT_ENV = () => ({ PATH: process.env.PATH, HOME: join(WORK, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
function resolveInChild(cwd) {
  const script = `import(${JSON.stringify(pathToFileURL(resolve(ROOT, MODULE)).href)}).then(m => {
    try { process.stdout.write(JSON.stringify({ value: m.resolveStateDir(process.argv[1]) })) }
    catch (e) { process.stdout.write(JSON.stringify({ code: e.code, message: e.message })) }
  })`
  const out = execFileSync(process.execPath, ['-e', script, cwd], { encoding: 'utf8', env: GIT_ENV(), timeout: 20000 })
  return JSON.parse(out)
}

// =====================================================================
describe('exports', () => {
  test('names, files and codes are pinned', async () => {
    const m = await load()
    assert.equal(m.STATE_DIR_NAME, 'harness-blueprint')
    assert.deepEqual({ ...m.FILES }, { request: 'request.json', run1: 'run1.json', state: 'state.json', run2: 'run2.json', run3: 'run3.json', meta: 'meta.json' })
    assert.ok(Object.isFrozen(m.FILES) && Object.isFrozen(m.BLUEPRINT_STATE_CODES))
    assert.deepEqual(Object.keys(m.BLUEPRINT_STATE_CODES).sort(), [...CODES].sort())
    for (const code of CODES) assert.equal(m.BLUEPRINT_STATE_CODES[code], code)
    for (const name of ['redactSecrets', 'redactJSON', 'resolveStateDir', 'initState', 'readRequest', 'readState', 'readRun',
      'writeState', 'writeRun', 'validateState', 'validateRun', 'designArgs', 'backlogArgs', 'freshness', 'readArgsFile']) {
      assert.equal(typeof m[name], 'function', name)
    }
  })

  test('the module imports only node built-ins, so the catalog gains no edge and the drift guard stays clean', async () => {
    await load()
    const source = readFileSync(resolve(ROOT, MODULE), 'utf8')
    const specifiers = [...source.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm)]
      .map(m => m[2] ?? m[4])
    assert.ok(specifiers.length > 0)
    assert.deepEqual(specifiers.filter(s => !s.startsWith('node:')), [])
    assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic import')
    const { checkCatalogDrift } = await import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')).href)
    const { problems } = checkCatalogDrift({ installationRoot: ROOT })
    assert.deepEqual(problems.filter(p => p.ref === 'blueprint' || p.dependency === 'blueprint'), [])
  })
})

// =====================================================================
describe('redaction', () => {
  for (const [name, input, secret, expected] of POSITIVE) {
    test(`redacts ${name}`, async () => {
      const { redactSecrets } = await load()
      const out = redactSecrets(input)
      assert.ok(!out.includes(secret), 'the secret is gone')
      assert.equal(out, expected)
    })
  }

  test('leaves look-alikes unchanged', async () => {
    const { redactSecrets } = await load()
    for (const [name, input] of NEGATIVE) assert.equal(redactSecrets(input), input, name)
  })

  test('the SKILL.md "When to ask" paragraph is not itself redacted', async () => {
    const { redactSecrets } = await load()
    const text = SKILL()
    const start = text.indexOf('**Never ask for a secret value.**')
    const paragraph = text.slice(start, text.indexOf('\n\n', start))
    assert.ok(paragraph.includes('`ghp_`'))
    assert.equal(redactSecrets(paragraph), paragraph)
  })

  test('non-string input comes back as it was', async () => {
    const { redactSecrets } = await load()
    const object = { key: SECRETS.github }
    for (const value of [null, undefined, 0, 42, NaN, true, false]) assert.ok(Object.is(redactSecrets(value), value))
    assert.equal(redactSecrets(object), object)
    assert.deepEqual(object, { key: SECRETS.github }, 'and is not mutated')
    const list = [SECRETS.github]
    assert.equal(redactSecrets(list), list)
  })

  test('is idempotent', async () => {
    const { redactSecrets, redactJSON } = await load()
    for (const [, input] of [...POSITIVE, ...NEGATIVE]) {
      const once = redactSecrets(input)
      assert.equal(redactSecrets(once), once)
    }
    const all = { a: POSITIVE.map(p => p[1]), b: NEGATIVE.map(n => n[1]) }
    assert.deepEqual(redactJSON(redactJSON(all)), redactJSON(all))
  })

  test('redactJSON goes deep over a ledger, keys too, and leaves the input untouched', async () => {
    const { redactJSON } = await load()
    const ledger = {
      status: 'design-ready',
      reason: null,
      designRounds: 2,
      ok: true,
      design: { summary: `uses ${SECRETS.github}`, modules: [{ id: 'M1', notes: [`k=${SECRETS.assigned}`, 7, null, false] }] },
      history: [[{ deep: { deeper: [`${PEM('EC PRIVATE KEY')}`] } }]],
      [SECRETS.aws]: 'a key named like a secret',
    }
    const copy = structuredClone(ledger)
    const out = redactJSON(ledger)
    assert.deepEqual(ledger, copy, 'input not mutated')
    const text = JSON.stringify(out)
    for (const secret of [SECRETS.github, SECRETS.assigned, SECRETS.keyBody, SECRETS.aws]) assert.ok(!text.includes(secret))
    assert.deepEqual(out, {
      status: 'design-ready',
      reason: null,
      designRounds: 2,
      ok: true,
      design: { summary: 'uses <redacted: GitHub token>', modules: [{ id: 'M1', notes: ['k=<redacted: secret value>', 7, null, false] }] },
      history: [[{ deep: { deeper: ['<redacted: private key>'] } }]],
      '<redacted: AWS access key>': 'a key named like a secret',
    })
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
    for (const scalar of [null, 3, true, 'plain']) assert.equal(redactJSON(scalar), scalar)
  })

  test('redactJSON refuses what is not a JSON value', async () => {
    const { redactJSON } = await load()
    const cycle = { a: 1 }
    cycle.self = cycle
    const deep = []
    let cursor = deep
    for (let i = 0; i < 200000; i++) { const next = []; cursor.push(next); cursor = next }
    for (const bad of [undefined, () => 1, Symbol('s'), 10n, NaN, Infinity, new Date(0), new Map(), { a: undefined }, [1, undefined],
      cycle, { [SECRETS.aws]: 1, '<redacted: AWS access key>': 2 }, deep]) {
      throwsCode(() => redactJSON(bad), 'INVALID_INPUT')
    }
  })
})

// =====================================================================
describe('state directory', () => {
  test('resolveStateDir is git\'s --git-path harness-blueprint, absolute, and creates nothing', async () => {
    await load()
    const repo = join(WORK, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    execFileSync('git', ['init', '-q', repo], { env: GIT_ENV() })
    const expected = join(repo, '.git', 'harness-blueprint')
    assert.deepEqual(resolveInChild(repo), { value: expected })
    assert.deepEqual(resolveInChild(join(repo, 'sub')), { value: expected })
    assert.equal(existsSync(expected), false)
    const outside = join(WORK, 'not-a-repo')
    mkdirSync(outside)
    const refused = resolveInChild(outside)
    assert.deepEqual(refused, { code: 'NOT_A_REPO', message: 'Blueprint state: NOT_A_REPO.' })
    assert.deepEqual(resolveInChild('relative/path'), { code: 'INVALID_INPUT', message: 'Blueprint state: INVALID_INPUT.' })
  })

  test('every call refuses a dir that is relative or not named harness-blueprint', async () => {
    const m = await load()
    const c = makeCase()
    for (const dir of ['harness-blueprint', join(c.base, 'state'), '', null, 7, `${c.dir}\0`]) {
      throwsCode(() => m.initState(dir, { request: 'x' }), 'INVALID_INPUT')
      throwsCode(() => m.readState(dir), 'INVALID_INPUT')
      throwsCode(() => m.freshness(dir), 'INVALID_INPUT')
      throwsCode(() => m.designArgs(dir), 'INVALID_INPUT')
    }
    assert.deepEqual(listDir(c.base), [])
  })
})

// =====================================================================
describe('initState', () => {
  test('creates a 0700 dir and a 0600 request.json holding the redacted, trimmed request', async () => {
    const { initState, readRequest } = await load()
    const c = makeCase()
    const doc = makeDoc(c)
    const stored = initState(c.dir, { request: `  build it with ${SECRETS.stripe}  `, docs: [doc] })
    assert.deepEqual(stored, { request: 'build it with <redacted: API key>', docs: [doc] })
    assert.equal(mode(c.dir), 0o700)
    assert.deepEqual(listDir(c.dir), ['request.json'])
    assert.equal(mode(join(c.dir, 'request.json')), 0o600)
    const bytes = readFileSync(join(c.dir, 'request.json'), 'utf8')
    assert.ok(!bytes.includes(SECRETS.stripe))
    assert.deepEqual(JSON.parse(bytes), stored)
    assert.deepEqual(readRequest(c.dir), stored)
  })

  test('docs alone are enough; a blank request is null; an existing wide dir is tightened to 0700', async () => {
    const { initState } = await load()
    const c = makeCase()
    mkdirSync(c.dir, { mode: 0o755 })
    chmodSync(c.dir, 0o755)
    const doc = makeDoc(c)
    assert.deepEqual(initState(c.dir, { request: '   ', docs: [doc] }), { request: null, docs: [doc] })
    assert.deepEqual(initState(c.dir, { docs: [doc] }), { request: null, docs: [doc] })
    assert.equal(mode(c.dir), 0o700)
  })

  test('refuses bad input with nothing written: no dir, no file', async () => {
    const { initState } = await load()
    const c = makeCase()
    const doc = makeDoc(c)
    mkdirSync(join(c.base, 'folder'))
    const cases = [
      [{ request: 'x', docs: ['relative/doc.md'] }, 'DOC_INVALID'],
      [{ request: 'x', docs: [doc, ''] }, 'DOC_INVALID'],
      [{ request: 'x', docs: [join(c.base, 'folder')] }, 'DOC_INVALID'],
      [{ request: 'x', docs: [join(c.base, 'missing.md')] }, 'DOC_MISSING'],
      [{ request: 'x', docs: [join(doc, 'below')] }, 'DOC_MISSING'],
      [{}, 'NO_REQUEST'],
      [{ request: null, docs: [] }, 'NO_REQUEST'],
      [{ request: ' \n\t ' }, 'NO_REQUEST'],
      [{ request: 5 }, 'INVALID_INPUT'],
      [{ request: 'x', docs: doc }, 'INVALID_INPUT'],
      [{ request: 'x', restart: 'yes' }, 'INVALID_INPUT'],
      [{ request: 'x', extra: 1 }, 'INVALID_INPUT'],
    ]
    for (const [options, code] of cases) throwsCode(() => initState(c.dir, options), code)
    throwsCode(() => initState(c.dir, null), 'INVALID_INPUT')
    throwsCode(() => initState(c.dir), 'INVALID_INPUT')
    assert.equal(existsSync(c.dir), false)
  })

  test('an existing state.json is refused unless restart, and a refused restart deletes nothing', async () => {
    const { initState } = await load()
    const c = makeCase()
    initState(c.dir, { request: 'first' })
    for (const file of SIX.slice(1)) writeFileSync(join(c.dir, file), `{"old":"${file}"}`)
    const before = snapshot(c.dir)
    throwsCode(() => initState(c.dir, { request: 'second' }), 'STATE_EXISTS')
    throwsCode(() => initState(c.dir, { request: 'second', restart: false }), 'STATE_EXISTS')
    throwsCode(() => initState(c.dir, { request: 'second', restart: true, docs: ['rel.md'] }), 'DOC_INVALID')
    throwsCode(() => initState(c.dir, { restart: true }), 'NO_REQUEST')
    assert.deepEqual(snapshot(c.dir), before)
  })

  test('restart deletes all five files and meta.json, then writes the new request', async () => {
    const { initState, readRequest } = await load()
    const c = makeCase()
    initState(c.dir, { request: 'first' })
    for (const file of SIX.slice(1)) writeFileSync(join(c.dir, file), '{}')
    assert.deepEqual(initState(c.dir, { request: 'second', restart: true }), { request: 'second', docs: [] })
    assert.deepEqual(listDir(c.dir), ['request.json'])
    assert.deepEqual(readRequest(c.dir), { request: 'second', docs: [] })
  })

  test('without a state.json, leftovers of an earlier request are removed too; restart with no state proceeds', async () => {
    const { initState } = await load()
    const c = makeCase()
    initState(c.dir, { request: 'first' })
    for (const file of ['run1.json', 'run2.json', 'run3.json', 'meta.json']) writeFileSync(join(c.dir, file), '{}')
    initState(c.dir, { request: 'second' })
    assert.deepEqual(listDir(c.dir), ['request.json'])
    initState(c.dir, { request: 'third', restart: true })
    assert.deepEqual(listDir(c.dir), ['request.json'])
  })

  test('a dir that is a file or a symlink is NO_STATE_DIR for initState and the writers, with nothing written', async () => {
    const m = await load()
    const asFile = makeCase()
    writeFileSync(asFile.dir, 'not a directory')
    const asLink = makeCase()
    mkdirSync(join(asLink.base, 'elsewhere'))
    symlinkSync(join(asLink.base, 'elsewhere'), asLink.dir)
    for (const c of [asFile, asLink]) {
      throwsCode(() => m.initState(c.dir, { request: 'x' }), 'NO_STATE_DIR')
      throwsCode(() => m.initState(c.dir, { request: 'x', restart: true }), 'NO_STATE_DIR')
      throwsCode(() => m.writeState(c.dir, STATE()), 'NO_STATE_DIR')
      throwsCode(() => m.writeRun(c.dir, 1, { status: 'needs-human' }), 'NO_STATE_DIR')
    }
    assert.equal(readFileSync(asFile.dir, 'utf8'), 'not a directory')
    assert.deepEqual(listDir(join(asLink.base, 'elsewhere')), [])
  })

  test('a state.json that is a symlink still counts as existing', async () => {
    const { initState } = await load()
    const c = makeCase()
    initState(c.dir, { request: 'first' })
    symlinkSync(join(c.base, 'nowhere'), join(c.dir, 'state.json'))
    throwsCode(() => initState(c.dir, { request: 'second' }), 'STATE_EXISTS')
    initState(c.dir, { request: 'second', restart: true })
    assert.deepEqual(listDir(c.dir), ['request.json'])
  })
})

// =====================================================================
describe('writers', () => {
  test('writeState and writeRun redact before writing, write 0600 files atomically, and leave no temp file', async () => {
    const m = await load()
    const c = makeCase()
    m.initState(c.dir, { request: 'x' })
    const run1 = { status: 'needs-human', reason: `see ${SECRETS.github}`, questions: [{ id: 'Q1', question: `q ${SECRETS.aws}` }] }
    const storedRun1 = m.writeRun(c.dir, 1, run1)
    assert.equal(storedRun1.reason, 'see <redacted: GitHub token>')
    const state = STATE({ decisions: [DECISION('Q1', `password=${SECRETS.assigned}`)] })
    const storedState = m.writeState(c.dir, state)
    assert.equal(storedState.decisions[0].answer, 'password=<redacted: secret value>')
    m.writeRun(c.dir, 2, RUN2({ notes: [SECRETS.slack] }))
    m.writeRun(c.dir, 3, RUN3({ reason: SECRETS.google }))
    assert.deepEqual(listDir(c.dir), [...SIX].sort())
    for (const file of SIX) {
      assert.equal(mode(join(c.dir, file)), 0o600, file)
      const bytes = readFileSync(join(c.dir, file), 'utf8')
      for (const secret of [SECRETS.github, SECRETS.aws, SECRETS.assigned, SECRETS.slack, SECRETS.google]) assert.ok(!bytes.includes(secret), file)
    }
    assert.deepEqual(m.readRun(c.dir, 1), storedRun1)
    assert.deepEqual(m.readState(c.dir), storedState)
    assert.equal(mode(c.dir), 0o700)
  })

  test('writers refuse invalid values and a missing state dir, writing nothing', async () => {
    const m = await load()
    const c = makeCase()
    throwsCode(() => m.writeState(c.dir, STATE()), 'NO_STATE_DIR')
    throwsCode(() => m.writeRun(c.dir, 1, { status: 'needs-human' }), 'NO_STATE_DIR')
    assert.equal(existsSync(c.dir), false)
    m.initState(c.dir, { request: 'x' })
    throwsCode(() => m.writeState(c.dir, STATE({ gateRounds: 3 })), 'INVALID_INPUT')
    throwsCode(() => m.writeRun(c.dir, 1, { status: 'design-ready' }), 'INVALID_INPUT')
    throwsCode(() => m.writeRun(c.dir, 4, { status: 'needs-human' }), 'INVALID_INPUT')
    throwsCode(() => m.writeRun(c.dir, 2, RUN2()), 'MISSING', 'state.json')
    m.writeState(c.dir, STATE())
    throwsCode(() => m.writeRun(c.dir, 3, RUN3()), 'MISSING', 'run2.json')
    assert.deepEqual(listDir(c.dir), ['request.json', 'state.json'])
  })

  test('meta.json holds the sha256 of each run\'s inputs at write time', async () => {
    const m = await load()
    const c = makeCase()
    m.initState(c.dir, { request: 'x' })
    m.writeState(c.dir, STATE())
    m.writeRun(c.dir, 2, RUN2())
    m.writeRun(c.dir, 3, RUN3())
    const file = name => readFileSync(join(c.dir, name))
    assert.deepEqual(JSON.parse(file('meta.json')), {
      version: 1,
      basis: {
        'run2.json': { 'state.json': sha(file('state.json')) },
        'run3.json': { 'state.json': sha(file('state.json')), 'run2.json': sha(file('run2.json')) },
      },
    })
  })
})

// =====================================================================
describe('design and backlog args', () => {
  for (const [name, state, run2] of DRIFT_FIXTURES) {
    test(`byte-equal to the SKILL.md commands: ${name}`, async () => {
      const { designArgs, backlogArgs } = await load()
      const [designCommand, backlogCommand] = skillCommands()
      assert.deepEqual(designCommand.files, ['state.json'])
      assert.deepEqual(backlogCommand.files, ['state.json', 'run2.json'])
      const c = makeCase()
      writeJSON(c.dir, 'state.json', state)
      writeJSON(c.dir, 'run2.json', run2)
      const design = runSkillCommand(designCommand, c.dir)
      assert.equal(design.status, 0, design.stderr)
      assert.equal(`${JSON.stringify(designArgs(c.dir))}\n`, design.stdout)
      const backlog = runSkillCommand(backlogCommand, c.dir)
      assert.equal(backlog.status, 0, backlog.stderr)
      assert.equal(`${JSON.stringify(backlogArgs(c.dir))}\n`, backlog.stdout)
    })
  }

  test('backlogArgs refuses a run2.json that is not design-ready, as the SKILL.md command does', async () => {
    const { backlogArgs, designArgs } = await load()
    const backlogCommand = skillCommands()[1]
    for (const status of ['needs-human', 'escalate']) {
      const c = makeCase()
      writeJSON(c.dir, 'state.json', STATE())
      writeJSON(c.dir, 'run2.json', { status, reason: 'r', questions: [] })
      assert.notEqual(runSkillCommand(backlogCommand, c.dir).status, 0)
      throwsCode(() => backlogArgs(c.dir), 'NOT_DESIGN_READY')
      assert.ok(designArgs(c.dir), 'design args need only the state')
    }
  })

  test('args come from the files as they are now: no meta.json or freshness needed', async () => {
    const { backlogArgs } = await load()
    const c = makeCase()
    writeJSON(c.dir, 'state.json', STATE())
    writeJSON(c.dir, 'run2.json', RUN2())
    assert.deepEqual(backlogArgs(c.dir), {
      mode: 'app', requirements: ['R1', 'R2'],
      decisions: [{ id: 'Q1', answer: 'Email and password' }, { id: 'Q2', answer: 'SQLite' }],
      assumptions: [], knowledge: ['K1', 'K2'],
    })
  })
})

// =====================================================================
describe('fail closed', () => {
  const MARK = 'ECHO-MARKER-7f3a'
  const badState = [
    ['truncated JSON', JSON.stringify(STATE()).slice(0, 60)],
    ['not JSON', `not json ${MARK}`],
    ['a JSON array', `["${MARK}"]`],
    ['an unknown key', JSON.stringify({ ...STATE(), extra: MARK })],
    ['a missing key', JSON.stringify((({ gateRounds, ...rest }) => rest)(STATE()))],
    ['mode not app or feature', JSON.stringify(STATE({ brief: { mode: MARK, requirements: [{ id: 'R1' }] } }))],
    ['no requirements', JSON.stringify(STATE({ brief: { mode: 'app', requirements: [] } }))],
    ['a requirement id not R<n>', JSON.stringify(STATE({ brief: { mode: 'app', requirements: [{ id: MARK }] } }))],
    ['duplicate requirement ids', JSON.stringify(STATE({ brief: { mode: 'app', requirements: [{ id: 'R1' }, { id: 'R1' }] } }))],
    ['decisions not a list', JSON.stringify(STATE({ decisions: MARK }))],
    ['a decision with an empty answer', JSON.stringify(STATE({ decisions: [DECISION('Q1', '')] }))],
    ['a decision missing resolves', JSON.stringify(STATE({ decisions: [(({ resolves, ...d }) => d)(DECISION('Q1', 'a'))] }))],
    ['a decision with a numeric note', JSON.stringify(STATE({ decisions: [DECISION('Q1', 'a', { note: 3 })] }))],
    ['a decision with an extra key', JSON.stringify(STATE({ decisions: [DECISION('Q1', 'a', { [MARK]: 'x' })] }))],
    ['a decision id also an assumption id', JSON.stringify(STATE({ assumptions: [{ id: 'Q1' }] }))],
    ['duplicate decision ids', JSON.stringify(STATE({ decisions: [DECISION('Q1', 'a'), DECISION('Q1', 'b')] }))],
    ['an assumption without an id', JSON.stringify(STATE({ assumptions: [{ assumption: MARK }] }))],
    ['a preflight item with have as a string', JSON.stringify(STATE({ preflight: [{ what: 'a', why: 'b', needed_by: 'c', have: 'yes' }] }))],
    ['gateRounds 3', JSON.stringify(STATE({ gateRounds: 3 }))],
    ['gateRounds 1.5', JSON.stringify(STATE({ gateRounds: 1.5 }))],
    ['a relative doc', JSON.stringify(STATE({ docs: ['rel.md'] }))],
    ['neither request nor docs', JSON.stringify(STATE({ request: null, docs: [] }))],
  ]

  for (const [name, text] of badState) {
    test(`state.json with ${name} is MALFORMED, nothing echoed`, async () => {
      const { readState, designArgs, backlogArgs, validateState } = await load()
      const c = makeCase()
      writeJSON(c.dir, 'run2.json', RUN2())
      writeFileSync(join(c.dir, 'state.json'), text)
      for (const fn of [readState, designArgs, backlogArgs]) {
        const error = throwsCode(() => fn(c.dir), 'MALFORMED', 'state.json')
        assert.ok(!error.message.includes(MARK) && !error.message.includes(c.dir))
      }
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* not JSON */ }
      if (parsed !== null) assert.equal(validateState(parsed), false)
    })
  }

  test('invalid UTF-8, a symlink, a directory and a FIFO are MALFORMED without blocking', { timeout: 10000 }, async () => {
    const { readState, readRun, readRequest } = await load()
    const c = makeCase()
    mkdirSync(c.dir, { recursive: true })
    writeFileSync(join(c.dir, 'state.json'), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
    throwsCode(() => readState(c.dir), 'MALFORMED', 'state.json')
    writeFileSync(join(c.base, 'real.json'), JSON.stringify(RUN2()))
    symlinkSync(join(c.base, 'real.json'), join(c.dir, 'run2.json'))
    throwsCode(() => readRun(c.dir, 2), 'MALFORMED', 'run2.json')
    mkdirSync(join(c.dir, 'run3.json'))
    throwsCode(() => readRun(c.dir, 3), 'MALFORMED', 'run3.json')
    execFileSync('/usr/bin/mkfifo', [join(c.dir, 'request.json')])
    throwsCode(() => readRequest(c.dir), 'MALFORMED', 'request.json')
  })

  test('missing files are MISSING with the file named; runs check their status set', async () => {
    const m = await load()
    const c = makeCase()
    throwsCode(() => m.readState(c.dir), 'MISSING', 'state.json')
    throwsCode(() => m.designArgs(c.dir), 'MISSING', 'state.json')
    throwsCode(() => m.readRequest(c.dir), 'MISSING', 'request.json')
    writeJSON(c.dir, 'state.json', STATE())
    throwsCode(() => m.backlogArgs(c.dir), 'MISSING', 'run2.json')
    throwsCode(() => m.readRun(c.dir, 1), 'MISSING', 'run1.json')
    throwsCode(() => m.readRun(c.dir, 0), 'INVALID_INPUT')
    const runs = [
      [1, { status: 'design-ready' }, false], [1, { status: 'needs-human' }, true], [1, [], false], [1, null, false],
      [2, { status: 'backlog-ready' }, false], [2, { status: 'design-ready' }, false], [2, { status: 'design-ready', design: [] }, false],
      [2, { status: 'design-ready', design: { knowledge: 'K1' } }, false], [2, { status: 'design-ready', design: { knowledge: [{ id: '' }] } }, false],
      [2, { status: 'design-ready', design: {} }, true], [2, { status: 'escalate' }, true],
      [3, { status: 'backlog-ready' }, false], [3, { status: 'backlog-ready', backlog: {} }, true], [3, { status: 'design-ready', design: {} }, false],
    ]
    for (const [n, value, ok] of runs) {
      assert.equal(m.validateRun(n, value), ok, `${n} ${JSON.stringify(value)}`)
      writeJSON(c.dir, `run${n}.json`, value)
      if (ok) assert.deepEqual(m.readRun(c.dir, n), value)
      else throwsCode(() => m.readRun(c.dir, n), 'MALFORMED', `run${n}.json`)
    }
    writeJSON(c.dir, 'run2.json', { status: 'design-ready', design: { knowledge: [{ id: 7 }] } })
    throwsCode(() => m.backlogArgs(c.dir), 'MALFORMED', 'run2.json')
    for (const bad of [{ request: '', docs: [] }, { request: 'x' }, { request: 'x', docs: [], extra: 1 }, { request: null, docs: ['rel'] }]) {
      writeJSON(c.dir, 'request.json', bad)
      throwsCode(() => m.readRequest(c.dir), 'MALFORMED', 'request.json')
    }
  })
})

// =====================================================================
describe('freshness', () => {
  async function built() {
    const m = await load()
    const c = makeCase()
    m.initState(c.dir, { request: 'x' })
    m.writeState(c.dir, STATE())
    m.writeRun(c.dir, 2, RUN2())
    m.writeRun(c.dir, 3, RUN3())
    return { m, c }
  }

  test('untouched is fresh, and touching mtimes alone changes nothing', async () => {
    const { m, c } = await built()
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'fresh' })
    for (const file of listDir(c.dir)) utimesSync(join(c.dir, file), new Date(2001, 1, 1), new Date(2001, 1, 1))
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'fresh' })
  })

  test('editing state.json after run2 makes design and backlog stale', async () => {
    const { m, c } = await built()
    m.writeState(c.dir, STATE({ decisions: [DECISION('Q1', 'Magic links')] }))
    assert.deepEqual(m.freshness(c.dir), { design: 'stale', backlog: 'stale' })
  })

  test('a hand edit of state.json bytes is caught too', async () => {
    const { m, c } = await built()
    writeFileSync(join(c.dir, 'state.json'), `${readFileSync(join(c.dir, 'state.json'), 'utf8')} `)
    assert.deepEqual(m.freshness(c.dir), { design: 'stale', backlog: 'stale' })
  })

  test('editing run2 after run3 makes only the backlog stale', async () => {
    const { m, c } = await built()
    m.writeRun(c.dir, 2, RUN2({ design: { summary: 'redesigned', knowledge: [] } }))
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'stale' })
    m.writeRun(c.dir, 3, RUN3())
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'fresh' })
  })

  test('missing files report missing; a missing state.json or meta.json is stale', async () => {
    const m = await load()
    const empty = makeCase()
    assert.deepEqual(m.freshness(empty.dir), { design: 'missing', backlog: 'missing' })
    const { c } = await built()
    rmSync(join(c.dir, 'run3.json'))
    assert.deepEqual(m.freshness(c.dir), { design: 'fresh', backlog: 'missing' })
    const { c: c2 } = await built()
    rmSync(join(c2.dir, 'run2.json'))
    assert.deepEqual(m.freshness(c2.dir), { design: 'missing', backlog: 'stale' })
    const { c: c3 } = await built()
    rmSync(join(c3.dir, 'state.json'))
    assert.deepEqual(m.freshness(c3.dir), { design: 'stale', backlog: 'stale' })
    const { c: c4 } = await built()
    rmSync(join(c4.dir, 'meta.json'))
    assert.deepEqual(m.freshness(c4.dir), { design: 'stale', backlog: 'stale' })
  })

  test('the backlog is fresh only while the design is fresh', async () => {
    const { m, c } = await built()
    const meta = JSON.parse(readFileSync(join(c.dir, 'meta.json'), 'utf8'))
    delete meta.basis['run2.json']
    writeFileSync(join(c.dir, 'meta.json'), JSON.stringify(meta))
    assert.deepEqual(m.freshness(c.dir), { design: 'stale', backlog: 'stale' })
  })

  test('a malformed meta.json never throws and fails toward stale', async () => {
    const m = await load()
    for (const text of ['{"version":1,"basis":', '[]', '{"version":2,"basis":{}}', '{"version":1,"basis":{"run2.json":{"state.json":"abc"}}}']) {
      const { c } = await built()
      writeFileSync(join(c.dir, 'meta.json'), text)
      assert.deepEqual(m.freshness(c.dir), { design: 'stale', backlog: 'stale' })
    }
    const { c } = await built()
    rmSync(join(c.dir, 'meta.json'))
    mkdirSync(join(c.dir, 'meta.json'))
    assert.deepEqual(m.freshness(c.dir), { design: 'stale', backlog: 'stale' })
  })
})

// =====================================================================
describe('readArgsFile', () => {
  const ALLOWED = ['repo', 'stage', 'doc']

  test('returns the object when every key is allowed (missing keys are the caller\'s concern)', async () => {
    const { readArgsFile } = await load()
    const c = makeCase()
    const path = join(c.base, 'args.json')
    writeFileSync(path, JSON.stringify({ repo: '/r', stage: 'design' }))
    assert.deepEqual(readArgsFile(path, ALLOWED), { repo: '/r', stage: 'design' })
    writeFileSync(path, '{}')
    assert.deepEqual(readArgsFile(path, ALLOWED), {})
  })

  test('refuses a bad file with INVALID_ARGS and no echo, without blocking on a FIFO', { timeout: 10000 }, async () => {
    const { readArgsFile } = await load()
    const c = makeCase()
    const MARK = 'ARGS-MARKER-91c2'
    const file = (name, bytes) => { const p = join(c.base, name); writeFileSync(p, bytes); return p }
    const fifo = join(c.base, 'fifo.json')
    execFileSync('/usr/bin/mkfifo', [fifo])
    mkdirSync(join(c.base, 'dir.json'))
    const paths = [
      file('unknown.json', JSON.stringify({ repo: '/r', [MARK]: 1 })),
      file('proto.json', '{"__proto__":{"x":1}}'),
      file('array.json', `["${MARK}"]`),
      file('string.json', `"${MARK}"`),
      file('null.json', 'null'),
      file('truncated.json', `{"repo":"${MARK}`),
      file('utf8.json', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])),
      file('big.json', `{"repo":"${'x'.repeat(1048576)}"}`),
      join(c.base, 'absent.json'),
      fifo,
      join(c.base, 'dir.json'),
      'relative/args.json',
    ]
    for (const path of paths) {
      const error = throwsCode(() => readArgsFile(path, ALLOWED), 'INVALID_ARGS')
      assert.ok(!error.message.includes(MARK) && !error.message.includes(c.base))
    }
    const exact = file('exact.json', `{"repo":"${'x'.repeat(1048576 - 11)}"}`)
    assert.equal(statSync(exact).size, 1048576)
    assert.equal(readArgsFile(exact, ALLOWED).repo.length, 1048576 - 11)
  })

  test('refuses a bad allowedKeys list as INVALID_INPUT', async () => {
    const { readArgsFile } = await load()
    const c = makeCase()
    const path = join(c.base, 'args.json')
    writeFileSync(path, '{}')
    for (const keys of [undefined, null, 'repo', ['repo', 'repo'], ['repo', ''], [1]]) throwsCode(() => readArgsFile(path, keys), 'INVALID_INPUT')
  })
})
