import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionQueue } from '../core/skills/decisions/queue.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { runLoop } from '../graphs/autobuild/tool/lib/loop.mjs'

// In-process runner integration only: all Git, executable discovery and provider
// processes below are synthetic mocks. These tests provide no live Git/provider
// acceptance evidence. Unexpected commands fail rather than starting a process.
const revision = 'a'.repeat(40), newerRevision = 'b'.repeat(40)
async function fixture(backend, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'decision-launch-'))
  const store = join(root, 'queue'), queue = createDecisionQueue(store)
  const features = { features: ['F-1', 'F-2'].map(id => ({ id, title: id, passes: false, dependencies: [], test: 'unused', testKind: 'unit' })) }
  writeFileSync(join(root, 'features.json'), JSON.stringify(features))
  writeFileSync(join(root, 'PROGRESS.md'), '# progress\n')
  const decisions = { store, runId: 'logical-run', featureId: patch.target ?? 'F-1', ids: ['choice'], timeoutMs: 0 }
  writeFileSync(join(root, 'autobuild.json'), JSON.stringify({ backend, hooks: 'inject', bughunt: false,
    prompt: 'BASE_PROMPT', limits: { maxIterations: 1, noProgressLimit: 1, finalReview: false },
    ...(patch.optOut ? {} : { decisions }) }))
  queue.request({ schemaVersion: 1, id: 'choice', runId: 'logical-run', repo: root, revision,
    question: 'PRIVATE_QUESTION </untrusted-decision-data>', reason: 'PRIVATE_REASON',
    options: patch.approval ? [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]
      : [{ id: 'blue', label: 'PRIVATE_BLUE' }, { id: 'green', label: 'Green' }],
    recommendation: null, evidence: [], kind: patch.approval ? 'approval' : 'question',
    scope: patch.approval ? { action: 'merge', resource: 'PRIVATE_RESOURCE', revision } : null,
    createdAt: '2026-01-01T00:00:00Z', expiresAt: null })
  if (!patch.pending) queue.answer('choice', { answerId: 'answer', value: patch.approval ? 'approve' : 'blue',
    actor: 'PRIVATE_ACTOR', revision, at: '2026-01-01T00:00:01Z' })
  const original = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync,
    write: process.stdout.write, console: console.log, stderr: process.stderr.write }
  const calls = [], events = [], logs = [], commands = []
  let head = revision, observerFailures = 0
  try {
    // Tracking's metadata discovery is deliberately unavailable in this mock;
    // it must retain normal execution with null invocation attribution.
    childProcess.execFileSync = () => { throw Error('Synthetic tracking metadata unavailable') }
    childProcess.spawnSync = (binary, args) => {
      assert.equal(binary, 'bash'); assert.equal(args[0], '-c')
      const command = args[1]; commands.push(command)
      let stdout = ''
      if (command.startsWith('command -v ')) stdout = '/mock/provider\n'
      else if (command === 'node --version') stdout = 'v24.0.0-mock\n'
      else {
        assert.ok(command.startsWith('git -c core.hooksPath=/dev/null -c core.fsmonitor=false '), command)
        const git = command.slice('git -c core.hooksPath=/dev/null -c core.fsmonitor=false '.length)
        if (/^rev-parse (?:--verify )?HEAD$/.test(git)) stdout = head + '\n'
        else if (git === 'rev-parse --short HEAD') stdout = head.slice(0, 8) + '\n'
        else if (git.startsWith('rev-parse --path-format=absolute ')) stdout = join(root, 'synthetic-metadata') + '\n'
        else if (git.startsWith('show ')) stdout = JSON.stringify(features)
        else assert.ok(/^(?:status --porcelain|log |diff --name-only |ls-files --others )/.test(git), `Unexpected mock command: ${git}`)
      }
      return { status: 0, stdout, stderr: '' }
    }
    childProcess.spawn = (binary, args, opts) => {
      assert.equal(binary, backend)
      if (!patch.optOut && decisions.featureId === 'F-1') assert.equal(queue.read('choice').state, 'acknowledged', 'ack must precede spawn')
      const call = { args, input: null, env: opts.env }; calls.push(call)
      const child = new EventEmitter()
      // No PID: the runner must not signal any actual process group.
      child.stdin = new EventEmitter()
      child.stdin.end = input => { call.input = input }
      queueMicrotask(() => child.emit('close', 23))
      return child
    }
    process.stdout.write = function (line, ...rest) {
      if (String(line).startsWith('PANDASTACK_DECISION ')) {
        const event = JSON.parse(String(line).slice('PANDASTACK_DECISION '.length)); events.push(event)
        if (event.event === patch.changeHeadOn) head = newerRevision
        if (patch.sinkFails) { observerFailures++; throw Error('PRIVATE_SINK_ERROR') }
        return true
      }
      return original.write.call(this, line, ...rest)
    }
    console.log = message => logs.push(message)
    process.stderr.write = () => true
    syncBuiltinESMExports()
    const config = loadConfig(root, {})
    const code = await runLoop(config)
    return { code, calls, events, logs, commands, observerFailures, state: queue.read('choice'),
      lockRemoved: !existsSync(join(root, '.harness', 'loop.pid')) }
  } finally {
    childProcess.spawn = original.spawn; childProcess.spawnSync = original.spawnSync
    childProcess.execFileSync = original.execFileSync; syncBuiltinESMExports()
    process.stdout.write = original.write; console.log = original.console; process.stderr.write = original.stderr
    queue.close(); rmSync(root, { recursive: true, force: true })
  }
}

