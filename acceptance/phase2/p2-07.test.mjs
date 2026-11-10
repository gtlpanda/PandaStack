import test from 'node:test';
import assert from 'node:assert/strict';
import {mod,NOW,REV,ROOT,temp,cleanup,decision,answer,recipient} from './support.mjs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const scope={queueNamespace:'review-queue',decisionRunId:'review-logical',featureId:'review-feature',decisionId:'review-choice',revision:REV,deliveryId:'review-delivery'};
for(const received of [false,true])test(`close-only sink failure returns and replays incomplete (${received?'received span':'empty trace'})`,async()=>{
 const {createDecisionTrace}=await mod('observations');let attempts=0;const delivered=[];
 const trace=createDecisionTrace({repo:'/review/project',revision:REV,invocationRunId:'review-outer',now:()=>NOW,monotonicNow:()=>10,emit:event=>{
  if(event.event==='trace_closed'){attempts++;throw Error('synthetic close sink failure');}
  delivered.push(structuredClone(event));
 }});
 if(received){const waiting=trace.startWait(scope);trace.finishWait(waiting.spanId,{answerId:'review-answer'});}
 assert.equal(trace.complete,true,'ordinary trace should be complete before the closing sink fails');
 let closed;assert.doesNotThrow(()=>{closed=trace.close();});
 assert.equal(trace.complete,false);assert.equal(closed.complete,false,'failed close emission cannot return complete');
 assert.deepEqual(closed.eventIds,delivered.map(e=>e.eventId));
 const expected=structuredClone(closed);try{closed.complete=true;closed.eventIds.push('tampered');}catch{}
 assert.deepEqual(trace.close(),expected,'replay retains detached incomplete snapshot');assert.equal(attempts,1,'replay never retries failed emission');
});
test('successful closing sink still returns complete and replay emits once',async()=>{
 const {createDecisionTrace}=await mod('observations');const delivered=[];
 const trace=createDecisionTrace({repo:'/review/project',revision:REV,invocationRunId:'review-outer',now:()=>NOW,monotonicNow:()=>10,emit:e=>delivered.push(structuredClone(e))});
 const waiting=trace.startWait(scope);trace.finishWait(waiting.spanId,{answerId:'review-answer'});
 const closed=trace.close();assert.equal(closed.complete,true);assert.equal(trace.complete,true);
 assert.deepEqual(trace.close(),closed);assert.equal(delivered.filter(e=>e.event==='trace_closed').length,1);
});

test('owning CLI preserves manual handoff after uncertain native dispatch',async()=>{
 const {createDecisionQueue}=await mod('queue');const {deliverToCodex}=await mod('codex-delivery');
 const root=temp(),store=join(root,'queue');let q;
 try{
  q=createDecisionQueue(store,{now:()=>NOW});q.request(decision());q.answer('decision-1',answer());let attempts=0;
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target:{threadId:'owned-thread',turnId:'owned-turn'},transport:async()=>{attempts++;throw Error('synthetic uncertain transport');}}),e=>e.code==='MANUAL_HANDOFF');
  assert.equal(attempts,1);q.close();q=null;
  const file=join(root,'recipient.json');writeFileSync(file,JSON.stringify(recipient()));
  const r=spawnSync(process.execPath,[join(ROOT,'scripts/pandastack.mjs'),'decision','ack','--store',store,'--id','decision-1','--file',file],{encoding:'utf8',timeout:15000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
  assert.equal(r.error,undefined);assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.deepEqual(JSON.parse(r.stderr),{error:'MANUAL_HANDOFF'},'known safe manual reconciliation code must survive CLI redaction');
  q=createDecisionQueue(store,{now:()=>NOW});assert.equal(q.read('decision-1').ack,null);
 }finally{q?.close();cleanup(root);}
});

import './p2-07-transport.cases.mjs';
