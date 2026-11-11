// Proposed pure acceptance only; do not execute before independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const load=()=>import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/critic-partitions.mjs')));
function measureScript(input){
 const source=readFileSync(resolve(ROOT,'graphs/security-audit/workflows/security-audit-flow.js'),'utf8');
 const seam='const INJECTED_INPUT = null';assert.equal(source.split(seam).length,2);
 return Buffer.byteLength(source.replace(seam,'const INJECTED_INPUT = JSON.parse('+JSON.stringify(JSON.stringify(input))+')'));
}
const critic=(extra={})=>({missing_units:[],reassign_ids:[],resolved_prior_leads:[],stop:true,...extra});
function fixture(){
 const items=Array.from({length:122},(_,i)=>({itemId:'u'+i,kind:'unit',owners:['u'+i],value:{coverage_id:'U'+i,status:'blocked',local_checks:[{method:'source',result:'tail-'+i+' '+('ordinary full evidence '.repeat(220)),paths:['src/a.js']}],attempts:[{unresolved:['retained history '+i]}]}}));
 return {identity:{runId:'pure',sourceRef:{commit:'a'.repeat(40),tree:'b'.repeat(40)},kind:'post-wave',wave:1,profile:'standard'},shared:{architecture_md:'ordinary architecture',parts:{criticSection:'ordinary methodology'},execution:{capability:'none',blockers:['source only']},tree:'/inert/tree'},items};
}
const opts={measureScript};
async function graph(input,answer,checkPrompt){
 const h=await import(pathToFileURL(resolve(ROOT,'scripts/workflow-harness.mjs')));
 const {fn}=h.load(resolve(ROOT,'graphs/security-audit/workflows/security-audit-flow.js'));
 const out=await h.run(fn,{'audit-researcher':[(prompt)=>{checkPrompt(prompt);return answer;}]},input);
 assert.equal(out.result.status,'done');assert.equal(out.calls.length,1);assert.deepEqual(out.result.results.critic,answer);return out;
}
const rows=m=>m.partitions.map(p=>({batchId:m.batchId,partId:p.partId,inputDigest:p.inputDigest,critic:critic(),summary:{text:'summary only, not raw evidence',itemIds:p.itemIds}}));
test('122 full evidence units exceed old bound and partition without losing any bytes',async()=>{
 const api=await load(),f=fixture(),before=structuredClone(f);assert.ok(measureScript(f)>505230);
 const m=api.planCriticBatch(f,opts);assert.ok(m.partitions.length>1);assert.deepEqual(f,before);
 assert.deepEqual(m,api.planCriticBatch(f,opts));
 for(const part of m.partitions){assert.equal(part.scriptBytes,measureScript(part.input));assert.ok(part.scriptBytes<=500000);assert.equal(part.input.critic_context.index.length,122);}
 for(const part of m.partitions)await graph(part.input,critic(),prompt=>{assert.ok(prompt.includes('untrusted-critic-context'));assert.ok(!prompt.includes('cut any text over 300'));for(const u of part.input.ledger)assert.ok(prompt.includes(u.local_checks[0].result));});
 for(const item of f.items){const owned=m.partitions.flatMap(p=>p.input.ledger).filter(x=>x.coverage_id===item.value.coverage_id);assert.ok(owned.length);for(const x of owned)assert.deepEqual(x,item.value);}
});
test('linked candidate details appear with every owning unit and hashes bind changes',async()=>{
 const api=await load(),f=fixture();f.items.push({itemId:'c1',kind:'candidate',owners:['u0','u121'],value:{fingerprint:'fp',units:['U0','U121'],evidence:{full:'unchanged candidate detail'}}});
 const m=api.planCriticBatch(f,opts);for(const owner of ['u0','u121']){const part=m.partitions.find(p=>p.itemIds.includes(owner));assert.ok(part.itemIds.includes('c1'));assert.deepEqual(part.input.candidates.find(x=>x.fingerprint==='fp'),f.items.at(-1).value);}
 f.items.at(-1).value.evidence.full='different';assert.notEqual(api.planCriticBatch(f,opts).batchId,m.batchId);
});
test('missing part cannot authorize global reconciliation; stale and duplicate parts refuse',async()=>{
 const api=await load(),m=api.planCriticBatch(fixture(),opts),r=rows(m);
 const partial=api.planCriticReconciliation({manifest:m,results:r.slice(1)},opts);assert.equal(partial.complete,false);assert.equal(partial.plan,null);assert.deepEqual(partial.missingPartIds,[r[0].partId]);
 for(const bad of [[...r,r[0]],r.map((x,i)=>i?x:{...x,inputDigest:'0'.repeat(64)})])assert.throws(()=>api.planCriticReconciliation({manifest:m,results:bad},opts),e=>e.code==='INVALID_PARTITION_RESULT');
});
test('global barrier cannot be replaced by deterministic part union or erase work',async()=>{
 const api=await load(),m=api.planCriticBatch(fixture(),opts),r=rows(m);r[0].critic=critic({reassign_ids:['U0'],stop:false});
 const rec=api.planCriticReconciliation({manifest:m,results:r},opts);assert.equal(rec.complete,true);assert.ok(rec.plan.scriptBytes<=500000);assert.equal(rec.plan.scriptBytes,measureScript(rec.plan.input));
 assert.deepEqual(api.acceptCriticReconciliation({manifest:m,results:r,plan:rec.plan,result:null}),{complete:false,critic:null});
 await graph(rec.plan.input,critic(),prompt=>{assert.match(prompt,/global semantic reconciliation/i);assert.ok(prompt.includes('U0'));assert.ok(prompt.includes('reassign_ids'));assert.ok(prompt.includes('summary only, not raw evidence'));});
 const out=api.acceptCriticReconciliation({manifest:m,results:r,plan:rec.plan,result:{batchId:m.batchId,inputDigest:rec.plan.inputDigest,critic:critic()}});assert.equal(out.complete,true);assert.equal(out.critic.stop,false);assert.deepEqual(out.critic.reassign_ids,['U0']);
 const changed=structuredClone(r);changed[0].summary.text='changed';assert.throws(()=>api.acceptCriticReconciliation({manifest:m,results:changed,plan:rec.plan,result:{batchId:m.batchId,inputDigest:rec.plan.inputDigest,critic:critic()}}),e=>e.code==='INVALID_PARTITION_RESULT');
});
test('indivisible shared input refuses rather than raising cap or clipping',async()=>{
 const api=await load(),f=fixture();f.shared.architecture_md='architecture '.repeat(60000);const before=structuredClone(f);
 assert.throws(()=>api.planCriticBatch(f,opts),e=>e.code==='STAGE_INPUT_TOO_LARGE');assert.deepEqual(f,before);
});
