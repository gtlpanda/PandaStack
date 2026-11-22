// The one parser for a shard spec, "i/n" (1-based, 1 <= i <= n, no leading zeros). Used by
// `autobuild check --shard` (gate.mjs) and by steps that split their own work from
// AUTOBUILD_SHARD (scripts/test-workflow.mjs). `name` only labels the error.
export function parseShard(text, name = "--shard") {
  if (text === undefined) return null;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(text));
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`${name} must be i/n with 1 <= i <= n, got ${JSON.stringify(text)}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}
