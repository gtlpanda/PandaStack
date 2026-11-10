import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const load=async()=>({
 ...(await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')))),
 ...(await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')))),
 ...(await import(pathToFileURL(join(ROOT,'core/skills/run-records/records.mjs')))),
});
const supported=()=>({version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(key=>[key,{status:'supported',evidence:'Trusted injected fixture proves this control.'}]))});
const envKeys={model:['AUTOBUILD_MODEL','MODEL'],subagentModel:['AUTOBUILD_SUBAGENT_MODEL','SUBAGENT_MODEL'],probeModel:['AUTOBUILD_PROBE_MODEL']};
for(const backend of ['codex','claude']){
 for(const key of Object.keys(envKeys)){
  test(`doctor and managed launcher reject selected null ${backend} ${key} without probing`,async()=>{
   const {inspectDoctor,loadConfig}=await load();const repo=mkdtempSync(join(tmpdir(),'p1-null-model-'));
   try{
    writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,[key]:null}));
    for(const env of [{},Object.fromEntries(envKeys[key].map(name=>[name,'']))]){
     let calls=0;const report=await inspectDoctor({repo,pandaRoot:ROOT,backend,env,capabilityProbe:async()=>{calls++;return supported();}});
     assert.equal(report.status,'blocked',JSON.stringify({backend,key,env,report}));
     assert.equal(calls,0,'invalid selected launch model must fail before a trusted probe');
     assert.ok(report.checks.some(c=>c.id==='configuration'&&c.status==='fail'));
     assert.throws(()=>loadConfig(repo,env,{backend}),'the owning managed resolver must reject the same invalid selected model');
    }
   }finally{rmSync(repo,{recursive:true,force:true});}
  });
 }
 test(`${backend} valid environment and main CLI overrides supersede raw null models`,async()=>{
  const {inspectDoctor,loadConfig}=await load();const repo=mkdtempSync(join(tmpdir(),'p1-null-override-'));
  try{
   const cases=[{project:{},env:{},overrides:{}}];
   for(const [key,names] of Object.entries(envKeys))for(const name of names)cases.push({project:{[key]:null},env:{[name]:'opus'},overrides:{}});
   cases.push({project:{model:null},env:{},overrides:{model:'opus'}});
   for(const {project,env,overrides} of cases){
    writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,...project}));
    const selected=loadConfig(repo,env,{backend,...overrides});
    for(const key of Object.keys(envKeys))assert.ok(typeof selected[key]==='string'&&selected[key].trim(),`invalid fixture selection ${key}`);
    let calls=0;const report=await inspectDoctor({repo,pandaRoot:ROOT,backend,env,overrides,capabilityProbe:async()=>{calls++;return supported();}});
    assert.equal(report.status,'ready',JSON.stringify({backend,project,env,overrides,report}));assert.equal(calls,1);
    for(const key of Object.keys(envKeys))assert.equal(report.settings.values[key],selected[key],'doctor selection must agree with the managed resolver');
   }
  }finally{rmSync(repo,{recursive:true,force:true});}
 });
}
test('observational run records retain null model values as unknown metadata',async()=>{
 const {sanitizeSettings,validateRun,createRun}=await load();
 const settings={model:null,subagentModel:null,advisorModel:null,probeModel:null,sources:{model:'unknown',subagentModel:'unknown',advisorModel:'unknown',probeModel:'unknown'}};
 const before=structuredClone(settings);assert.deepEqual(sanitizeSettings(settings),settings);assert.deepEqual(settings,before);
 const run={schemaVersion:1,id:'unknown-model-record',repo:'/fixture/project',revision:null,runnerRoot:'/fixture/runner',runnerRevision:null,workflow:'autobuild',backend:'codex',parentRunId:null,startedAt:'2026-11-10T00:00:00Z',settings};
 assert.deepEqual(validateRun(run),[]);assert.deepEqual(createRun(run).settings,settings);
});
