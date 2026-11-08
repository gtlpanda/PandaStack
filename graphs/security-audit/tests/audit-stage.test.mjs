// audit-stage.test.mjs - audit-stage.mjs: the file:line check that gates the facts, plan and apply for recon, and the whole
// path init -> recon (facts, synthesize) -> seed from disk, with the real vendored validator on the ledger it ends in and the
// generated run script loaded and run by the workflow harness against scripted agents.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, load, run } from '../../../scripts/workflow-harness.mjs'
import { FACT_LIMITS, MAX_SCRIPT_BYTES, RECON_IDS, checkFacts, refProblem } from '../skills/security-audit/audit-stage.mjs'
import { writeJson } from '../skills/security-audit/audit-run.mjs'
import { audit, ENV, fresh, init, ledgerCli, listFiles, meta, mkRepo, put } from './audit-fixtures.mjs'
import { planWave } from '../skills/security-audit/audit-ledger.mjs'
import { ledgerValid, readJsonFile, seeded, unitInput } from './ledger-fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const STAGE = join(here, '..', 'skills', 'security-audit', 'audit-stage.mjs')
const stage = (args, cwd = process.cwd()) => {
  const r = spawnSync(process.execPath, [STAGE, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), lines }
}
const FILES = { 'src/app.js': 'export const a = 1\n', 'src/db.js': 'export const q = s => s\n', 'src/lines.js': 'one\ntwo\nthree\nfour\nfive\n', 'src/bare.txt': 'one\ntwo', 'src/empty.txt': '', 'README.md': '# fixture\n' }
const newInit = (args = []) => { const repo = mkRepo(FILES); const r = init([repo, '--full', ...args]); assert.ok(r.ok, r.stdout + r.stderr); return { repo, runDir: r.runDir } }
const RESEARCH = (id, over = {}) => ({ agent: id, items: [{ text: `fact ${id}`, refs: ['src/app.js:1'] }], limits: [`limit ${id}`], ...over })
const UNIT = (name, over = {}) => ({
  canonical_refs: { surface: `src/app.js#${name}`, boundary: 'src/db.js#q', subsystem: 'src', attack_class: 'ATTACK-CLASSES.md#Access control' },
  surface: `Route ${name}`, boundary: 'Query helper', subsystem: 'Source', attack_class: 'Access control', starting_paths: ['src/app.js'],
  ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', selected_companion_blocks: [], excluded_blocks: [], priority_class: 2, priority_why: 'a lower-trust entry', ...over,
})
const SYNTH = (over = {}) => ({ architecture_md: 'The fixture app routes requests to handlers and a tiny data layer.', units: [UNIT('a')], focused_recon: [], ...over })

// Runs the run script `plan` wrote, the way the Workflow tool would, against scripted agents; returns what the workflow returned.
async function runScript(scriptFile, script) {
  const { fn } = load(scriptFile)
  return run(fn, script, undefined)
}
const returnedFile = (dir, result) => { const f = join(dir, 'returned.json'); writeFileSync(f, JSON.stringify(result)); return f }
const files = runDir => listFiles(runDir).filter(f => !f.startsWith('tree/')).sort()
const stageDirs = runDir => (existsSync(join(runDir, 'stages')) ? readdirSync(join(runDir, 'stages')).sort() : [])

