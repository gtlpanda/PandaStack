// blocks.test.mjs - blocks.mjs (graphs/security-audit/skills/security-audit/blocks.mjs): every block is a
// contiguous slice of a vendored file, byte for byte; every reference resolves or fails by name; a heading
// renamed by upstream drift fails the registry. The expected names and line numbers below are typed from
// the vendored files (grep -n of the headings), not computed by the code under test. The drift cases run
// on a temp copy; the vendored files are never written.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { VENDOR_SKILL_DIR, canonicalCoverageId, validateLedgerDocument } from '../skills/security-audit/upstream.mjs'
import { BlockError, parseRef, resolve, sections, fence, ordinary, companion, companions, schemaBranch, parts, payloadSizes, guidance } from '../skills/security-audit/blocks.mjs'

const BLOCKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'security-audit', 'blocks.mjs')

// ---------- an oracle that does not use blocks.mjs: bytes by line number ----------
const source = (file, dir = VENDOR_SKILL_DIR) => readFileSync(join(dir, file))
const lineStart = (buf, n) => { let at = 0; for (let l = 1; l < n; l += 1) at = buf.indexOf(10, at) + 1; return at }
// The bytes of lines a..b exactly as the file holds them, without the final newline.
const bytesOfLines = (file, a, b) => { const buf = source(file); return buf.subarray(lineStart(buf, a), lineStart(buf, b + 1) - 1) }
const lines = file => source(file).toString('utf8').split('\n')
function assertBytes(file, block) {
  assert.ok(Buffer.from(block.text).equals(bytesOfLines(file, block.startLine, block.endLine)), `${block.ref}: text is not lines ${block.startLine}-${block.endLine} of ${file}`)
}

const ORDINARY = [['Injection', 29, 37], ['Access control', 39, 47], ['Resource and file handling', 49, 54], ['Cryptography and secrets', 56, 62], ['Business logic', 64, 72],
  ['Feature abuse and data leakage', 74, 81], ['Chained vulnerabilities and trust boundaries', 83, 90], ['Wildcard', 92, 109], ['Obvious things', 111, 130]]
const CLASSES = {
  'AI-AND-LLM.md': ['Context, retrieval, and memory attack classes', 'Tool and action attack classes', 'MCP and sub-agent trust classes', 'Output and disclosure attack classes'],
  'CLIENT-SIDE.md': ['DOM and object-state attack classes', 'Cross-origin messaging and network attack classes', 'Service-worker and browser-storage attack classes', 'Cross-site information leak classes', 'UI-redress and navigation attack classes'],
  'CLOUD-AND-DEPLOYMENT.md': ['Workload identity and IAM attack classes', 'Ingress, network, and control-plane attack classes', 'Container and orchestration attack classes', 'Configuration and secret lifecycle attack classes', 'Managed storage, events, and edge attack classes'],
  'DATA-ISOLATION-AND-LIFECYCLE.md': ['Tenant and object-isolation attack classes', 'Derived-data and disclosure attack classes', 'Export, backup, restore, and migration attack classes', 'Deletion, revocation, and lifecycle attack classes'],
  'DESKTOP-MOBILE-AND-LOCAL-IPC.md': ['Deep-link, callback, and navigation attack classes', 'Webview and native-bridge attack classes', 'Local IPC and exported-component attack classes', 'Privileged-helper and local-file attack classes', 'Application-state and device-lifecycle attack classes'],
  'MEMORY-SAFETY-AND-BINARY.md': ['Bounds, integer, and representation attack classes', 'Lifetime, type, and concurrency attack classes', 'FFI and ABI attack classes', 'Binary loading and runtime attack classes', 'Kernel and privileged-interface attack classes'],
  'PROTOCOLS-RPC-AND-MESSAGING.md': ['Framing, schema, and interpretation attack classes', 'RPC identity and authorization attack classes', 'Broker and queue isolation attack classes', 'Replay, ordering, and transaction attack classes'],
  'RESOURCE-EXHAUSTION-AND-AVAILABILITY.md': ['Computational amplification attack classes', 'Resource accumulation attack classes', 'Quota and scheduling attack classes', 'Failure and recovery attack classes'],
  'SUPPLY-CHAIN-AND-RELEASE.md': ['Dependency and build-input attack classes', 'CI and automation attack classes', 'Release and update attack classes'],
  'WEB-PROTOCOL-AND-AUTH.md': ['HTTP framing and cache attack classes', 'Browser-session attack classes', 'Federated-identity attack classes', 'MFA, passkey, and account-transition attack classes', 'API-key and mTLS attack classes'],
}
// key: [file, first line, last line] of the text between the fence lines (HUNTING.md:29-97 is the method fence, and so on).
const PARTS = {
  recon1a: ['RECONNAISSANCE.md', 12, 19], recon1b: ['RECONNAISSANCE.md', 25, 32], recon1c: ['RECONNAISSANCE.md', 38, 41], recon1d: ['RECONNAISSANCE.md', 47, 54],
  hunterMethod: ['HUNTING.md', 30, 96], promotion: ['HUNTING.md', 102, 135], validationRules: ['HUNTING.md', 141, 156], criticResult: ['HUNTING.md', 226, 242],
  verifierPrompt: ['VALIDATION-AND-REPORTING.md', 12, 45], verifierPromotion: ['VALIDATION-AND-REPORTING.md', 51, 84],
}
const SCHEMA = [['confirmed', 6, 245], ['needs_validation', 246, 362], ['rejected', 363, 458]]

