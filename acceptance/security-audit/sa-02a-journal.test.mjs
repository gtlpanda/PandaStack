import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,symlinkSync,existsSync,lstatSync,readlinkSync,unlinkSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const api=()=>import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/dispatch-journal.mjs')));
const code=c=>e=>e?.code===c;
async function fixture(t,limit=4){
 const a=await api();
 const {newInit}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/tests/stage-fixtures.mjs')));
 const {runDir}=newInit();
 const original=Object.fromEntries(['run-metadata.json','stage-state.json'].map(n=>[n,readFileSync(join(runDir,n),'utf8')]));
 const handles=[];
 const open=()=>{const h=a.openAuditJournal({runDir,invocationLimit:limit});handles.push(h);return h;};
 t.after(()=>{for(const h of handles.reverse())h.close();for(const [n,v] of Object.entries(original))assert.equal(readFileSync(join(runDir,n),'utf8'),v);});
 return {...a,runDir,open,read:()=>a.readAuditJournal(runDir)};
}
test('disk-visible intent precedes callback; terminal result survives close and replays without invocation',async t=>{
 const x=await fixture(t);let h=x.open();let calls=0;const input={prompt:'ordinary inert evidence',refs:['src/app.js']};
 h.prepare({id:'leaf1',input});input.refs.push('caller mutation');
 const out=await h.execute('leaf1',async got=>{calls++;assert.deepEqual(got.refs,['src/app.js']);const s=x.read();assert.equal(s.rows[0].state,'dispatched');assert.equal(s.heldCalls,1);return {outcome:'returned',result:{text:'done'}};});
 assert.equal(out.replayed,false);assert.equal(x.read().rows[0].state,'returned');h.close();h=x.open();
 assert.deepEqual(await h.execute('leaf1',()=>{calls++;throw Error('must not invoke');}),{replayed:true,outcome:'returned',result:{text:'done'}});assert.equal(calls,1);
 assert.deepEqual([x.read().settledCalls,x.read().heldCalls,x.read().available],[1,0,3]);
});
test('prepared replay detached and conflicting input does not alter durable state',async t=>{
 const x=await fixture(t);const h=x.open();const first=h.prepare({id:'one',input:{n:1}});assert.equal(first.created,true);try{first.row.input.n=99;}catch{}
 const before=x.read();assert.equal(h.prepare({id:'one',input:{n:1}}).created,false);assert.throws(()=>h.prepare({id:'one',input:{n:2}}),code('CONFLICT'));assert.deepEqual(x.read(),before);
 h.close();const again=x.open();assert.equal((await again.execute('one',async()=>({outcome:'returned',result:'ok'}))).result,'ok');
});
test('successful and known-failed siblings persist independently while thrown transport remains held',async t=>{
 const x=await fixture(t,3);let h=x.open();for(const id of ['good','failed','unknown'])h.prepare({id,input:{id}});
 await h.execute('good',async()=>({outcome:'returned',result:{answer:1}}));await h.execute('failed',async()=>({outcome:'failed',result:{code:'REMOTE_FAILED'}}));
 await assert.rejects(h.execute('unknown',async()=>{throw Error('private raw transport text');}),e=>e.code==='DISPATCH_UNCERTAIN'&&!e.message.includes('private'));
 assert.deepEqual(x.read().rows.map(r=>r.state),['returned','failed','uncertain']);assert.deepEqual([x.read().settledCalls,x.read().heldCalls,x.read().available],[2,1,0]);
 h.close();h=x.open();let calls=0;await assert.rejects(h.execute('unknown',()=>{calls++;}),code('DISPATCH_UNCERTAIN'));assert.equal(calls,0);assert.throws(()=>h.prepare({id:'fourth',input:{}}),code('BUDGET_EXHAUSTED'));
 assert.equal((await h.execute('failed',()=>{calls++;})).outcome,'failed');assert.equal(calls,0);
});
test('prepared cancellation releases only a never-dispatched hold',async t=>{
 const x=await fixture(t,1);const h=x.open();h.prepare({id:'a',input:{}});assert.throws(()=>h.prepare({id:'b',input:{}}),code('BUDGET_EXHAUSTED'));assert.deepEqual(h.cancelPrepared('a'),{changed:true});assert.deepEqual(h.cancelPrepared('a'),{changed:false});
 h.prepare({id:'b',input:{}});await h.execute('b',async()=>({outcome:'returned',result:null}));const before=x.read();assert.throws(()=>h.cancelPrepared('b'),code('CONFLICT'));assert.deepEqual(x.read(),before);
});
test('concrete owner excludes duplicate opens; busy close cannot release its lease',async t=>{
 const x=await fixture(t);const h=x.open();assert.throws(()=>x.open(),code('OWNER_BUSY'));h.prepare({id:'a',input:{}});
 let release,started;const entered=new Promise(r=>{started=r;});const pending=h.execute('a',()=>new Promise(r=>{release=r;started();}));await entered;
 try{assert.throws(()=>h.close(),code('BUSY'));assert.throws(()=>x.open(),code('OWNER_BUSY'));}finally{release({outcome:'returned',result:'settled'});await pending;}
 h.close();assert.throws(()=>h.prepare({id:'later',input:{}}),code('CLOSED'));const next=x.open();assert.equal(x.read().settledCalls,1);next.close();
});
test('invalid callback envelope is uncertainty, never a known refund or replay grant',async t=>{
 const x=await fixture(t,1);const h=x.open();h.prepare({id:'a',input:{}});await assert.rejects(h.execute('a',async()=>({outcome:'imagined',result:null})),code('DISPATCH_UNCERTAIN'));assert.deepEqual([x.read().heldCalls,x.read().available],[1,0]);assert.equal(x.read().rows[0].state,'uncertain');
});
test('read-only missing journal and mismatched reopen budget do not mutate run authority',async t=>{
 const x=await fixture(t,2);assert.throws(()=>x.read(),code('NOT_FOUND'));const h=x.open();h.prepare({id:'a',input:{}});h.close();const before=x.read();assert.throws(()=>x.openAuditJournal({runDir:x.runDir,invocationLimit:3}),code('CONFLICT'));assert.deepEqual(x.read(),before);x.open();
});
test('existing graph harness callback observes durable completed leaf before returning result to workflow',async t=>{
 const x=await fixture(t);const h=x.open();
 const {run}=await import(pathToFileURL(resolve(ROOT,'scripts/workflow-harness.mjs')));
 const fn=async agent=>await agent('inert',{agentType:'ordinary-fixture',label:'ordinary'});
 const result=await run(fn,{'ordinary-fixture':[async()=>{h.prepare({id:'workflow-leaf',input:{prompt:'inert'}});const out=await h.execute('workflow-leaf',async()=>({outcome:'returned',result:'leaf text'}));assert.equal(x.read().rows[0].state,'returned');return out.result;}]});
 assert.equal(result.result,'leaf text');assert.equal(x.read().settledCalls,1);
});

