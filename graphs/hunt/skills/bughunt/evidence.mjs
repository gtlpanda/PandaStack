#!/usr/bin/env node
// evidence.mjs - the only thing in /bughunt that runs code. It runs a
// reproduction test at the head and at the merge-base and decides, from real
// exit codes and a marker in the output, whether the finding is reproduced. No
// model's word goes into the result.
//   node evidence.mjs repro <state dir> F<n> [--timeout-ms <ms>]
//   node evidence.mjs recheck <state dir> [--timeout-ms <ms>]
//
// repro reads the reproducer's files under <state dir>/repro/F<n>/:
//   repro.json         {"test_file": "<repo-relative path of a new test file>"}
//   files/<test_file>  the test
// It never takes a command from anyone: the runner is chosen here from the
// test's language and the repo's own test setup, and called with an argument
// list, never as shell text. Each arm runs in a fresh export of its commit
// (a private index and checkout-index, so the repo itself is never touched,
// and no export attribute applies), with only an allowlist
// of the environment, a timeout, and, where unshare works, no network and its
// own PID namespace (see isolation()).
// It writes <state dir>/evidence/F<n>.json and prints lines ending with
//   EVIDENCE: REPRODUCED|PREEXISTING|NOT_REPRODUCED|ERROR F<n>
// recheck re-runs every reproduction and committed fix the ledger relies on and
// corrects the ledger to what the runs show (findings.mjs reconcile). It ends
// with RECHECK: PASS (nothing changed) or RECHECK: CORRECTED <n>.
//
// The repair commands work on the fix worktree, always <state dir>/fix (made by
// /bughunt or the /build-app driver, never by an agent):
//   node evidence.mjs fix <state dir> F<n>          FIX: PASS|FAIL|BLOCKED|ERROR F<n>
//   node evidence.mjs adversarial <state dir> F<n>  ADVERSARIAL: PASS|FAIL|ERROR F<n>
//   node evidence.mjs commit <state dir> F<n>       COMMIT: DONE|FAIL F<n> [<commit>]
//   node evidence.mjs revert <state dir> F<n>       REVERT: DONE|FAIL F<n>
// fix proves a repair three ways: the reproduction passes with it, fails again
// without it (the worktree's last commit), and the repo's own suite passes. It
// stages the repair as a git tree in a private index; the arms run on that tree,
// and commit commits that same tree (no hooks), so what is checked is what is
// committed. Every git call in the fix worktree runs without hooks or
// fsmonitor, in the sandbox environment.
// Exit 0 when it ran, 1 on an error it could not run past, 2 on usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, symlinkSync, realpathSync, openSync, closeSync, readdirSync, mkdtempSync, chmodSync, readlinkSync, fstatSync } from 'node:fs'
import { join, dirname, extname, normalize, relative, basename, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { invocation, reference, verifyManifest, noSymlinks, STEP_LIMIT } from '../../../../core/skills/verify/retention.mjs'
import { git as rawGit } from '../../../build/skills/build-app/driver/proc.mjs'
import { packageDirs } from '../../../../core/skills/verify/packages.mjs'
import { TEST_FILE } from '../../../build/skills/build-app/driver/checks.mjs'
import { readLedger, writeLedger, reconcile, reconcileFix } from '../../../../core/skills/findings/findings.mjs'

export const VERDICTS = ['REPRODUCED', 'PREEXISTING', 'NOT_REPRODUCED', 'ERROR']
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TEST_BYTES = 200_000
const TAIL_LINES = 40
const ID = /^F[1-9][0-9]*$/
// Every git call here runs without hooks or fsmonitor. Both are config the
// user's repo may set with a relative path, and that path resolves inside the
// checkout git runs in: the PR's own code. Measured 2026-11-06: `git status` in
// a worktree of the PR ran a committed fsmonitor script; with these flags it
// did not.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const git = (dir, args, opts) => rawGit(dir, [...SAFE_GIT, ...args], opts)
const MAX_FIX_FILES = 8                 // source files one repair may change
const MAX_ADVERSARIAL = 5
const SUITE_TIMEOUT_MS = 15 * 60_000
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
const VERIFY_SH = join(HERE, '..', '..', '..', '..', 'core', 'skills', 'verify', 'verify.sh')

// Only an allowlist of the environment reaches the code under test: what a
// toolchain needs to find itself. Never a credential, a database URL, a
// webhook, or how this machine signs in to Claude.
const ENV_ALLOW = /^(PATH|HOME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|TZ|NODE_ENV|NODE_PATH|GOPATH|GOROOT|GOCACHE|GOMODCACHE|GOFLAGS|GOTOOLCHAIN|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV|CONDA_PREFIX|JAVA_HOME|CARGO_HOME|RUSTUP_HOME)$/
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION)/i
export function sandboxEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (ENV_ALLOW.test(key) && !SECRET.test(key)) env[key] = value
  return Object.assign(env, { CI: 'true', NO_COLOR: '1' })
}

// What this machine can isolate, probed once. Measured on WSL2 (2026-11-06):
// - unshare -rnpf --kill-child gives a fresh PID namespace, so every process a
//   test starts, detached ones included, dies with the run;
// - inside it, `ip link set lo up` brings loopback back, so a test can start a
//   local server while the outside network stays unreachable;
// - GNU timeout -s KILL ends the whole group at the limit.
// Without the namespace, killing only the runner left a node --test child
// spinning forever, and a detached grandchild survived the run.
let probed = null
const namespaceArgv = (argv, seconds) => ['unshare', '-cnpf', '--keep-caps', '--kill-child', '--mount-proc', 'sh', '-c',
  'ip link set lo up || exit 125; exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all timeout -s KILL "$@"', 'sh', String(seconds), ...argv]
export function isolation() {
  if (probed) return probed
  let supported = false
  if (process.platform === 'linux' && process.getuid?.() > 0) {
    const check = String.raw`const fs=require('fs'),cp=require('child_process');const a=process.argv.slice(1);let ok=process.getuid()===+a[0]&&process.getgid()===+a[1];const caps=fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^Cap(Inh|Prm|Eff|Bnd|Amb):/.test(x));ok&&=caps.length===5&&caps.every(x=>/:\s*0+$/.test(x));for(const [i,n] of ['pid','net','user'].entries())ok&&=fs.readlinkSync('/proc/self/ns/'+n)!==a[i+2];const r=cp.spawnSync('ip',['-j','link','show'],{encoding:'utf8'});const links=r.status===0?JSON.parse(r.stdout):[];ok&&=links.length===1&&links[0].ifname==='lo'&&links[0].flags.includes('UP');process.exit(ok?0:1)`
    const argv = namespaceArgv([process.execPath, '-e', check, String(process.getuid()), String(process.getgid()), ...['pid','net','user'].map(n=>readlinkSync('/proc/self/ns/'+n))], 5)
    supported = spawnSync(argv[0], argv.slice(1), {stdio:'ignore', timeout:8000, killSignal:'SIGKILL', env:sandboxEnv()}).status === 0
  }
  probed = {pidns:supported,network:supported,loopback:supported,timeout:supported}
  return probed
}
export function wrapIsolation(argv, timeoutMs) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a=>typeof a!=='string'||a.includes('\0')) || !Number.isInteger(timeoutMs) || timeoutMs<=0) throw new Error('Invalid isolated invocation')
  if (!isolation().pidns) throw Object.assign(new Error('Required non-root execution isolation is unavailable'),{code:'ISOLATION_UNAVAILABLE'})
  return namespaceArgv(argv, Math.max(1,Math.ceil(timeoutMs/1000)))
}
function wrap(argv, seconds) { return wrapIsolation(argv, seconds*1000) }

