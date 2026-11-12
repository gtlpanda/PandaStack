// A reader for the YAML that GitHub Actions workflows use: block mappings and
// sequences, plain, quoted and block (| >) scalars, comments, and single-line
// flow collections. Every scalar is a string. Anchors, aliases, tags, merge
// keys, multi-document files and multi-line flow collections are refused, so an
// unsupported file fails loudly instead of being misread.

export class WorkflowYamlError extends Error {}

const fail = (lineNo, why) => { throw new WorkflowYamlError(`line ${lineNo}: ${why}`); };

// Drops a comment: `#` at the start or after whitespace, outside quotes.
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") i++;   // '' is an escaped quote, not the end
      else if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1])) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function lex(source) {
  const lines = [];
  source.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)[0])) fail(i + 1, "tab indentation");
    lines.push({ no: i + 1, raw, indent: raw.match(/^ */)[0].length, text: stripComment(raw.trim()) });
  });
  return lines;
}

function unquote(text, lineNo) {
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail(lineNo, "unterminated single-quoted scalar");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) fail(lineNo, "unterminated double-quoted scalar");
  const escapes = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", 0: "\0", " ": " " };
  return text.slice(1, -1).replace(/\\(.)/g, (_, c) => {
    if (!(c in escapes)) fail(lineNo, `unsupported escape \\${c}`);
    return escapes[c];
  });
}

function splitFlow(body, lineNo) {
  const items = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { items.push(body.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || depth) fail(lineNo, "unbalanced flow collection");
  const last = body.slice(start).trim();
  if (last) items.push(last);
  return items;
}

function scalar(text, lineNo) {
  if (text === "") return null;
  if (/^[&*!]/.test(text)) fail(lineNo, "anchors, aliases and tags are not supported");
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text, lineNo);
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) fail(lineNo, "multi-line flow sequences are not supported");
    return splitFlow(text.slice(1, -1), lineNo).map(item => scalar(item, lineNo));
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) fail(lineNo, "multi-line flow mappings are not supported");
    const out = {};
    for (const item of splitFlow(text.slice(1, -1), lineNo)) {
      const pair = splitKey(item, lineNo);
      if (!pair) fail(lineNo, "flow mapping entry without a key");
      out[pair.key] = scalar(pair.rest, lineNo);
    }
    return out;
  }
  return text;
}

// "key: rest" or "key:" outside quotes, or null when the text is not a mapping entry.
function splitKey(text, lineNo) {
  let key, rest;
  if (text.startsWith('"') || text.startsWith("'")) {
    const close = text.startsWith('"') ? /^"(?:[^"\\]|\\.)*"/.exec(text) : /^'(?:[^']|'')*'/.exec(text);
    if (!close) return null;
    const after = text.slice(close[0].length);
    if (!/^:(\s|$)/.test(after)) return null;
    key = unquote(close[0], lineNo);
    rest = after.slice(1).trim();
  } else {
    const m = /^([^\s#'"{[\]},][^#]*?):(\s+|$)(.*)$/.exec(text);
    if (!m || /^- /.test(text)) return null;
    key = m[1];
    rest = m[3].trim();
  }
  if (key === "<<") fail(lineNo, "merge keys are not supported");
  return { key, rest };
}

function blockScalar(lines, index, parentIndent, header, lineNo) {
  const m = /^([|>])([+-]?)$/.exec(header);
  if (!m) fail(lineNo, `unsupported block scalar header ${header}`);
  const body = [];
  let i = index, blockIndent = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.raw.trim() === "") { body.push(""); continue; }
    if (line.indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = line.indent;
    if (line.indent < blockIndent) fail(line.no, "block scalar line is less indented than its first line");
    body.push(line.raw.slice(blockIndent));
  }
  while (body.length && body[body.length - 1] === "") body.pop();
  let text = m[1] === "|" ? body.join("\n") : body.reduce((out, l, k) => (k === 0 ? l : out + (l === "" ? "\n" : (out.endsWith("\n") ? "" : " ")) + l), "");
  if (m[2] !== "-" && body.length) text += "\n";
  return { value: text, next: i };
}

