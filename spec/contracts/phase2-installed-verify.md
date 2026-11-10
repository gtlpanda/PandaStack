# Installed verification entrypoint parity

The supported installed skill directory symlink must execute the same retention CLI as the direct source path. Direct module import remains side-effect-free. An invalid CLI operation must refuse with exit 125 through either path.

Invoking installed verify.sh on a disposable shell-only project must actually execute its task exactly as a direct invocation does. A task exit 7 must yield VERIFY: FAIL and exit 1; a task exit 0 must yield VERIFY: PASS and exit 0. Both outcomes must retain a real manifest with the task's actual exit and complete log. Missing dispatch must never appear as success or manufacture /manifest.json.

The three additive cases copy only the actual verify dependency files into a private disposable fixture and create the normal .claude/skills/verify directory symlink. Tasks are benign local marker writes with immediate bounded exits. No providers, network, user config or candidate changes are needed. Existing acceptance cases stay unchanged.

Proposed minimal implementation: compare the canonical filesystem identity of process.argv[1] against the module file's canonical identity at the CLI entrypoint. Handle absent argv safely for ordinary imports; do not execute main merely because the module was imported. For example, use fs.realpathSync for the argv filename (and module filename), with a small nonthrowing isMain predicate. Keep the current main/catch behavior and public exports unchanged. Review source selection under installed directory symlinks rather than weakening verify verdict checks.

Evidence: reproduction.json captures direct invalid exit125 versus symlink invalid exit0; direct verify runs the marker and fails, while current installed-symlink verify skips work and falsely passes. This is a confirmed behavior on the copied current source, not an assumption from path syntax.

Review tightening: the fixture supplies an explicit private 0700 evidence root, checks confined non-symlink regular0600 logs and actual bytes/hash/content, and verifies direct and symlink module imports remain inert. Async owned launches use a 15-second deadline, captured PID/start identities, bounded TERM/KILL joins and a separate isolated-file 120-second watchdog; failure retains artifacts and reports uncertainty rather than declaring cleanup success.
