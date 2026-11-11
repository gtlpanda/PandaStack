import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { readFileSync,readdirSync } from 'node:fs';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const base='graphs/security-audit/';
const imp=p=>import(pathToFileURL(resolve(ROOT,base+p)));
async function api(){const a=await imp('skills/security-audit/audit-ledger.mjs'); for(const name of ['inspectUnitInputs','criticTransitionContext','inspectCriticTransitions'])assert.equal(typeof a[name],'function',name+' owning export required');return a;}
async function fixture(){const f=await imp('tests/ledger-fixtures.mjs');const r=await imp('tests/audit-fixtures.mjs');return {...f,...r};}
const ctx=runDir=>({runDir,scope:[],priorStatus:'none',profile:'standard'});
const critic=ids=>({missing_units:[],reassign_ids:ids,resolved_prior_leads:[],stop:false});
const snapshot=d=>Object.fromEntries(readdirSync(d,{withFileTypes:true}).filter(x=>x.isFile()).map(x=>[x.name,readFileSync(resolve(d,x.name)).toString('base64')]));
test('per-record seed feedback retains good sibling bytes and does not publish run files',async()=>{
 const a=await api(),f=await fixture(),{runDir}=f.newRun(),units=[f.unitInput('good'),f.unitInput('bad',{starting_paths:['src/absent.js']})],before=snapshot(runDir),bytes=JSON.stringify(units);
 const r=a.inspectUnitInputs(units,ctx(runDir),{kind:'seed'});assert.deepEqual(r.accepted.map(x=>x.index),[0]);assert.deepEqual(r.rejected.map(x=>x.index),[1]);assert.ok(r.rejected[0].problems.length);assert.deepEqual(r.accepted[0].input,units[0]);assert.equal(r.accepted[0].coverageId,a.unitFromInput(units[0],ctx(runDir)).unit.coverage_id);assert.equal(JSON.stringify(units),bytes);assert.deepEqual(snapshot(runDir),before);
});
test('optional lifecycle absence stays absent while null empty one-sided and malformed fields remain invalid',async()=>{
 const a=await api(),f=await fixture(),{runDir}=f.newRun(),good=f.unitInput('absent');const inputs=[good,...[null,'',' '].map((v,i)=>f.unitInput('bad'+i,{lifecycle:v,canonical_refs:f.refsOf('bad'+i,{lifecycle:v})})),f.unitInput('one',{lifecycle:'startup'})];
 const r=a.inspectUnitInputs(inputs,ctx(runDir),{kind:'seed'});assert.deepEqual(r.accepted.map(x=>x.index),[0]);assert.deepEqual(r.rejected.map(x=>x.index),[1,2,3,4]);assert.equal(Object.hasOwn(r.accepted[0].input,'lifecycle'),false);assert.equal(Object.hasOwn(r.accepted[0].input.canonical_refs,'lifecycle'),false);
});
test('valid lifecycle pair retains exact canonical identity and quick still rejects splitting',async()=>{
 const a=await api(),f=await fixture(),{runDir}=f.newRun(),u=f.unitInput('pair',{lifecycle:'Startup',canonical_refs:f.refsOf('pair',{lifecycle:'startup'})});const c={...ctx(runDir),profile:'deep'};const r=a.inspectUnitInputs([u],c,{kind:'seed'});assert.deepEqual(r.rejected,[]);assert.deepEqual(r.accepted[0].input,u);assert.equal(r.accepted[0].coverageId,a.unitFromInput(u,c).unit.coverage_id);assert.equal(a.inspectUnitInputs([u],{...c,profile:'quick'},{kind:'seed'}).accepted.length,0);
});
test('duplicate identities reject every conflicting slot while independent sibling survives',async()=>{
 const a=await api(),f=await fixture(),{runDir}=f.newRun(),u=f.unitInput('dup');const r=a.inspectUnitInputs([u,structuredClone(u),f.unitInput('other')],ctx(runDir),{kind:'seed'});assert.deepEqual(r.rejected.map(x=>x.index),[0,1]);assert.deepEqual(r.accepted.map(x=>x.index),[2]);assert.ok(r.rejected.every(x=>x.problems.length));
});
test('mint planned-only validation and existing block/path gates do not sacrifice valid sibling',async()=>{
 const a=await api(),f=await fixture(),{runDir}=f.newRun();const r=a.inspectUnitInputs([f.unitInput('yes'),f.unitInput('state',{status:'covered'}),f.unitInput('block',{ordinary_attack_class_block:'ATTACK-CLASSES.md#Absent'})],ctx(runDir),{kind:'mint'});assert.deepEqual(r.accepted.map(x=>x.index),[0]);assert.deepEqual(r.rejected.map(x=>x.index),[1,2]);
});
test('critic vocabulary allows only existing live-evidence statuses and never reasons as authority',async()=>{
 const a=await api();const statuses=['blocked','covered','candidate','deferred','planned','in_progress','out_of_scope','not_applicable'];const rows=statuses.map(status=>({coverage_id:status,status,unresolved:['budget_can_be_increased']}));const before=JSON.stringify(rows);const c=a.criticTransitionContext(rows);assert.deepEqual(c.reassignableIds,['blocked','candidate','covered']);assert.equal(c.maxSemanticAttempts,2);assert.equal(c.nonReassignable.find(x=>x.status==='deferred').code,'DEFERRED_NOT_REOPENABLE');assert.equal(JSON.stringify(rows),before);
 const r=a.inspectCriticTransitions(rows,critic(['deferred','covered','missing','covered','planned']));assert.deepEqual(r.acceptedReassignIds,['covered']);assert.deepEqual(r.rejected,[{coverageId:'deferred',code:'DEFERRED_NOT_REOPENABLE'},{coverageId:'missing',code:'UNKNOWN_UNIT'},{coverageId:'planned',code:'NO_LIVE_EVIDENCE'}]);
});
test('actual criticInput carries shared transition context without changing ledger or stage',async()=>{
 const a=await api(),f=await fixture(),run=f.seeded([f.unitInput('waiting',{status:'deferred',reason:'hunter_result_invalid_twice'}),f.unitInput('work')]);const owner=await imp('skills/security-audit/audit-run.mjs'),stage=await imp('skills/security-audit/audit-stage.mjs'),loaded=owner.loadRun(run.runDir),before=snapshot(run.runDir);const input=stage.criticInput(run.runDir,loaded,{kind:'final',wave:1,hunted:false});assert.deepEqual(input.transitionContext,a.criticTransitionContext(loaded.ledger));assert.equal(input.transitionContext.reassignableIds.length,0);assert.deepEqual(snapshot(run.runDir),before);
});
test('invalid envelopes hooks and mutable output cannot create transition authority',async()=>{
 const a=await api();let calls=0;const bad={};Object.defineProperty(bad,'status',{enumerable:true,get(){calls++;return 'covered';}});const proxy=new Proxy({}, {ownKeys(){calls++;return [];}});for(const rows of [[bad],[proxy],[{coverage_id:'x',status:'arbitrary'}],[{coverage_id:'x',status:'covered'},{coverage_id:'x',status:'covered'}]])assert.throws(()=>a.criticTransitionContext(rows),e=>e.code==='INVALID_INPUT');assert.equal(calls,0);const rows=[{coverage_id:'x',status:'deferred'}],first=a.criticTransitionContext(rows);try{first.reassignableIds.push('x');}catch{}assert.deepEqual(a.criticTransitionContext(rows).reassignableIds,[]);assert.throws(()=>a.inspectCriticTransitions(rows,{reassign_ids:['x']}),e=>e.code==='INVALID_INPUT');
});
test('actual critic prompt receives legal vocabulary and malformed context dispatches nobody',async()=>{
 const a=await api(),h=await import(pathToFileURL(resolve(ROOT,'scripts/workflow-harness.mjs'))),{fn}=h.load(resolve(ROOT,base+'workflows/security-audit-flow.js'));
 const rows=[{coverage_id:'live',status:'covered'},{coverage_id:'held',status:'deferred'}],transitionContext=a.criticTransitionContext(rows);
 const input={stage:'critic',kind:'post-wave',wave:1,hunted:true,tree:'/inert/tree',profile:'standard',maxParallel:1,execution:{capability:'none',blockers:['source only']},architecture_md:'ordinary architecture',parts:{criticSection:'ordinary methodology'},ledger:rows,candidates:[],prior:{records:[]},transitionContext};
 const out=await h.run(fn,{'audit-researcher':[(prompt)=>{assert.ok(prompt.includes('untrusted-transition-context'));for(const text of ['DEFERRED_NOT_REOPENABLE','held','live','maxSemanticAttempts'])assert.ok(prompt.includes(text));return critic([]);}]},input);assert.equal(out.result.status,'done');assert.equal(out.calls.length,1);
 const malformed=await h.run(fn,{}, {...input,transitionContext:{...transitionContext,maxSemanticAttempts:99}});assert.equal(malformed.result.status,'escalate');assert.equal(malformed.calls.length,0);
});

