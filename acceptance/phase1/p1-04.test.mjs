import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, mod, temp, cleanup } from './support.mjs';
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function init(root){git(root,'init','-q','-b','main');git(root,'config','user.name','Acceptance');git(root,'config','user.email','test@example.com');writeFileSync(join(root,'README.md'),'fixture');git(root,'add','.');git(root,'commit','-qm','initial');}
test('tracking preserves results/errors and parents across concurrent nested calls',async()=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const {createRunStore}=await mod('store');const repo=temp(),storeDir=temp();
 try{init(repo);const opts={repo,runnerRoot:ROOT,workflow:'autobuild',backend:'codex',storeDir,settings:{model:'gpt-6-astra',effort:'medium'}};
 await Promise.all(['root-a','root-b'].map(runId=>withTrackedRun({...opts,runId},async()=>{
 assert.equal(currentRunId(),runId);
 await new Promise(r=>setTimeout(r,5));
 return withTrackedRun({...opts,workflow:'session',runId:runId+'-child'},async()=>0);
 })));
 const s=createRunStore(storeDir);for(const id of ['root-a','root-b']){assert.equal(s.readRun(id+'-child').parentRunId,id);assert.equal(s.readRun(id).parentRunId,null);assert.deepEqual(s.readEvents(id).map(e=>e.type).sort(),['finished','started']);}
 const before=s.readEvents('root-a');let collided=0;assert.equal(await withTrackedRun({...opts,runId:'root-a',backend:'claude'},async()=>{collided++;return 0;}),0);assert.equal(collided,1);assert.deepEqual(s.readEvents('root-a'),before);
 assert.equal(currentRunId()??null,null);
 assert.equal(await withTrackedRun({...opts,runId:'cancel'},async()=>130),130);assert.ok(s.readEvents('cancel').some(e=>e.type==='cancelled'));
 const error=new Error('SENSITIVE_SENTINEL');await assert.rejects(withTrackedRun({...opts,runId:'throws'},async()=>{throw error;}),e=>e===error);
 assert.ok(!JSON.stringify(s.readEvents('throws')).includes('SENSITIVE_SENTINEL'));
 const file=join(repo,'not-a-directory');writeFileSync(file,'x');let calls=0;assert.equal(await withTrackedRun({...opts,storeDir:file,runId:'unrecorded'},async()=>{calls++;return 7;}),7);assert.equal(calls,1);
 }finally{cleanup(repo);cleanup(storeDir);}
});
test('actual autobuild entry records parent and provider session for both backends and distinct projects',async()=>{
 const {createRunStore}=await mod('store');await mod('tracking');
 const fixture=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')).href);
 const storeDir=temp();const repos=[];
 try{for(const backend of ['claude','codex']){const root=fixture.project(['F-1']);repos.push(root);
 const result=fixture.run(root,[{build:'F-1'}],{PANDASTACK_RUNS_DIR:storeDir,AUTOBUILD_BACKEND:backend,...(backend==='codex'?{AUTOBUILD_CODEX_BIN:join(fixture.KIT,'test-fixtures/fake-codex.mjs')}:{})});
 assert.equal(result.code,0,result.out);
 const runs=createRunStore(storeDir).listRuns({repo:root,backend});const parent=runs.find(r=>r.workflow==='autobuild');assert.ok(parent,'missing root '+backend);assert.ok(runs.some(r=>r.workflow==='session'&&r.parentRunId===parent.id),'missing provider child '+backend);
 assert.ok(parent.revision);assert.ok(parent.runnerRevision);assert.ok(createRunStore(storeDir).readEvents(parent.id).some(e=>e.type==='finished'));
 }
 assert.equal(new Set(createRunStore(storeDir).listRuns().map(r=>r.repo)).size,2);
 }finally{repos.forEach(cleanup);cleanup(storeDir);}
});
test('actual build-app driver captures root, session parent and effective HARNESS_BUILD_MODEL',async()=>{
 const {createRunStore}=await mod('store');await mod('tracking');const repo=temp(),storeDir=temp(),scripts=temp();
 try{init(repo);git(repo,'switch','-qc','integration/toy');mkdirSync(join(repo,'docs'));
 writeFileSync(join(repo,'docs/backlog.json'),JSON.stringify({version:1,app:'toy',integrationBranch:'integration/toy',requirements:['R1'],slices:[{id:'S1',title:'one',goal:'one',requirements:['R1'],acceptance:[{id:'S1-AC1',criterion:'works',fails_when:'broken'}],depends_on:[]}]}));git(repo,'add','.');git(repo,'commit','-qm','blueprint');
 const script=join(scripts,'steps.json');writeFileSync(script,JSON.stringify([{dev:'done',commits:[{subject:'S1: C1: implement',files:{'src/S1.js':'export const x=1','tests/S1.test.js':'fixture'}}]},{qa:'done'}]));
 const out=spawnSync(process.execPath,[join(ROOT,'graphs/build/skills/build-app/driver/driver.mjs'),'run','--repo',repo,'--app','toy','--no-pr'],{encoding:'utf8',timeout:60000,env:{...process.env,PANDASTACK_RUNS_DIR:storeDir,HARNESS_BUILD_MODEL:'sonnet',HARNESS_BUILD_CLAUDE_BIN:join(ROOT,'graphs/build/tests/fixtures/fake-claude.mjs'),FAKE_CLAUDE_SCRIPT:script,HARNESS_BUILD_VERIFY:'echo VERIFY: PASS',HARNESS_BUILD_MAX_SLEEP_MS:'50',HARNESS_BUILD_BUGHUNT:'0',PANDASTACK_NOTIFY:''}});
 assert.equal(out.status,0,out.stdout+out.stderr);const runs=createRunStore(storeDir).listRuns({repo});const parent=runs.find(r=>r.workflow==='build-app');assert.ok(parent);assert.equal(parent.settings.model,'sonnet');assert.ok(runs.some(r=>r.workflow==='session'&&r.parentRunId===parent.id&&r.settings.model==='sonnet'));
 }finally{cleanup(repo);cleanup(storeDir);cleanup(scripts);}
});
