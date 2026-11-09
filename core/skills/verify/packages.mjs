// Immediate Node subprojects only; never traverse dependencies or directory symlinks.
import { readdirSync, lstatSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function packageDirs(root, { runnableOnly = false } = {}) {
  const dirs = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    if (!entry.isDirectory() || !lstatSync(manifest).isFile()) throw new Error(`unsafe package path: ${entry.name}`)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error(`invalid package manifest: ${entry.name}`)
    if (!runnableOnly || ['lint', 'typecheck', 'test'].some(s => typeof pkg.scripts?.[s] === 'string' && pkg.scripts[s].trim())) dirs.push(entry.name)
  }
  return dirs
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { for (const dir of packageDirs(process.argv[2], { runnableOnly: true })) process.stdout.write(`${dir}\0`) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