console.log('== references: path:line, and only what holds')
const treeDir = fresh('tree')
put(join(treeDir, 'src', 'app.js'), 'export const a = 1\n')
put(join(treeDir, 'src', 'lines.js'), 'one\ntwo\nthree\nfour\nfive\n')
put(join(treeDir, 'src', 'bare.txt'), 'one\ntwo')
put(join(treeDir, 'src', 'empty.txt'), '')
put(join(treeDir, 'src', 'aux.ts'), 'x\n')
put(join(treeDir, 'src', 'crlf.txt'), 'a\r\nb\r\n')
symlinkSync('/etc/hostname', join(treeDir, 'src', 'link'))
spawnSync('mkfifo', [join(treeDir, 'src', 'fifo')])
await test('a reference holds when it is path:line or path:first-last of a regular file in tree/ with that many lines', () => {
  for (const ref of ['src/app.js:1', 'src/lines.js:5', 'src/lines.js:3-5', 'src/lines.js:5-5', 'src/bare.txt:2', 'src/crlf.txt:2', 'src/lines.js:1-1']) assert.equal(refProblem(ref, treeDir), null, ref)
})
await test('a reference does not hold when it is not in the grammar, not a safe path, not a regular file, or past the end', () => {
  const bad = [
    ['src/app.js', /is not path:line or path:first-last/], ['src/app.js:', /is not path:line/], ['src/app.js:0', /is not path:line/], ['src/app.js:01', /is not path:line/], ['src/app.js:-1', /is not path:line/],
    ['src/app.js:1.5', /is not path:line/], ['src/app.js:1-', /is not path:line/], ['src/app.js:1,2', /is not path:line/], ['src/app.js:1-2-3', /is not path:line/], [':5', /is not path:line/], ['src/app.js:1 ', /is not path:line/],
    [' src/app.js:1', /is not a safe repository-relative path/], ['src/app.js:1\n', /is not path:line/], ['src/app.js :1', /is not a safe repository-relative path/],
    ['src/app.js:99999999999999999999', /is not path:line/], ['src/app.js:1:2', /is not path:line/], ['a:b:1', /is not path:line/],
    ['../x:1', /is not a safe repository-relative path/], ['/etc/passwd:1', /is not a safe repository-relative path/], ['src/../src/app.js:1', /is not a safe repository-relative path/], ['src\\app.js:1', /is not a safe repository-relative path/],
    ['c:/x:1', /is not path:line/], ['./src/app.js:1', /is not a safe repository-relative path/], ['src/./app.js:1', /is not a safe repository-relative path/], ['src/app.js/:1', /is not a safe repository-relative path/], ['src/aux.ts:1', /is not a safe repository-relative path/], ['src//app.js:1', /is not a safe repository-relative path/],
    ['src/app.js:2', /has 1 line\(s\); "src\/app\.js:2" reaches line 2/], ['src/lines.js:4-6', /has 5 line\(s\)/], ['src/lines.js:5-3', /runs backwards/], ['src/empty.txt:1', /has 0 line\(s\)/],
    ['src:1', /is a directory, not a file/], ['src/missing.js:1', /is not in tree\/ \(the audited snapshot\)/], ['src/app.js/x:1', /is not in tree/],
    ['src/link:1', /is not a regular file/], ['src/fifo:1', /is not a regular file/],
  ]
  for (const [ref, pattern] of bad) assert.match(String(refProblem(ref, treeDir)), pattern, ref)
  for (const v of [null, undefined, 5, 1.5, true, {}, [], ['src/app.js:1'], { toString: () => 'src/app.js:1' }, Symbol.iterator]) assert.match(String(refProblem(v, treeDir)), /a reference must be a string/, String(v))
})
await test('the line count is of a file, once, with its own limit: a missing tree is an error not a pass, and a file over the limit is not counted', () => {
  assert.match(refProblem('src/app.js:1', join(treeDir, 'nowhere')), /is not in tree\//)
  const cache = new Map()
  assert.equal(refProblem('src/lines.js:5', treeDir, cache), null)
  assert.equal(cache.size, 1)
  assert.match(refProblem('src/lines.js:6', treeDir, cache), /has 5 line\(s\)/)
  assert.equal(cache.size, 1, 'the second reference to a file reads nothing')
})

console.log('== facts: an item stays only when every reference holds')
const factsOf = (over = {}) => RECON_IDS.map(id => RESEARCH(id, over[id] ?? {}))
await test('checkFacts keeps items whose references all hold and drops, with a logged reason, any item that has none, a bad one, no text, or is not an item', () => {
  const items = [
    { text: 'good', refs: ['src/app.js:1', 'src/lines.js:2-3'] },
    { text: 'one bad of two', refs: ['src/app.js:1', 'src/app.js:9'] },
    { text: 'no refs', refs: [] },
    { text: '   ', refs: ['src/app.js:1'] },
    { text: 'not a ref', refs: [5] },
    { text: 'x'.repeat(FACT_LIMITS.itemChars + 1), refs: ['src/app.js:1'] },
    { text: 'too many refs', refs: Array.from({ length: FACT_LIMITS.refs + 1 }, () => 'src/app.js:1') },
    null, 5, 'prose', [], { text: 5, refs: ['src/app.js:1'] }, { text: 'no refs field' }, { text: 't', refs: 'src/app.js:1' },
    { text: 'just at the limit', refs: ['src/app.js:1'] },
  ]
  const { facts, dropped } = checkFacts(treeDir, factsOf({ '1b': { items } }))
  assert.deepEqual(facts[1].items.map(i => i.text), ['good', 'just at the limit'])
  assert.deepEqual(facts.map(f => f.items.length), [1, 2, 1, 1])
  assert.equal(dropped.length, items.length - 2)
  for (const d of dropped) { assert.equal(d.agent, '1b'); assert.equal(d.kind, 'item'); assert.ok(d.reason.length > 0); assert.ok(d.text.length <= 200) }
  assert.match(dropped[0].reason, /^has a reference that does not hold: src\/app\.js has 1 line\(s\)/)
  assert.deepEqual(dropped.map(d => d.reason).slice(1, 6).map(r => r.split(' ').slice(0, 3).join(' ')), ['has no file:line', 'has no text', 'has a reference', 'is over 2000', 'has more than'])
})
await test('items are capped per researcher, limits are checked and capped, and the cap drops, never truncates', () => {
  const many = Array.from({ length: FACT_LIMITS.items + 5 }, (_, i) => ({ text: `fact ${i}`, refs: ['src/app.js:1'] }))
  const limits = ['fine', '', '   ', 7, null, 'y'.repeat(FACT_LIMITS.limitChars + 1), ...Array.from({ length: FACT_LIMITS.limits + 2 }, (_, i) => `limit ${i}`)]
  const { facts, dropped } = checkFacts(treeDir, factsOf({ '1c': { items: many, limits } }))
  assert.equal(facts[2].items.length, FACT_LIMITS.items)
  assert.equal(facts[2].items.at(-1).text, `fact ${FACT_LIMITS.items - 1}`, 'the first ones are kept, whole')
  assert.equal(dropped.filter(d => d.kind === 'item').length, 5)
  assert.equal(facts[2].limits.length, FACT_LIMITS.limits)
  assert.deepEqual(facts[2].limits.slice(0, 2), ['fine', 'limit 0'])
  assert.equal(dropped.filter(d => d.kind === 'limit').length, 5 + 3, 'the empty, blank, two non-strings and the oversized one, and the three past the cap ("fine" took one of the 50 places)')
})
await test('a result whose facts are not one entry per researcher, in order, is refused outright, not repaired', () => {
  for (const bad of [null, 'x', {}, [], factsOf().slice(0, 3), [...factsOf(), RESEARCH('1e')], [...factsOf()].reverse(), factsOf().map(f => ({ ...f, agent: '1a' })), [null, null, null, null], factsOf().map(f => ({ ...f, items: 'x' })), factsOf().map(f => ({ ...f, limits: null }))]) {
    assert.throws(() => checkFacts(treeDir, bad), /results\.facts/, JSON.stringify(bad)?.slice(0, 60))
  }
})

console.log('== plan and apply: init -> recon -> seed, from disk')
await test('the whole path: plan, run the generated script, apply, plan, run, apply, then seed; every ledger it makes passes the vendored validator, and `next` is right at each step', async () => {
  const { runDir } = newInit()
  assert.equal(audit(['next', runDir]).last, 'NEXT: recon run=workflow')
  // facts
  const p1 = stage(['plan', runDir])
  assert.equal(p1.status, 0, p1.stdout)
  const dir1 = join(runDir, 'stages', '01-recon-facts')
  assert.match(p1.last, new RegExp(`^AUDIT: OK plan recon part=facts script=${dir1}/run\\.js bytes=\\d+ returned=${dir1}/returned\\.json$`))
  assert.deepEqual(readdirSync(dir1).sort(), ['input.json', 'run.js'])
  const script1 = readFileSync(join(dir1, 'run.js'), 'utf8')
  assert.equal(script1.split('\n').filter(l => l.startsWith('const INJECTED_INPUT = JSON.parse(')).length, 1)
  assert.ok(statSync(join(dir1, 'run.js')).size < 60_000, `the facts script is small (${statSync(join(dir1, 'run.js')).size} bytes)`)
  const input1 = readJsonFile(dir1, 'input.json')
  assert.deepEqual([input1.stage, input1.part, input1.tree, input1.maxParallel], ['recon', 'facts', join(runDir, 'tree'), 8])
  const ran1 = await runScript(join(dir1, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  assert.deepEqual([ran1.result.status, ran1.result.budgetSpent], ['done', 4])
  const a1 = stage(['apply', runDir, returnedFile(dir1, ran1.result)])
  assert.equal(a1.status, 0, a1.stdout)
  assert.equal(a1.last, 'AUDIT: OK apply recon part=facts kept=4 dropped=0 agents=4')
  assert.match(a1.stdout, new RegExp(`^then: node audit-stage\\.mjs plan ${runDir}$`, 'm'))
  assert.deepEqual(readdirSync(dir1).sort(), ['input.json', 'result.json', 'returned.json', 'run.js'])
  assert.equal(readJsonFile(runDir, 'recon-facts.json').facts.length, 4)
  assert.deepEqual([meta(runDir).agents_spent, meta(runDir).stage_spend], [4, { '01-recon-facts': 4 }])
  assert.equal(audit(['next', runDir]).last, 'NEXT: recon run=workflow', 'recon is one step: it is saved only when the synthesizer\'s result is')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  // synthesize
  const p2 = stage(['plan', runDir])
  assert.equal(p2.status, 0, p2.stdout)
  const dir2 = join(runDir, 'stages', '02-recon-synthesize')
  assert.match(p2.last, /^AUDIT: OK plan recon part=synthesize /)
  const input2 = readJsonFile(dir2, 'input.json')
  assert.deepEqual(input2.facts, readJsonFile(runDir, 'recon-facts.json').facts, 'the synthesizer is given the checked facts')
  assert.deepEqual([input2.profile, input2.scope_paths, input2.prior], ['standard', [], { found: 0, compatible: 0, incompatible: [] }])
  const ran2 = await runScript(join(dir2, 'run.js'), { 'audit-synthesizer': [SYNTH({ units: [UNIT('a'), UNIT('b', { ordinary_attack_class_block: '' })] })] })
  assert.deepEqual([ran2.result.status, ran2.result.budgetSpent], ['done', 1])
  const a2 = stage(['apply', runDir, returnedFile(dir2, ran2.result)])
  assert.equal(a2.status, 0, a2.stdout)
  assert.equal(a2.last, 'AUDIT: OK apply recon part=synthesize units=2 focused_recon=0 agents=1')
  assert.match(a2.stdout, new RegExp(`^then: node audit-ledger\\.mjs seed ${runDir} ${runDir}/recon\\.json$`, 'm'))
  const recon = readJsonFile(runDir, 'recon.json')
  assert.deepEqual(recon.units.map(u => u.ordinary_attack_class_block), ['ATTACK-CLASSES.md#Access control', null], 'the schema\'s empty string is written as null')
  assert.deepEqual([meta(runDir).agents_spent, Object.keys(meta(runDir).stage_spend)], [5, ['01-recon-facts', '02-recon-synthesize']])
  assert.equal(audit(['next', runDir]).last, 'NEXT: seed run=helper')
  // seed, the way the session runs it
  const seed = ledgerCli(['seed', runDir, join(runDir, 'recon.json')])
  assert.equal(seed.status, 0, seed.stdout)
  assert.match(seed.last, /^AUDIT: OK seed units=2 planned=2$/)
  assert.ok(ledgerValid(runDir), 'upstream\'s validator passes the ledger')
  assert.equal(readFileSync(join(runDir, 'architecture.md'), 'utf8'), `${recon.architecture_md}\n`)
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=1')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(events.map(e => `${e.cmd}:${e.result}`), ['init:ok', 'plan:ok', 'apply:ok', 'plan:ok', 'apply:ok', 'seed:ok'])
})
await test('the generated script is the workflow with one line changed, and the seam is the only difference', () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const original = readFileSync(join(here, '..', 'workflows', 'security-audit-flow.js'), 'utf8').split('\n')
  const generated = readFileSync(join(runDir, 'stages', '01-recon-facts', 'run.js'), 'utf8').split('\n')
  assert.equal(generated.length, original.length)
  assert.deepEqual(generated.map((l, i) => (l === original[i] ? null : i)).filter(i => i !== null), [original.indexOf('const INJECTED_INPUT = null')])
})
await test('planning twice with nothing applied reuses the stage directory; after an apply the next stage gets the next number', () => {
  const { runDir } = newInit()
  stage(['plan', runDir]); stage(['plan', runDir])
  assert.deepEqual(stageDirs(runDir), ['01-recon-facts'])
  writeJson(join(runDir, 'stages', '01-recon-facts', 'result.json'), {})
  stage(['plan', runDir])
  assert.deepEqual(stageDirs(runDir), ['01-recon-facts', '02-recon-facts'], 'a stage with a result is done: a new plan is a retry, with its own number')
})
await test('facts that do not hold are dropped before the synthesizer sees them, logged in recon-facts.json and named in the output', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir = join(runDir, 'stages', '01-recon-facts')
  const bad = RESEARCH('1b', { items: [{ text: 'real', refs: ['src/lines.js:2-4'] }, { text: 'invented line', refs: ['src/app.js:40'] }, { text: 'invented file', refs: ['src/ghost.js:1'] }, { text: 'a path outside', refs: ['../../etc/passwd:1'] }, { text: 'no refs', refs: [] }] })
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => (id === '1b' ? bad : RESEARCH(id))) })
  const a = stage(['apply', runDir, returnedFile(dir, ran.result)])
  assert.equal(a.status, 0, a.stdout)
  assert.equal(a.last, 'AUDIT: OK apply recon part=facts kept=4 dropped=4 agents=4')
  assert.match(a.stdout, /^note: recon-1b: dropped 4 \(4 item\(s\), 0 limit\(s\)\), first: has a reference that does not hold: src\/app\.js has 1 line\(s\)/m)
  const file = readJsonFile(runDir, 'recon-facts.json')
  assert.equal(file.dropped_total, 4)
  assert.deepEqual(file.dropped.map(d => d.agent), ['1b', '1b', '1b', '1b'])
  assert.deepEqual(file.facts[1].items.map(i => i.text), ['real'])
  stage(['plan', runDir])
  const synthInput = readJsonFile(join(runDir, 'stages', '02-recon-synthesize'), 'input.json')
  assert.ok(!JSON.stringify(synthInput.facts).includes('invented'), 'a dropped fact never reaches the synthesizer')
})
await test('when not one fact holds, apply refuses, still records what the agents cost, writes no facts file, and the stage can be planned again', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir = join(runDir, 'stages', '01-recon-facts')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id, { items: [{ text: 'invented', refs: ['src/ghost.js:1'] }] })) })
  const a = stage(['apply', runDir, returnedFile(dir, ran.result)])
  assert.equal(a.status, 1)
  assert.match(a.last, /^AUDIT: FAIL not one fact the researchers returned holds \(4 dropped\); recon-facts\.json is not written/)
  assert.ok(!existsSync(join(runDir, 'recon-facts.json')))
  assert.equal(meta(runDir).agents_spent, 4)
  assert.ok(existsSync(join(dir, 'result.json')))
  assert.equal(audit(['next', runDir]).last, 'NEXT: recon run=workflow')
  assert.match(stage(['plan', runDir]).last, /^AUDIT: OK plan recon part=facts script=.*\/02-recon-facts\/run\.js/)
})
await test('an escalated stage records its cost, refuses with the reason, changes no state, and a retry adds to the spend', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir = join(runDir, 'stages', '01-recon-facts')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': [RESEARCH('1a'), null, RESEARCH('1c'), RESEARCH('1d')] })
  assert.equal(ran.result.status, 'escalate')
  const before = readFileSync(join(runDir, 'stage-state.json'), 'utf8')
  const a = stage(['apply', runDir, returnedFile(dir, ran.result)])
  assert.equal(a.status, 1)
  assert.equal(a.last, 'AUDIT: FAIL recon facts escalated: audit-researcher returned no result recon-1b (skipped, or failed after retries) (4 agent(s) spent; plan the stage again to retry it)')
  assert.equal(readFileSync(join(runDir, 'stage-state.json'), 'utf8'), before)
  assert.ok(!existsSync(join(runDir, 'recon-facts.json')))
  assert.equal(meta(runDir).agents_spent, 4)
  stage(['plan', runDir])
  const dir2 = join(runDir, 'stages', '02-recon-facts')
  const ran2 = await runScript(join(dir2, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  assert.equal(stage(['apply', runDir, returnedFile(dir2, ran2.result)]).status, 0)
  assert.deepEqual([meta(runDir).agents_spent, meta(runDir).stage_spend], [8, { '01-recon-facts': 4, '02-recon-facts': 4 }])
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(events.map(e => `${e.cmd}:${e.result}`), ['init:ok', 'plan:ok', 'apply:escalated', 'plan:ok', 'apply:ok'])
  assert.match(events[2].reason, /returned no result recon-1b/)
})
await test('applying the same result twice (a crash before the step was saved) changes nothing the second time', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir = join(runDir, 'stages', '01-recon-facts')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  const file = returnedFile(dir, ran.result)
  assert.equal(stage(['apply', runDir, file]).status, 0)
  assert.match(stage(['apply', runDir, file]).last, /^AUDIT: FAIL no stage is planned/)
  assert.equal(meta(runDir).agents_spent, 4)
  // the crash itself: the effects landed, result.json did not
  const { runDir: r2 } = newInit()
  stage(['plan', r2])
  const d2 = join(r2, 'stages', '01-recon-facts')
  const ran2 = await runScript(join(d2, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  const f2 = returnedFile(d2, ran2.result)
  stage(['apply', r2, f2])
  const snapshot = files(r2)
  assert.ok(existsSync(join(d2, 'result.json')))
  rmSync(join(d2, 'result.json'))
  assert.equal(stage(['apply', r2, f2]).status, 0, 'the same stage applied again, its result.json missing')
  assert.equal(meta(r2).agents_spent, 4, 'the cost is recorded under the stage\'s key, not added again')
  assert.deepEqual(files(r2), snapshot)
})

console.log('== plan and apply refuse what they must, and change nothing')
await test('plan and apply run only when `next` names recon: not after seed, not for a run that cannot be funded, not before init has a run', () => {
  const { runDir } = newInit()
  writeJson(join(runDir, 'stage-state.json'), { version: 1, last: 'recon', wave: 0, critic_kind: null, updated: 'x' })
  for (const cmd of [['plan', runDir], ['apply', runDir, join(runDir, 'nope.json')]]) {
    const r = stage(cmd)
    assert.equal(r.status, 1)
    assert.match(r.last, /^AUDIT: FAIL the next step is not a Workflow stage: NEXT: seed run=helper/)
  }
  const repo = mkRepo(FILES)
  assert.equal(init([repo, '--full', '--budget', '3']).status, 1)
  const refused = join(repo, '.git', 'security-audit', 'run-1')
  assert.match(stage(['plan', refused]).last, /^AUDIT: FAIL the next step is not a Workflow stage: NEXT: report run=helper reason=budget_cannot_fund_reconnaissance_and_reserves/)
  const empty = fresh('not-a-run')
  assert.match(stage(['plan', empty]).last, /^AUDIT: FAIL .* has no run-metadata\.json: it is not a run directory/)
  assert.match(stage(['apply', empty, 'x.json']).last, /^AUDIT: FAIL .* has no run-metadata\.json/)
})
await test('a later stage is named as not built yet, so a session cannot plan a hunt this version cannot run', () => {
  const { runDir } = seeded([unitInput('a')])
  planWave(runDir)
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1')
  const r = stage(['plan', runDir])
  assert.equal(r.status, 1)
  assert.equal(r.last, 'AUDIT: FAIL stage hunt is not built in this version of audit-stage.mjs (it plans recon only): NEXT: hunt run=workflow wave=1')
  assert.match(stage(['apply', runDir, 'x.json']).last, /^AUDIT: FAIL stage hunt is not built in this version/)
  assert.ok(!existsSync(join(runDir, 'stages')))
})
await test('apply with nothing planned, with a missing file, a torn file, or a value that is not the workflow\'s result, refuses and writes nothing', async () => {
  const { runDir } = newInit()
  const none = files(runDir)
  assert.match(stage(['apply', runDir, join(runDir, 'r.json')]).last, /^AUDIT: FAIL no stage is planned/)
  stage(['plan', runDir])
  const dir = join(runDir, 'stages', '01-recon-facts')
  const planned = files(runDir)
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  const good = ran.result
  assert.match(stage(['apply', runDir, join(dir, 'missing.json')]).last, /^AUDIT: FAIL .*missing\.json does not exist/)
  writeFileSync(join(dir, 'torn.json'), JSON.stringify(good).slice(0, 40))
  assert.match(stage(['apply', runDir, join(dir, 'torn.json')]).last, /^AUDIT: FAIL .*torn\.json is not valid JSON/)
  const cases = [
    [[], /the result is not a JSON object/], ['prose', /the result is not a JSON object/], [null, /the result is not a JSON object/], [7, /the result is not a JSON object/],
    [{ ...good, status: 'ok' }, /status is "ok"/], [{ ...good, status: undefined }, /status is undefined, not done or escalate/], [{ ...good, reason: 5 }, /reason is not a string/],
    [{ ...good, stage: 'hunt' }, /stage is "hunt", but the stage planned is recon/], [{ ...good, history: {} }, /history is not an array/],
    [{ ...good, budgetSpent: -1 }, /budgetSpent is -1/], [{ ...good, budgetSpent: '4' }, /budgetSpent is "4"/], [{ ...good, budgetSpent: 1001 }, /budgetSpent is 1001/], [{ ...good, budgetSpent: 1.5 }, /budgetSpent is 1\.5/], [{ ...good, budgetSpent: null }, /budgetSpent is null/],
    [{ ...good, results: null }, /a done result must carry results for part facts/], [{ ...good, results: { ...good.results, part: 'synthesize' } }, /results for part facts/], [{ ...good, results: [] }, /results for part facts/],
  ]
  for (const [bad, pattern] of cases) {
    const r = stage(['apply', runDir, returnedFile(dir, bad)])
    assert.equal(r.status, 1, JSON.stringify(bad)?.slice(0, 60))
    assert.match(r.last, pattern, JSON.stringify(bad)?.slice(0, 60))
    assert.match(r.last, /^AUDIT: FAIL the result is not the workflow's: /)
  }
  const malformedFacts = [{ ...good, results: { part: 'facts', facts: 'x' } }, { ...good, results: { part: 'facts', facts: good.results.facts.slice(0, 3) } }, { ...good, results: { part: 'facts' } }]
  for (const bad of malformedFacts) assert.match(stage(['apply', runDir, returnedFile(dir, bad)]).last, /^AUDIT: FAIL results\.facts must be one entry per researcher/)
  assert.equal(meta(runDir).agents_spent, 0, 'a refused result costs nothing on record: its count is not trusted')
  assert.deepEqual(files(runDir).filter(f => !['stages/01-recon-facts/returned.json', 'stages/01-recon-facts/torn.json'].includes(f)), planned)
  assert.notDeepEqual(planned, none)
})
await test('a result for the other part, and a hand-edited result of the synthesize part, are refused, and the facts part never moves the step', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir1 = join(runDir, 'stages', '01-recon-facts')
  const ran1 = await runScript(join(dir1, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  stage(['apply', runDir, returnedFile(dir1, ran1.result)])
  stage(['plan', runDir])
  const dir2 = join(runDir, 'stages', '02-recon-synthesize')
  assert.match(stage(['apply', runDir, returnedFile(dir2, ran1.result)]).last, /results for part synthesize/)
  const ran2 = await runScript(join(dir2, 'run.js'), { 'audit-synthesizer': [SYNTH()] })
  const good = ran2.result
  const before = files(runDir)
  const spent = meta(runDir).agents_spent
  for (const [bad, pattern] of [
    [{ ...good, results: { ...good.results, architecture_md: '  ' } }, /needs architecture_md text/], [{ ...good, results: { ...good.results, units: [] } }, /non-empty list of unit objects/],
    [{ ...good, results: { ...good.results, units: [null] } }, /non-empty list of unit objects/], [{ ...good, results: { ...good.results, units: 'x' } }, /non-empty list of unit objects/],
    [{ ...good, results: { ...good.results, focused_recon: null } }, /focused_recon list/], [{ ...good, results: { part: 'synthesize' } }, /needs architecture_md text/],
  ]) {
    const r = stage(['apply', runDir, returnedFile(dir2, bad)])
    assert.equal(r.status, 1)
    assert.match(r.last, pattern)
  }
  assert.deepEqual(files(runDir).filter(f => f !== 'stages/02-recon-synthesize/returned.json'), before.filter(f => f !== 'stages/02-recon-synthesize/returned.json'))
  assert.equal(meta(runDir).agents_spent, spent)
  assert.equal(audit(['next', runDir]).last, 'NEXT: recon run=workflow')
})
await test('a recon-facts.json that is not what apply wrote, or that makes the script too big for the Workflow tool, stops the plan with the reason and leaves no script', () => {
  const { runDir } = newInit()
  for (const bad of ['[]', '{}', '{"facts":[]}', '{"facts":"x"}', JSON.stringify({ facts: RECON_IDS.map(id => ({ agent: id, items: 'x', limits: [] })) }), JSON.stringify({ facts: [...RECON_IDS].reverse().map(id => RESEARCH(id)) })]) {
    writeFileSync(join(runDir, 'recon-facts.json'), bad)
    const r = stage(['plan', runDir])
    assert.equal(r.status, 1, bad)
    assert.match(r.last, /^AUDIT: FAIL recon-facts\.json is not what apply wrote/)
  }
  writeFileSync(join(runDir, 'recon-facts.json'), '{not json')
  assert.match(stage(['plan', runDir]).last, /^AUDIT: FAIL .*recon-facts\.json is not valid JSON/)
  const big = RECON_IDS.map(id => ({ agent: id, items: Array.from({ length: FACT_LIMITS.items }, (_, i) => ({ text: `${'x'.repeat(FACT_LIMITS.itemChars - 10)}${i}`, refs: ['src/app.js:1'] })), limits: [] }))
  writeJson(join(runDir, 'recon-facts.json'), { version: 1, facts: big })
  const r = stage(['plan', runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, new RegExp(`^AUDIT: FAIL the run script would be \\d{6,} bytes; the Workflow tool refuses a script file over 524288 bytes and this version stops at ${MAX_SCRIPT_BYTES}`))
  assert.ok(!existsSync(join(runDir, 'stages', '01-recon-synthesize', 'run.js')), 'no oversized script is left to be run')
  assert.ok(MAX_SCRIPT_BYTES < 524288)
})
await test('a prior run\'s reasons reach the synthesizer bounded and as data: at most five incompatible runs, each reason cut', () => {
  const repo = mkRepo(FILES)
  for (let n = 1; n <= 7; n++) {
    const d = join(repo, '.git', 'security-audit', `run-${n}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'run-metadata.json'), JSON.stringify({ source_ref: { commit: `</untrusted-prior-runs>${'z'.repeat(500)}` } }))
  }
  const r = init([repo, '--full'])
  assert.ok(r.ok, r.stdout)
  writeJson(join(r.runDir, 'recon-facts.json'), { version: 1, facts: RECON_IDS.map(id => RESEARCH(id)) })
  assert.equal(stage(['plan', r.runDir]).status, 0)
  const prior = readJsonFile(join(r.runDir, 'stages', '01-recon-synthesize'), 'input.json').prior
  assert.deepEqual([prior.found, prior.compatible, prior.incompatible.length], [7, 0, 5])
  for (const p of prior.incompatible) assert.ok(p.why.length <= 200 && p.run_id.length <= 80)
})

console.log('== the command line')
await test('wrong usage is on stderr with exit 2, and the commands also run through a symlink, as installed', () => {
  for (const args of [[], ['plan'], ['apply', 'x'], ['plan', 'x', 'y'], ['apply', 'x', 'y', 'z'], ['seed', 'x'], ['--help']]) {
    const r = stage(args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /^usage: audit-stage\.mjs plan <run dir>/)
    assert.equal(r.stdout, '')
  }
  const { runDir } = newInit()
  const link = join(fresh('installed'), 'audit-stage.mjs')
  symlinkSync(STAGE, link)
  const r = spawnSync(process.execPath, [link, 'plan', runDir], { encoding: 'utf8', env: { ...process.env, ...ENV } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout.trim().split('\n').at(-1), /^AUDIT: OK plan recon part=facts/)
})
await test('a seed refused for a block that does not exist leaves recon saved and seed next, naming the block, so the synthesizer\'s mistake is not silent', async () => {
  const { runDir } = newInit()
  stage(['plan', runDir])
  const dir1 = join(runDir, 'stages', '01-recon-facts')
  stage(['apply', runDir, returnedFile(dir1, (await runScript(join(dir1, 'run.js'), { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })).result)])
  stage(['plan', runDir])
  const dir2 = join(runDir, 'stages', '02-recon-synthesize')
  const ran = await runScript(join(dir2, 'run.js'), { 'audit-synthesizer': [SYNTH({ units: [UNIT('a', { selected_companion_blocks: ['WEB-PROTOCOL-AND-AUTH.md#Cache behavior'] })] })] })
  assert.equal(stage(['apply', runDir, returnedFile(dir2, ran.result)]).status, 0, 'apply does not judge units: seed does')
  const seed = ledgerCli(['seed', runDir, join(runDir, 'recon.json')])
  assert.equal(seed.status, 1)
  assert.ok(seed.lines.some(l => /^ledger: unit 0 .*selected_companion_blocks\[0\]: unknown block WEB-PROTOCOL-AND-AUTH\.md#Cache behavior/.test(l)), seed.stdout)
  assert.ok(!existsSync(join(runDir, 'coverage-ledger.json')))
  assert.equal(audit(['next', runDir]).last, 'NEXT: seed run=helper')
})
