import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {mod,modulePath,temp,cleanup,decision,approval,answer,recipient,NOW,code} from './support.mjs';
const target={threadId:'owned-thread-1',turnId:'owned-turn-1'};
async function modules(){return {...await mod('codex-delivery'),...await mod('queue')}};
function populate(q,value=decision(),response=answer()){q.request(value);q.answer(value.id,response)}

test('active-turn dispatch targets the explicit session and acknowledges only its validated receipt',async()=>{
 const {deliverToCodex,createDecisionQueue}=await modules();const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});populate(q);const calls=[];
  const transport=async(method,params)=>{calls.push({method,params:structuredClone(params)});assert.equal(q.read('decision-1').ack,null,'acknowledged before RPC receipt');return {turnId:target.turnId}};
  assert.deepEqual(await deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport}),{delivered:true});
  assert.equal(calls.length,1);const {method,params}=calls[0];assert.equal(method,'turn/steer');
  assert.equal(params.threadId,target.threadId);assert.equal(params.expectedTurnId,target.turnId);assert.equal(params.clientUserMessageId,recipient().deliveryId);
  assert.equal(params.input.length,1);assert.equal(params.input[0].type,'text');const text=params.input[0].text;
  assert.match(text,/untrusted/i);assert.ok(text.includes(decision().question));assert.match(text,/careful/i);
  assert.equal(q.read('decision-1').state,'acknowledged');assert.notEqual(q.read('decision-1').ack,null);
  q.close();q=createDecisionQueue(root,{now:()=>NOW});
  assert.deepEqual(await deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport}),{delivered:false});assert.equal(calls.length,1);
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target:{...target,threadId:'other-thread'},transport}),code('MANUAL_HANDOFF'));
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target:{...target,turnId:'other-turn'},transport}),code('MANUAL_HANDOFF'));
  assert.equal(calls.length,1,'target conflict resent an acknowledged answer');
 }finally{q?.close();cleanup(root)}
});

test('recipient, revision, target and approval boundaries reject before any RPC',async()=>{
 const {deliverToCodex,createDecisionQueue}=await modules();const root=temp();const q=createDecisionQueue(root,{now:()=>NOW});let calls=0;
 const transport=async()=>{calls++;return {turnId:target.turnId}};
 try{
  populate(q);
  for(const patch of [{runId:'other-run'},{repo:'/other/project'}])await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(patch),target,transport}),code('WRONG_RECIPIENT'));
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient({revision:'b'.repeat(40)}),target,transport}),code('STALE'));
  for(const bad of [null,{}, {...target,threadId:''},{...target,turnId:'x'.repeat(257)},{...target,threadId:'bad\nthread'},{...target,extra:'SECRET'}]){
   await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target:bad,transport}),code('INVALID_DECISION'));
  }
  populate(q,approval({id:'approval'}),answer({value:'approve'}));
  await assert.rejects(deliverToCodex({queue:q,id:'approval',recipient:recipient(),target,transport}),code('MANUAL_HANDOFF'));
  assert.equal(calls,0);assert.equal(q.read('decision-1').state,'answered');assert.equal(q.read('approval').ack,null);
  assert.deepEqual(await deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport}),{delivered:true});assert.equal(calls,1,'invalid routing poisoned a valid dispatch');
 }finally{q.close();cleanup(root)}
});

test('uncertain remote failure persists across reopen and never sends automatically again',async()=>{
 const {deliverToCodex,createDecisionQueue}=await modules();const root=temp();let q;let calls=0;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});populate(q);
  const transport=async()=>{calls++;throw Error('PRIVATE_RPC_SECRET_8471')};
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport}),e=>e.code==='MANUAL_HANDOFF'&&!e.message.includes('PRIVATE_RPC_SECRET_8471'));
  assert.equal(calls,1);assert.equal(q.read('decision-1').ack,null);q.close();q=createDecisionQueue(root,{now:()=>NOW});
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport}),code('MANUAL_HANDOFF'));
  assert.equal(calls,1);assert.equal(q.read('decision-1').ack,null);q.close();q=null;
  for(const relative of fs.readdirSync(root,{recursive:true})){
   const path=join(root,relative);if(fs.statSync(path).isFile())assert.equal(fs.readFileSync(path).includes(Buffer.from('PRIVATE_RPC_SECRET_8471')),false,'raw RPC failure persisted');
  }
 }finally{q?.close();cleanup(root)}
});

test('mismatched receipt never acknowledges and a later valid transport cannot retry it',async()=>{
 const {deliverToCodex,createDecisionQueue}=await modules();const root=temp();const q=createDecisionQueue(root,{now:()=>NOW});let calls=0;
 try{
  populate(q);
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport:async()=>{calls++;return {turnId:'unrelated-turn'}}}),code('MANUAL_HANDOFF'));
  assert.equal(q.read('decision-1').ack,null);
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport:async()=>{calls++;return {turnId:target.turnId}}}),code('MANUAL_HANDOFF'));
  assert.equal(calls,1);assert.equal(q.read('decision-1').ack,null);
 }finally{q.close();cleanup(root)}
});

