import test from 'node:test';
import assert from 'node:assert/strict';
import {load,setup,bounded} from './p2-trace-integration-support.mjs';
import {observations,validate,completeTrace} from './p2-observation-support.mjs';
const REV='a'.repeat(40);
const scope={queueNamespace:'queue-1',decisionRunId:'logical-1',featureId:'F-1',decisionId:'decision-1',revision:REV,deliveryId:'delivery-1'};
const error=e=>e?.code==='INVALID_OBSERVATION';
function trace(api,patch={}){const events=[];let tick=10;const value=api.createDecisionTrace({repo:'/fixture/project',revision:REV,invocationRunId:'outer-1',emit:e=>events.push(structuredClone(e)),now:()=> '2026-11-10T12:00:00.000Z',monotonicNow:()=>tick,...patch});return {value,events,tick:n=>tick=n};}

test('trace context receipt requires received span; exact replay is detached and close references every event once',async()=>{
 const api=await load(),t=trace(api),wait=t.value.startWait(scope);
 assert.throws(()=>t.value.contextSupplied(wait.spanId,{providerRunId:'child-1',launchId:'launch-1'}),error);
 t.tick(15.8);const received=t.value.finishWait(wait.spanId,{answerId:'answer-1'});
 const supplied=t.value.contextSupplied(wait.spanId,{providerRunId:'child-1',launchId:'launch-1'});
 validate(supplied);assert.equal(supplied.event,'context_supplied');assert.equal(supplied.answerId,received.answerId);assert.equal(supplied.providerRunId,'child-1');
 const original=structuredClone(supplied);try{supplied.answerId='mutated';}catch{}
 assert.deepEqual(t.value.contextSupplied(wait.spanId,{providerRunId:'child-1',launchId:'launch-1'}),original);assert.equal(t.events.length,3);
 assert.throws(()=>t.value.contextSupplied(wait.spanId,{providerRunId:'different-child',launchId:'launch-1'}),error);
 // Invalid direct calls make coverage incomplete; valid event identities remain preserved.
 const closed=t.value.close();validate(closed);assert.equal(closed.complete,false);
 assert.deepEqual(closed.eventIds,t.events.slice(0,-1).map(e=>e.eventId));assert.deepEqual(closed.contextEventIds,[original.eventId]);
 assert.deepEqual(t.value.close(),closed);assert.equal(t.events.filter(e=>e.event==='trace_closed').length,1);
 assert.throws(()=>t.value.startWait(scope),error);assert.throws(()=>t.value.contextSupplied(wait.spanId,{providerRunId:'child-1',launchId:'new'}),error);
});
test('valid repeated launch receipts retain separate attempts; terminal and close replays never emit twice',async()=>{
 const api=await load(),t=trace(api);const wait=t.value.startWait(scope);const received=t.value.finishWait(wait.spanId,{answerId:'answer-1'});
 assert.deepEqual(t.value.finishWait(wait.spanId,{answerId:'answer-1'}),received);
 for(const id of ['launch-1','launch-2'])t.value.contextSupplied(wait.spanId,{providerRunId:'child-'+id,launchId:id});
 const closed=t.value.close();completeTrace(t.events);assert.equal(closed.contextEventIds.length,2);assert.equal(closed.spanIds.length,1);
 const snapshot=structuredClone(closed);try{closed.eventIds.push('tamper');}catch{}assert.deepEqual(t.value.close(),snapshot);
});
test('empty complete trace establishes zero; null root, open span, and explicit uncertainty remain incomplete',async()=>{
 const api=await load();
 const empty=trace(api);empty.value.close();const zero=completeTrace(empty.events);assert.deepEqual(zero.spanIds,[]);assert.deepEqual(zero.contextEventIds,[]);
 const nullRoot=trace(api,{invocationRunId:null});assert.equal(nullRoot.value.close().complete,false);
 const open=trace(api);open.value.startWait(scope);assert.equal(open.value.close().complete,false);
 const uncertain=trace(api);uncertain.value.markIncomplete();assert.equal(uncertain.value.close().complete,false);
 const childNull=trace(api),wait=childNull.value.startWait(scope);childNull.value.finishWait(wait.spanId,{answerId:'answer-1'});childNull.value.contextSupplied(wait.spanId,{providerRunId:null,launchId:'launch-1'});assert.equal(childNull.value.close().complete,true,'known transport can be complete while child attribution is null');
});
test('sink exceptions preserve detached intended references, known terminal work and incomplete closure',async()=>{
 const api=await load();const attempted=[];let throws=true;
 const t=trace(api,{emit:e=>{attempted.push(structuredClone(e));if(throws)throw Error('PRIVATE_SINK_SENTINEL');}});
 const wait=t.value.startWait(scope);t.value.finishWait(wait.spanId,{answerId:'answer-1'});
 throws=false;const supplied=t.value.contextSupplied(wait.spanId,{providerRunId:'child-1',launchId:'launch-1'});const closed=t.value.close();
 assert.equal(closed.complete,false);assert.deepEqual(closed.eventIds,attempted.slice(0,-1).map(e=>e.eventId));assert.deepEqual(closed.contextEventIds,[supplied.eventId]);
 assert.ok(!JSON.stringify(attempted).includes('PRIVATE_SINK_SENTINEL'));assert.equal(attempted.filter(e=>e.event==='trace_closed').length,1);
 const closing=trace(api,{emit:()=>{throw Error('PRIVATE_CLOSE');}});assert.doesNotThrow(()=>closing.value.close());
});