export const markerFor = id => `BUGHUNT-${id}`

// Problems with the reproducer's declared test path, as plain strings. No
// component may start with "-", so the path can never be read as a flag.
export function testFileProblems(testFile) {
  if (typeof testFile !== 'string' || !testFile.trim()) return ['repro.json has no test_file']
  const p = []
  if (testFile.startsWith('/') || testFile.includes('\\') || testFile.includes('\0') || normalize(testFile) !== testFile || testFile.split('/').includes('..')) p.push(`test_file must be a plain repo-relative path, got ${JSON.stringify(testFile)}`)
  if (testFile.split('/').some(part => part.startsWith('-'))) p.push(`no part of test_file may start with "-", got ${JSON.stringify(testFile)}`)
  if (!TEST_FILE.test(testFile)) p.push(`test_file must be a test file by this repo's naming (tests/, __tests__/, *.test.*, *_test.go, test_*.py), got ${JSON.stringify(testFile)}`)
  return p
}

// Whether a tool is installed, asked where no code under review can answer: from
// an empty temp directory, in Python's isolated mode (-I: no current directory
// or user site on the path), with the sandbox environment and a short limit. A
// probe run inside the export once imported a pytest.py the PR committed, with
// the full environment and no sandbox (found in review, 2026-11-06).
function toolInstalled(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore', cwd: tmpdir(), env: sandboxEnv(), timeout: 20_000, killSignal: 'SIGKILL' }).status === 0
}

// The package a JavaScript test belongs to: the nearest directory above it
// with a package.json ('.' for the root). A monorepo has several.
export function packageDirOf(testFile, dir) {
  let d = dirname(testFile)
  while (d !== '.' && !existsSync(join(dir, d, 'package.json'))) d = dirname(d)
  return d
}

