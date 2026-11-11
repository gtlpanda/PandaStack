// External prospective bridge acceptance; no execution before independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,unlinkSync,mkdirSync,rmdirSync,lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {ROOT,pins,completion,devAnswer,reconArgs,research} from './nr-02-runtime-support.mjs';
const err=c=>e=>e?.code===c;
async function setup(t,grant=1){
 const bridge=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/native-checkpoints.mjs')));
 const j=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/dispatch-journal.mjs')));
 const report=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/audit-report.mjs')));
 const {createNativeRuntime}=await import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/runtime.mjs')));
 const {loadWorkflowRegistry}=await import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/registry.mjs')));
 const {newInit}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/tests/stage-fixtures.mjs')));
 const {runDir}=newInit(),journal=j.openAuditJournal({runDir,invocationLimit:4});journal.initControl({initialGrant:grant});
 const calls=[],runtimes=[],ports=[];const registry=loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:pins()});
 const current=()=>{report.publishPartialReport(runDir);assert.equal(report.readPartialReport(runDir).status,'current');journal.acknowledgeReport({expectedRevision:journal.getControl().revision});};
 const runtime=(answer=devAnswer,cap=1,{signal}={})=>{const checkpoints=bridge.createAuditCheckpoints({runDir,journal});ports.push(checkpoints);const r=createNativeRuntime({registry,checkpoints,provider:{async runLeaf(req){calls.push(req);assert.equal(j.readAuditJournal(runDir).rows.find(x=>x.id===req.callId).state,'dispatched');return completion(req,await answer(req));}},resolveLeaf:({workflowId})=>({selection:{provider:'codex',model:'fake',effort:'high'},profile:workflowId==='security-audit-flow'?'audit-source-only':'source-review'}),maxConcurrentSubagents:cap,deadlineMs:Date.now()+10000,...(signal?{signal}:{})});runtimes.push(r);return r;};
 t.after(async()=>{for(const r of runtimes)await r.close();for(const p of ports)await p.close();journal.close();});
 return {bridge,j,report,journal,runDir,calls,current,runtime,ports};
}
const run=r=>r.run('harness-repair',{repo:'/inert/project'},{invocationId:'bridge-qa'});
test('actual initial report gate is controlled pause with no provider call',async t=>{
 const x=await setup(t);await assert.rejects(run(x.runtime()),err('CONTROL_PAUSED'));assert.equal(x.calls.length,0);assert.equal(x.j.readAuditJournal(x.runDir).settledCalls,0);
});
test('grant pause preserves checker and same invocation resumes without rerunning it',async t=>{
 const x=await setup(t);x.current();await assert.rejects(run(x.runtime()),err('CONTROL_PAUSED'));
 assert.deepEqual(x.calls.map(x=>x.agentType),['checker']);const before=x.j.readAuditJournal(x.runDir);assert.equal(before.settledCalls,1);assert.equal(before.rows[0].state,'returned');assert.equal(x.report.readPartialReport(x.runDir).status,'current');
 x.journal.adjustGrant({expectedRevision:x.journal.getControl().revision,currentGrant:4,reason:'operator_increase'});x.current();x.journal.resumeBudget({expectedRevision:x.journal.getControl().revision});
 const out=await run(x.runtime());assert.equal(out.status,'done');assert.deepEqual(x.calls.map(x=>x.agentType),['checker','reviewer','qa-auditor']);assert.equal(x.j.readAuditJournal(x.runDir).settledCalls,3);assert.equal(x.report.readPartialReport(x.runDir).status,'current');assert.deepEqual(x.j.readAuditJournal(x.runDir).rows[0],before.rows[0]);
});
test('explicit report-stale pause never turns into provider failure or replay call',async t=>{
 const x=await setup(t,4);x.current();assert.equal((await run(x.runtime())).status,'done');const before=x.j.readAuditJournal(x.runDir),n=x.calls.length;
 x.journal.pauseControl({expectedRevision:x.journal.getControl().revision,reason:'report_stale'});
 // Replaying only terminal receipts is legal even while no new dispatch is permitted.
 assert.equal((await run(x.runtime())).status,'done');assert.equal(x.calls.length,n);assert.deepEqual(x.j.readAuditJournal(x.runDir),before);assert.ok(x.journal.getControl().blockers.includes('report_stale'));
});
test('unknown transport remains fatal and charged, never mapped to controlled pause',async t=>{
 const x=await setup(t,4);x.current();await assert.rejects(run(x.runtime(()=>{throw Error('inert uncertain transport');})),err('DISPATCH_UNCERTAIN'));
 assert.equal(x.calls.length,1);const s=x.j.readAuditJournal(x.runDir);assert.equal(s.heldCalls,1);assert.equal(s.rows[0].state,'uncertain');assert.ok(x.journal.getControl().blockers.includes('paused_uncertain'));
});

