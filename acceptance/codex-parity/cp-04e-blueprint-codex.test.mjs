// CP-04e frozen acceptance: /blueprint on Codex (spec/contracts/codex-parity-cp-04e.md).
// Wiring proof, not runtime certification: no real codex, no claude, no gh, no network.
// Unlike CP-04c, the installation root is the candidate root itself: the production
// catalog, unmodified. Everything runs from PANDASTACK_CANDIDATE_ROOT (default: the repo
// root). The leaves are the frozen fake acceptance/codex-parity/cp-02f-fake-codex.cjs,
// scripted per role by prefix; the CLIs run through the symlink that the candidate's own
// `install.sh --codex` creates in an owned skills directory, with an owned HOME.
//
// Owned temp directories only. It never runs the repository's own verify.sh or capture
// machinery (AGENTS.md); blueprint-design runs no verify. Case 5 is the only slow case.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = realpathSync(process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..'))
const SKILL_REL = 'graphs/blueprint/skills/blueprint'
const SKILL_DIR = join(ROOT, SKILL_REL)
const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
const CATALOG = 'spec/offering-capabilities.json'
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const bytesOf = file => { try { return readFileSync(file) } catch { return Buffer.from('<unreadable>') } }
const filesUnder = dir => !existsSync(dir) ? []
  : readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])

const NR01_WIRE = '{"type":"object","properties":{"json":{"type":"string"}},"required":["json"],"additionalProperties":false}'
const MARKER = `cp04e-host-marker-${process.pid}-${Date.now()}`
const INVOCATION_ID = /^bp-(interview|design|backlog)-([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{8}$/

// The catalog CP-04e pins. The first three transports are CP-01b's, unchanged.
const CODEX_ROW = Object.freeze({ implementation: 'partial', transportId: 'codex-graph-host',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
const CLAUDE_ROW = Object.freeze({ implementation: 'partial', transportId: 'claude-code', limitations: ['REQUIREMENTS_INCOMPLETE'] })
const TRANSPORTS = [
  { id: 'claude-code', provider: 'claude', entry: 'install.sh' },
  { id: 'codex-autobuild', provider: 'codex', entry: 'graphs/autobuild/tool/lib/codex.mjs' },
  { id: 'codex-bughunt', provider: 'codex', entry: 'graphs/hunt/skills/bughunt/native-runner.mjs' },
  { id: 'codex-graph-host', provider: 'codex', entry: 'core/skills/native-runtime/graph-host.mjs' },
]
// Amended for CP-06: dev is Codex install-eligible too, so the plan has a fourth line.
const THREE_LINES = 'skills/autobuild\tgraphs/autobuild/skills/autobuild\n' +
  'skills/blueprint\tgraphs/blueprint/skills/blueprint\nskills/bughunt\tgraphs/hunt/skills/bughunt\n' +
  'skills/dev\tgraphs/dev/skills/dev\n'
// CP-04c adds the native-runtime edge; CP-04e leaves the dependency list alone.
const BLUEPRINT_DEPENDENCIES = ['backlog', 'default-stack', 'knowledge-map', 'native-runtime']

let WORK, REAL_GIT, REAL_BASH, SYSTEM_TOOLS
before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-04e-')))
  REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_GIT.startsWith('/') && !REAL_GIT.includes("'"), 'a usable real git')
  REAL_BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_BASH.startsWith('/'), 'a usable bash')
  // The few system tools a path-resolving shell block can need. Never claude, gh or codex.
  SYSTEM_TOOLS = Object.fromEntries(['awk', 'basename', 'cat', 'cut', 'dirname', 'env', 'grep', 'head', 'ls', 'readlink', 'realpath', 'sed', 'sh',
    'tail', 'tr', 'uname', 'which'].map(name => [name, spawnSync('/bin/sh', ['-c', `PATH=/usr/bin:/bin command -v ${name}`], { encoding: 'utf8' }).stdout.trim()])
    .filter(([, path]) => path.startsWith('/')))
})
after(() => { if (WORK) rmSync(WORK, { recursive: true, force: true }) })

let dirNo = 0
const ownedDir = prefix => realpathSync(mkdtempSync(join(WORK, `${prefix}${++dirNo}-`)))
const linkTools = bin => { for (const [name, path] of Object.entries(SYSTEM_TOOLS)) symlinkSync(path, join(bin, name)) }

