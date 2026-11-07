// The /build-app guard's rules, pure so they are tested without a session.
// rules: { repo: real absolute repo path, frozen: [repo-relative test files],
//          writable: [absolute files a session may write even inside .git],
//          writableDirs: [absolute directories it may write anywhere under] }.
// writableDirs is the bug hunt's own state dir: its reproductions, its result,
// and the fix worktree the repairer edits.
// Denied: git push, remote changes, commands that rewrite or discard history or
// work, touching the integration branch, recursive rm of / ~ $HOME, edits inside
// .git, and edits to test files frozen by slices that already landed. It covers
// the common spellings, not every one: the driver's checks after the session are
// the backstop (a frozen test changed any way at all, or a commit it did not
// expect, keeps the slice from landing).
import { existsSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'

// A git subcommand (with its arguments) a slice session never needs, with why.
const GIT_DENY = [
  [a => a[0] === 'push', 'git push: nothing leaves this machine until the whole app is built'],
  [a => a[0] === 'send-pack', 'git push: nothing leaves this machine until the whole app is built'],
  [a => a[0] === 'remote' && ['add', 'set-url', 'remove', 'rm', 'rename'].includes(a[1]), 'git remote changes'],
  [a => a[0] === 'reset' && a.includes('--hard'), 'git reset --hard discards work'],
  [a => ['rebase', 'filter-branch', 'filter-repo', 'update-ref', 'replace'].includes(a[0]), 'rewriting history'],
  [a => a[0] === 'branch' && a.slice(1).some(x => /^-[a-zA-Z]*[DfM]/.test(x) || x === '--force'), 'force-deleting, forcing, or moving a branch'],
  [a => a[0] === 'clean' && a.slice(1).some(x => /^-[a-zA-Z]*f/.test(x) || x === '--force') && !a.slice(1).some(x => /^-[a-zA-Z]*n/.test(x) || x === '--dry-run'), 'git clean deletes untracked work'],
  [a => ['checkout', 'switch', 'branch', 'merge', 'reset'].includes(a[0]) && a.slice(1).some(x => /(^|[/:])integration\//.test(x)), 'the driver lands slices on the integration branch; a session never touches it'],
]
// git options before the subcommand that take a value.
const GIT_VALUE_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace']
// Words that run the command after them, with their options that take a
// value (so `timeout -s KILL 30 gh ...` and `sudo -u bob gh ...` reach gh).
const PREFIXES = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], sudo: ['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t'],
  nohup: [], time: ['-f', '-o', '--format', '--output'], command: [], exec: ['-a'], builtin: [],
  xargs: ['-n', '-I', '-i', '-L', '-l', '-P', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'],
  nice: ['-n', '--adjustment'], timeout: ['-s', '--signal', '-k', '--kill-after'], stdbuf: ['-i', '-o', '-e'],
}
// Shell reserved words that can stand before a command in a segment.
const KEYWORDS = ['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'in', 'esac', ';;', '[[', ']]']
const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh']

// Heredoc bodies are data (a commit message, a file), never commands - unless
// the line that opens one runs a shell, which then reads the body as a
// script. Returns { text, scripts: [body fed to a shell] }.
function splitHeredocs(text) {
  const lines = String(text).split('\n')
  const out = []
  const scripts = []
  let end = null
  let body = null
  for (const line of lines) {
    if (end !== null) {
      if (line.trim() === end) { if (body) scripts.push(body.join('\n')); end = null; body = null } else if (body) body.push(line)
      continue
    }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) {
      end = m[2]
      const opener = line.slice(0, m.index)
      body = parse(opener).segments.some(t => SHELLS.includes(commandOf(t).word)) ? [] : null
    }
  }
  return { text: out.join('\n'), scripts }
}

// Splits into simple commands at unquoted ; & | newlines, and lifts out every
// command substitution ($(...) and backticks outside single quotes) as its own
// script. Returns { segments: [[token]], subs: [script] }; quotes are removed
// from tokens, so a quoted commit message is one token, never a command.
function parse(text) {
  const segments = []
  const subs = []
  let tokens = []
  let tok = ''
  let inTok = false
  let q = null
  const endTok = () => { if (inTok) tokens.push(tok); tok = ''; inTok = false }
  const endSeg = () => { endTok(); if (tokens.length) segments.push(tokens); tokens = [] }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (q === "'") { if (ch === "'") q = null; else tok += ch; continue }
    if (ch === '\\' && i + 1 < text.length) { tok += text[i + 1]; inTok = true; i += 1; continue }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth; j += 1) { if (text[j] === '(') depth += 1; else if (text[j] === ')') depth -= 1 }
      subs.push(text.slice(i + 2, j - 1))
      tok += 'SUBST'
      inTok = true
      i = j - 1
      continue
    }
    if (ch === '`') {
      const j = text.indexOf('`', i + 1)
      subs.push(text.slice(i + 1, j < 0 ? text.length : j))
      tok += 'SUBST'
      inTok = true
      i = j < 0 ? text.length : j
      continue
    }
    if (q === '"') { if (ch === '"') q = null; else tok += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; inTok = true; continue }
    if (/[;&|\n()]/.test(ch)) { endSeg(); continue }
    if (/\s/.test(ch)) { endTok(); continue }
    tok += ch
    inTok = true
  }
  endSeg()
  return { segments, subs }
}