test('controlled pause drains two actual audit leaves without aborting active sibling',{timeout:5000},async t=>{
 const x=await setup(t,4);x.current();let entered;const both=new Promise(r=>{entered=r;}),pending=[];
 const r=x.runtime(req=>new Promise(resolve=>{pending.push({req,resolve});if(pending.length===2)entered();}),2);
 const running=r.run('security-audit-flow',reconArgs(),{invocationId:'bridge-audit'});
 const observed=running.then(value=>({value}),error=>({error}));
 try{
 await Promise.race([both,observed.then(()=>{throw Error('audit ended before two callbacks entered');})]);
 assert.equal(x.report.readPartialReport(x.runDir).status,'current');
 x.journal.pauseControl({expectedRevision:x.journal.getControl().revision,reason:'paused_budget'});
 pending[0].resolve(research(pending[0].req));await new Promise(r=>setImmediate(r));
 assert.equal(pending[1].req.signal.aborted,false);assert.equal(x.calls.length,2);
 pending[1].resolve(research(pending[1].req));const out=await observed;assert.equal(out.error?.code,'CONTROL_PAUSED');assert.equal(x.calls.length,2);
 const state=x.j.readAuditJournal(x.runDir);assert.equal(state.settledCalls,2);assert.equal(state.heldCalls,0);assert.ok(state.rows.every(x=>x.state==='returned'));assert.ok(x.journal.getControl().blockers.includes('paused_budget'));
 }finally{for(const row of pending)row.resolve(research(row.req));await observed;}
});

test('actual owned publication conflict pauses after durable receipt and repair never repeats callbacks',{timeout:5000},async t=>{
 const x=await setup(t,4);x.current();const pointer=join(x.runDir,'partial-reports/current.json'),saved=readFileSync(pointer);let conflict=false,entered;const both=new Promise(r=>{entered=r;}),pending=[];
 const repair=()=>{if(conflict){assert.equal(lstatSync(pointer).isDirectory(),true);rmdirSync(pointer);writeFileSync(pointer,saved,{mode:0o600});conflict=false;}};
 const r=x.runtime(async req=>{const index=pending.length;await new Promise(resolve=>{pending.push({req,resolve});if(pending.length===2)entered();});if(index===0){assert.equal(lstatSync(pointer).isFile(),true);unlinkSync(pointer);mkdirSync(pointer,{mode:0o700});conflict=true;}return research(req);},2);
 const observed=r.run('security-audit-flow',reconArgs(),{invocationId:'publication-audit'}).then(value=>({value}),error=>({error}));
 try{
  await Promise.race([both,observed.then(()=>{throw Error('audit ended before both ordinary callbacks');})]);assert.equal(x.report.readPartialReport(x.runDir).status,'current');pending[0].resolve();
  // Only ordinary in-process promise settlement is awaited; no external writer or race.
  let ready=false;for(let i=0;i<100;i++){await new Promise(r=>setImmediate(r));if(x.j.readAuditJournal(x.runDir).settledCalls===1&&conflict){ready=true;break;}}
  assert.equal(ready,true);assert.equal(pending[1].req.signal.aborted,false);assert.equal(x.calls.length,2);
  const failed=x.report.publishPartialReport(x.runDir);assert.equal(failed.status,'failed');assert.equal(failed.reason,'IO_ERROR');assert.equal(failed.currentPath,null);
  pending[1].resolve();const out=await observed;assert.equal(out.error?.code,'CONTROL_PAUSED');assert.equal(x.calls.length,2);
  const before=x.j.readAuditJournal(x.runDir);assert.equal(before.settledCalls,2);assert.ok(before.rows.every(r=>r.state==='returned'));assert.deepEqual(x.journal.getControl().blockers,['report_stale']);
  repair();x.current();const resumed=await x.runtime(research,2).run('security-audit-flow',reconArgs(),{invocationId:'publication-audit'});assert.equal(resumed.status,'done');assert.equal(x.calls.length,4);assert.deepEqual(x.j.readAuditJournal(x.runDir).rows.slice(0,2),before.rows);assert.equal(x.report.readPartialReport(x.runDir).status,'current');
 }finally{for(const row of pending)row.resolve();await observed;repair();}
});

