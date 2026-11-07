// install-skip-symlinked-dir.test.mjs — a user whose ~/.claude/commands is their own symlink
// must still be able to install: a plain install at the merge-base worked, and a target named
// in --skip is not guarded or touched. guard_layout must not abort the whole install.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

test('install.sh still installs when ~/.claude/commands is a symlink (directly or via --skip=commands)', () => {
  const root = mkdtempSync(join(tmpdir(), 'install-skip-symlink-'))
  try {
    const home = join(root, 'claude')
    const mine = join(root, 'my-commands')
    mkdirSync(home, { recursive: true })
    mkdirSync(mine)
    writeFileSync(join(mine, 'mine.md'), 'my own command\n')
    symlinkSync(mine, join(home, 'commands'))
    const install = args => spawnSync('bash', [join(REPO, 'install.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, HARNESS_NO_GIT_CONFIG: '1' },
    })
    let r = install([])
    if (r.status !== 0) r = install(['--skip=commands'])   // the user's opt-out must be honored
    assert.equal(r.status, 0,
      `BUGHUNT-F12 install.sh aborts on the symlinked commands dir, even with --skip=commands: ${r.stderr}`)
    assert.equal(lstatSync(join(home, 'skills', 'verify')).isSymbolicLink(), true,
      'BUGHUNT-F12 skills were not linked')
    assert.equal(readFileSync(join(mine, 'mine.md'), 'utf8'), 'my own command\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
