import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const load=async()=>({
 ...(await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')))),
 ...(await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')))),
});
const supported=()=>({version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(key=>[key,{status:'supported',evidence:'Trusted injected fixture proves this control.'}]))});
function fixture(){
 const repo=mkdtempSync(join(tmpdir(),'p1-binary-'));
 const projectBin=join(repo,'project-provider'),envBin=join(repo,'environment-provider');
 for(const file of [projectBin,envBin]){writeFileSync(file,'#!/bin/sh\nexit 91\n');chmodSync(file,0o700);}
 return {repo,projectBin,envBin,write(project){writeFileSync(join(repo,'autobuild.json'),JSON.stringify(project));},close(){rmSync(repo,{recursive:true,force:true});}};
}
for(const backend of ['codex','claude']){
 const key=`${backend}Bin`,envKey=`AUTOBUILD_${backend.toUpperCase()}_BIN`;
 for(const [label,value] of [['empty string',''],['null',null],['false',false]]){
  test(`doctor blocks selected ${backend} binary ${label} before any capability probe`,async()=>{
   const {inspectDoctor}=await load();const f=fixture();
   try{
    f.write({backend,[key]:value});
    for(const env of [{},{[envKey]:''}]){
     let calls=0;const report=await inspectDoctor({repo:f.repo,pandaRoot:ROOT,backend,env,capabilityProbe:async()=>{calls++;return supported();}});
     assert.equal(report.status,'blocked',JSON.stringify({backend,label,env,report}));
     assert.equal(calls,0,'invalid effective binary must be rejected before a trusted discovery callback runs');
     assert.ok(report.checks.some(c=>c.id==='configuration'&&c.status==='fail'),'invalid binary must be reported as configuration failure');
    }
   }finally{f.close();}
  });
 }
 test(`doctor ${backend} defaults and explicit valid binaries match managed launch selection`,async()=>{
  const {inspectDoctor,loadConfig}=await load();const f=fixture();
  try{
   const cases=[
    {project:{},env:{},expected:backend},
    {project:{},env:{[envKey]:''},expected:backend},
    {project:{[key]:f.projectBin},env:{},expected:f.projectBin},
    {project:{[key]:f.projectBin},env:{[envKey]:''},expected:f.projectBin},
    {project:{[key]:f.projectBin},env:{[envKey]:f.envBin},expected:f.envBin},
    ...['',null,false].map(value=>({project:{[key]:value},env:{[envKey]:f.envBin},expected:f.envBin})),
   ];
   for(const {project,env,expected} of cases){
    f.write({backend,...project});const selected=loadConfig(f.repo,env,{backend})[key];assert.equal(selected,expected,'fixture must follow managed launcher precedence');
    const seen=[];const report=await inspectDoctor({repo:f.repo,pandaRoot:ROOT,backend,env,capabilityProbe:async input=>{seen.push(input.bin);return supported();}});
    assert.equal(report.status,'ready',JSON.stringify({project,env,report}));assert.deepEqual(seen,[selected],'doctor must probe exactly the selected managed binary once');
   }
  }finally{f.close();}
 });
}
