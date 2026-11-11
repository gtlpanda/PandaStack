// EXTERNAL / UNSELECTED / UNFROZEN / NOT EXECUTED.
// Proposed acceptance/security-audit/sa-ar01-application-recovery.test.mjs.
// Only one-shot synchronous fixture-owned I/O; no actual hunt restart or blocked reproduction.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applicationFixture, oneShotIO } from './sa-ar01-fixtures.mjs'
const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const stage = await import(pathToFileURL(resolve(ROOT, 'graphs/security-audit/skills/security-audit/audit-stage.mjs')))
const auditRun = await import(pathToFileURL(resolve(ROOT, 'graphs/security-audit/skills/security-audit/audit-run.mjs')))
const classify = value => {
  assert.equal(typeof stage.completedStageRejection, 'function', 'stage-owned completed rejection classifier required')
  return stage.completedStageRejection(value)
}
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const caught = async work => { try { await work() } catch (error) { return error } assert.fail('expected owning refusal') }
const fixture = async (t, existingRunDir) => { const f = await applicationFixture(ROOT, existingRunDir); t.after(() => f.close()); return f }
const eio = () => Object.assign(new Error('ordinary fixture I/O failure'), { code: 'EIO' })
function assertRejectedReceipt(f, planned) {
  const receipt = json(join(planned.stage.dir, 'native-application.json'))
  assert.equal(receipt.outcome, 'rejected')
  assert.equal(receipt.invocation_id, planned.invocationId)
  assert.equal(f.stage.pendingNativeApplication(f.runDir), null)
}
async function assertRecovered(f, files, calls, rows) {
  f.forbidCallbacks()
  const recovered = await f.execute()
  assert.equal(recovered.recoveredApplication, true)
  assert.equal(recovered.stageName, files.planned.stage.name)
  assert.equal(recovered.invocationId, files.planned.invocationId)
  assert.deepEqual(f.calls, calls)
  assert.deepEqual(f.rows(), rows)
  assert.equal(f.run.loadRun(f.runDir).state.last, 'recon')
  assert.equal(f.run.loadRun(f.runDir).meta.agents_spent, 5)
  assert.equal(f.fixtures.stageDirs(f.runDir).length, 2)
  assert.equal(json(files.receiptFile).outcome, 'applied')
  assert.equal(f.stage.pendingNativeApplication(f.runDir), null)
  assert.equal(f.report.readPartialReport(f.runDir).status, 'current')
  assert.deepEqual(readFileSync(join(f.runDir, 'recon-facts.json')), files.facts)
}

await test('SA-AR01 completed rejection authority is an owning identity, never Refusal spelling or object hooks', () => {
  let ordinary
  try { auditRun.refuse('ordinary read-shaped refusal') } catch (error) { ordinary = error }
  let touched = 0
  const hooked = { get constructor() { touched++; throw new Error('not a classification input') },
    get code() { touched++; return 'SEMANTIC_REJECTION' } }
  const proxy = new Proxy({}, { get() { touched++; throw new Error('not a classification input') },
    getPrototypeOf() { touched++; throw new Error('not a classification input') } })
  for (const value of [null, undefined, 1, 'Refusal', new Error('Refusal'), ordinary,
    { constructor: { name: 'Refusal' } }, { code: 'SEMANTIC_REJECTION', completed: true }, hooked, proxy])
    assert.equal(classify(value), null)
  assert.equal(touched, 0)
})

for (const method of ['readFileSync', 'writeFileSync']) await test(`SA-AR01 one ordinary ${method} failure after saved valid result replays without another callback`, async t => {
  const f = await fixture(t), files = await f.synthesis(), injected = eio()
  const error = await oneShotIO({ method, file: files.stateFile + (method === 'writeFileSync' ? '.tmp' : ''),
    afterFile: files.resultFile, thrown: injected }, f.execute)
  if (method === 'readFileSync') assert.match(error.message, /stage-state\.json: EIO/)
  else assert.equal(error, injected)
  assert.equal(classify(error), null)
  assert.equal(json(files.resultFile).status, 'done')
  assert.equal(existsSync(files.receiptFile), false, 'operational failure must not produce terminal rejected receipt')
  assert.equal(f.run.loadRun(f.runDir).state.last, 'init')
  assert.equal(f.calls.length, 5)
  const pending = f.stage.pendingNativeApplication(f.runDir)
  assert.equal(pending.invocationId, files.planned.invocationId)
  assert.equal(pending.stage.name, files.planned.stage.name)
  await assertRecovered(f, files, [...f.calls], f.rows())
})

