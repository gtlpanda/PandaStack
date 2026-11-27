// papercut.test.mjs — core/skills/papercut/papercut.mjs: field validation, secret scrubbing,
// concurrent appends, a refused symlinked store, private permissions, grouping and the store
// location. Every case uses its own temp store (PANDASTACK_PAPERCUT_DIR or a temp HOME); the
// real ~/.local/state/pandastack is never touched.
import { join } from 'node:path'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { normalize, redactSecrets, scrub, signature, storeDir, summarize, validateFields } from '../core/skills/papercut/papercut.mjs'
import { redactSecrets as blueprintRedact } from '../graphs/blueprint/skills/blueprint/blueprint-state.mjs'

const CLI = join(REPO, 'core', 'skills', 'papercut', 'papercut.mjs')
const GOOD = { agent: 'claude', tool: 'evidence.mjs', tried: 'node evidence.mjs recheck .git/bughunt/k', expected: 'RECHECK: PASS',
  actual: 'RECHECK F1: ERROR', fix: 'resolve the state dir' }

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'papercut-test-')))
  const store = join(home, 'store')
  const env = { ...process.env, HOME: home, PANDASTACK_PAPERCUT_DIR: store }
  delete env.XDG_STATE_HOME
  const run = (args, { input, extra = {}, cwd = home } = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd, input })
  const file = (fields = GOOD, extra) => run(['file', ...Object.entries(fields).flatMap(([k, v]) => [`--${k}`, v])], { extra })
  const lines = () => readFileSync(join(store, 'papercuts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { home, store, env, run, file, lines, done: () => rmSync(home, { recursive: true, force: true }) }
}

console.log('== papercut: fields')
await test('a complete report is filed as one line with the stored fields, and the verdict line names it', () => {
  const s = sandbox()
  try {
    const r = s.file()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^PAPERCUT: FILED [0-9a-f]{16} evidence\.mjs -> .*papercuts\.jsonl\n$/)
    const [rec] = s.lines()
    assert.deepEqual(Object.keys(rec), ['v', 'at', 'pandastack', 'agent', 'repo', 'tool', 'tried', 'expected', 'actual', 'workaround', 'fix', 'signature'])
    assert.equal(rec.agent, 'claude')
    assert.equal(rec.workaround, null)
    assert.equal(rec.repo, s.home.split('/').pop(), 'the directory name only, never a path')
    assert.match(rec.pandastack, /^[0-9a-f]{12}$/)
  } finally { s.done() }
})

