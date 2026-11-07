// install-skip-bin-statusline.test.mjs — install.sh --skip=bin must not merge a statusLine
// that names the bin/statusline.sh it did not link.
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

test('--skip=bin into a user\'s own settings.json does not add a statusLine for the unlinked script', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-skip-bin-'))
  try {
    const dest = join(home, 'settings.json')
    writeFileSync(dest, JSON.stringify({ model: 'sonnet' }, null, 2) + '\n')
    const r = spawnSync('bash', [join(REPO, 'install.sh'), '--skip=bin'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, HARNESS_NO_GIT_CONFIG: '1' },
    })
    assert.equal(r.status, 0, `install.sh failed: ${r.stderr}`)
    assert.equal(existsSync(join(home, 'bin', 'statusline.sh')), false, 'bin/statusline.sh must be skipped')
    const merged = JSON.parse(readFileSync(dest, 'utf8'))
    assert.equal(merged.statusLine, undefined,
      `BUGHUNT-F3 statusLine merged although bin/statusline.sh is skipped: ${JSON.stringify(merged.statusLine)}`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
