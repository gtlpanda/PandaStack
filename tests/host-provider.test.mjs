// detectHostProvider: which app the user has open decides the provider when no flag says otherwise.
// Matrix: override wins; nearest ancestor wins (codex nested in claude -> codex, claude nested in codex ->
// claude); env-only fallbacks; no signals -> claude; garbage override -> usage error. Plus the real
// process-tree walk through stub executables named codex and claude (no live model, no network).
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { HostProviderUsageError, classifyProcess, detectHostProvider, readProcessAncestry } from '../core/skills/native-runtime/host-provider.mjs'

const detect = (env, ancestry = []) => detectHostProvider({ env, ancestry })
const usage = e => { assert.ok(e instanceof HostProviderUsageError, String(e)); assert.equal(e.code, 'USAGE'); return true }

await test('PANDASTACK_PROVIDER wins over the process tree and every env signal', () => {
  assert.deepEqual(detect({ PANDASTACK_PROVIDER: 'codex', CLAUDECODE: '1' }, ['claude']), { provider: 'codex', source: 'PANDASTACK_PROVIDER' })
  assert.deepEqual(detect({ PANDASTACK_PROVIDER: 'claude', CODEX_THREAD_ID: 't' }, ['codex']), { provider: 'claude', source: 'PANDASTACK_PROVIDER' })
})

await test('a bad PANDASTACK_PROVIDER is a usage error, and an empty one counts as unset', () => {
  for (const bad of ['gpt', 'Codex', 'CLAUDE', ' codex', 'codex ', 'claude,codex', '1', 'codex\n']) {
    assert.throws(() => detect({ PANDASTACK_PROVIDER: bad }, ['codex']), usage, JSON.stringify(bad))
  }
  assert.deepEqual(detect({ PANDASTACK_PROVIDER: '' }, ['codex']), { provider: 'codex', source: 'ancestor' })
  assert.deepEqual(detect({ PANDASTACK_PROVIDER: 7 }, []), { provider: 'claude', source: 'default' }, 'a non-string is not an override')
})

await test('the nearest host ancestor decides: codex nested in claude is codex, claude nested in codex is claude', () => {
  // Nearest first. Claude's variables leak into the Codex sandbox it launched; the tree still says codex.
  const leaked = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli' }
  assert.deepEqual(detect(leaked, ['bash', 'codex', 'bash', 'claude', 'bash']), { provider: 'codex', source: 'ancestor' })
  assert.deepEqual(detect({ CODEX_THREAD_ID: 't' }, ['sh', 'claude', 'sh', 'codex']), { provider: 'claude', source: 'ancestor' })
  assert.deepEqual(detect({}, ['bash', 'node', 'claude']), { provider: 'claude', source: 'ancestor' })
})

