// merge-settings.test.mjs — the statusLine rules of scripts/merge-settings.mjs: filled only when
// a person has none and its script is installed; removed on unmerge only while it is still ours.
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { mergeSettings, unmergeSettings } from '../scripts/merge-settings.mjs'

const OURS = {
  model: 'opus',
  statusLine: { type: 'command', command: '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/bin/statusline.sh"' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node gate.mjs' }] }] },
}

test('merge fills statusLine only when theirs has none, and never with statusLine: false', () => {
  assert.deepEqual(mergeSettings(OURS, {}).settings.statusLine, OURS.statusLine)
  assert.ok(mergeSettings(OURS, {}).added.includes('statusLine'))
  const mine = { type: 'command', command: 'my-line' }
  assert.deepEqual(mergeSettings(OURS, { statusLine: mine }).settings.statusLine, mine)
  const off = mergeSettings(OURS, {}, { statusLine: false })
  assert.equal(off.settings.statusLine, undefined)
  assert.ok(!off.added.includes('statusLine'))
  assert.equal(off.settings.model, 'opus', 'other keys still fill')
})

test('unmerge removes our statusLine (key order ignored) but keeps one a person changed or owns', () => {
  const reordered = { command: OURS.statusLine.command, type: 'command' }
  const r = unmergeSettings(OURS, { model: 'mine', statusLine: reordered })
  assert.equal(r.settings.statusLine, undefined)
  assert.deepEqual(r.removed, ['statusLine'])
  assert.equal(r.settings.model, 'mine')
  const tuned = { ...OURS.statusLine, padding: 2 }
  assert.deepEqual(unmergeSettings(OURS, { statusLine: tuned }).settings.statusLine, tuned)
  const own = { type: 'command', command: '~/.claude/bin/statusline.sh' }
  assert.deepEqual(unmergeSettings(OURS, { statusLine: own }).settings.statusLine, own)
  assert.deepEqual(unmergeSettings({ model: 'x' }, { statusLine: own }).removed, [], 'no statusLine of ours: nothing to remove')
})

test('the CLI takes --no-statusline for merge only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-settings-'))
  try {
    const ours = join(dir, 'ours.json'), theirs = join(dir, 'theirs.json')
    writeFileSync(ours, JSON.stringify(OURS)); writeFileSync(theirs, '{}')
    const run = args => spawnSync(process.execPath, [join(REPO, 'scripts', 'merge-settings.mjs'), ...args], { encoding: 'utf8' })
    const m = run(['merge', '--no-statusline', ours, theirs])
    assert.equal(m.status, 0, m.stderr)
    assert.equal(JSON.parse(m.stdout).statusLine, undefined)
    assert.match(m.stderr, /added: hooks\.PreToolUse/)
    assert.equal(run(['unmerge', '--no-statusline', ours, theirs]).status, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
