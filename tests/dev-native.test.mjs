// cp-06-dev-codex (proofRef): the /dev driver for Codex, graphs/dev/skills/dev/dev-native.mjs,
// run end to end through the real CP-02e host CLI on the frozen fake codex
// (acceptance/codex-parity/cp-02f-fake-codex.cjs). WIRING PROOF, NOT RUNTIME CERTIFICATION:
// no real codex, no claude, no network, no HOME; every leaf is a scripted reply, and the
// repository's own verify.sh and capture machinery are never run (AGENTS.md).
//
// The installation root is this checkout's PRODUCTION catalog, where dev's codex row is
// `partial` on codex-graph-host (CP-06). Cases:
// - a new task runs planner, advisor gate, scout, implementer, checker, acceptance auditor,
//   then the nested QA graph (checker, reviewer, qa-auditor), in that order, and saves the
//   ledger, the plan and the task the way SKILL.md section 2 does;
// - `--review` semantics: approval `human` stops at plan-ready with the plan saved, and the
//   `plan` mode builds the saved (and edited) plan with no planner or gate call;
// - the advisor gate revises, and blocks (needs-human, no resumable plan saved);
// - triage of an unplanned change goes to the advisor;
// - a provider refusal escalates once, is never retried or sent to Claude, and `resume`
//   skips the components already built while the same invocation replays with zero spawns;
// - every refusal that comes before a spawn is exit 1 or 2 with zero spawns.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'
import { devAnswer, pass, plan, review } from '../acceptance/native-runtime/nr-02-runtime-support.mjs'

const ROOT = realpathSync(resolve(import.meta.dirname, '..'))
const DEV_NATIVE = join(ROOT, 'graphs/dev/skills/dev/dev-native.mjs')
const FAKE_CODEX = join(ROOT, 'acceptance/codex-parity/cp-02f-fake-codex.cjs')
const CATALOG = 'spec/offering-capabilities.json'
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'dev-native-')))
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }))

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const INVOCATION_ID = /^dev-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

// ---------------------------------------------------------------- roles and replies

const { assembleRoleInstructions } = await import(pathToFileURL(join(ROOT, 'core/skills/native-runtime/role-files.mjs')).href)
const ROLES = ['planner', 'advisor', 'scout', 'implementer', 'checker', 'acceptance-auditor', 'reviewer', 'qa-auditor', 'fixer']
const PREFIXES = ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: ROOT, name: role }).instructions + '\n\n' }))

const wire = value => ({ json: JSON.stringify(value) })
const GATE_APPROVE = { verdict: 'approve', issues: [], questions: [] }
const GATE_REVISE = { verdict: 'revise', issues: [{ n: 1, issue: 'name the file', fix: 'list src/a.js', blocking: true }], questions: [] }
const GATE_BLOCKED = { verdict: 'blocked', issues: [], questions: ['Which database holds the records?'] }
const AUDIT_UNPLANNED = { ...devAnswer({ agentType: 'acceptance-auditor' }), behavior_changes_missing: [{ change: 'adds a retry', file: 'src/a.js', line: 3 }] }
const TRIAGE_KEEP = { decisions: [{ n: 1, decision: 'keep', serves: 'goal', reason: 'the goal needs it (src/a.js:3)' }] }
const HAPPY = Object.freeze({
  planner: wire(plan()), advisor: wire(GATE_APPROVE), scout: wire(devAnswer({ agentType: 'scout' })),
  implementer: wire(devAnswer({ agentType: 'implementer' })), checker: wire(pass()),
  'acceptance-auditor': wire(devAnswer({ agentType: 'acceptance-auditor' })), reviewer: wire(review()), 'qa-auditor': wire(review()),
})
const BUILD = ['scout', 'implementer', 'checker', 'acceptance-auditor']
const QA = ['checker', 'reviewer', 'qa-auditor']
const SANDBOX = { checker: 'workspace-write', implementer: 'workspace-write' }
const MODEL = { checker: 'gpt-6-luna', advisor: 'gpt-6-astra' }

// ---------------------------------------------------------------- one case

