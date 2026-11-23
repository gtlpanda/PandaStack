// native-grant-budget.test.mjs - `audit-native.mjs resume --grant N` raises the journal's grant; the audit's own planner gates (reconGate, waveAllowance,
// criticBudgetExhausted) read run-metadata.json's budget, so they must honour the raised grant too. Same fake codex and toy audit as native-e2e.test.mjs.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test, NO_LINUX_STORES } from '../../../scripts/workflow-harness.mjs'
import { meta, mkRepo, sandbox } from './audit-fixtures.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { main } from '../skills/security-audit/audit-native.mjs'
import { raiseBudget, markIncomplete } from '../skills/security-audit/audit-run.mjs'
import { newInit } from './stage-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, '..', '..', '..', 'tests', 'fixtures', 'fake-source-only-codex.mjs')
const ANSWERS = join(HERE, 'native-e2e-answers.mjs')
const work = mkdtempSync(join(sandbox, 'native-grant-'))
const auth = join(work, 'auth.json'); writeFileSync(auth, 'not-a-real-login-file', { mode: 0o600 })

function fakeCodex(name) {
  const bin = join(work, name), record = join(work, `${name}.jsonl`)
  const vars = { FAKE_CODEX_ANSWER: ANSWERS, FAKE_CODEX_RECORD: record, FAKE_CODEX_ENV_KEYS: 'CODEX_HOME,HOME,PANDASTACK_AUDIT_READER_KEY,PATH' }
  writeFileSync(bin, `#!/bin/sh\n${Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(' ')} exec ${process.execPath} ${FAKE} "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin }
}
const capture = () => { const lines = []; return { lines, log: l => lines.push(l) } }

await test('a run paused for its budget and resumed with a larger --grant is funded by that grant, not by the original run-metadata budget', { skip: NO_LINUX_STORES }, async () => {
  const f = fakeCodex('codex-grant')
  const target = mkRepo(TOY_FILES, 'toy-grant')
  // The standard profile's minimum budget is 10: the original budget funds reconnaissance and its reserves, and nothing more.
  const init = spawnSync(process.execPath, [join(HERE, '..', 'skills', 'security-audit', 'audit-run.mjs'), 'init', target, '--full', '--budget', '10', '--max-parallel', '2'], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stdout + init.stderr)
  const dir = init.stdout.split('\n')[0]
  assert.equal(meta(dir).budget, 10)
  // The journal's grant is small so the run pauses for its budget; the operator then raises it to the maximum.
  mkdirSync(join(dir, 'native-codex'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'native-codex', 'native-run.json'), JSON.stringify({ version: 1, grant: 3, maxBudget: 60 }))

  const first = capture()
  assert.equal(await main(['resume', dir, '--codex-bin', f.bin, '--auth-file', auth], { log: first.log }), 3, `precondition: the run pauses for its budget\n${first.lines.join('\n')}`)
  assert.match(first.lines.at(-1), /^AUDIT: PAUSED blockers=paused_budget/)

  const second = capture()
  const code = await main(['resume', dir, '--grant', '60', '--codex-bin', f.bin, '--auth-file', auth], { log: second.log })
  assert.ok(code === 0 || code === 5, `precondition: the resumed run ends
${second.lines.join('\n')}`)
  const m = meta(dir)
  const huntStages = Object.keys(m.stage_spend ?? {}).filter(k => /-hunt-/.test(k))
  assert.ok(huntStages.length > 0, `BUGHUNT-F1 the operator raised the grant to 60 but the planners still gate on run-metadata budget ${m.budget} (agents_spent=${m.agents_spent}): no hunter was funded, the run ended ${m.run_status} with exit ${code}:
${second.lines.join('\n')}`)
})

await test('the raised grant and the planners\' budget agree after resume, and the run completes on the toy audit', { skip: NO_LINUX_STORES }, async () => {
  const f = fakeCodex('codex-grant-agree')
  const init = spawnSync(process.execPath, [join(HERE, '..', 'skills', 'security-audit', 'audit-run.mjs'), 'init', mkRepo(TOY_FILES, 'toy-grant-agree'), '--full', '--budget', '10', '--max-parallel', '2'], { encoding: 'utf8' })
  const dir = init.stdout.split('\n')[0]
  mkdirSync(join(dir, 'native-codex'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'native-codex', 'native-run.json'), JSON.stringify({ version: 1, grant: 3, maxBudget: 60 }))
  assert.equal(await main(['resume', dir, '--codex-bin', f.bin, '--auth-file', auth], { log() {} }), 3)
  const o = capture()
  assert.equal(await main(['resume', dir, '--grant', '60', '--codex-bin', f.bin, '--auth-file', auth], { log: o.log }), 0, o.lines.join('\n'))
  assert.equal(meta(dir).budget, 60)
  assert.equal(meta(dir).run_status, 'complete')
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(events.filter(e => e.cmd === 'raise-budget').map(e => e.counts), [{ from: 10, to: 60 }])
})

await test('--grant above the maximum or not above the current grant is refused before anything changes', { skip: NO_LINUX_STORES }, async () => {
  const f = fakeCodex('codex-grant-bounds')
  const init = spawnSync(process.execPath, [join(HERE, '..', 'skills', 'security-audit', 'audit-run.mjs'), 'init', mkRepo(TOY_FILES, 'toy-grant-bounds'), '--full', '--budget', '10', '--max-parallel', '2'], { encoding: 'utf8' })
  const dir = init.stdout.split('\n')[0]
  mkdirSync(join(dir, 'native-codex'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'native-codex', 'native-run.json'), JSON.stringify({ version: 1, grant: 3, maxBudget: 20 }))
  assert.equal(await main(['resume', dir, '--codex-bin', f.bin, '--auth-file', auth], { log() {} }), 3)
  for (const grant of ['21', '3']) {
    const o = capture()
    assert.equal(await main(['resume', dir, '--grant', grant, '--codex-bin', f.bin, '--auth-file', auth], { log: o.log }), 1, grant)
    assert.match(o.lines.join('\n'), /--grant must be above the current grant 3 and at most the maximum 20/)
    assert.equal(meta(dir).budget, 10, 'the planners\' budget did not move')
  }
})

await test('raiseBudget only raises a nonterminal run\'s budget: lower, non-integer, null-budget and finished runs are refused; the same value is a no-op', { skip: NO_LINUX_STORES }, () => {
  const { runDir } = newInit(['--budget', '12'])
  const refused = value => assert.throws(() => raiseBudget(runDir, value), e => e.constructor.name === 'Refusal')
  for (const bad of [11, 12.5, '20', null, undefined, -1, NaN, Infinity]) { if (bad !== 12) refused(bad) }
  assert.equal(raiseBudget(runDir, 12), 12)
  assert.equal(raiseBudget(runDir, 30), 30)
  assert.equal(meta(runDir).budget, 30)
  const none = newInit().runDir
  assert.throws(() => raiseBudget(none, 40), e => /no budget to raise/.test(e.message))
  markIncomplete(runDir, 'critic_budget_exhausted')
  assert.throws(() => raiseBudget(runDir, 60), e => /never reopened/.test(e.message))
  assert.equal(meta(runDir).budget, 30)
})
