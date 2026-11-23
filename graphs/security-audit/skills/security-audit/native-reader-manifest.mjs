// native-reader-manifest.mjs - the host-built inputs of the source-only reader (source-reader.mjs) for one run: the sealed snapshot's manifest,
// its hash, and an empty protected context root. Nothing in production built these before. The reader verifies every byte it serves against this
// manifest, so the manifest is the host's statement of what the leaf may read: exactly the files of `tree/`, none outside it.
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonical } from './journal-data.mjs'
import { isSafeRelativePath } from './upstream.mjs'
import { loadRun } from './audit-run.mjs'

const ENTRY_LIMIT = 10000, FILE_LIMIT = 16777216, MANIFEST_LIMIT = 4194304
export const CONTEXT_DIR = 'reader-context'
const fail = code => { throw Object.assign(new Error(`Audit reader manifest: ${code}`), { code }) }

// Every regular file under `root` as `/`-separated relative paths. Anything else (a symlink, a device) is refused: `init` leaves none in tree/.
function filesUnder(root) {
  const found = [], pending = ['']
  while (pending.length) {
    const rel = pending.pop()
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) found.push(path)
      else fail('SNAPSHOT_ENTRY_UNSUPPORTED')
      if (found.length > ENTRY_LIMIT) fail('READER_TREE_TOO_LARGE')
    }
  }
  return found.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

/**
 * The reader inputs for `runDir`: `{ sourceRoot, contextRoot, manifest, expectedManifestHash }`, ready for createNativeReaderServer.
 * Throws READER_TREE_TOO_LARGE past the reader's 10,000-file or 16 MiB-per-file bounds, so a tree it cannot serve is refused before inference,
 * never served partially.
 */
export function buildReaderInputs(runDir) {
  const { meta } = loadRun(runDir)
  const sourceRoot = join(runDir, 'tree'), contextRoot = join(runDir, CONTEXT_DIR)
  const files = filesUnder(sourceRoot).map(path => {
    if (!isSafeRelativePath(path) || Buffer.byteLength(path) > 1024) fail('SNAPSHOT_PATH_UNSUPPORTED')
    if (lstatSync(join(sourceRoot, path)).size > FILE_LIMIT) fail('READER_TREE_TOO_LARGE')
    const bytes = readFileSync(join(sourceRoot, path))
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  })
  const manifest = { version: 1, sourceRef: { commit: meta.source_ref.commit, tree: meta.source_ref.tree }, files, contexts: [] }
  const expectedManifestHash = createHash('sha256').update(canonical(manifest, MANIFEST_LIMIT, 'INVALID_READER_INPUT', 'READER_TREE_TOO_LARGE')).digest('hex')
  // An empty, write-protected directory beside the tree: the reader requires both roots, and this audit grants no context artifacts.
  mkdirSync(contextRoot, { recursive: true, mode: 0o755 })
  chmodSync(contextRoot, 0o555)
  return { sourceRoot, contextRoot, manifest, expectedManifestHash }
}