test('partition and global critic transition vocabulary is produced by the shared owner and hash-bound',async()=>{
 const a=await api(),p=await imp('skills/security-audit/critic-partitions.mjs');
 const values=[{coverage_id:'live',status:'covered'},{coverage_id:'held',status:'deferred'}];
 const input={identity:{runId:'transitions',sourceRef:{commit:'a'.repeat(40),tree:'b'.repeat(40)},kind:'post-wave',wave:1,profile:'standard'},shared:{architecture_md:'ordinary architecture',parts:{criticSection:'ordinary methodology'},execution:{capability:'none',blockers:['source only']},tree:'/inert/tree'},items:values.map((value,i)=>({itemId:'u'+i,kind:'unit',owners:['u'+i],value}))};
 const measureScript=x=>{const source=readFileSync(resolve(ROOT,base+'workflows/security-audit-flow.js'),'utf8');return Buffer.byteLength(source.replace('const INJECTED_INPUT = null','const INJECTED_INPUT = JSON.parse('+JSON.stringify(JSON.stringify(x))+')'));};
 const m=p.planCriticBatch(input,{measureScript});for(const part of m.partitions){assert.deepEqual(part.input.transitionContext,a.criticTransitionContext(part.input.ledger));assert.equal(part.scriptBytes,measureScript(part.input));}
 const results=m.partitions.map(part=>({batchId:m.batchId,partId:part.partId,inputDigest:part.inputDigest,critic:critic([]),summary:{text:'ordinary summary',itemIds:part.itemIds}}));
 const global=p.planCriticReconciliation({manifest:m,results},{measureScript});assert.equal(global.complete,true);assert.deepEqual(global.plan.input.transitionContext,a.criticTransitionContext(values));assert.equal(global.plan.scriptBytes,measureScript(global.plan.input));
 const forged=structuredClone(global.plan);forged.input.transitionContext.reassignableIds.push('held');assert.throws(()=>p.acceptCriticReconciliation({manifest:m,results,plan:forged,result:{batchId:m.batchId,inputDigest:global.plan.inputDigest,critic:critic([])}}),e=>e.code==='INVALID_PARTITION_RESULT');
 const changed=structuredClone(input);changed.items[0].value.status='deferred';const other=p.planCriticBatch(changed,{measureScript});assert.notEqual(other.batchId,m.batchId);assert.notEqual(other.partitions[0].inputDigest,m.partitions[0].inputDigest);
});
