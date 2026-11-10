import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
export const PATHS={'blueprint-design':'graphs/blueprint/workflows/blueprint-design.js','bughunt-flow':'graphs/hunt/workflows/bughunt-flow.js','dev-build':'graphs/dev/workflows/dev-build.js','harness-repair':'graphs/qa/workflows/harness-repair.js','release-flow':'graphs/release/workflows/release-flow.js','security-audit-flow':'graphs/security-audit/workflows/security-audit-flow.js'};
export const sha=s=>createHash('sha256').update(s).digest('hex');
export const load=async()=>{const runtime=await import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/runtime.mjs')));const registry=await import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/registry.mjs')));return {...runtime,...registry};};
export const pins=()=>Object.fromEntries(Object.entries(PATHS).map(([id,path])=>[id,sha(readFileSync(resolve(ROOT,path)))]));
const clone=v=>structuredClone(v);
export function checkpointPort(){
 const rows=new Map(),events=[];
 return {rows,events,
 async reserve(binding){events.push(['reserve',binding.callId]);const old=rows.get(binding.callId);if(old){assert.deepEqual(old.binding,binding);if(old.state==='completed')return {state:'completed',completion:clone(old.completion)};return {state:'uncertain'};}rows.set(binding.callId,{binding:clone(binding),state:'dispatched'});return {state:'dispatch'};},
 async settle(id,completion){events.push(['settle',id]);assert.equal(rows.get(id)?.state,'dispatched');rows.set(id,{...rows.get(id),state:'completed',completion:clone(completion)});},
 async uncertain(id,value){events.push(['uncertain',id,value.code]);assert.ok(rows.has(id));rows.get(id).state='uncertain';}
 };
}
export const pass=()=>({verdict:'PASS',verify_block:'  [0] inert fixture\nVERIFY: PASS',failures:[]});
export const review=()=>({files_reviewed:1,findings:[]});
export const plan=()=>({goal:'fixture task',acceptance:[{id:'AC1',criterion:'holds',protects:'invariant',fails_when:'wrong output',no_claim:'runtime'}],components:[{id:'C1',title:'one',files:['src/a.js'],depends_on:[],tests:['inert'],owners_used:[],owners_created:[]}],behavior_changes:[],out_of_scope:[],risks:[],questions:[]});
export const devAnswer=req=>{
 if(req.agentType==='scout')return {reuse:[],owners:[],must_preserve:[],interfaces:[],edge_cases:[],test_patterns:'fixture'};
 if(req.agentType==='implementer')return {done:true,touched:['src/a.js'],tests_added:[],test_changes:[],verify_verdict:'PASS',unchecked:[],summary:'inert'};
 if(req.agentType==='acceptance-auditor')return {criteria:[{id:'AC1',status:'MET',evidence:'inert fixture assertion'}],behavior_changes_missing:[],owners:[]};
 if(req.agentType==='checker')return pass();
 if(['reviewer','qa-auditor'].includes(req.agentType))return review();
 throw Error('unexpected fixture role');
};
export const reconArgs=()=>({stage:'recon',part:'facts',tree:'/inert/snapshot',maxParallel:4,execution:{capability:'none',blockers:['source only']},parts:{recon1a:'inert method',recon1b:'inert method',recon1c:'inert method',recon1d:'inert method'}});
export const research=req=>({agent:req.label.slice('recon-'.length),items:[{text:'ordinary fact',refs:['src/app.js:1']}],limits:[]});
export const completion=(req,value)=>({outcome:'returned',wire:{json:JSON.stringify(value)},usage:null,receipt:{...req.selection,invocationId:'fake-'+req.callId}});
export async function fixture(t,{cap=2,answer=devAnswer,checkpoints=checkpointPort(),provider,resolveLeaf,onEvent,signal,nowMs,deadlineMs}={}){
 const api=await load();const registry=api.loadWorkflowRegistry({installationRoot:ROOT,workflowHashes:pins()});const calls=[];
 const selected=resolveLeaf||(({workflowId})=>({selection:{provider:'codex',model:'fake-model',effort:'high'},profile:workflowId==='security-audit-flow'?'audit-source-only':workflowId==='release-flow'?'release-controlled':'build-workspace'}));
 const port=provider||{async runLeaf(req){calls.push(req);assert.equal(checkpoints.rows.get(req.callId)?.state,'dispatched');return completion(req,await answer(req));}};
 const runtime=api.createNativeRuntime({registry,provider:port,resolveLeaf:selected,checkpoints,maxConcurrentSubagents:cap,deadlineMs:deadlineMs??Date.now()+10000,...(signal?{signal}:{}),...(nowMs?{nowMs}:{}),...(onEvent?{onEvent}:{})});
 t.after(()=>runtime.close());return {api,registry,runtime,calls,checkpoints};
}