const isDocumentMarker = (line) => line.indent === 0 && (line.text === "---" || line.text === "...");

function nextContent(lines, i) {
  while (i < lines.length && lines[i].text === "") i++;
  return i;
}

function parseValue(lines, i, parentIndent, rest, lineNo) {
  if (rest === "") {
    const j = nextContent(lines, i);
    if (j < lines.length && lines[j].indent > parentIndent) return parseNode(lines, j, lines[j].indent);
    // A sequence may sit at its key's indentation: "key:\n- item".
    if (j < lines.length && lines[j].indent === parentIndent && /^-(\s|$)/.test(lines[j].text)) return parseNode(lines, j, parentIndent);
    return { value: null, next: i };
  }
  if (/^[|>]/.test(rest)) return blockScalar(lines, i, parentIndent, rest, lineNo);
  return { value: scalar(rest, lineNo), next: i };
}

function parseNode(lines, start, indent) {
  const first = lines[start];
  if (/^-(\s|$)/.test(first.text)) return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

function parseMapping(lines, start, indent, inlineFirst = null) {
  const out = {};
  let i = start;
  const take = (text, lineNo, at) => {
    const pair = splitKey(text, lineNo);
    if (!pair) fail(lineNo, `expected "key: value", found ${JSON.stringify(text)}`);
    if (Object.hasOwn(out, pair.key)) fail(lineNo, `duplicate key ${pair.key}`);
    const { value, next } = parseValue(lines, at, indent, pair.rest, lineNo);
    out[pair.key] = value;
    return next;
  };
  if (inlineFirst) i = take(inlineFirst.text, inlineFirst.no, start);
  for (i = nextContent(lines, i); i < lines.length; i = nextContent(lines, i)) {
    const line = lines[i];
    if (line.indent < indent || isDocumentMarker(line)) break;
    if (line.indent > indent) fail(line.no, "unexpected indentation");
    if (/^-(\s|$)/.test(line.text)) break;
    i = take(line.text, line.no, i + 1);
  }
  return { value: out, next: i };
}

function parseSequence(lines, start, indent) {
  const out = [];
  let i = start;
  for (i = nextContent(lines, i); i < lines.length; i = nextContent(lines, i)) {
    const line = lines[i];
    if (isDocumentMarker(line)) break;
    if (line.indent !== indent || !/^-(\s|$)/.test(line.text)) {
      if (line.indent > indent) fail(line.no, "unexpected indentation");
      break;
    }
    const body = line.text.replace(/^-\s*/, "");
    if (body === "") {
      const { value, next } = parseValue(lines, i + 1, indent, "", line.no);
      out.push(value);
      i = next;
    } else if (splitKey(body, line.no)) {
      // "- key: value" opens a mapping at the key's column.
      const column = indent + (line.text.length - body.length);
      const { value, next } = parseMapping(lines, i + 1, column, { text: body, no: line.no });
      out.push(value);
      i = next;
    } else {
      const { value, next } = parseValue(lines, i + 1, indent, body, line.no);
      out.push(value);
      i = next;
    }
  }
  return { value: out, next: i };
}

export function parseWorkflowYaml(source) {
  const lines = lex(String(source));
  let i = nextContent(lines, 0);
  if (i < lines.length && lines[i].text === "---") i = nextContent(lines, i + 1);
  if (i >= lines.length) return {};
  if (lines[i].indent !== 0) fail(lines[i].no, "the document must start at column 0");
  const { value, next } = parseNode(lines, i, 0);
  const rest = nextContent(lines, next);
  if (rest < lines.length) fail(lines[rest].no, lines[rest].text === "---" || lines[rest].text === "..." ? "multiple documents are not supported" : "unexpected content");
  return value;
}