// ---------------------------------------------------------------- install through install.sh
const IDENTITY = { GIT_AUTHOR_NAME: 'CP Test', GIT_AUTHOR_EMAIL: 'cp-test@example.invalid', GIT_COMMITTER_NAME: 'CP Test', GIT_COMMITTER_EMAIL: 'cp-test@example.invalid' }
function installEnv(home, skills) {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, PANDASTACK_CODEX_SKILLS_DIR: skills,
    HARNESS_NO_GIT_CONFIG: '1', TMPDIR: tmpdir() }
  for (const key of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR']) delete env[key]
  return env
}
// The candidate's own install.sh --codex, with an owned empty HOME and an owned skills directory.
function runInstall(home, skills, args = []) {
  const r = spawnSync(REAL_BASH, [join(ROOT, 'install.sh'), '--codex', ...args], { encoding: 'utf8', env: installEnv(home, skills), cwd: WORK })
  assert.equal(r.status, 0, `install.sh --codex ${args.join(' ')}: ${r.stdout}${r.stderr}`)
  return r
}
const ownedHome = () => { const home = ownedDir('home-'); return { home, skills: join(home, '.agents', 'skills') } }
const isLink = path => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const assertNoAgentDirs = home => {
  for (const name of ['.claude', '.codex', '.local']) assert.equal(existsSync(join(home, name)), false, `${name} was not created in HOME`)
}
// One installation shared by cases 4 and 5. Built on first use.
let INSTALLED
function installed() {
  if (INSTALLED) return INSTALLED
  const { home, skills } = ownedHome()
  runInstall(home, skills)
  const link = join(skills, 'blueprint')
  assert.ok(isLink(link), `install.sh --codex linked skills/blueprint (an unflipped catalog installs only: ${readdirSync(skills).join(', ')})`)
  INSTALLED = { home, skills, link }
  return INSTALLED
}

// ---------------------------------------------------------------- the runner section
const VERBS = ['start', 'interview', 'answer', 'design', 'gate', 'backlog', 'show', 'approve', 'edit']
const CLAUDE_ONLY = ['~/.claude', '$HOME/.claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SKILL_DIR']
const NATIVE_FORM = 'node "$SKILL_DIR/blueprint-native.mjs" <verb> --args-file <file>'
const APPROVE_FORM = 'node "$SKILL_DIR/blueprint-approve.mjs" <show|approve> --args-file <file>'

// The "## Codex runner" section: from its heading to the next "## " heading outside a code fence.
function runnerSection() {
  const all = readFileSync(SKILL_MD, 'utf8').split('\n')
  let fenced = false
  const headings = []
  all.forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced
    if (!fenced && /^## /.test(line)) headings.push({ i, line: line.trimEnd() })
  })
  const runner = headings.filter(h => h.line === '## Codex runner')
  assert.equal(runner.length, 1, 'SKILL.md has exactly one "## Codex runner" section')
  const ask = headings.find(h => h.line === '## When to ask')
  assert.ok(ask, 'SKILL.md still has "## When to ask"')
  assert.ok(runner[0].i < ask.i, '"## Codex runner" comes before "## When to ask"')
  const next = headings.find(h => h.i > runner[0].i)
  const body = all.slice(runner[0].i + 1, next.i).join('\n')
  const blocks = [...body.matchAll(/^```bash[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm)].map(m => m[1])
  return { body, blocks }
}
const tableCells = line => line.split('|').slice(1, -1).map(cell => cell.trim().replace(/`/g, ''))
// The table row of each verb: the first table row that has a cell equal to the verb.
function verbRows(body) {
  const rows = body.split('\n').filter(line => /^\s*\|/.test(line))
  return Object.fromEntries(VERBS.map(verb => {
    const found = rows.filter(row => tableCells(row).includes(verb))
    assert.ok(found.length >= 1, `the steps table has a row for ${verb}`)
    return [verb, found[0]]
  }))
}
// Runs the first bash block with <installed-skill-dir> replaced, in an owned HOME with PATH = bin
// only, then prints the three variables.
function deriveRoots({ block, link, home, bin }) {
  assert.ok(block.includes('<installed-skill-dir>'), 'the first block starts from <installed-skill-dir>')
  const script = `${block.split('<installed-skill-dir>').join(link)}\nprintf '%s\\n' "SKILL_DIR=$SKILL_DIR" "ROOT=$ROOT" "CODEX=$CODEX"\n`
  const r = spawnSync(REAL_BASH, ['-c', script], { encoding: 'utf8', env: { HOME: home, PATH: bin }, cwd: home })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr,
    vars: Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) }
}

