// e2e-driver.mjs - drives a whole audit the way the entry skill says, against scripted agents: the commands come out of SKILL.md (the init command, `next`, the table of
// helper steps, plan and apply), never from a copy of them in a test, and what to run is whatever `audit-run.mjs next` prints, never a fixed sequence. The Workflow tool is
// replaced by the workflow harness, running the very script `plan` wrote; the output file is shaped like the runtime's (summary, agentCount, logs, result). The real vendored
// validators run inside the helpers on every artifact. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { load, run } from '../../../scripts/workflow-harness.mjs'
import { SKILL_DIR, runCommand, skillCommands, skillText, stepCommands } from './skill-commands.mjs'
import { sandbox } from './audit-fixtures.mjs'

const AGENT_TYPES = ['audit-researcher', 'audit-analyst', 'audit-synthesizer']
const commandFor = (pattern, text = skillText()) => {
  const found = [...new Set(skillCommands(text).filter(c => pattern.test(c)))]
  assert.equal(found.length, 1, `SKILL.md has exactly one command matching ${pattern}: ${found.join(' | ')}`)
  return found[0]
}

// answer(label, ctx) -> what the scripted agent returns (or { throws }); ctx = { agentType, stage, input, prompt }.
// opts: initArgs (extra flags for init), maxSteps, onStep(trace entry).
export async function driveAudit({ repo, answer, initArgs = [], maxSteps = 120, onStep = () => {}, stopAt = null }) {
  const text = skillText()
  const vars = { AUDIT: SKILL_DIR, REPO: repo }
  const initCommand = `${commandFor(/audit-run\.mjs" init /, text)}${initArgs.length ? ` ${initArgs.join(' ')}` : ''}`
  const init = runCommand(initCommand, vars, repo)
  assert.equal(init.status, 0, init.stdout + init.stderr)
  assert.match(init.last, /^AUDIT: OK run=/)
  const RUN = init.stdout.split('\n')[0]
  vars.RUN = RUN
  const nextCommand = commandFor(/audit-run\.mjs" next "\$RUN"$/, text)
  const planCommand = commandFor(/audit-stage\.mjs" plan "\$RUN"$/, text)
  const applyCommand = commandFor(/audit-stage\.mjs" apply "\$RUN" "\$OUT"$/, text)
  const table = stepCommands(text)
  const trace = []
  const outDir = mkdtempSync(join(sandbox, 'runtime-output-'))
  let agentsCalled = 0
  for (let i = 0; i < maxSteps; i++) {
    const next = runCommand(nextCommand, vars, repo)
    const m = next.last.match(/^NEXT: (\S+)(?: run=(\S+))?/)
    assert.ok(m, `next printed something the skill does not describe: ${next.stdout}${next.stderr}`)
    const [, step, runner] = m
    const entry = { next: next.last, step, runner, commands: [], calls: [] }
    trace.push(entry)
    if (step === 'done') { onStep(entry); break }
    if (stopAt && stopAt(entry)) { onStep(entry); break }
    if (table.has(step)) {
      const r = runCommand(table.get(step), vars, repo)
      entry.commands.push({ command: table.get(step), last: r.last, status: r.status })
      assert.equal(r.status, 0, `${next.last}: ${table.get(step)}\n${r.stdout}${r.stderr}`)
      assert.match(r.last, /^AUDIT: OK /)
    } else {
      assert.equal(runner, 'workflow', `the skill has no row for ${next.last}`)
      const plan = runCommand(planCommand, vars, repo)
      entry.commands.push({ command: planCommand, last: plan.last, status: plan.status })
      assert.equal(plan.status, 0, `${next.last}: plan\n${plan.stdout}${plan.stderr}`)
      const printed = plan.stdout.match(/^Call the Workflow tool with scriptPath (\S+) and no args, then save the JSON it returns to (\S+)$/m)
      assert.ok(printed, `plan printed the script's path: ${plan.stdout}`)
      const scriptPath = printed[1]
      const input = JSON.parse(readFileSync(join(scriptPath, '..', 'input.json'), 'utf8'))
      const { fn } = load(scriptPath)
      const queues = Object.fromEntries(AGENT_TYPES.map(t => [t, Array.from({ length: 300 }, () => (prompt, opts) => answer(opts.label, { agentType: t, stage: step, input, prompt, opts }))]))
      const ran = await run(fn, queues, undefined, { allowLeftover: true })
      entry.calls = ran.calls.map(c => ({ label: c.label, agentType: c.agentType }))
      agentsCalled += ran.calls.length
      const OUT = join(outDir, `${String(i).padStart(3, '0')}-${step}.json`)
      writeFileSync(OUT, JSON.stringify({ summary: 'Full security audit graph', agentCount: ran.calls.length, logs: ran.logs, result: ran.result, workflowProgress: [], totalTokens: 0, totalToolCalls: 0 }, null, 2))
      const applied = runCommand(applyCommand, { ...vars, OUT }, repo)
      entry.commands.push({ command: applyCommand, last: applied.last, status: applied.status })
      entry.applied = applied
      assert.equal(applied.status, 0, `${next.last}: apply\n${applied.stdout}${applied.stderr}`)
      assert.match(applied.last, /^AUDIT: OK apply /)
    }
    onStep(entry)
  }
  return { RUN, vars, trace, agentsCalled, steps: trace.map(t => t.next) }
}