await test('the env fallbacks apply only when no ancestor is a host: CODEX_THREAD_ID then CLAUDECODE then claude', () => {
  assert.deepEqual(detect({ CODEX_THREAD_ID: 't' }, ['bash', 'init']), { provider: 'codex', source: 'CODEX_THREAD_ID' })
  assert.deepEqual(detect({ CODEX_SANDBOX_NETWORK_DISABLED: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, []), { provider: 'codex', source: 'CODEX_SANDBOX_NETWORK_DISABLED' }, 'the variable Codex sets in its sandbox beats leaked Claude variables')
  assert.deepEqual(detect({ CLAUDECODE: '1' }, ['bash']), { provider: 'claude', source: 'CLAUDECODE' })
  assert.deepEqual(detect({ CODEX_THREAD_ID: 't', CLAUDECODE: '1' }, []), { provider: 'codex', source: 'CODEX_THREAD_ID' }, 'codex wins the env-only tie')
  assert.deepEqual(detect({ CODEX_THREAD_ID: '', CLAUDECODE: '' }, []), { provider: 'claude', source: 'default' }, 'empty signals are absent')
  assert.deepEqual(detect({}, []), { provider: 'claude', source: 'default' })
  assert.deepEqual(detectHostProvider({ env: {} }), { provider: 'claude', source: 'default' }, 'an injected env never consults the real process tree')
})

await test('an ancestry that throws, returns junk or is far too long never throws', () => {
  assert.deepEqual(detect({}, () => { throw new Error('boom') }), { provider: 'claude', source: 'default' })
  assert.deepEqual(detect({}, () => 'codex'), { provider: 'claude', source: 'default' })
  assert.deepEqual(detect({}, [null, undefined, 7, {}, { comm: 5 }]), { provider: 'claude', source: 'default' })
  assert.deepEqual(detect({}, [...Array(40).fill('bash'), 'codex']), { provider: 'claude', source: 'default' }, 'the walk is bounded')
  assert.deepEqual(detect({}, () => ['bash', 'codex']), { provider: 'codex', source: 'ancestor' }, 'a function is accepted')
})

await test('classifyProcess matches exact executable names only, including a node-run script', () => {
  assert.equal(classifyProcess('codex'), 'codex')
  assert.equal(classifyProcess({ comm: 'claude', argv: [] }), 'claude')
  assert.equal(classifyProcess({ comm: 'x', argv: ['/usr/local/bin/codex', 'exec'] }), 'codex')
  assert.equal(classifyProcess({ comm: 'node', argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'exec'] }), 'codex')
  assert.equal(classifyProcess({ comm: 'node', argv: ['node', '--no-warnings', '/opt/claude.mjs'] }), 'claude')
  for (const lookalike of ['codex-exec', 'mycodex', 'claude-code-guide', 'Codex', 'CLAUDE', 'codexd', 'xclaude', 'bash', '', 'node']) {
    assert.equal(classifyProcess(lookalike), null, lookalike)
  }
  assert.equal(classifyProcess({ comm: 'bash', argv: ['bash', 'codex'] }), null, 'bash running a file called codex is not codex')
  assert.equal(classifyProcess({ comm: 'node', argv: ['node', '/work/codex/index.js'] }), null, 'a directory named codex is not the executable')
  for (const junk of [null, undefined, 0, 7, {}, [], { comm: null, argv: 'codex' }, { argv: [1, 2] }]) assert.equal(classifyProcess(junk), null)
})

await test('readProcessAncestry walks parent links nearest first, through PID 1 (the codex process inside Codex\'s sandbox), stopping at ppid 0, a loop, a gap and the depth bound', () => {
  const table = { 50: { ppid: 40, comm: 'node', argv: [] }, 40: { ppid: 30, comm: 'bash', argv: [] }, 30: { ppid: 1, comm: 'codex', argv: [] }, 1: { ppid: 0, comm: 'init', argv: [] } }
  assert.deepEqual(readProcessAncestry({ start: 50, readProcess: pid => table[pid] }).map(p => p.comm), ['node', 'bash', 'codex', 'init'])
  assert.deepEqual(readProcessAncestry({ start: 1, readProcess: pid => ({ ppid: 0, comm: 'codex', argv: [] }) }).map(p => p.comm), ['codex'], 'a sandboxed command whose parent is PID 1')
  assert.deepEqual(readProcessAncestry({ start: 50, readProcess: pid => (pid === 40 ? undefined : table[pid]) }).map(p => p.comm), ['node'])
  assert.deepEqual(readProcessAncestry({ start: 9, readProcess: () => ({ ppid: 9, comm: 'x', argv: [] }) }).length, 1, 'a self-loop is one step')
  assert.equal(readProcessAncestry({ start: 100, readProcess: pid => ({ ppid: pid + 1, comm: 'x', argv: [] }) }).length, 32)
  assert.deepEqual(readProcessAncestry({ start: 'x', readProcess: () => { throw new Error('never') } }), [])
  assert.deepEqual(readProcessAncestry({ start: 50, readProcess: () => { throw new Error('boom') } }), [])
})

// ---- the real process tree, through stub executables (Linux: the stubs' comm is their file name) ----

const walkable = process.platform === 'linux'
const PROBE = `import(${JSON.stringify(new URL('../core/skills/native-runtime/host-provider.mjs', import.meta.url).href)})` +
  '.then(m => console.log(JSON.stringify(m.detectHostProvider())))'