// One owned directory per case. bin/ is the whole PATH of the CLI and of every leaf: node, git,
// and recording claude and gh stubs. The fake codex lives outside PATH.
function makeCase(replies = HAPPY) {
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, repo: join(dir, 'repo'), fake: join(dir, 'fake'), bin: join(dir, 'bin'), codex: join(dir, 'codex-bin', 'codex'),
    claudeGhCalls: join(dir, 'claude-gh-calls.jsonl') }
  for (const d of [c.repo, c.fake, c.bin, dirname(c.codex)]) mkdirSync(d)
  symlinkSync(process.execPath, join(c.bin, 'node'))
  symlinkSync(REAL_GIT, join(c.bin, 'git'))
  for (const name of ['claude', 'gh']) {
    writeFileSync(join(c.bin, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(c.claudeGhCalls)}, ${JSON.stringify(name)} + '\\n')\n`)
    chmodSync(join(c.bin, name), 0o755)
  }
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  const init = spawnSync('git', ['init', '-q', c.repo], { encoding: 'utf8', env: { PATH: c.bin, HOME: dir } })
  assert.equal(init.status, 0, init.stderr)
  c.state = join(c.repo, '.git', 'harness-dev')
  setReplies(c, replies)
  return c
}
const setReplies = (c, replies) => writeFileSync(join(c.fake, 'script.json'), JSON.stringify({ roles: PREFIXES, replies }))
const leafEnv = c => ({ PATH: c.bin, FAKE_CODEX_DIR: c.fake })
const cliEnv = c => ({ PATH: c.bin, DEV_NATIVE_HOST_ONLY: 'host-marker' })
const NEW = { mode: 'new', task: 'Add a greeting function', approval: 'advisor' }

let argsNo = 0
function argsFile(c, patch = {}, { drop = [] } = {}) {
  const value = { repo: c.repo, mode: 'plan', installationRoot: ROOT, codexBin: c.codex, env: leafEnv(c), timeoutMs: 60000, ...patch }
  for (const key of drop) delete value[key]
  const path = join(c.dir, `args-${++argsNo}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}
