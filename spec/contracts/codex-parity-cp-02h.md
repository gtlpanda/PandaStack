# CP-02h: Codex gets the strict leaf schema

Part of the Codex parity priority, wave 2 (spec/contracts/codex-parity-priority.md,
D126, root decision W2-3). It amends two wave-1 modules: schema.mjs gains one export,
and the CP-02b provider hands Codex the leaf's own schema instead of the NR-01 wire
schema. NR-01 stays the runtime contract: the provider wraps Codex's bare object as
the wire `{json}` itself. runtime.mjs and its decode are unchanged.

Everything it proves runs against a stub executable or an in-memory provider:
wiring proof, not runtime certification. Whether a real Codex enforces the strict
schema is not proven here; the live strict-schema probe after this feature builds is
a separate, authorized step (priority contract, "Live steps around wave 2").

## Why

The live smoke of 2026-11-20 (docs/evidence/codex-live-2026-11-20.md) ran
harness-repair on Codex 0.167.0. The provider wrote the NR-01 wire schema
(`{json: string}`) to `--output-schema`, so Codex enforced only that wrapper. The
checker returned `failures[].excerpt` as an array of strings. graphs/qa/workflows/
harness-repair.js `CHECK_SCHEMA` declares it a string, so NR-01 decode rejected the
reply and the graph escalated. Codex never saw the leaf schema it was meant to follow.

## Owners and the files a builder may edit

- core/skills/native-runtime/schema.mjs: adds `strictOutputSchema`. Nothing else in
  the module changes (`KEYWORDS`, `copyJSON`, `schemaProblems` and
  `encodeOutputContract` are unchanged).
- core/skills/native-runtime/codex-provider.mjs: the changes below. It imports
  `strictOutputSchema` and `copyJSON` from schema.mjs and never copies them.
- tests/native-codex-provider.test.mjs: its `{json}` fixtures and schema-file
  assertions move to the new behavior (it is an implementation test, not frozen).
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

No change to runtime.mjs, codex-exec.mjs, graph-host.mjs, codex-selection.mjs, any
workflow, role file, SKILL.md, the catalog, autobuild or hunt.

## `strictOutputSchema(schema) -> object`

A new export of schema.mjs. Synchronous and pure. It turns a leaf schema into the
strict subset that Codex `--output-schema` takes.

1. It first validates `schema` exactly as `encodeOutputContract` does (the same
   `captureSchema`). Anything that function rejects is rejected with the same code:
   `INVALID_SCHEMA` or `UNSUPPORTED_SCHEMA`.
2. The root must be the single type `'object'`. Anything else is
   `UNSUPPORTED_SCHEMA`, including `['object', 'null']`.
3. Every node is rebuilt. A node keeps only these keys:
   - `type`: a single type, or exactly `[x, 'null']` where `x` is not `'null'`. Any
     other type array (one entry, `['null', x]`, two non-null types, three or more)
     is `UNSUPPORTED_SCHEMA`.
   - `description` and `enum`, copied when present.
   - for an object node (type `'object'` or `['object', 'null']`): `properties`
     (each child rebuilt, keys in their input order), `required` (every property key,
     in property order, whatever order the input listed), and
     `additionalProperties: false`.
   - for an array node (type `'array'` or `['array', 'null']`): `items` (rebuilt).
4. Dropped: `minimum`, `maximum`, `minItems`, `maxItems`, `title` and `$comment`.
   Codex never sees them. NR-01 decode still enforces every one of them against the
   original schema, so nothing is loosened.
5. `UNSUPPORTED_SCHEMA` for each shape the strict subset cannot express:
   - an optional property: `required` absent, or naming fewer keys than
     `properties` has;
   - a `required` key that is not a property;
   - an object node with no `properties`, or an empty `properties`;
   - an explicit `additionalProperties: true`;
   - an array node with no `items`;
   - a type array other than `[x, 'null']`;
   - a root that is not the single type `'object'`.
6. The thrown error is schema.mjs's own: an `Error` with that `code` and the fixed
   message `Native output contract rejected.` It never contains a key, a value or
   any other schema text.
7. The input is never mutated, and no getter or hook on it runs (captureSchema copies
   data descriptors only). The result is a fresh tree of ordinary objects
   (`Object.prototype`) and arrays, every one of them frozen. It shares no object
   with the input. A property named `__proto__` stays an own property.

