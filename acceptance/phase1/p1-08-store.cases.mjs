import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const mod=()=>import(pathToFileURL(join(ROOT,'core/skills/run-records/store.mjs')).href);
const run={schemaVersion:1,id:'read-run',repo:'/project/one',revision:'a'.repeat(40),runnerRoot:'/runner',runnerRevision:'b'.repeat(40),workflow:'autobuild',backend:'codex',parentRunId:null,startedAt:'2026-11-10T12:00:00.000Z',settings:{}};
const event={schemaVersion:1,id:'start',runId:run.id,type:'started',at:run.startedAt,exitCode:null};
const operations=[
 {name:'readRun',target:'run',call:s=>s.readRun(run.id)},
 {name:'readEvents',target:'event',call:s=>s.readEvents(run.id)},
 {name:'listRuns',target:'run',call:s=>s.listRuns()},
 {name:'putRun replay',target:'run',call:s=>s.putRun(run)},
 {name:'appendEvent replay',target:'event',call:s=>s.appendEvent(event)},
];
for(const operation of operations)test(`${operation.name} reports operational EIO as safe IO_ERROR`,async()=>{
 const {createRunStore}=await mod();const root=fs.mkdtempSync(join(tmpdir(),'pandastack-read-error-'));const saved=fs.readFileSync;let injected=0;
 try{
  const store=createRunStore(root);store.putRun(run);store.appendEvent(event);
  const target=operation.target==='run'?join(root,'runs',run.id+'.json'):join(root,'events',run.id,event.id+'.json');
  fs.readFileSync=(path,...args)=>{
   if(typeof path==='number'&&fs.readlinkSync('/proc/self/fd/'+path)===target){injected++;throw Object.assign(Error('PRIVATE_READ_FAILURE_4190'),{code:'EIO'})}
   return saved(path,...args);
  };
  syncBuiltinESMExports();
  assert.throws(()=>operation.call(store),e=>e.code==='IO_ERROR'&&e.message==='Run store: IO_ERROR');
  assert.equal(injected,1,'the intended existing record read was not exercised');
 }finally{fs.readFileSync=saved;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true})}
});

test('malformed JSON and invalid stored content remain CORRUPT on reads and replay',async()=>{
 const {createRunStore}=await mod();const root=fs.mkdtempSync(join(tmpdir(),'pandastack-read-corrupt-'));
 try{
  for(const operation of operations)for(const content of ['{ malformed PRIVATE_CONTENT_9081',JSON.stringify({invalid:'PRIVATE_CONTENT_9081'})]){
   const directory=join(root,operation.name.replaceAll(' ','-')+(content[0]==='{'&&content[1]===' '?'json':'shape'));
   const store=createRunStore(directory);store.putRun(run);store.appendEvent(event);
   const file=operation.target==='run'?join(directory,'runs',run.id+'.json'):join(directory,'events',run.id,event.id+'.json');
   fs.writeFileSync(file,content);
   assert.throws(()=>operation.call(store),e=>e.code==='CORRUPT'&&e.message==='Run store: CORRUPT');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
