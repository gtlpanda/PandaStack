// CP-08 acceptance: /release-pr on Codex (spec/contracts/codex-parity-cp-08.md).
// WIRING PROOF, NOT RUNTIME CERTIFICATION: no real codex, claude, gh or network. The leaves
// are the frozen fake acceptance/codex-parity/cp-02f-fake-codex.cjs, scripted per role; the
// release remote is offline: `gh` and `claude` are recording stubs on the PATH that must never
// be called, and the only git the CLI may run is `rev-parse`. What this proves is the state
// machine around the leaves (approval for one exact head, one merge attempt, escalation with no
// fallback) and which Codex sandbox flags each release role receives. It does not prove that a
// real Codex `workspace-write` sandbox with `network_access=true` can run `gh`.
//
// Runs from PANDASTACK_CANDIDATE_ROOT (default: the repo root). Owned temp directories only.
// It never runs the repository's own verify.sh or capture machinery (AGENTS.md).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = realpathSync(process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..'))
const SKILL_DIR = join(ROOT, 'graphs/release/skills/release-pr')
const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
const CLI = join(SKILL_DIR, 'release-native.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const callsOf = flow => existsSync(join(flow.fake, 'calls.jsonl'))
  ? readFileSync(join(flow.fake, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

const NETWORK_FLAG = 'sandbox_workspace_write.network_access=true'
const PR = 7
const HEAD1 = 'a'.repeat(40)
const HEAD2 = 'b'.repeat(40)
const MERGE_SHA = 'c'.repeat(40)
const RELEASE_ROLES = ['release-checker', 'scribe', 'merger', 'deploy-watcher', 'advisor']
const CLAUDE_ONLY = ['~/.claude', '$HOME/.claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SKILL_DIR']

let WORK, REAL_GIT, REAL_BASH, SYSTEM_TOOLS
before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-08-')))
  REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  REAL_BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_GIT.startsWith('/') && !REAL_GIT.includes("'") && REAL_BASH.startsWith('/'), 'a usable git and bash')
  SYSTEM_TOOLS = Object.fromEntries(['awk', 'basename', 'cat', 'cut', 'dirname', 'env', 'grep', 'head', 'ls', 'readlink', 'realpath', 'sed', 'sh',
    'tail', 'tr', 'uname', 'which'].map(name => [name, spawnSync('/bin/sh', ['-c', `PATH=/usr/bin:/bin command -v ${name}`], { encoding: 'utf8' }).stdout.trim()])
    .filter(([, path]) => path.startsWith('/')))
})
after(() => { if (WORK) rmSync(WORK, { recursive: true, force: true }) })

let dirNo = 0
const ownedDir = prefix => realpathSync(mkdtempSync(join(WORK, `${prefix}${++dirNo}-`)))