test('actual handle association rejects mismatched runs and forged or Proxy handles before hooks',async t=>{
 const a=await setup(t),b=await setup(t);const snapshot=x=>({journal:x.j.readAuditJournal(x.runDir),control:x.journal.getControl()});const beforeA=snapshot(a),beforeB=snapshot(b);
 assert.throws(()=>a.bridge.createAuditCheckpoints({runDir:a.runDir,journal:b.journal}),err('CONFLICT'));
 let hooks=0;const fake={get prepare(){hooks++;throw Error('must not read forged methods');}};
 const proxy=new Proxy(a.journal,{get(){hooks++;throw Error('must not inspect proxy');},getPrototypeOf(){hooks++;throw Error('must not inspect proxy');},ownKeys(){hooks++;throw Error('must not inspect proxy');}});
 for(const journal of [fake,proxy])assert.throws(()=>a.bridge.createAuditCheckpoints({runDir:a.runDir,journal}),err('INVALID_JOURNAL_OWNER'));
 assert.equal(hooks,0);assert.deepEqual(snapshot(a),beforeA);assert.deepEqual(snapshot(b),beforeB);
 a.journal.close();assert.throws(()=>a.bridge.createAuditCheckpoints({runDir:a.runDir,journal:a.journal}),err('CLOSED'));
});

test('external cancellation joins both owned journal callbacks and retains uncertain charge',{timeout:5000},async t=>{
 const x=await setup(t,4);x.current();const controller=new AbortController();let entered,joined=0;const both=new Promise(r=>{entered=r;});let started=0;
 const r=x.runtime(req=>new Promise(resolve=>{req.signal.addEventListener('abort',()=>{joined++;resolve(research(req));},{once:true});if(++started===2)entered();}),2,{signal:controller.signal});
 const observed=r.run('security-audit-flow',reconArgs(),{invocationId:'cancel-audit'}).then(value=>({value}),error=>({error}));
 try{
  await Promise.race([both,observed.then(()=>{throw Error('audit ended before two callbacks');})]);controller.abort();const out=await observed;assert.equal(out.error?.code,'RUNTIME_ABORTED');
  await new Promise(r=>setImmediate(r));assert.equal(joined,2);assert.equal(x.calls.length,2);
  const before=x.j.readAuditJournal(x.runDir);assert.equal(before.heldCalls,2);assert.equal(before.settledCalls,0);assert.ok(before.rows.every(row=>row.state==='uncertain'));x.current();const control=x.journal.getControl();
  for(const row of before.rows)await x.ports[0].uncertain(row.id,{code:'RUNTIME_ABORTED'},{signal:new AbortController().signal});
  assert.deepEqual(x.j.readAuditJournal(x.runDir),before);assert.deepEqual(x.journal.getControl(),control);
  await x.ports[0].close();x.journal.close();
 }finally{
  controller.abort();await observed;
  try{for(const row of x.j.readAuditJournal(x.runDir).rows)if(row.state==='dispatched')await x.ports[0].uncertain(row.id,{code:'RUNTIME_ABORTED'},{signal:new AbortController().signal});}catch{}
 }
});

test('changed bound metadata after acknowledgement pauses before any new row or provider',async t=>{
 const x=await setup(t,4);x.current();assert.deepEqual(x.journal.getControl().blockers,[]);
 const {recordSpend}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/audit-run.mjs')));recordSpend(x.runDir,'fixture-observation',1);
 assert.equal(x.report.readPartialReport(x.runDir).status,'stale');assert.deepEqual(x.journal.getControl().blockers,[]);
 await assert.rejects(run(x.runtime()),err('CONTROL_PAUSED'));assert.equal(x.calls.length,0);assert.equal(x.j.readAuditJournal(x.runDir).rows.length,0);assert.deepEqual(x.journal.getControl().blockers,['report_stale']);
});
