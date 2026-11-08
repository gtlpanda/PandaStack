// audit-md.mjs - text that came from an audited repository, made safe to put in a Markdown file or a prompt that a person or an agent reads. Titles, descriptions, blockers,
// paths, remediation text: agents wrote them after reading hostile source, so none of it may open a heading, close a table cell, forge a link or a tag, or pass for the
// report's own words. Single-line text is escaped (inline, cell); multi-line text is fenced (fence, fenceTag), and the fence is longer than anything inside it.

// One line, safe after a label or a bullet marker or inside a table cell: control characters and runs of whitespace are one space, the markup characters are escaped, the length is
// bounded (a cut ends in an ellipsis).
export function inline(value, max = 300) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
  const flat = text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat
  return cut.replace(/[\\`*_[\]<>|&~]/g, c => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : `\\${c}`))
}
export const cell = (value, max = 200) => inline(value, max)
// One line of text this audit's own code produced (the blockers of the execution statement are upstream's wording): its whitespace is collapsed and its length bounded, and it is not escaped.
export const plain = (value, max = 400) => { const flat = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat }

// Text in a code fence that nothing inside can close: the fence is one backtick longer than the longest run of backticks in the text (at least three).
export function fence(value, max = 4000, info = 'text') {
  const text = (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2)).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
  const cut = text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text
  const longest = Math.max(0, ...(cut.match(/`+/g) ?? []).map(r => r.length))
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return `${bar}${info}\n${cut}\n${bar}`
}

// A tag the text cannot close: the same treatment as the workflow's `fenced` (a copy of the one in bughunt-flow.js): any <tag> or </tag> inside is replaced.
export const fenceTag = (tag, text) => `<${tag}>\n${String(text || '').replace(new RegExp(`</?${tag}>?`, 'gi'), '[tag removed]')}\n</${tag}>`

// A repository-relative reference as one code span: the path is validated upstream (no backtick can be in one), and a line is an integer.
// A code span: nothing inside a code span is markup, so nothing is escaped (an escape would show as a backslash); a backtick cannot be in it, and it is one line.
export const code = (value, max = 200) => `\`${plain(value, max).replace(/`/g, "'")}\``
export const where = (file, line) => `\`${String(file).replace(/`/g, '')}:${Number.isSafeInteger(line) ? line : '?'}\``

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
