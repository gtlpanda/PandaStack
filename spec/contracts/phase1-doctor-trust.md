# P1-07: read-only doctor trust boundary

Default doctor inspection must never execute selected provider binaries, whether
selected by project fields, project PATH, inherited PATH or environment override.
It may resolve/check executable presence read-only. Report runtime.version null
and capabilities unknown, with explicit evidence that execution was not performed.
A missing executable remains blocked. Existing settings/provenance and generated
checks remain unchanged. Do not execute a different binary and present it as the
managed provider. Trusted caller-injected capabilityProbe remains supported with
its existing explicit callback contract, normalization and safe errors.

This is defensive contract tightening of the existing read-only requirement.
No exploit execution is needed. The frozen regression replaces spawnSync with an
in-process spy and asserts zero invocations; it does not run repository payloads.
Add implementation tests and update README/skill docs. All earlier frozen tests
and full host gates remain required. Do not retry the previously blocked filesystem
race reproduction. Record that earlier live version outputs were prior behavior;
current default doctor deliberately reports version unknown without executing code.
