// The note every source-only leaf is given must be true of the `exec` isolate it names. Observed live (docs/evidence/codex-security-audit-hardening-2026-11-23.md):
// the isolate has no `atob`, `Buffer` or `TextDecoder`. The decoder in the note is run here in a context that has only what the isolate has.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { test } from '../../../scripts/workflow-harness.mjs'
import { BASE64_DECODER_SOURCE, READER_NOTE } from '../skills/security-audit/native-codex.mjs'

// Only the globals the isolate was observed to have that the decoder needs; every other global is absent, so a use of atob/Buffer/TextDecoder would throw.
const isolate = () => vm.createContext({ escape, decodeURIComponent, String, Array, Object })
const decode = b64 => vm.runInContext(`${BASE64_DECODER_SOURCE}; decode(${JSON.stringify(b64)})`, isolate())
const b64 = text => Buffer.from(text, 'utf8').toString('base64')

await test('the note does not tell a leaf to use atob, and it carries the decoder it names', () => {
  assert.ok(!/decode with `atob`/.test(READER_NOTE), 'the old instruction named a function the isolate lacks')
  assert.ok(READER_NOTE.includes(BASE64_DECODER_SOURCE))
  assert.match(READER_NOTE, /`atob`, `Buffer` and `TextDecoder` do not exist in `exec`/)
})

await test('the decoder reproduces base64 of ASCII, multi-byte UTF-8, padding variants and the empty string without atob, Buffer or TextDecoder', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'console.log("hi")\n', 'é', 'naïve café — 日本語 😀', '\u0000\u0001\u007f', 'x'.repeat(1000)]) assert.equal(decode(b64(text)), text, JSON.stringify(text.slice(0, 20)))
  assert.throws(() => vm.runInContext('atob("YQ==")', isolate()), /atob is not defined/)
  assert.throws(() => vm.runInContext('Buffer.from("a")', isolate()), /Buffer is not defined/)
})

await test('a range that cuts a multi-byte character, and bytes that are not UTF-8, decode to the byte string instead of throwing', () => {
  // read_source serves byte ranges, so a page can end inside a character; a valid UTF-8 file must not make the decoder throw.
  const bytes = Buffer.from('ab\u00e9cd\u65e5\u672c', 'utf8')            // a b [c3 a9] c d [e6 97 a5] [e6 9c ac]
  for (const cut of [3, 7, 8, 10]) {                                  // each cut falls inside a character
    const page = decode(bytes.subarray(0, cut).toString('base64'))
    assert.equal(typeof page, 'string')
    assert.ok(page.startsWith('ab'), `the ASCII prefix survives a cut at ${cut}`)
  }
  assert.equal(decode(Buffer.from([0xff, 0xfe, 0x41]).toString('base64')), '\u00ff\u00feA', 'not UTF-8: the byte string, never an exception')
  assert.equal(decode(bytes.toString('base64')), 'ab\u00e9cd\u65e5\u672c', 'a whole character range is still decoded as UTF-8')
})