for(const backend of ['claude','codex']){
 test(backend+': actual owned spawn context receipt matches child tracking and delivered answer',async t=>{
  const api=await load(),f=setup(api,t,backend),p=f.launch(),result=await bounded(p.done);
  assert.equal(result.code,0,result.out);assert.equal(f.passed(),true);assert.equal(f.calls().length,1);
  const events=observations(result.out),closed=completeTrace(events),receipt=events.filter(e=>e.event==='context_supplied');
  assert.equal(receipt.length,1);const e=receipt[0];assert.equal(e.answerId,'answer-trace');assert.equal(e.decisionRunId,'logical-trace');assert.equal(e.revision,f.revision);assert.equal(e.queueNamespace,f.queue.readNamespace());
  const s=api.createRunStore(f.storeDir),runs=s.listRuns(),parent=runs.find(r=>r.workflow==='autobuild'),child=runs.find(r=>r.id===e.providerRunId);
  assert.ok(parent&&child);assert.equal(child.workflow,'session');assert.equal(child.parentRunId,parent.id);assert.equal(child.backend,backend);assert.equal(e.invocationRunId,parent.id);assert.equal(closed.invocationRunId,parent.id);assert.notEqual(e.providerRunId,parent.id);assert.notEqual(e.invocationRunId,e.decisionRunId);
  const transport=backend==='codex'?f.calls()[0].input:f.argv()[0].args.join('\n');assert.match(transport,/blue/);assert.match(transport,/untrusted/i);
  assert.ok(!JSON.stringify(events).includes('Pick fixture color'));assert.ok(!JSON.stringify(events).includes('"value":"blue"'));
 });
 test(backend+': known actual spawn failure emits no supplied-context receipt',async t=>{
  const api=await load(),f=setup(api,t,backend,{failedSpawn:true}),result=await bounded(f.launch().done);
  assert.notEqual(result.code,0,result.out);assert.equal(f.passed(),false);assert.equal(f.calls().length,0);assert.equal(f.argv().length,0);
  const events=observations(result.out);assert.ok(events.some(e=>e.event==='received'),'fixture must reach acknowledged gate before spawn failure');
  assert.equal(f.queue.read('choice').state,'acknowledged');assert.equal(events.filter(e=>e.event==='context_supplied').length,0);completeTrace(events);
  const runs=api.createRunStore(f.storeDir).listRuns();assert.ok(runs.some(r=>r.workflow==='session'),'actual tracked session attempt required');
 });
 test(backend+': unavailable tracking preserves transport fact with null IDs and incomplete root',async t=>{
  const api=await load(),f=setup(api,t,backend,{brokenTracking:true}),result=await bounded(f.launch().done);
  assert.equal(result.code,0,result.out);assert.equal(f.passed(),true);const events=observations(result.out),receipt=events.filter(e=>e.event==='context_supplied');
  assert.equal(receipt.length,1);assert.equal(receipt[0].invocationRunId,null);assert.equal(receipt[0].providerRunId,null);assert.equal(receipt[0].decisionRunId,'logical-trace');
  const close=events.at(-1);assert.equal(close.event,'trace_closed');assert.equal(close.complete,false);assert.deepEqual(close.contextEventIds,[receipt[0].eventId]);assert.equal(f.calls().length,1);
 });
 test(backend+': opt-out and completed-feature restart emit complete zero without duplicate context',async t=>{
  const api=await load(),f=setup(api,t,backend,{question:false}),first=await bounded(f.launch().done);
  assert.equal(first.code,0,first.out);assert.equal(f.passed(),true);const initial=completeTrace(observations(first.out));assert.deepEqual(initial.spanIds,[]);assert.deepEqual(initial.contextEventIds,[]);
  const count=f.calls().length;assert.equal(count,1);
  const second=await bounded(f.launch().done);assert.equal(second.code,0,second.out);const resumed=completeTrace(observations(second.out));assert.deepEqual(resumed.spanIds,[]);assert.deepEqual(resumed.contextEventIds,[]);assert.equal(f.calls().length,count);assert.notEqual(initial.invocationRunId,resumed.invocationRunId);
 });
 test(backend+': observation sink failure cannot change actual provider work or feature completion',async t=>{
  const api=await load(),f=setup(api,t,backend,{emissionFailure:true}),result=await bounded(f.launch().done);
  assert.equal(result.code,0,result.out);assert.equal(f.passed(),true);assert.equal(f.calls().length,1);assert.equal(f.queue.read('choice').state,'acknowledged');
  const attempts=f.attempts().map(validate);assert.ok(attempts.some(e=>e.event==='context_supplied'));const closed=attempts.filter(e=>e.event==='trace_closed');assert.equal(closed.length,1);assert.equal(closed[0].complete,false);assert.deepEqual(closed[0].eventIds,attempts.filter(e=>e.event!=='trace_closed').map(e=>e.eventId));
 });
}

