import {observations,validate} from './p2-observation-support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const temp=()=>mkdtempSync(join(tmpdir(),'p2-managed-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const load=async()=>({...(await import(pathToFileURL(join(ROOT,'core/skills/decisions/queue.mjs')))),fixture:await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')))});
function decision(repo,revision,patch={}){return {schemaVersion:1,id:'choice',runId:'managed-a',repo,revision,question:'Which color should the fixture use?',reason:'Need one user choice',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}],recommendation:null,evidence:[],kind:'question',scope:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:null,...patch};}
function configure(repo,store,patch={}){
 const file=join(repo,'autobuild.json'),cfg=JSON.parse(readFileSync(file,'utf8'));
 cfg.backend='codex';cfg.codex={sessionTimeoutMinutes:1};cfg.decisions={store,featureId:'F-1',runId:'managed-a',ids:['choice'],timeoutMs:5000,...patch};
 writeFileSync(file,JSON.stringify(cfg,null,2));git(repo,'add','autobuild.json');git(repo,'commit','-qm','decision gate fixture');return git(repo,'rev-parse','HEAD');
}
function launch(repo,fixture,{steps=[{build:'F-1'}],checkAck=false,store,env={}}={}){
 const script=join(repo,'.harness-script.json');writeFileSync(script,JSON.stringify(steps));
 let fake=join(fixture.KIT,'test-fixtures/fake-codex.mjs');
 if(checkAck){
  const wrapper=script+'.provider.mjs';writeFileSync(wrapper,`#!/usr/bin/env node\nimport assert from 'node:assert/strict';\nimport {createDecisionQueue} from ${JSON.stringify(pathToFileURL(join(ROOT,'core/skills/decisions/queue.mjs')).href)};\nconst q=createDecisionQueue(${JSON.stringify(store)});assert.equal(q.read('choice').state,'acknowledged','receipt must be acknowledged before provider launch');q.close();\nawait import(${JSON.stringify(pathToFileURL(fake).href)});\n`);chmodSync(wrapper,0o755);fake=wrapper;
 }
 const child=spawn(process.execPath,[fixture.CLI,'run'],{cwd:repo,env:{...fixture.loopEnv(script),AUTOBUILD_BACKEND:'codex',AUTOBUILD_CODEX_BIN:fake,...env},detached:true,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,out}));});
 return {child,done,output:()=>out,calls:()=>existsSync(script+'.calls')?readFileSync(script+'.calls','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],stop(){if(child.exitCode!==null || child.signalCode!==null)return;try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}};
}
function correlations(output){return observations(output).filter(e=>['waiting','received'].includes(e.event));}
function assertCorrelation(value,{repo,revision,event,invocationRunId}){assert.ok(value,'missing structured correlation');const keys=['schemaVersion','event','repo','decisionRunId','invocationRunId','featureId','decisionId','revision'];assert.deepEqual(Object.fromEntries(keys.map(k=>[k,value[k]])),{schemaVersion:2,event,repo,decisionRunId:'managed-a',invocationRunId,featureId:'F-1',decisionId:'choice',revision});}
async function bounded(p,ms=12000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('managed loop exceeded acceptance deadline')),ms))]);}finally{clearTimeout(timer);}}
async function finish(proc){if(!proc)return;proc.stop();await bounded(proc.done,2000).catch(()=>{});}
async function waitUntil(predicate,ms=1500){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await delay(15);}assert.fail('expected observable state before deadline');}

test('actual opt-in autobuild waits without provider, isolates projects, and acknowledges before delivering untrusted answer',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1']),other=fixture.project(['F-1']);let q,waiting,independent;
 try{
  const store=join(root,'queue'),revision=configure(repo,store);q=createDecisionQueue(store);q.request(decision(repo,revision));
  waiting=launch(repo,fixture,{checkAck:true,store});independent=launch(other,fixture);
  await waitUntil(()=>/wait/i.test(waiting.output()),3000);assert.equal(waiting.calls().length,0,'waiting must not launch or hold a provider');assert.equal(q.read('choice').state,'pending');
  const otherResult=await bounded(independent.done);assert.equal(otherResult.code,0,otherResult.out);assert.equal(independent.calls().length,1);assert.equal(waiting.calls().length,0,'another project completing must not release waiter');
  q.answer('choice',{answerId:'answer-a',value:'blue',actor:'fixture-user',at:new Date().toISOString(),revision});
  const result=await bounded(waiting.done);assert.equal(result.code,0,result.out);assert.equal(waiting.calls().length,1);assert.equal(q.read('choice').state,'acknowledged');
  const input=waiting.calls()[0].input;assert.ok(input.includes('blue'),'chosen answer missing from builder input');assert.match(input,/untrusted/i,'decision context must be explicitly labeled untrusted');
  assert.match(result.out,/wait/i,'host must publish waiting evidence');assert.match(result.out,/answer|decision.*receiv/i,'host must publish receipt evidence');
  assert.ok(JSON.parse(readFileSync(join(repo,'features.json'),'utf8')).features[0].passes);
 }finally{await finish(waiting);await finish(independent);q?.close();for(const p of [root,repo,other])rmSync(p,{recursive:true,force:true});}
});

