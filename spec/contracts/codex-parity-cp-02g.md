# CP-02g: the host settles an oversize leaf prompt as PROMPT_TOO_LARGE

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125), wave 2.
Wave-2 decision W2-2 binds this feature: an oversize prompt is a failed leaf, settled in
the host.

Everything it proves runs against a recording provider or a stub `codex` executable:
wiring proof, not runtime certification.

## The gap

- The runtime accepts a workflow prompt of up to 1048576 UTF-8 bytes
  (runtime.mjs:215).
- The CP-02e host puts the role instructions and `"\n\n"` in front of it
  (graph-host.mjs:165-173, `wrapProvider`).
- The CP-02b provider rejects a prompt over 1048576 bytes (codex-provider.mjs:81).
- The runtime turns a provider rejection after `reserve` into `DISPATCH_UNCERTAIN`
  (runtime.mjs:263) and writes an `uncertain` row (runtime.mjs:278-283). The host exits 3.

So a deterministic input error becomes a held call that needs an operator `fail`
(CP-05b) before the run can go on, and a rerun is exit 3 `CHECKPOINT_UNCERTAIN`.

## Owners

- core/skills/native-runtime/graph-host.mjs (amended). Two changes, nothing else.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

No runtime, provider, store, completion, registry, catalog, role-file or workflow edit.
The provider keeps its own check: it is still the last guard for any other caller.

graph-host.mjs adds these imports to its CP-02e table. It imports them and never copies
them:

| from | names | pinned by |
|---|---|---|
| checkpoint-store.mjs | `checkpointDirOf` | CP-05a |
| completion.mjs | `failedCompletion` | CP-05b |

It does not import or call `failHeldCheckpoint`. That function takes the store's lock
and refuses `OWNER_BUSY` while the run holds it (CP-05a step 3), so it cannot settle a
leaf of a live run. Both new imports are siblings in core/skills/native-runtime, so
CP-01b's derived dependency edges do not change.

## Change 1: oversize prompts in the wrapped provider

CP-02e step 10's wrapped `runLeaf(request)` keeps its order. After the role lookup (a
role with no instructions still throws `INVALID_SELECTION`):

1. `prompt = <instructions> + "\n\n" + request.prompt`, exactly as CP-02e builds it.
2. If `Buffer.byteLength(prompt, 'utf8') > 1048576`, it returns
   `failedCompletion({selection: request.selection, code: 'PROMPT_TOO_LARGE',
   invocationId: 'host:' + request.callId})` and does not call the caller's provider.
3. Otherwise it calls the caller's `runLeaf` exactly as CP-02e says, with `prompt`.
   Exactly 1048576 bytes is passed through.

- The size is in UTF-8 bytes of the whole combined prompt: role instructions, the two
  newlines and the workflow prompt. It is never UTF-16 units, and never the workflow
  prompt alone.
- `request.selection` is the leaf's resolved selection: the runtime spreads the chosen
  `{selection, profile}` into the request (runtime.mjs:259). So the receipt equals the
  binding's selection and runtime `completionFor` accepts the envelope (CP-05b).
- The envelope is exactly
  `{outcome: 'failed', code: 'PROMPT_TOO_LARGE', usage: null,
  receipt: {provider, model, effort, invocationId: 'host:<callId>'}}`.
- The prompt is never truncated, split or rewritten.

### What follows, unchanged runtime behavior

- The runtime settles the envelope through the run's own open store (`store.settle`):
  the row is `{version: 1, callId, binding, state: 'failed', completion}` under
  `<runDir>/checkpoints`. No row is `prepared` or `uncertain`.
- The workflow sees an ordinary failed leaf (`Native runtime: LEAF_FAILED.`).
  harness-repair escalates. The host exits 0 with status `escalate` and writes
  result.json (CP-02e step 11).
- A rerun with the same run directory and invocation id replays the failed leaf from
  the store with zero provider calls and rewrites the same result.json bytes (CP-02e
  resume). A new invocation id is a new call and settles the same way, also with zero
  provider calls.

