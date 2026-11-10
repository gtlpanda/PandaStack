import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {mod,modulePath,temp,cleanup,decision,approval,answer,recipient,authority,REV,NOW,code} from './support.mjs';

test('queue stores detached requests, deterministic filters and immutable replay across restart',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});const original=decision(),copy=structuredClone(original);
  assert.deepEqual(q.request(original),{created:true});original.question='Changed';
  assert.deepEqual(q.request(copy),{created:false});assert.throws(()=>q.request({...copy,reason:'Different'}),code('CONFLICT'));
  assert.deepEqual(q.read(copy.id),{decision:copy,state:'pending',answer:null,delivery:null,ack:null});
  const read=q.read(copy.id);try{read.decision.question='Mutated'}catch{};assert.equal(q.read(copy.id).decision.question,copy.question);
  q.request(decision({id:'decision-0'}));q.request(decision({id:'later',repo:'/project/two',runId:'run-2',createdAt:'2026-11-10T12:00:01.000Z'}));
  assert.deepEqual(q.list().map(x=>x.decision.id),['decision-0','decision-1','later']);
  assert.equal(q.list({repo:'/project/one',runId:'run-1',state:'pending'}).length,2);
  assert.equal(q.list({repo:'/project/two',runId:'run-1'}).length,0);assert.equal(q.read('missing'),null);
  q.close();q=createDecisionQueue(root,{now:()=>NOW});assert.deepEqual(q.read(copy.id).decision,copy);assert.equal(q.list().length,3);
 }finally{q?.close();cleanup(root)}
});

test('answer delivery binds recipient and revision, acknowledges once, and ordinary answers never authorize',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});q.request(decision());
  assert.throws(()=>q.deliver('decision-1',recipient()),code('NOT_READY'));
  assert.throws(()=>q.answer('decision-1',answer({revision:'b'.repeat(40)})),code('STALE'));
  for(const patch of [{answerId:'../SECRET'},{actor:''},{value:'missing'},{at:'2026-11-10T11:59:59.000Z'},{at:'2026-11-10T12:00:01.000Z'}])assert.throws(()=>q.answer('decision-1',answer(patch)),code('INVALID_DECISION'));
  assert.equal(q.read('decision-1').state,'pending');
  assert.deepEqual(q.answer('decision-1',answer()),{created:true});assert.deepEqual(q.answer('decision-1',answer()),{created:false});
  assert.throws(()=>q.answer('decision-1',answer({answerId:'other',value:'fast'})),code('CONFLICT'));
  for(const patch of [{runId:'other'},{repo:'/project/two'}])assert.throws(()=>q.deliver('decision-1',recipient(patch)),code('WRONG_RECIPIENT'));
  assert.throws(()=>q.deliver('decision-1',recipient({revision:'b'.repeat(40)})),code('STALE'));
  assert.equal(q.read('decision-1').state,'answered','failed routing mutated state');
  assert.throws(()=>q.deliver('decision-1',recipient({deliveryId:'../SECRET'})),code('INVALID_DECISION'));
  const delivered=q.deliver('decision-1',recipient());assert.equal(delivered.state,'delivered');assert.deepEqual(delivered.delivery,recipient());assert.equal(delivered.ack,null);
  q.close();q=createDecisionQueue(root,{now:()=>NOW});assert.deepEqual(q.deliver('decision-1',recipient()),delivered);
  assert.throws(()=>q.deliver('decision-1',recipient({deliveryId:'other'})),code('CONFLICT'));
  assert.throws(()=>q.acknowledge('decision-1',recipient({runId:'other'})),code('WRONG_RECIPIENT'));
  assert.throws(()=>q.acknowledge('decision-1',recipient({revision:'b'.repeat(40)})),code('STALE'));
  assert.deepEqual(q.acknowledge('decision-1',recipient()),{created:true});assert.deepEqual(q.acknowledge('decision-1',recipient()),{created:false});
  assert.equal(q.read('decision-1').state,'acknowledged');assert.notEqual(q.read('decision-1').ack,null);
  assert.equal(q.deliver('decision-1',recipient()).state,'acknowledged');
  for(const action of ['merge','publish','deploy'])assert.equal(q.authorize('decision-1',authority({action})),false);
 }finally{q?.close();cleanup(root)}
});

