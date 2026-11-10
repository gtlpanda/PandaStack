import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, mod, temp, cleanup } from './support.mjs';
const central=JSON.parse(readFileSync(join(ROOT,'agent-config.json')));
const probe = (status='supported', evidence='Fixture proves native control') => async()=>({version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(k=>[k,{status,evidence}]))});
function pandaFixture(root) {
 for(const f of ['agent-config.json','settings.json','core/agents'])cpSync(join(ROOT,f),join(root,f),{recursive:true});
 mkdirSync(join(root,'graphs'),{recursive:true});
 for(const name of readdirSync(join(ROOT,'graphs')))for(const dir of ['agents','workflows']) {try{cpSync(join(ROOT,'graphs',name,dir),join(root,'graphs',name,dir),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
}
test('doctor configuration resolves actual precedence and provider-specific effort',async()=>{
 const {resolveSettings}=await mod('doctor');
 const c=resolveSettings({backend:'claude',central,project:{model:'haiku',maxConcurrentSubagents:2},env:{AUTOBUILD_MODEL:'sonnet',MODEL:'haiku'},overrides:{model:'opus'}});
 assert.equal(c.values.model,'opus');assert.equal(c.sources.model,'cli');assert.equal(c.values.maxConcurrentSubagents,2);assert.equal(c.sources.maxConcurrentSubagents,'project');assert.equal(c.values.advisorModel,central.claude.advisor.model);
 const e=resolveSettings({backend:'claude',central,env:{AUTOBUILD_MODEL:'sonnet',MODEL:'haiku'}});assert.equal(e.values.model,'sonnet');assert.equal(e.sources.model,'env');
 const forced=resolveSettings({backend:'claude',central,project:{subagentModel:'haiku',subagentModelForce:true}});assert.equal(forced.values.advisorModel,'haiku');
 const effort=resolveSettings({backend:'claude',central,project:{env:{vars:{CLAUDE_CODE_EFFORT_LEVEL:'low'}}}});assert.equal(effort.values.effort,'low');assert.equal(effort.sources.effort,'project');
 const codex=resolveSettings({backend:'codex',central,project:{model:'opus',codex:{reasoningEffort:'high'}},env:{SUBAGENT_MODEL:'haiku'}});
 assert.equal(codex.values.model,'gpt-6-astra');assert.equal(codex.values.subagentModel,'gpt-6-luna');assert.equal(codex.values.effort,'high');assert.equal(codex.values.advisorEffort,'high');assert.equal(codex.values.subagentEffort,null);
 assert.throws(()=>resolveSettings({backend:'claude',central,project:{maxConcurrentSubagents:0}}));
});
test('doctor requires evidence, detects generated drift, and does not write config',async()=>{
 const {inspectDoctor}=await mod('doctor');const panda=temp(),repo=temp();
 try{pandaFixture(panda);const original=readFileSync(join(panda,'settings.json'),'utf8');
 const args={repo,pandaRoot:panda,backend:'codex',env:{},capabilityProbe:probe()};
 let binary; await inspectDoctor({...args,env:{AUTOBUILD_CODEX_BIN:'/explicit/codex'},capabilityProbe:async input=>{binary=input.bin;return probe()();}});assert.equal(binary,'/explicit/codex');
 const ready=await inspectDoctor(args);assert.equal(ready.status,'ready',JSON.stringify(ready));
 const unknown=await inspectDoctor({...args,capabilityProbe:probe('unknown','No schema available')});assert.equal(unknown.status,'degraded');
 assert.notEqual((await inspectDoctor({...args,capabilityProbe:probe('supported','')})).status,'ready');
 assert.equal((await inspectDoctor({...args,capabilityProbe:probe('unsupported')})).status,'blocked');
 writeFileSync(join(panda,'settings.json'),original.replace('"effortLevel": "high"','"effortLevel": "low"'));
 const changed=readFileSync(join(panda,'settings.json'),'utf8');assert.notEqual(changed,original);
 assert.equal((await inspectDoctor(args)).status,'blocked');assert.equal(readFileSync(join(panda,'settings.json'),'utf8'),changed);
 writeFileSync(join(repo,'autobuild.json'),'{"model":"SENSITIVE_SENTINEL wrong"}');
 const bad=await inspectDoctor(args);assert.equal(bad.status,'blocked');assert.ok(!JSON.stringify(bad).includes('SENSITIVE_SENTINEL'));
 }finally{cleanup(panda);cleanup(repo);}
});
test('doctor CLI rejects malformed flags and reports missing CLI without model calls',async()=>{
 await mod('doctor');const repo=temp();
 try {const cli=join(ROOT,'scripts/pandastack.mjs');
 for(const args of [['doctor','--backend'],['doctor','--unknown','x'],['doctor','--backend','codex','--backend','claude']]) {const out=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(out.status,1,out.stdout+out.stderr);}
 const out=spawnSync(process.execPath,[cli,'doctor','--repo',repo,'--backend','codex','--json'],{encoding:'utf8',env:{...process.env,AUTOBUILD_CODEX_BIN:'/no/such/pandastack-cli'}});
 assert.equal(out.status,2,out.stdout+out.stderr);assert.equal(JSON.parse(out.stdout).status,'blocked');
 }finally{cleanup(repo);}
});