function withStubs(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'host-provider-'))
  try {
    for (const name of ['codex', 'claude']) {
      // `; exit $?` keeps the shell alive as a real parent (dash would otherwise exec the last command in place).
      writeFileSync(join(dir, name), '#!/bin/sh\n"$@"; exit $?\n')
      chmodSync(join(dir, name), 0o755)
    }
    return fn(dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const cleanEnv = extra => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra })
const probe = (dir, chain, extraEnv = {}) => {
  const argv = [...chain.flatMap(name => [join(dir, name)]), process.execPath, '-e', PROBE]
  const [first, ...rest] = argv
  const r = spawnSync(first, rest, { encoding: 'utf8', cwd: REPO, env: cleanEnv(extraEnv), timeout: 30000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout)
}

await test('real process tree: a stub codex or claude parent is found; the nearest one wins; the env cannot fool it', { skip: walkable ? false : 'the real-tree walk is Linux /proc here' }, () => withStubs(dir => {
  assert.deepEqual(probe(dir, ['codex']), { provider: 'codex', source: 'ancestor' })
  assert.deepEqual(probe(dir, ['claude']), { provider: 'claude', source: 'ancestor' })
  assert.deepEqual(probe(dir, ['claude', 'codex']), { provider: 'codex', source: 'ancestor' }, 'codex launched from claude')
  assert.deepEqual(probe(dir, ['codex', 'claude']), { provider: 'claude', source: 'ancestor' }, 'claude launched from codex')
  assert.deepEqual(probe(dir, ['claude', 'codex'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }), { provider: 'codex', source: 'ancestor' },
    'claude variables leaked into a codex child do not make it claude')
  assert.deepEqual(probe(dir, ['claude'], { PANDASTACK_PROVIDER: 'codex' }), { provider: 'codex', source: 'PANDASTACK_PROVIDER' })
}))

// ---- the real Codex sandbox (`codex sandbox` runs a plain command: no model, no login) ----
// Observed with Codex CLI 0.167.0 on Linux: the command runs in its own PID namespace whose PID 1 is the codex
// process, and the Claude variables of the shell that started it are still in its environment. Skipped where
// there is no codex or its sandbox cannot start (no live model is ever run).
const codexBin = spawnSync('bash', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim()
const sandboxUsable = codexBin !== '' && spawnSync(codexBin, ['sandbox', '--', 'true'], { encoding: 'utf8', timeout: 30000 }).status === 0
const SANDBOX_PROBE = `import(${JSON.stringify(new URL('../core/skills/native-runtime/host-provider.mjs', import.meta.url).href)})` +
  '.then(m => console.log(JSON.stringify({ real: m.detectHostProvider(), envOnly: m.detectHostProvider({ env: process.env, ancestry: [] }) })))'

// The sandbox (seccomp: no sockets) cannot let a node child print to the socketpair that spawnSync gives it, so the
// command's output goes to a regular file through a shell redirect, and the test reads that file.
await test('real codex sandbox started from a Claude shell: the tree says codex, and the env-only fallback says codex too', { skip: sandboxUsable ? false : 'no codex on PATH, or its sandbox cannot start here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-provider-sandbox-'))
  try {
    const out = join(dir, 'probe.out')
    const leaked = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'leaked', CLAUDE_CODE_ENTRYPOINT: 'cli' }
    const r = spawnSync('bash', ['-c', 'exec "$0" sandbox -- "$1" -e "$2" > "$3"', codexBin, process.execPath, SANDBOX_PROBE, out],
      { encoding: 'utf8', cwd: REPO, env: cleanEnv(leaked), timeout: 60000 })
    assert.equal(r.status, 0, r.stderr)
    const seen = JSON.parse(readFileSync(out, 'utf8').trim().split('\n').pop())
    assert.deepEqual(seen.real, { provider: 'codex', source: 'ancestor' }, 'the codex process is the sandboxed command\'s parent')
    assert.equal(seen.envOnly.provider, 'codex', 'CODEX_SANDBOX_NETWORK_DISABLED (set by Codex in its sandbox) beats the leaked CLAUDECODE')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
