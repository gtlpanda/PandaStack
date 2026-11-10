# Doctor PATH-selection parity follow-up (frozen acceptance)

Doctor executable presence must agree with the effective managed environment from
loadConfig + buildEnv when invoked from the target repository, regardless of the
inspector process cwd. Do not change launcher behavior to make doctor pass tests.
No provider or fixture executable is run by these tests; executable selection is
checked through access/stat following actual PATH traversal semantics.

Preserve branch distinctions:
- Empty env.pathPrepend entries fail existsSync('') in the managed launcher and
  are omitted. Do not turn them into the target repository via path.resolve.
- Missing prefixes are omitted; existing relative prefixes resolve from the target
  repository, absolute prefixes stay absolute, and non-directory prefixes cannot
  yield an executable. The selected file must be executable and regular.
- Inherited PATH empty components are filtered by buildEnv; relative/absolute
  components retain their target-cwd executable search semantics.
- Project env.vars.PATH replaces the entire constructed PATH including prepend
  and inherited entries. Empty components in this explicit override are retained
  and mean current directory. An explicitly empty PATH therefore searches cwd.
- Relative prefixes/PATH components and explicit executable paths containing
  symlink/.. must preserve kernel traversal. Lexical path.resolve normalization
  changes the target and is not equivalent to child execution from config.root.
- Explicit path binaries bypass PATH as before. Default doctor remains presence
  only, with unknown native controls; no executable launch/probe added.

Matrix covers both backends from target and unrelated inspection cwd. Frozen test
ROOT resolves from eventual acceptance/phase1 placement. Temporary initial-proof
copy points at candidate; do not install that copy as acceptance.

Home/tilde prefix expansion belongs to loadConfig/expandHome. Compare the selected
expanded configuration, not an invented raw-string interpretation. Matrix includes
~/ and $HOME/ prefixes resolving to the owned temporary absolute bin directory.
