# CP-04b: the /blueprint decision rules

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. This feature moves SKILL.md's answer rules (sections 3.4-3.5, 4.2 `needs-human`,
5.2 `needs-human` and 6.4) out of prose and into one library. It applies the human's
interview, gate and approval-edit answers to state.json, and deletes the design and
backlog runs that a changed answer makes wrong. CP-04c (the stage CLI) imports it. It
runs no graph, asks no question, makes no git change and does not edit SKILL.md.

## Owners

- graphs/blueprint/skills/blueprint/blueprint-decisions.mjs (new): every export below.
  - It is synchronous.
  - It imports only `node:` built-ins and `./blueprint-state.mjs` (CP-04a). From
    CP-04a it imports, and never copies: `FILES`, `readRequest`, `readState`,
    `readRun`, `writeState`, `validateState`, `redactSecrets` and `freshness`.
  - It writes a file only through CP-04a's `writeState`. Its only other filesystem
    calls are `lstat` and `unlink`.
- Nothing else changes:
  - The catalog stays as it is. The import resolves to
    `graphs/blueprint/skills/blueprint/`, which CP-01b's rule 3 does not count, so no
    edge is derived and blueprint keeps `backlog`, `default-stack` and `knowledge-map`.
  - `entrySha256` hashes only SKILL.md, so it is unchanged.
  - SKILL.md, blueprint-design.js, write-docs.mjs, blueprint-state.mjs and their tests
    stay unchanged.

## Public API

These exports are stable: CP-04c imports them by these names.

### `BLUEPRINT_DECISION_CODES`

A frozen object whose keys and values are exactly these twelve codes. The names that
CP-04a also uses mean the same condition here (root decision 5).

| code | when |
|---|---|
| `INVALID_INPUT` | the options object or an entry in it breaks the rules under "Caller input" |
| `STATE_EXISTS` | `applyInterviewAnswers` found a state.json (by `lstat`, so a symlink counts) |
| `MALFORMED` | run1.json, or the pending gate run, does not have the shape this call needs |
| `NOT_NEEDS_HUMAN` | run1.json, or the run picked as the pending gate, has a `status` other than `'needs-human'` |
| `NOT_BACKLOG_READY` | `applyApprovalEdit` found a run3.json whose `status` is not `'backlog-ready'` |
| `STALE_RUN` | the gate run or run3.json is not `fresh` by CP-04a's `freshness` |
| `DUPLICATE_ID` | an id appears twice in one answer list |
| `UNKNOWN_ID` | an answer names an id that was not asked |
| `MISSING_ANSWER` | an asked question has no answer |
| `BAD_PREFLIGHT` | a `have` name is not a preflight item's `what`, or is given twice |
| `GATE_ROUNDS_EXHAUSTED` | `applyGateAnswers` found `gateRounds` already 2 |
| `IO_ERROR` | an `lstat` or `unlink` failed for a reason other than "no such file" |

### Errors

- Every refusal of this module throws an `Error` with:
  - `code`: one of the codes above;
  - `message`: exactly `Blueprint decisions: <CODE>.`;
  - `file`: a `FILES` value (a fixed name, never a path), set for `STATE_EXISTS`,
    `MALFORMED`, `NOT_NEEDS_HUMAN`, `NOT_BACKLOG_READY`, `STALE_RUN` and `IO_ERROR`;
  - `ids`: set only for `DUPLICATE_ID`, `UNKNOWN_ID` and `MISSING_ANSWER`. It is an
    array naming each offending id once, in the order below.
- A message never holds an id, a path, answer text or any other input. `ids` holds ids
  only, and an id reaches it only after it matched the id shape below, so it can never
  carry free text or a credential.
- **CP-04a errors pass through unchanged** (their code, their message
  `Blueprint state: <CODE>.` and their `file`). This covers a bad `dir`
  (`INVALID_INPUT`), an absent or bad request.json, run1.json, state.json, run2.json or
  run3.json (`MISSING`, `MALFORMED`), and every `writeState` refusal.

