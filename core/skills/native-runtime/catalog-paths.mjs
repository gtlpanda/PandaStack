// Comparison keys for paths already resolved by realpathSync. Filesystem calls
// keep their original resolved paths; aliases never select a new read target.
import { posix, win32 } from 'node:path'

function wslParts(value, platform) {
  if (platform !== 'win32') return null
  // Windows exposes the same WSL share through these two reserved hosts. Linux
  // components remain case-sensitive, even though path.win32.relative is not.
  const match = /^\\\\(?:\?\\UNC\\)?(?:wsl\$|wsl\.localhost)\\(.*)$/is.exec(value)
  if (!match) return null
  const parts = match[1].replace(/\\$/, '').split('\\')
  return parts.some(part => !part || part === '.' || part === '..') ? [] : parts
}

export function catalogPathsEqual(left, right, platform = process.platform) {
  const a = wslParts(left, platform), b = wslParts(right, platform)
  if (a || b) return Boolean(a?.length && b?.length) && a.length === b.length && a.every((part, i) => part === b[i])
  return left === right
}

export function catalogPathContains(root, value, platform = process.platform) {
  const a = wslParts(root, platform), b = wslParts(value, platform)
  if (a || b) return Boolean(a?.length && b?.length) && a.length <= b.length && a.every((part, i) => part === b[i])
  const path = platform === 'win32' ? win32 : posix
  const rest = path.relative(root, value)
  return rest === '' || (!path.isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + path.sep))
}
