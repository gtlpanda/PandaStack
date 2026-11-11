import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { catalogPathsEqual as equal, catalogPathContains as contains } from '../core/skills/native-runtime/catalog-paths.mjs'

const root = String.raw`\\wsl$\Ubuntu-24.04\home\gtlpanda\PandaStack`
const alias = String.raw`\\wsl.localhost\Ubuntu-24.04\home\gtlpanda\PandaStack`
const extended = String.raw`\\?\UNC\wsl.localhost\Ubuntu-24.04\home\gtlpanda\PandaStack`

await test('catalog recognizes only reserved Windows WSL host aliases after resolution', () => {
  for (const value of [alias, extended, root.replace('wsl$', 'WSL$')]) {
    assert.equal(equal(root, value, 'win32'), true)
    assert.equal(equal(value, root, 'win32'), true)
    assert.equal(contains(root, value, 'win32'), true)
    assert.equal(contains(value, root, 'win32'), true)
  }
})

await test('WSL distro and Linux tail case remain exact in link and containment comparisons', () => {
  for (const value of [alias.replace('Ubuntu-24.04', 'Debian'), alias.replace('Ubuntu', 'ubuntu'),
    alias.replace('PandaStack', 'pandastack'), alias.replace('gtlpanda', 'Gtlpanda'),
    alias + '-sibling', alias.replace('wsl.localhost', 'wsl.localhost.example'),
    alias.replace('wsl.localhost', 'server')]) {
    assert.equal(equal(root, value, 'win32'), false, value)
    assert.equal(contains(root, value, 'win32'), false, value)
    assert.equal(contains(value, root, 'win32'), false, value)
  }
})

await test('WSL containment follows complete case-sensitive components and permits descendants', () => {
  const child = alias + String.raw`\core\skills\verify`
  assert.equal(contains(root, child, 'win32'), true)
  assert.equal(contains(root + '\\', child, 'win32'), true)
  assert.equal(contains(child, root, 'win32'), false)
  assert.equal(equal(root, child, 'win32'), false)
  assert.equal(contains(root, alias.replace('PandaStack', 'pandastack') + '\\core', 'win32'), false)
  assert.equal(contains(root, alias + '-sibling\\core', 'win32'), false)
  assert.equal(contains(String.raw`\\wsl$\Ubuntu-24.04` + '\\', child, 'win32'), true)
})

await test('malformed unresolved WSL components cannot create comparison authority', () => {
  for (const value of [String.raw`\\wsl$` + '\\', root + '\\..\\elsewhere', root + '\\.\\core', root + '\\\\core']) {
    assert.equal(equal(value, value, 'win32'), false)
    assert.equal(contains(value, value, 'win32'), false)
    assert.equal(contains(root, value, 'win32'), false)
  }
})

await test('ordinary Windows directories retain existing comparison behavior', () => {
  const base = String.raw`C:\Tools\PandaStack`
  assert.equal(equal(base, base, 'win32'), true)
  assert.equal(equal(base, base.toLowerCase(), 'win32'), false)
  assert.equal(contains(base, String.raw`c:\tools\pandastack\core`, 'win32'), true)
  assert.equal(contains(base, String.raw`C:\Tools\PandaStack-other\core`, 'win32'), false)
  assert.equal(contains(base, String.raw`D:\Tools\PandaStack\core`, 'win32'), false)
  assert.equal(equal(String.raw`\\server\share\core`, String.raw`\\other\share\core`, 'win32'), false)
})

await test('native Linux paths keep exact containment without Windows alias interpretation', () => {
  assert.equal(contains('/home/panda/PandaStack', '/home/panda/PandaStack/core', 'linux'), true)
  assert.equal(contains('/home/panda/PandaStack', '/home/panda/pandastack/core', 'linux'), false)
  assert.equal(contains('/home/panda/PandaStack', '/home/panda/PandaStack-other/core', 'linux'), false)
  assert.equal(equal(root, alias, 'linux'), false)
  assert.equal(contains(root, alias, 'linux'), false)
})
