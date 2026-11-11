// Permission-bit prerequisite only: no ACL, denied-write, same-user containment,
// concurrent replacement or native tool-isolation guarantee.
import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, parse, sep } from 'node:path'

export function inspectSnapshotProtection(tree) {
  const problems = []
  const problem = (path, code) => problems.push({ path, code })
  const separator = sep === '\\' ? /[\\/]/ : '/'
  if (typeof tree !== 'string' || !isAbsolute(tree) ||
      tree.split(separator).some(part => part === '.' || part === '..')) {
    return { ok: false, problems: [{ path: '.', code: 'INVALID_ROOT' }] }
  }

  // Check ancestors from the filesystem root down, before any lookup through
  // them. This rejects static links only; it cannot prevent concurrent changes.
  let ancestor = parse(tree).root
  const parts = tree.slice(ancestor.length).split(separator).filter(Boolean)
  for (const part of parts) {
    let stat
    try { stat = lstatSync(ancestor) }
    catch { return { ok: false, problems: [{ path: '.', code: 'IO_ERROR' }] } }
    if (stat.isSymbolicLink()) {
      return { ok: false, problems: [{ path: '.', code: 'SYMLINK' }] }
    }
    if (!stat.isDirectory()) {
      return { ok: false, problems: [{ path: '.', code: 'IO_ERROR' }] }
    }
    ancestor = join(ancestor, part)
  }
  // Strip separators only after rejecting dot components. A trailing separator
  // would make lstat follow a root symlink on POSIX. The root is checked below.
  tree = ancestor
  const pending = [{ absolute: tree, path: '.' }]
  while (pending.length) {
    const { absolute, path } = pending.pop()
    let stat
    try { stat = lstatSync(absolute) }
    catch { problem(path, 'IO_ERROR'); continue }

    if (stat.isSymbolicLink()) { problem(path, 'SYMLINK'); continue }
    const directory = stat.isDirectory()
    if (path === '.' && !directory) { problem(path, 'NOT_DIRECTORY'); continue }
    if (!directory && !stat.isFile()) { problem(path, 'NOT_REGULAR'); continue }
    if (stat.mode & 0o222) problem(path, 'WRITABLE')
    if (!directory) continue

    let names
    try { names = readdirSync(absolute) }
    catch { problem(path, 'IO_ERROR'); continue }
    for (const name of names) {
      pending.push({ absolute: join(absolute, name), path: path === '.' ? name : `${path}/${name}` })
    }
  }

  // UTF-8 byte order preserves Unicode codepoint order, including astral names.
  const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  problems.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code))
  return { ok: problems.length === 0, problems }
}