### Caller input

- `dir` is the state directory, checked by the CP-04a reader each function calls first.
- `opts` must be a plain object with only the keys a function lists, and its required
  keys.
- An **answer list** is an array of plain objects with exactly the keys `id` and
  `answer`:
  - `id` matches `^[A-Z][0-9]{1,9}$`, the only shape blueprint-design.js mints (`Q<n>`,
    `A<n>`, `D<n>`) plus this module's `G<n>`;
  - `answer` is a string that is not blank after `trim`.
- Anything else is `INVALID_INPUT`, raised before any file is read.

### Free text and labels

- Free text (every gate answer, every override, the edit, and an interview answer that
  is not an option label) is stored as `redactSecrets(text.trim())`.
- An interview answer that is exactly (`===`) one of its question's `options[].label`
  is stored unchanged. A near miss, such as a label with ` (Recommended)` appended or
  in another case, is free text. Stripping the AskUserQuestion suffix (SKILL.md 3.2,
  line 80) is the caller's job.
- `writeState` then redacts the whole state again (CP-04a), so stored text is always
  redacted.

### Id checks

Given each answer list and the ids it may name, the checks run in this order, and the
first that fails is thrown:
1. `DUPLICATE_ID`: an id twice within one list. `ids` lists each such id once, in the
   order of its second appearance (lists in argument order).
2. `UNKNOWN_ID`: an id the list may not name. `ids` lists each once, in input order.
3. `MISSING_ANSWER`: an asked id with no answer. `ids` follows the question order.

### Saving

Every successful call does this, in this order:
1. `writeState(dir, state)` writes state.json atomically (CP-04a). Its return value is
   what the function returns.
2. run3.json, run2.json and meta.json are unlinked when present. A user's answer
   changes the inputs of the design and the backlog, so both runs go. meta.json holds
   only those two runs' basis entries (CP-04a), so removing both entries removes the
   file. "No such file" is ignored; any other failure is `IO_ERROR` with `file`.
- So a failed write leaves every file as it was. A failure after the write leaves the
  new state saved and runs that CP-04a's `freshness` reports `stale`, which CP-04c
  reruns. Repeating the same call is then refused (`STATE_EXISTS` for the interview;
  `STALE_RUN`, `NOT_NEEDS_HUMAN` or CP-04a's `MISSING` for a gate or an edit, by which
  deletes ran), so an answer is never applied twice.
- Every refusal except a step-2 `IO_ERROR` happens before step 1, and changes no file.
- run1.json and request.json are never touched.
- No id is ever both a decision and an assumption: every rule below that adds an
  assumption's id as a decision removes that assumption, and CP-04a's `validateState`
  refuses such a state.

### `applyInterviewAnswers(dir, { answers, have?, overrides? }) -> state`

SKILL.md 3.4-3.5 (lines 91-98).

- **Signature.** The planner's sketch was `applyInterviewAnswers({run1, answers})`.
  This contract reads run1.json and request.json from `dir` instead: CP-04c runs the
  interview and the answers in separate invocations, and the file is the one already
  redacted and written by `writeRun`. `answers` is required; `have` (an array of
  strings) and `overrides` (an answer list) default to `[]`.
- **Order of reads and checks:**
  1. Caller input (above).
  2. `readRequest(dir)`.
  3. state.json exists: `STATE_EXISTS` (`file: 'state.json'`). Answers become binding
     once; starting over is CP-04a's `initState` with `restart` (SKILL.md 1.3).
  4. `readRun(dir, 1)`; `status` must be `'needs-human'`, else `NOT_NEEDS_HUMAN`.
  5. run1's interview shape, else `MALFORMED` (`file: 'run1.json'`):
     - `questions`: a non-empty array of plain objects, each with an `id` of the id
       shape, a string `question`, `options` as an array of plain objects with string
       `label`s, and `resolves` as an array of strings;
     - `preflight`: an array of plain objects with string `what`, `why` and `needed_by`;
     - `assumptions`: an array of plain objects with an `id` of the id shape;
     - question and assumption ids all unique, across both lists.
  6. Id checks. `answers` may name the question ids and must name each of them;
     `overrides` may name the assumption ids. An assumption past the cap (`Q13`) is an
     override, never an answer.
  7. `have`: each name must equal some preflight `what`, with no name twice, else
     `BAD_PREFLIGHT`. The name is never echoed.
  8. The built state must pass `validateState` (a bad `brief`, say), else `MALFORMED`
     (`file: 'run1.json'`).
