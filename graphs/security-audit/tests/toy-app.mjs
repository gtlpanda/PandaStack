// toy-app.mjs - the fixture repository of the end-to-end audit: a tiny notes API with four planted weaknesses, the plan's toy app. Built from strings at run
// time, in a temp directory by the caller, so no weakness lives in this repository as a file (and the dummy credential below is a placeholder by construction:
// DUMMY and EXAMPLE are in it, and it matches no real provider's key shape). Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
//
// The planted weaknesses (each a real shape an audit should find; none is exploitable in a way that matters, there is nothing to run):
//   notes   src/routes/notes.js   GET /notes/:id answers with any user's note: the owner is never compared with the caller (missing ownership check)
//   files   src/routes/files.js   the `name` query parameter is joined onto the uploads directory unchecked (unsafe path join)
//   config  src/config.js         a credential-shaped dummy string assigned to a constant named like a key
//   cors    src/cors.js           the request's Origin is reflected with credentials allowed (permissive CORS)
export const TOY_FILES = {
  'package.json': '{\n  "name": "notes-api",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": { "start": "node src/server.js" }\n}\n',
  'README.md': '# notes-api\n\nA toy notes service. Run `npm start`.\n',
  'src/server.js': [
    "import http from 'node:http'",
    "import { handleNotes } from './routes/notes.js'",
    "import { handleFiles } from './routes/files.js'",
    "import { withCors } from './cors.js'",
    "import { config } from './config.js'",
    '',
    'export const server = http.createServer((req, res) => {',
    '  withCors(req, res)',
    "  if (req.url.startsWith('/notes')) return handleNotes(req, res)",
    "  if (req.url.startsWith('/files')) return handleFiles(req, res)",
    '  res.statusCode = 404',
    "  res.end('not found')",
    '})',
    '',
    'if (process.argv[1] && process.argv[1].endsWith("server.js")) server.listen(config.port)',
    '',
  ].join('\n'),
  'src/auth.js': [
    '// The caller is whoever the x-user header says. A real service would verify a session here.',
    'export function currentUser(req) {',
    "  const id = req.headers['x-user']",
    "  return id ? { id: String(id) } : null",
    '}',
    '',
  ].join('\n'),
  'src/db.js': [
    'export const notes = new Map([',
    "  ['1', { id: '1', owner: 'alice', body: 'alice private note' }],",
    "  ['2', { id: '2', owner: 'bob', body: 'bob private note' }],",
    '])',
    '',
  ].join('\n'),
  'src/routes/notes.js': [
    "import { notes } from '../db.js'",
    "import { currentUser } from '../auth.js'",
    '',
    'export function handleNotes(req, res) {',
    '  const user = currentUser(req)',
    '  if (!user) {',
    '    res.statusCode = 401',
    "    return res.end('login required')",
    '  }',
    "  const id = req.url.split('/')[2]",
    '  const note = notes.get(id)',
    '  if (!note) {',
    '    res.statusCode = 404',
    "    return res.end('no such note')",
    '  }',
    '  // note.owner is never compared with user.id',
    "  res.setHeader('content-type', 'application/json')",
    '  res.end(JSON.stringify(note))',
    '}',
    '',
  ].join('\n'),
  'src/routes/files.js': [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    '',
    "const ROOT = new URL('../../uploads/', import.meta.url).pathname",
    '',
    'export function handleFiles(req, res) {',
    "  const name = new URL(req.url, 'http://localhost').searchParams.get('name') ?? ''",
    '  res.end(readFileSync(join(ROOT, name)))',
    '}',
    '',
  ].join('\n'),
  'src/config.js': [
    "export const SERVICE_API_KEY = 'svc_live_DUMMY0EXAMPLE0KEY000000'",
    'export const config = { port: 3000, serviceKey: SERVICE_API_KEY }',
    '',
  ].join('\n'),
  'src/cors.js': [
    'export function withCors(req, res) {',
    "  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')",
    "  res.setHeader('access-control-allow-credentials', 'true')",
    '}',
    '',
  ].join('\n'),
}

// The first line of `file` (1-based) that contains `needle`: a reference a scripted agent can cite that holds in the fixture.
export function lineOf(file, needle) {
  const i = TOY_FILES[file].split('\n').findIndex(l => l.includes(needle))
  if (i < 0) throw new Error(`${file} has no line containing ${JSON.stringify(needle)}`)
  return i + 1
}

// What each planted weakness is, by the fingerprint its candidate carries, and where an audit must point.
export const PLANTED = {
  'notes-byid-no-owner-check': { file: 'src/routes/notes.js', line: lineOf('src/routes/notes.js', 'note.owner is never compared'), title: 'a note is returned to any logged-in caller' },
  'files-name-unchecked-path-join': { file: 'src/routes/files.js', line: lineOf('src/routes/files.js', 'join(ROOT, name)'), title: 'a file name is joined onto the uploads directory unchecked' },
  'config-service-key-literal': { file: 'src/config.js', line: lineOf('src/config.js', 'SERVICE_API_KEY ='), title: 'a credential-shaped string is a constant in source' },
  'cors-origin-reflected-with-credentials': { file: 'src/cors.js', line: lineOf('src/cors.js', 'access-control-allow-origin'), title: 'every origin is allowed with credentials' },
}
