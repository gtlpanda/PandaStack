// uninstall-no-home-local-bin.test.mjs — with HOME and PANDASTACK_BIN_DIR unset there is no LOCAL_BIN,
// so --uninstall must not restore a local-bin/* backup entry to "/<name>"; it skips it with a note.
// Runs --dry-run so a buggy install.sh only prints the mv it would have run against "/".
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

import { test, REPO } from '../scripts/workflow-harness.mjs'

test('install.sh --uninstall with no HOME and no PANDASTACK_BIN_DIR does not restore local-bin/* to /', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uninstall-no-home-'))
  try {
    const backup = join(dir, 'backups', '20240101-000000')
    mkdirSync(join(backup, 'local-bin'), { recursive: true })
    writeFileSync(join(backup, 'local-bin', 'autobuild'), '#!/bin/sh\necho foreign\n')
    writeFileSync(join(backup, '.harness-manifest'), 'local-bin/autobuild\n')

    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, HARNESS_NO_GIT_CONFIG: '1' }
    delete env.HOME
    delete env.PANDASTACK_BIN_DIR
    const r = spawnSync('bash', [join(REPO, 'install.sh'), '--uninstall', '--dry-run'], { encoding: 'utf8', env })
    const out = r.stdout + r.stderr

    assert.ok(!existsSync('/autobuild'), 'test precondition: /autobuild must not exist on this machine')
    assert.doesNotMatch(out, /\[dry-run\] mv \S*local-bin\/autobuild \/autobuild/,
      `BUGHUNT-F24 uninstall would mv the local-bin backup to /autobuild: ${out}`)
    assert.doesNotMatch(out, /\[dry-run\] mkdir -p \/$/m,
      `BUGHUNT-F24 uninstall would mkdir -p / for the local-bin backup: ${out}`)
    assert.equal(r.status, 0, `BUGHUNT-F24 uninstall failed (exit ${r.status}): ${out}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