test('invalid options and input data reject without invoking accessors or changing journal',async t=>{
 const x=await fixture(t);let getters=0;const options={runDir:x.runDir,invocationLimit:4};Object.defineProperty(options,'extra',{enumerable:true,get(){getters++;return true;}});
 assert.throws(()=>x.openAuditJournal(options),code('INVALID_JOURNAL_INPUT'));assert.equal(getters,0);
 for(const invocationLimit of [null,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>x.openAuditJournal({runDir:x.runDir,invocationLimit}),code('INVALID_JOURNAL_INPUT'));
 const h=x.open();const before=x.read();const accessor={};Object.defineProperty(accessor,'value',{enumerable:true,get(){getters++;return 1;}});
 for(const input of [accessor,{a:undefined},{a:Infinity},Object.assign(Object.create({custom:true}),{a:1})])assert.throws(()=>h.prepare({id:'bad',input}),code('INVALID_JOURNAL_INPUT'));
 for(const id of ['', '../bad','x'.repeat(81)])assert.throws(()=>h.prepare({id,input:{}}),code('INVALID_JOURNAL_INPUT'));
 assert.throws(()=>h.prepare({id:'extra',input:{},verifiedOwner:true}),code('INVALID_JOURNAL_INPUT'));
 assert.equal(getters,0);assert.deepEqual(x.read(),before);
});
test('serialized input bound refuses before dispatch and oversized transport result retains uncertainty',async t=>{
 const x=await fixture(t,1);const h=x.open();const before=x.read();const huge='x'.repeat(1024*1024);
 assert.throws(()=>h.prepare({id:'large',input:{huge}}),code('INPUT_TOO_LARGE'));assert.deepEqual(x.read(),before);
 h.prepare({id:'small',input:{}});await assert.rejects(h.execute('small',async()=>({outcome:'returned',result:{huge}})),code('DISPATCH_UNCERTAIN'));
 assert.equal(x.read().rows[0].state,'uncertain');assert.equal(x.read().heldCalls,1);assert.equal(x.read().available,0);
});
test('run source identity change and terminal run cannot grant dispatch; owned metadata restored exactly',async t=>{
 const x=await fixture(t);const h=x.open();h.prepare({id:'a',input:{}});h.close();const file=join(x.runDir,'run-metadata.json'),bytes=readFileSync(file);const original=JSON.parse(bytes);
 try{
  const changed=structuredClone(original);changed.source_ref.commit='f'.repeat(original.source_ref.commit.length);if(changed.source_ref.commit===original.source_ref.commit)changed.source_ref.commit='e'.repeat(original.source_ref.commit.length);
  writeFileSync(file,JSON.stringify(changed));assert.throws(()=>x.open(),code('CONFLICT'));
 }finally{writeFileSync(file,bytes);}
 for(const status of ['complete','incomplete']){
  try{writeFileSync(file,JSON.stringify({...original,run_status:status,incomplete_reason:status==='incomplete'?'owned_fixture_stop':null}));assert.throws(()=>x.open(),code('TERMINAL_RUN'));}finally{writeFileSync(file,bytes);}
 }
 const reopened=x.open();assert.equal(x.read().rows[0].state,'prepared');reopened.close();
 let calls=0;await assert.rejects(reopened.execute('a',async()=>{calls++;return {outcome:'returned',result:null};}),code('CLOSED'));assert.equal(calls,0);assert.equal(x.read().rows[0].state,'prepared');
});
test('static symlink dispatch directory is refused without altering its ordinary owned target',async t=>{
 const x=await fixture(t);const target=join(x.runDir,'owned-static-target');mkdirSync(target,{mode:0o755});chmodSync(target,0o755);const sentinel=join(target,'sentinel');writeFileSync(sentinel,'unchanged');const before=lstatSync(target),sentinelBefore=lstatSync(sentinel);const link=join(x.runDir,'native-dispatch');symlinkSync(target,link,'dir');
 try{
  assert.throws(()=>x.open(),code('CORRUPT'));assert.equal(readlinkSync(link),target);assert.equal(readFileSync(sentinel,'utf8'),'unchanged');const after=lstatSync(target);assert.deepEqual([after.dev,after.ino,after.mode],[before.dev,before.ino,before.mode]);const afterFile=lstatSync(sentinel);assert.deepEqual([afterFile.dev,afterFile.ino,afterFile.mode,afterFile.size],[sentinelBefore.dev,sentinelBefore.ino,sentinelBefore.mode,sentinelBefore.size]);
 }finally{unlinkSync(link);}
 x.open();
});

test('multiple individually bounded bodies exceeding1MiB in total remain durable and replayable',async t=>{
 const x=await fixture(t,3);let h=x.open();const payload='a'.repeat(600000);
 h.prepare({id:'large-a',input:{payload}});h.prepare({id:'large-b',input:{payload}});
 assert.ok(Buffer.byteLength(JSON.stringify(x.read()))>1024*1024);assert.equal(x.read().heldCalls,2);
 await h.execute('large-a',async()=>({outcome:'returned',result:{payload:'r'.repeat(600000)}}));h.close();h=x.open();
 let calls=0;const out=await h.execute('large-a',()=>{calls++;});assert.equal(calls,0);assert.equal(out.result.payload.length,600000);assert.equal(x.read().rows[1].input.payload.length,600000);
 assert.deepEqual([x.read().settledCalls,x.read().heldCalls,x.read().available],[1,1,1]);
});
test('malformed actual run identity refuses before journal creation and restores owned metadata',async t=>{
 const x=await fixture(t);const file=join(x.runDir,'run-metadata.json'),bytes=readFileSync(file),base=JSON.parse(bytes);
 const mutations=[m=>{delete m.run_id;},m=>{m.run_id=17;},m=>{m.source_ref=null;},m=>{m.source_ref.commit='not-a-commit';},m=>{delete m.source_ref.tree;},m=>{m.source_ref.dirty='false';},m=>{m.source_ref.uncommitted={tracked:-1,untracked:0};}];
 for(const mutate of mutations){
  try{const changed=structuredClone(base);mutate(changed);writeFileSync(file,JSON.stringify(changed));assert.throws(()=>x.open(),code('CORRUPT'));assert.equal(existsSync(join(x.runDir,'native-dispatch')),false);}
  finally{writeFileSync(file,bytes);}
 }
 x.open();assert.equal(x.read().runId,base.run_id);assert.deepEqual(x.read().sourceRef,base.source_ref);
});
