// install-tests-isolate-codex-home.test.mjs — the tests that run install.sh must not touch a real
// Codex home (BUGHUNT-F1 of the codex review gate hook). install.sh registers and trusts the review
// gate in a Codex home's hooks.json; a test with a temp HOME that inherits the developer's CODEX_HOME
// must not reach it. install.sh writes only PANDASTACK_CODEX_HOME or $HOME/.codex, and warns about a
// CODEX_HOME that names another directory, so these tests need no change of their own.
// Each install test runs here as a child with CODEX_HOME pointed at an existing temp dir (standing in
// for the real one) and a codex binary that does not exist; that dir must come out untouched.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const INSTALL_TESTS = ['install-codex.test.mjs', 'install-skip-symlinked-dir.test.mjs', 'install-skip-bin-statusline.test.mjs']

for (const file of INSTALL_TESTS) {
  await test(`${file} passes and does not write into an inherited CODEX_HOME`, () => {
    const root = mkdtempSync(join(tmpdir(), 'install-isolate-codex-home-'))
    try {
      const fakeHome = join(root, 'home')
      const fakeCodexHome = join(root, 'real-codex-home')
      mkdirSync(fakeHome)
      mkdirSync(fakeCodexHome)
      const env = { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome, PANDASTACK_CODEX_BIN: join(root, 'no-such-codex') }
      for (const k of ['PANDASTACK_BIN_DIR', 'CLAUDE_CONFIG_DIR', 'PANDASTACK_CODEX_SKILLS_DIR', 'PANDASTACK_CODEX_HOME']) delete env[k]
      const r = spawnSync(process.execPath, [join(REPO, 'tests', file)], { encoding: 'utf8', env })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /^ {2}FAIL /m, r.stdout)
      assert.deepEqual(readdirSync(fakeCodexHome), [],
        `BUGHUNT-F1 ${file} ran install.sh with the inherited CODEX_HOME and wrote into it; install.sh must not register the gate there unasked`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
