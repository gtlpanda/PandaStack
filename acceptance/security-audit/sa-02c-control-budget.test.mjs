// External proposed acceptance; not executed or frozen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
async function setup(t,{maximum=4,grant=2,legacy=false}={}){
 const j=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/dispatch-journal.mjs')));
 for(const n of ['readAuditControl','readAuditBudgetEvidence'])assert.equal(typeof j[n],'function','missing control API '+n);
 const p=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/audit-report.mjs')));
 assert.equal(typeof p.publishPartialReport,'function');
 const {newInit}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/tests/stage-fixtures.mjs')));
 const {runDir}=newInit();const h=j.openAuditJournal({runDir,invocationLimit:maximum});t.after(()=>h.close());
 if(!legacy)h.initControl({initialGrant:grant});
 const current=()=>{const out=p.publishPartialReport(runDir);assert.ok(['published','replayed'].includes(out.status));assert.equal(p.readPartialReport(runDir).status,'current');return h.acknowledgeReport({expectedRevision:h.getControl().revision});};
 return {j,p,h,runDir,current};
}
const err=c=>e=>e?.code===c;
test('legacy journal retains original immutable limit without control',async t=>{
 const x=await setup(t,{maximum:1,legacy:true});assert.equal(x.h.getControl(),null);assert.equal(x.j.readAuditControl(x.runDir),null);
 x.h.prepare({id:'a',input:{}});assert.throws(()=>x.h.prepare({id:'b',input:{}}),err('BUDGET_EXHAUSTED'));assert.equal(x.j.readAuditJournal(x.runDir).invocationLimit,1);
});
test('explicit initial grant is gated by actual current report and acknowledgement does not stale it',async t=>{
 const x=await setup(t);assert.deepEqual(x.h.getControl().blockers,['report_stale']);assert.throws(()=>x.h.prepare({id:'a',input:{}}),err('CONTROL_PAUSED'));
 assert.throws(()=>x.h.acknowledgeReport({expectedRevision:1}),err('REPORT_NOT_CURRENT'));
 const c=x.current();assert.deepEqual(c.blockers,[]);assert.equal(x.p.readPartialReport(x.runDir).status,'current');assert.equal(x.j.readAuditBudgetEvidence(x.runDir).currentGrant,2);
 x.h.prepare({id:'a',input:{}});x.h.prepare({id:'b',input:{}});assert.throws(()=>x.h.prepare({id:'c',input:{}}),err('BUDGET_EXHAUSTED'));assert.deepEqual(x.h.getControl().blockers,['paused_budget']);
});
test('grant adjustment uses CAS and never silently raises immutable maximum or clears another blocker',async t=>{
 const x=await setup(t);let c=x.h.getControl();
 assert.throws(()=>x.h.adjustGrant({expectedRevision:c.revision,currentGrant:3,reason:'operator_increase'}),err('CONTROL_BUSY'));
 x.h.pauseControl({expectedRevision:c.revision,reason:'paused_budget'});c=x.h.getControl();
 assert.throws(()=>x.h.adjustGrant({expectedRevision:c.revision,currentGrant:5,reason:'operator_increase'}),err('INVALID_CONTROL_INPUT'));
 const n=x.h.adjustGrant({expectedRevision:c.revision,currentGrant:3,reason:'operator_increase'});assert.equal(n.currentGrant,3);assert.equal(n.maximum,4);assert.deepEqual(n.blockers,['paused_budget','report_stale']);
 assert.throws(()=>x.h.adjustGrant({expectedRevision:n.revision,currentGrant:2,reason:'operator_increase'}),err('INVALID_CONTROL_INPUT'));
 assert.throws(()=>x.h.adjustGrant({expectedRevision:c.revision,currentGrant:4,reason:'operator_increase'}),err('CONFLICT'));
 assert.equal(x.j.readAuditJournal(x.runDir).invocationLimit,4);x.current();assert.equal(x.p.readPartialReport(x.runDir).status,'current');
});
test('pause blocks prepared dispatch while terminal replay and cancellation remain allowed',async t=>{
 const x=await setup(t);x.current();x.h.prepare({id:'done',input:{}});let calls=0;await x.h.execute('done',async()=>{calls++;return {outcome:'returned',result:{ok:true}};});x.current();
 x.h.prepare({id:'held',input:{}});x.h.pauseControl({expectedRevision:x.h.getControl().revision,reason:'paused_budget'});
 await assert.rejects(x.h.execute('held',async()=>{calls++;return {outcome:'returned',result:null};}),err('CONTROL_PAUSED'));
 assert.equal((await x.h.execute('done',()=>{throw Error('replay must not dispatch');})).replayed,true);assert.equal(calls,1);assert.equal(x.h.cancelPrepared('held').changed,true);
});
test('in-flight settlement survives pause and unknown outcome cannot be cleared by extra grant or report',{timeout:5000},async t=>{
 const x=await setup(t);x.current();x.h.prepare({id:'active',input:{}});let finish,entered;const started=new Promise(r=>{entered=r;});
 const result=x.h.execute('active',()=>new Promise(r=>{finish=r;entered();}));
 await Promise.race([started,result.then(()=>{throw Error('callback did not start');})]);
 try{x.h.pauseControl({expectedRevision:x.h.getControl().revision,reason:'paused_budget'});}
 finally{if(finish)finish({outcome:'returned',result:'kept'});await result;}
 assert.equal(x.j.readAuditJournal(x.runDir).rows[0].state,'returned');assert.deepEqual(x.h.getControl().blockers,['paused_budget','report_stale']);
 x.current();x.h.resumeBudget({expectedRevision:x.h.getControl().revision});x.h.prepare({id:'unknown',input:{}});
 await assert.rejects(x.h.execute('unknown',async()=>{throw Error('unknown transport');}),err('DISPATCH_UNCERTAIN'));
 assert.ok(x.h.getControl().blockers.includes('paused_uncertain'));assert.throws(()=>x.h.adjustGrant({expectedRevision:x.h.getControl().revision,currentGrant:3,reason:'operator_increase'}),err('CONTROL_BUSY'));
 x.current();assert.deepEqual(x.h.getControl().blockers,['paused_uncertain']);assert.equal(x.j.readAuditJournal(x.runDir).heldCalls,1);
});
test('grant evidence invalidates prior report; stale reader cannot clear gate',async t=>{
 const x=await setup(t);x.current();const old=x.p.readPartialReport(x.runDir).generationKey;
 x.h.pauseControl({expectedRevision:x.h.getControl().revision,reason:'paused_budget'});
 x.h.adjustGrant({expectedRevision:x.h.getControl().revision,currentGrant:3,reason:'operator_increase'});
 assert.equal(x.p.readPartialReport(x.runDir).status,'stale');assert.throws(()=>x.h.acknowledgeReport({expectedRevision:x.h.getControl().revision}),err('REPORT_NOT_CURRENT'));
 x.current();assert.notEqual(x.p.readPartialReport(x.runDir).generationKey,old);assert.equal(x.p.readPartialReport(x.runDir).status,'current');
});
test('populated legacy journal cannot be silently opted into new control semantics',async t=>{
 const x=await setup(t,{legacy:true});x.h.prepare({id:'a',input:{}});
 assert.throws(()=>x.h.initControl({initialGrant:2}),err('CONTROL_INIT_REFUSED'));assert.equal(x.h.getControl(),null);assert.equal(x.j.readAuditJournal(x.runDir).rows.length,1);
});

