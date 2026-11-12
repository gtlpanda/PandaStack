// Splits a gate command into POSIX shell words, without running it, so autobuild
// can see what each gate sets and skips. Handles single and double quotes,
// backslashes, adjacent quoted parts ('"'"' joins), the operators && || ; | & and
// newlines as separate words, and the script of `bash -c` / `sh -c`, which is
// split again in place. Unquoted ( and ) of a subshell are words of their own.
// Command substitution `$(...)` and variables stay literal text.

const OPERATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];

// The index just past the `)` that closes the `$(` at `open` (quotes inside are skipped).
function substitutionEnd(text, open) {
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "'") { const close = text.indexOf("'", i + 1); if (close === -1) break; i = close; }
    else if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; }
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  throw new Error("unterminated command substitution");
}

export function shellWords(command) {
  const words = [];
  let word = "", inWord = false, i = 0;
  const end = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const text = String(command);
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) throw new Error("unterminated single quote");
      word += text.slice(i + 1, close); inWord = true; i = close + 1;
    } else if (c === '"') {
      i++; inWord = true;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "$" && text[i + 1] === "(") { const stop = substitutionEnd(text, i + 1); word += text.slice(i, stop); i = stop; continue; }
        if (text[i] === "\\" && /["\\$`\n]/.test(text[i + 1] ?? "")) { word += text[i + 1]; i += 2; } else { word += text[i]; i++; }
      }
      if (i >= text.length) throw new Error("unterminated double quote");
      i++;
    } else if (c === "\\") {
      if (text[i + 1] === "\n") { i += 2; continue; }
      word += text[i + 1] ?? ""; inWord = true; i += 2;
    } else if (c === "$" && text[i + 1] === "(") {
      const stop = substitutionEnd(text, i + 1);
      word += text.slice(i, stop); inWord = true; i = stop;
    } else if (c === "#" && !inWord) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === " " || c === "\t") {
      end(); i++;
    } else {
      const op = OPERATORS.find(o => text.startsWith(o, i));
      if (op) { end(); words.push(op); i += op.length; } else { word += c; inWord = true; i++; }
    }
  }
  end();
  // Inline the script of `bash -c '...'` so its words are analysed too.
  const out = [];
  for (let k = 0; k < words.length; k++) {
    out.push(words[k]);
    if (/^(?:.*\/)?(?:bash|sh)$/.test(words[k])) {
      let j = k + 1;
      while (j < words.length && /^-[A-Za-z]+$/.test(words[j]) && !words[j].includes("c")) out.push(words[j++]);
      if (j < words.length && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[j]) && j + 1 < words.length) {
        out.push(words[j], "(", ...shellWords(words[j + 1]), ")");
        k = j + 1;
      }
    }
  }
  return out;
}

const SEPARATORS = new Set(OPERATORS);

// Simple commands: the words between operators, with each one's working
// directory as set by earlier `cd DIR` commands (relative to the gate's root).
// A `cd` inside a subshell or a `bash -c` script ends with it.
export function simpleCommands(command) {
  const commands = [];
  let cwd = ".", current = [];
  const outer = [];
  const flush = () => {
    if (!current.length) return;
    const words = current[0] === "builtin" ? current.slice(1) : current;
    if (words[0] === "cd" && words[1]) cwd = joinPath(cwd, words[1]);
    else commands.push({ cwd, words: current });
    current = [];
  };
  for (const word of shellWords(command)) {
    if (!SEPARATORS.has(word)) { current.push(word); continue; }
    flush();
    if (word === "(") outer.push(cwd);
    else if (word === ")" && outer.length) cwd = outer.pop();
  }
  flush();
  return commands;
}

function joinPath(base, dir) {
  const parts = (dir.startsWith("/") ? [] : base.split("/")).concat(dir.split("/"));
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return (dir.startsWith("/") ? "/" : "") + (out.join("/") || ".");
}

// Variables a command sets for what it runs: leading NAME=value words, and
// those after `env` (whose -u NAME options are skipped).
export function assignments(words) {
  const found = [];
  let k = 0;
  const take = () => {
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) {
      const eq = words[k].indexOf("=");
      found.push({ name: words[k].slice(0, eq), value: words[k].slice(eq + 1) });
      k++;
    }
  };
  take();
  if (words[k] === "env") {
    k++;
    while (k < words.length && /^-/.test(words[k])) k += words[k] === "-u" ? 2 : 1;
    take();
  }
  return found;
}

// The values of an option given as `--name value` or `--name=value`.
export function optionValues(words, name) {
  const values = [];
  for (let k = 0; k < words.length; k++) {
    if (words[k] === name && k + 1 < words.length) values.push(words[++k]);
    else if (words[k].startsWith(`${name}=`)) values.push(words[k].slice(name.length + 1));
  }
  return values;
}
