// uninstall-statusline.test.mjs — install.sh --uninstall after settings.json was
// edited following the merge: the statusLine the merge added must go too, since
// uninstall removes the bin/statusline.sh link it points at.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

test('uninstall removes the statusLine the merge added, even after settings.json was edited', () => {
  const root = mkdtempSync(join(tmpdir(), 'uninstall-statusline-'))
  try {
    const claude = join(root, 'claude')
    mkdirSync(claude, { recursive: true })
    const settings = join(claude, 'settings.json')
    writeFileSync(settings, JSON.stringify({ model: 'mine' }) + '\n')
    const env = { ...process.env, HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: claude, HARNESS_NO_GIT_CONFIG: '1' }
    const sh = args => spawnSync('bash', [join(REPO, 'install.sh'), ...args], { env, encoding: 'utf8' })

    const inst = sh([])
    assert.equal(inst.status, 0, inst.stderr)
    const merged = JSON.parse(readFileSync(settings, 'utf8'))
    assert.match(merged.statusLine?.command ?? '', /bin\/statusline\.sh/, 'setup: the merge should have added our statusLine')

    // The user edits settings.json after the merge, so it no longer equals settings.json.merged.
    merged.theme = 'dark'
    writeFileSync(settings, JSON.stringify(merged, null, 2) + '\n')

    const un = sh(['--uninstall'])
    assert.equal(un.status, 0, un.stderr)
    const link = join(claude, 'bin', 'statusline.sh')
    const linkGone = !existsSync(link) && (() => { try { lstatSync(link); return false } catch { return true } })()
    assert.ok(linkGone, 'setup: uninstall should have removed the bin/statusline.sh link')

    const after = JSON.parse(readFileSync(settings, 'utf8'))
    assert.equal(after.theme, 'dark', "the user's later edit is kept")
    assert.equal(after.model, 'mine')
    assert.equal(after.statusLine, undefined,
      'BUGHUNT-F8 uninstall left statusLine pointing at the removed bin/statusline.sh: ' + JSON.stringify(after.statusLine))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
