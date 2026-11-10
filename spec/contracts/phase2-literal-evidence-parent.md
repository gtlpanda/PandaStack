# Conditional P2-13: literal evidence parent paths in Bash retention

Preparation only. Depends on P2-12; passes remains false. The active native hunt
retains fix ownership; supervisor chooses installation only after its terminal
result and exact-source reconciliation. No source or native ledger is changed.

Normal successful verification using the Bash retention backend must publish valid
JSON manifests and correct lowercase64hex SHA256 digests when its private absolute
evidence parent contains a literal POSIX backslash, as well as under an ordinary
parent. Paths remain literal argv/data, never shell commands. Parent backslashes do
not weaken relative-reference confinement, private directory/file modes, symlink
checks, owned scope enforcement, digest/byte-length checks, complete receipt status,
or exit-code propagation. Preserve root and nested manifest references and hashes.

Correct checksum extraction must not include GNU sha256sum filename-escaping markers
in the digest. Prefer hashing retained file contents through stdin, or otherwise
parse the documented checksum format without interpreting filename text; do not
strip arbitrary characters from unchecked output or relax digest validators. Both
step logs and child-manifest digest producers must satisfy the same bytes/hash rule.
Keep normal retention/owner ordering and existing bounded cleanup unchanged.

Acceptance proposal: byte-identical independently reviewed two-case normal fixture
installed as acceptance/phase2/p2-13.test.mjs, SHA256
e627e6cb405ea10f000002be062847863ffbcf0e65f92ea6eb8d91f1e35b1b97.
HostNode only, reviewed18tool taskPATH without Node/nodejs/Python/python3; immediate
normal outer/inner tasks, explicit private VERIFY_EVIDENCE_DIR. Ordinary path control
and literal-backslash parent each require actual successful tasks, two retained
private/nonsymlink manifests, valid JSON, exact hash/bytes, complete receipts and
ordinary actual scope observations. No stop/flood/overflow/orphan/race payload.
The existing safety restriction forbids reconstruction or translated/alternate-tool
or provider retry of previously blocked negative reproductions. No coverage waiver.

Root separately executed this exact fixture on immutable b31a8514208b03fdcfc488e618e7eff6516a796d:
actual-normal-path-red.json/log records syntax0, ordinarycontrolPASS, backslashFAIL
at explicit BUGHUNT-F3 invalidJSON, sourcefivehashes unchanged. This proves the
normal manifest defect for that exact revision only. Native F3 evidence remains
ERROR/no marker from its misconfigured fixture and MUST NOT be relabeled reproduced.
No inference about negative lifecycle/hostile containment follows from normal-path
proof. Setup failure, timeout or cleanup uncertainty remains incomplete, not proof.
Existing frozen gates remain required independently; no new runtime is run by this
preparation. Reconcile any native repair before choosing this fallback.