// ---------------------------------------------------------------- the leaf scripts
const wire = value => ({ json: JSON.stringify(value) })
const TARGET = { name: 'web', workflow: 'deploy.yml', status_command: '', health: 'https://app.example.invalid/health' }
// A release-checker snapshot of PR #7 at `head`, in the graph's CHECK_SCHEMA.
const snap = (head, extra = {}) => wire({
  pr: { number: PR, state: 'OPEN', headRefOid: head, headRefName: 'topic', baseRefName: 'main', mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED', isDraft: false, mergeCommit: '', ...extra },
  default_branch: 'main', merge_methods: ['squash'], checks: [{ name: 'ci', bucket: 'pass' }],
  deploy: { source: 'config', merge_method: 'squash', targets: [TARGET], missing_credentials: [] },
})
const DOCS = wire({ touched: ['CHANGELOG.md'], summary: 'notes added', for_human: [], release_notes: 'Fixes the cart.' })
const MERGED = wire({ outcome: 'MERGED', merge_sha: MERGE_SHA, by_this_attempt: true, detail: 'merged' })
const NOT_MERGED = wire({ outcome: 'NOT_MERGED', merge_sha: '', by_this_attempt: false, detail: 'merge failed' })
const WATCH_OK = wire({ targets: [{ name: 'web', evidence: 'MATCHED', health: 'OK', detail: 'run matched the merge commit' }] })
const WATCH_FAILED = wire({ targets: [{ name: 'web', evidence: 'FAILED', health: 'FAIL', detail: 'the deploy run failed' }] })
const ADVICE = wire({ action: 'rollback', diagnosis: 'the deploy of this commit failed', evidence: 'run log' })

// ---------------------------------------------------------------- one flow: repo, fake codex, stubs
const IDENTITY = { GIT_AUTHOR_NAME: 'CP Test', GIT_AUTHOR_EMAIL: 'cp-test@example.invalid', GIT_COMMITTER_NAME: 'CP Test', GIT_COMMITTER_EMAIL: 'cp-test@example.invalid' }
const GIT_ENV = () => ({ PATH: `${dirname(REAL_GIT)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', ...IDENTITY })
const git = (repo, args) => execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV(), stdio: ['ignore', 'pipe', 'pipe'] })
let rolesCache
async function rolePrefixes() {
  if (rolesCache) return rolesCache
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  rolesCache = RELEASE_ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: ROOT, name: role }).instructions + '\n\n' }))
  return rolesCache
}

async function makeFlow() {
  const dir = ownedDir('flow-')
  const flow = { dir, repo: join(dir, 'my repo'), bin: join(dir, 'bin'), fake: join(dir, 'fake'), home: join(dir, 'home'),
    ghLog: join(dir, 'gh.log'), claudeLog: join(dir, 'claude.log'), gitLog: join(dir, 'git.log'), runs: 0 }
  for (const d of [flow.repo, flow.bin, flow.fake, flow.home]) mkdirSync(d)
  flow.repo = realpathSync(flow.repo)
  flow.stateDir = join(flow.repo, '.git', 'harness-release', String(PR))
  symlinkSync(process.execPath, join(flow.bin, 'node'))
  symlinkSync(REAL_BASH, join(flow.bin, 'bash'))
  for (const [name, path] of Object.entries(SYSTEM_TOOLS)) symlinkSync(path, join(flow.bin, name))
  writeFileSync(join(flow.bin, 'git'), [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\037' "$a" >> '${flow.gitLog}'; done`,
    `printf '\\036' >> '${flow.gitLog}'`,
    `exec '${REAL_GIT}' "$@"`, '',
  ].join('\n'), { mode: 0o755 })
  // gh and claude are the offline remote: they record any call and fail it. None is expected.
  for (const [name, log] of [['gh', flow.ghLog], ['claude', flow.claudeLog]]) {
    writeFileSync(join(flow.bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 })
  }
  flow.codex = join(flow.bin, 'codex')
  cpSync(FAKE_CODEX, flow.codex)
  chmodSync(flow.codex, 0o755)
  git(flow.repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(flow.repo, 'README.md'), '# app\n')
  git(flow.repo, ['add', 'README.md'])
  git(flow.repo, ['commit', '-q', '-m', 'init'])
  return flow
}
// The replies the fake gives each role from now on (one reply per role, repeated for every spawn).
async function script(flow, replies) {
  writeFileSync(join(flow.fake, 'script.json'), JSON.stringify({ roles: await rolePrefixes(), replies }))
}
const hostKeys = flow => ({ installationRoot: ROOT, codexBin: flow.codex,
  env: { HOME: flow.home, PATH: flow.bin, FAKE_CODEX_DIR: flow.fake }, timeoutMs: 120000 })
const stage = (flow, extra = {}) => ({ repo: flow.repo, pr: PR, ...hostKeys(flow), ...extra })

// One CLI run as a child. The CLI's own env carries a marker that must never reach a leaf or an output.
const MARKER = `cp08-host-marker-${process.pid}-${Date.now()}`
function cli(flow, verb, args) {
  const argsPath = join(flow.dir, `args-${++flow.runs}.json`)
  writeFileSync(argsPath, JSON.stringify(args))
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, verb, '--args-file', argsPath], { cwd: flow.dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: { PATH: flow.bin, HOME: flow.home, CP08_HOST_ONLY: MARKER, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', ...IDENTITY } })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => done({ verb, code, stdout, stderr }))
  })
}
const ok = (r, status) => {
  assert.deepEqual([r.code, r.stderr], [0, ''], `${r.verb}: ${r.stdout}${r.stderr}`)
  const report = JSON.parse(r.stdout)
  if (status !== undefined) assert.equal(report.status, status, `${r.verb} status (reason: ${readJson(join(report.stateDir, report.file)).reason})`)
  return report
}
const refused = (r, code, exit = 2) => {
  assert.deepEqual([r.code, r.stdout, r.stderr], [exit, '', JSON.stringify({ error: code }) + '\n'], `${r.verb} refuses with ${code}`)
}
const ledger = flow => readJson(join(flow.stateDir, 'ledger.json'))
const stateFile = (flow, name) => join(flow.stateDir, name)
const spawnedRoles = flow => callsOf(flow).map(call => call.role)
const hasNetwork = call => call.argv.some((arg, i) => arg === '-c' && call.argv[i + 1] === NETWORK_FLAG)

