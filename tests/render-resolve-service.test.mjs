// render-resolve-service.test.mjs — kit/skills/render/render: name resolution.
// A fake `curl` on PATH serves two services whose names both contain "api".
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const RENDER = join(REPO, 'kit', 'skills', 'render', 'render')

const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  */services?limit=100)
    echo '[{"service":{"id":"srv-1","name":"api-public"}},{"service":{"id":"srv-2","name":"api-internal"}}]' ;;
  */services/srv-1/env-vars*) echo '[{"envVar":{"key":"PUBLIC_KEY"}}]' ;;
  */services/srv-2/env-vars*) echo '[{"envVar":{"key":"INTERNAL_KEY"}}]' ;;
  *) echo '[]' ;;
esac
`

// The script's key-file guard calls `stat -f '%Lp'` (BSD); GNU stat treats -f as
// filesystem status, so shim a `stat` that reports the mode the guard expects.
const FAKE_STAT = `#!/usr/bin/env bash
echo 600
`

test('render env with a name matching two services errors out instead of silently using the first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  try {
    writeFileSync(join(dir, 'curl'), FAKE_CURL)
    chmodSync(join(dir, 'curl'), 0o755)
    writeFileSync(join(dir, 'stat'), FAKE_STAT)
    chmodSync(join(dir, 'stat'), 0o755)
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_test')
    chmodSync(keyFile, 0o600)
    const r = spawnSync('bash', [RENDER, 'env', 'api'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RENDER_API_KEY_FILE: keyFile },
    })
    assert.notEqual(r.status, 0,
      `BUGHUNT-F5 ambiguous name "api" matched two services but the first was used silently; stdout=${JSON.stringify(r.stdout)}`)
    assert.equal(r.stdout.includes('PUBLIC_KEY'), false,
      'BUGHUNT-F5 env vars of the first match were printed for an ambiguous name')
    assert.match(r.stderr, /ambiguous|multiple|more than one/i,
      `BUGHUNT-F5 expected an ambiguity error on stderr; stderr=${JSON.stringify(r.stderr)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
