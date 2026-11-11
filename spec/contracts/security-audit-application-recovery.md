# SA-AR01 — distinguish completed stage rejection from operational application failure

EXTERNAL PROPOSAL / UNSELECTED / UNFROZEN / NOT EXECUTED. Scope derives from the preserved application-read-recovery handoff and static inspection of audit-stage.mjs/native-stage.mjs/audit-run.mjs. The original F1 hunt result remains unverified. This proposal neither restarts that hunt nor edits its evidence. Root must independently review exact contract and ordinary acceptance before selecting/freezing.

## Selected owner behavior

Current native-stage apply catch infers semantic rejection from constructor.name === Refusal plus result.json existence. audit-run readText wraps lstat/read I/O errors in the same Refusal class. An ordinary read failure after result publication can therefore produce a rejected application receipt and suppress saved-result replay. This is the source-traced candidate being addressed, not an executed reproduction.

Add `completedStageRejection(value) -> 'semantic' | 'escalation' | null` in audit-stage.mjs. It is an identity-based query over a module-private WeakMap populated only by the owning applier. Do not export a constructor, marker, token or registration function. Querying any unregistered value, including plain objects, Proxy values, copied errors, constructor-name spoofs and an ordinary Refusal emitted by audit-run, returns null without reading properties or invoking hooks. No prototype, class name, message, code, JSON field or caller claim grants this classification.

Keep the branding function private in audit-stage. Pass a private `rejectCompleted(message,kind)` capability only in the host-constructed applier context to applyValidate/applyVerify; their existing direct-call behavior defaults to ordinary refuse when that capability is absent. Never expose this capability in native options, model inputs, exported constructors or registration functions. Brand only the actual Error object deliberately thrown at these existing completed branches, and only after every existing required side effect returned successfully:

1. `refuseResult`: after bounded feedback attempt, stage spend, result.json, any terminal giveUp and owning event writes; kind semantic. Preserve existing attempts/MAX_SYNTH_ATTEMPTS, valid earlier facts/results, messages and CLI Refusal behavior.
2. Recon facts with zero retained facts: after existing spend, result.json and refusal event; kind semantic. Preserve current retry policy; this slice adds no policy or retries.
3. `applyStage`'s explicit validated workflow status escalate: after existing spend, result.json and escalated event; kind escalation. Preserve existing receipt/disposition behavior, distinguish this completed workflow state from transport/provider errors. A provider safety refusal or unknown runtime error is not branded merely because its text says escalate/refused.

4. applyValidate's existing fresh round where every verifier value is null, after spend/result/event; kind escalation. Preserve its explicit no candidate try consumed behavior.
5. applyVerify's equivalent fresh phase-5 round where every verifier value is null, after spend/result/event; kind escalation. Preserve its explicit no phase-5 try consumed behavior.

These last two are owning completed unsuccessful rounds, not semantic proof about a finding or authorization to retry a provider safety refusal. The capability call uses a trusted literal kind in those two branches; no event/message inference is used.

All other errors remain unbranded: validation that has not completed the required rejection writes, missing/malformed persisted inputs, read/write/event failures, capture conflicts, operational/runtime errors escaping the application path and unknown objects. Do not brand an error preemptively before writes or after catching an operational exception.

In native-stage's apply catch, record `native-application.json` outcome rejected only for an actual completedStageRejection classification. Remove the generic constructor-name/result-existence test and its incidental read probe. Ordinary operational failures rethrow the original error and leave a saved stage without a terminal application receipt. An existing saved result remains eligible for pendingNativeApplication and ordinary same-result application replay.

If writing the rejected application receipt itself fails, do not label that operation complete or overwrite saved result evidence. Throw a bounded Error with code APPLICATION_RECEIPT_UNCONFIRMED and the original owner-branded rejection as its `cause`; the original Error object is retained, not flattened into message text. The failed receipt operation remains recoverable using the same saved result, with no new provider call. Normal successful semantic/escalation paths keep their existing original thrown Refusal and messages.

Preserve existing fatal CLEANUP_UNCONFIRMED behavior if runtime/checkpoint cleanup fails, but retain any prior primary error object as the new cleanup error's cause. This is diagnostic preservation only: no clearing held journal outcomes, grant repair, new cleanup protocol or blocked lifecycle test is selected. No new forced cleanup failure test is proposed here.

## Allowed files and preserved authority