// A copy of the vendored skill directory to damage. fn(copy) runs, then the copy is removed.
function withCopy(fn) {
  const root = mkdtempSync(join(tmpdir(), 'blocks-test-'))
  try { cpSync(VENDOR_SKILL_DIR, root, { recursive: true }); return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
const rewrite = (dir, file, from, to) => {
  const text = readFileSync(join(dir, file), 'utf8')
  assert.ok(text.includes(from), `${file} has no ${JSON.stringify(from)} to damage`)
  writeFileSync(join(dir, file), text.replace(from, to))
}
// The registry assertion the real tree must pass and a drifted tree must not: names, counts, line numbers.
function assertRegistry(dir) {
  assert.deepEqual(ordinary(dir), ORDINARY.map(([n]) => `ATTACK-CLASSES.md#${n}`))
  const reg = companions(dir)
  assert.deepEqual(reg.map(c => c.file), Object.keys(CLASSES))
  for (const c of reg) assert.deepEqual(c.classes, CLASSES[c.file].map(n => `${c.file}#${n}`), c.file)
}

console.log('== blocks.mjs: ordinary attack classes')
await test('the nine ordinary classes are the bold names in ATTACK-CLASSES.md, each exactly its own lines', () => {
  assert.equal(ORDINARY.length, 9)
  for (const [name, a, b] of ORDINARY) {
    const s = resolve(`ATTACK-CLASSES.md#${name}`)
    assert.deepEqual([s.startLine, s.endLine], [a, b], name)
    assert.ok(s.text.startsWith(`**${name}** (subagent_type: \`general\`)\n`), name)
    assertBytes('ATTACK-CLASSES.md', s)
  }
})
await test('the seventh class is "Chained vulnerabilities and trust boundaries" (the plan\'s short name does not resolve)', () => {
  assert.throws(() => resolve('ATTACK-CLASSES.md#Chained vulnerabilities'), /unknown block ATTACK-CLASSES\.md#Chained vulnerabilities: .*Chained vulnerabilities and trust boundaries/)
})
await test('the bold "**Important**" paragraph at line 130 stays inside Obvious things and is not a class', () => {
  const obvious = resolve('ATTACK-CLASSES.md#Obvious things')
  assert.equal(obvious.endLine, 130)
  assert.ok(obvious.text.split('\n').pop().startsWith('**Important**: '))
  assert.ok(!ordinary().some(r => r.includes('Important')))
  assert.throws(() => resolve('ATTACK-CLASSES.md#Important'), /unknown block/)
})
await test('ordinary blocks tile lines 29-130: nothing between them but blank lines, and none is split or overlapped', () => {
  const all = ordinary().map(r => resolve(r))
  const covered = new Set(all.flatMap(s => Array.from({ length: s.endLine - s.startLine + 1 }, (_, i) => s.startLine + i)))
  lines('ATTACK-CLASSES.md').forEach((l, i) => { if (i + 1 >= 29 && !covered.has(i + 1)) assert.equal(l.trim(), '', `line ${i + 1} belongs to no block: ${l.slice(0, 60)}`) })
  assert.equal(covered.size, all.reduce((n, s) => n + s.endLine - s.startLine + 1, 0), 'two blocks share a line')
  for (const s of all) assert.ok(s.text.split('\n').pop().trim() !== '', `${s.ref} ends in a blank line`)
})
await test('the preface (lines 3-27) is its own section and holds none of the classes; ordinary blocks carry no companion-style sections', () => {
  const pre = resolve('ATTACK-CLASSES.md#Attack classes — choose and split based on Phase 1')
  assert.deepEqual([pre.startLine, pre.endLine], [3, 27])
  assertBytes('ATTACK-CLASSES.md', pre)
  const names = sections('ATTACK-CLASSES.md').map(s => s.name)
  for (const fixed of ['Core discipline', 'Universal moves', 'Validation rules']) assert.ok(!names.includes(fixed), fixed)
})

console.log('== blocks.mjs: companions')
await test('the registry is the ten companions ATTACK-CLASSES.md links to: 44 class sections and 30 fixed sections, none renamed', () => {
  assertRegistry(VENDOR_SKILL_DIR)
  const reg = companions()
  assert.equal(reg.reduce((n, c) => n + c.classes.length, 0), 44)
  assert.deepEqual(reg.map(c => c.classes.length), [4, 5, 5, 4, 5, 5, 4, 4, 3, 5])
  for (const c of reg) {
    assert.deepEqual([c.core, c.universal, c.validation], [`${c.file}#Core discipline`, `${c.file}#Universal moves`, `${c.file}#Validation rules`])
    assert.equal(c.whenToUse, `${c.file}#When to use this file`)
    assert.equal(c.blocks.length, c.classes.length + 3)
    assert.ok(![c.core, c.universal, c.validation, ...c.classes].some(r => r.includes('(')), `${c.file}: a reference kept its parenthetical`)
  }
  assert.equal(reg.length * 3, 30)
})
await test('every companion block (Core discipline, each class, Universal moves, Validation rules, When to use) is exactly its own lines', () => {
  let count = 0
  for (const c of companions()) {
    for (const ref of [c.whenToUse, ...c.blocks]) { const s = resolve(ref); assertBytes(c.file, s); assert.ok(s.text.split('\n')[0].startsWith('#'), ref); count += 1 }
  }
  assert.equal(count, 10 + 30 + 44)
})
await test('a companion\'s blocks tile the file after its title: only blank lines fall between them, none overlaps, all in file order', () => {
  for (const c of companions()) {
    const found = [c.whenToUse, ...c.blocks].map(r => resolve(r))
    const covered = new Set()
    let last = 0
    for (const s of found) {
      assert.ok(s.startLine > last, `${s.ref} starts at ${s.startLine}, inside or before the previous block`)
      for (let n = s.startLine; n <= s.endLine; n += 1) covered.add(n)
      last = s.endLine
    }
    lines(c.file).forEach((l, i) => {
      if (i === 0) assert.match(l, /^# /, `${c.file}: line 1 is the title`)
      else if (!covered.has(i + 1)) assert.equal(l.trim(), '', `${c.file}:${i + 1} belongs to no block: ${l.slice(0, 60)}`)
    })
    assert.ok(found.find(s => s.ref === c.core).text.split('\n').includes('```'), `${c.file}: Core discipline holds its fence`)
  }
})
await test('Core discipline holds exactly one fence, and its text is exactly the lines between the fence lines', () => {
  for (const c of companions()) {
    const f = fence(c.core, 0)
    assert.equal(lines(c.file)[f.startLine - 2].startsWith('```'), true)
    assert.equal(lines(c.file)[f.endLine], '```')
    assertBytes(c.file, f)
    assert.throws(() => fence(c.core, 1), /has no code fence number 1 \(it has 1\)/)
  }
})

console.log('== blocks.mjs: the text later prompts carry')
await test('method, promotion, validation rules, critic JSON, verifier prompt, recon prompts: exactly the lines inside their fences', () => {
  const p = parts()
  for (const [key, [file, a, b]] of Object.entries(PARTS)) {
    assert.deepEqual([p[key].startLine, p[key].endLine], [a, b], key)
    assertBytes(file, p[key])
    assert.match(lines(file)[a - 2], /^```/, `${key}: the line before is a fence`)
    assert.equal(lines(file)[b], '```', `${key}: the line after is the closing fence`)
  }
  assert.equal(p.hunterMethod.text.split('\n')[0], '## Defensive vulnerability-finding method', 'a heading inside a fence is text, not a section')
  assert.ok(p.recon1a.text.startsWith('Read the target at <target>.') && p.recon1d.text.startsWith('Read tests, build definitions'))
})
await test('the structured hunter result is the whole section, JSON and the rules after it', () => {
  const r = parts().hunterResult
  assert.deepEqual([r.startLine, r.endLine], [168, 213])
  assertBytes('HUNTING.md', r)
  assert.ok(r.text.includes('"disposition": "covered|candidate|blocked"'))
  assert.ok(r.text.split('\n').pop().startsWith('Every assigned coverage ID appears exactly once in `units`.'))
})
await test('the record contracts are lines 103 to 109 of the Phase 4 section, whole: from the sentence about the schema to the trace rule', () => {
  const c = parts().recordContract
  assert.deepEqual([c.startLine, c.endLine], [103, 109])
  assertBytes('VALIDATION-AND-REPORTING.md', c)
  assert.ok(c.text.startsWith('Read `report-schema.json` immediately before writing.'))
  assert.ok(c.text.endsWith('Overall severity cannot exceed demonstrated impact.'))
  assert.ok(c.text.includes('A multi-step trace begins with `entrypoint`, ends with `sink`, and uses `propagation` only between them. One-entry traces use `entrypoint` or `sink`.'))
  assert.ok(c.text.includes('A `needs_validation` record uses `claimed_root_cause`') && !c.text.includes('Run:'), 'the contracts, not the commands after them')
})
await test('a drifted anchor of the record contracts fails by name, never as a shorter span', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'))
  try {
    cpSync(VENDOR_SKILL_DIR, dir, { recursive: true })
    const file = join(dir, 'VALIDATION-AND-REPORTING.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Overall severity cannot exceed demonstrated impact.', 'Overall severity is capped.'))
    assert.throws(() => parts(dir), /VALIDATION-AND-REPORTING\.md#Phase 4: Write and validate `findings\.json`: the span from "Read `report-schema\.json` immediately before writing\." to a line ending "Overall severity cannot exceed demonstrated impact\." is not there/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await test('the promotion procedure is the same bytes in HUNTING.md and in the candidate-verifier section (upstream repeats it)', () => {
  const p = parts()
  assert.equal(p.promotion.text, p.verifierPromotion.text)
  assert.ok(p.promotion.text.startsWith('Artifact promotion procedure (trusted parent-side code only):'))
  assert.equal(p.promotion.text.split('\n').length, 34)
})
await test('each schema branch is whole lines from its brace line to its closing brace, parses, and equals the parsed oneOf entry', () => {
  const schema = JSON.parse(readFileSync(join(VENDOR_SKILL_DIR, 'report-schema.json'), 'utf8'))
  SCHEMA.forEach(([verdict, a, b], i) => {
    const s = schemaBranch(verdict)
    assert.deepEqual([s.startLine, s.endLine], [a, b], verdict)
    assert.deepEqual(JSON.parse(s.text), schema.items.oneOf[i])
    assert.equal(JSON.parse(s.text).properties.verdict.const, verdict)
    // The file's lines 6-245 and 246-362 end in "}," (the comma separates branches); only the last ends in "}".
    assert.equal(bytesOfLines('report-schema.json', a, b).toString('utf8'), i < 2 ? `${s.text},` : s.text, verdict)
    assert.ok(s.text.startsWith('      {\n') && s.text.endsWith('\n      }'), verdict)
  })
  assert.throws(() => schemaBranch('maybe'), /no branch for verdict "maybe"/)
})

console.log('== blocks.mjs: references')
await test('every FILE.md#Name in the vendored markdown resolves, except the five placeholders upstream uses to describe the grammar', () => {
  const real = []
  const placeholders = []
  for (const file of readdirSync(VENDOR_SKILL_DIR).filter(f => f.endsWith('.md'))) {
    lines(file).forEach((l, i) => {
      for (const m of l.matchAll(/\b([A-Za-z][A-Za-z0-9-]*\.md)#([^"`]*)/g)) (m[1] === 'FILE.md' ? placeholders : real).push({ at: `${file}:${i + 1}`, ref: `${m[1]}#${m[2]}` })
    })
  }
  assert.deepEqual(placeholders.map(p => p.at), ['HUNTING.md:234', 'HUNTING.md:235', 'RECONNAISSANCE.md:94', 'RECONNAISSANCE.md:121', 'RECONNAISSANCE.md:122'])
  assert.deepEqual(real.map(r => `${r.at} ${r.ref}`), ['RECONNAISSANCE.md:113 ATTACK-CLASSES.md#Access control', 'RECONNAISSANCE.md:120 ATTACK-CLASSES.md#Access control'])
  for (const r of real) assert.equal(resolve(r.ref).name, 'Access control', r.at)
  assert.throws(() => resolve('FILE.md#section'), /unknown block file FILE\.md/, 'the placeholder is not a file')
})
await test('every reference the registry produces resolves to itself; a ref is the file, "#", and the name, nothing else', () => {
  for (const ref of [...ordinary(), ...companions().flatMap(c => [c.whenToUse, ...c.blocks])]) {
    assert.equal(resolve(ref).ref, ref)
    assert.deepEqual(parseRef(ref), { file: ref.split('#')[0], name: ref.slice(ref.indexOf('#') + 1) })
  }
})
await test('the ledger validator accepts a block that does not exist (upstream\'s own fixtures use two), so blocks.mjs is the only existence gate', () => {
  const refs = { surface: 'a', boundary: 'b', subsystem: 'c', attack_class: 'd' }
  const unit = {
    coverage_id: canonicalCoverageId(refs), canonical_refs: refs, surface: 'a', boundary: 'b', subsystem: 'c', attack_class: 'd', starting_paths: ['a.ts'],
    ordinary_attack_class_block: 'ATTACK-CLASSES.md#No such class', selected_companion_blocks: ['AI-AND-LLM.md#Tool calls'],
    excluded_blocks: [{ block: 'WEB-PROTOCOL-AND-AUTH.md#Cache behavior', reason: 'x' }], prior_status: 'new', attempts: [], wave: 1, status: 'planned',
    agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [],
  }
  assert.deepEqual(validateLedgerDocument([unit]), [])
  for (const ref of [unit.ordinary_attack_class_block, unit.selected_companion_blocks[0], unit.excluded_blocks[0].block]) assert.throws(() => resolve(ref), /unknown block/, ref)
})
await test('malformed and unknown references fail with an error that names the reference and says what to fix', () => {
  const malformed = ['', 'Injection', 'ATTACK-CLASSES.md', 'ATTACK-CLASSES.md#', '#Injection', ' ATTACK-CLASSES.md#Injection', 'ATTACK-CLASSES.md#Injection ', 'ATTACK-CLASSES.md# Injection',
    'attack-classes.md#Injection', 'ATTACK-CLASSES.txt#Injection', '../ATTACK-CLASSES.md#Injection', 'a/ATTACK-CLASSES.md#Injection', 'ATTACK-CLASSES.md#Inj\nection', 'ATTACK-CLASSES.md#Injection\n']
  for (const ref of malformed) assert.throws(() => parseRef(ref), err => err instanceof BlockError && /malformed block reference/.test(err.message) && err.message.includes(JSON.stringify(ref)), JSON.stringify(ref))
  for (const bad of [null, undefined, 0, 7, {}, [], ['ATTACK-CLASSES.md#Injection'], true]) assert.throws(() => resolve(bad), err => err instanceof BlockError && /must be a string/.test(err.message), String(bad))
  // Well-formed, but not a section: case, slug, parenthetical, and the wrong file are all misses, never guesses.
  const unknown = ['ATTACK-CLASSES.md#injection', 'ATTACK-CLASSES.md#Access-control', 'ATTACK-CLASSES.md#Access control (subagent_type: `general`)', 'ATTACK-CLASSES.md#Core discipline',
    'AI-AND-LLM.md#Injection', 'AI-AND-LLM.md#Universal moves (apply across the above)', 'AI-AND-LLM.md#Tool calls']
  for (const ref of unknown) assert.throws(() => resolve(ref), err => err instanceof BlockError && err.message.startsWith(`unknown block ${ref}:`), ref)
  assert.throws(() => resolve('NOPE.md#Injection'), /unknown block file NOPE\.md: .* has .*ATTACK-CLASSES\.md/)
  assert.throws(() => resolve('FILE.md#section'), /unknown block file FILE\.md/)
})

console.log('== blocks.mjs: the parser, on text it was not written for')
await test('headings in code fences are text; a trailing parenthetical is dropped from the name; blocks drop trailing blank lines and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blocks-parser-'))
  try {
    writeFileSync(join(dir, 'X.md'), ['# T', '', '## A (note) (second)', 'body', '', '```text', '## Not a heading', '```', '', '', '## B (note)', 'two', '', '### B.1', 'deep', '', '## A (again)', 'x', ''].join('\n'))
    const got = sections('X.md', dir).map(s => [s.name, s.startLine, s.endLine])
    assert.deepEqual(got, [['T', 1, 18], ['A (note)', 3, 8], ['B', 11, 15], ['B.1', 14, 15], ['A', 17, 18]])
    assert.equal(resolve('X.md#B', dir).text, '## B (note)\ntwo\n\n### B.1\ndeep')
    assert.equal(fence('X.md#A (note)', 0, dir).text, '## Not a heading')
    assert.equal(resolve('X.md#A', dir).startLine, 17, 'only the last parenthetical is dropped, so "A (note) (second)" is "A (note)", not "A"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await test('an unclosed fence, a duplicate name, a missing file, and an unreadable schema fail with a BlockError instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blocks-parser-'))
  try {
    writeFileSync(join(dir, 'U.md'), '# T\n\n## A\n```\ntext\n')
    writeFileSync(join(dir, 'D.md'), '# T\n\n## A\none\n\n## A (again)\ntwo\n')
    assert.throws(() => sections('U.md', dir), /U\.md: a code fence is never closed/)
    assert.throws(() => resolve('D.md#A', dir), /ambiguous block reference D\.md#A: 2 sections of D\.md have that name \(lines 3, 6\)/)
    assert.throws(() => resolve('Z.md#A', dir), /unknown block file Z\.md: .* has D\.md, U\.md/)
    assert.throws(() => resolve('Z.md#A', join(dir, 'missing')), /unknown block file Z\.md: .* has no upstream \.md files/)
    assert.throws(() => schemaBranch('confirmed', dir), err => err instanceof BlockError && /report-schema\.json: items\.oneOf cannot be read/.test(err.message))
    writeFileSync(join(dir, 'report-schema.json'), '{"items":{"oneOf":[')
    assert.throws(() => schemaBranch('confirmed', dir), BlockError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('== blocks.mjs: vendored headings renamed by upstream drift')
await test('the control: an untouched copy passes the same registry assertion the real tree passes', () => { withCopy(copy => assertRegistry(copy)) })
await test('a class heading renamed in a companion fails the registry assertion', () => {
  withCopy(copy => {
    rewrite(copy, 'CLIENT-SIDE.md', '## DOM and object-state attack classes', '## DOM and object-state attack surfaces classes')
    assert.throws(() => assertRegistry(copy), /attack surfaces classes/)
    assert.throws(() => resolve('CLIENT-SIDE.md#DOM and object-state attack classes', copy), /unknown block CLIENT-SIDE\.md#DOM and object-state attack classes/)
  })
})
await test('an ordinary class renamed in ATTACK-CLASSES.md fails the registry assertion and the reference a ledger would hold', () => {
  withCopy(copy => {
    rewrite(copy, 'ATTACK-CLASSES.md', '**Access control** (subagent_type', '**Access controls** (subagent_type')
    assert.throws(() => assertRegistry(copy), /Access control/)
    assert.throws(() => resolve('ATTACK-CLASSES.md#Access control', copy), /unknown block ATTACK-CLASSES\.md#Access control: .* Access controls /)
  })
})
await test('a fixed section renamed or removed fails by file and section name; an unknown ## section does too', () => {
  withCopy(copy => {
    rewrite(copy, 'WEB-PROTOCOL-AND-AUTH.md', '## Universal moves (apply across the above)', '## Universal tactics (apply across the above)')
    assert.throws(() => companions(copy), err => err instanceof BlockError && err.message.startsWith('WEB-PROTOCOL-AND-AUTH.md: unrecognized section "Universal tactics"'))
  })
  withCopy(copy => {
    rewrite(copy, 'AI-AND-LLM.md', '## Validation rules (apply before reporting ANY finding here)', '#### Validation rules (apply before reporting ANY finding here)')
    assert.throws(() => companion('AI-AND-LLM.md', copy), /AI-AND-LLM\.md: expected exactly one section "Validation rules" \(a ## heading\), found 0/)
  })
  withCopy(copy => {
    writeFileSync(join(copy, 'CLOUD-AND-DEPLOYMENT.md'), `${readFileSync(join(copy, 'CLOUD-AND-DEPLOYMENT.md'), 'utf8')}\n## Notes\nnew\n`)
    assert.throws(() => companions(copy), /CLOUD-AND-DEPLOYMENT\.md: unrecognized section "Notes"/)
  })
  withCopy(copy => {
    rewrite(copy, 'MEMORY-SAFETY-AND-BINARY.md', '## Core discipline (include in every agent prompt for this domain)', '## Core discipline')
    rewrite(copy, 'MEMORY-SAFETY-AND-BINARY.md', '## Validation rules (apply before reporting ANY finding here)', '## Core discipline (again)')
    assert.throws(() => companion('MEMORY-SAFETY-AND-BINARY.md', copy), /MEMORY-SAFETY-AND-BINARY\.md: expected exactly one section "Core discipline" \(a ## heading\), found 2/)
  })
})
await test('a heading the hunter prompt is found by, a file ATTACK-CLASSES.md links to, and the schema layout each fail by name when changed', () => {
  withCopy(copy => {
    rewrite(copy, 'HUNTING.md', '#### Core hunting method — include in every hunter prompt', '#### Core hunting method')
    assert.throws(() => parts(copy), /unknown block HUNTING\.md#Core hunting method — include in every hunter prompt/)
  })
  withCopy(copy => {
    rmSync(join(copy, 'SUPPLY-CHAIN-AND-RELEASE.md'))
    assert.throws(() => companions(copy), /unknown block file SUPPLY-CHAIN-AND-RELEASE\.md/)
  })
  withCopy(copy => {
    rewrite(copy, 'report-schema.json', '\n      {\n        "type": "object",\n        "description": "A source-grounded candidate whose', '\n       {\n        "type": "object",\n        "description": "A source-grounded candidate whose')
    assert.throws(() => schemaBranch('confirmed', copy), /report-schema\.json: the oneOf layout changed/)
  })
})

console.log('== blocks.mjs: command line, guidance, and sizes')
const cli = (args, cwd) => spawnSync(process.execPath, [BLOCKS, ...args], { encoding: 'utf8', cwd })
await test('ref prints the block exactly; list prints every block; a bad ref exits 1 with FAIL on stderr; no arguments exit 2', () => {
  const r = cli(['ref', 'ATTACK-CLASSES.md#Injection'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `${bytesOfLines('ATTACK-CLASSES.md', 29, 37).toString('utf8')}\n`)
  const list = cli(['list'])
  assert.equal(list.status, 0)
  assert.equal(list.stdout.split('\n').filter(l => /^ {2}\S+#/.test(l) || /^ATTACK-CLASSES\.md#/.test(l)).length, 9 + 30 + 44)
  const bad = cli(['ref', 'ATTACK-CLASSES.md#Nope'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /^blocks: FAIL unknown block ATTACK-CLASSES\.md#Nope: /)
  assert.equal(bad.stdout, '')
  for (const args of [[], ['ref'], ['ref', 'a', 'b'], ['guidance'], ['guidance', '  '], ['nope'], ['size', 'x']]) { const u = cli(args); assert.equal(u.status, 2, args.join(' ')); assert.match(u.stderr, /^usage: blocks\.mjs /) }
})
await test('guidance prints verbatim excerpts for a question and the pointer to the security skill, and writes nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'blocks-guidance-'))
  try {
    const r = cli(['guidance', 'How do I protect JWT sessions from CSRF and cookie theft?'], cwd)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /writes no files, starts no audit and runs no agent/)
    assert.match(r.stdout, /use the `security` skill/)
    const s = resolve('WEB-PROTOCOL-AND-AUTH.md#Browser-session attack classes')
    assert.ok(r.stdout.includes(`--- ${s.ref} (lines ${s.startLine}-${s.endLine}) ---\n${s.text}\n`), 'the browser-session section, verbatim, with its lines')
    assert.deepEqual(readdirSync(cwd), [], 'the working directory is untouched')
    assert.match(cli(['guidance', 'zzzz qqqq'], cwd).stdout, /No excerpt matched\./)
    assert.deepEqual(readdirSync(cwd), [])
    assert.match(guidance('SQL injection in query building'), /--- ATTACK-CLASSES\.md#Injection \(lines 29-37\) ---/)
    assert.equal((guidance('jwt csrf sessions', undefined, 1).match(/^--- /gm) || []).length, 1, 'the limit caps the excerpts')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
await test('a hunter-prompt-sized payload is measured: shared parts + one ordinary block + one companion, and the worst case', () => {
  const s = payloadSizes()
  const p = parts()
  const size = b => Buffer.byteLength(b.text)
  assert.equal(s.common, size(p.promotion) + size(p.hunterMethod) + size(p.validationRules) + size(p.hunterResult) + size(p.schema_confirmed) + size(p.schema_needs_validation))
  assert.equal(s.classes, ORDINARY.reduce((n, [name]) => n + size(resolve(`ATTACK-CLASSES.md#${name}`)), 0))
  assert.equal(s.companions.length, 10)
  assert.equal(s.typicalHunter, s.common + size(resolve(s.largestClass)) + Math.max(...s.companions.map(c => c.bytes)))
  assert.equal(s.worstHunter, s.common + s.classes + s.companions.reduce((n, c) => n + c.bytes, 0))
  assert.ok(s.typicalHunter < s.worstHunter && s.worstHunter < s.injectedWorst, 'double encoding only adds bytes')
  const out = cli(['size']).stdout
  assert.match(out, new RegExp(`typical hunter.*: ${s.typicalHunter} bytes`))
  console.log(`       (typical hunter ${s.typicalHunter} bytes of upstream text, worst ${s.worstHunter}, worst as an injected script line ${s.injectedWorst}; shared parts ${s.common})`)
})
