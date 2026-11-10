// External draft only. No providers, target execution, arbitrary graph code or source edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {load,pins,ROOT,PATHS,fixture,checkpointPort,pass,plan,reconArgs,research,completion,sha} from './nr-02-runtime-support.mjs';
const code=c=>e=>e?.code===c;
test('registry has exact six pinned templates and sole dev to QA edge',async()=>{
 const {loadWorkflowRegistry}=await load(),hashes=pins(),registry=loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:hashes}),rows=registry.describe();
 assert.deepEqual(rows.map(x=>x.id),Object.keys(PATHS).sort());
 for(const r of rows){assert.equal(r.sha256,hashes[r.id]);assert.deepEqual(r.children,r.id==='dev-build'?['harness-repair']:[]);}
 try{rows[0].id='mutated';}catch{}assert.notEqual(registry.describe()[0].id,'mutated');
});
test('missing extra and wrong pinned source never become executable registry',async()=>{
 const {loadWorkflowRegistry}=await load(),hashes=pins();const missing={...hashes};delete missing['dev-build'];
 assert.throws(()=>loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:missing}),code('INVALID_RUNTIME_INPUT'));
 assert.throws(()=>loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:{...hashes,custom:'0'.repeat(64)}}),code('INVALID_RUNTIME_INPUT'));
 assert.throws(()=>loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:{...hashes,'dev-build':'0'.repeat(64)}}),code('REGISTRY_MISMATCH'));
});
test('actual QA graph uses NR01 wire decode and durable result before done',async t=>{
 const f=await fixture(t);const result=await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'qa'});
 assert.equal(result.status,'done');assert.deepEqual(f.calls.map(c=>c.agentType),['checker','reviewer','qa-auditor']);
 assert.equal(f.checkpoints.rows.size,3);assert.ok([...f.checkpoints.rows.values()].every(r=>r.state==='completed'));
 assert.deepEqual(f.calls[0].wireSchema,{type:'object',properties:{json:{type:'string'}},required:['json'],additionalProperties:false});
 assert.equal(f.calls[0].requestedModel,'haiku');assert.equal(f.calls[0].requestedEffort,'high');assert.equal(f.calls[0].selection.model,'fake-model');
});
test('actual dev invokes actual child QA under cap1 without parent permit deadlock',{timeout:5000},async t=>{
 const f=await fixture(t,{cap:1});const args={repo:'/inert/project',plan:plan(),planApproved:true};const before=structuredClone(args);
 const out=await f.runtime.run('dev-build',args,{invocationId:'dev'});assert.equal(out.status,'done');assert.equal(out.qa.status,'done');assert.deepEqual(args,before);
 const child=f.calls.filter(c=>c.workflowId==='harness-repair');assert.deepEqual(child.map(c=>c.agentType),['checker','reviewer','qa-auditor']);
 assert.ok(child.every(c=>JSON.stringify(c.workflowPath)===JSON.stringify(['dev-build','harness-repair'])));
});
test('actual release graph without approval never dispatches merger or any leaf',async t=>{
 const f=await fixture(t);const out=await f.runtime.run('release-flow',{repo:'/inert/project',pr:1,stage:'land'},{invocationId:'release'});
 assert.equal(out.status,'escalate');assert.equal(f.calls.length,0);assert.equal(f.checkpoints.rows.size,0);
});
test('audit graph pool retains order while shared cap bounds actual leaf concurrency',{timeout:5000},async t=>{
 let active=0,peak=0;const waiting=[];
 const f=await fixture(t,{cap:2,answer:async req=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===2){const batch=waiting.splice(0);queueMicrotask(()=>batch.reverse().forEach(r=>r()));}});active--;return research(req);}});
 const out=await f.runtime.run('security-audit-flow',reconArgs(),{invocationId:'audit'});
 assert.equal(out.status,'done');assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(out.results.facts.map(x=>x.agent),['1a','1b','1c','1d']);
 assert.equal(out.budgetSpent,4);
});
test('stable call IDs independent of completion order and no global settlement sequence',async t=>{
 const first=await fixture(t,{cap:4,answer:async req=>{await new Promise(r=>setTimeout(r,req.label==='recon-1a'?3:0));return research(req);}});
 const second=await fixture(t,{cap:4,answer:async req=>{await new Promise(r=>setTimeout(r,req.label==='recon-1d'?3:0));return research(req);}});
 for(const f of [first,second])await f.runtime.run('security-audit-flow',reconArgs(),{invocationId:'same'});
 assert.deepEqual(Object.fromEntries(first.calls.map(c=>[c.label,c.callId])),Object.fromEntries(second.calls.map(c=>[c.label,c.callId])));
 for(const row of first.checkpoints.rows.values()){const b=row.binding;assert.equal(b.callId,'nr-'+sha(JSON.stringify(['same',['security-audit-flow'],b.agentType,b.label,1])));}
});
test('completed checkpoint replay never calls provider again',async t=>{
 const f=await fixture(t);const a=await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'replay'});const count=f.calls.length;
 const b=await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'replay'});assert.deepEqual(b,a);assert.equal(f.calls.length,count);
});
test('uncertain reservation escapes graph catch and forbids dispatch',async t=>{
 const checkpoints=checkpointPort();checkpoints.reserve=async()=>({state:'uncertain'});const f=await fixture(t,{checkpoints});
 await assert.rejects(f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'unknown'}),code('CHECKPOINT_UNCERTAIN'));assert.equal(f.calls.length,0);
});
test('terminal checkpoint failure cannot become successful or ordinary graph escalation',async t=>{
 const checkpoints=checkpointPort();checkpoints.settle=async()=>{throw Error('private persistence message');};const f=await fixture(t,{checkpoints,cap:1});
 await assert.rejects(f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'disk'}),e=>e.code==='CHECKPOINT_ERROR'&&!e.message.includes('private'));
 assert.equal(f.calls.length,1);assert.equal([...checkpoints.rows.values()][0].state,'uncertain');
});
test('transport rejection is uncertain even though graph catches agent errors',async t=>{
 const f=await fixture(t,{answer:async()=>{throw Error('private transport error');}});
 await assert.rejects(f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'transport'}),e=>e.code==='DISPATCH_UNCERTAIN'&&!e.message.includes('private'));
 assert.equal(f.calls.length,1);assert.equal([...f.checkpoints.rows.values()][0].state,'uncertain');
});
test('global deadline after callback settles still rejects outside graph return',async t=>{
 let now=1;const f=await fixture(t,{nowMs:()=>now,deadlineMs:100,answer:async()=>{now=101;return pass();}});
 await assert.rejects(f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'deadline'}),code('RUNTIME_ABORTED'));assert.equal(f.calls.length,1);
});
test('abort joins cooperative fake active leaf and never dispatches queued work',{timeout:5000},async t=>{
 const controller=new AbortController();let active=0,stopped=0;
 const f=await fixture(t,{cap:1,signal:controller.signal,answer:req=>{active++;queueMicrotask(()=>controller.abort());return new Promise((resolve,reject)=>req.signal.addEventListener('abort',()=>{active--;stopped++;reject(Error('cancelled'));},{once:true}));}});
 await assert.rejects(f.runtime.run('security-audit-flow',reconArgs(),{invocationId:'abort'}),code('RUNTIME_ABORTED'));assert.equal(active,0);assert.equal(stopped,1);assert.equal(f.calls.length,1);
});
test('profile refusal cannot broaden security audit; no reservation',async t=>{
 const f=await fixture(t,{resolveLeaf:()=>({selection:{provider:'codex',model:'fake',effort:'high'},profile:'build-workspace'})});
 await assert.rejects(f.runtime.run('security-audit-flow',reconArgs(),{invocationId:'profile'}),code('PROFILE_REFUSED'));assert.equal(f.calls.length,0);assert.equal(f.checkpoints.rows.size,0);
});
test('observer failure does not alter actual QA success; unknown template refuses',async t=>{
 const f=await fixture(t,{onEvent:()=>{throw Error('observer');}});assert.equal((await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'observer'})).status,'done');
 const n=f.calls.length;await assert.rejects(f.runtime.run('../target-script',{}, {invocationId:'bad'}),code('UNKNOWN_WORKFLOW'));assert.equal(f.calls.length,n);
 await f.runtime.close();await assert.rejects(f.runtime.run('harness-repair',{}, {invocationId:'closed'}),code('CLOSED'));
});