## Change 2: the checkpoint directory

CP-02e step 9 opens its store at `checkpointDirOf(runDir)` (CP-05a) instead of its own
`join(runDir, 'checkpoints')`. The path is the same, so the layout CP-02e froze holds:
rows still live under `<runDir>/checkpoints`. graph-host.mjs then has no
`'checkpoints'` literal of its own; CP-05a owns the name.

## Codes and leaks

- `PROMPT_TOO_LARGE` is a fixed code matching `^[A-Z][A-Z0-9_]{0,63}$`. It is new: no
  existing code names an oversize leaf prompt as a leaf failure (decision 5). The
  provider's and the runtime's `INVALID_RUNTIME_INPUT` name a caller contract error,
  and using it would mark a graph-handled failure as a host bug.
- The code appears only in the checkpoint row's completion. The workflow sees only
  `LEAF_FAILED`, so result.json, the host outcome and the CLI output never name it.
- No prompt text reaches the row (the binding keeps only `promptHash`), the outcome,
  result.json, stdout or stderr.

## Not in scope

- Any provider change, prompt truncation, or a size check anywhere but the host.
- Reconcile (CP-05b); `failHeldCheckpoint`.
- A size check in `resolveLeaf` or before `reserve`. The row is reserved, then settled
  as failed, so the same invocation replays it.
- Leaves that reach the provider through any other host.

## Acceptance

acceptance/codex-parity/cp-02g-prompt-too-large.test.mjs (node:test, about 1 second).
It imports the module under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo
root). Installation roots are owned temp fixtures built as CP-02e's are (the candidate
catalog with only `dev`'s codex row set to `partial`). Library cases inject a recording
provider that rejects a prompt over 1048576 bytes the way codex-provider.mjs does. The
combined size is set exactly through `args.repo`, which the checker prompt names once,
after one probe run measures the checker's leaf prompt. One root pads the checker's
role file by 1 MiB, so the role text alone is over the limit. The CLI case spawns the
host CLI with a stub `codex` that records every spawn. No HOME, network or real codex.

Cases:
1. Combined checker prompt of 1048577 ASCII bytes (workflow prompt under the runtime
   limit): exit 0 `escalate`, zero provider calls, one row, state `failed`, the exact
   envelope above with the receipt equal to the binding's selection, no held row, the
   lock released, result.json equal to the outcome. No row, outcome or result.json
   carries prompt text; result.json and the outcome do not name the code.
2. Exactly 1048576 bytes (with 2-byte characters): the checker's provider request
   carries the combined prompt byte for byte, its row is `returned`, exit 0. A later
   leaf whose longer role text takes it over the limit settles as `PROMPT_TOO_LARGE`,
   never a held call.
3. 1048577 bytes whose UTF-16 length is under 1048576: zero calls, the failed row.
4. The padded role with the small workflow prompt: zero calls, the failed row.
5. Rerun with the same invocation id: the same outcome, zero calls, rows and
   result.json byte-identical. A new invocation id: zero calls, a second failed row.
6. CLI on the padded role: exit 0, stdout `{"status":"escalate"}`, empty stderr, no
   codex spawn, no `provider/` directory, the failed row.
7. graph-host.mjs statically imports `checkpointDirOf` from `./checkpoint-store.mjs`
   and `failedCompletion` from `./completion.mjs`, does not import
   `failHeldCheckpoint`, has no quoted `checkpoints` literal and builds no
   `outcome: 'failed'` envelope of its own.

At this freeze (main plus the tier-1 and tier-2 freezes) all 7 cases fail. Cases 1 to 6
fail because the provider is called and the run is exit 3 `DISPATCH_UNCERTAIN` (case 2:
the reviewer leaf, whose role text is longer than the checker's). Case 7 fails on the
missing import.

Enforced by review, not by a case: the role lookup still comes before the size check;
the provider's own 1 MiB check is unchanged.
