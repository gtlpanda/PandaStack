import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect,load,ROOT} from './p1-09-support.mjs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const roleKeys={model:['AUTOBUILD_MODEL','MODEL'],subagentModel:['AUTOBUILD_SUBAGENT_MODEL','SUBAGENT_MODEL'],probeModel:['AUTOBUILD_PROBE_MODEL']};
const invalidProject=['bad model','bad\nmodel','',null,false,0,[],{}];
const invalidSelectedEnv=['bad model','bad\nmodel',' '];
const mapped=(backend,value)=>backend==='codex'?{opus:'gpt-6-astra',sonnet:'gpt-6.1-sol',haiku:'gpt-6-luna'}[value]??value:value;
async function ready(input,key,value,source){
 const out=await inspect(input);
 assert.equal(out.launchError,null,'fixture must launch under actual owner: '+out.launchError);
 assert.equal(out.selected[key],mapped(input.backend,value));
 assert.equal(out.report.status,'ready',JSON.stringify({input,report:out.report}));
 assert.equal(out.calls,1);
 assert.equal(out.report.settings.values[key],out.selected[key]);
 assert.equal(out.report.settings.sources[key],source);
}
async function blocked(input){
 const out=await inspect(input);
 assert.ok(out.launchError,'effective invalid model must also be refused by launcher');
 assert.equal(out.report.status,'blocked');
 assert.equal(out.calls,0);
 assert.ok(out.report.checks.some(c=>c.id==='configuration'&&c.status==='fail'));
 assert.deepEqual(out.report.settings.values,{});
}
for(const backend of ['claude','codex']){
 test(backend+': AUTOBUILD_MODEL wins over malformed MODEL and project',async()=>{
  for(const invalid of invalidProject)await ready({backend,project:{model:invalid},env:{AUTOBUILD_MODEL:'opus',MODEL:'bad legacy model'}},'model','opus','env');
 });
 test(backend+': main CLI wins over invalid AUTO, legacy and project',async()=>{
  for(const invalid of invalidProject)await ready({backend,project:{model:invalid},env:{AUTOBUILD_MODEL:'bad auto model',MODEL:'bad legacy model'},overrides:{model:'sonnet'}},'model','sonnet','cli');
 });
 test(backend+': subagent AUTO wins over malformed legacy/project',async()=>{
  for(const invalid of invalidProject)await ready({backend,project:{subagentModel:invalid},env:{AUTOBUILD_SUBAGENT_MODEL:'haiku',SUBAGENT_MODEL:'bad legacy model'}},'subagentModel','haiku','env');
 });
 test(backend+': valid env repairs all project roles including probe',async()=>{
  for(const [key,names] of Object.entries(roleKeys))for(const name of names)for(const invalid of invalidProject){
   await ready({backend,project:{[key]:invalid},env:{[name]:'opus'}},key,'opus','env');
  }
 });
 test(backend+': selected invalid project role remains blocked',async()=>{
  for(const key of Object.keys(roleKeys))for(const invalid of invalidProject)await blocked({backend,project:{[key]:invalid}});
 });
 test(backend+': invalid selected AUTO/legacy/CLI remains blocked instead of fallback',async()=>{
  for(const [key,names] of Object.entries(roleKeys))for(const name of names)for(const invalid of invalidSelectedEnv){
   const env={[name]:invalid};
   if(name.startsWith('AUTOBUILD_')&&names.length>1)env[names[1]]='opus';
   await blocked({backend,project:{[key]:'haiku'},env});
  }
  for(const invalid of invalidSelectedEnv)await blocked({backend,project:{model:'haiku'},env:{AUTOBUILD_MODEL:'opus'},overrides:{model:invalid}});
 });
 test(backend+': empty env and CLI strings skip to actual next selected value',async()=>{
  await ready({backend,project:{model:'haiku'},env:{AUTOBUILD_MODEL:'',MODEL:'opus'},overrides:{model:''}},'model','opus','env');
  await ready({backend,project:{model:'haiku'},env:{AUTOBUILD_MODEL:'',MODEL:''},overrides:{model:''}},'model','haiku','project');
  await ready({backend,project:{subagentModel:'opus'},env:{AUTOBUILD_SUBAGENT_MODEL:'',SUBAGENT_MODEL:'sonnet'}},'subagentModel','sonnet','env');
  await ready({backend,project:{probeModel:'haiku'},env:{AUTOBUILD_PROBE_MODEL:'',PROBE_MODEL:'bad ignored value'}},'probeModel','haiku','project');
  for(const key of Object.keys(roleKeys))await blocked({backend,project:{[key]:null},env:Object.fromEntries(roleKeys[key].map(k=>[k,'']))});
 });
 test(backend+': effective selection never suppresses nonmodel safety checks',async()=>{
  const env={AUTOBUILD_MODEL:'opus',MODEL:'bad lower value'};
  for(const project of [{maxConcurrentSubagents:0},{hooks:'bad'},{codex:{reasoningEffort:'bad'}},{env:{vars:{PATH:3}}}]){
   const out=await inspect({backend,project,env});
   assert.equal(out.report.status,'blocked');assert.equal(out.calls,0);
  }
 });
}
test('Codex validates mapping only for selected value',async()=>{
 await ready({backend:'codex',project:{model:'claude-unmapped'},env:{AUTOBUILD_MODEL:'opus',MODEL:'claude-unmapped'}},'model','opus','env');
 await blocked({backend:'codex',project:{model:'claude-unmapped'}});
});
test('observational null model settings and override allowlist unchanged',async()=>{
 const {sanitizeSettings}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/records.mjs')));
 assert.deepEqual(sanitizeSettings({model:null,subagentModel:null,probeModel:null}),{model:null,subagentModel:null,probeModel:null});
 const out=await inspect({backend:'codex',overrides:{subagentModel:'opus'}});
 assert.equal(out.report.status,'blocked');assert.equal(out.calls,0);
});