test('approval bookkeeping matches acknowledged scope without representing authenticated human consent',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();const q=createDecisionQueue(root,{now:()=>NOW});
 try{
  q.request(approval());assert.equal(q.authorize('decision-1',authority()),false);
  q.answer('decision-1',answer({value:'approve'}));assert.equal(q.authorize('decision-1',authority()),false);
  q.deliver('decision-1',recipient());assert.equal(q.authorize('decision-1',authority()),false);
  q.acknowledge('decision-1',recipient());assert.equal(q.authorize('decision-1',authority()),true);
  for(const patch of [{revision:'b'.repeat(40)},{resource:'repo/pull/13'},{action:'deploy'},{runId:'other'},{repo:'/project/two'}])assert.equal(q.authorize('decision-1',authority(patch)),false);
  q.request(approval({id:'rejected'}));q.answer('rejected',answer({value:'reject'}));q.deliver('rejected',recipient());q.acknowledge('rejected',recipient());assert.equal(q.authorize('rejected',authority()),false);
  assert.throws(()=>q.cancel('decision-1',{reason:'Late'}),code('CONFLICT'));
 }finally{q.close();cleanup(root)}
});

test('expiry and cancellation prevent stale answer delivery or acknowledgment',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();let now=NOW;const q=createDecisionQueue(root,{now:()=>now});
 try{
  for(const stage of ['pending','answered','delivered','acknowledged']){
   const id='expire-'+stage;q.request(approval({id,expiresAt:'2026-11-10T12:00:10.000Z'}));
   if(stage!=='pending')q.answer(id,answer({value:'approve'}));
   if(['delivered','acknowledged'].includes(stage))q.deliver(id,recipient());
   if(stage==='acknowledged')q.acknowledge(id,recipient());
  }
  now='2026-11-10T12:00:10.000Z';
  assert.throws(()=>q.answer('expire-pending',answer({value:'approve'})),code('EXPIRED'));
  assert.throws(()=>q.deliver('expire-answered',recipient()),code('EXPIRED'));
  assert.throws(()=>q.acknowledge('expire-delivered',recipient()),code('EXPIRED'));
  assert.equal(q.authorize('expire-acknowledged',authority()),false);
  for(const stage of ['pending','answered','delivered']){
   const id='cancel-'+stage;q.request(decision({id}));
   if(stage!=='pending')q.answer(id,answer());if(stage==='delivered')q.deliver(id,recipient());
   assert.throws(()=>q.cancel(id,{reason:''}),code('INVALID_DECISION'));
   assert.throws(()=>q.cancel(id,{reason:'x'.repeat(4097)}),code('INVALID_DECISION'));
   assert.deepEqual(q.cancel(id,{reason:'No longer needed'}),{created:true});assert.deepEqual(q.cancel(id,{reason:'No longer needed'}),{created:false});
   assert.throws(()=>q.cancel(id,{reason:'Different'}),code('CONFLICT'));assert.equal(q.read(id).state,'cancelled');
   assert.throws(()=>q.answer(id,answer()),code('CANCELLED'));assert.throws(()=>q.deliver(id,recipient()),code('CANCELLED'));
   if(stage==='delivered')assert.throws(()=>q.acknowledge(id,recipient()),code('CANCELLED'));
  }
 }finally{q.close();cleanup(root)}
});

function worker(source,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},20000);
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('close',status=>{clearTimeout(timer);if(timedOut||status!==0)reject(Error(`worker failed ${status}: ${err}`));else{try{resolve(JSON.parse(out))}catch(e){reject(e)}}});
 });
}
test('independent processes preserve requests and one competing answer/delivery winner',async()=>{
 await mod('queue');const root=temp();let q;
 const source=`const {createDecisionQueue}=await import(process.argv[1]);const q=createDecisionQueue(process.argv[2],{now:()=>${JSON.stringify(NOW)}});const op=JSON.parse(process.argv[3]);try{console.log(JSON.stringify({ok:true,value:q[op.method](...op.args)}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code}))}finally{q.close()}`;
 const run=op=>worker(source,[pathToFileURL(modulePath('queue')).href,root,JSON.stringify(op)]);
 try{
  const writes=await Promise.allSettled(Array.from({length:6},(_,i)=>run({method:'request',args:[decision({id:'request-'+i})]})));
  assert.ok(writes.every(r=>r.status==='fulfilled'&&r.value.ok),JSON.stringify(writes));
  const {createDecisionQueue}=await mod('queue');q=createDecisionQueue(root,{now:()=>NOW});assert.equal(q.list().length,6);q.request(decision());q.close();q=null;
  const answers=await Promise.allSettled(Array.from({length:4},(_,i)=>run({method:'answer',args:['decision-1',answer({answerId:'a'+i,value:i%2?'fast':'careful'})]})));
  assert.ok(answers.every(r=>r.status==='fulfilled'));const av=answers.map(r=>r.value);assert.equal(av.filter(r=>r.ok).length,1);assert.ok(av.filter(r=>!r.ok).every(r=>r.code==='CONFLICT'));
  const deliveries=await Promise.allSettled(Array.from({length:4},(_,i)=>run({method:'deliver',args:['decision-1',recipient({deliveryId:'d'+i})]})));
  assert.ok(deliveries.every(r=>r.status==='fulfilled'));const dv=deliveries.map(r=>r.value);assert.equal(dv.filter(r=>r.ok).length,1);assert.ok(dv.filter(r=>!r.ok).every(r=>r.code==='CONFLICT'));
  q=createDecisionQueue(root,{now:()=>NOW});assert.equal(q.list().length,7);assert.equal(q.read('decision-1').state,'delivered');assert.ok(q.read('decision-1').answer);
 }finally{q?.close();cleanup(root)}
});

