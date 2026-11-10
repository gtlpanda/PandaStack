import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const fixture=()=>import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')));
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function environment(extra={}){const env={...process.env,...extra};for(const key of ['AUTOBUILD_MODEL','MODEL','AUTOBUILD_SUBAGENT_MODEL','SUBAGENT_MODEL','AUTOBUILD_PROBE_MODEL'])if(!Object.hasOwn(extra,key))delete env[key];return env;}
function provider(file,report){
 writeFileSync(file,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {loadConfig} from ${JSON.stringify(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')).href)};
const args=process.argv.slice(2),root=process.cwd(),settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const env={...process.env,...settings.env,CLAUDE_PROJECT_DIR:root};
const output={argumentModel:args[args.indexOf('--model')+1]};
try{output.hookModel=loadConfig(root,env).model;}catch{output.hookModel=null;}
function invoke(file,input){const r=spawnSync(process.execPath,[${JSON.stringify(join(ROOT,'graphs/autobuild/tool/hooks'))}+'/'+file],{cwd:root,env,input:JSON.stringify(input),encoding:'utf8',timeout:5000});return {status:r.status,value:r.stdout.trim()?JSON.parse(r.stdout):null};}
try{
 output.normal=invoke('guard.mjs',{tool_name:'Write',tool_input:{file_path:path.join(root,'src/app.mjs'),content:'fixture'}});
 output.frozen=invoke('guard.mjs',{tool_name:'Write',tool_input:{file_path:path.join(root,'tests/F-1.test'),content:'forbidden'}});
 output.push=invoke('guard.mjs',{tool_name:'Bash',tool_input:{command:'git push origin main'}});
 output.stopBefore=invoke('stop-gate.mjs',{});
 output.sessionBefore=JSON.parse(fs.readFileSync(path.join(root,'.harness/session.json'),'utf8'));
 fs.writeFileSync(path.join(root,'F-1.done'),'built\\n');
 const mark=spawnSync(process.execPath,[${JSON.stringify(join(ROOT,'graphs/autobuild/tool/lib/cli.mjs'))},'mark-passed','F-1'],{cwd:root,env,encoding:'utf8',timeout:5000});output.markStatus=mark.status;
 if(mark.status===0){
  fs.appendFileSync(path.join(root,'PROGRESS.md'),'\\n## F-1 — built\\n');
  for(const gitArgs of [['add','-A'],['commit','-qm','feat(F-1): fake build']]){const r=spawnSync('git',gitArgs,{cwd:root,env,encoding:'utf8',timeout:5000});if(r.status!==0)throw Error('fixture commit failed');}
  output.stopAfter=invoke('stop-gate.mjs',{});output.sessionAfter=JSON.parse(fs.readFileSync(path.join(root,'.harness/session.json'),'utf8'));
 }
}catch(e){output.fixtureError=String(e);}
fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(output));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0,result:'fixture complete'}));
`);chmodSync(file,0o700);
}
for(const scenario of ['null project','conflicting lower-priority environment'])test(`actual fake-Claude child preserves CLI model through guard and stop hooks: ${scenario}`,async()=>{
 const f=await fixture(),repo=f.project(['F-1'],{maxIterations:2,noProgressLimit:1}),tmp=mkdtempSync(join(tmpdir(),'p1-hook-child-'));
 try{
  const config=JSON.parse(readFileSync(join(repo,'autobuild.json'),'utf8'));config.backend='claude';config.model=scenario==='null project'?null:'sonnet';writeFileSync(join(repo,'autobuild.json'),JSON.stringify(config));git(repo,'add','autobuild.json');git(repo,'commit','-qm','hook override fixture');
  const fake=join(tmp,'fake-provider.mjs'),report=join(tmp,'report.json');provider(fake,report);
  const env=environment({AUTOBUILD_CLAUDE_BIN:fake,AUTOBUILD_BUGHUNT:'0',...(scenario==='null project'?{}:{AUTOBUILD_MODEL:'haiku',MODEL:'sonnet'})});
  const result=spawnSync(process.execPath,[f.CLI,'run','--backend','claude','--model','opus'],{cwd:repo,env,encoding:'utf8',timeout:15000});
  assert.ok(existsSync(report),result.stdout+result.stderr);const seen=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(seen.fixtureError,undefined,JSON.stringify(seen));assert.equal(seen.argumentModel,'opus');assert.equal(seen.hookModel,'opus','BUGHUNT-HOOK CLI selection must survive child hook config reload');
  assert.equal(seen.normal.status,0);assert.notEqual(seen.normal.value?.hookSpecificOutput?.permissionDecision,'deny','ordinary code write must remain allowed with valid selected config');
  assert.equal(seen.frozen.value?.hookSpecificOutput?.permissionDecision,'deny');assert.equal(seen.push.value?.hookSpecificOutput?.permissionDecision,'deny','CLI override must not weaken guard authorization');
  assert.equal(seen.stopBefore.value?.decision,'block','BUGHUNT-HOOK failing feature gate must not be silently skipped');assert.equal(seen.sessionBefore.lastGate?.ok,false);assert.ok(seen.sessionBefore.lastGate.steps.some(s=>!s.ok));
  assert.equal(seen.markStatus,0,'mark-passed must reload same effective model');assert.equal(seen.stopAfter.value,null);assert.equal(seen.sessionAfter.lastGate?.ok,true);assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{rmSync(repo,{recursive:true,force:true});rmSync(tmp,{recursive:true,force:true});}
});
test('invalid selected model still blocks launch and active guard remains fail closed',async()=>{
 const f=await fixture(),repo=f.project(['F-1'],{maxIterations:1}),tmp=mkdtempSync(join(tmpdir(),'p1-hook-invalid-'));
 try{
  const config=JSON.parse(readFileSync(join(repo,'autobuild.json'),'utf8'));config.backend='claude';config.model=null;writeFileSync(join(repo,'autobuild.json'),JSON.stringify(config));git(repo,'add','autobuild.json');git(repo,'commit','-qm','invalid selected model');
  const fake=join(tmp,'fake-provider.mjs'),report=join(tmp,'report.json');provider(fake,report);const env=environment({AUTOBUILD_CLAUDE_BIN:fake,AUTOBUILD_BUGHUNT:'0'});
  const result=spawnSync(process.execPath,[f.CLI,'run','--backend','claude'],{cwd:repo,env,encoding:'utf8',timeout:10000});assert.notEqual(result.status,0);assert.equal(existsSync(report),false,'invalid selected model must not launch even the fake provider');
  const guard=spawnSync(process.execPath,[join(ROOT,'graphs/autobuild/tool/hooks/guard.mjs')],{cwd:repo,env:{...env,AUTOBUILD_ACTIVE:'1',AUTOBUILD_ROLE:'builder',CLAUDE_PROJECT_DIR:repo},input:JSON.stringify({tool_name:'Write',tool_input:{file_path:join(repo,'src/app.mjs'),content:'x'}}),encoding:'utf8',timeout:5000});
  assert.equal(guard.status,0);assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision,'deny');
 }finally{rmSync(repo,{recursive:true,force:true});rmSync(tmp,{recursive:true,force:true});}
});
