// install-tests-isolate-home.test.mjs — the tests that run install.sh must not touch the real
// $HOME: install.sh links autobuild into $HOME/.local/bin, so a test that only sets
// CLAUDE_CONFIG_DIR would rewrite the developer's real ~/.local/bin/autobuild.
// Each install test is run here as a child with HOME pointed at a temp dir; that dir must
// come out untouched.
import { join } from 'node:path'
import { mkdtempSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

import { test, REPO } from '../scripts/workflow-harness.mjs'

const INSTALL_TESTS = ['install-skip-symlinked-dir.test.mjs', 'install-skip-bin-statusline.test.mjs']

for (const file of INSTALL_TESTS) {
  test(`${file} does not write into the inherited HOME`, () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'install-isolate-home-'))
    try {
      const env = { ...process.env, HOME: fakeHome }
      delete env.PANDASTACK_BIN_DIR
      delete env.CLAUDE_CONFIG_DIR
      const r = spawnSync(process.execPath, [join(REPO, 'tests', file)], { encoding: 'utf8', env })
      assert.equal(r.status, 0, `${file} did not run cleanly: ${r.stdout}${r.stderr}`)
      const link = join(fakeHome, '.local', 'bin', 'autobuild')
      const touched = existsSync(join(fakeHome, '.local')) || (() => { try { lstatSync(link); return true } catch { return false } })()
      assert.equal(touched, false,
        `BUGHUNT-F20 ${file} ran install.sh with the inherited HOME and linked autobuild into ${link}; it must set HOME or PANDASTACK_BIN_DIR to a temp dir`)
    } finally { rmSync(fakeHome, { recursive: true, force: true }) }
  })
}