test('corrupt persisted storage is refused instead of silently reset',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});q.request(decision());q.close();q=null;
  const files=fs.readdirSync(root,{recursive:true}).map(p=>join(root,p)).filter(p=>fs.statSync(p).isFile());
  const sqlite=files.filter(p=>fs.readFileSync(p).subarray(0,16).toString()==='SQLite format 3\0');assert.equal(sqlite.length,1,'expected one SQLite database');
  assert.equal(fs.statSync(sqlite[0]).mode&0o077,0,'database must be private');assert.equal(fs.statSync(root).mode&0o077,0,'directory must be private');
  fs.writeFileSync(sqlite[0],'CORRUPT SECRET');
  assert.throws(()=>{q=createDecisionQueue(root,{now:()=>NOW});q.read('decision-1')},e=>['CORRUPT','IO_ERROR'].includes(e.code)&&!e.message.includes('SECRET'));
 }finally{q?.close();cleanup(root)}
});

const storageRefusal=e=>['CORRUPT','IO_ERROR'].includes(e?.code);
function dbFile(root){
 const files=fs.readdirSync(root,{recursive:true}).map(p=>join(root,p)).filter(p=>fs.lstatSync(p).isFile());
 const filesWithHeader=files.filter(p=>fs.readFileSync(p).subarray(0,16).toString()==='SQLite format 3\0');
 assert.equal(filesWithHeader.length,1,'expected one SQLite database');return filesWithHeader[0];
}
function refusesStorage(createDecisionQueue,root){
 let q;try{assert.throws(()=>{q=createDecisionQueue(root,{now:()=>NOW});q.request(decision())},storageRefusal)}finally{q?.close()}
}

test('queue creation keeps leaf, database and visible sidecars private and current-user owned',async()=>{
 const {createDecisionQueue}=await mod('queue');const parent=temp(),root=join(parent,'new-queue');let q;
 try{
  q=createDecisionQueue(root,{now:()=>NOW});q.request(decision());const leaf=fs.lstatSync(root);
  assert.ok(leaf.isDirectory()&&!leaf.isSymbolicLink());assert.equal(leaf.mode&0o777,0o700);assert.equal(leaf.uid,process.getuid());
  const files=fs.readdirSync(root,{recursive:true}).map(p=>join(root,p)).filter(p=>!fs.lstatSync(p).isDirectory());assert.ok(files.length>0);
  for(const path of files){const info=fs.lstatSync(path);assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(info.mode&0o777,0o600);assert.equal(info.uid,process.getuid())}
 }finally{q?.close();cleanup(parent)}
});

test('unsafe existing leaves are rejected without chmod or writes through symlinks',async()=>{
 const {createDecisionQueue}=await mod('queue');const parent=temp();
 try{
  const unsafe=join(parent,'unsafe');fs.mkdirSync(unsafe,{mode:0o700});fs.chmodSync(unsafe,0o755);refusesStorage(createDecisionQueue,unsafe);assert.equal(fs.statSync(unsafe).mode&0o777,0o755);assert.deepEqual(fs.readdirSync(unsafe),[]);
  const file=join(parent,'file');fs.writeFileSync(file,'preserve',{mode:0o600});refusesStorage(createDecisionQueue,file);assert.equal(fs.readFileSync(file,'utf8'),'preserve');
  const target=join(parent,'target'),link=join(parent,'linked');fs.mkdirSync(target,{mode:0o700});fs.symlinkSync(target,link);refusesStorage(createDecisionQueue,link);assert.deepEqual(fs.readdirSync(target),[]);assert.ok(fs.lstatSync(link).isSymbolicLink());
 }finally{cleanup(parent)}
});