function cli(c, file, entry = DEV_NATIVE) {
  return new Promise(done => {
    const child = spawn(process.execPath, [entry, 'run', '--args-file', file], { env: cliEnv(c), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => done({ code, stdout, stderr }))
  })
}
const run = (c, patch, options) => cli(c, argsFile(c, patch, options))
const calls = c => lines(join(c.fake, 'calls.jsonl'))
const order = c => calls(c).map(call => call.role)
const ledgerOf = c => readJson(join(c.state, 'ledger.json'))
const planOf = c => readJson(join(c.state, 'plan.json'))

// Exit 0: one report line of exactly {status, invocationId, stateDir}.
function assertReport(c, r, status) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  const report = JSON.parse(r.stdout)
  assert.equal(r.stdout, JSON.stringify(report) + '\n', 'one line')
  assert.deepEqual(Object.keys(report), ['status', 'invocationId', 'stateDir'])
  assert.equal(report.status, status)
  assert.match(report.invocationId, INVOCATION_ID)
  assert.equal(report.stateDir, c.state)
  assert.equal(ledgerOf(c).status, status, 'the ledger is saved')
  return report
}
// Exit 1-4: empty stdout and one {"error"} line.
function assertError(r, code, error, extra = {}) {
  assert.deepEqual([r.code, r.stdout, r.stderr], [code, '', JSON.stringify({ error, ...extra }) + '\n'])
}
// Every spawn was the fake codex, with the args file's env only, the CP-02c model and CP-02b sandbox,
// and the repository as cwd; the claude and gh stubs never ran.
function assertLeaves(c, roles) {
  const seen = calls(c)
  assert.deepEqual(seen.map(call => call.role), roles, 'spawn order')
  for (const call of seen) {
    assert.equal(call.cwd, c.repo)
    assert.deepEqual(Object.keys(call.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['FAKE_CODEX_DIR', 'PATH'], `${call.role} env`)
    assert.equal(call.env.PATH, c.bin)
    assert.equal(call.sandbox, SANDBOX[call.role] ?? 'read-only', `${call.role} sandbox`)
    assert.equal(call.model, MODEL[call.role] ?? 'gpt-6.1-sol', `${call.role} model`)
    assert.ok(call.argv.includes('--ignore-user-config'))
  }
  assert.equal(existsSync(c.claudeGhCalls), false, 'claude or gh ran')
  return seen
}
const stdinOf = (c, role, n = 0) => {
  const call = calls(c).filter(x => x.role === role)[n]
  return call.stdin.slice(PREFIXES.find(p => p.role === role).prefix.length)
}
const state = c => existsSync(c.state) ? readdirSync(c.state).sort() : null

// =============================================================== a new task, advisor approval

await test('a new task: planner, advisor gate, scout, implementer, checker, acceptance auditor, then nested QA; saved state follows SKILL.md section 2', async () => {
  const c = makeCase()
  mkdirSync(c.state, { recursive: true })
  writeFileSync(join(c.state, 'plan.json'), '{"stale":"an earlier task\'s plan"}')
  const report = assertReport(c, await run(c, NEW), 'done')
  assertLeaves(c, ['planner', 'advisor', ...BUILD, ...QA])

  // The task reaches the planner; the plan reaches the gate and every build leaf.
  assert.ok(stdinOf(c, 'planner').includes('Add a greeting function'))
  assert.ok(stdinOf(c, 'advisor').includes(JSON.stringify(plan(), null, 2)))
  assert.ok(stdinOf(c, 'implementer').includes(`Goal: ${plan().goal}`))

  // Saved state: task.txt, ledger.json, plan.json (replaced: the stale plan is gone), and 0600 files.
  assert.equal(readFileSync(join(c.state, 'task.txt'), 'utf8'), 'Add a greeting function\n')
  const ledger = ledgerOf(c)
  assert.deepEqual([ledger.status, ledger.planApproved, ledger.planRounds, ledger.completed, ledger.qa.status], ['done', true, 1, ['C1'], 'done'])
  assert.deepEqual(planOf(c), { ...plan(), kept_changes: [] })
  assert.deepEqual(readJson(join(c.state, 'plan.json')), ledger.plan)
  for (const name of ['task.txt', 'ledger.json', 'plan.json']) assert.equal(statSync(join(c.state, name)).mode & 0o777, 0o600, name)
  assert.equal(statSync(join(c.state, 'native-runs')).mode & 0o777, 0o700)

  // The host's own record agrees with the saved ledger, and its args file holds the env at 0600.
  const runDir = join(c.state, 'native-runs', report.invocationId)
  const result = readJson(join(runDir, 'result.json'))
  assert.deepEqual([result.workflowId, result.offeringId, result.invocationId, result.status], ['dev-build', 'dev', report.invocationId, 'done'])
  assert.deepEqual(result.result, ledger)
  const hostArgs = join(c.state, 'native-runs', `${report.invocationId}.host-args.json`)
  assert.equal(statSync(hostArgs).mode & 0o777, 0o600)
  assert.deepEqual(readJson(hostArgs), { schemaVersion: 1, installationRoot: ROOT, workflowId: 'dev-build', offeringId: 'dev',
    invocationId: report.invocationId, args: { repo: c.repo, task: 'Add a greeting function', approval: 'advisor', maxFixRounds: 3, knownStuckSigs: [] },
    runDir, codexBin: c.codex, cwd: c.repo, env: leafEnv(c), timeoutMs: 60000, maxConcurrentSubagents: 1 })
  // Nothing the CLI printed or saved carries the CLI's own environment.
  assert.ok(!JSON.stringify(readdirSync(c.state)).includes('host-marker'))
  for (const call of calls(c)) assert.ok(!JSON.stringify(call.env).includes('host-marker'))
})

await test('base, maxFixRounds, knownStuckSigs and requiredCriteria reach the workflow exactly as given', async () => {
  const c = makeCase()
  const requiredCriteria = [{ id: 'AC1', criterion: 'holds' }]
  const report = assertReport(c, await run(c, { ...NEW, base: 'trunk', maxFixRounds: 5, knownStuckSigs: ['sig-1'], requiredCriteria }), 'done')
  assert.deepEqual(readJson(join(c.state, 'native-runs', `${report.invocationId}.host-args.json`)).args,
    { repo: c.repo, task: 'Add a greeting function', base: 'trunk', approval: 'advisor', maxFixRounds: 5, knownStuckSigs: ['sig-1'], requiredCriteria })
  assert.ok(stdinOf(c, 'planner').includes('"criterion": "holds"'), 'the required criteria reach the planner')
  assert.ok(stdinOf(c, 'reviewer').includes('trunk'), 'the nested QA graph got the base')
})

// =============================================================== --review, plan, edit

await test('--review: approval human stops at plan-ready with the plan saved; `plan` builds the saved plan, edited, with no planner or gate call', async () => {
  const c = makeCase()
  const first = assertReport(c, await run(c, { ...NEW, approval: 'human' }), 'plan-ready')
  assertLeaves(c, ['planner', 'advisor'])
  const ledger = ledgerOf(c)
  assert.deepEqual([ledger.planApproved, ledger.planRounds], [false, 1])
  assert.deepEqual(planOf(c), plan(), 'plan.json is the ledger plan (SKILL.md section 3)')
  assert.deepEqual(ledger.plan, plan())

  // The human chose Edit: the saved plan changes, and that is what gets built.
  const edited = { ...plan(), goal: 'EDITED goal: say hello politely' }
  writeFileSync(join(c.state, 'plan.json'), JSON.stringify(edited))
  const second = assertReport(c, await run(c, { mode: 'plan' }), 'done')
  assert.notEqual(second.invocationId, first.invocationId, 'a new invocation')
  assertLeaves(c, ['planner', 'advisor', ...BUILD, ...QA])
  assert.ok(stdinOf(c, 'scout').includes('Goal: EDITED goal: say hello politely\n'))
  assert.deepEqual(readJson(join(c.state, 'native-runs', `${second.invocationId}.host-args.json`)).args,
    { repo: c.repo, plan: edited, planApproved: true, maxFixRounds: 3, knownStuckSigs: [] })
  const after = ledgerOf(c)
  assert.deepEqual([after.planApproved, after.planRounds, after.completed], [true, 0, ['C1']])
  assert.deepEqual(planOf(c), { ...edited, kept_changes: [] }, 'the approved plan is saved for --resume')
})

// =============================================================== the advisor gate

await test('the gate revises: planner and advisor run twice before the build', async () => {
  const c = makeCase({ ...HAPPY, advisor: [wire(GATE_REVISE), wire(GATE_APPROVE)] })
  assertReport(c, await run(c, NEW), 'done')
  assertLeaves(c, ['planner', 'advisor', 'planner', 'advisor', ...BUILD, ...QA])
  assert.equal(ledgerOf(c).planRounds, 2)
  assert.ok(stdinOf(c, 'planner', 1).includes('name the file'), 'the second planner call carries the gate issues')
})

await test('the gate blocks: needs-human with its questions, no build leaf, no resumable plan saved', async () => {
  const c = makeCase({ ...HAPPY, advisor: wire(GATE_BLOCKED) })
  mkdirSync(c.state, { recursive: true })
  writeFileSync(join(c.state, 'plan.json'), '{"stale":true}')
  assertReport(c, await run(c, NEW), 'needs-human')
  assertLeaves(c, ['planner', 'advisor'])
  assert.deepEqual(ledgerOf(c).questions, ['Which database holds the records?'])
  assert.equal(existsSync(join(c.state, 'plan.json')), false, 'a plan that did not pass the gate is never saved as resumable')
  assert.equal(readFileSync(join(c.state, 'task.txt'), 'utf8'), 'Add a greeting function\n')
})

await test('an escalation while planning saves the ledger and no plan', async () => {
  const c = makeCase({ ...HAPPY, planner: { refuse: true } })
  assertReport(c, await run(c, NEW), 'escalate')
  assertLeaves(c, ['planner'])
  assert.equal(existsSync(join(c.state, 'plan.json')), false)
  assert.match(ledgerOf(c).reason, /planner/)
})

// =============================================================== triage

await test('an unplanned change goes to the advisor: keep is recorded in the plan, the QA graph still runs', async () => {
  const c = makeCase({ ...HAPPY, 'acceptance-auditor': wire(AUDIT_UNPLANNED), advisor: [wire(GATE_APPROVE), wire(TRIAGE_KEEP)] })
  // An approved plan to build: the human approved it earlier.
  assertReport(c, await run(c, { ...NEW, approval: 'human' }), 'plan-ready')
  assertReport(c, await run(c, { mode: 'plan' }), 'done')
  assertLeaves(c, ['planner', 'advisor', 'scout', 'implementer', 'checker', 'acceptance-auditor', 'advisor', ...QA])
  const ledger = ledgerOf(c)
  assert.equal(ledger.keptChanges.length, 1)
  assert.equal(ledger.keptChanges[0].change, 'adds a retry')
  assert.deepEqual(planOf(c).kept_changes, ledger.keptChanges, 'the kept change is saved with the plan, so --resume keeps it')
})

// =============================================================== refusal, replay, resume

await test('a provider refusal in the nested QA escalates once, never retried or sent to Claude; the same invocation replays with zero spawns; resume skips built components', async () => {
  const c = makeCase({ ...HAPPY, reviewer: { refuse: true } })
  const first = assertReport(c, await run(c, NEW), 'escalate')
  const refused = ['planner', 'advisor', ...BUILD, 'checker', 'reviewer']
  assertLeaves(c, refused)
  assert.match(ledgerOf(c).reason, /QA graph escalated/)
  assert.deepEqual(ledgerOf(c).completed, ['C1'])
  assert.deepEqual(planOf(c), { ...plan(), kept_changes: [] }, 'an approved plan is saved even when the build escalates')

  // The same invocation again (what a person does after graph-reconcile): finished leaves replay.
  const ledgerBytes = readFileSync(join(c.state, 'ledger.json'))
  const again = assertReport(c, await run(c, { ...NEW, invocationId: first.invocationId }), 'escalate')
  assert.equal(again.invocationId, first.invocationId)
  assertLeaves(c, refused)
  assert.deepEqual(readFileSync(join(c.state, 'ledger.json')), ledgerBytes)

  // The provider answers now. `resume` is a new invocation over the saved plan and ledger: the
  // component that was built is not built again, and the QA graph runs afresh.
  setReplies(c, HAPPY)
  const resumed = assertReport(c, await run(c, { mode: 'resume' }), 'done')
  assert.notEqual(resumed.invocationId, first.invocationId)
  assertLeaves(c, [...refused, 'acceptance-auditor', ...QA])
  assert.deepEqual(readJson(join(c.state, 'native-runs', `${resumed.invocationId}.host-args.json`)).args,
    { repo: c.repo, plan: { ...plan(), kept_changes: [] }, planApproved: true, completed: ['C1'], maxFixRounds: 3, knownStuckSigs: [] })
  assert.deepEqual(ledgerOf(c).completed, ['C1'])
})

await test('a refusal while building escalates with the ledger saved and no further leaf', async () => {
  const c = makeCase({ ...HAPPY, implementer: { refuse: true } })
  assertReport(c, await run(c, NEW), 'escalate')
  assertLeaves(c, ['planner', 'advisor', 'scout', 'implementer'])
  assert.deepEqual(ledgerOf(c).completed, [])
})

await test('plan mode on a malformed saved plan escalates in the workflow with zero spawns', async () => {
  const c = makeCase()
  mkdirSync(c.state, { recursive: true })
  writeFileSync(join(c.state, 'plan.json'), '{}')
  assertReport(c, await run(c, { mode: 'plan' }), 'escalate')
  assertLeaves(c, [])
  assert.match(ledgerOf(c).reason, /args\.plan is malformed/)
  assert.equal(readFileSync(join(c.state, 'plan.json'), 'utf8'), '{}', 'a plan that never ran is left as it was')
})

// =============================================================== refusals before a spawn

await test('bad argv and args files are exit 1 INVALID_ARGS with zero spawns and nothing written', async () => {
  const c = makeCase()
  const good = argsFile(c, NEW)
  const bad = {
    'no keys': () => argsFile(c, {}, { drop: ['repo', 'mode', 'installationRoot', 'codexBin', 'env', 'timeoutMs'] }),
    'extra key': () => argsFile(c, { ...NEW, extra: 1 }),
    'relative repo': () => argsFile(c, { ...NEW, repo: 'repo' }),
    'relative codexBin': () => argsFile(c, { ...NEW, codexBin: 'codex' }),
    'relative installationRoot': () => argsFile(c, { ...NEW, installationRoot: 'root' }),
    'control character in a path': () => argsFile(c, { ...NEW, repo: `${c.repo}\u0001` }),
    'unknown mode': () => argsFile(c, { ...NEW, mode: 'build' }),
    'env value that is not a string': () => argsFile(c, { ...NEW, env: { PATH: 1 } }),
    'env that is an array': () => argsFile(c, { ...NEW, env: ['PATH'] }),
    'timeout below the minimum': () => argsFile(c, { ...NEW, timeoutMs: 1000 }),
    'timeout above the maximum': () => argsFile(c, { ...NEW, timeoutMs: 86400001 }),
    'timeout that is a string': () => argsFile(c, { ...NEW, timeoutMs: '60000' }),
    'new without a task': () => argsFile(c, NEW, { drop: ['task'] }),
    'new without approval': () => argsFile(c, NEW, { drop: ['approval'] }),
    'blank task': () => argsFile(c, { ...NEW, task: '   ' }),
    'task that is not a string': () => argsFile(c, { ...NEW, task: 7 }),
    'approval that is not advisor or human': () => argsFile(c, { ...NEW, approval: 'auto' }),
    'plan mode with a task': () => argsFile(c, { mode: 'plan', task: 'x' }),
    'resume mode with approval': () => argsFile(c, { mode: 'resume', approval: 'advisor' }),
    'maxFixRounds 0': () => argsFile(c, { ...NEW, maxFixRounds: 0 }),
    'maxFixRounds 1.5': () => argsFile(c, { ...NEW, maxFixRounds: 1.5 }),
    'knownStuckSigs with a number': () => argsFile(c, { ...NEW, knownStuckSigs: [1] }),
    'requiredCriteria without a criterion': () => argsFile(c, { ...NEW, requiredCriteria: [{ id: 'AC1' }] }),
    'requiredCriteria that is an object': () => argsFile(c, { ...NEW, requiredCriteria: { id: 'AC1', criterion: 'x' } }),
    'invocationId of another shape': () => argsFile(c, { ...NEW, invocationId: 'qa-20261122T010203Z-0123abcd' }),
    'invocationId with a path in it': () => argsFile(c, { ...NEW, invocationId: '../dev-20261122T010203Z-0123abcd' }),
    'base that is blank': () => argsFile(c, { ...NEW, base: ' ' }),
  }
  const notJson = join(c.dir, 'not-json.json'); writeFileSync(notJson, '{')
  const array = join(c.dir, 'array.json'); writeFileSync(array, '[]')
  const files = [...Object.entries(bad).map(([name, make]) => [name, make()]), ['not json', notJson], ['an array', array],
    ['a missing file', join(c.dir, 'absent.json')]]
  for (const [name, file] of files) {
    const r = await cli(c, file)
    assert.deepEqual([r.code, r.stdout, r.stderr], [1, '', '{"error":"INVALID_ARGS"}\n'], name)
  }
  for (const argv of [[], ['run'], ['run', '--args-file'], ['build', '--args-file', good], ['run', good], ['run', '--args-file', 'relative.json'],
    ['run', '--args-file', good, 'extra'], ['run', '--other', good]]) {
    const r = spawnSync(process.execPath, [DEV_NATIVE, ...argv], { env: cliEnv(c), encoding: 'utf8' })
    assertError({ code: r.status, stdout: r.stdout, stderr: r.stderr }, 1, 'INVALID_ARGS')
  }
  assertLeaves(c, [])
  assert.equal(state(c), null, 'nothing was written')
})

await test('refusals before the host: not a repo (a subdirectory too), no saved plan, no saved ledger, unknown invocation; zero spawns', async () => {
  const c = makeCase()
  mkdirSync(join(c.repo, 'sub'))
  assertError(await run(c, { ...NEW, repo: join(c.repo, 'sub') }), 2, 'NOT_A_REPO')
  const outside = join(c.dir, 'outside'); mkdirSync(outside)
  assertError(await run(c, { ...NEW, repo: outside }), 2, 'NOT_A_REPO')
  assertError(await run(c, { ...NEW, repo: join(c.dir, 'absent') }), 2, 'NOT_A_REPO')
  assertError(await run(c, { mode: 'plan' }), 2, 'NO_SAVED_PLAN')
  assertError(await run(c, { mode: 'resume' }), 2, 'NO_SAVED_PLAN')
  assert.equal(state(c), null, 'nothing is created by a refusal')

  mkdirSync(c.state)
  writeFileSync(join(c.state, 'plan.json'), JSON.stringify(plan()))
  assertError(await run(c, { mode: 'resume' }), 2, 'NO_SAVED_LEDGER')
  writeFileSync(join(c.state, 'ledger.json'), 'not json')
  assertError(await run(c, { mode: 'resume' }), 2, 'NO_SAVED_LEDGER')
  writeFileSync(join(c.state, 'plan.json'), '[]')
  assertError(await run(c, { mode: 'plan' }), 2, 'NO_SAVED_PLAN')
  assertError(await run(c, { ...NEW, invocationId: 'dev-20261122T010203Z-0123abcd' }), 2, 'NOT_FOUND')
  assertLeaves(c, [])
  assert.deepEqual(state(c), ['ledger.json', 'plan.json'], 'refusals created and changed nothing')
})

await test('a host refusal passes through: dev codex unavailable gives OFFERING_UNSUPPORTED (exit 2) with the invocation id, zero spawns, no ledger', async () => {
  const c = makeCase()
  const root = join(c.dir, 'root')
  for (const rel of ['spec', 'core', 'kit', ...readdirSync(join(ROOT, 'graphs')).map(g => `graphs/${g}`)]) {
    const from = join(ROOT, rel)
    if (!existsSync(from)) continue
    // Judge each path relative to the checkout: the checkout itself may sit under any directory.
    cpSync(from, join(root, rel), { recursive: true, filter: source => !/(^|\/)(tests|test-native)(\/|$)/.test(source.slice(ROOT.length)) })
  }
  const catalog = readJson(join(root, CATALOG))
  catalog.offerings.find(o => o.id === 'dev').providers.codex = { implementation: 'unavailable', transportId: null,
    limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  writeFileSync(join(root, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  const r = await run(c, { ...NEW, installationRoot: root })
  assert.equal(r.code, 2)
  assert.equal(r.stdout, '')
  const err = JSON.parse(r.stderr)
  assert.deepEqual(Object.keys(err), ['error', 'invocationId'])
  assert.equal(err.error, 'OFFERING_UNSUPPORTED')
  assert.match(err.invocationId, INVOCATION_ID)
  assertLeaves(c, [])
  assert.equal(existsSync(join(c.state, 'ledger.json')), false)
  assert.equal(existsSync(join(c.state, 'native-runs', err.invocationId)), false, 'the host made no run directory')
})

// =============================================================== no git write

await test('the CLI and the leaves leave HEAD, refs, the index and the work tree alone', async () => {
  const c = makeCase()
  const snapshot = () => spawnSync('git', ['-C', c.repo, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8', env: { PATH: c.bin } }).stdout
  const before = snapshot()
  const refs = () => readdirSync(join(c.repo, '.git', 'refs'), { recursive: true }).sort().join()
  const refsBefore = refs()
  assertReport(c, await run(c, NEW), 'done')
  assert.equal(snapshot(), before)
  assert.equal(refs(), refsBefore)
  assert.equal(existsSync(join(c.repo, '.git', 'index')), false, 'no index was made')
  assert.ok(lstatSync(c.state).isDirectory())
})

// =============================================================== installed through install.sh --codex

await test('through the installed symlink on the production root: install.sh --codex links dev, the whole new-task flow runs, no leaf names a Claude path', async () => {
  const home = realpathSync(mkdtempSync(join(WORK, 'home-')))
  const skills = join(home, '.agents', 'skills')
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, PANDASTACK_CODEX_SKILLS_DIR: skills,
    HARNESS_NO_GIT_CONFIG: '1', TMPDIR: tmpdir() }
  for (const key of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'CODEX_HOME', 'PANDASTACK_CODEX_HOME']) delete env[key]
  const install = spawnSync('bash', [join(ROOT, 'install.sh'), '--codex'], { encoding: 'utf8', env, cwd: WORK })
  assert.equal(install.status, 0, install.stdout + install.stderr)
  const link = join(skills, 'dev')
  assert.equal(lstatSync(link).isSymbolicLink(), true, `dev is installed (the plan reads the production catalog): ${readdirSync(skills)}`)
  assert.equal(realpathSync(link), join(ROOT, 'graphs/dev/skills/dev'))

  const c = makeCase()
  assertReport(c, await cli(c, argsFile(c, NEW), join(link, 'dev-native.mjs')), 'done')
  assertLeaves(c, ['planner', 'advisor', ...BUILD, ...QA])
  // A checkout may itself sit under a .claude directory, so the root is removed first.
  for (const call of calls(c)) {
    const text = call.stdin.split(ROOT).join('<ROOT>')
    for (const needle of ['.claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SKILL_DIR']) assert.ok(!text.includes(needle), `${call.role}: stdin names ${needle}`)
  }
  for (const name of ['.claude', '.codex', '.local']) assert.equal(existsSync(join(home, name)), false, `${name} was not created in HOME`)

  const uninstall = spawnSync('bash', [join(ROOT, 'install.sh'), '--codex', '--uninstall'], { encoding: 'utf8', env, cwd: WORK })
  assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr)
  assert.equal(existsSync(link), false, '--uninstall removed the dev link')
})