// The command word of a simple command and its arguments, after reserved
// words (do, then, !, {), variable assignments, and prefix commands (env,
// sudo, timeout 30, ...). env holds the VAR=value assignments it passed.
function commandOf(tokens) {
  let i = 0
  const env = {}
  for (;;) {
    if (i < tokens.length && KEYWORDS.includes(tokens[i])) { i += 1; continue }
    if (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      const eq = tokens[i].indexOf('=')
      env[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1)
      i += 1
      continue
    }
    const word = i < tokens.length ? basename(tokens[i]) : ''
    if (Object.hasOwn(PREFIXES, word)) {
      i += 1
      while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '-') { if (PREFIXES[word].includes(tokens[i])) i += 1; i += 1 }
      if (word === 'timeout' && i < tokens.length) i += 1   // the duration
      continue
    }
    return { word, args: tokens.slice(i + 1), env }
  }
}

// The script a shell runs from -c (also combined, as in -lc or -ec), or null.
function shellScript(args) {
  const i = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null
}

// Every simple command a Bash command line runs, in order, as {word, args,
// env}: command substitutions first, then each segment, with eval, `sh -c`,
// and heredocs fed to a shell expanded in place. A shell with no script
// (reading one from a pipe) is marked {stdinScript: true}; a script nested
// past depth 5 yields {tooDeep: true}. Shared with the /bughunt review gate.
export function simpleCommands(command, depth = 0, out = []) {
  if (depth > 5) { out.push({ word: '', args: [], env: {}, tooDeep: true }); return out }
  const { text, scripts } = splitHeredocs(command)
  const { segments, subs } = parse(text)
  for (const sub of subs) simpleCommands(sub, depth + 1, out)
  for (const body of scripts) simpleCommands(body, depth + 1, out)
  for (const tokens of segments) {
    const c = commandOf(tokens)
    out.push(c)
    if (c.word === 'eval') simpleCommands(c.args.join(' '), depth + 1, out)
    if (SHELLS.includes(c.word)) {
      const script = shellScript(c.args)
      if (script !== null) simpleCommands(script, depth + 1, out)
      else if (!c.args.some(a => !a.startsWith('-'))) c.stdinScript = true
    }
  }
  return out
}

// git's subcommand and its arguments, after the options that come before it
// (-C <dir>, -c <k=v>, ...). opts holds those options with their values.
export function gitSubcommand(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) { if (GIT_VALUE_OPTS.includes(args[i])) i += 1; i += 1 }
  return { opts: args.slice(0, i), sub: args.slice(i) }
}

export function decideBash(command) {
  for (const { word, args, tooDeep } of simpleCommands(command)) {
    if (tooDeep) return 'a command nested too deeply to check'
    if (word === 'git') {
      const { sub } = gitSubcommand(args)
      for (const [match, why] of GIT_DENY) if (match(sub)) return why
    }
    if (word === 'rm' && args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') && args.some(a => ['/', '/*', '~', '~/', '$HOME', '$HOME/', '${HOME}', '${HOME}/'].includes(a))) {
      return 'recursive rm of /, ~, or $HOME'
    }
  }
  return null
}

// The real path of a file that may not exist yet: its nearest existing parent,
// resolved, plus the rest. So a symlinked repo or ../ cannot dodge the rules.
function realish(p) {
  let head = p
  const rest = []
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head) }
  try { head = realpathSync(head) } catch { /* keep it as given */ }
  return join(head, ...rest)
}

// Whether any existing part of `abs` below `dir` is a symlink. realish cannot
// resolve a dangling link, so without this a link inside a writable dir
// pointing at a file not yet created (say .git/hooks/post-merge) would look
// inside it while the write landed outside (found in review).
function symlinkBelow(dir, abs) {
  let cur = dir
  for (const part of relative(dir, abs).split('/').filter(Boolean)) {
    cur = join(cur, part)
    let st
    try { st = lstatSync(cur) } catch { return false }
    if (st.isSymbolicLink()) return true
  }
  return false
}

// The reason to deny one tool call, or null to let it run.
export function decide(tool, params, rules) {
  if (tool === 'Bash') return decideBash(params.command || '')
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return null
  const file = params.file_path || params.notebook_path
  if (typeof file !== 'string' || !file) return null
  const repo = realish(rules.repo)
  const abs = realish(isAbsolute(file) ? file : resolve(repo, file))
  const rel = relative(repo, abs).split('\\').join('/')
  if ((rules.writable || []).some(w => realish(w) === abs)) return null
  if ((rules.writableDirs || []).some(d => { const dir = realish(d); return (abs === dir || abs.startsWith(`${dir}/`)) && !symlinkBelow(dir, abs) })) return null
  if (rel === '.git' || rel.startsWith('.git/')) return 'editing inside .git'
  if ((rules.frozen || []).includes(rel)) return `${rel} is a frozen test from a slice that already landed; add a new test instead of changing it`
  return null
}
