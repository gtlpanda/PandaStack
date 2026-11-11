# SR-01a static source/context directory identity separation

Selected corrective scope for SR-ROOT-ALIAS-01 only. Existing SR-01 contract, API,
acceptance and baseline tests remain frozen. This is a static conditional
portability correction, not a reproduced Windows/DrvFS exploit or filesystem race.
No target execution, provider, process-control, dynamic replacement or previously
blocked reproduction is authorized.

The existing factory checks sourceRoot/contextRoot separation lexically. On a
filesystem with alternate spellings for directories, lexical inequality does not
establish distinctness. Preserve lexical validation and all static lstat/no-link,
mode, manifest, path, size, hash and no-follow checks. At factory initialization,
inspect both root ancestor chains with actual bigint directory metadata. Compare
source root identity against every context-chain identity, and context root
identity against every source-chain identity. Equal identity means identical or
nested physical directories and must refuse INVALID_READER_INPUT. Sharing an
ordinary parent is allowed; do not reject merely because both chains share /tmp
or the filesystem root.

Use exact OS directory identity pair (dev,ino) from lstat with bigint:true;
require dev bigint>=0 and ino bigint>0. Missing, non-bigint or otherwise unusable
identity refuses UNSAFE_PATH. Do not lowercase paths, infer identity from strings,
coerce lossy Number values, or claim realpath alone detects every alias. This
relies on the filesystem providing meaningful dev/ino metadata; no hostile kernel,
remote filesystem forgery, mount-race or same-user containment claim. Existing
source/context roots remain trusted host inputs; this adds no model authority.
Factory checks are a static observation, not a promise about later replacement.
Do not add an unbounded filesystem walk or a new reader implementation.

Acceptance: four reviewed ordinary/pure cases use two tiny actual sealed roots
and existing reader calls. A narrow synchronous lstat observation seam substitutes
only directory identity metadata to model same-root alias, aliased ancestry and
unavailable identity; every file/type/mode operation remains ordinary. No actual
case-insensitive filesystem is required or claimed. The positive case verifies
separate sibling roots sharing parents remain valid and preserve source/context
bytes. Restore builtin methods in finally and keep all fixtures under their owned
temporary directory. The supervisor must review fixture source before execution.
Add meaningful implementation tests in the owning workflow harness. Host owns
acceptance, full gates, pass flags and implementation commit. Root independently
reviews the final identity comparison and original frozen protections.

Run these cases serially in one process; the narrow builtin observation seam is restored before another case starts. Identity-validation coverage does not establish filesystem identity reliability or containment.