// =====================================================================
describe('CP-04e: blueprint on Codex', () => {
  test('1. catalog: the codex row, four transports, entrySha256, derived values and the drift guard', async () => {
    const catalog = readJson(resolve(ROOT, CATALOG))
    const blueprint = catalog.offerings.find(o => o.id === 'blueprint')
    assert.deepEqual(blueprint.providers.codex, CODEX_ROW, 'blueprint\'s codex row')
    assert.deepEqual(blueprint.providers.claude, CLAUDE_ROW, 'blueprint\'s claude row is unchanged')
    assert.deepEqual(catalog.transports, TRANSPORTS, 'the three CP-01b transports and codex-graph-host, in that order')
    assert.equal(blueprint.entrySha256, sha(readFileSync(SKILL_MD)), 'entrySha256 is the sha256 of the SKILL.md bytes')
    assert.deepEqual(blueprint.dependencies, BLUEPRINT_DEPENDENCIES)
    assert.deepEqual(blueprint.evidenceOwners, ['graphs/blueprint/workflows/blueprint-design.js', 'graphs/blueprint/skills/blueprint/write-docs.mjs'])
    assert.deepEqual(blueprint.proofRefs, [])
    assert.equal(blueprint.requirementsComplete, false)
    assert.equal(blueprint.nativeReadiness, 'unknown')
    assert.deepEqual(catalog.offerings.filter(o => o.providers.codex.implementation === 'partial').map(o => o.id).sort(),
      ['autobuild', 'blueprint', 'bughunt', 'dev'], 'codex partial rows are exactly autobuild, blueprint, bughunt and dev (CP-06)')

    const { installEligible, nativeImplementationOf, checkCatalogDrift } = await loadModule('core/skills/native-runtime/catalog.mjs')
    assert.equal(installEligible(blueprint, 'codex'), true)
    assert.equal(nativeImplementationOf(blueprint), 'present-limited')
    assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
  })

  test('2. install: the plan is three lines, install.sh --codex links blueprint in an owned HOME, --uninstall removes it', () => {
    const plan = spawnSync(process.execPath, [join(ROOT, 'core/skills/native-runtime/install-plan.mjs'), '--installation-root', ROOT, '--backend', 'codex'],
      { encoding: 'utf8', cwd: WORK, env: { PATH: dirname(process.execPath) } })
    assert.deepEqual([plan.status, plan.stderr, plan.stdout], [0, '', THREE_LINES], 'install-plan prints autobuild, blueprint, bughunt, dev')

    const { home, skills } = ownedHome()
    runInstall(home, skills)
    assert.equal(isLink(join(skills, 'blueprint')), true, 'blueprint is a symlink')
    assert.equal(readlinkSync(join(skills, 'blueprint')), SKILL_DIR, 'blueprint links to graphs/blueprint/skills/blueprint')
    assert.equal(readlinkSync(join(skills, 'autobuild')), join(ROOT, 'graphs/autobuild/skills/autobuild'))
    assert.equal(readlinkSync(join(skills, 'bughunt')), join(ROOT, 'graphs/hunt/skills/bughunt'))
    assert.deepEqual(readdirSync(skills).sort(), ['autobuild', 'blueprint', 'bughunt', 'dev'])
    assertNoAgentDirs(home)
    assert.deepEqual(readdirSync(home), ['.agents'], 'HOME holds only the skills parent')

    runInstall(home, skills, ['--uninstall'])
    assert.equal(existsSync(join(skills, 'blueprint')) || isLink(join(skills, 'blueprint')), false, '--uninstall removed the blueprint link')
    assertNoAgentDirs(home)
  })

  test('3. readiness: inspectOffering is ready for blueprint on Codex only with an injected probe that reports support', async () => {
    const { inspectOffering } = await loadModule('core/skills/native-runtime/inspect-offering.mjs')
    const bin = ownedDir('inspect-bin-')
    const marker = join(bin, 'executable-ran.log')
    const executable = join(bin, 'codex')
    writeFileSync(executable, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 })
    const options = extra => ({ installationRoot: ROOT, offeringId: 'blueprint', backend: 'codex', executable,
      configuration: { model: 'fixture-model', effort: 'medium', maxConcurrentSubagents: 4 }, ...extra })
    const checks = result => Object.fromEntries(result.checks.map(check => [check.id, [check.status, check.code]]))

    const requests = []
    const probe = request => { requests.push(request); return Promise.resolve({ model: true, effort: true, concurrency: true }) }
    const ready = await inspectOffering(options({ probe }))
    assert.deepEqual(checks(ready), Object.fromEntries(['implementation', 'executable', 'catalog', 'entry', 'transport', 'dependencies',
      'configuration', 'controls', 'probe'].map(id => [id, ['pass', null]])), JSON.stringify(checks(ready)))
    assert.equal(ready.status, 'ready')
    assert.deepEqual([ready.offeringId, ready.backend, ready.limitations, ready.unsupportedControls],
      ['blueprint', 'codex', [...CODEX_ROW.limitations], []])
    assert.equal(requests.length, 1)
    assert.deepEqual([requests[0].offeringId, requests[0].backend, requests[0].executable], ['blueprint', 'codex', executable])

    const without = await inspectOffering(options())
    assert.equal(without.status, 'unknown', 'no probe is never ready')
    assert.deepEqual(checks(without).probe, ['unknown', 'PROBE_ABSENT'])
    assert.deepEqual(checks(without).implementation, ['pass', null])

    const refused = await inspectOffering(options({ probe: () => ({ model: true, effort: false, concurrency: true }) }))
    assert.equal(refused.status, 'unsupported')
    assert.equal(existsSync(marker), false, 'the executable never ran')
  })

  test('4. the section: placement, verbs, forms, host keys, no Claude-only text, and the first block derives the roots', () => {
    const { body, blocks } = runnerSection()
    for (const text of CLAUDE_ONLY) assert.ok(!body.includes(text), `the section does not contain ${text}`)
    assert.ok(blocks.length >= 2, 'the section has the roots block and the commands block')
    for (const form of [NATIVE_FORM, APPROVE_FORM]) assert.ok(blocks.some(block => block.includes(form)), `a bash block holds ${form}`)

    const rows = verbRows(body)
    assert.equal(new Set(Object.values(rows)).size, 9, 'one table row per verb, all nine')
    for (const verb of VERBS) assert.ok(rows[verb].includes('repo'), `the ${verb} row names repo`)
    for (const verb of ['interview', 'design', 'backlog']) {
      for (const key of ['installationRoot', 'codexBin', 'env', 'timeoutMs']) assert.ok(rows[verb].includes(key), `the ${verb} row names ${key}`)
    }
    assert.ok(rows.approve.includes('approvalSha256'), 'the approve row names approvalSha256')

    assert.ok(!/HOME|\.claude|CLAUDE/.test(blocks[0]), 'the roots block reads no HOME, .claude or CLAUDE_* name')
    const { home, link } = installed()
    const bin = ownedDir('derive-bin-')
    linkTools(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const deriveHome = ownedDir('derive-home-')
    const r = deriveRoots({ block: blocks[0], link, home: deriveHome, bin })
    assert.equal(r.stderr, '')
    assert.equal(r.code, 0)
    assert.equal(r.stdout, `SKILL_DIR=${SKILL_DIR}\nROOT=${ROOT}\nCODEX=${join(bin, 'codex')}\n`,
      'the block prints nothing of its own; SKILL_DIR, ROOT and CODEX are the real skill directory, the root realpath and the stub')
    assert.equal(realpathSync(link), SKILL_DIR, 'the installed path is a symlink to the real skill directory')
    assert.deepEqual(readdirSync(deriveHome), [], 'the block wrote nothing in HOME')
    assertNoAgentDirs(home)
  })
})

