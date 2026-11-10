import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from '../scripts/workflow-harness.mjs'
import { observeContextLaunch } from '../graphs/autobuild/tool/lib/context-receipt.mjs'

function fixture(stdin = false, patch = {}) {
  const child = new EventEmitter(); child.stdin = new EventEmitter()
  const supplied = [], uncertain = []
  const written = observeContextLaunch(child, {
    onContextSupplied: e => supplied.push(e), onContextUncertain: () => uncertain.push(true), ...patch,
  }, { stdin })
  return { child, written, supplied, uncertain }
}

await test('Claude receipt requires spawn; Codex requires spawn and confirmed write in either order', () => {
  const claude = fixture()
  assert.equal(claude.supplied.length, 0)
  claude.child.emit('spawn'); claude.child.emit('close', 23)
  assert.equal(claude.supplied.length, 1); assert.deepEqual(claude.uncertain, [])
  assert.equal(claude.supplied[0].providerRunId, null)
  for (const writeFirst of [true, false]) {
    const f = fixture(true)
    if (writeFirst) f.written(); else f.child.emit('spawn')
    assert.equal(f.supplied.length, 0)
    if (writeFirst) f.child.emit('spawn'); else f.written()
    f.child.emit('close', 23)
    assert.equal(f.supplied.length, 1); assert.equal(f.uncertain.length, 0)
    assert.notEqual(f.supplied[0].launchId, claude.supplied[0].launchId)
  }
})

await test('known spawn failure is zero; lost write callback and EPIPE are uncertain with no receipt', () => {
  for (const stdin of [false, true]) {
    const failed = fixture(stdin)
    failed.child.emit('error', Error('synthetic spawn failure'))
    if (stdin) failed.written(Error('synthetic pipe error'))
    failed.child.emit('close', 127)
    assert.equal(failed.supplied.length, 0); assert.equal(failed.uncertain.length, 0)
  }
  for (const mode of ['callback', 'event', 'unknown']) {
    const f = fixture(true); f.child.emit('spawn')
    if (mode === 'callback') f.written(Error('synthetic EPIPE'))
    if (mode === 'event') f.child.stdin.emit('error', Error('synthetic EPIPE'))
    f.child.emit('close', 70)
    // A delayed completion cannot publish after the provider boundary has ended.
    f.written()
    assert.equal(f.supplied.length, 0); assert.ok(f.uncertain.length >= 1)
  }
})

await test('receipt and uncertainty callbacks cannot throw into either provider lifecycle', () => {
  for (const stdin of [false, true]) {
    let failures = 0
    const f = fixture(stdin, { onContextSupplied: () => { throw Error('synthetic observer failure') },
      onContextUncertain: () => { failures++; throw Error('synthetic observer failure') } })
    assert.doesNotThrow(() => { f.child.emit('spawn'); if (stdin) f.written(); f.child.emit('close', 23) })
    assert.ok(failures >= 1)
  }
})
