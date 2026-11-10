import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const load=async()=>({...(await import(pathToFileURL(join(ROOT,'core/skills/decisions/queue.mjs')))),...(await import(pathToFileURL(join(ROOT,'core/skills/decisions/routing.mjs'))))});
const temp=()=>mkdtempSync(join(tmpdir(),'p2-routing-'));
const revision='a'.repeat(40);
const request=(repo,id='question',runId='run-a')=>({schemaVersion:1,id,runId,repo,revision,question:'Choose a color',reason:'Fixture needs one choice',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}],recommendation:null,evidence:[],kind:'question',scope:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:null});
const recipient=(repo,runId='run-a')=>({repo,runId,revision,deliveryId:'delivery-a'});
const answer=(value='blue')=>({answerId:'answer-a',value,actor:'test-user',at:'2026-01-01T00:00:01Z',revision});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function command(...args){return spawnSync(process.execPath,[join(ROOT,'scripts/pandastack.mjs'),'decision',...args],{encoding:'utf8',timeout:5000});}
function processRun(args){
 const child=spawn(process.execPath,[join(ROOT,'scripts/pandastack.mjs'),'decision',...args],{stdio:['ignore','pipe','pipe'],detached:true});let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,out,err}));});
 return {child,done,stop:()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}};
}
async function bounded(p,ms=6000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('child exceeded deadline')),ms))]);}finally{clearTimeout(timer);}}

test('routing waits only for its recipient, delivers durably, and leaves acknowledgment explicit',async()=>{
 const {createDecisionQueue,waitForDecision}=await load();const root=temp(),repo=temp();let q,waiting;const controller=new AbortController();
 try{
  q=createDecisionQueue(join(root,'queue'));q.request(request(repo));q.request(request(repo,'other','run-b'));
  let settled=false;waiting=waitForDecision({queue:q,id:'question',recipient:recipient(repo),pollMs:10,timeoutMs:1000,signal:controller.signal}).then(v=>{settled=true;return v;});
  await delay(50);assert.equal(settled,false);q.answer('other',answer());await delay(50);assert.equal(settled,false,'another run answer must not release this waiter');
  q.answer('question',answer());const delivered=await bounded(waiting);assert.equal(delivered.state,'delivered');assert.equal(delivered.answer.value,'blue');assert.equal(q.read('question').ack,null);
  q.close();q=createDecisionQueue(join(root,'queue'));
  const replay=await waitForDecision({queue:q,id:'question',recipient:recipient(repo),pollMs:10,timeoutMs:200});assert.deepEqual(replay,delivered);
  assert.deepEqual(q.acknowledge('question',recipient(repo)),{created:true});assert.deepEqual(q.acknowledge('question',recipient(repo)),{created:false});
  assert.equal(q.read('other').state,'answered');assert.equal(q.read('other').delivery,null);
 }finally{controller.abort();await waiting?.catch(()=>{});q?.close();rmSync(root,{recursive:true,force:true});rmSync(repo,{recursive:true,force:true});}
});

test('routing fails closed on timeout, abort, wrong recipient, stale revision and storage failure',async()=>{
 const {createDecisionQueue,waitForDecision}=await load();const root=temp(),repo=temp();let q;
 try{
  q=createDecisionQueue(root);q.request(request(repo));const opts={queue:q,id:'question',recipient:recipient(repo),pollMs:10,timeoutMs:50};
  await assert.rejects(waitForDecision(opts),e=>e.code==='TIMEOUT');assert.equal(q.read('question').state,'pending');
  const controller=new AbortController();const waiting=waitForDecision({...opts,timeoutMs:1000,signal:controller.signal});controller.abort();await assert.rejects(waiting,e=>e.code==='CANCELLED');
  q.answer('question',answer());
  await assert.rejects(waitForDecision({...opts,recipient:{...recipient(repo),runId:'run-b'}}),e=>e.code==='WRONG_RECIPIENT');
  await assert.rejects(waitForDecision({...opts,recipient:{...recipient(repo),revision:'b'.repeat(40)}}),e=>e.code==='STALE');
  const failure=Object.assign(Error('safe I/O error'),{code:'IO_ERROR'});
  await assert.rejects(waitForDecision({...opts,queue:new Proxy(q,{get(target,key){if(typeof target[key]==='function'&&key!=='close')return()=>{throw failure;};return target[key];}})}),e=>e.code==='IO_ERROR');
  assert.equal(q.read('question').state,'answered');
 }finally{q?.close();rmSync(root,{recursive:true,force:true});rmSync(repo,{recursive:true,force:true});}
});

