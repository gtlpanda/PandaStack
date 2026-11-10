import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {modulePath} from './support.mjs';
import {count,runCliTransport} from './p2-07-transport-support.mjs';
import {bounded} from './p2-trace-integration-support.mjs';
function complete(result){
 assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.featurePassed,true);assert.equal(result.calls,1);
 assert.deepEqual(result.malformed,[]);assert.equal(result.events.length,count*3+1,'ordinary CLI exit must retain all structured observations');
 const closed=result.events.filter(e=>e.event==='trace_closed');assert.equal(closed.length,1);assert.equal(closed[0].complete,true);assert.equal(closed[0].eventIds.length,count*3);
 for(const kind of ['waiting','received','context_supplied'])assert.equal(result.events.filter(e=>e.event===kind).length,count);
}
test('actual CLI continuous-reader control emits complete decision trace', {timeout:120000},async t=>{
 const result=await runCliTransport(t,false);t.diagnostic(JSON.stringify({bytes:result.bytes,events:result.events.length,marker:result.marker}));complete(result);
});
test('actual CLI preserves closure through finite stdout backpressure released after100ms', {timeout:120000},async t=>{
 const result=await runCliTransport(t,true);t.diagnostic(JSON.stringify({bytes:result.bytes,events:result.events.length,marker:result.marker}));
 assert.ok(result.marker,'observed actual closure write');assert.equal(result.marker.returned,false);assert.ok(result.marker.pendingBytes>0,'real stdout was backpressured, not mocked');complete(result);
});
test('real closed stdout pipe cannot terminate decision work after asynchronous EPIPE', {timeout:10000},async t=>{
 const source=[
  'import {createDecisionTrace} from '+JSON.stringify(pathToFileURL(modulePath('observations')).href)+';',
  "const revision='a'.repeat(40);const trace=createDecisionTrace({repo:'/fixture',revision,invocationRunId:'outer',now:()=> '2026-11-10T12:00:00.000Z',monotonicNow:()=>10});",
  "const waiting=trace.startWait({queueNamespace:'queue',decisionRunId:'logical',featureId:'F-1',decisionId:'question-1',revision,deliveryId:'delivery-1'});",
  "await new Promise(resolve=>process.once('message',resolve));",
  "const received=trace.finishWait(waiting.spanId,{answerId:'answer-1'});await new Promise(resolve=>setImmediate(resolve));",
  "process.send({event:received.event,answerId:received.answerId,complete:trace.complete},()=>process.disconnect());"
 ].join('\n');
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','ipc']});
 let out='',err='',result,readerClosed=false;
 child.stderr.on('data',b=>err+=b);child.on('message',m=>result=m);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(done,3000);});
 const communication=new Promise((resolve,reject)=>{
  child.stdout.on('data',b=>{out+=b;if(readerClosed||!out.includes('\n'))return;readerClosed=true;child.stdout.once('close',()=>child.send('answer',error=>error?reject(error):resolve()));child.stdout.destroy();});
  child.once('error',reject);
 });
 await bounded(communication,3000);const exited=await bounded(done,5000);
 assert.equal(readerClosed,true);assert.equal(JSON.parse(out.trim().slice(20)).event,'waiting');
 assert.equal(exited.code,0,'BUGHUNT-F1 asynchronous stdout error must not terminate work: '+err);assert.equal(exited.signal,null);
 assert.deepEqual(result,{event:'received',answerId:'answer-1',complete:false});
});