test('explicit empty opt-in alone upgrades exact schema while retaining original header and attempts',async t=>{
 const x=await setup(t,{legacy:true});
 const {DatabaseSync}=await import('node:sqlite');
 const inspect=()=>{const db=new DatabaseSync(resolve(x.runDir,'native-dispatch/journal.sqlite'),{readOnly:true});try{return {version:db.prepare('PRAGMA user_version').get().user_version,schemas:db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),header:db.prepare('SELECT * FROM header').get(),rows:db.prepare('SELECT * FROM attempts').all()};}finally{db.close();}};
 const before=inspect();assert.equal(before.version,1);assert.deepEqual(before.schemas.map(x=>x.name),['attempts','header']);
 x.h.initControl({initialGrant:2});const after=inspect();assert.equal(after.version,2);assert.deepEqual(after.schemas.map(x=>x.name),['attempts','control','control_history','header']);
 assert.deepEqual(after.schemas.filter(x=>['attempts','header'].includes(x.name)),before.schemas);assert.deepEqual(after.header,before.header);assert.deepEqual(after.rows,before.rows);
 assert.throws(()=>x.h.initControl({initialGrant:2}),err('CONFLICT'));
});

test('zero authorized grant and zero maximum remain known budget evidence',async t=>{
 const x=await setup(t,{maximum:0,grant:0});x.current();
 assert.deepEqual(x.j.readAuditBudgetEvidence(x.runDir),{version:1,maximum:0,currentGrant:0});
 assert.equal(x.p.readPartialReport(x.runDir).status,'current');
 assert.throws(()=>x.h.prepare({id:'denied',input:{}}),err('BUDGET_EXHAUSTED'));
 assert.equal(x.j.readAuditJournal(x.runDir).rows.length,0);
 assert.deepEqual(x.h.getControl().blockers,['paused_budget']);
});
