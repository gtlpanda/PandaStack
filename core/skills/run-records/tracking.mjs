// Observation only: storage failures must never change runner execution.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRun } from './records.mjs'
import { createRunStore } from './store.mjs'

const context = new AsyncLocalStorage()
export const currentRunId = () => context.getStore() ?? null
const warn = () => { try { process.stderr.write('PandaStack: run tracking unavailable; execution continues.\n') } catch {} }
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, maxBuffer: 8192 }).trim()
}
function revision(repo) {
  try { return git(repo, 'rev-parse', '--verify', 'HEAD') } catch { return null }
}

export async function withTrackedRun(options, work) {
  let store, id, warned = false
  const warning = () => { if (!warned) { warned = true; warn() } }
  const event = (type, exitCode) => store.appendEvent({ schemaVersion: 1, id: randomUUID(), runId: id, type, at: new Date().toISOString(), exitCode })
  try {
    const repo = realpathSync(resolve(options.repo))
    const runnerRoot = realpathSync(resolve(options.runnerRoot))
    id = options.runId ?? randomUUID()
    store = createRunStore(options.storeDir ?? process.env.PANDASTACK_RUNS_DIR ?? git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'pandastack-runs'))
    const run = createRun({ id, repo, runnerRoot, revision: revision(repo), runnerRevision: revision(runnerRoot),
      workflow: options.workflow, backend: options.backend, settings: options.settings,
      parentRunId: options.parentRunId === undefined ? currentRunId() : options.parentRunId, startedAt: new Date().toISOString() })
    // A caller-supplied ID cannot resume an earlier invocation, even in the same millisecond.
    if (!store.putRun(run).created) throw Error('Existing invocation')
    event('started', null)
  } catch { store = null; id = null; warning() }
  return context.run(id, async () => {
    let code
    try { code = await work() }
    catch (error) {
      if (store) { try { event('failed', 1) } catch { warning() } }
      throw error
    }
    if (store) {
      try { event(code === 0 ? 'finished' : code === 130 ? 'cancelled' : 'failed', code) }
      catch { warning() }
    }
    return code
  })
}