test('known terminal failure settles envelope and follows existing graph escalation',async t=>{
 const checkpoints=checkpointPort();let calls=0;
 const f=await fixture(t,{checkpoints,provider:{async runLeaf(req){calls++;return {outcome:'failed',code:'REMOTE_FAILED',usage:null,receipt:{...req.selection,invocationId:'known-failed'}};}}});
 const out=await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'failed'});
 assert.equal(out.status,'escalate');assert.equal(calls,1);assert.equal([...checkpoints.rows.values()][0].completion.outcome,'failed');
});
test('invalid returned semantic JSON is persisted as returned evidence, not repaired or resent',async t=>{
 const checkpoints=checkpointPort();let calls=0;
 const f=await fixture(t,{checkpoints,provider:{async runLeaf(req){calls++;return completion(req,{verdict:'PASS'});}}});
 const out=await f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'invalid'});
 assert.equal(out.status,'escalate');assert.equal(calls,1);const row=[...checkpoints.rows.values()][0];assert.equal(row.state,'completed');assert.equal(row.completion.outcome,'returned');
});

test('unsettled checkpoint reserve is bounded and late grant never dispatches',{timeout:5000},async t=>{
 const checkpoints=checkpointPort();let grant,entered;const started=new Promise(r=>{entered=r;});let opSignal;
 checkpoints.reserve=(_binding,options)=>new Promise(resolve=>{grant=resolve;opSignal=options.signal;entered();});
 const controller=new AbortController(),f=await fixture(t,{checkpoints,signal:controller.signal});
 const running=f.runtime.run('harness-repair',{repo:'/inert/project'},{invocationId:'pending-store'});
 await started;controller.abort();await assert.rejects(running,code('CHECKPOINT_UNCERTAIN'));
 assert.equal(opSignal.aborted,true);assert.equal(f.calls.length,0);
 grant({state:'dispatch'});await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,0);assert.equal(checkpoints.events.filter(x=>x[0]==='settle').length,0);
});

