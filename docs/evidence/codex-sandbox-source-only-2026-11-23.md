# Codex sandbox confinement for security-audit's `audit-source-only` profile, 2026-11-23

Question: can native Codex CLI enforce source-only access for security-audit's leaves
(roles audit-researcher, audit-synthesizer, audit-analyst), so the catalog's Codex row can
leave `unavailable`? Decision: **no. The row stays `unavailable`, and the `audit-source-only`
refusal is unchanged.** Two claims are kept apart below, because only the first one is
established.

1. **Shell-command confinement is achievable.** A command run under `codex sandbox` with the
   flag set in section 1 can read only the snapshot, cannot write, and cannot open a socket.
2. **Source-only access for a model leaf is not established.** Section 3 lists the blockers.

Nothing here ran a model. The only Codex commands run were `codex sandbox ...` (a plain command
under Codex's Linux sandbox: no model, no login, no account use), `codex --version`,
`codex debug prompt-input` (renders the prompt locally) and help/feature listings. No `codex
exec`, no `claude`, no verify.sh, no capture machinery. Codex CLI 0.167.0, Linux (WSL2) on x86_64.
Paths below are redacted (`<home>`, `<scratch>`).

## 1. The recipe

No `-P` profile name, no `-C`, and no `config.toml`: only `-c` overrides, with the snapshot as the
working directory. (`-P` and `-C` are accepted too, but `-C` requires `-P`; the leaf builds its argv
with `--ignore-user-config`, which stops `$CODEX_HOME/config.toml` loading, so a named profile in a
config file is not a usable route. `-c` is.)

```
cd <snapshot>
codex sandbox \
  -c 'default_permissions="source_only"' \
  -c 'permissions.source_only.filesystem={":minimal"="read", "<codex vendor dir>"="read", "<snapshot>"="read"}' \
  -c 'permissions.source_only.network.enabled=false' \
  -- <command>
```

- One inline table for the filesystem, not dotted keys: `-c 'permissions.p.filesystem."/a/b.c"="read"'`
  splits the key at the dot inside the path and fails with
  `filesystem path ... must be absolute, use ~/..., or start with :`.
- `:minimal` is Codex's own minimal system read set. It is not enough alone: the sandbox re-executes
  the codex binary inside the namespace, and without the directory holding the native binary the
  run dies with `bwrap: execvp <codex vendor dir>/bin/codex: No such file or directory`.
  The vendor directory is derived from where `codex` resolves; it is install-specific.
- There is no write root. The leaf's `--output-last-message` file is written by the Codex process
  itself, outside the sandbox, so it needs none.
- Reading the vendor directory is enough. With a `$CODEX_HOME` outside `/tmp` Codex also binds its
  own `$CODEX_HOME/tmp/arg0-*` helper directory; a decoy `auth.json` in that `$CODEX_HOME` stayed
  unreadable.

The test that holds these flags is tests/codex-source-only-sandbox.test.mjs. It uses only owned
temp directories and a loopback listener it owns, runs no model, and skips with the reason printed
when `codex` is not on PATH, the platform is not Linux, or Codex's own read-only sandbox cannot start.

## 2. Proof, each property with a control

Controls run the same command bare (no sandbox). Run of the test on this machine:

```
  ok   control: a plain read-only sandbox exposes files outside the snapshot, so the test can detect a leak
  ok   the recipe starts and reads a snapshot file; the same read works bare
  ok   a file outside the snapshot is unreadable under the recipe, readable bare
  ok   a symlink inside the snapshot cannot lead outside it
  ok   CODEX_HOME (where auth.json lives) is unreadable under the recipe, readable bare
  ok   writes fail inside and outside the snapshot; the same writes succeed bare
  ok   a TCP connect to a local listener is refused under the recipe and accepted bare
```

| Property | Under the recipe | Control |
|---|---|---|
| Read inside the snapshot | content returned | bare read returns it |
| Read of a file outside the snapshot | exit non-zero, marker absent | bare read returns the marker |
| Symlink in the snapshot to an outside file | exit non-zero, marker absent | bare read returns the marker |
| Read of `$CODEX_HOME/auth.json` (decoy) | exit non-zero, marker absent | bare read returns the marker |
| Write into the snapshot, write outside it | both fail (`Read-only file system`), neither file exists | bare run creates both |
| TCP connect to a 127.0.0.1 listener | `Operation not permitted`, listener saw 0 connections | bare run connects, listener saw 1 |
| Outside read with plain `sandbox_mode="read-only"` | marker returned (leak) | n/a, shows the check can detect a leak |

Two mutations of the recipe were run against the test, and each failed the matching cases: adding
the snapshot's parent directory as a readable root failed the outside, symlink and CODEX_HOME cases;
setting `network.enabled=true` failed the network case. So the cases discriminate.

The mount set inside the sandbox (`/proc/self/mountinfo`) is the full readable surface: `/`,
`/dev` and its null/zero/full/random/urandom/tty nodes, `/dev/pts`, `/bin`, `/etc`, `/lib`,
`/lib64`, `/sbin`, `/usr` (with the WSL driver and GPU library mounts under them),
`/mnt/wslg/distro` (an empty mode-000 tmpfs), `/run/WSL` (tmpfs), `/proc` in a fresh PID
namespace (only a handful of pids), the codex vendor directory, the helper directory and the snapshot.
No Windows drive and no home directory content appeared. `ls /mnt` showed only `wslg`.

## 3. Why this does not make the row available

1. **The native stage cannot finish an audit.** graphs/security-audit/skills/security-audit/native-stage.mjs:95
   throws `PARTITION_INTEGRATION_REQUIRED` when the next step is `critic`; critic partition dispatch is
   documented there as a separate integration that does not exist. A Codex-installed skill would run
   recon and hunting and then stop. `NO_NATIVE_ENTRY` is still true: no CLI drives the native stage.
2. **SA-08 asks for more than confinement.** docs/roadmap/security-audit-priority.md item 8 requires
   "no target execution, shell, writes, arbitrary MCP/config inheritance or network tools" and says a
   filesystem sandbox alone does not prove it. The recipe confines a shell; it does not remove it. A
   script placed in the snapshot is still executable by `bash` inside the sandbox (it can read the
   snapshot and nothing else). Disabling Codex's shell tool in favor of the loopback reader
   (native-reader-server.mjs) would need a live model to verify, and none was run.
3. **The recipe is not the leaf's flag set.**
   - `codex exec` has no `--permission-profile`. A `-c default_permissions` route is what `exec`
     would need, and whether `exec` applies it to the model's tool calls, rather than a legacy
     read-only projection, is **an untested hypothesis**. Evidence that it does not settle it:
     `codex debug prompt-input` with these `-c` values rendered the permissions text as
     "`sandbox_mode` is `read-only`", and the Codex binary contains the string
     `derived permission profile cannot be represented as a legacy sandbox policy; falling back to
     read-only`. Proving it needs a model call.
   - `codexExecArgs` (core/skills/native-runtime/codex-exec.mjs:39,44) accepts only the `read-only` and
     `workspace-write` sandboxes and always emits `--sandbox`. The binary has the strings
     "`sandbox_mode` and `default_permissions` overrides cannot both be set", so carrying the recipe means
     changing that CP-02a-pinned builder and omitting `--sandbox`.
   - Three layers refuse today and would all change: `SANDBOXES['audit-source-only'] = null`
     (core/skills/native-runtime/codex-provider.mjs:26), `CODEX_REFUSED_WORKFLOWS` including
     `security-audit-flow` (codex-selection.mjs:37), and the runtime's own profile rule
     (runtime.mjs:24). None was touched.

## 4. Residual exposure under the recipe (shell command level)

- `/etc`, `/usr`, `/bin`, `/lib`, `/proc`, `/dev` are readable. `/etc/passwd` and the rest of
  world-readable `/etc` are visible. A secret stored world-readable under those trees would be too.
- The environment of the sandboxed command is inherited: a canary variable set in the parent was
  visible inside. The leaf's own environment is provider-owned (the blueprint pattern passes `HOME`,
  `CODEX_HOME` and `PATH` only), but the sandbox does not scrub it.
- The native codex binary directory is readable (required). The shell can run any executable under
  the readable trees, including scripts from the snapshot.
- Unix-domain sockets can be created. A `connect` to a bus path that is not mounted was refused with
  `EPERM`; connecting to a socket path inside a readable root was not tried.
- This was tested on one machine (WSL2, Codex 0.167.0, bwrap-based sandbox). The mount list above is
  WSL-specific; a macOS or non-bwrap Linux sandbox is a different mechanism and was not tested.

## 5. What would change the answer

All of: (a) a live, user-authorized probe showing `codex exec` applies the `-c` recipe to a model's
tool calls, (b) a way to remove or deny the shell tool, or an accepted decision that a confined shell
satisfies SA-08, (c) the critic partition integration in the native stage, and (d) a native CLI for
the audit stages with the Codex provider. Until then the existing refusal is the safe behavior.