test('restart reuses delivery identity and committed feature checkpoint prevents a second provider launch',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1']);let q,first,second;
 try{
  const store=join(root,'queue'),revision=configure(repo,store);q=createDecisionQueue(store);q.request(decision(repo,revision));q.answer('choice',{answerId:'answer-a',value:'green',actor:'fixture-user',at:new Date().toISOString(),revision});
  first=launch(repo,fixture,{checkAck:true,store});const completed=await bounded(first.done);assert.equal(completed.code,0,completed.out);const original=q.read('choice');assert.equal(original.state,'acknowledged');assert.equal(first.calls().length,1);
  second=launch(repo,fixture,{steps:[]});const resumed=await bounded(second.done);assert.equal(resumed.code,0,resumed.out);assert.equal(second.calls().length,1,'existing provider log must not acquire a second call after feature commit');assert.deepEqual(q.read('choice'),original,'restart must not redeliver or mutate acknowledged receipt');
 }finally{await finish(first);await finish(second);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});

test('stale, cancelled, expired, wrong-run and approval requests stop before a provider starts',async()=>{
 const {createDecisionQueue,fixture}=await load();
 for(const mode of ['stale','cancelled','expired','wrong-run','wrong-project','approval']){
  const root=temp(),repo=fixture.project(['F-1']),other=temp();let q,proc;
  try{
   const store=join(root,'queue'),revision=configure(repo,store,{timeoutMs:150});q=createDecisionQueue(store);
   const patch=mode==='wrong-run'?{runId:'another-run'}:mode==='wrong-project'?{repo:other}:mode==='stale'?{revision:'f'.repeat(40)}:mode==='expired'?{expiresAt:'2026-01-01T00:01:00Z'}:mode==='approval'?{kind:'approval',scope:{action:'deploy',resource:'fixture-staging',revision},options:[{id:'approve',label:'Approve'},{id:'reject',label:'Reject'}]}:{};
   const item=decision(repo,revision,patch);q.request(item);
   if(mode==='cancelled')q.cancel('choice',{reason:'cancelled by fixture'});
   else if(mode!=='expired')q.answer('choice',{answerId:'answer-a',value:mode==='approval'?'approve':'blue',actor:'fixture-user',at:new Date().toISOString(),revision:item.revision});
   proc=launch(repo,fixture);const result=await bounded(proc.done);assert.notEqual(result.code,0,mode+': '+result.out);assert.equal(proc.calls().length,0,mode+' launched provider');assert.equal(JSON.parse(readFileSync(join(repo,'features.json'),'utf8')).features[0].passes,false);
   assert.notEqual(q.read('choice').state,'acknowledged',mode+' was improperly acknowledged');
  }finally{await finish(proc);q?.close();for(const p of [root,repo,other])rmSync(p,{recursive:true,force:true});}
 }
});

