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
function environment(extra={}){const env={...process.env,...extra};for(const key of ['AUTOBUILD_BACKEND','AUTOBUILD_CODEX_BIN','AUTOBUILD_CLAUDE_BIN','AUTOBUILD_MODEL','MODEL','AUTOBUILD_SUBAGENT_MODEL','SUBAGENT_MODEL','AUTOBUILD_PROBE_MODEL'])if(!Object.hasOwn(extra,key))delete env[key];return env;}
function provider(file,report){
 writeFileSync(file,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {loadConfig} from ${JSON.stringify(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')).href)};
const args=process.argv.slice(2),root=process.cwd(),settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const env={...process.env,...settings.env,CLAUDE_PROJECT_DIR:root};
const output={argumentModel:args[args.indexOf('--model')+1]};
try{const c=loadConfig(root,env);output.selected={backend:c.backend,model:c.model,subagentModel:c.subagentModel,probeModel:c.probeModel,binary:c[c.backend+'Bin']};}catch(e){output.reloadError=String(e);}
output.authPreserved=env.CLAUDE_CODE_OAUTH_TOKEN==='EXAMPLE-fixture-auth-sentinel';
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

const scenarios=[
 ['CLI backend overrides project backend',{backend:'codex'}],
 ['project env backend shadow',{vars:{AUTOBUILD_BACKEND:'codex'}}],
 ['project env invalid backend shadow',{vars:{AUTOBUILD_BACKEND:'invalid'}}],
 ['project env valid subagent shadow',{vars:{AUTOBUILD_SUBAGENT_MODEL:'haiku'}}],
 ['project env legacy subagent shadow',{vars:{SUBAGENT_MODEL:'opus'}}],
 ['project env invalid subagent shadow',{vars:{AUTOBUILD_SUBAGENT_MODEL:'bad model'}}],
 ['project env valid probe shadow',{vars:{AUTOBUILD_PROBE_MODEL:'opus'}}],
 ['project env invalid probe shadow',{vars:{AUTOBUILD_PROBE_MODEL:'bad model'}}],
 ['project env selected binary shadow',{vars:{AUTOBUILD_CLAUDE_BIN:'/owned-fixture-unselected-binary'}}],
 ['project env invalid selected binary shadow',{vars:{AUTOBUILD_CLAUDE_BIN:'\n'}}],
 ['project env empty binary shadows accepted inherited binary',{vars:{AUTOBUILD_CLAUDE_BIN:''}}],
 ['combined selected context',{backend:'codex',vars:{AUTOBUILD_BACKEND:'invalid',AUTOBUILD_MODEL:'haiku',AUTOBUILD_SUBAGENT_MODEL:'bad model',AUTOBUILD_PROBE_MODEL:'bad model',AUTOBUILD_CLAUDE_BIN:'\n'}}],
 ['project env main model already pinned',{vars:{AUTOBUILD_MODEL:'haiku',MODEL:'sonnet'}}],
 ['matching effective control',{}],
];
for(const [name,scenario] of scenarios)test(`actual fake-Claude selected child context: ${name}`,async()=>{
 const f=await fixture(),repo=f.project(['F-1'],{maxIterations:2,noProgressLimit:1}),tmp=mkdtempSync(join(tmpdir(),'p1-child-context-'));
 try{
  const fake=join(tmp,'fake-provider.mjs'),report=join(tmp,'report.json');provider(fake,report);
  const config=JSON.parse(readFileSync(join(repo,'autobuild.json'),'utf8'));Object.assign(config,{backend:scenario.backend??'claude',model:'opus',subagentModel:'sonnet',probeModel:'haiku',env:{vars:scenario.vars??{}}});writeFileSync(join(repo,'autobuild.json'),JSON.stringify(config));git(repo,'add','autobuild.json');git(repo,'commit','-qm','selected child context fixture');
  const env=environment({AUTOBUILD_CLAUDE_BIN:fake,AUTOBUILD_BUGHUNT:'0',CLAUDE_CODE_OAUTH_TOKEN:'EXAMPLE-fixture-auth-sentinel'}),overrides={backend:'claude',model:'claude-fable-5-1'};
  const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));const accepted=loadConfig(repo,env,overrides),expected={backend:accepted.backend,model:accepted.model,subagentModel:accepted.subagentModel,probeModel:accepted.probeModel,binary:accepted.claudeBin};
  assert.equal(expected.backend,'claude');assert.equal(expected.model,'claude-fable-5-1');assert.equal(expected.subagentModel,'sonnet');assert.equal(expected.probeModel,'haiku');assert.equal(expected.binary,fake);
  const result=spawnSync(process.execPath,[f.CLI,'run','--backend','claude','--model','claude-fable-5-1'],{cwd:repo,env,encoding:'utf8',timeout:15000});
  assert.ok(existsSync(report),result.stdout+result.stderr);const seen=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(seen.fixtureError,undefined,JSON.stringify(seen));assert.equal(seen.argumentModel,expected.model);assert.equal(seen.reloadError,undefined,'CHILD-CONTEXT '+JSON.stringify(seen));assert.deepEqual(seen.selected,expected,'CHILD-CONTEXT accepted parent selection must survive actual child reload');assert.equal(seen.authPreserved,true);
  assert.equal(seen.normal.status,0);assert.notEqual(seen.normal.value?.hookSpecificOutput?.permissionDecision,'deny');assert.equal(seen.frozen.value?.hookSpecificOutput?.permissionDecision,'deny');assert.equal(seen.push.value?.hookSpecificOutput?.permissionDecision,'deny');
  assert.equal(seen.stopBefore.value?.decision,'block');assert.equal(seen.sessionBefore.lastGate?.ok,false);assert.ok(seen.sessionBefore.lastGate.steps.some(s=>!s.ok));assert.equal(seen.markStatus,0);assert.equal(seen.stopAfter.value,null);assert.equal(seen.sessionAfter.lastGate?.ok,true);assert.equal(result.status,0,result.stdout+result.stderr);
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