await test('missing, empty, unknown, oversized and non-text fields are refused with exit 2 and nothing is written', () => {
  const s = sandbox()
  try {
    const cases = [
      [{ ...GOOD, fix: undefined }, /--fix is required/],
      [{ ...GOOD, actual: '   ' }, /--actual is required/],
      [{ ...GOOD, agent: 'gpt' }, /--agent must be one of claude, codex, other/],
      [{ ...GOOD, tool: 'x'.repeat(81) }, /--tool is 81 characters; the limit is 80/],
      [{ ...GOOD, actual: 'y'.repeat(1201) }, /--actual is 1201 characters/],
      [{ ...GOOD, repo: 'a/b' }, /--repo must be a bare directory name/],
      [{ ...GOOD, repo: '..' }, /--repo must be a bare directory name/],
      [{ ...GOOD, tool: 'two\nlines' }, /--tool must be one line/],
    ]
    for (const [fields, why] of cases) {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      const r = s.file(clean)
      assert.equal(r.status, 2, `${why}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, why)
      assert.match(r.stderr, /^PAPERCUT: INVALID /)
    }
    assert.match(s.run(['file', '--nope', 'x']).stderr, /unknown option: --nope/)
    assert.match(s.run(['file', '--tool']).stderr, /--tool needs a value/)
    assert.match(s.run(['file', '--tool', 'a', '--tool', 'b']).stderr, /--tool given twice/)
    for (const input of ['[1,2]', 'null', '"text"', '{"agent":"claude","tool":5}', '{not json']) {
      const r = s.run(['file', '--stdin'], { input })
      assert.equal(r.status, 2, input)
    }
    const extra = s.run(['file', '--stdin'], { input: JSON.stringify({ ...GOOD, prompt: 'the user said' }) })
    assert.match(extra.stderr, /unknown field: prompt/, 'no field for prompt text')
    assert.equal(lstatSync(s.store, { throwIfNoEntry: false }), undefined, 'no store created by a refused report')
  } finally { s.done() }
})

await test('validateFields refuses non-objects and non-string values, and keeps the workaround optional', () => {
  for (const bad of [null, undefined, 0, 'x', [], [GOOD]]) assert.throws(() => validateFields(bad), /must be an object/)
  for (const key of ['tool', 'tried', 'expected', 'actual', 'fix', 'workaround']) {
    for (const value of [0, 1, true, {}, ['a']]) assert.throws(() => validateFields({ ...GOOD, [key]: value }), new RegExp(`--${key} must be text`))
  }
  assert.equal(validateFields(GOOD).workaround, null)
  assert.equal(validateFields({ ...GOOD, workaround: 'used an absolute path' }).workaround, 'used an absolute path')
  assert.equal(validateFields({ ...GOOD, actual: 'a\r\nb\u0007c' }).actual, 'a\nb c', 'CRLF to LF, control characters to spaces')
})

await test('--stdin takes the same fields as one JSON object, so quotes and $ survive', () => {
  const s = sandbox()
  try {
    const r = s.run(['file', '--stdin'], { input: JSON.stringify({ ...GOOD, tried: `jq '.a["b"]' "$FILE"`, agent: 'codex' }) })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(s.lines()[0].tried, `jq '.a["b"]' "$FILE"`)
    assert.equal(s.lines()[0].agent, 'codex')
  } finally { s.done() }
})

console.log('== papercut: secrets')
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
await test('secrets in any field are redacted before writing, including bearer and authorization headers', () => {
  const s = sandbox()
  try {
    const actual = `curl -H "Authorization: Bearer abc.def-123456789" -H "X-Api-Key: k3y_live_9988776655" https://u:hunter2pass@host/x ${GHP} AKIA0123456789ABCDEF xoxb-1234567890-abcdefghij sk-proj-abcdefghij0123456789abcdefghij`
    const r = s.file({ ...GOOD, actual, tried: `gh auth login --with-token ${GHP}`, workaround: 'Token 9f8e7d6c5b4a39281706' })
    assert.equal(r.status, 0, r.stderr)
    const raw = readFileSync(join(s.store, 'papercuts.jsonl'), 'utf8')
    for (const secret of [GHP, 'abc.def-123456789', 'k3y_live_9988776655', 'hunter2pass', 'AKIA0123456789ABCDEF', 'xoxb-1234567890-abcdefghij', // allow-secret: fake redaction fixtures
      'sk-proj-abcdefghij0123456789abcdefghij', '9f8e7d6c5b4a39281706']) { // allow-secret: fake redaction fixtures
      assert.ok(!raw.includes(secret), `${secret} must not be stored`)
    }
    const rec = s.lines()[0]
    assert.match(rec.actual, /Authorization: Bearer <redacted: credential>/)
    assert.match(rec.tried, /<redacted: GitHub token>/)
  } finally { s.done() }
})

await test('look-alikes that are not secrets are kept as written', () => {
  for (const text of [
    'Bearer authentication failed',
    'authorization: required',
    'pip install scikit-learn sk-learn',
    'ghp_short',
    'the AKIA prefix marks AWS keys',
    'commit=0123456789abcdef0123456789abcdef01234567',
    'Token expired; log in again',
    'x-api-key header missing',
    'Token expired.',
    '401 Unauthorized: Bearer authentication.',
    'authorization: required.',
    'Basic authentication is disabled...',
  ]) assert.equal(scrub(text), text, text)
  assert.equal(scrub(42), 42)
  // bughunt F1: a sentence-ending period made a plain word look like a credential.
  const expired = validateFields({ ...GOOD, actual: 'Token expired.' }), revoked = validateFields({ ...GOOD, actual: 'Token revoked.' })
  assert.notEqual(signature(expired), signature(revoked), 'different prose failures keep different signatures')
  assert.equal(scrub('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic <redacted: credential>', 'base64 with no digit is still a credential')
  assert.equal(scrub('sent Bearer abc123def456.'), 'sent Bearer <redacted: credential>.', 'the sentence period stays outside the redaction')
})

await test("papercut's redaction copy agrees with the blueprint graph's on every shape (drift guard)", () => {
  const corpus = [
    GHP, `pre ${GHP} post`, 'github_pat_' + 'a'.repeat(30), 'AKIA0123456789ABCDEF', 'ASIA0123456789ABCDEF', 'xoxp-123-456-abcdef',
    'sk-ant-' + 'a1'.repeat(15), 'sk-proj-' + 'b2'.repeat(16), 'sk_live_abc12345', 'rk_test_' + '9'.repeat(20), 'AIza' + 'c'.repeat(35),
    'eyJhbGciOiJ.eyJzdWIiOiIx.sig', 'https://user:longpassword@example.com/x', 'password = "Abcdefghij0123456789KLMN"', // allow-secret: fake redaction fixtures
    'key: 0123456789abcdef0123456789abcdef', 'sha 0123456789abcdef0123456789abcdef01234567', '-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----', // allow-secret: fake redaction fixtures
    'plain prose with no secrets', 'AKIA0123456789ABCDEFsk_live_abc12345', '', // allow-secret: fake redaction fixtures
  ]
  for (const text of corpus) assert.equal(redactSecrets(text), blueprintRedact(text), JSON.stringify(text))
})

console.log('== papercut: store')
await test('twenty concurrent writers each land one whole, parseable line', async () => {
  const s = sandbox()
  try {
    const runs = Array.from({ length: 20 }, (_, i) => new Promise((res, rej) => {
      const p = spawn(process.execPath, [CLI, 'file', '--agent', 'other', '--tool', `t${i % 3}`, '--tried', `cmd ${i}`, '--expected', 'e',
        '--actual', `a ${'x'.repeat(900)} ${i}`, '--fix', 'f'], { env: s.env, cwd: s.home, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', d => { err += d })
      p.on('error', rej)
      p.on('close', code => (code === 0 ? res() : rej(new Error(`writer ${i} exit ${code}: ${err}`))))
    }))
    await Promise.all(runs)
    const raw = readFileSync(join(s.store, 'papercuts.jsonl'), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    assert.equal(lines.length, 20)
    const parsed = lines.map(l => JSON.parse(l))
    assert.deepEqual(parsed.map(r => Number(r.tried.split(' ')[1])).sort((a, b) => a - b), [...Array(20).keys()])
  } finally { s.done() }
})

await test('a symlinked store file or store dir is refused (exit 1) and its target is never written', () => {
  const s = sandbox()
  try {
    mkdirSync(s.store, { mode: 0o700 })
    const target = join(s.home, 'elsewhere.txt')
    writeFileSync(target, 'keep\n')
    symlinkSync(target, join(s.store, 'papercuts.jsonl'))
    let r = s.file()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /refusing a symlinked papercut store/)
    assert.equal(readFileSync(target, 'utf8'), 'keep\n')
    assert.equal(s.run(['list']).status, 1, 'reading through the link is refused too')

    const realDir = join(s.home, 'real-dir')
    mkdirSync(realDir)
    const linkedDir = join(s.home, 'linked-dir')
    symlinkSync(realDir, linkedDir)
    r = s.file(GOOD, { PANDASTACK_PAPERCUT_DIR: linkedDir })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /symlinked papercut store dir/)
    assert.equal(lstatSync(join(realDir, 'papercuts.jsonl'), { throwIfNoEntry: false }), undefined)
  } finally { s.done() }
})

await test('the store dir is 0700 and the file 0600, and wider modes on existing ones are tightened', () => {
  const s = sandbox()
  try {
    assert.equal(s.file().status, 0)
    assert.equal(statSync(s.store).mode & 0o777, 0o700)
    assert.equal(statSync(join(s.store, 'papercuts.jsonl')).mode & 0o777, 0o600)
    chmodSync(s.store, 0o755)
    chmodSync(join(s.store, 'papercuts.jsonl'), 0o644)
    assert.equal(s.file().status, 0)
    assert.equal(statSync(s.store).mode & 0o777, 0o700)
    assert.equal(statSync(join(s.store, 'papercuts.jsonl')).mode & 0o777, 0o600)
  } finally { s.done() }
})

await test('the store location: PANDASTACK_PAPERCUT_DIR, then XDG_STATE_HOME, then HOME; a relative override is refused', () => {
  assert.equal(storeDir({ PANDASTACK_PAPERCUT_DIR: '/a/b', XDG_STATE_HOME: '/x', HOME: '/h' }), '/a/b')
  assert.equal(storeDir({ XDG_STATE_HOME: '/x', HOME: '/h' }), '/x/pandastack')
  assert.equal(storeDir({ XDG_STATE_HOME: 'relative', HOME: '/h' }), '/h/.local/state/pandastack')
  assert.equal(storeDir({ HOME: '/h' }), '/h/.local/state/pandastack')
  assert.throws(() => storeDir({ PANDASTACK_PAPERCUT_DIR: 'rel/dir', HOME: '/h' }), /must be an absolute path/)
  assert.throws(() => storeDir({}), /set HOME or PANDASTACK_PAPERCUT_DIR/)
  const s = sandbox()
  try {
    const env = { PANDASTACK_PAPERCUT_DIR: '' }
    const r = s.file(GOOD, env)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(statSync(join(s.home, '.local', 'state', 'pandastack', 'papercuts.jsonl')).isFile(), 'falls back to HOME in the temp home')
    assert.equal(s.file(GOOD, { PANDASTACK_PAPERCUT_DIR: 'rel' }).status, 2)
  } finally { s.done() }
})

console.log('== papercut: reading')
await test('the same failure from different paths, numbers and ids groups into one signature; another failure does not', () => {
  const a = validateFields({ ...GOOD, tried: 'node evidence.mjs recheck /tmp/a1/.git/bughunt/key-1a2b3c4d', actual: 'RECHECK F1: ERROR at 12:01' })
  const b = validateFields({ ...GOOD, tried: 'node evidence.mjs recheck /home/u/r/.git/bughunt/key-9f8e7d6c', actual: 'RECHECK F7: ERROR at 09:44' })
  const c = validateFields({ ...GOOD, tried: a.tried, actual: 'RECHECK F1: REPRODUCED' })
  assert.equal(signature(a), signature(b))
  assert.notEqual(signature(a), signature(c))
  assert.equal(normalize('Exit 3 at /tmp/x/y and abc1234def'), 'exit # at <path> and <hex>')
  // bughunt F3: 0x addresses and numbers that grow past six digits split one failure into many groups.
  assert.equal(normalize('Segfault at 0x7fff5fbff8c0'), normalize('Segfault at 0x7ffee4a3b1d0'))
  assert.equal(normalize('pid 123456 exited'), normalize('pid 1234567 exited'))
  assert.equal(normalize('pid 1234567 exited'), 'pid # exited')
  const seg = f => signature(validateFields({ ...GOOD, actual: f }))
  assert.equal(seg('Segfault at 0x7fff5fbff8c0'), seg('Segfault at 0x7ffee4a3b1d0'))
})

await test('summary groups by tool and signature with counts, newest group first; list is newest first and honours --limit', () => {
  const s = sandbox()
  try {
    assert.equal(s.file({ ...GOOD, tool: 'old-tool' }).status, 0)
    assert.equal(s.file({ ...GOOD, actual: 'RECHECK F2: ERROR' }).status, 0)
    assert.equal(s.file({ ...GOOD, actual: 'RECHECK F3: ERROR', agent: 'codex' }).status, 0)
    const sum = JSON.parse(s.run(['summary', '--json']).stdout)
    assert.equal(sum.total, 3)
    assert.deepEqual(sum.groups.map(g => [g.tool, g.count]), [['evidence.mjs', 2], ['old-tool', 1]])
    assert.deepEqual(sum.groups[0].agents, ['claude', 'codex'])
    const text = s.run(['summary']).stdout
    assert.match(text, /^3 papercut\(s\) in 2 group\(s\), newest first\n1\. evidence\.mjs {2}x2 /)
    const list = JSON.parse(s.run(['list', '--json', '--limit', '2']).stdout)
    assert.deepEqual(list.reports.map(r => r.actual), ['RECHECK F3: ERROR', 'RECHECK F2: ERROR'])
    for (const bad of ['0', '-1', 'x', '1.5']) assert.equal(s.run(['list', '--limit', bad]).status, 2, bad)
  } finally { s.done() }
})

await test('an unreadable line is skipped with a warning and the rest still read; no store reads as empty', () => {
  const s = sandbox()
  try {
    let r = s.run(['summary'])
    assert.equal(r.status, 0)
    assert.equal(r.stdout, 'no papercuts filed\n')
    assert.equal(lstatSync(s.store, { throwIfNoEntry: false }), undefined, 'reading creates nothing')
    assert.equal(s.file().status, 0)
    // bughunt F2: a line with the grouping keys but no printed fields used to crash list and summary.
    const partial = JSON.stringify({ tool: 'partial-tool', signature: 's', at: '2026-01-01T00:00:00Z' })
    writeFileSync(join(s.store, 'papercuts.jsonl'), readFileSync(join(s.store, 'papercuts.jsonl'), 'utf8') + `{broken\n{"tool":1}\n${partial}\n[]\n`)
    r = s.run(['list'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /skipped 4 unreadable line\(s\)/)
    assert.match(r.stdout, /evidence\.mjs/)
    r = s.run(['summary'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^1 papercut\(s\) in 1 group\(s\)/)
  } finally { s.done() }
})

await test('terminal control characters never reach list or summary output, from a derived repo name or a hand-edited line', () => {
  const s = sandbox()
  try {
    // bughunt F4: the repository name is derived from the working directory, which may carry escape bytes.
    const evil = join(s.home, 'repo\u001b]0;pwned\u0007\u001b[2J')
    mkdirSync(evil)
    const r = s.run(['file', ...Object.entries(GOOD).flatMap(([k, v]) => [`--${k}`, v])], { cwd: evil })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!/[\u0000-\u001f]/.test(s.lines()[0].repo), 'the stored repo name has no control characters')
    writeFileSync(join(s.store, 'papercuts.jsonl'), readFileSync(join(s.store, 'papercuts.jsonl'), 'utf8') +
      JSON.stringify({ ...s.lines()[0], tool: 'x\u001b[31mred', actual: 'a\u009bb', agent: 'codex\u0007' }) + '\n')
    for (const args of [['list'], ['summary']]) {
      const out = s.run(args)
      assert.equal(out.status, 0, out.stderr)
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(out.stdout), `${args[0]} printed a control character`)
    }
  } finally { s.done() }
})

await test('summarize orders groups by their newest report', () => {
  const rows = [
    { tool: 'a', signature: 's1', at: '2026-01-01T00:00:00.000Z', agent: 'claude', repo: 'r', tried: 't', actual: 'x', fix: 'f' },
    { tool: 'b', signature: 's2', at: '2026-01-03T00:00:00.000Z', agent: 'codex', repo: 'r', tried: 't', actual: 'y', fix: 'f' },
    { tool: 'a', signature: 's1', at: '2026-01-02T00:00:00.000Z', agent: 'codex', repo: 'q', tried: 't', actual: 'z', fix: 'f' },
  ]
  const groups = summarize(rows)
  assert.deepEqual(groups.map(g => [g.tool, g.count, g.last]), [['b', 1, '2026-01-03T00:00:00.000Z'], ['a', 2, '2026-01-02T00:00:00.000Z']])
  assert.equal(groups[1].latest.actual, 'z')
  assert.deepEqual(groups[1].repos, ['q', 'r'])
})

await test('an unknown command prints usage and exits 2', () => {
  const s = sandbox()
  try {
    for (const args of [[], ['nope'], ['summary', '--json=1']]) {
      const r = s.run(args)
      assert.equal(r.status, 2, args.join(' '))
    }
  } finally { s.done() }
})
