import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
for(const backend of ['codex','claude'])test(`doctor resolves ${backend} relative project PATH independently of inspector cwd`,async()=>{
 const {inspectDoctor}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')));
 const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));
 const {buildEnv}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/proc.mjs')));
 const repo=mkdtempSync(join(tmpdir(),'p1-relative-path-')),outside=mkdtempSync(join(tmpdir(),'p1-outside-cwd-')),cwd=process.cwd();
 try{
  mkdirSync(join(repo,'local-bin'));writeFileSync(join(repo,'local-bin','fixture-provider'),'#!/bin/sh\nexit 91\n',{mode:0o700});writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,[`${backend}Bin`]:'fixture-provider',env:{pathPrepend:['local-bin']}}));
  const cfg=loadConfig(repo,{}, {backend});process.chdir(repo);assert.ok(buildEnv(cfg).PATH.split(':').includes('local-bin'),'managed launcher from repo includes existing relative prefix');
  const inside=await inspectDoctor({repo,pandaRoot:ROOT,backend,env:{PATH:''}});
  process.chdir(outside);const external=await inspectDoctor({repo,pandaRoot:ROOT,backend,env:{PATH:''}});
  for(const result of [inside,external]){assert.equal(result.status,'degraded',JSON.stringify(result));assert.equal(result.checks.find(c=>c.id==='binary')?.status,'pass');}
  assert.deepEqual(external,inside,'BUGHUNT-PATH target readiness must not change with inspector cwd');
 }finally{process.chdir(cwd);rmSync(repo,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
