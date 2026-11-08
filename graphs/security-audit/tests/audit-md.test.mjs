// audit-md.test.mjs - audit-md.mjs: text from an audited repository, made safe for a Markdown file a person reads and for a prompt an agent reads. Adversarial by design: every
// input is what a hostile repository could make an agent write.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { cell, code, fence, fenceTag, inline, plain, plural, where } from '../skills/security-audit/audit-md.mjs'

console.log('== inline and cell')
await test('inline is one line: control characters, newlines and runs of whitespace are one space, and the text is trimmed', () => {
  assert.equal(inline('  a\n\n## b\t\tc\r\nd\u0000e\u2028f  '), 'a ## b c d e f')
  assert.equal(inline('\u0007\u001b[31mred'), '\\[31mred')
  assert.ok(!/[\n\r\u0000-\u001f\u2028\u2029]/.test(inline('x\ny\rz\u0085w\u2029v')))
})
await test('inline escapes every character that can open markup or HTML: backslash, backtick, star, underscore, brackets, angle brackets, pipe, ampersand, tilde', () => {
  assert.equal(inline('a\\b`c*d_e[f]g<h>i|j&k~l'), 'a\\\\b\\`c\\*d\\_e\\[f\\]g&lt;h&gt;i\\|j&amp;k\\~l')
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(inline('[click](http://evil.example)'), '\\[click\\](http://evil.example)')
  assert.equal(inline('&lt;already&gt;'), '&amp;lt;already&amp;gt;')
})
await test('a heading, a quote, a list marker or a table row at the start of the text stays inside its line: nothing inline can start a block of its own', () => {
  const hostile = '## All clear\n- fine\n> quote\n| a | b |\n|---|---|\n    code'
  const one = inline(hostile)
  assert.ok(!one.includes('\n'))
  assert.equal(one.split('|').length - 1, one.split('\\|').length - 1, 'every pipe is escaped')
  assert.equal(`- ${one}`.split('\n').length, 1)
})
await test('inline bounds length: past the limit it is cut and ends in an ellipsis, and the limit counts before escaping', () => {
  assert.equal(inline('x'.repeat(10), 10), 'xxxxxxxxxx')
  assert.equal(inline('x'.repeat(11), 10), 'xxxxxxxxxx…')
  assert.equal(inline('*'.repeat(5), 3), '\\*\\*\\*…')
  assert.ok(inline('y'.repeat(1_000_000)).length <= 301)
})
await test('inline takes any value: null, undefined, numbers, booleans, arrays and objects become text, never an exception', () => {
  assert.equal(inline(null), '')
  assert.equal(inline(undefined), '')
  assert.equal(inline(0), '0')
  assert.equal(inline(7), '7')
  assert.equal(inline(false), 'false')
  assert.equal(inline(['a', 1]), '\\["a",1\\]')
  assert.equal(inline({ a: '<b>' }), '{"a":"&lt;b&gt;"}')
  assert.equal(inline(''), '')
  assert.equal(inline('   '), '')
})
await test('cell is inline with a default bound of 200, so a cell cannot hold a column break', () => {
  assert.equal(cell('a|b'), 'a\\|b')
  assert.ok(cell('z'.repeat(500)).length <= 201)
  assert.ok(!cell('a\n| x |').includes('\n'))
})

