# Phase 1 PATH serialization parity (bounded supplement)

Doctor must match actual loadConfig/buildEnv executable discovery when the target
repository pathname contains a colon or whitespace. Do not alter launcher PATH
semantics to satisfy doctor tests. Default doctor remains non-executing; preserve the explicit trusted probe interface.

Keep existence anchoring separate from PATH serialization: testing whether a
relative configured prefix exists requires target-root anchoring, but adding the
target-root pathname to the serialized PATH creates delimiters absent from the
managed PATH. Preserve the selected prefix bytes when composing PATH, split that
actual PATH on its delimiters, then anchor relative search candidates to the repo.
Preserve prior empty-prefix, symlink traversal and config home-expansion contracts.

A colon already present in an actual absolute or relative PATH string remains a
delimiter. Do not magically escape or preserve a literal colon-bearing directory
as one PATH entry: that would invent behavior the launcher does not provide. In
contrast an explicit binary pathname is not a PATH list and colon characters in
it remain ordinary pathname characters. Whitespace requires no splitting/unquoting.

The matrix uses both backends, colon-bearing and whitespace repository names,
relative/dot prefixes, inherited and project relative PATH, empty explicit PATH,
explicit relative/absolute binaries, actual absolute PATH colon delimiters, and
relative prefix literal-colon splitting plus empty/missing prefix controls. Each
case derives baseline from actual loadConfig/buildEnv and inert access/stat search,
then checks doctor from target and unrelated cwd. No executable is run.
