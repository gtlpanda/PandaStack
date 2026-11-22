// decision-launch.test.mjs guards against the autobuild loop writing its gate cache into real
// state. Under the parallel runner each child gets a private, empty AUTOBUILD_STATE_HOME; the
// guard must still watch the real default (XDG_STATE_HOME, then ~/.local/state). This runs the
// real decision-launch.test.mjs through the real pool with a preload that simulates a leak
// into XDG_STATE_HOME, and expects the guard to fail. (bughunt F1 on #80, kept as a regression.)
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, NO_LINUX_STORES, test } from '../scripts/workflow-harness.mjs'
import { runPool } from '../scripts/workflow-pool.mjs'

const listDir = dir => { try { return readdirSync(dir) } catch { return [] } }

await test('decision-launch\'s leak guard sees a gate cache written to the real state dir under the pool', { skip: NO_LINUX_STORES }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-launch-leak-guard-'))
  try {
    const home = join(dir, 'home'), xdg = join(dir, 'xdg')
    mkdirSync(home); mkdirSync(xdg)
    const preload = join(dir, 'leak-preload.mjs')
    writeFileSync(preload, `
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const leakDir = path.join(process.env.XDG_STATE_HOME, 'autobuild', 'gate')
const rename = fs.renameSync
fs.renameSync = function (from, to, ...rest) {
  const result = rename.call(this, from, to, ...rest)
  const dest = String(to)
  if (/[\\\\/]autobuild[\\\\/]gate[\\\\/][^\\\\/]+\\.json$/.test(dest) && !dest.startsWith(leakDir)) {
    fs.mkdirSync(leakDir, { recursive: true })
    fs.copyFileSync(dest, path.join(leakDir, path.basename(dest)))
  }
  return result
}
syncBuiltinESMExports()
`)
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: xdg,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() }
    delete env.AUTOBUILD_STATE_HOME
    let out = ''
    const total = await runPool([join(REPO, 'tests', 'decision-launch.test.mjs')], { jobs: 1, cwd: REPO, env, labelOf: f => f.slice(REPO.length + 1), write: t => { out += t } })
    assert.ok(listDir(join(xdg, 'autobuild', 'gate')).length > 0, `the simulated leak reached the real state dir\n${out}`)
    assert.ok(total.pass > 0, `decision-launch ran\n${out}`)
    assert.ok(total.fail > 0 && /FAIL the loop's gate cache goes to a private state home/.test(out),
      `the leak guard did not notice a gate-cache file in the real state dir\n${out}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