test('pending decision timeout stops before a provider and can be resumed after an answer',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1']);let q,first,second;
 try{
  const store=join(root,'queue'),runs=join(root,'runs'),revision=configure(repo,store,{timeoutMs:100});q=createDecisionQueue(store);q.request(decision(repo,revision));
  first=launch(repo,fixture,{env:{PANDASTACK_RUNS_DIR:runs}});const timedOut=await bounded(first.done);assert.notEqual(timedOut.code,0,timedOut.out);assert.equal(first.calls().length,0);assert.equal(q.read('choice').state,'pending');assert.equal(git(repo,'rev-parse','HEAD'),revision);
  q.answer('choice',{answerId:'answer-a',value:'blue',actor:'fixture-user',at:new Date().toISOString(),revision});second=launch(repo,fixture,{checkAck:true,store,env:{PANDASTACK_RUNS_DIR:runs}});const resumed=await bounded(second.done);assert.equal(resumed.code,0,resumed.out);assert.equal(second.calls().length,1);assert.equal(q.read('choice').state,'acknowledged');
  const failed=observations(timedOut.out).filter(e=>e.event==='wait_failed');assert.equal(failed.length,1);assert.equal(failed[0].outcome,'timeout');assert.ok(failed[0].waitDurationMs>=80);
  const before=correlations(timedOut.out),after=correlations(resumed.out);assert.equal(before.length,1);assert.equal(after.length,2);
  for(const event of [...before,...after,...failed])assert.equal(event.queueNamespace,q.readNamespace());assert.notEqual(before[0].traceId,after[0].traceId);assert.equal(before[0].spanId,failed[0].spanId);assert.equal(after[0].spanId,after[1].spanId);assert.equal(after[0].traceId,after[1].traceId);assert.notEqual(after[0].eventId,after[1].eventId);assert.equal(after[1].answerId,'answer-a');
  assert.ok(before[0].invocationRunId);assert.ok(after[0].invocationRunId);assert.notEqual(before[0].invocationRunId,after[0].invocationRunId);assert.notEqual(before[0].invocationRunId,'managed-a');assert.notEqual(after[0].invocationRunId,'managed-a');
  assertCorrelation(before[0],{repo,revision,event:'waiting',invocationRunId:before[0].invocationRunId});assertCorrelation(after[0],{repo,revision,event:'waiting',invocationRunId:after[0].invocationRunId});assertCorrelation(after[1],{repo,revision,event:'received',invocationRunId:after[0].invocationRunId});
  assert.equal(before[0].deliveryId,after[0].deliveryId);assert.equal(after[0].deliveryId,after[1].deliveryId);assert.equal(q.read('choice').delivery.deliveryId,after[1].deliveryId);
  const {createRunStore}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/store.mjs'))),tracking=createRunStore(runs);
  for(const item of [before[0],after[0]]){const run=tracking.readRun(item.invocationRunId);assert.ok(run);assert.equal(run.workflow,'autobuild');assert.equal(run.repo,repo);assert.equal(run.revision,revision);assert.equal(run.parentRunId,null);}
  const children=tracking.listRuns({parentRunId:after[0].invocationRunId});assert.equal(children.length,1);assert.equal(children[0].workflow,'session');assert.notEqual(children[0].id,after[0].invocationRunId);assert.notEqual(children[0].id,'managed-a');assert.equal(tracking.listRuns({parentRunId:before[0].invocationRunId}).length,0);

 }finally{await finish(first);await finish(second);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});


test('a decision is scoped to one feature and its old revision/context do not leak into later builders',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1','F-2']);let q,proc;
 try{
  const store=join(root,'queue'),revision=configure(repo,store);q=createDecisionQueue(store);
  const selected='decision-sentinel';q.request(decision(repo,revision,{question:'PHASE2_FEATURE_ONLY_QUESTION',options:[{id:selected,label:'Selected choice'},{id:'other',label:'Other choice'}]}));
  q.answer('choice',{answerId:'answer-a',value:selected,actor:'fixture-user',at:new Date().toISOString(),revision});
  proc=launch(repo,fixture,{steps:[{build:'F-1'},{build:'F-2'}],checkAck:true,store});const result=await bounded(proc.done);assert.equal(result.code,0,result.out);
  const calls=proc.calls();assert.equal(calls.length,2);assert.ok(calls[0].input.includes(selected),'target feature must receive its answer');
  assert.ok(!calls[1].input.includes(selected),'answer from F-1 must not be reused for F-2');assert.ok(!calls[1].input.includes('PHASE2_FEATURE_ONLY_QUESTION'),'targeted question must not be reused for F-2');
  assert.ok(JSON.parse(readFileSync(join(repo,'features.json'),'utf8')).features.every(f=>f.passes));assert.notEqual(git(repo,'rev-parse','HEAD'),revision);
  assert.equal(q.read('choice').state,'acknowledged');assert.equal(q.read('choice').delivery.revision,revision,'original receipt must remain tied to its original revision');
 }finally{await finish(proc);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});

