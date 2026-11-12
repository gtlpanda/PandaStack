// Which files a repository declares as generated evidence, not code. Shared by
// /bughunt intake (it leaves them out of a hunt) and autobuild's commit guard
// (it keeps new ones out of git). Nothing here knows any repository's layout:
// a path counts only when it is declared, and only non-code kinds ever count.

// Non-code kinds: data, docs, logs, images, patches and archives. A script or
// source file is never treated as evidence, wherever it lives and however it
// is marked.
export const NON_CODE = /\.(json|jsonl|ndjson|txt|log|md|csv|tsv|png|jpe?g|gif|webp|pdf|patch|diff|zip|gz|tgz|tar)$/i;

// .gitattributes attributes that declare a path evidence: PandaStack's own and
// the de facto linguist-generated.
export const EVIDENCE_ATTRIBUTES = ["bughunt-skip", "linguist-generated"];

/** A path glob as a whole-path match: `*` and `?` stay in a segment, `**` crosses segments. */
export function globRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Paths declared evidence by .gitattributes as of `rev` (so a change cannot
 * declare its own files), as a Map path -> attribute. `git` runs git with
 * (args, {input}) and returns {ok, stdout}. Git older than 2.40 has no
 * --source: then read is false and nothing is declared.
 */
export function declaredAt(git, rev, paths) {
  const declared = new Map();
  if (!paths.length) return { declared, read: true };
  const r = git(["check-attr", `--source=${rev}`, "-z", "--stdin", ...EVIDENCE_ATTRIBUTES], { input: paths.join("\0") + "\0" });
  if (!r.ok) return { declared, read: false };
  const parts = r.stdout.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if ((parts[i + 2] === "set" || parts[i + 2] === "true") && !declared.has(parts[i])) declared.set(parts[i], parts[i + 1]);
  }
  return { declared, read: true };
}

/** Why a path counts as declared evidence, or null: declared by attribute or matched by a glob, and non-code. */
export function evidenceReason(path, declared, globs = [], label = (glob) => glob) {
  if (!NON_CODE.test(path)) return null;
  if (declared.has(path)) return declared.get(path);
  const glob = globs.find((g) => globRegex(g).test(path));
  return glob ? label(glob) : null;
}