test('Codex actual closed stdin reports EPIPE and never upgrades acknowledgement to supplied context',async t=>{
 const api=await load();
 const control=setup(api,t,'codex',{question:false,pipeFailure:true});
 const baseline=await bounded(control.launch().done);
 assert.ok(control.pipeErrors().some(e=>e.code==='EPIPE'),'control must observe actual pipe error, not infer it from elapsed time');
 const target=setup(api,t,'codex',{question:true,pipeFailure:true});
 const result=await bounded(target.launch().done);
 assert.ok(target.pipeErrors().some(e=>e.code==='EPIPE'),'target must observe actual pipe error');
 assert.equal(result.code,baseline.code,'observation cannot change original workflow exit');
 assert.equal(target.passed(),control.passed());assert.equal(target.passed(),false);
 assert.equal(target.calls().length,0);assert.ok(target.argv().length>=1,'owned executable actually spawned');
 const events=observations(result.out);assert.ok(events.some(e=>e.event==='received'));assert.equal(target.queue.read('choice').state,'acknowledged');
 assert.equal(events.filter(e=>e.event==='context_supplied').length,0,'spawn alone does not prove successful stdin context transport');
 const closed=events.filter(e=>e.event==='trace_closed');assert.equal(closed.length,1);assert.equal(closed[0].complete,false);
 assert.deepEqual(closed[0].contextEventIds,[]);assert.deepEqual(closed[0].eventIds,events.filter(e=>e.event!=='trace_closed').map(e=>e.eventId));
});

for(const backend of ['claude','codex']){
 test(backend+': previously answered completed feature restart closes zero without stale gate or duplicate receipt',async t=>{
  const api=await load(),f=setup(api,t,backend),first=await bounded(f.launch().done);
  assert.equal(first.code,0,first.out);const original=completeTrace(observations(first.out));assert.equal(original.contextEventIds.length,1);
  const queueBefore=structuredClone(f.queue.read('choice')),callCount=f.calls().length;
  const second=await bounded(f.launch().done);assert.equal(second.code,0,second.out);
  const after=completeTrace(observations(second.out));assert.notEqual(after.invocationRunId,original.invocationRunId);
  assert.deepEqual(after.spanIds,[]);assert.deepEqual(after.eventIds,[]);assert.deepEqual(after.contextEventIds,[]);
  assert.equal(f.calls().length,callCount);assert.deepEqual(f.queue.read('choice'),queueBefore);assert.equal(f.passed(),true);
 });
 test(backend+': usage probe, later feature, and review never receive the earlier decision context',async t=>{
  const api=await load();
  const limit=backend==='codex'?{error:"You've hit your usage limit"}:{limit:"You've hit your usage limit"};
  const f=setup(api,t,backend,{featureIds:['F-1','F-2'],steps:[limit,{ok:true},{build:'F-1'},{build:'F-2'},{review:true}],limits:{maxIterations:8,noProgressLimit:2,finalReview:true}});
  const result=await bounded(f.launch().done,30000);assert.equal(result.code,0,result.out);assert.ok(f.features().every(feature=>feature.passes));
  const calls=f.calls();assert.equal(calls.length,5);assert.deepEqual(calls.map(c=>c.step),[limit,{ok:true},{build:'F-1'},{build:'F-2'},{review:true}]);
  const transports=backend==='codex'?calls.map(c=>c.input):f.argv().map(c=>c.args.join('\n'));assert.equal(transports.length,5);
  for(const i of [0,2]){assert.match(transports[i],/blue/);assert.match(transports[i],/untrusted/i);}
  for(const i of [1,3,4])assert.ok(!transports[i].includes('blue'),'answer leaked to untargeted call '+i);
  assert.match(transports[1],/Reply(?: with)? OK\./,'second call is actual usage probe');
  const events=observations(result.out);completeTrace(events);const receipts=events.filter(e=>e.event==='context_supplied');
  assert.equal(receipts.length,2,'only original and retried targeted builders receive context');assert.equal(new Set(receipts.map(e=>e.launchId)).size,2);
  assert.ok(receipts.every(e=>e.featureId==='F-1'&&e.answerId==='answer-trace'));
  const runs=api.createRunStore(f.storeDir).listRuns(),parent=runs.find(r=>r.workflow==='autobuild');
  assert.ok(parent);for(const receipt of receipts){const child=runs.find(r=>r.id===receipt.providerRunId);assert.ok(child);assert.equal(child.parentRunId,parent.id);assert.equal(child.workflow,'session');}
  assert.equal(new Set(receipts.map(e=>e.providerRunId)).size,2);
 });
}
