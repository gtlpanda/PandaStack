// ci-optimizer state: per-machine, per-repository JSON files kept outside the repository
// (spec/contracts/ci-optimizer-priority.md, "State directory").
//   <state home>/autobuild/ci/<first 24 hex of sha256(realpath(root))>/<name>.json
// Directories are created 0700 and files written 0600 through a temporary file and a rename.
// A state directory or file that is a symbolic link is refused (STATE_UNSAFE) on reads and
// writes alike, and nothing is read or written through it.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const STATE_SCHEMA_VERSION = 1;
// The contract's state names: profile, history, baseline, validation (and any later one of the same shape).
const STATE_NAME = /^[a-z][a-z0-9-]*$/;

/** An error a `ci` subcommand reports as `autobuild ci: <code>: <detail>` and exits with `exit`. */
export class CiError extends Error {
  constructor(code, detail, exit = 3) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.exit = exit;
  }
}

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");

function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);   // a root that does not exist yet has no state to share
  }
}

/** The repository's state directory. A computed path only: nothing is created. */
export function ciStateDir(root, env = process.env) {
  const home = env.AUTOBUILD_STATE_HOME || env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(home, "autobuild", "ci", sha256hex(realRoot(root)).slice(0, 24));
}

/** lstat, or null when the path does not exist. Any other failure is a state I/O error. */
function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CiError("STATE_IO", `cannot inspect ${target}: ${error.message}`);
  }
}

/** The state directory when it exists as a real directory, null when absent; refuses a link or a non-directory. */
function checkedDir(dir) {
  const stat = lstatOrNull(dir);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new CiError("STATE_UNSAFE", `state directory ${dir} is a symbolic link; refusing to use it`);
  if (!stat.isDirectory()) throw new CiError("STATE_UNSAFE", `state directory ${dir} is not a directory; refusing to use it`);
  return dir;
}

function checkedName(name) {
  if (typeof name !== "string" || !STATE_NAME.test(name)) throw new CiError("STATE_IO", `invalid state name ${JSON.stringify(name)}`);
  return name;
}

const stateFile = (dir, name) => path.join(dir, `${name}.json`);

function refuseLinkedFile(file) {
  const stat = lstatOrNull(file);
  if (stat?.isSymbolicLink()) throw new CiError("STATE_UNSAFE", `state file ${file} is a symbolic link; refusing to use it`);
  if (stat && !stat.isFile()) throw new CiError("STATE_UNSAFE", `state file ${file} is not a regular file; refusing to use it`);
}

/**
 * The stored object for `name`, or null when it is absent, does not parse as a JSON object, or
 * has a different schemaVersion. A linked directory or file throws STATE_UNSAFE.
 */
export function readState(root, name, env = process.env) {
  checkedName(name);
  const dir = checkedDir(ciStateDir(root, env));
  if (!dir) return null;
  const file = stateFile(dir, name);
  refuseLinkedFile(file);
  let text;
  let fd;
  try {
    // O_NOFOLLOW closes the gap between the lstat above and the read.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    text = readFileSync(fd, "utf8");
  } catch (error) {
    if (error instanceof CiError) throw error;
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") throw new CiError("STATE_UNSAFE", `state file ${file} is a symbolic link; refusing to use it`);
    throw new CiError("STATE_IO", `cannot read ${file}: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;   // treated as absent; the next write replaces it
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  return doc;
}

/** Creates the state directory (0700) when absent and returns it; refuses a link. */
function ensureDir(root, env) {
  const dir = ciStateDir(root, env);
  if (checkedDir(dir)) return dir;
  try {
    // A umask only clears bits, so 0700 stays 0700. No chmod afterwards: it would follow a link
    // planted between the check above and this mkdir; the recheck below refuses one instead.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CiError("STATE_IO", `cannot create state directory ${dir}: ${error.message}`);
  }
  return checkedDir(dir);
}

/** Writes `value` as `<name>.json` atomically with mode 0600. */
export function writeState(root, name, value, env = process.env) {
  checkedName(name);
  const dir = ensureDir(root, env);
  const file = stateFile(dir, name);
  refuseLinkedFile(file);
  const draft = path.join(dir, `.${name}.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // "wx": the draft is always a new file, so it can never be a planted link.
    writeFileSync(draft, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(draft, file);
  } catch (error) {
    rmSync(draft, { force: true });
    throw new CiError("STATE_IO", `cannot write ${file}: ${error.message}`);
  }
}
