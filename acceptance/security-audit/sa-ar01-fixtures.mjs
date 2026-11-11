// External draft only; proposed acceptance/security-audit/sa-ar01-fixtures.mjs.
// Existing owners and isolated ordinary fixtures only. No proposed classifier import.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function applicationFixture(root, existingRunDir) {
  const imp = p => import(pathToFileURL(resolve(root, p)))
  const [fixtures, journalAPI, native, stage, run, report, registryAPI] = await Promise.all([
    imp('graphs/security-audit/tests/stage-fixtures.mjs'),
    imp('graphs/security-audit/skills/security-audit/dispatch-journal.mjs'),
    imp('graphs/security-audit/skills/security-audit/native-stage.mjs'),
    imp('graphs/security-audit/skills/security-audit/audit-stage.mjs'),
    imp('graphs/security-audit/skills/security-audit/audit-run.mjs'),
    imp('graphs/security-audit/skills/security-audit/audit-report.mjs'),
    imp('core/skills/native-runtime/registry.mjs'),
  ])
  const runDir = existingRunDir ?? fixtures.newInit().runDir
  const journal = journalAPI.openAuditJournal({ runDir, invocationLimit: 12 })
  journal.initControl({ initialGrant: 12 })
  const ids = ['blueprint-design', 'bughunt-flow', 'dev-build', 'harness-repair', 'release-flow', 'security-audit-flow']
  const dirs = ['blueprint', 'hunt', 'dev', 'qa', 'release', 'security-audit']
  const registry = registryAPI.loadWorkflowRegistry({ installationRoot: root,
    workflowHashes: Object.fromEntries(ids.map((id, i) => [id,
      sha(fs.readFileSync(join(root, 'graphs', dirs[i], 'workflows', id + '.js')))])) })
  const calls = []
  let forbidden = false, answer = req => req.agentType === 'audit-researcher'
    ? fixtures.RESEARCH(req.label.slice(6)) : fixtures.SYNTH()
  const options = { runDir, journal, registry, maxConcurrentSubagents: 1, deadlineMs: Date.now() + 60000,
    resolveLeaf: () => ({ selection: { provider: 'codex', model: 'fixture', effort: 'high' }, profile: 'audit-source-only' }),
    provider: { async runLeaf(req) {
      calls.push({ callId: req.callId, invocationId: req.invocationId, agentType: req.agentType })
      assert.equal(forbidden, false, 'saved application recovery must not dispatch another callback')
      return { outcome: 'returned', wire: { json: JSON.stringify(answer(req)) }, usage: null,
        receipt: { ...req.selection, invocationId: req.callId } }
    } } }
  const execute = () => native.runNativeAuditStage(options)
  return { runDir, calls, stage, run, report, fixtures, journal,
    execute, setAnswer(fn) { answer = fn }, forbidCallbacks() { forbidden = true },
    rows: () => journalAPI.readAuditJournal(runDir).rows,
    close: () => journal.close(),
    async synthesis() {
      await execute()
      assert.equal(calls.length, 4)
      const planned = stage.planNativeStage(runDir)
      assert.equal(planned.part, 'synthesize')
      return { planned, resultFile: join(planned.stage.dir, 'result.json'), stateFile: join(runDir, 'stage-state.json'),
        receiptFile: join(planned.stage.dir, 'native-application.json'), facts: fs.readFileSync(join(runDir, 'recon-facts.json')) }
    },
  }
}
export async function oneShotIO({ method, file, afterFile, thrown }, work) {
  assert.ok(['readFileSync', 'writeFileSync'].includes(method))
  const original = fs[method]
  let injected = false, failure
  try {
    fs[method] = (path, ...args) => {
      if (!injected && path === file && fs.existsSync(afterFile)) { injected = true; throw thrown }
      return original(path, ...args)
    }
    syncBuiltinESMExports()
    try { await work() } catch (error) { failure = error }
  } finally { fs[method] = original; syncBuiltinESMExports() }
  assert.equal(injected, true, 'one exact fixture-owned synchronous I/O boundary was reached')
  assert.ok(failure, 'the injected failure must escape, never become success')
  return failure
}
