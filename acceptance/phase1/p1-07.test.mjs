import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {ROOT,mod,temp,cleanup} from './support.mjs';
test('default doctor never executes discovered provider binaries',async()=>{
 const {inspectDoctor}=await mod('doctor');const repo=temp(),bin=join(repo,'codex');
 fs.writeFileSync(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const saved=cp.spawnSync;let calls=0;
 try{
  cp.spawnSync=(...args)=>{calls++;return {status:0,stdout:'codex 1.2.3\n',stderr:''};};syncBuiltinESMExports();
  for(const [project,env] of [[{codexBin:bin},{}],[{codexBin:'codex',env:{vars:{PATH:repo}}},{}],[{}, {AUTOBUILD_CODEX_BIN:bin}],[{}, {PATH:repo}]]){
   fs.writeFileSync(join(repo,'autobuild.json'),JSON.stringify(project));
   const report=await inspectDoctor({repo,pandaRoot:ROOT,backend:'codex',env});
   assert.equal(calls,0,'read-only inspection invoked a subprocess');
   assert.equal(report.status,'degraded');assert.equal(report.runtime.version,null);
   assert.ok(Object.values(report.runtime.controls).every(c=>c.status==='unknown'));
  }
  fs.writeFileSync(join(repo,'autobuild.json'),JSON.stringify({codexBin:join(repo,'missing')}));
  assert.equal((await inspectDoctor({repo,pandaRoot:ROOT,env:{}})).status,'blocked');assert.equal(calls,0);
 }finally{cp.spawnSync=saved;syncBuiltinESMExports();cleanup(repo);}
});
test('trusted injected capability evidence remains explicitly supported',async()=>{
 const {inspectDoctor}=await mod('doctor');const repo=temp();let called=0;
 try{
  const report=await inspectDoctor({repo,pandaRoot:ROOT,env:{},capabilityProbe:async()=>{called++;return{version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(k=>[k,{status:'supported',evidence:'Explicit trusted fixture evidence.'}]))};}});
  assert.equal(called,1);assert.equal(report.status,'ready');assert.equal(report.runtime.version,'fixture-1.0');
 }finally{cleanup(repo);}
});