// The command for one test file, chosen from its language and the exported
// tree's own setup. Returns {argv, cwd} or {error}.
export function runnerFor(testFile, dir) {
  const ext = extname(testFile)
  if (/^\.(m|c)?(j|t)s$/.test(ext)) {
    const pkgDir = packageDirOf(testFile, dir)
    const root = pkgDir === '.' ? dir : join(dir, pkgDir)
    const rel = pkgDir === '.' ? testFile : testFile.slice(pkgDir.length + 1)
    let pkg = {}
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { /* no package.json: plain node */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const bin = name => [join(root, 'node_modules', '.bin', name), join(dir, 'node_modules', '.bin', name)].find(b => existsSync(b))
    if (deps.vitest) return bin('vitest') ? { argv: [bin('vitest'), 'run', rel], cwd: root } : { error: 'the package uses vitest but node_modules/.bin/vitest is not installed' }
    if (deps.jest) return bin('jest') ? { argv: [bin('jest'), '--runTestsByPath', rel], cwd: root } : { error: 'the package uses jest but node_modules/.bin/jest is not installed' }
    return { argv: [process.execPath, '--test', rel], cwd: root }
  }
  if (ext === '.py') {
    if (!toolInstalled('python3', ['-I', '-c', 'import pytest'])) return { error: 'pytest is not installed for python3' }
    return { argv: ['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', testFile], cwd: dir }
  }
  if (testFile.endsWith('_test.go')) {
    if (!toolInstalled('go', ['version'])) return { error: 'go is not installed' }
    return { argv: ['go', 'test', `./${dirname(testFile)}`], cwd: dir }
  }
  return { error: `no runner for ${ext || 'files without an extension'}` }
}

// A fresh copy of the commit or tree `sha` in `dir`, every file exactly as git
// stores it: read into a private index and checked out with checkout-index.
// Not git archive, which honors the tree's own export-ignore and export-subst,
// so a .gitattributes in a repair once hid a broken test from the check while
// the commit kept it (found in review). The repo itself is never touched, so
// any number of these can run at once.
function exportTree(repo, sha, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const index = { GIT_INDEX_FILE: join(dir, '..', `.index-${process.pid}-${relative(join(dir, '..'), dir).replace(/[^A-Za-z0-9]/g, '_')}`) }
  try {
    const read = spawnSync('git', ['-C', repo, ...SAFE_GIT, 'read-tree', sha], { encoding: 'utf8', env: { ...process.env, ...index } })
    if (read.status !== 0) return `reading ${sha} failed: ${String(read.stderr).trim()}`
    const out = spawnSync('git', ['-C', repo, ...SAFE_GIT, 'checkout-index', '-a', '-f', `--prefix=${dir}/`], { encoding: 'utf8', env: { ...process.env, ...index }, maxBuffer: 64 * 1024 * 1024 })
    if (out.status !== 0) return `checking out ${sha} failed: ${String(out.stderr).trim()}`
    return null
  } finally {
    rmSync(index.GIT_INDEX_FILE, { force: true })
  }
}

export function createSuiteExport({repo,tree}) {
  if(typeof repo!=='string'||typeof tree!=='string'||! /^[0-9a-f]{40,64}$/.test(tree))throw new Error('Invalid suite export source')
  const parent = realpathSync(tmpdir())
  for(let current=parent;;current=dirname(current)){
    if(basename(current)==='.git')throw new Error('Suite temporary location is inside Git metadata')
    if(current===dirname(current))break
  }
  const directory=mkdtempSync(join(parent,'bughunt-suite-'));chmodSync(directory,0o700)
  const env={...sandboxEnv(),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'bughunt export',GIT_AUTHOR_EMAIL:'export@localhost',GIT_COMMITTER_NAME:'bughunt export',GIT_COMMITTER_EMAIL:'export@localhost'}
  const call=(args,extra={})=>{
    const r=spawnSync('git',['-C',directory,...SAFE_GIT,'-c','commit.gpgsign=false','-c','core.autocrlf=false',...args],{env,encoding:'utf8',timeout:30000,maxBuffer:128*1024*1024,...extra})
    if(r.status!==0)throw new Error('Suite Git export failed');return r.stdout
  }
  let cleaned=false;const cleanup=()=>{if(!cleaned){rmSync(directory,{recursive:true,force:true});cleaned=true}}
  try{
    // Query storage format: a 40-character source identifier can also be a
    // SHA256 abbreviation. Identifier length cannot select the destination.
    const formatResult=git(repo,['rev-parse','--show-object-format'],{env,timeoutMs:30000})
    const format=formatResult.stdout.replace(/\n$/, '')
    if(!formatResult.ok||!['sha1','sha256'].includes(format))throw new Error('Suite source object format is unavailable')
    call(['init','-q','--template=',`--object-format=${format}`])
    const objects=git(repo,['rev-parse','--path-format=absolute','--git-path','objects'],{env,timeoutMs:30000});if(!objects.ok)throw new Error('Suite source object directory is unavailable')
    // Git parses this as a path list. C-quote one element so literal colons,
    // quotes and backslashes cannot change its meaning; controls use octal.
    const objectDirectory=objects.stdout.replace(/\n$/, '')
    const quotedDirectory=objectDirectory.replace(/["\\\x00-\x1f\x7f]/g, c=>'\\'+c.charCodeAt(0).toString(8).padStart(3,'0'))
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES='"'+quotedDirectory+'"'
    call(['read-tree',tree])
    const entries=call(['ls-files','--stage','-z']).split('\0').filter(Boolean).map(e=>{const m=/^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(e);if(!m||m[3].split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')||!['100644','100755','120000'].includes(m[1]))throw new Error('Unsupported suite tree entry');return {mode:m[1],sha:m[2],path:m[3]}})
    // Restore literal object bytes, bypassing checkout conversions/attributes.
    // The small-object path is bounded independently of tree size. Larger
    // regular blobs go directly from Git to their owned destination fd; neither
    // their contents nor the aggregate tree occupy a subprocess stdout buffer.
    const maxBufferedBlob=1024*1024
    for(const entry of entries){
      const input=Buffer.from(entry.sha+'\n')
      const info=call(['cat-file','--batch-check'],{input})
      const match=/^([0-9a-f]+) blob (0|[1-9][0-9]*)\n$/.exec(info)
      if(!match||match[0]!==info||match[1]!==entry.sha)throw new Error('Invalid exported blob')
      const size=Number(match[2])
      if(!Number.isSafeInteger(size))throw new Error('Invalid exported blob size')
      const path=join(directory,entry.path)
      mkdirSync(dirname(path),{recursive:true})
      if(size<=maxBufferedBlob){
        const bytes=call(['cat-file','--batch'],{encoding:null,input})
        const header=Buffer.from(`${entry.sha} blob ${size}\n`)
        if(!Buffer.isBuffer(bytes)||bytes.length!==header.length+size+1||!bytes.subarray(0,header.length).equals(header)||bytes.at(-1)!==10)throw new Error('Incomplete exported blob')
        const data=bytes.subarray(header.length,header.length+size)
        if(entry.mode==='120000')symlinkSync(data,path)
        else{writeFileSync(path,data,{flag:'wx',mode:0o600});chmodSync(path,entry.mode==='100755'?0o755:0o644)}
      }else{
        // Symlink targets must fit the bounded metadata path; no unbounded
        // allocation just because an object declares itself a link target.
        if(entry.mode==='120000')throw new Error('Unsupported suite symlink size')
        const fd=openSync(path,'wx',0o600)
        try{
          call(['cat-file','blob',entry.sha],{encoding:null,stdio:['ignore',fd,'pipe']})
          if(fstatSync(fd).size!==size)throw new Error('Incomplete exported blob')
        }finally{closeSync(fd)}
        chmodSync(path,entry.mode==='100755'?0o755:0o644)
      }
    }
    const snapshotTree=call(['rev-parse',tree+'^{tree}']).trim();const commit=call(['commit-tree',snapshotTree,'-m','Private source-only suite snapshot']).trim();call(['update-ref','HEAD',commit])
    // Objects are copied into this source-only repository; no persistent alternate or source ref.
    call(['repack','-a','-d']);delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
    return {directory,cleanup}
  }catch(e){cleanup();throw e}
}

// Shared fixed parents only; invocation() still owns private allocation and
// ownership validation. Sequential reuse does not imply a hostile race guarantee.
export function prepareCaptureDirectories(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || stateDir.includes('\0')) throw new Error('Invalid capture state directory')
  const directory = path => {
    noSymlinks(path)
    if (!lstatSync(path).isDirectory()) throw new Error('Capture path must be a directory')
  }
  directory(stateDir)
  const evidence = join(stateDir, 'evidence'), root = join(evidence, 'logs')
  for (const path of [evidence, root]) {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    directory(path)
  }
  // Preserve the evidence parent's mode; only the validated logs root hardens.
  chmodSync(root, 0o700)
  return { stateDir, evidence, root }
}

function armCapture(workDir,name){
  const {stateDir,root}=prepareCaptureDirectories(dirname(dirname(workDir)))
  const dir=invocation(root),path=join(dir,name+'.out');return {stateDir,dir,path}
}
function captureResult(capture,result){
  const path=join(capture.dir,'capture.json');if(!existsSync(path))return {complete:false,error:result.status===124||result.status===137||result.signal==='SIGKILL'||result.error?.code==='ETIMEDOUT'?null:'Evidence capture receipt is unavailable'}
  try{noSymlinks(path);if(lstatSync(path).size>1024)throw new Error('Capture receipt too large');const receipt=JSON.parse(readFileSync(path,'utf8'));if(receipt.schemaVersion!==1||typeof receipt.complete!=='boolean'||!Number.isInteger(receipt.exitCode)||receipt.exitCode!==result.status||receipt.bytes!==lstatSync(capture.path).size)throw new Error('Invalid capture receipt');return {complete:receipt.complete,error:receipt.complete?null:'Evidence capture did not complete'};}catch{return {complete:false,error:'Evidence capture receipt is invalid'}}
}
const CAPTURE_JS=join(dirname(VERIFY_SH),'retention.mjs')

// Installed dependencies are not in git: link the repo's own, at the root and
// for the test's package.
function linkDeps(repo, dir, pkgDir) {
  for (const d of new Set(['.', pkgDir])) {
    const from = join(repo, d, 'node_modules')
    const to = join(dir, d, 'node_modules')
    if (existsSync(from) && existsSync(join(dir, d)) && !existsSync(to)) symlinkSync(from, to)
  }
}

// Suites can import sibling libraries even when those libraries have no tests.
// Discover only real immediate package directories in the immutable export.
function linkSuiteDeps(repo, dir) {
  for (const pkg of ['.', ...packageDirs(dir)]) {
    const from = join(repo, pkg, 'node_modules')
    const to = join(dir, pkg, 'node_modules')
    if (!existsSync(from)) continue
    if (existsSync(to)) throw new Error(`suite dependency directory already exists: ${pkg}/node_modules`)
    // Keep the container private so config bundlers/cache writers cannot write
    // through a node_modules symlink into the user's installed dependencies.
    mkdirSync(to)
    for (const name of readdirSync(from)) {
      if (name.startsWith('.') && name !== '.bin') continue
      symlinkSync(join(from, name), join(to, name))
    }
  }
}

// The test's directory, walked part by part in the export: a part the commit
// made a symlink (or a file) would send the write outside the export.
function unsafeTestPath(dir, testFile) {
  let cur = dir
  for (const part of testFile.split('/')) {
    cur = join(cur, part)
    let st
    try { st = lstatSync(cur) } catch { return null }
    if (st.isSymbolicLink()) return `${relative(dir, cur)} is a symlink in this commit`
    if (cur !== join(dir, testFile) && !st.isDirectory()) return `${relative(dir, cur)} is a file in this commit, not a directory`
  }
  return null
}

// One test run in a fresh export of `source.sha` (a commit, or the staged
// tree of a repair).
function runArm(repo, source, arm, testFile, testText, workDir, timeoutMs, marker) {
  const dir = join(workDir, arm)
  const sha = source.sha
  const fail = error => ({ arm, sha, exit: null, timedOut: false, marker: false, error, tail: '' })
  const err = exportTree(repo, sha, dir)
  if (err) return fail(err)
  const unsafe = unsafeTestPath(dir, testFile)
  if (unsafe) return fail(unsafe)
  mkdirSync(dirname(join(dir, testFile)), { recursive: true })
  writeFileSync(join(dir, testFile), testText)
  linkDeps(repo, dir, packageDirOf(testFile, dir))
  const runner = runnerFor(testFile, dir)
  if (runner.error) return fail(runner.error)
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  // Output goes to a file, not a pipe: a child that keeps the pipe open can
  // never hold the run past its own end.
  const capture=armCapture(workDir,arm),outFile=capture.path
  const argv=wrap([process.execPath,CAPTURE_JS,'relay','--receipt',join(capture.dir,'capture.json'),'--',...runner.argv],seconds)
  const fd = openSync(outFile, 'wx',0o600)
  const started = Date.now()
  let r
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd: runner.cwd, env: sandboxEnv(), stdio: ['ignore', fd, fd], timeout: isolation().timeout ? (seconds + 15) * 1000 : timeoutMs, killSignal: 'SIGKILL' })
  } finally {
    closeSync(fd)
  }
  const captured=captureResult(capture,r)
  const out = readFileSync(outFile, 'utf8')
  const killed = r.signal === 'SIGKILL' || r.status === 137 || r.status === 124
  const timedOut = Boolean((r.error && r.error.code === 'ETIMEDOUT') || (killed && Date.now() - started >= seconds * 1000 - 100))
  // 126 and 127 are the shell's and timeout's "could not run it": no test ran.
  const notRun = !timedOut && (r.status === 126 || r.status === 127)
  const i = isolation()
  return {
    arm, sha, command: runner.argv.map(a => a.replace(dir + '/', '')),
    network: i.network ? `blocked${i.loopback ? ', loopback up' : ''}` : 'not blocked', processes: i.pidns ? 'own PID namespace' : i.timeout ? 'process group' : 'runner only',
    exit: r.status, timedOut, marker: out.includes(marker),
    error: captured.error ? captured.error : r.error && !timedOut ? r.error.message : notRun ? `the runner could not start (exit ${r.status})` : null,
    tail: out.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
    log: reference(capture.stateDir,outFile,captured.complete),
  }
}

// The verdict from the two arms. Only a test that passes at the head is
// NOT_REPRODUCED. A failure without the marker is no evidence either way
// (ERROR): a missing tool, an environment problem, or a test that breaks for
// another reason. After a marked failure at the head, the merge-base decides:
// passing, or failing without the marker (the code under test is new), means
// this change introduced it; failing with the marker means it was already there.
export function verdictOf(head, base) {
  if (head.error) return ['ERROR', `the test could not run at the head: ${head.error}`]
  if (head.timedOut) return ['ERROR', 'the test timed out at the head']
  if (head.exit === 0) return ['NOT_REPRODUCED', 'the test passes at the head']
  if (!head.marker) return ['ERROR', 'the test fails at the head without its marker: it fails for another reason, which is no evidence either way']
  if (!base) return ['ERROR', 'the merge-base arm did not run']
  if (base.error) return ['ERROR', `the test could not run at the merge-base: ${base.error}`]
  if (base.timedOut) return ['ERROR', 'the test timed out at the merge-base']
  if (base.exit === 0) return ['REPRODUCED', 'fails at the head with its marker, passes at the merge-base']
  if (!base.marker) return ['REPRODUCED', 'fails at the head with its marker; at the merge-base it fails for another reason (the code under test is new)']
  return ['PREEXISTING', 'fails with its marker at the merge-base too: this change did not introduce it']
}

// The evidence file for one finding, merged by kind: a repro run never erases
// the fix runs, and the reverse. Top-level head, verdict, reason, and test_file
// describe the reproduction; `fix`, `adversarial`, and `commit` carry theirs.
export function readEvidenceRecord(stateDir, id) {
  try { return JSON.parse(readFileSync(join(stateDir, 'evidence', `${id}.json`), 'utf8')) } catch { return { finding_id: id, runs: [] } }
}
function writeEvidence(stateDir, id, kind, runs, fields) {
  const record = readEvidenceRecord(stateDir, id)
  const at = new Date().toISOString()
  if (kind === 'repro') Object.assign(record, fields, { at })
  else record[kind] = { ...fields, at }
  record.finding_id = id
  record.runs = [...(record.runs || []).filter(r => (r.kind || 'repro') !== kind), ...runs.map(r => ({ kind, ...r }))]
  mkdirSync(join(stateDir, 'evidence'), { recursive: true })
  const path = join(stateDir, 'evidence', `${id}.json`)
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
  return record
}

function readIntake(stateDir) {
  const doc = JSON.parse(readFileSync(join(stateDir, 'intake.json'), 'utf8'))
  if (!doc || !doc.target || !doc.target.head || !doc.target.mergeBase || !doc.repo) throw new Error(`${join(stateDir, 'intake.json')} is not an intake file`)
  return doc
}

// Runs one finding's reproduction and writes its evidence file. Never throws
// past a finding: anything that goes wrong is an ERROR verdict. Returns
// {id, verdict, reason, runs, lines}.
export function repro(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lines = []
  const intake = readIntake(stateDir)
  const done = (verdict, reason, extra = {}) => {
    lines.push(`EVIDENCE ${id}: ${reason}`, `EVIDENCE: ${verdict} ${id}`)
    const runs = extra.runs || []
    writeEvidence(stateDir, id, 'repro', runs, { head: intake.target.head, verdict, reason, test_file: extra.test_file || null })
    return { id, verdict, reason, runs, lines }
  }
  const dir = join(stateDir, 'repro', id)
  let spec
  try { spec = JSON.parse(readFileSync(join(dir, 'repro.json'), 'utf8')) } catch (e) { return done('ERROR', `no readable repro.json in ${dir}: ${e.message}`) }
  const testFile = spec && spec.test_file
  const problems = testFileProblems(testFile)
  if (problems.length) return done('ERROR', problems.join('; '))
  const source = join(dir, 'files', testFile)
  let st
  try { st = lstatSync(source) } catch { return done('ERROR', `the test is missing at ${source}`) }
  if (!st.isFile()) return done('ERROR', `the test at ${source} must be a regular file, not a link or directory`)
  if (st.size > MAX_TEST_BYTES) return done('ERROR', `the test is ${st.size} bytes; the limit is ${MAX_TEST_BYTES}`)
  if (git(intake.repo, ['cat-file', '-e', `${intake.target.head}:${testFile}`]).ok) return done('ERROR', `${testFile} already exists at the head: a reproduction is a new file`)
  // The reproducer may write only its own directory; a changed analysis tree
  // means it wrote where the code under review lives.
  if (intake.tree && existsSync(intake.tree)) {
    const dirty = git(intake.tree, ['status', '--porcelain'])
    if (!dirty.ok || dirty.stdout.trim()) return done('ERROR', 'the analysis tree was modified; reproductions are written only under repro/<id>/', { test_file: testFile })
  }
  const text = readFileSync(source)
  const marker = markerFor(id)
  const work = join(stateDir, 'work', id)
  try {
    const head = runArm(intake.repo, { sha: intake.target.head }, 'head', testFile, text, work, timeoutMs, marker)
    lines.push(`EVIDENCE ${id} runner: ${(head.command || []).join(' ') || 'none'} (network ${head.network || 'n/a'}; ${head.processes || 'n/a'})`)
    lines.push(`EVIDENCE ${id} head ${intake.target.head.slice(0, 7)}: ${head.timedOut ? 'timed out' : head.error ? `error: ${head.error}` : `exit ${head.exit}`}${head.marker ? `, ${marker} seen` : ''}`)
    const needBase = !head.error && !head.timedOut && head.exit !== 0 && head.marker
    const base = needBase ? runArm(intake.repo, { sha: intake.target.mergeBase }, 'merge-base', testFile, text, work, timeoutMs, marker) : null
    if (base) lines.push(`EVIDENCE ${id} merge-base ${intake.target.mergeBase.slice(0, 7)}: ${base.timedOut ? 'timed out' : base.error ? `error: ${base.error}` : `exit ${base.exit}`}${base.marker ? `, ${marker} seen` : ''}`)
    const [verdict, reason] = verdictOf(head, base)
    return done(verdict, reason, { test_file: testFile, runs: [head, base].filter(Boolean).map(r => ({ kind: 'repro', ...r })) })
  } catch (e) {
    return done('ERROR', `the run failed: ${e.message}`, { test_file: testFile })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Re-runs every reproduction the ledger relies on and corrects the ledger to
// match, writing it after each finding so a cut-off recheck keeps what it
// proved. A status that claims a run (reproduced, preexisting, not_reproduced)
// with no written reproduction behind it at this head is an ERROR, which takes
// the finding back to confirmed. Returns {checked, corrected, lines}.
export function recheck(stateDir, opts = {}) {
  const intake = readIntake(stateDir)
  const ledgerFile = join(stateDir, 'ledger.json')
  let ledger = readLedger(ledgerFile, intake.key)
  const lines = []
  const corrected = []
  let checked = 0
  for (const f of ledger.findings) {
    if (f.stale || !['confirmed', 'reproduced', 'preexisting', 'not_reproduced'].includes(f.verification_status)) continue
    const written = Boolean(f.reproduction_artifact && f.reproduction_artifact.written === true)
    const claimsRun = f.verification_status !== 'confirmed'
    if (!written && !claimsRun) continue
    let r
    if (!written || !existsSync(join(stateDir, 'repro', f.finding_id, 'repro.json'))) {
      r = { verdict: 'ERROR', reason: 'no reproduction was written for this finding at this head, so its status has no run behind it', runs: [] }
    } else {
      try { r = repro(stateDir, f.finding_id, opts) } catch (e) { r = { verdict: 'ERROR', reason: `the recheck failed: ${e.message}`, runs: [] } }
    }
    checked += 1
    lines.push(`RECHECK ${f.finding_id}: ${r.verdict} (the ledger said ${f.verification_status})`)
    // test_results carry every run on file for this finding: the reproduction, and any fix runs.
    const all = written ? readEvidenceRecord(stateDir, f.finding_id).runs || r.runs : r.runs
    const out = reconcile(ledger, { [f.finding_id]: { verdict: r.verdict, reason: r.reason, runs: all } }, intake.files)
    ledger = out.ledger
    writeLedger(ledgerFile, ledger)
    corrected.push(...out.corrected)
  }
  // A committed repair is proven again from its commit.
  for (const f of ledger.findings) {
    const sha = f.fix_artifact && f.fix_artifact.commit
    if (f.stale || !sha || !['verified', 'proposed'].includes(f.fix_status)) continue
    const r = recheckFix(stateDir, intake, f.finding_id, sha, f.fix_artifact.branch, opts)
    checked += 1
    lines.push(`RECHECK ${f.finding_id} fix ${sha.slice(0, 7)}: ${r.verdict} (${r.reason})`)
    const out = reconcileFix(ledger, { [f.finding_id]: r })
    ledger = out.ledger
    writeLedger(ledgerFile, ledger)
    corrected.push(...out.corrected)
  }
  for (const c of corrected) lines.push(`RECHECK ${c.finding_id}: corrected ${c.from} -> ${c.to}`)
  lines.push(corrected.length ? `RECHECK: CORRECTED ${corrected.length}` : 'RECHECK: PASS')
  return { checked, corrected: corrected.length, lines }
}

// ---------- repair ----------

// git in the fix worktree, which holds the PR's code: SAFE_GIT, no system
// config, and the sandbox environment. A post-commit hook the PR committed once
// ran here with the full environment (found in review).
function wgit(dir, args, extraEnv = {}) {
  const r = spawnSync('git', ['-C', dir, ...SAFE_GIT, ...args], { encoding: 'utf8', env: { ...sandboxEnv(), GIT_CONFIG_NOSYSTEM: '1', ...extraEnv }, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' }
}

// The fix worktree, checked: <state dir>/fix must be a real directory (not a
// symlink) holding a linked worktree of this repo, and git's own record of
// which worktree owns its admin dir (<admin dir>/gitdir) must name this exact
// .git. Without that last check a repairer could point .git at the user's own
// worktree's admin dir, or at the repo, and commit and revert acted on the
// user's branch and files (found in review, twice). Its last commit must
// descend from the head under review. Returns {dir, head} or {error}.
function fixWorktree(stateDir, intake) {
  const dir = join(stateDir, 'fix')
  let st
  try { st = lstatSync(dir) } catch { return { error: `no fix worktree at ${dir}; /bughunt --propose or --fix makes it` } }
  if (!st.isDirectory()) return { error: `${dir} must be a directory, not a symlink` }
  let dotgit
  try { dotgit = lstatSync(join(dir, '.git')) } catch { return { error: `${dir} is not a git worktree` } }
  if (!dotgit.isFile()) return { error: `${dir}/.git must be a linked worktree's .git file` }
  const repoCommon = git(intake.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
  const gitDir = wgit(dir, ['rev-parse', '--absolute-git-dir']).stdout.trim()
  const top = wgit(dir, ['rev-parse', '--show-toplevel']).stdout.trim()
  let inside = false
  try {
    const admin = realpathSync(gitDir)
    const owner = readFileSync(join(admin, 'gitdir'), 'utf8').trim()
    // git names a linked worktree's admin dir after the worktree's directory: fix, fix1, ...
    inside = admin.startsWith(`${realpathSync(repoCommon)}/worktrees/`) && /^fix[0-9]*$/.test(basename(admin)) && realpathSync(top) === realpathSync(dir) && realpathSync(owner) === realpathSync(join(dir, '.git'))
  } catch { inside = false }
  if (!inside) return { error: `${dir} is not the linked worktree of ${intake.repo} it claims to be` }
  // HEAD is detached (propose) or exactly the fix branch (fix): never a branch
  // under review, which commit would otherwise move (found in review).
  const branchRef = `refs/heads/bughunt/${intake.key}`
  const sym = wgit(dir, ['symbolic-ref', '-q', 'HEAD'])
  const ref = sym.ok ? sym.stdout.trim() : null
  if (ref !== null && ref !== branchRef) return { error: `the fix worktree's HEAD is ${ref}; it must be detached or ${branchRef}` }
  const head = wgit(dir, ['rev-parse', 'HEAD']).stdout.trim()
  if (!wgit(dir, ['merge-base', '--is-ancestor', intake.target.head, head]).ok) return { error: `the fix worktree's commit ${head.slice(0, 7)} does not descend from the head under review` }
  return { dir, head, ref }
}

// Every path the staged tree changes against HEAD: exactly what would be
// checked and committed. Never git status, which reads the worktree's own index
// (skip-worktree or assume-unchanged hid edits from every guard; found in
// review). No rename detection: a rename is a delete plus an add, so a test
// "moved" away is seen as deleted. [{status, path}].
function changesOf(dir, tree) {
  const r = wgit(dir, ['diff-tree', '-r', '--no-renames', '-z', '--name-status', 'HEAD', tree])
  if (!r.ok) throw new Error(`git diff-tree failed in ${dir}`)
  const parts = r.stdout.split('\0').filter(Boolean)
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] })
  return out
}

// The tree the repair would commit: HEAD plus every change, ignored files
// excluded, modes and symlink targets included, staged in a private index so
// the worktree's own index is untouched. Both the fingerprint and the arms the
// checks run come from it, so what is checked is what is committed.
function stagedTree(dir, work) {
  mkdirSync(work, { recursive: true })
  const index = { GIT_INDEX_FILE: join(work, `index-${process.pid}`) }
  try {
    if (!wgit(dir, ['read-tree', 'HEAD'], index).ok) throw new Error('git read-tree failed')
    if (!wgit(dir, ['add', '-A'], index).ok) throw new Error('git add failed')
    const t = wgit(dir, ['write-tree'], index)
    if (!t.ok) throw new Error('git write-tree failed')
    return t.stdout.trim()
  } finally {
    rmSync(index.GIT_INDEX_FILE, { force: true })
  }
}

// Files that define what the suite runs or expects. A repair may add one but
// never edit or delete one: changing the test script to "true" made a broken
// repair pass (found in review).
const SUITE_FILE = /(^|\/)(package\.json|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|go\.mod|Makefile|\.mocharc[^/]*|(jest|vitest|vite|karma|playwright|cypress|babel)\.config\.[^/]+|tsconfig[^/]*\.json)$|\.snap$|(^|\/)__snapshots__\/|(^|\/)scripts\/(test|validate)\.sh$/

// The reproduction behind a finding, when a test proved it fails at the head
// with its marker: REPRODUCED, or PREEXISTING (failing at the merge-base too),
// which the graph counts as reproduced when the change wrote the finding's
// lines. A missed PREEXISTING here once let such a repair skip the proof and
// pass on the suite alone (found by the first live benchmark run). Such a
// finding must have a readable reproduction, or the check fails closed; any
// other finding (approved by the human) is checked without one. Returns
// {repro} | {none: true} | {error}.
function reproFor(stateDir, id) {
  const rec = readEvidenceRecord(stateDir, id)
  if (rec.verdict !== 'REPRODUCED' && rec.verdict !== 'PREEXISTING') return { none: true }
  try {
    const spec = JSON.parse(readFileSync(join(stateDir, 'repro', id, 'repro.json'), 'utf8'))
    if (testFileProblems(spec.test_file).length || spec.test_file !== rec.test_file) throw new Error('its repro.json no longer names the test that reproduced it')
    const src = join(stateDir, 'repro', id, 'files', spec.test_file)
    if (!lstatSync(src).isFile()) throw new Error('the test is not a regular file')
    return { repro: { testFile: spec.test_file, text: readFileSync(src) } }
  } catch (e) {
    return { error: `the reproduction that proved this finding is unreadable: ${e.message}` }
  }
}

// The repo's own suite (the verify skill) in `dir`, sandboxed. Returns
// {pass, failing: [step], timedOut, tail}.
function runSuite(dir, workDir, name, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const capture=armCapture(workDir,name),outFile=capture.path,verifyRoot=join(capture.dir,'verify')
  const argv=wrap([process.execPath,CAPTURE_JS,'relay','--receipt',join(capture.dir,'capture.json'),'--','bash',VERIFY_SH,'.'],seconds)
  mkdirSync(verifyRoot,{mode:0o700})
  const fd=openSync(outFile,'wx',0o600),started=Date.now();let r
  try{r=spawnSync(argv[0],argv.slice(1),{cwd:dir,env:{...sandboxEnv(),VERIFY_EVIDENCE_DIR:verifyRoot},stdio:['ignore',fd,fd],timeout:(seconds+15)*1000,killSignal:'SIGKILL'})}finally{closeSync(fd)}
  const lines=readFileSync(outFile,'utf8').trimEnd().split('\n'),last=lines.at(-1)||''
  const failing=lines.map(l=>l.match(/^  \[(\d+)\] (.+)$/)).filter(m=>m&&m[1]!=='0').map(m=>m[2])
  const timedOut=Boolean(r.error?.code==='ETIMEDOUT'||((r.signal==='SIGKILL'||r.status===137||r.status===124)&&Date.now()-started>=seconds*1000-100))
  const captured=captureResult(capture,r),log=reference(capture.stateDir,outFile,captured.complete)
  let verification=null,error=captured.error|| (r.error&&!timedOut?'Suite execution failed':null)
  const markers=lines.filter(l=>l.startsWith('VERIFY_EVIDENCE: ')).map(l=>l.slice('VERIFY_EVIDENCE: '.length))
  try{
    for(const marker of markers){const rel=relative(verifyRoot,resolve(marker));if(!rel||rel.startsWith('../')||isAbsolute(rel))throw new Error('Verification marker is outside its allocation')}
    if(markers.length){const manifest=markers.at(-1),verified=verifyManifest(verifyRoot,manifest);verification={...verified,path:relative(capture.stateDir,manifest)};if(!verified.complete)throw new Error('Incomplete verification capture')}
    // A timed-out verifier may not have emitted its final manifest. Captured bytes remain useful.
    // Missing nested logs cannot produce a successful fix; baseline failure classification still uses the retained suite transcript.
  }catch{error='Verification evidence manifest or capture is invalid'}
  return {exit:r.status,pass:!timedOut&&!error&&r.status===0&&last==='VERIFY: PASS',failing,timedOut,error,log,verification,tail:lines.slice(-TAIL_LINES).join('\n')}
}

// Prints `<KIND> F<n>: <reason>` then `<KIND>: <verdict> F<n>[ <extra>]`.
function report(kind, id, verdict, reason, extra = '') {
  return [`${kind} ${id}: ${reason}`, `${kind}: ${verdict} ${id}${extra ? ` ${extra}` : ''}`]
}

// One command's wall clock: the runner agent's Bash call allows 10 minutes, so
// every arm and suite gets what is left of FIX_BUDGET_MS. A suite that cannot
// fit is BLOCKED, never a guess.
const FIX_BUDGET_MS = 9 * 60_000
function clock(budgetMs) {
  const until = Date.now() + budgetMs
  return { left: () => until - Date.now() }
}

// Proves the repair in the fix worktree for one finding. PASS: commit may
// follow. FAIL: this attempt is wrong (feedback, retry). BLOCKED: no attempt
// can pass the check as things stand (a human decides). ERROR: the check
// cannot run at all.
export function fix(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS, suiteTimeoutMs = SUITE_TIMEOUT_MS, budgetMs = FIX_BUDGET_MS } = {}) {
  const intake = readIntake(stateDir)
  const time = clock(budgetMs)
  const out = (verdict, reason, fields = {}, runs = []) => {
    writeEvidence(stateDir, id, 'fix', runs, { verdict, reason, ...fields })
    return { verdict, reason, lines: report('FIX', id, verdict, reason) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('ERROR', wt.error)
  // A fresh check: adversarial tests from an earlier attempt never judge this one.
  rmSync(join(stateDir, 'repro', id, 'adversarial'), { recursive: true, force: true })
  const proof = reproFor(stateDir, id)
  if (proof.error) return out('BLOCKED', proof.error)
  const repro = proof.repro || null
  const work = join(stateDir, 'work', `${id}-fix`)
  rmSync(work, { recursive: true, force: true })
  let changes
  try { changes = changesOf(wt.dir, stagedTree(wt.dir, work)) } catch (e) { return out('ERROR', `staging the repair failed: ${e.message}`) }
  if (!changes.length) return out('FAIL', 'the repair changed nothing')
  // A fix may add tests and suite files; it never edits or deletes one that
  // exists, which is how a counterfeit fix makes a suite pass.
  for (const c of changes) {
    if (repro && c.path === repro.testFile) {
      if (!existsSync(join(wt.dir, c.path)) || !readFileSync(join(wt.dir, c.path)).equals(repro.text)) return out('FAIL', `the repair changed the reproduction test ${c.path}; it must stay as written`)
      continue
    }
    const existed = wgit(wt.dir, ['cat-file', '-e', `HEAD:${c.path}`]).ok
    if (existed && TEST_FILE.test(c.path)) return out('FAIL', `the repair changed an existing test, ${c.path}; a fix may add tests, never edit or delete one`)
    if (existed && SUITE_FILE.test(c.path)) return out('FAIL', `the repair changed ${c.path}, which defines what the suite runs; a fix never edits it`)
  }
  const source = changes.filter(c => !TEST_FILE.test(c.path))
  if (source.length > MAX_FIX_FILES) return out('FAIL', `the repair changed ${source.length} source files; a minimal fix changes at most ${MAX_FIX_FILES}`)
  // The reproduction joins the change as its regression test, at a path no
  // earlier fix already took.
  if (repro) {
    if (wgit(wt.dir, ['cat-file', '-e', `HEAD:${repro.testFile}`]).ok) return out('BLOCKED', `${repro.testFile} already exists in the fix worktree (an earlier fix committed a test there); this reproduction needs its own path`)
    const unsafe = unsafeTestPath(wt.dir, repro.testFile)
    if (unsafe) return out('FAIL', unsafe)
    mkdirSync(dirname(join(wt.dir, repro.testFile)), { recursive: true })
    writeFileSync(join(wt.dir, repro.testFile), repro.text)
  }
  const runs = []
  const suiteExports=[]
  try {
    const tree = stagedTree(wt.dir, work)
    const files = changesOf(wt.dir, tree).map(c => c.path)
    const marker = markerFor(id)
    const armTime = () => Math.min(timeoutMs, time.left())
    if (repro) {
      const fixed = runArm(intake.repo, { sha: tree }, 'fixed', repro.testFile, repro.text, work, armTime(), marker)
      runs.push(fixed)
      if (fixed.error || fixed.timedOut) return out('FAIL', `with the repair the reproduction could not finish: ${fixed.error || 'timed out'}`, { tree }, runs)
      if (fixed.exit !== 0) return out('FAIL', `with the repair the reproduction still fails${fixed.marker ? ' with its marker: the bug is still there' : ' (for another reason)'}`, { tree }, runs)
      const without = runArm(intake.repo, { sha: wt.head }, 'without', repro.testFile, repro.text, work, armTime(), marker)
      runs.push(without)
      if (without.error || without.timedOut || without.exit === 0 || !without.marker) return out('FAIL', 'without the repair the reproduction does not fail with its marker, so it cannot tell a fix from no fix', { tree }, runs)
    }
    // The suite with the repair must pass. Without it, the suite decides only
    // whether the failure is new (FAIL) or was already there (BLOCKED: a
    // regression inside a failing step cannot be told apart, so no such repair
    // is ever committed).
    const suiteTime = () => Math.min(suiteTimeoutMs, time.left() - 5_000)
    if (suiteTime() < 30_000) return out('BLOCKED', 'no time is left in this check for the suite; the suite must fit in what the 9-minute check leaves', { tree }, runs)
    const fixedExport=createSuiteExport({repo:intake.repo,tree});suiteExports.push(fixedExport)
    linkSuiteDeps(intake.repo,fixedExport.directory)
    const withFix=runSuite(fixedExport.directory,work,'suite-fixed',suiteTime())
    runs.push({ arm: 'suite with the repair', sha: tree, exit: withFix.exit, timedOut: withFix.timedOut, marker: false, error: withFix.error, failing: withFix.failing, tail: withFix.tail,log:withFix.log,verification:withFix.verification })
    if (withFix.error) return out('ERROR',withFix.error,{tree},runs)
    if (withFix.pass&&!withFix.verification) return out('ERROR','Missing verification evidence manifest',{tree},runs)
    if (withFix.pass) return out('PASS', `${repro ? 'the reproduction passes with the repair and fails without it; ' : 'no reproduction proved this finding (the human approved it); '}the suite passes`, { tree, files }, runs)
    if (withFix.timedOut) return out('BLOCKED', 'the suite did not finish in the time this check allows', { tree }, runs)
    if (suiteTime() < 30_000) return out('BLOCKED', 'the suite fails with the repair, and no time is left to see whether it failed without it', { tree }, runs)
    const baseExport=createSuiteExport({repo:intake.repo,tree:wt.head});suiteExports.push(baseExport)
    linkSuiteDeps(intake.repo,baseExport.directory)
    const base=runSuite(baseExport.directory,work,'suite-base',suiteTime())
    runs.push({ arm: 'suite without the repair', sha: wt.head, exit: base.exit, timedOut: base.timedOut, marker: false, error: base.error, failing: base.failing, tail: base.tail,log:base.log,verification:base.verification })
    if(base.timedOut)return out('BLOCKED','the baseline suite without the repair timed out; comparison is incomplete',{tree},runs)
    if(base.error)return out('ERROR',base.error,{tree},runs)
    const worse = withFix.failing.filter(step => !base.failing.includes(step))
    if (base.pass || worse.length) return out('FAIL', `the repair breaks the suite: ${worse.length ? worse.join('; ') : 'it passes without the repair and fails with it'}`, { tree }, runs)
    return out('BLOCKED', `the suite already fails without the repair, at ${base.failing.join('; ') || 'a step it could not name (no stack detected?)'}; a regression inside those steps cannot be told apart, so this repair is left for a human`, { tree }, runs)
  } catch (e) {
    return out('ERROR', `the check failed: ${e.message}`, {}, runs)
  } finally {
    for(const exported of suiteExports)exported.cleanup()
    rmSync(work, { recursive: true, force: true })
  }
}

// Runs the fix verifier's adversarial tests against the checked repair. They
// assert correct behavior, so each must pass; the staged tree must be exactly
// the one fix checked (the verifier never edits the worktree).
export function adversarial(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS, budgetMs = FIX_BUDGET_MS } = {}) {
  const intake = readIntake(stateDir)
  const time = clock(budgetMs)
  const out = (verdict, reason, runs = []) => {
    writeEvidence(stateDir, id, 'adversarial', runs, { verdict, reason })
    return { verdict, reason, lines: report('ADVERSARIAL', id, verdict, reason) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('ERROR', wt.error)
  const checked = readEvidenceRecord(stateDir, id).fix
  if (!checked || checked.verdict !== 'PASS') return out('FAIL', 'the repair has not passed its fix check')
  const work = join(stateDir, 'work', `${id}-adv`)
  rmSync(work, { recursive: true, force: true })
  const runs = []
  try {
    if (stagedTree(wt.dir, work) !== checked.tree) return out('FAIL', 'the worktree changed after the fix check; adversarial tests are run against the checked repair only')
    const dir = join(stateDir, 'repro', id, 'adversarial')
    if (!existsSync(join(dir, 'adversarial.json'))) return out('PASS', 'no adversarial tests were written')
    let files
    try { files = JSON.parse(readFileSync(join(dir, 'adversarial.json'), 'utf8')).test_files } catch (e) { return out('FAIL', `adversarial.json is unreadable: ${e.message}`) }
    if (!Array.isArray(files) || files.length > MAX_ADVERSARIAL) return out('FAIL', `adversarial.json must list at most ${MAX_ADVERSARIAL} test_files`)
    for (const [i, file] of files.entries()) {
      const problems = testFileProblems(file)
      if (problems.length) return out('FAIL', problems.join('; '), runs)
      if (wgit(wt.dir, ['cat-file', '-e', `${checked.tree}:${file}`]).ok) return out('FAIL', `${file} already exists; an adversarial test is a new file`, runs)
      const src = join(dir, 'files', file)
      let st
      try { st = lstatSync(src) } catch { return out('FAIL', `the adversarial test is missing at ${src}`, runs) }
      if (!st.isFile() || st.size > MAX_TEST_BYTES) return out('FAIL', `the adversarial test at ${src} must be a regular file under ${MAX_TEST_BYTES} bytes`, runs)
      if (time.left() < 10_000) return out('FAIL', 'no time is left in this check for the remaining adversarial tests', runs)
      const r = runArm(intake.repo, { sha: checked.tree }, `adversarial-${i + 1}`, file, readFileSync(src), work, Math.min(timeoutMs, time.left()), '\0never')
      runs.push({ ...r, test_file: file })
      if (r.error || r.timedOut || r.exit !== 0) return out('FAIL', `${file} fails against the repair: ${r.error || (r.timedOut ? 'timed out' : `exit ${r.exit}`)}`, runs)
    }
    return out('PASS', `${files.length} adversarial test(s) pass against the repair`, runs)
  } catch (e) {
    return out('ERROR', `the run failed: ${e.message}`, runs)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Commits exactly the tree fix checked, with plumbing (commit-tree and
// update-ref), so no hook can run and nothing unchecked rides along.
export function commit(stateDir, id) {
  const intake = readIntake(stateDir)
  const out = (verdict, reason, sha = '') => {
    writeEvidence(stateDir, id, 'commit', [], { verdict, reason, commit: sha || null })
    return { verdict, reason, sha, lines: report('COMMIT', id, verdict, reason, sha) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('FAIL', wt.error)
  const checked = readEvidenceRecord(stateDir, id).fix
  if (!checked || checked.verdict !== 'PASS') return out('FAIL', 'the repair has not passed its fix check')
  const work = join(stateDir, 'work', `${id}-commit`)
  try {
    if (stagedTree(wt.dir, work) !== checked.tree) return out('FAIL', 'the worktree changed after the fix check')
    const proof = reproFor(stateDir, id)
    const msg = `bughunt: fix ${id}\n\n${proof.repro ? `Regression test: ${proof.repro.testFile} (fails without this change, passes with it).\n` : ''}Checked by evidence.mjs fix; see the bughunt ledger for the finding.`
    const who = wgit(wt.dir, ['config', 'user.email']).stdout.trim() ? {} : { GIT_AUTHOR_NAME: 'bughunt', GIT_AUTHOR_EMAIL: 'bughunt@localhost', GIT_COMMITTER_NAME: 'bughunt', GIT_COMMITTER_EMAIL: 'bughunt@localhost' }
    const made = wgit(wt.dir, ['commit-tree', checked.tree, '-p', wt.head, '-m', msg], who)
    if (!made.ok) return out('FAIL', `git commit-tree failed: ${made.out.trim()}`)
    const sha = made.stdout.trim()
    // The explicit ref fixWorktree pinned, or a detached HEAD: never through a symref.
    const moved = wt.ref ? wgit(wt.dir, ['update-ref', '-m', `bughunt: fix ${id}`, wt.ref, sha, wt.head]) : wgit(wt.dir, ['update-ref', '--no-deref', '-m', `bughunt: fix ${id}`, 'HEAD', sha, wt.head])
    const synced = moved.ok && wgit(wt.dir, ['reset', '-q']).ok
    if (!synced) return out('FAIL', `could not move the fix worktree to ${sha.slice(0, 7)}: ${moved.out.trim()}`)
    return out('DONE', 'committed in the fix worktree', sha)
  } catch (e) {
    return out('FAIL', `the commit failed: ${e.message}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Puts the fix worktree back to its last commit, dropping a failed repair: the
// index rebuilt from HEAD (no skip-worktree or assume-unchanged left), every
// file restored, every untracked or ignored file and nested repo removed. DONE
// only once the worktree stages to exactly HEAD's tree.
export function revert(stateDir, id) {
  const intake = readIntake(stateDir)
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', wt.error) }
  const steps = [['read-tree', 'HEAD'], ['checkout-index', '-a', '-f'], ['clean', '-ffdqx']].map(a => wgit(wt.dir, a))
  const failed = steps.find(x => !x.ok)
  if (failed) return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', failed.out.trim()) }
  const work = join(stateDir, 'work', `${id}-revert`)
  try {
    const left = changesOf(wt.dir, stagedTree(wt.dir, work))
    if (left.length) return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', `the worktree still differs from its last commit: ${left.map(c => c.path).join(', ')}`) }
  } catch (e) {
    return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', e.message) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { verdict: 'DONE', lines: report('REVERT', id, 'DONE', `the fix worktree is back at ${wt.head.slice(0, 7)}`) }
}

// A committed repair, re-proven from its commit: the commit is still on a
// branch the run kept (the fix worktree's HEAD, or `branch`), the reproduction
// passes at it and fails at its parent. Returns {verdict: PASS|FAIL, reason}.
function recheckFix(stateDir, intake, id, sha, branch, opts) {
  if (!git(intake.repo, ['cat-file', '-e', `${sha}^{commit}`]).ok) return { verdict: 'FAIL', reason: `the fix commit ${sha.slice(0, 7)} no longer exists` }
  const wt = fixWorktree(stateDir, intake)
  const onWorktree = !wt.error && git(intake.repo, ['merge-base', '--is-ancestor', sha, wt.head]).ok
  const onBranch = typeof branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(branch) && git(intake.repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok && git(intake.repo, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]).ok
  if (!onWorktree && !onBranch) return { verdict: 'FAIL', reason: `the fix commit ${sha.slice(0, 7)} is no longer on the fix worktree or ${branch || 'any kept branch'}` }
  const proof = reproFor(stateDir, id)
  if (proof.error) return { verdict: 'FAIL', reason: proof.error }
  if (!proof.repro) return { verdict: 'PASS', reason: 'the commit is kept; no reproduction proved this finding (the human approved it)' }
  const repro = proof.repro
  const parent = git(intake.repo, ['rev-parse', `${sha}^`]).stdout.trim()
  const work = join(stateDir, 'work', `${id}-refix`)
  try {
    const marker = markerFor(id)
    const fixed = runArm(intake.repo, { sha }, 'fixed', repro.testFile, repro.text, work, opts.timeoutMs || DEFAULT_TIMEOUT_MS, marker)
    if (fixed.error || fixed.timedOut || fixed.exit !== 0) return { verdict: 'FAIL', reason: `at the fix commit the reproduction does not pass (${fixed.error || (fixed.timedOut ? 'timed out' : `exit ${fixed.exit}`)})` }
    const without = runArm(intake.repo, { sha: parent }, 'without', repro.testFile, repro.text, work, opts.timeoutMs || DEFAULT_TIMEOUT_MS, marker)
    if (without.error || without.timedOut || without.exit === 0 || !without.marker) return { verdict: 'FAIL', reason: 'at the fix commit\'s parent the reproduction does not fail with its marker' }
    return { verdict: 'PASS', reason: 'the reproduction passes at the fix commit and fails at its parent' }
  } catch (e) {
    return { verdict: 'FAIL', reason: `the recheck failed: ${e.message}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const USAGE = 'usage: evidence.mjs repro|fix|adversarial|commit|revert <state dir> F<n> [--timeout-ms <ms>] | evidence.mjs recheck <state dir> [--timeout-ms <ms>]'
const COMMANDS = { repro, fix, adversarial, commit: (d, id) => commit(d, id), revert: (d, id) => revert(d, id) }

function main(argv) {
  const opts = {}
  const at = argv.indexOf('--timeout-ms')
  if (at >= 0) {
    const ms = Number(argv[at + 1])
    if (!Number.isInteger(ms) || ms <= 0) { console.error(USAGE); return 2 }
    opts.timeoutMs = ms
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)]
  }
  const [cmd, stateDir, id, ...rest] = argv
  try {
    if (COMMANDS[cmd] && stateDir && ID.test(id || '') && !rest.length) {
      for (const l of COMMANDS[cmd](stateDir, id, opts).lines) console.log(l)
      return 0
    }
    if (cmd === 'recheck' && stateDir && id === undefined) {
      for (const l of recheck(stateDir, opts).lines) console.log(l)
      return 0
    }
  } catch (e) {
    console.log(`EVIDENCE: ERROR ${e.message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
