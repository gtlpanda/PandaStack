# CO-03: CI history through a gh port

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-01.
Test: acceptance/ci-optimizer/co-03-history.test.mjs.

## Module

`lib/ci/history.mjs` exports these functions:

- `githubRepo(root)` → `"owner/name"` or `null`. It parses `git remote get-url origin` in
  either of these forms:
  - `https://github.com/<o>/<r>(.git)`;
  - `git@github.com:<o>/<r>(.git)`.
- `fetchGithubHistory({ repo, ghBin, limit, env })` → `attempts[]` (normalized; see below).
- `normalizeAttempt(run, jobsDoc)` → one attempt record.
- `mergeHistory(existing, incoming)` → the merged `attempts[]`.
- `readHistory(root, env)` and `writeHistory(root, doc, env)`.

## The gh port

Every call is `spawnSync(ghBin, args)` with the caller's environment. The argument vectors
are exact. In order:

1. `["api", "repos/<repo>/actions/runs?per_page=<limit>&status=completed"]`.
2. For each run in response order, and for each `k` from 1 to `run_attempt - 1`:
   `["api", "repos/<repo>/actions/runs/<id>/attempts/<k>"]`. This returns that earlier
   attempt's run object.
3. For each run, and for each attempt `a` from 1 to `run_attempt`:
   `["api", "repos/<repo>/actions/runs/<id>/attempts/<a>/jobs?per_page=100"]`.

**Failures.** If any call exits non-zero or prints invalid JSON, the whole fetch fails with
`GH_FAILED` (exit 3). The message names the argument vector and the exit status. The stored
history is left byte-for-byte unchanged. A partial fetch is never merged.

## Normalized attempt

```
{ provider: "github", runId, attempt, workflow, workflowPath, event, headSha, branch,
  conclusion, createdAt, startedAt, updatedAt,
  jobs: [{ name, conclusion, createdAt, startedAt, completedAt, labels: [..],
           steps: [{ number, name, conclusion, startedAt, completedAt }] }] }
```

**Run fields.** Each one maps from the run object:

| Normalized | Run object |
|---|---|
| `runId` | `id` |
| `attempt` | the attempt number |
| `workflow` | `name` |
| `workflowPath` | `path` |
| `event` | `event` |
| `headSha` | `head_sha` |
| `branch` | `head_branch` |
| `conclusion` | `conclusion` |
| `createdAt` | `created_at` |
| `startedAt` | `run_started_at` |
| `updatedAt` | `updated_at` |

- For the latest attempt, the run object is the one from the runs list.
- For an earlier attempt, it is the call 2 response.

**Jobs and steps** keep API order. Their fields are mapped the same way:

| Normalized | API field |
|---|---|
| `createdAt` | `created_at` |
| `startedAt` | `started_at` |
| `completedAt` | `completed_at` |

Missing values become `null`.

## Stored history

`history.json` is:

```
{ schemaVersion: 1, source, attempts }
```

**`source`** is one of:
- `{ provider: "github", repo }`;
- `{ provider: "import", file: <basename> }` for the last import.

**`mergeHistory` rules:**
- The key is `` `${runId}#${attempt}` ``. An incoming record replaces the existing record with
  the same key.
- The result is sorted by `startedAt` descending, then `runId` descending, then `attempt`
  descending.
- A record whose `startedAt` is `null` sorts last.
- The result is capped at the first 200 records.

## CLI: `autobuild ci history`

**Forms:**

| Form | What it does |
|---|---|
| `--from-gh [--repo o/r] [--limit N]` | `N` defaults to `ciPolicy.historyLimit`, and must be from 1 to 100 (exit 2 otherwise). Without `--repo`, the repo comes from `githubRepo(root)`. When neither gives one: `REPO_UNKNOWN`, exit 2. |
| `--import FILE` | `FILE` holds `{ "attempts": [...] }` in the normalized shape, from any provider. Every record is validated (required keys present, types as above; `provider` may be any non-empty string). One bad record refuses the whole file with `IMPORT_INVALID` (exit 2), naming the record index. |
| no source flag | Prints what is stored and changes nothing. |

**Output:**
- Human output: `history: <total> attempts (<new> new) from <github owner/name | import FILE>`.
- With no source flag, the output is `history: <total> attempts stored` (or `history: none`).
- **`--json`** prints `{ "total", "new", "source", "attempts" }`.

## Acceptance (frozen)

The test uses a fake `gh`: a Node script that looks up its argument vector in
`fixtures/github/pandastack/index.json` and prints that file. An unknown vector exits 1. Every
call is logged.

1. **Fetch and normalize.**
   - `fetchGithubHistory({ repo: "example/pandastack", limit: 40 })` makes exactly the call
     sequence the port section lists: 1 runs call, 1 earlier-attempt call for run 44929986613,
     and 41 jobs calls.
   - It returns 41 attempts.
   - Run 44929986613 attempt 1 has conclusion `failure`, and attempt 2 has `success`.
2. **Field mapping.** The newest attempt (run 45056977608) maps:
   - `workflow` to `test`, `event` to `push`, `branch` to `main`;
   - four jobs, `gate shard 2`, `gate shard 1`, `gate shard 3` and `test`, in API order;
   - step names and timestamps exactly as the fixture holds them;
   - labels `["ubuntu-22.04"]`.
3. **Store.**
   - `autobuild ci history --from-gh --repo example/pandastack --limit 40 --json` stores 41
     attempts and reports `new: 41`.
   - Running it again reports `new: 0`, and the store still holds 41.
   - The history file sits in `ciStateDir` with mode 0600.
4. **Fetch failure.** With a fake `gh` that fails on the tenth call, the command exits 3 with
   `GH_FAILED`, and an existing `history.json` keeps its bytes.
5. **Repo resolution.**
   - Without `--repo`, the repo comes from an `origin` remote
     `git@github.com:example/pandastack.git`.
   - With no origin, the command exits 2 with `REPO_UNKNOWN`.
   - `--limit 0` and `--limit 101` exit 2.
6. **Import.**
   - `--import` of a two-record GitLab-provider file merges them, with
     `source.provider: "import"`.
   - A record with no `runId` refuses the file (exit 2, `IMPORT_INVALID`, index named), and
     nothing changes.
7. **Merge and offline rules.**
   - `mergeHistory` replaces a record with the same key.
   - It keeps the sort order defined above.
   - It caps at 200.
   - No `gh` call is made by `autobuild ci history` without `--from-gh`, as the fake's log
     shows.

## Clarifications

- The call order is phased: call 1, then every call-2 vector (runs in response order, `k`
  ascending), then every call-3 vector (runs in response order, `a` ascending). The fetch stops
  at the first failing call.
- `normalizeAttempt(run, jobsDoc)` takes the attempt number from `run.run_attempt`.
- `IMPORT_INVALID` names the 0-based index of the first bad record. `attempt` and `runId` must be
  integers, `provider` a non-empty string, timestamps strings or `null`.
- The human import line names the file as given on the command line. The GitHub form is
  literally `history: <total> attempts (<new> new) from github <owner/name>`.
