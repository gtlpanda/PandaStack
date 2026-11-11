// A Codex CLI installed the way `npm install -g @openai/codex` lays it out:
// <prefix>/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js, with the
// package.json two levels above the real file. Returns the PATH directory to add.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function npmCodex(prefix, version, { target, name = "@openai/codex" } = {}) {
  const pkg = path.join(prefix, "lib", "node_modules", "@openai", "codex");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version }));
  // An inert script by default; `target` makes it forward to a scripted fake Codex.
  const body = target ? `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n` : "#!/bin/sh\nexit 0\n";
  writeFileSync(path.join(pkg, "bin", "codex.js"), body, { mode: 0o755 });
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", path.join(prefix, "bin", "codex"));
  return path.join(prefix, "bin");
}