await test('SA-AR01 completed invalid synthesis retains existing bounded feedback and permits only the next legal attempt', async t => {
  const f = await fixture(t), files = await f.synthesis()
  f.setAnswer(() => f.fixtures.SYNTH({ units: [f.fixtures.UNIT('good'), f.fixtures.UNIT('bad', { starting_paths: ['src/absent.js'] })] }))
  const error = await caught(f.execute)
  assert.equal(classify(error), 'semantic')
  assert.equal(error.constructor.name, 'Refusal', 'existing CLI refusal class is retained')
  assert.match(error.message, /would not seed/)
  assertRejectedReceipt(f, files.planned)
  const feedback = json(join(f.runDir, 'seed-feedback.json'))
  assert.equal(feedback.attempts.length, 1)
  assert.equal(feedback.attempts[0].stage, files.planned.stage.name)
  const saved = json(files.resultFile)
  assert.equal(saved.status, 'done')
  assert.equal(saved.results.units.length, 2, 'retain the whole returned evidence, not a dropped sibling')
  assert.equal(f.run.loadRun(f.runDir).meta.agents_spent, 5)
  assert.deepEqual(readFileSync(join(f.runDir, 'recon-facts.json')), files.facts)
  const originalRows = f.rows()
  f.setAnswer(() => f.fixtures.SYNTH())
  const next = await f.execute()
  assert.notEqual(next.stageName, files.planned.stage.name)
  assert.equal(f.calls.length, 6)
  assert.equal(f.run.loadRun(f.runDir).meta.agents_spent, 6)
  assert.equal(f.run.loadRun(f.runDir).state.last, 'recon')
  assert.deepEqual(f.rows().slice(0, originalRows.length), originalRows)
  assert.equal(json(files.receiptFile).outcome, 'rejected')
})

await test('SA-AR01 zero retained facts remains a genuine completed semantic rejection', async t => {
  const f = await fixture(t)
  f.setAnswer(req => f.fixtures.RESEARCH(req.label.slice(6), { items: [] }))
  const planned = f.stage.planNativeStage(f.runDir)
  const error = await caught(f.execute)
  assert.equal(classify(error), 'semantic')
  assert.match(error.message, /not one fact/)
  assertRejectedReceipt(f, planned)
  assert.equal(f.calls.length, 4)
  assert.equal(f.run.loadRun(f.runDir).state.last, 'init')
})

await test('SA-AR01 an explicit trusted workflow escalation keeps its distinct completed owner outcome', async t => {
  const f = await fixture(t)
  f.setAnswer(() => null) // ordinary returned malformed data, not a provider or safety refusal
  const planned = f.stage.planNativeStage(f.runDir)
  const error = await caught(f.execute)
  assert.equal(classify(error), 'escalation')
  assert.equal(json(join(planned.stage.dir, 'result.json')).status, 'escalate')
  assertRejectedReceipt(f, planned)
  assert.equal(f.calls.length, 4)
})