### Keyword drift

Every entry of schema.mjs `KEYWORDS` is classified exactly once: structure (`type`,
`properties`, `required`, `additionalProperties`, `items`), kept (`enum`,
`description`) or dropped (the six above). schema.mjs checks at import that the three
classes are exactly `KEYWORDS`, so a keyword added to `KEYWORDS` without a class
fails the import. The frozen test pins the other direction: common JSON Schema
keywords outside today's `KEYWORDS` (`pattern`, `format`, `const`, `anyOf`, `$ref`,
`default` and others) throw `UNSUPPORTED_SCHEMA`. A feature that extends `KEYWORDS`
therefore amends this contract and that list in the same freeze.

## Provider changes (amending spec/contracts/codex-parity-cp-02b.md)

Everything in CP-02b not named here is unchanged: the factory, the request keys and
their checks, the sandbox mapping, the timeout and settle margin, the single spawn,
the file names and modes, the stale-file removal, the output file inspection
(`lstat`, `O_NOFOLLOW`, size before read), the envelope shapes, receipts, usage
keys and the 1 MiB envelope bound.

### Codes

`CODEX_PROVIDER_CODES` gains exactly one code, `SCHEMA_UNSUPPORTED`: twelve in all.
It is frozen and keeps the pattern `^[A-Z][A-Z0-9_]{0,63}$`. The module still has
exactly the four CP-02b exports.

### Request checks

- `wireSchema` is still checked: it must canonically equal the NR-01 `wireSchema`,
  or `runLeaf` rejects with `INVALID_RUNTIME_INPUT`. It is the runtime contract; it
  is no longer written to a file.
- `schema` is now read. While the request is validated, the provider computes
  `strictOutputSchema(request.schema)`:
  - `INVALID_SCHEMA` (or any other failure) is a caller contract violation: `runLeaf`
    rejects with `INVALID_RUNTIME_INPUT` before any file or process exists. The
    runtime never sends such a schema, since it encoded it first.
  - `UNSUPPORTED_SCHEMA` makes the request valid but unrunnable on Codex (below).
- `request.schema` is never mutated.

### Steps for a valid request

1. `PROFILE_UNSUPPORTED` when the profile has no sandbox, as before. It comes first,
   so security-audit-flow leaves keep settling as `PROFILE_UNSUPPORTED`.
2. New: when the schema is unsupported, resolve `failed` `SCHEMA_UNSUPPORTED`. No
   file or directory is written and nothing is spawned. `usage` is null and the
   receipt is the usual one.
3. `TIMEOUT` when no time is left, as before.
4. The `<callId>.schema.json` file (0600, in a 0700 `runDir`) holds exactly
   `JSON.stringify(strictOutputSchema(request.schema))`. It no longer holds the NR-01
   wire schema.
5. Spawn and classify, as before.
6. The output file is read as before, then parsed as one bare JSON value:
   - not valid UTF-8, not JSON, or not a plain object (an array, `null`, a string, a
     number, a boolean): `INVALID_WIRE`;
   - the object is passed through schema.mjs `copyJSON` with the code
     `INVALID_WIRE`. A non-finite number (for example `1e999`, which `JSON.parse`
     reads as `Infinity` and `JSON.stringify` would write as `null`), nesting past
     64 levels, or a serialized size over 1 MiB gives `INVALID_WIRE`. Nothing is
     repaired;
   - otherwise the wire is `{json: JSON.stringify(object)}`. The string is the
     re-serialized object, not the file bytes, so whitespace and escapes may differ
     from what Codex wrote.
   - The provider never unwraps. An object that happens to be `{"json": "..."}` is a
     bare object like any other; its wire string is that whole object.
   - Absent or empty file: `NO_OUTPUT`. Symlink, FIFO, directory, file over 1 MiB:
     `INVALID_WIRE`. A stale file is never read. All as before.
7. The envelope bound is unchanged: over 1 MiB serialized gives `INVALID_WIRE`.

