// Which Codex CLI a launch will use, and whether another install on PATH is newer.
// Read-only and never executes anything: a version comes from the npm package.json
// beside the install, so non-npm installs report an unknown version.
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CONTROL = /[\x00-\x1f\x7f]/g;

/**
 * Every executable `bin` on `pathString`, in PATH order, one entry per real file.
 * Relative PATH entries (and an explicit relative `bin`) are anchored at `base`, the
 * directory the CLI will be launched from. An explicit path yields at most itself.
 */
export function findInstalls(bin, pathString, base) {
  const anchor = (path) => (isAbsolute(path) || !base ? path : `${base}/${path}`);
  const candidates = bin.includes("/") ? [anchor(bin)]
    // Plain concatenation, not join(): the kernel resolves "..", after symlinks, the way the launch will.
    : String(pathString ?? "").split(delimiter).map((dir) => `${anchor(dir || ".")}/${bin}`);
  const installs = [];
  const seen = new Set();
  for (const file of candidates) {
    let real;
    try {
      accessSync(file, constants.X_OK);
      // .native resolves ".." after symlinks like the kernel; plain realpathSync collapses it first.
      real = realpathSync.native(file);
      if (!statSync(real).isFile()) continue;
    } catch {
      continue; // Missing, not executable, or a dangling link: not an install.
    }
    if (seen.has(real)) continue;
    seen.add(real);
    installs.push({ file, version: packageVersion(real) });
  }
  return installs;
}

/** The version of the @openai/codex package that owns `realFile`, or null. */
export function packageVersion(realFile) {
  let dir = dirname(realFile);
  for (let depth = 0; depth < 4; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg?.name === "@openai/codex") return typeof pkg.version === "string" && VERSION.test(pkg.version) ? pkg.version : null;
    } catch {
      // No readable package.json at this level; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Negative when a < b, positive when a > b, 0 when equal. Both must match X.Y.Z. */
export function compareVersions(a, b) {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

// A PATH directory name can hold control characters (from project config); never print them raw.
const printable = (file) => file.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
const describe = ({ file, version }) => `${printable(file)} (${version ?? "version unknown"})`;

/**
 * Summarize installs (the first one is the one in use). `newer` is set only when both
 * versions are known and another install is newer than the one in use.
 */
export function assessInstalls(installs) {
  if (installs.length === 0) return { inUse: null, others: [], newer: null, message: "No Codex CLI found on PATH." };
  const [inUse, ...others] = installs;
  const newer = inUse.version === null ? null : others.find((other) => other.version !== null && compareVersions(other.version, inUse.version) > 0) ?? null;
  let message = `Codex in use: ${describe(inUse)}.`;
  if (others.length) message += ` Warning: ${others.length} more on PATH: ${others.map(describe).join(", ")}.`;
  if (newer) message += ` The one in use is older than ${printable(newer.file)}; put that install first on PATH, remove the old one, or set AUTOBUILD_CODEX_BIN.`;
  return { inUse, others, newer, message };
}

/** autobuild preflight: refuse a launch whose Codex is older than another install on PATH. */
export function checkCodexLaunch(bin, pathString, base) {
  const assessment = assessInstalls(findInstalls(bin, pathString, base));
  return { ok: assessment.newer === null, message: assessment.message };
}