for (const kind of ['validate', 'verify']) await test(`SA-AR01 fresh ${kind} all-null round preserves its existing completed retry path`, async t => {
  const v = await import(pathToFileURL(resolve(ROOT, 'graphs/security-audit/tests/verdict-fixtures.mjs')))
  const defs = [{ name: 'ordinary', candidates: ['ordinary-fp'] }]
  const prepared = kind === 'validate' ? v.toValidate(defs) : await v.atVerify(defs)
  const f = await fixture(t, prepared.runDir)
  assert.equal(f.run.nextStep(f.run.loadRun(f.runDir)).step, kind)
  const planned = f.stage.planNativeStage(f.runDir)
  const decisionsFile = join(f.runDir, 'decisions.json'), decisions = readFileSync(decisionsFile)
  const beforeSpent = f.run.loadRun(f.runDir).meta.agents_spent
  f.setAnswer(() => null) // malformed ordinary returned data: no provider refusal injection
  const error = await caught(f.execute)
  assert.equal(classify(error), 'escalation')
  assert.match(error.message, /every verifier of the round returned nothing/)
  assertRejectedReceipt(f, planned)
  assert.equal(f.calls.length, 1)
  assert.equal(f.run.loadRun(f.runDir).meta.agents_spent, beforeSpent + 1)
  assert.deepEqual(readFileSync(decisionsFile), decisions, 'no candidate/phase5 try was consumed')
  const next = f.stage.planNativeStage(f.runDir)
  assert.equal(next.step, kind)
  assert.notEqual(next.stage.name, planned.stage.name)
  assert.equal(f.calls.length, 1, 'planning a legal attempt does not dispatch it')
})

await test('SA-AR01 one receipt-write failure retains its original semantic cause and replays only the saved application', async t => {
  const f = await fixture(t), files = await f.synthesis()
  f.setAnswer(() => f.fixtures.SYNTH({ units: [f.fixtures.UNIT('bad', { starting_paths: ['src/absent.js'] })] }))
  const error = await oneShotIO({ method: 'writeFileSync', file: files.receiptFile + '.tmp',
    afterFile: files.resultFile, thrown: eio() }, f.execute)
  assert.equal(error.code, 'APPLICATION_RECEIPT_UNCONFIRMED')
  assert.equal(classify(error), null)
  assert.equal(classify(error.cause), 'semantic')
  assert.match(error.cause.message, /would not seed/)
  assert.equal(existsSync(files.receiptFile), false)
  const calls = [...f.calls], rows = f.rows()
  assert.equal(f.stage.pendingNativeApplication(f.runDir).invocationId, files.planned.invocationId)
  f.forbidCallbacks()
  const replayed = await caught(f.execute)
  assert.equal(classify(replayed), 'semantic')
  assert.deepEqual(f.calls, calls); assert.deepEqual(f.rows(), rows)
  assert.equal(f.run.loadRun(f.runDir).meta.agents_spent, 5)
  assertRejectedReceipt(f, files.planned)
  assert.equal(json(join(f.runDir, 'seed-feedback.json')).attempts.length, 1, 'same application replay consumes no extra semantic try')
})

await test('SA-AR01 changed capture and already-receipted result bytes refuse without another callback', async t => {
  const f = await fixture(t), files = await f.synthesis()
  await oneShotIO({ method: 'readFileSync', file: files.stateFile, afterFile: files.resultFile, thrown: eio() }, f.execute)
  const input = join(files.planned.stage.dir, 'input.json'), originalInput = readFileSync(input), calls = [...f.calls], rows = f.rows()
  writeFileSync(input, Buffer.concat([originalInput, Buffer.from(' ')]))
  f.forbidCallbacks()
  const conflict = await caught(f.execute)
  assert.match(conflict.message, /capture changed/)
  assert.equal(classify(conflict), null)
  assert.deepEqual(f.calls, calls); assert.deepEqual(f.rows(), rows)
  assert.equal(existsSync(files.receiptFile), false)
  writeFileSync(input, originalInput)
  await assertRecovered(f, files, calls, rows)
  const savedResult = readFileSync(files.resultFile)
  writeFileSync(files.resultFile, Buffer.concat([savedResult, Buffer.from(' ')]))
  const changedReceipt = await caught(f.execute)
  assert.match(changedReceipt.message, /receipt changed/)
  assert.equal(classify(changedReceipt), null)
  assert.deepEqual(f.calls, calls); assert.deepEqual(f.rows(), rows)
  writeFileSync(files.resultFile, savedResult)
})
