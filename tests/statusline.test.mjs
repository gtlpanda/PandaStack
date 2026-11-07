// statusline.test.mjs — core/bin/statusline.sh: the ~-shortened working directory.
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const SCRIPT = join(REPO, 'core', 'bin', 'statusline.sh')

function statusline(home, dir) {
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({ workspace: { current_dir: dir } }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home },
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

test('statusline shortens HOME itself and paths under it to ~', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'statusline-'))
  try {
    assert.ok(statusline('/home/bob', '/home/bob').startsWith('~'), 'BUGHUNT-F6 HOME itself is shown as ~')
    assert.ok(statusline('/home/bob', '/home/bob/project').startsWith('~/project'), 'BUGHUNT-F6 a path under HOME is shown as ~/...')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('statusline does not shorten a sibling directory that merely shares the HOME prefix', () => {
  const out = statusline('/home/bob', '/home/bobby/project')
  assert.ok(out.startsWith('/home/bobby/project'),
    `BUGHUNT-F6 sibling /home/bobby/project must not be shortened to ~by/project, got: ${out}`)
})