// =====================================================================
// Case 5. The whole path through the installed symlink on the production catalog.
const wire = value => ({ json: JSON.stringify(value) })
const REQUEST_TEXT = 'Build a reading list app where people track the books they want to read'
const BRIEF = {
  goal: 'Track books to read', mode: 'app', users: ['readers'],
  requirements: [{ id: 'R1', text: 'Add a book', source: 'request' }, { id: 'R2', text: 'List the books', source: 'request' }],
  decided: [], gaps: ['sign-in'], contradictions: [], constraints: [], existing_stack: 'none',
}
const QUESTION = (id, question, labels) => ({
  id, question, stakes: `what ${id} costs to change later`,
  options: labels.map(label => ({ label, description: `about ${label}` })),
  recommended: labels[1], default_if_unasked: labels[1], resolves: [],
})
const QUESTIONS = {
  questions: [QUESTION('Q1', 'How do people sign in?', ['Magic link', 'Email and password']), QUESTION('Q2', 'Which database?', ['Postgres', 'SQLite', 'Mongo'])],
  preflight: [{ what: 'SMTP key', why: 'sends mail', needed_by: 'S3' }, { what: 'Domain name', why: 'serves the app', needed_by: 'S1' }],
  assumptions: [{ assumption: 'One person per list', why: 'stated' }, { assumption: 'English only', why: 'no i18n asked' }],
}
const DESIGN = {
  summary: 'A reading list.',
  modules: [
    { id: 'M1', name: 'books', responsibility: 'store books', requirements: ['R1'], boundary: false, shapes: [], pick: '', depth_reason: '' },
    { id: 'M2', name: 'reading', responsibility: 'read state', requirements: ['R2'], boundary: false, shapes: [], pick: '', depth_reason: '' },
  ],
  failure_modes: [{ id: 'F1', what: 'db down', module: 'M1', silent: false, tested: true, handled: true, plan: 'return 503' }],
  adrs: [{ id: 'ADR1', title: 'database', options: ['SQLite', 'Postgres'], decision: 'SQLite', reason: 'one user' }],
  departures: [],
  honors: ['Q1', 'Q2', 'A1', 'A2'].map(id => ({ id, how: `the design follows ${id}` })),
  conflicts: [],
  knowledge: [{ id: 'K1', knowledge: 'book shape', kind: 'type', owner: 'src/books/book.ts', used_by: ['M1', 'M2'], changes_together_because: 'one row shape' }],
  premises: [],
}
const AC = sid => [{ id: `${sid}-AC1`, criterion: `${sid} works`, fails_when: `${sid} output is wrong` }]
const SLICES = {
  app: 'reading-list',
  slices: [
    { id: 'S1', title: 'scaffold', goal: 'g1', requirements: [], acceptance: AC('S1'), depends_on: [] },
    { id: 'S2', title: 'books', goal: 'g2', requirements: ['R1'], acceptance: AC('S2'), depends_on: ['S1'] },
    { id: 'S3', title: 'reading', goal: 'g3', requirements: ['R2'], acceptance: AC('S3'), depends_on: ['S2'] },
  ],
  knowledge: [{ id: 'K1', built_in: 'S2', used_by: ['S2', 'S3'] }],
}
const HAPPY = Object.freeze({
  extractor: wire(BRIEF), questioner: wire(QUESTIONS), architect: wire(DESIGN), slicer: wire(SLICES),
  advisor: wire({ verdict: 'approve', issues: [], questions: [] }),
})
const ROLES = ['extractor', 'questioner', 'architect', 'slicer', 'advisor']
const ANSWERS = {
  answers: [{ id: 'Q1', answer: 'Email and password' }, { id: 'Q2', answer: 'Postgres, hosted' }], have: ['SMTP key'],
  overrides: [{ id: 'A1', answer: 'Two people share a list' }],
}
const GIT_ENV = () => ({ PATH: `${dirname(REAL_GIT)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', ...IDENTITY })
const git = (repo, args) => execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV(), stdio: ['ignore', 'pipe', 'pipe'] })
const FORBIDDEN_GIT = ['push', 'fetch', 'pull', 'merge', 'remote', 'clone', 'ls-remote']
const subcommand = call => call[0] === '-C' ? call[2] : call[0]

// One owned flow: a fixture repo (its path holds a space) with a bare origin, an owned HOME, a fake
// script directory outside PATH and a bin/ that is the whole PATH of the CLIs and of every leaf: a
// `node` link, a `bash` link, a recording `git` wrapper, recording `claude` and `gh` stubs, a few
// system tools and the frozen fake named `codex`, so the roots block finds it.
async function makeFlow() {
  const dir = ownedDir('flow-')
  const flow = { dir, repo: join(dir, 'my repo'), origin: join(dir, 'origin.git'), bin: join(dir, 'bin'), fake: join(dir, 'fake'), home: join(dir, 'home'),
    ghLog: join(dir, 'gh.log'), claudeLog: join(dir, 'claude.log'), runs: [] }
  for (const d of [flow.repo, flow.bin, flow.fake, flow.home]) mkdirSync(d)
  flow.repo = realpathSync(flow.repo)
  flow.stateDir = join(flow.repo, '.git', 'harness-blueprint')
  symlinkSync(process.execPath, join(flow.bin, 'node'))
  symlinkSync(REAL_BASH, join(flow.bin, 'bash'))
  linkTools(flow.bin)
  writeFileSync(join(flow.bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do printf \'%s\\037\' "$a" >> "$CP04E_GIT_LOG"; done',
    'printf \'\\036\' >> "$CP04E_GIT_LOG"',
    `exec '${REAL_GIT}' "$@"`, '',
  ].join('\n'), { mode: 0o755 })
  for (const [name, log] of [['gh', flow.ghLog], ['claude', flow.claudeLog]]) {
    writeFileSync(join(flow.bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 })
  }
  flow.codex = join(flow.bin, 'codex')
  cpSync(FAKE_CODEX, flow.codex)
  chmodSync(flow.codex, 0o755)
  // Each role is identified by the instructions the host prepends to its prompt (production roles, the candidate root).
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  const roles = ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: ROOT, name: role }).instructions + '\n\n' }))
  writeFileSync(join(flow.fake, 'script.json'), JSON.stringify({ roles, replies: HAPPY }))
  git(dir, ['init', '-q', '--bare', flow.origin])
  git(flow.repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(flow.repo, 'README.md'), '# app\n')
  git(flow.repo, ['add', 'README.md'])
  git(flow.repo, ['commit', '-q', '-m', 'init'])
  git(flow.repo, ['remote', 'add', 'origin', flow.origin])
  git(flow.repo, ['push', '-q', 'origin', 'main'])
  git(flow.repo, ['fetch', '-q', 'origin'])
  writeFileSync(join(flow.repo, 'README.md'), '# app\nlocal edit\n')
  writeFileSync(join(flow.repo, 'notes.txt'), 'untracked notes\n')
  return flow
}
// The args file's `env` is the leaf's whole environment.
const leafEnv = flow => ({ HOME: flow.home, PATH: flow.bin, FAKE_CODEX_DIR: flow.fake })
let runNo = 0
// One CLI run as a child, through the installed symlink path. The CLI's own env also carries a
// marker that must never reach a leaf, an output or a state file.
function runCli(flow, module, verb, args) {
  const id = ++runNo
  const argsPath = join(flow.dir, `args-${id}.json`)
  const gitLog = join(flow.dir, `git-${id}.log`)
  writeFileSync(argsPath, JSON.stringify(args))
  const script = join(installed().link, module)
  return new Promise(done => {
    const child = spawn(process.execPath, [script, verb, '--args-file', argsPath], { cwd: flow.dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: { PATH: flow.bin, HOME: flow.home, CP04E_HOST_ONLY: MARKER, CP04E_GIT_LOG: gitLog, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        LANG: 'C', TZ: 'Pacific/Kiritimati', ...IDENTITY } })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      const raw = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : ''
      const gitCalls = raw.split('\x1e').filter((rec, i, all) => i < all.length - 1).map(rec => rec.split('\x1f').slice(0, -1))
      const run = { verb, code, stdout, stderr, gitCalls }
      flow.runs.push(run)
      done(run)
    })
  })
}
const nativeCli = (flow, verb, args) => runCli(flow, 'blueprint-native.mjs', verb, args)
const approveCli = (flow, verb, args) => runCli(flow, 'blueprint-approve.mjs', verb, args)
// A stage report: {status, file, invocationId, redacted}, one line, keys in that order.
function assertStage(r, stage, status, file) {
  assert.deepEqual([r.code, r.stderr], [0, ''], `${r.verb} exits 0 with an empty stderr`)
  const report = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(report), ['status', 'file', 'invocationId', 'redacted'])
  const m = INVOCATION_ID.exec(report.invocationId)
  assert.ok(m && m[1] === stage, `invocationId ${report.invocationId} is a ${stage} invocation`)
  assert.equal(r.stdout, JSON.stringify({ status, file, invocationId: report.invocationId, redacted: false }) + '\n')
}
const assertOk = (r, expected) => {
  assert.deepEqual([r.code, r.stderr], [0, ''], `${r.verb} exits 0 with an empty stderr`)
  assert.equal(r.stdout, JSON.stringify(expected) + '\n')
}
function snapshot(flow) {
  const walk = (top, rel = '') => {
    const out = {}
    for (const name of readdirSync(join(top, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      if (r === '.git') continue
      out[r] = lstatSync(join(top, r)).isDirectory() ? 'dir' : sha(readFileSync(join(top, r)))
    }
    return out
  }
  return { head: git(flow.repo, ['symbolic-ref', 'HEAD']), refs: git(flow.repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    originRefs: git(flow.origin, ['for-each-ref', '--format=%(refname) %(objectname)']), index: git(flow.repo, ['ls-files', '-s']), tree: walk(flow.repo) }
}

describe('CP-04e: the whole path on the production catalog', () => {
  test('5. start, interview, answer, design, backlog, show and approve through the installed symlink; strict schema, read-only, no Claude', async () => {
    const flow = await makeFlow()
    const snap0 = snapshot(flow)
    const hostKeys = { installationRoot: ROOT, codexBin: flow.codex, env: leafEnv(flow), timeoutMs: 120000 }

    assertOk(await nativeCli(flow, 'start', { repo: flow.repo, request: REQUEST_TEXT }), { stateDir: flow.stateDir, redacted: false })
    assertStage(await nativeCli(flow, 'interview', { repo: flow.repo, ...hostKeys }), 'interview', 'needs-human', 'run1.json')
    assert.equal(readJson(join(flow.stateDir, 'run1.json')).status, 'needs-human')
    assertOk(await nativeCli(flow, 'answer', { repo: flow.repo, ...ANSWERS }), { decisions: 3, assumptions: 1, owed: 1, redacted: false })
    assertStage(await nativeCli(flow, 'design', { repo: flow.repo, ...hostKeys }), 'design', 'design-ready', 'run2.json')
    assertStage(await nativeCli(flow, 'backlog', { repo: flow.repo, ...hostKeys }), 'backlog', 'backlog-ready', 'run3.json')
    assert.deepEqual(snapshot(flow), snap0, 'before approval HEAD, every ref, the index and the work tree are unchanged')

    // show, then approve with the hash show printed.
    const shown = await approveCli(flow, 'show', { repo: flow.repo })
    assert.deepEqual([shown.code, shown.stderr], [0, ''], 'show exits 0 with an empty stderr')
    assert.ok(shown.stdout.startsWith('Blueprint approval: reading-list\nBranch: integration/reading-list\n'), shown.stdout.slice(0, 120))
    const last = shown.stdout.trimEnd().split('\n').at(-1)
    assert.match(last, /^approvalSha256: [0-9a-f]{64}$/)
    const approved = await approveCli(flow, 'approve', { repo: flow.repo, approvalSha256: last.slice('approvalSha256: '.length) })
    assert.deepEqual([approved.code, approved.stderr], [0, ''], 'approve exits 0 with an empty stderr')
    const out = JSON.parse(approved.stdout)
    assert.equal(approved.stdout, JSON.stringify(out) + '\n')
    assert.deepEqual(Object.keys(out), ['branch', 'commit', 'paths'])
    assert.equal(out.branch, 'integration/reading-list')

    // approve: integration/<app>, one commit holding exactly the printed paths, nothing pushed.
    assert.equal(git(flow.repo, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/integration/reading-list')
    assert.equal(git(flow.repo, ['rev-parse', 'HEAD']).trim(), out.commit)
    assert.equal(git(flow.repo, ['rev-parse', 'HEAD^']).trim(), git(flow.repo, ['rev-parse', 'refs/heads/main']).trim(), 'one commit on the original HEAD')
    assert.ok(out.paths.length > 0)
    assert.deepEqual(git(flow.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD']).trim().split('\n').sort(), [...out.paths].sort(),
      'the commit holds exactly the paths approve printed')
    assert.equal(snapshot(flow).originRefs, snap0.originRefs, 'nothing was pushed')
    assert.equal(readFileSync(join(flow.repo, 'README.md'), 'utf8'), '# app\nlocal edit\n')
    assert.equal(readFileSync(join(flow.repo, 'notes.txt'), 'utf8'), 'untracked notes\n')
    assert.equal(existsSync(flow.ghLog), false, 'gh was never run')
    assert.equal(existsSync(flow.claudeLog), false, 'claude was never run')
    for (const run of flow.runs) {
      assert.ok(!(run.stdout + run.stderr).includes(MARKER), `the env marker is not in ${run.verb}'s output`)
      for (const call of run.gitCalls) {
        assert.ok(!FORBIDDEN_GIT.includes(subcommand(call)), `${run.verb}: no remote git call: ${JSON.stringify(call)}`)
        if (run.verb !== 'approve') assert.equal(subcommand(call), 'rev-parse', `${run.verb} runs only git rev-parse`)
      }
    }
    for (const file of [...filesUnder(flow.stateDir), ...filesUnder(flow.fake)]) assert.ok(!bytesOf(file).toString('utf8').includes(MARKER), `no marker in ${file}`)

    // Every leaf: read-only, no user config, exactly the args file's env, the strict schema.
    const spawns = lines(join(flow.fake, 'calls.jsonl'))
    assert.deepEqual(spawns.map(call => call.role), ['extractor', 'questioner', 'architect', 'advisor', 'slicer', 'advisor'])
    for (const call of spawns) {
      assert.equal(call.sandbox, 'read-only', `${call.role} sandbox`)
      assert.ok(call.argv.includes('--ignore-user-config'), `${call.role} ran with --ignore-user-config`)
      assert.deepEqual(Object.keys(call.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['FAKE_CODEX_DIR', 'HOME', 'PATH'],
        `${call.role}: the leaf env is the args file's, exactly`)
      assert.deepEqual([call.env.HOME, call.env.PATH, call.env.FAKE_CODEX_DIR], [flow.home, flow.bin, flow.fake])
      assert.equal(call.cwd, flow.repo, `${call.role} ran in the repo top`)
      assert.equal(typeof call.schema, 'string', `${call.role} was handed an --output-schema file`)
      assert.notEqual(call.schema, NR01_WIRE, `${call.role}: the schema is not the NR-01 wire schema`)
      const schema = JSON.parse(call.schema)
      assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${call.role}: the schema is an object`)
      assert.equal(schema.additionalProperties, false, `${call.role}: the strict schema has additionalProperties false`)
      // The candidate root may itself sit under a .claude directory (a worktree), so its own spelling is not counted.
      const stdin = call.stdin.split(ROOT).join('<ROOT>')
      assert.ok(!stdin.includes('.claude') && !stdin.includes('CLAUDE_CONFIG_DIR'), `${call.role}'s stdin names no .claude or CLAUDE_CONFIG_DIR`)
    }
    const advisors = spawns.filter(call => call.role === 'advisor')
    assert.equal(advisors.length, 2)
    for (const call of advisors) assert.ok(call.stdin.includes(`${ROOT}/core/skills/backlog/SKILL.md`), 'the advisor\'s stdin names <ROOT>/core/skills/backlog/SKILL.md')
    assert.equal(existsSync(join(flow.home, '.claude')), false, 'the owned HOME holds no .claude')
    assertNoAgentDirs(flow.home)

    // The roots the session passed are what the section's own block prints for this layout (case 4's derivation).
    const { blocks } = runnerSection()
    const derived = deriveRoots({ block: blocks[0], link: installed().link, home: ownedDir('flow-derive-home-'), bin: flow.bin })
    assert.deepEqual([derived.code, derived.stderr, derived.vars.ROOT, derived.vars.CODEX], [0, '', ROOT, flow.codex],
      'ROOT and CODEX from the section are the installationRoot and codexBin the flow used')
  })
})
