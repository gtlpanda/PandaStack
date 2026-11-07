// render.test.mjs — kit/skills/render/render name resolution and error paths, against a fake
// curl on PATH (no network): an exact name beats a substring, a unique substring resolves, bad
// ids never reach the API, and a broken grep pattern is still an error.
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const RENDER = join(REPO, 'kit', 'skills', 'render', 'render')

// Logs every URL it is asked for, then answers from a fixed table.
const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
echo "$url" >> "$CURL_LOG"
case "$url" in
  */services?limit=100)
    echo '[{"service":{"id":"srv-1","name":"api"}},{"service":{"id":"srv-2","name":"api-internal"}},{"service":{"id":"srv-3","name":"worker"}}]' ;;
  */services/srv-1/env-vars*) echo '[{"envVar":{"key":"API_KEY_NAME"}}]' ;;
  */services/srv-3/env-vars*) echo '[{"envVar":{"key":"WORKER_KEY_NAME"}}]' ;;
  */logs*) echo '{"logs":[{"timestamp":"t1","message":"hello"}],"hasMore":false}' ;;
  *) echo '{}' ;;
esac
`

function render(args) {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  try {
    writeFileSync(join(dir, 'curl'), FAKE_CURL); chmodSync(join(dir, 'curl'), 0o755)
    const keyFile = join(dir, 'api-key'); writeFileSync(keyFile, 'rnd_test'); chmodSync(keyFile, 0o600)
    const log = join(dir, 'curl.log'); writeFileSync(log, '')
    const r = spawnSync('bash', [RENDER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RENDER_API_KEY_FILE: keyFile, CURL_LOG: log },
    })
    return { ...r, urls: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('render: an exact name wins over services that merely contain it', () => {
  const r = render(['env', 'api'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /API_KEY_NAME/)
  assert.ok(!r.urls.some(u => u.includes('srv-2')), 'api-internal is not touched')
})

test('render: a unique substring resolves; an ambiguous one names every match', () => {
  const w = render(['env', 'work'])
  assert.equal(w.status, 0, w.stderr)
  assert.match(w.stdout, /WORKER_KEY_NAME/)
  const a = render(['env', 'ap'])
  assert.equal(a.status, 1)
  assert.match(a.stderr, /"ap" is ambiguous; it matches 2 services: api, api-internal/)
})

test('render: an id with anything but letters and digits never reaches the API', () => {
  for (const bad of ['srv-1/env-vars', 'srv-1?x=1', 'srv-', 'name/../env-vars']) {
    const r = render(['service', bad])
    assert.equal(r.status, 1, `${bad}: ${r.stdout}`)
    assert.equal(r.urls.length, 0, `${bad} requested ${r.urls}`)
  }
  const ok = render(['service', 'srv-1'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(ok.urls[0].endsWith('/services/srv-1'))
})

test('render: logs --grep with a matching line prints it; a broken pattern is still an error', () => {
  const hit = render(['logs', 'srv-1', '--grep', 'hel+o'])
  assert.equal(hit.status, 0, hit.stderr)
  assert.match(hit.stdout, /t1 {2}hello/)
  assert.match(hit.stderr, /1 log lines/)
  const broken = render(['logs', 'srv-1', '--grep', '('])
  assert.notEqual(broken.status, 0, 'grep exit 2 (bad pattern) is not swallowed')
})