A semantically wrong object (the live smoke's `excerpt` array) is still `returned`.
The runtime's NR-01 decode rejects it against the original schema
(`INVALID_RESULT`), an ordinary leaf error that the graph handles. Handing Codex the
strict schema makes that rarer only if Codex enforces it, which is unverified.

### Usage and diagnostics

- `usage` keeps only CP-02b's four counters. `cache_write_input_tokens`, which Codex
  0.167.0 reports, stays dropped. No dollar, cost or price field is ever emitted.
- No envelope or thrown error carries prompt text or schema text. The schema file is
  the one place schema text is written, because it is Codex's input.

## Not in scope

- No change to the runtime, NR-01 decode, the wire schema or `completionFor`.
- No claim that Codex enforces the strict schema, follows `description`, or rejects
  an extra key. The live probe is a separate step.
- No fix for schemas the strict subset cannot express. Today the security-audit
  synthesizer schemas have optional properties; they would settle
  `SCHEMA_UNSUPPORTED`, but security-audit never reaches the provider on Codex
  (`audit-source-only` gives `PROFILE_UNSUPPORTED` first).
- No catalog change, no live codex, no network, no HOME.

## Host amendments frozen with this feature

These keep every passing frozen test green on main and after the build (W2-9, W2-10).
None pins the new behavior; this feature's own test does.

- acceptance/codex-parity/cp-02b-codex-leaf.test.mjs: its stub writes a step's
  `output` unchanged when the `--output-schema` file is the NR-01 wire schema, and the
  inner string of an exact `{"json": <string>}` output otherwise. The pins this
  feature changes are retired or narrowed: the closed 11-code set (now "contains the
  11"), the three schema-file-equals-wireSchema checks (now "equals the file the
  provider wrote"), three failure rows (a bare result, a non-string `json`, an extra
  key), the unparseable-inner-JSON subcases, and the runtime `INVALID_WIRE` row (now
  an array output). The two 1 MiB envelope cases use an object-shaped payload.
- acceptance/codex-parity/cp-02e-graph-host.test.mjs: the same schema-aware rule in
  its stub.
- acceptance/codex-parity/cp-02f-fake-codex.cjs: writes `{"json": s}` when handed the
  NR-01 wire schema and `s` itself otherwise; records the schema file bytes in
  calls.jsonl; and accepts an array of replies per role, one per spawn, the last
  repeating. Additive: CP-02f's cases are unchanged.

## Acceptance

acceptance/codex-parity/cp-02h-strict-schema.test.mjs (node:test, a few seconds,
no timing bound). It imports the modules under test from `PANDASTACK_CANDIDATE_ROOT`
(default: the repo root), runs a stub `codex` (a node script in an owned temp
directory) with a minimal explicit environment, and drives the real runtime and
graph templates through acceptance/native-runtime/nr-02-runtime-support.mjs.

- `strictOutputSchema` over every schema reached by the harness-repair, dev-build,
  blueprint-design and release-flow graphs (every catalog role of those graphs is
  reached) gives objects that all have `additionalProperties: false` and `required`
  equal to their property keys in order, with no dropped keyword left; the input is
  deep-equal before and after, and the result is frozen. bughunt's `minItems`,
  `maxItems`, `minimum` and `maximum` are dropped without error.
- Each rejection shape throws `UNSUPPORTED_SCHEMA` with the fixed message.
- The provider's `.schema.json` bytes equal `JSON.stringify(strictOutputSchema(request.schema))`,
  mode 0600. A stub writing a bare valid object gives `returned` whose `wire.json` is
  that object's string; the real runtime's `completionFor` and decode accept it, and
  a real-runtime harness-repair run completes in 3 leaves.
- The live-smoke regression: the checker's schema file declares
  `failures.items.properties.excerpt` a string with `additionalProperties: false`; a
  bare checker object with `excerpt` as an array is `returned`, decode rejects it as
  an ordinary leaf error, and the graph escalates after one spawn. This proves what
  the request carried, not that Codex enforces it.
- Non-object output, a non-finite number, invalid UTF-8, a symlink, a FIFO, output
  over 1 MiB, an envelope over 1 MiB and a stale file give `INVALID_WIRE` or
  `NO_OUTPUT` as before.
- An unsupported schema resolves `failed` `SCHEMA_UNSUPPORTED` with a matching
  receipt, zero spawns and no schema, output or log file. No schema or prompt text
  reaches an envelope or error, and no dollar field is emitted.
