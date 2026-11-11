import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'

// The owner hardens its own control files to umask 077. The payload must still
// see the caller's umask. These checks use the pure predicate, static source
// order, argument refusal before any filesystem access, and ONE ordinary
// immediate-success payload per caller umask. No nesting, timeout, descendant,
// overflow, symlink or race scenario is exercised here.
const helper = fileURLToPath(new URL('../core/skills/verify/capture-owner.sh', import.meta.url))
const source = fs.readFileSync(helper, 'utf8')

function pure(script, args = []) {
  const result = spawnSync('bash', ['-c', 'source "$1"; shift; ' + script, 'pure', helper, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

await test('payload umask predicate accepts only the four-digit octal shape the builtin prints', () => {
  for (const ok of ['0022', '0027', '0077', '0000', '0777']) assert.equal(pure('co_umask "$1" || exit 1', [ok]), '', ok)
  // Adjacent shapes that must not match: short, long, non-octal, signed, padded, newline-terminated.
  for (const bad of ['', '022', '22', '00022', '0088', '0822', '7022', '-022', '0o22', '0x22', '0022\n', ' 0022', '0022 ', '00 22']) {
    assert.equal(pure('co_umask "$1" && exit 1; :', [bad]), '', JSON.stringify(bad))
  }
})

await test('owner captures the caller umask before hardening and hands it only to the anchor argv', () => {
  const root = source.slice(source.indexOf('co_root() {'), source.indexOf('co_main() {'))
  const capture = root.indexOf('payload_umask=$(umask) && co_umask "$payload_umask" || return 125')
  const harden = root.indexOf('\n  umask 077\n')
  assert.ok(capture >= 0 && harden >= 0 && capture < harden, 'capture precedes owner hardening')
  assert.equal(root.match(/umask 077/g).length, 1, 'owner hardens exactly once and never restores the caller umask itself')
  assert.ok(root.includes('anchor "$leaf" "$payload_umask" -- "$@" {STOP_FD}>&- {GRANT_FD}>&- {RELEASE_FD}>&- &'))
})

await test('anchor restores the caller umask for the payload line only and re-hardens before status writes', () => {
  const anchor = source.slice(source.indexOf('co_anchor() {'), source.indexOf('# Checks local root identity'))
  const first = anchor.indexOf('umask 077 || exit 125')
  const grant = anchor.indexOf('[[ $grant == GO ]] || exit 125')
  const restore = anchor.indexOf('\n  umask "$payload_umask" || exit 125\n')
  const payload = anchor.indexOf('\n  VERIFY_CAPTURE_SCOPE_DIR=$leaf "$@" </dev/null 2>&1\n')
  const code = anchor.indexOf('code=$?')
  const rehard = anchor.lastIndexOf('umask 077 || exit 125')
  const status = anchor.indexOf('.status.pending')
  assert.ok(first >= 0 && first < grant, 'anchor hardens before opening any control fifo')
  assert.ok(grant < restore && restore < payload, 'caller umask applies only after the single grant')
  assert.ok(payload < code && code < rehard && rehard < status, 'anchor re-hardens before publishing status')
  assert.ok(anchor.indexOf('co_umask "$payload_umask" || exit 125') < first, 'anchor validates the token first')
})

await test('anchor refuses old grammar and malformed umask tokens before touching any directory', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'payload-umask-args-')))
  const leaf = join(dir, 'absent-leaf')
  try {
    const cases = [
      ['anchor', leaf, '--', 'true'], // pre-token grammar
      ['anchor', leaf, '0022', 'true'], // missing delimiter
      ['anchor', leaf, '0022', '--'], // missing payload
      ['anchor', leaf, '', '--', 'true'],
      ['anchor', leaf, '022', '--', 'true'],
      ['anchor', leaf, '0x22', '--', 'true'],
      ['anchor', leaf, '0022\n', '--', 'true'],
    ]
    for (const args of cases) {
      const result = spawnSync('bash', [helper, ...args], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 125, JSON.stringify(args))
      assert.equal(result.stdout, '', JSON.stringify(args))
    }
    assert.deepEqual(fs.readdirSync(dir), [], 'refusal created nothing')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// One ordinary immediate-success payload per caller umask: it prints its own
// umask and creates one ordinary file. The caller shell sets the umask, so the
// test process umask is never changed and other test files are unaffected.
// A joined run (hint present) would detach from an outer capture, so skip then.
if (Object.hasOwn(process.env, 'VERIFY_CAPTURE_SCOPE_DIR')) {
  console.log('  skip payload umask runtime case: VERIFY_CAPTURE_SCOPE_DIR is set (inside an outer capture)')
} else {
  for (const [mask, fileMode] of [['0027', 0o640], ['0000', 0o666]]) {
    await test(`ordinary payload sees caller umask ${mask} while control artifacts stay private`, () => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'payload-umask-run-')))
      const leaf = join(root, 'leaf')
      const out = join(root, 'out')
      const file = join(out, 'payload-file')
      fs.mkdirSync(leaf, { mode: 0o700 }); fs.chmodSync(leaf, 0o700)
      fs.mkdirSync(out, { mode: 0o700 })
      try {
        const result = spawnSync('bash', [
          '-c', 'umask "$1"; shift; exec bash "$@"', 'caller', mask,
          helper, 'run', leaf, '--', 'bash', '-c', 'umask; : > "$1"', 'payload', file,
        ], { encoding: 'utf8', timeout: 30000 })
        assert.equal(result.error, undefined)
        assert.equal(result.signal, null)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, mask + '\n')
        assert.equal(fs.statSync(file).mode & 0o777, fileMode, 'ordinary payload file uses the caller umask')
        assert.equal(fs.statSync(leaf).mode & 0o777, 0o700)
        const entries = fs.readdirSync(leaf)
        for (const name of ['scope-v1.tsv', 'stop', '.status', '.settled']) assert.ok(entries.includes(name), name)
        assert.ok(!entries.includes('.incomplete'), 'ordinary success is not incomplete')
        for (const name of entries) assert.equal(fs.lstatSync(join(leaf, name)).mode & 0o777, 0o600, name)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })
  }
}

if (!Object.hasOwn(process.env, 'VERIFY_CAPTURE_SCOPE_DIR')) {
  await test('Bash retention preserves caller umask without exposing its evidence files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'retention-payload-umask-')))
    const retention = fileURLToPath(new URL('../core/skills/verify/retention.sh', import.meta.url))
    const payload = join(root, 'ordinary-file')
    const call = args => spawnSync('bash', ['-c', 'umask 0027; exec bash "$@"', 'caller', retention, ...args], { encoding: 'utf8', timeout: 30000 })
    try {
      const init = call(['init', root, ''])
      assert.equal(init.status, 0, init.stderr)
      const run = init.stdout.trim()
      const step = call(['step', run, 'ordinary', '--', 'bash', '-c', 'umask; : > "$1"', 'payload', payload])
      assert.equal(step.status, 0, step.stderr)
      assert.equal(fs.readFileSync(step.stdout.trim(), 'utf8'), '0027\n')
      assert.equal(fs.statSync(payload).mode & 0o777, 0o640)
      assert.equal(fs.statSync(step.stdout.trim()).mode & 0o777, 0o600)
      assert.equal(call(['finalize', run, run]).status, 0)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}