test('unsafe database modes, symlinks and nonregular database paths fail closed unchanged',async()=>{
 const {createDecisionQueue}=await mod('queue');const parent=temp();
 try{
  for(const kind of ['mode','symlink','directory']){
   const root=join(parent,kind);let q=createDecisionQueue(root,{now:()=>NOW});q.request(decision());q.close();q=null;const file=dbFile(root);
   if(kind==='mode'){
    fs.chmodSync(file,0o644);const bytes=fs.readFileSync(file);refusesStorage(createDecisionQueue,root);assert.equal(fs.statSync(file).mode&0o777,0o644);assert.deepEqual(fs.readFileSync(file),bytes);
   }else if(kind==='symlink'){
    const saved=join(parent,'saved-db');fs.renameSync(file,saved);const bytes=fs.readFileSync(saved);fs.symlinkSync(saved,file);refusesStorage(createDecisionQueue,root);assert.ok(fs.lstatSync(file).isSymbolicLink());assert.deepEqual(fs.readFileSync(saved),bytes);
   }else{
    fs.unlinkSync(file);fs.mkdirSync(file,{mode:0o700});refusesStorage(createDecisionQueue,root);assert.ok(fs.lstatSync(file).isDirectory());assert.deepEqual(fs.readdirSync(file),[]);
   }
  }
 }finally{cleanup(parent)}
});

test('preexisting unsafe SQLite sidecars are rejected without following or repairing them',async()=>{
 const {createDecisionQueue}=await mod('queue');const parent=temp();
 try{
  // SQLite defines these names relative to its database file; the queue's own
  // database filename remains discovered from the normal SQLite header.
  for(const suffix of ['-wal','-shm','-journal'])for(const kind of ['mode','symlink','directory']){
   const root=join(parent,suffix.slice(1)+'-'+kind);const q=createDecisionQueue(root,{now:()=>NOW});q.request(decision());q.close();const file=dbFile(root)+suffix;
   if(fs.existsSync(file)){assert.ok(fs.lstatSync(file).isFile());fs.unlinkSync(file)} // disposable, closed fixture only
   if(kind==='mode'){
    fs.writeFileSync(file,'preserve-sidecar',{mode:0o600});fs.chmodSync(file,0o644);refusesStorage(createDecisionQueue,root);assert.equal(fs.statSync(file).mode&0o777,0o644);assert.equal(fs.readFileSync(file,'utf8'),'preserve-sidecar');
   }else if(kind==='symlink'){
    const target=join(parent,suffix.slice(1)+'-target');fs.writeFileSync(target,'preserve-target',{mode:0o600});fs.symlinkSync(target,file);refusesStorage(createDecisionQueue,root);assert.ok(fs.lstatSync(file).isSymbolicLink());assert.equal(fs.readFileSync(target,'utf8'),'preserve-target');
   }else{
    fs.mkdirSync(file,{mode:0o700});refusesStorage(createDecisionQueue,root);assert.ok(fs.lstatSync(file).isDirectory());assert.deepEqual(fs.readdirSync(file),[]);
   }
  }
 }finally{cleanup(parent)}
});

test('queue namespace survives restart and relocation and concurrent initializers agree',async()=>{
 const {createDecisionQueue}=await mod('queue');const root=temp();let q;
 try{const directory=join(root,'queue');const source=`import {createDecisionQueue} from ${JSON.stringify(pathToFileURL(modulePath('queue')).href)};const q=createDecisionQueue(process.argv[1]);console.log(JSON.stringify(q.readNamespace()));q.close();`;
 const settled=await Promise.allSettled(Array.from({length:4},()=>worker(source,[directory])));for(const result of settled)assert.equal(result.status,'fulfilled',String(result.reason));const ids=settled.map(r=>r.value);assert.equal(new Set(ids).size,1);assert.match(ids[0],/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
 q=createDecisionQueue(directory);assert.equal(q.readNamespace(),ids[0]);q.close();q=null;const moved=join(root,'moved');fs.renameSync(directory,moved);q=createDecisionQueue(moved);assert.equal(q.readNamespace(),ids[0]);q.close();q=createDecisionQueue(join(root,'independent'));assert.notEqual(q.readNamespace(),ids[0]);
 }finally{q?.close();cleanup(root)}
});