test('a controlled HEAD change during waiting rejects the old answer before acknowledgment or provider launch',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1']);let q,proc;
 try{
  const store=join(root,'queue'),revision=configure(repo,store);q=createDecisionQueue(store);q.request(decision(repo,revision));
  proc=launch(repo,fixture);await waitUntil(()=>/wait/i.test(proc.output()),3000);assert.equal(proc.calls().length,0);
  writeFileSync(join(repo,'revision-change.txt'),'ordinary independent revision change\n');git(repo,'add','revision-change.txt');git(repo,'commit','-qm','change revision while waiting');assert.notEqual(git(repo,'rev-parse','HEAD'),revision);
  q.answer('choice',{answerId:'answer-a',value:'blue',actor:'fixture-user',at:new Date().toISOString(),revision});
  const result=await bounded(proc.done);assert.notEqual(result.code,0,result.out);assert.match(result.out,/STALE/i,'changed revision must be diagnosed as stale');assert.equal(proc.calls().length,0);assert.equal(q.read('choice').ack,null);assert.notEqual(q.read('choice').state,'acknowledged');
  assert.equal(JSON.parse(readFileSync(join(repo,'features.json'),'utf8')).features[0].passes,false);
 }finally{await finish(proc);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});

test('a missing or unknown configured decision feature is rejected before waiting or provider launch',async()=>{
 const {createDecisionQueue,fixture}=await load();
 for(const featureId of [undefined,'NONEXISTENT_FEATURE']){
 const root=temp(),repo=fixture.project(['F-1']);let q,proc;
 try{
  const store=join(root,'queue'),revision=configure(repo,store,{featureId,timeoutMs:5000});q=createDecisionQueue(store);q.request(decision(repo,revision));
  proc=launch(repo,fixture);const result=await bounded(proc.done,3000);assert.notEqual(result.code,0,result.out);assert.match(result.out,/feature/i,'invalid feature configuration should be explained');assert.equal(proc.calls().length,0);assert.equal(q.read('choice').state,'pending');assert.equal(q.read('choice').delivery,null);
 }finally{await finish(proc);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
 }
});

test('unavailable observational tracking emits null invocation identity while decision routing still succeeds',async()=>{
 const {createDecisionQueue,fixture}=await load();const root=temp(),repo=fixture.project(['F-1']);let q,proc;
 try{
  const store=join(root,'queue'),unavailable=join(root,'not-a-directory'),revision=configure(repo,store);writeFileSync(unavailable,'owned fixture blocks tracking directory creation');q=createDecisionQueue(store);q.request(decision(repo,revision));
  q.answer('choice',{answerId:'answer-a',value:'blue',actor:'fixture-user',at:new Date().toISOString(),revision});proc=launch(repo,fixture,{checkAck:true,store,env:{PANDASTACK_RUNS_DIR:unavailable}});
  const result=await bounded(proc.done);assert.equal(result.code,0,result.out);assert.equal(proc.calls().length,1);assert.equal(q.read('choice').state,'acknowledged');assert.match(result.out,/run tracking unavailable/i);
  const events=correlations(result.out);assert.equal(events.length,2);assertCorrelation(events[0],{repo,revision,event:'waiting',invocationRunId:null});assertCorrelation(events[1],{repo,revision,event:'received',invocationRunId:null});assert.equal(events[0].deliveryId,events[1].deliveryId);assert.equal(events[1].deliveryId,q.read('choice').delivery.deliveryId);
 }finally{await finish(proc);q?.close();for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});

test('host gate durations use monotonic elapsed time despite wall clock rollback and terminal replay is detached',async()=>{
 const {createDecisionTrace}=await import(pathToFileURL(join(ROOT,'core/skills/decisions/observations.mjs')));let mono=10,wall='2026-11-10T12:00:00.000Z';const emitted=[];
 const trace=createDecisionTrace({repo:'/project/one',revision:'a'.repeat(40),invocationRunId:'outer-1',emit:e=>emitted.push(structuredClone(e)),now:()=>wall,monotonicNow:()=>mono});
 const input={queueNamespace:'queue-1',decisionRunId:'logical-1',featureId:'F-1',decisionId:'choice',revision:'b'.repeat(40),deliveryId:'delivery-1'},copy=structuredClone(input);
 const started=trace.startWait(input);validate(started);assert.deepEqual(input,copy);mono=135.9;wall='2026-11-10T11:59:00.000Z';const done=trace.finishWait(started.spanId,{answerId:'answer-1'});validate(done);assert.equal(done.waitDurationMs,125);assert.equal(done.revision,input.revision);assert.equal(done.spanId,started.spanId);assert.equal(done.traceId,started.traceId);
 const replay=trace.finishWait(started.spanId,{answerId:'answer-1'});assert.deepEqual(replay,done);assert.equal(emitted.length,2);try{replay.answerId='changed'}catch{};assert.equal(trace.finishWait(started.spanId,{answerId:'answer-1'}).answerId,'answer-1');
 assert.throws(()=>trace.failWait(started.spanId,{outcome:'timeout'}),e=>e.code==='INVALID_OBSERVATION');
});

test('invalid observations stay generic and failed gates report their own monotonic span',async()=>{
 const {createDecisionTrace}=await import(pathToFileURL(join(ROOT,'core/skills/decisions/observations.mjs')));const errors=e=>e.code==='INVALID_OBSERVATION'&&!/SECRET/.test(e.message);let mono=1;const events=[];
 const trace=createDecisionTrace({repo:'/project/one',revision:'a'.repeat(40),invocationRunId:null,emit:e=>events.push(structuredClone(e)),now:()=>'2026-11-10T12:00:00.000Z',monotonicNow:()=>mono});
 const input={queueNamespace:'queue-1',decisionRunId:'logical-1',featureId:'F-1',decisionId:'choice',revision:'a'.repeat(40),deliveryId:'delivery-1'};
 assert.throws(()=>trace.startWait({...input,SECRET:'SECRET'}),errors);assert.equal(events.length,0);
 const a=trace.startWait(input);mono=18;const b=trace.startWait({...input,decisionId:'choice-2',deliveryId:'delivery-2'});mono=30;
 const failed=trace.failWait(a.spanId,{outcome:'cancelled'});validate(failed);assert.equal(failed.waitDurationMs,29);assert.equal(failed.invocationRunId,null);assert.equal(failed.outcome,'cancelled');
 const received=trace.finishWait(b.spanId,{answerId:'answer-2'});validate(received);assert.equal(received.waitDurationMs,12);assert.notEqual(a.spanId,b.spanId);
 assert.throws(()=>trace.finishWait('SECRET',{answerId:'answer-2'}),errors);assert.throws(()=>trace.failWait(a.spanId,{outcome:'SECRET'}),errors);
 const c=trace.startWait({...input,decisionId:'choice-3'});mono=0;assert.throws(()=>trace.finishWait(c.spanId,{answerId:'answer-3'}),errors);assert.equal(events.filter(e=>e.event==='received').length,1,'invalid clock cannot fabricate a terminal duration');
});

test('loadConfig and default doctor validate decisions without opening a queue or executing a provider',async()=>{
 const {fixture}=await load();const root=temp(),repo=fixture.project(['F-1']);
 try{
  const store=join(root,'unopened-queue'),sentinel=join(root,'provider-executed'),binary=join(root,'provider.mjs');
  writeFileSync(binary,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync('+JSON.stringify(sentinel)+',"unexpected provider execution");\n');chmodSync(binary,0o755);
  const revision=configure(repo,store),before=git(repo,'status','--porcelain');assert.equal(before,'');assert.equal(existsSync(store),false);
  const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));
  const {inspectDoctor}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')));
  for(const backend of ['claude','codex']){
   const env={...process.env,AUTOBUILD_BACKEND:backend,AUTOBUILD_CODEX_BIN:binary,AUTOBUILD_CLAUDE_BIN:binary};
   const loaded=loadConfig(repo,env);assert.equal(loaded.decisions.store,store);assert.equal(loaded.decisions.runId,'managed-a');assert.equal(loaded.decisions.featureId,'F-1');assert.deepEqual(loaded.decisions.ids,['choice']);
   assert.equal(existsSync(store),false,'pure config validation must not initialize or inspect queue storage');
   const report=await inspectDoctor({repo,backend,pandaRoot:ROOT,env});
   assert.equal(report.checks.find(c=>c.id==='configuration')?.status,'pass');assert.equal(report.checks.find(c=>c.id==='binary')?.status,'pass');assert.equal(report.status,'degraded');
   for(const value of Object.values(report.runtime.controls))assert.equal(value.status,'unknown');
   assert.equal(existsSync(sentinel),false,'doctor must only check executable presence');assert.equal(existsSync(store),false,'doctor must not create/open the decision queue');
  }
  assert.equal(git(repo,'rev-parse','HEAD'),revision);assert.equal(git(repo,'status','--porcelain'),before);assert.equal(existsSync(join(repo,'.harness')),false);
 }finally{for(const p of [root,repo])rmSync(p,{recursive:true,force:true});}
});
