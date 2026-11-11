import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'

const retention = fileURLToPath(new URL('../core/skills/verify/retention.sh', import.meta.url))

// Inert retained manifests only: no tasks, capture owner, signals or lifecycle
// are started. The frozen acceptance owns actual ordinary nested-success proof.
for (const parent of ['evidence', 'verify\\logs']) {
  await test(`Bash finalize retains exact child bytes and digest under ${parent}`, () => {
    const base = fs.mkdtempSync(join(tmpdir(), 'verify-literal-parent-'))
    try {
      fs.chmodSync(base, 0o700)
      const root = join(base, parent)
      const child = join(root, 'run.child')
      fs.mkdirSync(root, { mode: 0o700 })
      fs.mkdirSync(child, { mode: 0o700 })
      const bytes = Buffer.from('{"schemaVersion":1,"steps":[]}\n')
      fs.writeFileSync(join(child, 'manifest.json'), bytes, { mode: 0o600 })
      fs.writeFileSync(join(root, '.steps'), '', { mode: 0o600 })
      const env = { ...process.env }
      for (const key of ['BASH_ENV', 'ENV', 'VERIFY_CAPTURE_SCOPE_DIR', 'VERIFY_CAPTURE_SESSION']) delete env[key]
      const result = spawnSync('/bin/bash', [retention, 'finalize', root, root], {
        env, encoding: 'utf8', timeout: 5000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      const manifest = join(root, 'manifest.json')
      const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      assert.deepEqual(doc, {
        schemaVersion: 1, steps: [], children: [{
          path: 'run.child/manifest.json',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length, complete: true,
        }],
      })
      assert.match(doc.children[0].sha256, /^[0-9a-f]{64}$/)
      assert.deepEqual(fs.readFileSync(join(child, 'manifest.json')), bytes)
      assert.equal(fs.lstatSync(manifest).mode & 0o777, 0o600)
      assert.equal(fs.lstatSync(manifest).isSymbolicLink(), false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
}