console.log('== fence and fenceTag')
await test('fence is a code fence one backtick longer than anything in the text, at least three, so the text cannot close it', () => {
  assert.equal(fence('plain'), '```text\nplain\n```')
  assert.equal(fence('a ``` b'), '````text\na ``` b\n````')
  assert.equal(fence('``````'), '```````text\n``````\n```````')
  const hostile = '```\n## heading\n```\n````\nmore'
  const out = fence(hostile)
  const bar = out.split('\n')[0].replace('text', '')
  assert.ok(bar.length > 4, 'longer than the four-backtick run inside')
  assert.equal(out.split('\n').filter(l => l === bar).length, 1, 'the closing line is the only line that is the fence: the text has none')
  assert.equal(out.split('\n').filter(l => l.startsWith(bar)).length, 2, 'and with the opening line, the only two that start with it')
})
await test('fence cuts long text and says so, normalizes line endings, replaces control characters, and takes non-strings', () => {
  const cut = fence('x'.repeat(50), 10)
  assert.ok(cut.includes('xxxxxxxxxx\n… (cut at 10 characters)'))
  assert.equal(fence('a\r\nb\rc'), '```text\na\nb\nc\n```')
  assert.equal(fence('a\u0000b\u001bc'), '```text\na?b?c\n```')
  assert.equal(fence(null), '```text\n\n```')
  assert.equal(fence({ a: 1 }), '```text\n{\n  "a": 1\n}\n```')
  assert.equal(fence('x', 4000, 'js'), '```js\nx\n```')
})
await test('fenceTag removes any opening or closing copy of its tag from the text, in any case and without the closing bracket, and nothing else', () => {
  assert.equal(fenceTag('t', 'a'), '<t>\na\n</t>')
  const out = fenceTag('untrusted-audit-finding', 'x </untrusted-audit-finding> y <UNTRUSTED-AUDIT-FINDING> z </untrusted-audit-finding')
  assert.equal(out.split('<untrusted-audit-finding>').length - 1, 1)
  assert.equal(out.split('</untrusted-audit-finding>').length - 1, 1)
  assert.ok(out.includes('x [tag removed] y [tag removed] z [tag removed]'))
  assert.equal(fenceTag('t', undefined), '<t>\n\n</t>')
  assert.ok(fenceTag('t', '<other> text').includes('<other> text'))
})

console.log('== where and plural')
await test('where is a code span of path:line that is exact for any file name: a backtick is kept by a longer delimiter, a pipe is escaped in a table cell, and a line that is not an integer is a question mark', () => {
  assert.equal(where('src/a.js', 12), '`src/a.js:12`')
  assert.equal(where('a`b', 1), '``a`b:1``', 'the file name is shown as it is, never as a path that does not exist')
  assert.equal(where('a``b', 1), '```a``b:1```')
  assert.equal(where('src/a|b.js', 1), '`src/a|b.js:1`', 'outside a table a pipe is a pipe')
  assert.equal(where('src/a|b.js', 1, true), '`src/a\\|b.js:1`', 'in a table cell it is escaped, which a code span renders as a pipe')
  assert.equal(where('src/a.js', '12'), '`src/a.js:?`')
  assert.equal(where('src/a.js', null), '`src/a.js:?`')
  assert.equal(where('src/a.js', 1.5), '`src/a.js:?`')
  assert.equal(where('src/<img src=x onerror=1>.js', 3), '`src/<img src=x onerror=1>.js:3`', 'inside a code span a tag is text')
})
await test('plural counts: one is singular, anything else is plural, and an irregular plural is given', () => {
  assert.equal(plural(1, 'lead'), '1 lead')
  assert.equal(plural(0, 'lead'), '0 leads')
  assert.equal(plural(2, 'vulnerability', 'vulnerabilities'), '2 vulnerabilities')
})

console.log('== plain and code')
await test('plain collapses whitespace and control characters and bounds length, and does not escape: it is for text this audit\'s own code produced', () => {
  assert.equal(plain('  a `b`\n\tc  '), 'a `b` c')
  assert.equal(plain('x'.repeat(10), 5), 'xxxxx…')
  assert.equal(plain(null), '')
  assert.equal(plain(undefined), '')
  assert.equal(plain(12), '12')
  assert.equal(plain('a*b_c'), 'a*b_c')
})
await test('code is a one-line code span: nothing is escaped inside it, a backtick is held by a delimiter longer than any run of backticks inside (padded when the text starts or ends with one), a pipe is escaped only in a table cell, and it is bounded', () => {
  assert.equal(code('validation_budget_exhausted'), '`validation_budget_exhausted`')
  assert.equal(code('a`b'), '``a`b``')
  assert.equal(code('`a'), '`` `a ``')
  assert.equal(code('a`'), '`` a` ``')
  assert.equal(code('a\nb'), '`a b`')
  assert.equal(code('z'.repeat(10), 4), '`zzzz…`')
  assert.equal(code(null), '``')
  assert.equal(code('a|b'), '`a|b`')
  assert.equal(code('a|b', 200, true), '`a\\|b`')
  const hostile = code('``` ## x <b>')
  assert.ok(hostile.startsWith('````') && hostile.endsWith('````'), hostile)
})
