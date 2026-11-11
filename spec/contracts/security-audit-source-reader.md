# SR-01 trusted source/context reader — proposal, not frozen

External contract and ordinary inert fixtures only. No MCP/CLI/provider integration or execution. Owner graphs/security-audit/skills/security-audit/source-reader.mjs. This proves one trusted reader, not absence of broader Codex tools or OS containment.

## Reuse and limits

audit-run.exportTree/sealTree owns committed snapshot creation; snapshot-protection.inspectSnapshotProtection owns permission-bit prerequisite. Keep them unchanged. Existing upstream.isSafeRelativePath is the relative-path grammar (including no dot components, backslash, colon or absolute paths); reuse it rather than a competing permissive grammar. audit-facts.refProblem is not a reader boundary: it only lstat-checks the final file and is unsuitable for no-follow ancestor validation. audit-inputs.architectureOf is unbounded and unsuitable here. Reuse existing journal-data canonical finite-JSON validation/hashing machinery internally if compatible; do not import mutable journal storage/authority.

Host must run existing snapshot protection before using a production snapshot. Reader independently checks static root/ancestor and addressed file chains, including permission bits at source/context root and descendants. Do not recursively scan unrelated filesystem entries or use that unbounded walk to enforce request resource limits. No concurrent replacement protection claimed; no race fixture.

## Exact public library boundary

createSourceReader({sourceRoot,contextRoot,manifest,expectedManifestHash}) -> {listSource,readSource,searchSource,readContext,close}.
Roots trusted host absolute paths, checked component-by-component with lstat before descending; no symlink, dot/dotdot components, NUL, non-directory. Roots distinct, neither inside the other. contextRoot is a dedicated host-prepared sanitized immutable artifact directory, never runDir, auth home or journal directory. Its contents are copied/issued by host; models cannot choose roots or manufacture authority. No root/env fallback.

Manifest exact {version:1,sourceRef:{commit,tree},files:[{path,sha256,bytes}],contexts:[{manifestId,artifacts:[{artifactId,path,sha256,bytes}]}]}. All hashes lowercase64hex except Git commit/tree40or64 matching widths. expectedManifestHash is separate trusted SHA256 of recursively key-sorted finite canonical JSON manifest. Reject mismatch MANIFEST_MISMATCH; digest is integrity consistency, not proof of commit provenance. Host must bind manifest to accepted export/sourceRef; this slice performs no Git or target invocation.

Files sorted UTF8 path bytes, unique; contexts/artifacts unique safe IDs [A-Za-z0-9][A-Za-z0-9_-]{0,127}, sorted by UTF8 ID. Paths valid existing relative grammar, UTF8<=1024; no duplicates per context or files. Each byte size0..16777216 safeinteger; combined files/context entries<=10000; manifest canonical bytes<=4194304; cumulative declared artifact bytes<=1073741824. Unknown fields/accessors/Proxy/custom prototypes/cycles/nonfinite data reject INVALID_READER_INPUT before reflective hooks; use Node types.isProxy before inspection. Root inputs trusted but validated too. Capture detached manifest; caller mutations cannot change it.

Factory validates shape/hash/root chains but does not read all file bodies. List returns frozen inventory metadata, not proof current bytes remain unchanged. Every read/search validates addressed chain static no symlinks/nonregular/writable files or directories below root, actual size equals declared, and streaming SHA256 of complete addressed file equals manifest before returning any bytes/matches. Per file16MiB bounds total work, no content cache bypass after mutation. No content/error echo on failure. Missing/unlisted identifier NOT_FOUND; path traversal INVALID_READER_INPUT; unsafe static entry UNSAFE_PATH; size/hash drift SOURCE_MISMATCH; operational failure IO_ERROR. Lookup unknown manifest/context/ID must not search other directories.

listSource({after:null|path,limit}) -> {manifestHash,sourceRef,entries,nextAfter}. limit1..128 required, after null or exact existing listed path. UTF8 sorted pagination, nextAfter last returned path only if more remain else null. No directory scan or glob. Each entry exact {path,sha256,bytes}. No implicit cap truncation without cursor.

readSource({path,offset,limit}) -> {manifestHash,sha256,bytes,offset,dataBase64,nextOffset}. offset safeinteger0..bytes; limit1..65536. Exact raw bytes [offset,min(bytes,offset+limit)], lossless base64 (binary and split UTF8 safe); nextOffset null iff end, else offset+returned length. No silent UTF8 replacement. Later MCP may present separately validated UTF8, but this primitive does not invent line/character offsets.

searchSource({path,literal,offset,scanBytes,limit}) -> {manifestHash,sha256,matches:[byteOffset],nextOffset}. Literal nonempty Unicode scalar text UTF8<=1024, interpreted literally not regex/shell. offset0..bytes, scanBytes1..1048576, limit1..128. Return ascending nonoverlapping byte matches whose START lies within [offset,min(bytes,offset+scanBytes)); read up to literalByteLength-1 overlap beyond window so boundary matches not lost. If result limit reached and more eligible starts remain, nextOffset=lastMatch+literalByteLength; otherwise window end or null atEOF. No line snippets, arbitrary file search or recursive traversal. Whole-file hash verification still precedes result delivery. Limit each call to one manifest-listed file; host concurrency policy outside this pure reader.

readContext({manifestId,artifactId,offset,limit}) -> same raw page shape as readSource plus manifestId/artifactId. Resolves ONLY host captured context manifest IDs, never model path. Context root/path mapping not returned. Context artifact may contain complete architecture, coverage/prior/critic/hunter evidence for global critic; stage-specific host issues only authorized IDs. Raw prompts/auth/journal/provider transcripts are never automatically imported or read. Sanitization and source provenance are host prerequisites, not inferred from filename/hash.

close idempotent; later methods CLOSED. Results detached and may frozen. Error code plus fixed generic message only; no file contents, raw OS error or absolute root paths. No child_process/network/writes/exports/config loading/MCP discovery/agent callbacks.

## Accepted boundaries and future integration

Full source file beyond16MiB explicitly unavailable, not silently clipped; reader reports this limitation to coverage. At most one16MiB full hash read plus bounded result per operation. Manifest makes global total known; repeated calls do not promise global CPU quota (native host cap/deadline owns aggregate invocation work). No current journal/control authority exposed.

Future source-only capability profile must establish that no other exec/write/network/private-read tools bypass this reader. Actual MCP transport, account/model preflight, context issuance and hostile same-user/race protection are separate; none proved by these tests. No blocked reproduction is authorized.