test('CLI request, answer, wait, ack and replay share durable state across real processes',async()=>{
 const {createDecisionQueue}=await load();const root=temp(),repo=temp();let q,proc;
 try{
  const store=join(root,'queue'),file=join(root,'request.json'),who=join(root,'recipient.json'),reply=join(root,'answer.json');
  writeFileSync(file,JSON.stringify(request(repo)));writeFileSync(who,JSON.stringify(recipient(repo)));writeFileSync(reply,JSON.stringify(answer()));
  let r=command('request','--store',store,'--file',file);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotThrow(()=>JSON.parse(r.stdout));
  r=command('list','--store',store,'--repo',repo,'--run-id','run-a');assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.includes('question'));
  proc=processRun(['wait','--store',store,'--id','question','--file',who,'--timeout-ms','3000']);await delay(100);assert.equal(proc.child.exitCode,null);
  r=command('answer','--store',store,'--id','question','--file',reply);assert.equal(r.status,0,r.stdout+r.stderr);
  const waited=await bounded(proc.done);assert.equal(waited.code,0,waited.out+waited.err);assert.equal(JSON.parse(waited.out).state,'delivered');
  q=createDecisionQueue(store);assert.equal(q.read('question').state,'delivered');assert.equal(q.read('question').ack,null);
  r=command('ack','--store',store,'--id','question','--file',who);assert.equal(r.status,0,r.stderr);assert.equal(q.read('question').state,'acknowledged');
  r=command('wait','--store',store,'--id','question','--file',who,'--timeout-ms','100');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,'acknowledged');
  r=command('show','--store',store,'--id','question');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision.id,'question');
  q.request(request(repo,'cancel-me'));r=command('cancel','--store',store,'--id','cancel-me','--reason','No longer needed');assert.equal(r.status,0,r.stderr);assert.equal(q.read('cancel-me').state,'cancelled');
 }finally{proc?.stop();if(proc)await bounded(proc.done).catch(()=>{});q?.close();rmSync(root,{recursive:true,force:true});rmSync(repo,{recursive:true,force:true});}
});

test('CLI rejects ambiguous flags and treats input text as inert data',async()=>{
 await load();const root=temp(),repo=temp();
 try{
  const store=join(root,'queue'),file=join(root,'request.json'),who=join(root,'recipient.json'),marker=join(root,'should-not-exist');
  writeFileSync(file,JSON.stringify({...request(repo),question:'Do not execute $(touch '+marker+') or `touch '+marker+'`'}));writeFileSync(who,JSON.stringify(recipient(repo)));
  assert.equal(command('request','--store',store,'--file',file).status,0);assert.equal(existsSync(marker),false);
  for(const args of [
   ['list','--store',store,'--store',store],['list','--store',store,'--unknown','value'],
   ['wait','--store',store,'--id','question','--file',who,'--timeout-ms','NaN'],
   ['wait','--store',store,'--id','question','--file',who,'--timeout-ms','-1'],
   ['wait','--store',store,'--id','question','--file',who,'--timeout-ms','1.5'],
  ]){const r=command(...args);assert.notEqual(r.status,0,JSON.stringify(args));assert.ok(r.stderr.trim(),'errors must go to stderr');}
  const bad=join(root,'bad.json');writeFileSync(bad,'{"secret":"SENSITIVE_SENTINEL"');const r=command('request','--store',store,'--file',bad);assert.notEqual(r.status,0);assert.ok(!r.stderr.includes('SENSITIVE_SENTINEL'));assert.ok(!r.stderr.includes('at JSON.parse')); // allow-secret: synthetic malformed-input sentinel; verifies diagnostic redaction
 }finally{rmSync(root,{recursive:true,force:true});rmSync(repo,{recursive:true,force:true});}
});