- **The state** has exactly SKILL.md 3.5's keys (line 95-96):
  - `request`, `docs`: from request.json.
  - `brief`: run1's `brief`, unchanged.
  - `decisions`: one per question, in run1's question order:
    `{id, question: <its question>, answer, resolves: <a copy of its resolves>, note: null}`.
    Then one per override, in run1's assumption order:
    `{id: <the assumption id>, question: <its assumption text, or "" when that is not a string>, answer, resolves: [], note: "override"}`.
  - `assumptions`: run1's assumptions without the overridden ones, order and keys kept.
  - `preflight`: one per run1 item, in order, exactly
    `{what, why, needed_by, have: <true when have names its what>}`. Two items with the
    same `what` are both marked by that name. An item not named is `have: false`
    (owed), as SKILL.md 3.4 says (line 91-92).
  - `gateRounds`: 0.
- **Readings of SKILL.md:**
  - An interview decision's `note` is null and an override's is `"override"`. SKILL.md
    3.5 lists `note` without a value; `"override"` keeps an override apart from an
    answer and matches the value CP-04a's drift fixture uses.
  - An override's `question` is the assumption it replaced. SKILL.md 3.4 says only "a
    decision with the overridden assumption's id"; `resolves` is empty (line 97).

### `applyGateAnswers(dir, { answers }) -> state`

SKILL.md 4.2 `needs-human` (lines 116-132) and 5.2 `needs-human` (lines 145-147).

- **Order of reads and checks:**
  1. Caller input.
  2. `readState(dir)`.
  3. `gateRounds` is already 2: `GATE_ROUNDS_EXHAUSTED`. SKILL.md: "The gates ask at
     most twice per request, both gates together" (line 130-132).
  4. **The pending gate.** When run3.json exists (by `lstat`), it is run3 (the backlog
     gate); otherwise run2 (the design gate). It is read with `readRun`, so an absent
     run2.json is CP-04a's `MISSING`. Its `status` must be `'needs-human'`, else
     `NOT_NEEDS_HUMAN` with its `file`. A backlog-ready run3 is the approval, not a
     gate.
  5. `freshness(dir)`: `design` must be `fresh` for run2, `backlog` for run3, else
     `STALE_RUN` with its `file`. The questions were asked about that exact state.
  6. The run's `questions`: a non-empty array of plain objects with exactly `about` and
     `question` (blueprint-design.js `gateQuestions`, lines 506-516). `question` is not
     blank. `about` is null or the id of a decision or an assumption in the state. Else
     `MALFORMED` with its `file`.
  7. Id checks. The ledger gives gate questions no id, so question `k` (1-based, in
     ledger order) is answered as `G<k>`, each exactly once.
- **Applying.** The questions are applied in ledger order, each answer as free text:
  - `about` is a decision id: set that decision's `answer`, and `note: "design gate"`.
    Its `question` and `resolves` stay (line 122-123).
  - `about` is an assumption id: remove the assumption, and append
    `{id: <that id>, question: <the gate question>, answer, resolves: [], note: "design gate"}`
    (line 124-126).
  - `about` is null: append the same with `id` the next unused `D<n>` (line 127-128).
  - Then `gateRounds` goes up by 1 (line 129).