test('expiry or cancellation during RPC cannot turn a stale receipt into acknowledgment',async()=>{
 const {deliverToCodex,createDecisionQueue}=await modules();const root=temp();let now=NOW;const q=createDecisionQueue(root,{now:()=>now});
 try{
  populate(q,decision({id:'expires',expiresAt:'2026-11-10T12:00:01.000Z'}));
  await assert.rejects(deliverToCodex({queue:q,id:'expires',recipient:recipient(),target,transport:async()=>{now='2026-11-10T12:00:01.000Z';return {turnId:target.turnId}}}),e=>['EXPIRED','MANUAL_HANDOFF'].includes(e.code));
  assert.equal(q.read('expires').ack,null);
  populate(q,decision({id:'cancelled'}));
  await assert.rejects(deliverToCodex({queue:q,id:'cancelled',recipient:recipient(),target,transport:async()=>{q.cancel('cancelled',{reason:'Cancelled while remote request was pending'});return {turnId:target.turnId}}}),e=>['CANCELLED','MANUAL_HANDOFF'].includes(e.code));
  assert.equal(q.read('cancelled').ack,null);assert.equal(q.read('cancelled').state,'cancelled');
 }finally{q.close();cleanup(root)}
});

function processCall(source,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source,...args],{stdio:['ignore','pipe','pipe']});let out='',err='',timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},20000);
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('close',status=>{clearTimeout(timer);if(timedOut||status!==0)reject(Error(`dispatch worker failed ${status}: ${err}`));else{try{resolve(JSON.parse(out))}catch(e){reject(e)}}});
 });
}
test('two independent dispatchers durably reserve only one remote attempt',async()=>{
 const {createDecisionQueue}=await modules();const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});populate(q);q.close();q=null;const log=join(root,'rpc-attempts.log');
  const source=`import {appendFileSync} from 'node:fs';const {createDecisionQueue}=await import(process.argv[1]);const {deliverToCodex}=await import(process.argv[2]);const q=createDecisionQueue(process.argv[3],{now:()=>${JSON.stringify(NOW)}});try{const result=await deliverToCodex({queue:q,id:'decision-1',recipient:${JSON.stringify(recipient())},target:${JSON.stringify(target)},transport:async()=>{appendFileSync(process.argv[4],'sent\\n');await new Promise(r=>setTimeout(r,200));return {turnId:${JSON.stringify(target.turnId)}}}});console.log(JSON.stringify({ok:true,result}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code}))}finally{q.close()}`;
  const args=[pathToFileURL(modulePath('queue')).href,pathToFileURL(modulePath('codex-delivery')).href,root,log];
  const settled=await Promise.allSettled([processCall(source,args),processCall(source,args)]);
  assert.ok(settled.every(r=>r.status==='fulfilled'),JSON.stringify(settled));const results=settled.map(r=>r.value);
  assert.equal(results.filter(r=>r.ok&&r.result.delivered===true).length,1);
  assert.ok(results.every(r=>r.ok?typeof r.result.delivered==='boolean':r.code==='MANUAL_HANDOFF'));
  assert.equal(fs.readFileSync(log,'utf8'),'sent\n','multiple processes sent the answer');
  q=createDecisionQueue(root,{now:()=>NOW});assert.equal(q.read('decision-1').state,'acknowledged');assert.notEqual(q.read('decision-1').ack,null);
 }finally{q?.close();cleanup(root)}
});

test('process interruption after reservation cannot cause resend after restart',async()=>{
 const {createDecisionQueue,deliverToCodex}=await modules();const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});populate(q);q.close();q=null;const log=join(root,'interrupted-rpc.log');
  const source=`import {appendFileSync} from 'node:fs';const {createDecisionQueue}=await import(process.argv[1]);const {deliverToCodex}=await import(process.argv[2]);const q=createDecisionQueue(process.argv[3],{now:()=>${JSON.stringify(NOW)}});await deliverToCodex({queue:q,id:'decision-1',recipient:${JSON.stringify(recipient())},target:${JSON.stringify(target)},transport:async()=>{appendFileSync(process.argv[4],'attempted');await new Promise(()=>process.stdout.write(JSON.stringify({interrupted:true}),()=>process.exit(0)))}});throw Error('expected fixture to terminate before receipt')`;
  const result=await processCall(source,[pathToFileURL(modulePath('queue')).href,pathToFileURL(modulePath('codex-delivery')).href,root,log]);
  assert.deepEqual(result,{interrupted:true});assert.equal(fs.readFileSync(log,'utf8'),'attempted');
  q=createDecisionQueue(root,{now:()=>NOW});let retries=0;
  await assert.rejects(deliverToCodex({queue:q,id:'decision-1',recipient:recipient(),target,transport:async()=>{retries++;return {turnId:target.turnId}}}),code('MANUAL_HANDOFF'));
  assert.equal(retries,0);assert.equal(q.read('decision-1').ack,null);
 }finally{q?.close();cleanup(root)}
});