test('same stable IDs reject changed args and selection without replay or new dispatch',async t=>{
 const checkpoints=checkpointPort(),baseReserve=checkpoints.reserve.bind(checkpoints),attempted=[];
 checkpoints.reserve=async(binding,options)=>{
  attempted.push(structuredClone(binding));
  const old=checkpoints.rows.get(binding.callId);
  if(old&&JSON.stringify(old.binding)!==JSON.stringify(binding)){
   const e=new Error('binding conflict');e.code='CONFLICT';throw e;
  }
  return baseReserve(binding,options);
 };
 const first=await fixture(t,{checkpoints});
 await first.runtime.run('harness-repair',{repo:'/inert/original'},{invocationId:'binding'});
 const before=structuredClone([...checkpoints.rows]),original=attempted[0],count=first.calls.length;
 const argsChanged=await fixture(t,{checkpoints});
 await assert.rejects(argsChanged.runtime.run('harness-repair',{repo:'/inert/changed'},{invocationId:'binding'}),code('CONFLICT'));
 const changedArgs=attempted.at(-1);assert.equal(changedArgs.callId,original.callId);assert.notEqual(changedArgs.argsHash,original.argsHash);assert.equal(argsChanged.calls.length,0);
 const selected=await fixture(t,{checkpoints,resolveLeaf:()=>({selection:{provider:'codex',model:'different-fake',effort:'high'},profile:'build-workspace'})});
 await assert.rejects(selected.runtime.run('harness-repair',{repo:'/inert/original'},{invocationId:'binding'}),code('CONFLICT'));
 const changedSelection=attempted.at(-1);assert.equal(changedSelection.callId,original.callId);assert.equal(changedSelection.argsHash,original.argsHash);assert.notDeepEqual(changedSelection.selection,original.selection);assert.equal(selected.calls.length,0);
 assert.deepEqual([...checkpoints.rows],before);assert.equal(first.calls.length,count);
});
