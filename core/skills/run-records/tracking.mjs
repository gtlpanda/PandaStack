// Observation only: storage failures must never change runner execution.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpathSync, lstatSync, statSync } from 'node:fs'
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path'
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

function placementRoot(directory) {
  let root
  try { root = git(directory, 'rev-parse', '--show-toplevel') }
  catch (error) {
    // Only a known non-Git directory gets the supplied-directory fallback.
    // Permission, timeout and invalid repository failures are indeterminate.
    if (error.status === 128 && /not a git repository/.test(String(error.stderr))) {
      return { root: directory, namespace: null }
    }
    throw error
  }
  const owner = realpathSync(git(directory, 'rev-parse', '--absolute-git-dir'))
  // Trust the metadata owner, never a caller-created namespace symlink target.
  return { root: realpathSync(root), namespace: join(owner, 'pandastack-runs') }
}

function prospectiveDirectory(directory) {
  const suffix = []
  let ancestor = directory
  for (;;) {
    try { lstatSync(ancestor); break }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      suffix.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
  // Broken/looping symlinks and non-directory ancestors must not be mistaken
  // for a missing suffix. All checks happen before the store can create paths.
  const canonical = realpathSync(ancestor)
  if (!statSync(canonical).isDirectory()) throw Error('Invalid tracking ancestor')
  return resolve(canonical, ...suffix)
}

function contains(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function managedStoreDirectory(options, repo, runnerRoot) {
  const roots = [placementRoot(repo), placementRoot(runnerRoot)]
  const selected = options.storeDir ?? process.env.PANDASTACK_RUNS_DIR ??
    git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'pandastack-runs')
  if (typeof selected !== 'string' || !selected || selected.includes('\0')) throw Error('Invalid tracking directory')
  // Match the store's lexical normalization, but keep its original no-follow path.
  const directory = resolve(selected)
  const candidate = prospectiveDirectory(directory)
  const metadata = roots.some(({ namespace }) => namespace && contains(namespace, candidate))
  if (!metadata && roots.some(({ root }) => contains(root, candidate))) throw Error('Tracking inside worktree')
  return directory
}

export async function withTrackedRun(options, work) {
  let store, id, warned = false
  const warning = () => { if (!warned) { warned = true; warn() } }
  const event = (type, exitCode) => store.appendEvent({ schemaVersion: 1, id: randomUUID(), runId: id, type, at: new Date().toISOString(), exitCode })
  try {
    const repo = realpathSync(resolve(options.repo))
    const runnerRoot = realpathSync(resolve(options.runnerRoot))
    id = options.runId ?? randomUUID()
    store = createRunStore(managedStoreDirectory(options, repo, runnerRoot))
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
