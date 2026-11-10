import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'

const helper = fileURLToPath(new URL('../core/skills/verify/capture-owner.sh', import.meta.url))
await test('shared capture owner is executable for installed verification', () => {
  fs.accessSync(helper, fs.constants.X_OK)
})
function pure(script, args = []) {
  const result = spawnSync('bash', ['-c', 'source "$1"; shift; ' + script, 'pure', helper, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
const wire = ['1','11111111-2222-3333-4444-555555555555','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','101','9007199254740993','202','9007199254740995','202'].join('\t') + '\n'
await test('Bash scope parser accepts exact records and preserves string birth tokens', () => {
  assert.equal(pure('co_parse_record "$1" || exit 1; printf "%s %s %s" "$CO_SCOPE_ID" "$CO_OWNER_START" "$CO_ANCHOR_START"', [wire]), '11111111-2222-3333-4444-555555555555 9007199254740993 9007199254740995')
})
await test('Bash scope parser rejects delimiter, integer, UUID and length defects', () => {
  const invalid = [wire.slice(0,-1), wire+'\n',wire.replace('\n','\r\n'),wire.replace('\t','\t\t'),wire.replace('101','01'),wire.replace('101','2147483648'),wire.replace('9007199254740993','0'),wire.replace('aaaaaaaa','AAAAAAAA'),wire.replace('9007199254740993','9'.repeat(21)), 'x'.repeat(257)]
  for (const text of invalid) assert.equal(pure('if co_parse_record "$1"; then exit 1; fi', [text]), '')
})
await test('Bash pure close rules deny pending grants and retain first incomplete failure', () => {
  assert.equal(pure('CO_CLOSING=0; CO_FAILURE=""; co_latch first; co_latch second; co_can_grant && exit 1; printf "%s:%s" "$CO_CLOSING" "$CO_FAILURE"'), '1:first')
})
await test('Bash pure identity checks bind signal authority to captured local birth and group', () => {
  assert.equal(pure('co_identity_matches 202 9007199254740995 202 202 9007199254740995 202 S || exit 1; co_identity_matches 202 9007199254740995 202 202 1 202 S && exit 1; co_identity_matches 202 9 202 202 9 202 Z && exit 1; :'), '')
})
await test('Bash normal completion needs both known empty membership and settled endpoints', () => {
  assert.equal(pure('co_settled empty yes || exit 1; co_settled unknown yes && exit 1; co_settled populated yes && exit 1; co_settled empty no && exit 1; :'), '')
})

await test('Bash path validator rejects nonliteral normalized paths, aliases and nonprivate leaves', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'capture-path-'))
  const leaf = join(root, 'literal space')
  fs.mkdirSync(leaf, { mode: 0o700 })
  fs.symlinkSync(leaf, join(root, 'alias'))
  try {
    assert.equal(pure('co_path "$1" || exit 1', [leaf]), '')
    for (const path of [leaf + '/', leaf + '/.', root + '//literal space', join(root, 'alias'), 'relative']) {
      assert.equal(pure('co_path "$1" && exit 1; :', [path]), '')
    }
    fs.chmodSync(leaf, 0o755)
    assert.equal(pure('co_path "$1" && exit 1; :', [leaf]), '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
await test('Bash root signal identity ignores record identity and rejects stale observations', () => {
  assert.equal(pure(`
    LOCAL_ANCHOR_PID=202 LOCAL_ANCHOR_START=99 LOCAL_PGID=202 LOCAL_OWNER_PID=101
    CO_ANCHOR_PID=999 CO_ANCHOR_START=1 CO_PGID=999
    co_proc() { CO_PROC_PID=$1 CO_PROC_START=99 CO_PROC_PGID=202 CO_PROC_STATE=S CO_PROC_PARENT=101; }
    co_local_anchor || exit 1
    co_proc() { CO_PROC_PID=$1 CO_PROC_START=98 CO_PROC_PGID=202 CO_PROC_STATE=S CO_PROC_PARENT=101; }
    co_local_anchor && exit 1
    :
  `), '')
})

await test('Bash join relation vectors bind boot, live births, group and full current ancestry', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'capture-relations-'))
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  const record = wire.replace('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', boot)
  fs.writeFileSync(join(root, 'scope-v1.tsv'), record, { mode: 0o600 })
  const setup = `
    co_capabilities() { :; }; co_path() { :; }; co_file() { :; }
    current=$BASHPID
    owner_start=9007199254740993 observed_owner_group=90 owner_state=S
    anchor_start=9007199254740995 anchor_parent=101 anchor_group=202 anchor_state=S
    current_group=202 current_state=S current_parent=303 middle_parent=202 middle_group=202 middle_state=S
    co_proc() {
      CO_PROC_PID=$1
      case $1 in
        101) CO_PROC_PARENT=1 CO_PROC_START=$owner_start CO_PROC_PGID=$observed_owner_group CO_PROC_STATE=$owner_state ;;
        202) CO_PROC_PARENT=$anchor_parent CO_PROC_START=$anchor_start CO_PROC_PGID=$anchor_group CO_PROC_STATE=$anchor_state ;;
        303) CO_PROC_PARENT=$middle_parent CO_PROC_START=99 CO_PROC_PGID=$middle_group CO_PROC_STATE=$middle_state ;;
        "$current") CO_PROC_PARENT=$current_parent CO_PROC_START=100 CO_PROC_PGID=$current_group CO_PROC_STATE=$current_state ;;
        *) return 1 ;;
      esac
    }
  `
  try {
    assert.equal(pure(setup + 'capture_join "$1" || exit 1', [root]), '')
    for (const mutation of [
      'owner_start=1', 'observed_owner_group=202', 'owner_state=Z', 'anchor_start=1',
      'anchor_parent=9', 'anchor_group=303', 'anchor_state=X', 'current_group=303',
      'current_state=Z', 'current_parent=9', 'middle_parent=303', 'middle_group=303', 'middle_state=X',
    ]) assert.equal(pure(setup + mutation + '; capture_join "$1" && exit 1; :', [root]), '', mutation)
    fs.writeFileSync(join(root, 'scope-v1.tsv'), wire, { mode: 0o600 })
    assert.equal(pure(setup + 'capture_join "$1" && exit 1; :', [root]), '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