// The offline-remote invariants every flow keeps: nothing called gh, claude or any git write.
function assertNoRemoteNoFallback(flow) {
  assert.equal(existsSync(flow.ghLog), false, 'gh was never called')
  assert.equal(existsSync(flow.claudeLog), false, 'claude was never called (no fallback)')
  const raw = existsSync(flow.gitLog) ? readFileSync(flow.gitLog, 'utf8') : ''
  const calls = raw.split('\x1e').filter((rec, i, all) => i < all.length - 1).map(rec => rec.split('\x1f').slice(0, -1))
  for (const call of calls) {
    const sub = call[0] === '-C' ? call[2] : call[0]
    assert.equal(sub, 'rev-parse', `the CLI ran only git rev-parse (saw ${sub})`)
  }
  for (const call of callsOf(flow)) {
    assert.ok(!JSON.stringify(call.env).includes(MARKER), 'the CLI-only env marker never reaches a leaf')
    assert.equal(call.cwd, flow.repo, 'a leaf runs in the repository')
  }
}

// Brings a flow to a saved approval for HEAD1: docs not needed; ready then approve.
async function readyAndApprove(flow, head = HEAD1) {
  await script(flow, { 'release-checker': snap(head) })
  ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
  ok(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head, base: 'main' }))
}

// =====================================================================
describe('CP-08: catalog and launcher (wiring proof, not runtime certification)', () => {
  test('1. release-pr is codex partial through codex-graph-host with LIVE_PROOF_MISSING, a proofRef and no new transport', async () => {
    const catalog = readJson(resolve(ROOT, 'spec/offering-capabilities.json'))
    const row = catalog.offerings.find(o => o.id === 'release-pr')
    assert.deepEqual(row.providers.codex, { implementation: 'partial', transportId: 'codex-graph-host',
      limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
    assert.deepEqual(row.providers.claude, { implementation: 'partial', transportId: 'claude-code', limitations: ['REQUIREMENTS_INCOMPLETE'] })
    assert.deepEqual(row.proofRefs, ['cp-08-release-codex'])
    assert.deepEqual(row.dependencies, ['backlog', 'default-stack', 'knowledge-map', 'native-runtime'])
    assert.equal(row.permissionProfile, null, 'permission profiles are per leaf role, not per offering')
    assert.equal(row.entrySha256, sha(readFileSync(SKILL_MD)))
    assert.equal(catalog.transports.filter(t => t.id === 'codex-graph-host').length, 1, 'no second graph-host transport')
    const { installEligible, nativeImplementationOf, checkCatalogDrift } = await loadModule('core/skills/native-runtime/catalog.mjs')
    assert.equal(installEligible(row, 'codex'), true)
    assert.equal(nativeImplementationOf(row), 'present-limited')
    assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
    // security-audit is not part of this port; its row is whatever the expected-state fixture says (unavailable until its own port flips it).
    const audit = catalog.offerings.find(o => o.id === 'security-audit').providers.codex
    const expected = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/codex-expected-state.json'), 'utf8'))
    assert.equal(audit.implementation, expected.unavailable.includes('security-audit') ? 'unavailable' : 'partial')
  })

  test('2. codexExecArgs: network access is workspace-write only, opt-in, and never widens the sandbox', async () => {
    const { codexExecArgs } = await loadModule('core/skills/native-runtime/codex-exec.mjs')
    const base = { model: 'm', reasoningEffort: 'low' }
    const none = codexExecArgs({ ...base, sandbox: 'workspace-write' })
    assert.ok(!none.includes(NETWORK_FLAG), 'no network flag by default')
    assert.ok(!codexExecArgs({ ...base, sandbox: 'workspace-write', networkAccess: false }).includes(NETWORK_FLAG))
    const net = codexExecArgs({ ...base, sandbox: 'workspace-write', networkAccess: true })
    assert.equal(net[net.indexOf('--sandbox') + 1], 'workspace-write')
    assert.ok(net.some((arg, i) => arg === '-c' && net[i + 1] === NETWORK_FLAG))
    assert.ok(!net.includes('danger-full-access'))
    assert.deepEqual(net.filter(arg => arg === '--ignore-user-config'), ['--ignore-user-config'], 'user config is still ignored')
    for (const bad of [{ sandbox: 'read-only', networkAccess: true }, { sandbox: 'workspace-write', networkAccess: 'yes' },
      { sandbox: 'workspace-write', networkAccess: 1 }, { sandbox: 'workspace-write', networkAccess: null }, { sandbox: 'danger-full-access', networkAccess: true }]) {
      assert.throws(() => codexExecArgs({ ...base, ...bad }), error => error.code === 'INVALID_CODEX_EXEC_INPUT', JSON.stringify(bad))
    }
  })

  test('2b. release-controlled is selected only for the leaves of release-flow itself', async () => {
    const { resolveLeaf } = await loadModule('core/skills/native-runtime/codex-selection.mjs')
    const context = (agentType, workflowId, workflowPath) => ({ workflowId, workflowPath, agentType, label: 'l', phase: 'p',
      requestedModel: 'sonnet', requestedEffort: 'high' })
    for (const role of ['release-checker', 'merger', 'deploy-watcher']) {
      assert.equal(resolveLeaf(context(role, 'release-flow', ['release-flow'])).profile, 'release-controlled', role)
      for (const [workflowId, path] of [['dev-build', ['dev-build']], ['harness-repair', ['harness-repair']],
        ['release-flow', ['dev-build', 'release-flow']], ['security-audit-flow', ['security-audit-flow']]]) {
        assert.throws(() => resolveLeaf(context(role, workflowId, path)), error => error.code === 'INVALID_SELECTION', `${role} in ${path}`)
      }
    }
    assert.equal(resolveLeaf(context('scribe', 'release-flow', ['release-flow'])).profile, 'build-workspace')
    assert.equal(resolveLeaf(context('advisor', 'release-flow', ['release-flow'])).profile, 'source-review')
    assert.throws(() => resolveLeaf(context('scribe', 'security-audit-flow', ['security-audit-flow'])), error => error.code === 'INVALID_SELECTION')
  })

  test('3. the Codex runner section: placement, verbs, form, host keys, no Claude-only text', () => {
    const text = readFileSync(SKILL_MD, 'utf8')
    const all = text.split('\n')
    let fenced = false
    const headings = []
    all.forEach((line, i) => {
      if (line.startsWith('```')) fenced = !fenced
      else if (!fenced && line.startsWith('## ')) headings.push({ i, line })
    })
    const runner = headings.filter(h => h.line === '## Codex runner')
    assert.equal(runner.length, 1)
    const setup = headings.find(h => h.line === '## Setup')
    assert.ok(setup && runner[0].i < setup.i, '"## Codex runner" comes before "## Setup"')
    const body = all.slice(runner[0].i + 1, headings.find(h => h.i > runner[0].i).i).join('\n')
    for (const needle of CLAUDE_ONLY) assert.ok(!body.includes(needle), `the section does not contain ${needle}`)
    assert.ok(body.includes('node "$SKILL_DIR/release-native.mjs" <docs|ready|approve|land|verify> --args-file <file>'))
    const rows = body.split('\n').filter(line => /^\s*\|/.test(line))
    for (const verb of ['docs', 'ready', 'approve', 'land', 'verify']) {
      const row = rows.find(line => line.split('|')[1].replace(/`/g, '').trim() === verb)
      assert.ok(row && row.includes('repo') && row.includes('pr'), `a table row names ${verb}`)
      if (verb !== 'approve') for (const key of ['installationRoot', 'codexBin', 'env', 'timeoutMs']) assert.ok(row.includes(key), `${verb} names ${key}`)
    }
    assert.ok(rows.find(line => line.includes('`approve`')).includes('head') && body.includes('MERGE_ALREADY_ATTEMPTED'))
    // The Claude sections are still there, in order.
    const sections = headings.map(h => h.line).filter(line => line !== '## Codex runner')
    assert.deepEqual(sections.slice(0, 7), ['## Setup', '## 1. Stage `docs`', '## 2. Stage `ready`', '## 3. Waiting on deploys',
      '## 4. Approval', '## 5. Stage `land`', '## 6. Stage `verify`'])
  })

  test('4. invalid args exit 1 before any git call or leaf', async () => {
    const flow = await makeFlow()
    await script(flow, { 'release-checker': snap(HEAD1) })
    const bad = [
      ['ready', { ...stage(flow), extra: 1 }], ['ready', { ...stage(flow), pr: 0 }], ['ready', { ...stage(flow), pr: '7' }],
      ['ready', { ...stage(flow), timeoutMs: 10 }], ['ready', { ...stage(flow), env: { A: 1 } }], ['ready', { ...stage(flow), repo: 'relative' }],
      ['approve', { repo: flow.repo, pr: PR, head: 'not a sha', base: 'main' }], ['approve', { repo: flow.repo, pr: PR, head: HEAD1 }],
      ['land', { ...stage(flow), approval: { pr: PR, head: HEAD1, base: 'main' } }], ['verify', { ...stage(flow), mergeSha: MERGE_SHA }],
      ['merge', stage(flow)],
    ]
    for (const [verb, args] of bad) refused(await cli(flow, verb, args), 'INVALID_ARGS', 1)
    assert.deepEqual(callsOf(flow), [])
    assert.equal(existsSync(flow.stateDir), false, 'nothing was created')
    assert.equal(existsSync(flow.gitLog), false, 'no git call')
    refused(await cli(flow, 'ready', stage(flow, { repo: flow.dir })), 'NOT_A_REPO')
  })
})

// =====================================================================
describe('CP-08: the release state machine on Codex leaves (wiring proof, not runtime certification)', () => {
  test('5. happy path: docs, readiness, approval, one merge, deploy evidence; each leaf gets only its own sandbox and network', async () => {
    const flow = await makeFlow()
    await script(flow, { 'release-checker': snap(HEAD1), scribe: DOCS })
    ok(await cli(flow, 'docs', stage(flow)), 'docs-ready')
    assert.deepEqual(ledger(flow).docs.touched, ['CHANGELOG.md'])
    ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
    assert.equal(ledger(flow).head, HEAD1)
    assert.equal(existsSync(stateFile(flow, 'approval.json')), false, 'readiness alone approves nothing')

    ok(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }))
    assert.deepEqual(readJson(stateFile(flow, 'approval.json')), { pr: PR, head: HEAD1, base: 'main' })
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED, 'deploy-watcher': WATCH_OK })
    ok(await cli(flow, 'land', stage(flow)), 'merged')
    assert.equal(ledger(flow).merge.merge_sha, MERGE_SHA)
    assert.deepEqual(readJson(stateFile(flow, 'merge.json')), { mergeSha: MERGE_SHA, targets: [TARGET] })
    assert.equal(readJson(stateFile(flow, 'merge-attempt.json')).head, HEAD1, 'the merge attempt is recorded for that exact head')
    const done = ok(await cli(flow, 'verify', stage(flow)), 'done')
    assert.equal(done.file, 'ledger.json')
    assert.deepEqual(ledger(flow).deploy.map(d => [d.name, d.verdict]), [['web', 'DEPLOYED']])

    assert.deepEqual(spawnedRoles(flow), ['release-checker', 'scribe', 'release-checker', 'release-checker', 'merger', 'deploy-watcher'])
    // The profile is applied only to the leaves that need it.
    const byRole = Object.fromEntries(callsOf(flow).map(call => [call.role, [call.sandbox, hasNetwork(call)]]))
    assert.deepEqual(byRole, { 'release-checker': ['workspace-write', true], scribe: ['workspace-write', false],
      merger: ['workspace-write', true], 'deploy-watcher': ['workspace-write', true] })
    for (const call of callsOf(flow)) {
      assert.ok(call.argv.includes('--ignore-user-config'))
      assert.ok(!call.argv.includes('danger-full-access') && !call.argv.includes('--dangerously-bypass-approvals-and-sandbox'))
      const schema = JSON.parse(call.schema)
      assert.equal(schema.type, 'object')
      assert.equal(schema.additionalProperties, false, 'the leaf got its strict schema')
    }
    assertNoRemoteNoFallback(flow)
  })

  test('6. no approval, no merge: land refuses with zero spawns, before and after a readiness reading', async () => {
    const flow = await makeFlow()
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    refused(await cli(flow, 'land', stage(flow)), 'NO_APPROVAL')
    ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
    refused(await cli(flow, 'land', stage(flow)), 'NO_APPROVAL')
    assert.ok(!spawnedRoles(flow).includes('merger'))
    assert.equal(existsSync(stateFile(flow, 'merge-attempt.json')), false)
    assertNoRemoteNoFallback(flow)
  })

  test('7. approve only the exact head the last readiness reported; a later reading clears the approval', async () => {
    const flow = await makeFlow()
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }), 'NOT_READY')
    await script(flow, { 'release-checker': snap(HEAD1), scribe: DOCS })
    ok(await cli(flow, 'docs', stage(flow)), 'docs-ready')
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }), 'NOT_READY') // docs-ready is not ready-to-merge
    ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD2, base: 'main' }), 'HEAD_MISMATCH')
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'develop' }), 'HEAD_MISMATCH')
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR + 1, head: HEAD1, base: 'main' }), 'NOT_READY')
    assert.equal(existsSync(stateFile(flow, 'approval.json')), false)
    ok(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }))
    assert.equal(existsSync(stateFile(flow, 'approval.json')), true)
    ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
    assert.equal(existsSync(stateFile(flow, 'approval.json')), false, 'a new reading makes the old approval stale')
    assertNoRemoteNoFallback(flow)
  })

  test('8. a head that moves after approval refuses the merge: stale, no merger, approval deleted', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow, HEAD1)
    await script(flow, { 'release-checker': snap(HEAD2), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'stale')
    assert.match(ledger(flow).reason, new RegExp(`${HEAD1}.*${HEAD2}`))
    assert.ok(!spawnedRoles(flow).includes('merger'), 'the merger was never spawned')
    assert.equal(existsSync(stateFile(flow, 'approval.json')), false, 'the old approval never carries over')
    assert.equal(existsSync(stateFile(flow, 'merge-attempt.json')), false, 'no merge attempt was recorded')
    refused(await cli(flow, 'land', stage(flow)), 'NO_APPROVAL')
    assert.ok(!spawnedRoles(flow).includes('merger'))
    // A base that moved is stale too.
    const other = await makeFlow()
    await readyAndApprove(other, HEAD1)
    await script(other, { 'release-checker': snap(HEAD1, { baseRefName: 'release' }), merger: MERGED })
    ok(await cli(other, 'land', stage(other)), 'stale')
    assert.ok(!spawnedRoles(other).includes('merger'))
    assertNoRemoteNoFallback(flow)
    assertNoRemoteNoFallback(other)
  })

  test('9. a failed merge is never retried: one merger spawn, then no further dispatch for ever', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1), merger: NOT_MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.match(ledger(flow).reason, /NOT_MERGED/)
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1)
    assert.equal(existsSync(stateFile(flow, 'merge-attempt.json')), true)
    // The approval is still saved, and still cannot merge again: the dispatch is refused, nothing spawns.
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1)
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }), 'NOT_READY')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1, 'still one merger spawn')
    assert.equal(existsSync(stateFile(flow, 'merge.json')), false)
    refused(await cli(flow, 'verify', stage(flow)), 'NOT_MERGED')
    assertNoRemoteNoFallback(flow)
  })

  test('10. an unknown merge (the merger leaf fails) is never retried and says the merge may have happened', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1) }) // no merger reply: the fake exits 3, the leaf fails
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.match(ledger(flow).reason, /merge may or may not have happened/)
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1)
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1)
    assertNoRemoteNoFallback(flow)
  })

  test('11. a merge marker made by anything else also blocks the dispatch', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    writeFileSync(stateFile(flow, 'merge-attempt.json'), '{}\n')
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.ok(!spawnedRoles(flow).includes('merger'), 'the merger was never spawned')
    ok(await cli(flow, 'ready', stage(flow)), 'ready-to-merge')
    refused(await cli(flow, 'approve', { repo: flow.repo, pr: PR, head: HEAD1, base: 'main' }), 'MERGE_ALREADY_ATTEMPTED')
  })

  test('12. a refusal escalates with no Claude fallback: checker refused, then merger refused', async () => {
    const flow = await makeFlow()
    await script(flow, { 'release-checker': { refuse: true } })
    ok(await cli(flow, 'ready', stage(flow)), 'escalate')
    assert.match(ledger(flow).reason, /release-checker/)
    assert.deepEqual(spawnedRoles(flow), ['release-checker'], 'one spawn: no retry, no other provider')

    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1), merger: { refuse: true } })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1, 'the refused merge is not retried')
    assert.equal(existsSync(stateFile(flow, 'merge-attempt.json')), true)
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1, 'still one merger spawn')
    assertNoRemoteNoFallback(flow)
  })

  test('13. the host refuses release-pr when the offering is unsupported: exit 2, zero spawns, no marker', async () => {
    const flow = await makeFlow()
    const root = ownedDir('root-')
    // A candidate-shaped root whose catalog marks release-pr codex unavailable.
    for (const rel of ['spec', 'core', 'graphs', 'kit', 'install.sh']) cpSync(join(ROOT, rel), join(root, rel), { recursive: true })
    const catalogPath = join(root, 'spec/offering-capabilities.json')
    const catalog = readJson(catalogPath)
    catalog.offerings.find(o => o.id === 'release-pr').providers.codex = { implementation: 'unavailable', transportId: null,
      limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
    await script(flow, { 'release-checker': snap(HEAD1) })
    refused(await cli(flow, 'ready', stage(flow, { installationRoot: root })), 'OFFERING_UNSUPPORTED')
    assert.deepEqual(callsOf(flow), [])
    assert.equal(existsSync(stateFile(flow, 'merge-attempt.json')), false)
  })

  test('14. verify: a failed deploy is advised read-only without network, and nothing rolls back', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'merged')
    await script(flow, { 'deploy-watcher': WATCH_FAILED, advisor: ADVICE })
    ok(await cli(flow, 'verify', stage(flow)), 'rollback-recommended')
    assert.equal(ledger(flow).advice.action, 'rollback')
    const advisor = callsOf(flow).find(call => call.role === 'advisor')
    assert.equal(advisor.sandbox, 'read-only')
    assert.equal(hasNetwork(advisor), false, 'the advisor has no network')
    assert.equal(callsOf(flow).find(call => call.role === 'deploy-watcher').sandbox, 'workspace-write')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1, 'the merge is not repeated and no revert is attempted')
    assertNoRemoteNoFallback(flow)
  })

  test('16. an unknown merge that did land: land reads the state back as merged, never merges again, and verify runs', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1) }) // no merger reply: the leaf fails
    ok(await cli(flow, 'land', stage(flow)), 'escalate')
    refused(await cli(flow, 'verify', stage(flow)), 'NOT_MERGED')
    await script(flow, { 'release-checker': snap(HEAD1, { state: 'MERGED', mergeCommit: MERGE_SHA }), merger: MERGED, 'deploy-watcher': WATCH_OK })
    ok(await cli(flow, 'land', stage(flow)), 'merged')
    assert.equal(ledger(flow).merge.by_this_attempt, false)
    assert.deepEqual(readJson(stateFile(flow, 'merge.json')), { mergeSha: MERGE_SHA, targets: [TARGET] })
    ok(await cli(flow, 'verify', stage(flow)), 'done')
    assert.equal(spawnedRoles(flow).filter(role => role === 'merger').length, 1, 'the merger was spawned once, by the first land')
    assertNoRemoteNoFallback(flow)
  })

  test('15. verify passes the caller\'s round and prior to the graph; the first round waits on a pending deploy', async () => {
    const flow = await makeFlow()
    await readyAndApprove(flow)
    await script(flow, { 'release-checker': snap(HEAD1), merger: MERGED })
    ok(await cli(flow, 'land', stage(flow)), 'merged')
    await script(flow, { 'deploy-watcher': wire({ targets: [{ name: 'web', evidence: 'PENDING', health: 'NOT_CONFIGURED', detail: 'queued' }] }) })
    ok(await cli(flow, 'verify', stage(flow)), 'waiting')
    assert.deepEqual(ledger(flow).wait_for, [{ kind: 'deploy', target: 'web', sha: MERGE_SHA }])
    await script(flow, { 'deploy-watcher': WATCH_OK })
    ok(await cli(flow, 'verify', stage(flow, { verifyRound: 2, prior: [{ name: 'web', health: 'NOT_CONFIGURED' }] })), 'done')
    assertNoRemoteNoFallback(flow)
  })
})