Only audit-stage.mjs, native-stage.mjs, the exact completed-null-verifier branches/context parameters in audit-verdicts.mjs and audit-verify.mjs, plus an internal stage-owned identity helper if necessary, and additive implementation tests may change. No broader verdict transition/refusal taxonomy changes are included. audit-run.mjs Refusal/readText/readJson behavior stays unchanged; this design does not need new I/O error metadata. Preserve existing application receipt version and exact fields, native capture/input/script/workflow hashes, ordinary nativeInvocation derivation, pendingNativeApplication scheduling, source protection, current journal/checkpoints/report owners, upstream schemas and every frozen test/gate.

Keep nextStep as the only scheduler. Recovery reuses the exact saved result and same invocation/stage, rewrites the same spend key idempotently, and publishes the current owning partial report. It creates no new provider attempt. A successful recovery removes pending application by writing the existing applied receipt and advances only through the current applier. Completed semantic rejection remains eligible only for the next legal stage attempt under existing policy; no terminal audit is reopened.

This slice does not classify the original provenance of graph-returned escalation/all-null data. Existing native runtime maps failed completions to LEAF_FAILED and the graph can catch those failures into these completed states; preserve that transport behavior here. Typed native-audit provider-refusal propagation and a durable stop policy remain required separate work before real provider transport or production completion. No refusal payload or provider-refusal retry fixture is authorized in SA-AR01.

This slice does not add integrity claims for unreceipted result bodies beyond current owners. Negative hash controls cover changed captured input/script/workflow and a changed result already bound by an existing application receipt. Initial capture preparation recovery, critic execution and broader retry/reserve work remain separate.

## Ordinary acceptance proposal

Use existing newInit/RESEARCH/SYNTH/UNIT fixture factories and actual journal, registry, native runtime, checkpoints, application and report owners. All provider callbacks are deterministic in-memory stubs. newInit creates only its ordinary isolated throwaway source repository through the established fixture helper; no original target/hunt repository is touched and no target source is executed.

Run serially. The only I/O injection is a synchronous one-shot wrapper around fs.readFileSync or fs.writeFileSync, installed with syncBuiltinESMExports and restored in finally. It matches exactly one absolute fixture-owned path after that same fixture's valid result.json exists. There is no competing writer, timer, signal, chmod/permission denial, symlink race, lock takeover, child-process fault, nested capture, orphan/overflow or shared-repository trust setup. No blocked F2/capture/race scenario is included.

Cases:

1. Identity query rejects primitive, ordinary Error/Refusal, copied/spoofed objects and Proxy/accessor values without hooks. A real completed invalid synthesis later supplies positive semantic classification.
2. One read EIO at stage-state.json after real synthesis result publication yields no rejected receipt. pendingNativeApplication remains bound; after restoring I/O, same result replays, no callback/row is added, spend stays 5, next state is recon and current partial report is published.
3. One write EIO at stage-state.json.tmp after valid result publication has the same saved-result recovery. Preserve the original thrown operational Error object.
4. Real invalid synthesis with an absent fixture path records its bounded semantic rejection, keeps prior facts/rows unchanged and allows the next legal valid attempt. Separately, zero retained facts records its existing completed semantic rejection. No new unit-level partial publication is claimed.
5. Scripted returned-null data makes the trusted graph explicitly escalate; completedStageRejection returns escalation and the existing rejected receipt is persisted. This is malformed data, not a simulated provider safety refusal or permission bypass.
6. The actual fresh validate and verify all-null branches retain their completed escalation receipt, unchanged decision/phase-5 try records, charged call and next legal attempt; they do not become stuck pending applications.
7. A one-shot receipt write EIO after a genuine semantic rejection returns APPLICATION_RECEIPT_UNCONFIRMED with the original rejection cause, no false receipt; saved application-only retry preserves spend/callback counts and later records the real rejection.
8. Changed captured input hash and changed already-receipted result hash refuse before another callback. These are static fixture edits with exact restoration, not marker forgery or a concurrent attack.

Only ordinary process-interruption-equivalent saved state is covered; no actual process is killed. Passing these cases would establish this narrow application-recovery behavior, not full audit completion, hostile containment, production tool closure or verification of the original F1 hunt finding. Before freeze, independently review the typed export and APPLICATION_RECEIPT_UNCONFIRMED diagnostic choice, exact fixture boundaries and existing CLI/cleanup compatibility.
