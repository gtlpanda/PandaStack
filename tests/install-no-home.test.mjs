// install-no-home.test.mjs — install.sh must not need $HOME when CLAUDE_CONFIG_DIR names the target
// (a container or cron run that sets only that); the PATH link is then skipped with a note.
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

test('install.sh with CLAUDE_CONFIG_DIR set and HOME unset installs, and skips the PATH link with a note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-no-home-'))
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, HARNESS_NO_GIT_CONFIG: '1' }
    delete env.HOME
    delete env.PANDASTACK_BIN_DIR
    const r = spawnSync('bash', [join(REPO, 'install.sh'), '--dry-run'], { encoding: 'utf8', env })
    assert.equal(r.status, 0, `BUGHUNT-F18 install.sh needs HOME although CLAUDE_CONFIG_DIR is set (exit ${r.status}): ${r.stderr}`)
    assert.doesNotMatch(r.stderr, /unbound variable/, `BUGHUNT-F18 install.sh hit an unbound variable: ${r.stderr}`)
    assert.match(r.stdout + r.stderr, /PANDASTACK_BIN_DIR/, 'it says how to get the PATH link')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
