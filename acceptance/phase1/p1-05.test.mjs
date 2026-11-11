import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, mod, temp, cleanup, baseRun, event } from './support.mjs';
const probe=async()=>({version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(k=>[k,{status:'supported',evidence:'Fixture validates this control'}]))});
test('doctor blocks launch-invalid configuration through the shared managed validator',async()=>{
 const {inspectDoctor}=await mod('doctor');
 const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));
 const repo=temp();
 try {
  const cases=[
   [{codex:{sessionTimeoutMinutes:0}},{}],
   [{codex:{sessionTimeoutMinutes:-1}},{}],
   [{codex:{sessionTimeoutMinutes:'5'}},{}],
   [{codex:{sessionTimeoutMinutes:null}},{}],
   [{hooks:'invalid'},{}],
   [{limits:{totalBudgetUsd:1}},{}],
   [{},{AUTOBUILD_TOTAL_BUDGET_USD:'1'}],
   [{},{TOTAL_BUDGET_USD:'1'}],
  ];
  for(const [raw,env] of cases){
   fs.writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend:'codex',...raw}));
   assert.throws(()=>loadConfig(repo,env),JSON.stringify({raw,env}));
   const result=await inspectDoctor({repo,pandaRoot:ROOT,backend:'codex',env,capabilityProbe:probe});
   assert.equal(result.status,'blocked',JSON.stringify({raw,env,result}));
   assert.ok(result.checks.some(c=>c.id==='configuration'&&c.status==='fail'));
  }
  fs.writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend:'codex',codex:{sessionTimeoutMinutes:5}}));
  assert.equal((await inspectDoctor({repo,pandaRoot:ROOT,backend:'codex',env:{},capabilityProbe:probe})).status,'ready');
 } finally {cleanup(repo);}
});
test('ordinary store operations use verified directory anchors and sync every created parent',async()=>{
 const {createRunStore}=await mod('store');
 const parent=temp(),root=join(parent,'nested','store');
 const names=['openSync','closeSync','mkdirSync','fsyncSync','linkSync','unlinkSync'];
 const saved=Object.fromEntries(names.map(k=>[k,fs[k]]));
 const opened=[],created=[],synced=[],linked=[],unlinked=[],active=new Set();
 const anchored=p=>p.startsWith('/proc/self/fd/') && /^[0-9]+$/.test(p.split('/')[4]) && p.split('/').length>5;
 try {
  fs.openSync=(...args)=>{const fd=saved.openSync(...args);active.add(fd);opened.push({path:String(args[0]),flags:args[1],dir:fs.fstatSync(fd).isDirectory()});return fd;};
  fs.closeSync=(fd)=>{const out=saved.closeSync(fd);active.delete(fd);return out;};
  fs.mkdirSync=(...args)=>{const out=saved.mkdirSync(...args);created.push(fs.realpathSync(args[0]));return out;};
  fs.fsyncSync=(fd)=>{const out=saved.fsyncSync(fd);if(fs.fstatSync(fd).isDirectory())synced.push(fs.readlinkSync('/proc/self/fd/'+fd));return out;};
  fs.linkSync=(a,b)=>{linked.push([String(a),String(b)]);return saved.linkSync(a,b);};
  fs.unlinkSync=(p)=>{unlinked.push(String(p));return saved.unlinkSync(p);};
  syncBuiltinESMExports();
  const s=createRunStore(root),run=baseRun();
  assert.deepEqual(s.putRun(run),{created:true});
  assert.deepEqual(s.appendEvent(event()),{created:true});
  assert.deepEqual(s.readRun(run.id),run);
  assert.equal(s.readEvents(run.id).length,1);assert.equal(s.listRuns().length,1);
  assert.deepEqual(s.putRun(run),{created:false});
  assert.ok(opened.some(o=>!o.dir),'record I/O was not observed');
  assert.ok(opened.filter(o=>!o.dir).every(o=>anchored(o.path)),'record I/O must use a retained directory anchor');
  assert.ok(opened.filter(o=>o.dir).every(o=>typeof o.flags==='number'&&(o.flags&fs.constants.O_NOFOLLOW)!==0&&(o.flags&fs.constants.O_DIRECTORY)!==0),'directory handles require no-follow directory flags');
  assert.ok(linked.length>=2&&linked.every(pair=>pair.every(anchored)),'publication must use anchored names');
  assert.ok(unlinked.length>=2&&unlinked.every(anchored),'temporary cleanup must use anchored names');
  assert.ok(created.length>=4,'expected new directory coverage');
  for(const p of created)assert.ok(synced.includes(dirname(p)),'unsynced new directory parent: '+dirname(p));
  assert.equal(active.size,0,'store operation leaked descriptors');
 } finally {for(const k of names)fs[k]=saved[k];syncBuiltinESMExports();cleanup(parent);}
});