- **Readings of SKILL.md:**
  - The backlog gate also writes `note: "design gate"`: SKILL.md 5.2 says "answer it as
    in section 4" (line 145).
  - Two questions about one id apply in order, so the later answer wins and the old one
    never stays next to the new one (line 120-121). An assumption challenged twice is a
    decision by the second question, which then sets its `answer`.
  - **The next `D<n>`** is one more than the highest `n` of every id matching
    `^D([0-9]{1,9})$` among the decisions and the assumptions, or `D1` when there is
    none. A gap is never filled (`D1`, `D3` give `D4`), and an id already taken is
    skipped. SKILL.md says "after every `D` id already in `decisions`"; counting the
    assumptions too keeps the ids unique. Two null-`about` answers get consecutive ids.

### `applyApprovalEdit(dir, { edit }) -> state`

SKILL.md 6.4 (lines 181-183).

- **Order of reads and checks:**
  1. Caller input: `edit` is a string that is not blank after `trim`.
  2. `readState(dir)`, then `readRun(dir, 3)` (an absent run3.json is CP-04a's
     `MISSING`).
  3. run3's `status` must be `'backlog-ready'`, else `NOT_BACKLOG_READY`. An edit is
     the answer to the one approval, which only a ready backlog reaches (section 6).
  4. `freshness(dir).backlog` must be `fresh`, else `STALE_RUN` (`file: 'run3.json'`).
- **Applying.** Append
  `{id: <the next D<n>>, question: "approval edit", answer: <the edit as free text>, resolves: [], note: "approval edit"}`.
  `gateRounds` is unchanged: SKILL.md 6.4 does not count an edit as a gate round.

## Not in scope

- No graph run, no question asked, no CLI (CP-04c), no approval or commit (CP-04d).
- No git command. No SKILL.md, catalog, install or role-file edit.
- No lock: the driver runs one step at a time (CP-04a).
- No crash simulation. That a crash between the write and the deletes leaves only
  stale runs follows from CP-04a's `freshness`; no case kills the process there.

## Acceptance

acceptance/codex-parity/cp-04b-blueprint-decisions.test.mjs (node:test, 31 cases,
about half a second).
- It imports the module from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root),
  lazily in every case. It never imports blueprint-state.mjs: fixtures are written,
  and results read back, with plain `fs`. The `meta.json` basis in a fixture is the
  sha256 of the bytes it wrote, the way CP-04a's `writeRun` records it.
- Every file lives in an owned temp directory. Fake credentials and a marker string
  are built at run time.
- The cases that pin `note` and `question` values read them out of SKILL.md, so a drift
  there is caught.

The cases cover:
- **Exports.** The codes and functions. The import graph (node built-ins and
  `./blueprint-state.mjs` only, `writeState` among the imports, no write call of its
  own) and `checkCatalogDrift` with no blueprint problem.
- **Interview.** The exact stored state: an option label kept, free text trimmed and
  redacted, `resolves` copied, preflight by name, overrides as decisions with the
  assumption removed, `gateRounds` 0, request and docs from request.json. A "none"
  reply. Near-label answers. A shared preflight name. Stale run2, run3 and meta.json
  deleted, run1 kept, state.json 0600.
- **Interview refusals.** Duplicate, unknown and missing ids with their `ids` and
  precedence. Bad preflight names. Malformed options. `STATE_EXISTS` (also for a
  symlink). An escalated run1. Seventeen malformed run1 shapes. CP-04a refusals passing
  through. A delete failure after the write, and the repeat it refuses.
- **Gates.** The design gate with every kind of `about`. The backlog gate. Two
  questions about one id. A repeat after a partial delete. The next `D<n>` with gaps and with a D id among the
  assumptions. `GATE_ROUNDS_EXHAUSTED` for both gates. No pending gate. Three stale
  runs. Malformed gate questions. `G<k>` id checks. Malformed options and CP-04a
  refusals.
- **Approval edit.** The added decision, `gateRounds` unchanged. A pending, missing or
  stale run3. Malformed options.
- **Fail closed.** Every refusal leaves the directory byte-identical, and no error's
  `message`, `file` or `ids` holds the marker or a fake credential.