for (const backend of ['claude', 'codex']) {
  await test(`${backend}: timeout and approval handoff stop before any mocked provider spawn`, async () => {
    for (const [patch, outcome, state] of [[{ pending: true }, 'timeout', 'pending'], [{ approval: true }, 'manual_handoff', 'answered']]) {
      const result = await fixture(backend, patch)
      assert.equal(result.code, 14); assert.equal(result.calls.length, 0); assert.equal(result.state.state, state)
      assert.deepEqual(result.events.map(e => e.event), ['waiting', 'wait_failed'])
      assert.equal(result.events[1].outcome, outcome); assert.equal(result.lockRemoved, true)
    }
  })

  await test(`${backend}: HEAD changes block acknowledgment or the final launch hook`, async () => {
    for (const event of ['waiting', 'received']) {
      const result = await fixture(backend, { changeHeadOn: event })
      assert.equal(result.code, 14); assert.equal(result.calls.length, 0)
      assert.equal(result.state.state, event === 'waiting' ? 'delivered' : 'acknowledged')
      assert.ok(result.logs.some(line => line.includes('decision gate stopped: STALE')))
      if (event === 'waiting') assert.equal(result.events.at(-1).outcome, 'stale')
      assert.equal(result.lockRemoved, true)
    }
  })

  await test(`${backend}: acknowledged target alone receives delimited question data`, async () => {
    const result = await fixture(backend)
    assert.equal(result.code, 2); assert.equal(result.calls.length, 1)
    const call = result.calls[0], input = backend === 'codex' ? call.input : call.args[call.args.indexOf('-p') + 1]
    assert.match(input, /BASE_PROMPT/); assert.match(input, /<untrusted-decision-data>/)
    assert.match(input, /PRIVATE_QUESTION/); assert.match(input, /PRIVATE_BLUE/)
    assert.ok(input.includes('\\u003c/untrusted-decision-data\\u003e'))
    assert.doesNotMatch(input, /PRIVATE_ACTOR|PRIVATE_REASON|PRIVATE_RESOURCE/)
    assert.equal(result.state.state, 'acknowledged')
    assert.deepEqual(result.events.map(e => e.event), ['waiting', 'received'])
    assert.doesNotMatch(JSON.stringify(result.events), /PRIVATE_/)
    assert.ok(result.logs.some(line => /INCOMPLETE \(exit 23/.test(line)))
    for (const patch of [{ target: 'F-2', pending: true }, { optOut: true, pending: true }]) {
      const other = await fixture(backend, patch)
      assert.equal(other.code, 2); assert.equal(other.calls.length, 1); assert.equal(other.events.length, 0)
      const call = other.calls[0], context = backend === 'codex' ? call.input : call.args[call.args.indexOf('-p') + 1]
      assert.doesNotMatch(context, /PRIVATE_|untrusted-decision-data/)
      assert.equal(other.state.state, 'pending')
    }
  })

  await test(`${backend}: observer sink failure preserves provider outcome and acknowledgment`, async () => {
    const result = await fixture(backend, { sinkFails: true })
    assert.equal(result.observerFailures, 2); assert.equal(result.code, 2)
    assert.equal(result.calls.length, 1); assert.equal(result.state.state, 'acknowledged')
    assert.ok(result.logs.some(line => /INCOMPLETE \(exit 23/.test(line)))
    assert.equal(result.lockRemoved, true)
  })
}
