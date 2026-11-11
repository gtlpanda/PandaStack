// Best-effort observations: one error listener per output stream, no retries.
// Write callbacks establish transport completion, not consumer acknowledgment.
const outputs = new WeakMap()

function outputFor(stream) {
  if (outputs.has(stream)) return outputs.get(stream)
  const pending = new Set(), waiters = new Set()
  let failed = false
  function notify() {
    if (!pending.size) for (const finish of [...waiters]) finish(!failed)
  }
  function fail() {
    failed = true
    for (const onFailure of pending) {
      try { onFailure() } catch { /* Observation callbacks cannot affect work. */ }
    }
    pending.clear()
    notify()
  }
  // The callback alone is insufficient: Writable also emits an error event.
  // Keep this single listener for the stream lifetime, including late errors.
  stream.on('error', fail)
  const output = {
    emit(event, onFailure) {
      const failure = () => onFailure()
      pending.add(failure)
      if (stream.destroyed || stream.writableEnded) { fail(); return }
      try {
        stream.write(`PANDASTACK_DECISION ${JSON.stringify(event)}\n`, error => {
          if (error) { fail(); return }
          pending.delete(failure)
          notify()
        })
      } catch { fail() }
    },
    flush(timeoutMs) {
      if (!pending.size) return Promise.resolve(!failed)
      return new Promise(resolve => {
        const timer = setTimeout(fail, timeoutMs)
        const finish = ok => { clearTimeout(timer); waiters.delete(finish); resolve(ok) }
        waiters.add(finish)
      })
    },
  }
  outputs.set(stream, output)
  return output
}

export function emitDecisionOutput(event, onFailure) {
  outputFor(process.stdout).emit(event, onFailure)
}

// Only the owning CLI waits. A deadline degrades outstanding observations and
// preserves the workflow exit code; it never retries or ends shared stdout.
export function flushDecisionOutput(timeoutMs = 1000) {
  return outputs.get(process.stdout)?.flush(timeoutMs) ?? Promise.resolve(true)
}
