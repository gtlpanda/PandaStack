import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
const ROOT=resolve(process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url)));
const mod=name=>import(pathToFileURL(join(ROOT,'core/skills/run-records',name+'.mjs')).href);
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'p1-store-location-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function init(root){fs.mkdirSync(root,{recursive:true});git(root,'init','-q','-b','main');git(root,'config','user.name','Acceptance');git(root,'config','user.email','test@example.com');fs.writeFileSync(join(root,'README.md'),'fixture\n');git(root,'add','.');git(root,'commit','-qm','initial');}
function tree(root){const out=[];function walk(at){for(const name of fs.readdirSync(at).sort()){if(name==='.git')continue;const full=join(at,name),st=fs.lstatSync(full),p=relative(root,full);out.push([p,st.isDirectory()?'directory':st.isFile()?fs.readFileSync(full,'utf8'):'other']);if(st.isDirectory())walk(full);}}walk(root);return out;}
async function observed(fn){const prior=process.stderr.write;let warnings='';process.stderr.write=function(chunk,...args){warnings+=String(chunk);const cb=args.find(x=>typeof x==='function');cb?.();return true;};try{return {value:await fn(),warnings};}finally{process.stderr.write=prior;}}
async function envStore(value,fn){const old=process.env.PANDASTACK_RUNS_DIR;try{if(value===undefined)delete process.env.PANDASTACK_RUNS_DIR;else process.env.PANDASTACK_RUNS_DIR=value;return await fn();}finally{if(old===undefined)delete process.env.PANDASTACK_RUNS_DIR;else process.env.PANDASTACK_RUNS_DIR=old;}}
const opts=(repo,runnerRoot,patch={})=>({repo,runnerRoot,workflow:'autobuild',backend:'codex',settings:{},...patch});
const warning='PandaStack: run tracking unavailable; execution continues.\n';

for(const placement of ['project-root','project-child','project-ignored','project-subdir-call','runner-root','runner-child','runner-subdir-call','nongit-child','linked-child'])test(`managed tracking rejects ${placement} before any worktree mutation`,async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const base=fixture(t),repo=join(base,'project'),runner=join(base,'runner');init(repo);init(runner);let selectedRepo=repo,selectedRunner=runner,storeDir;
 if(placement==='project-root')storeDir=repo;
 if(placement==='project-child')storeDir=join(repo,'not-created','records');
 if(placement==='project-ignored'){fs.writeFileSync(join(repo,'.gitignore'),'ignored-records/\n');git(repo,'add','.gitignore');git(repo,'commit','-qm','ignore fixture');storeDir=join(repo,'ignored-records');}
 if(placement==='project-subdir-call'){selectedRepo=join(repo,'packages','app');fs.mkdirSync(selectedRepo,{recursive:true});storeDir=join(repo,'records');}
 if(placement==='runner-root')storeDir=runner;
 if(placement==='runner-child')storeDir=join(runner,'records');
 if(placement==='runner-subdir-call'){selectedRunner=join(runner,'packages','app');fs.mkdirSync(selectedRunner,{recursive:true});storeDir=join(runner,'records');}
 if(placement==='nongit-child'){selectedRepo=join(base,'non-git');fs.mkdirSync(selectedRepo);storeDir=join(selectedRepo,'records');}
 if(placement==='linked-child'){selectedRepo=join(base,'linked');git(repo,'worktree','add','-q','-b','linked',selectedRepo);storeDir=join(selectedRepo,'records');}
 const beforeProject=tree(repo),beforeRunner=tree(runner),beforeSelected=tree(selectedRepo);let calls=0,inside='not-called';
 const result=await observed(()=>envStore(storeDir,()=>withTrackedRun(opts(selectedRepo,selectedRunner),async()=>{calls++;inside=currentRunId();return 17;})));
 assert.deepEqual(tree(repo),beforeProject,'tracking must not create directories or records in project');
 assert.deepEqual(tree(runner),beforeRunner,'tracking must not create directories or records in runner');
 assert.deepEqual(tree(selectedRepo),beforeSelected,'linked/subdirectory project must remain untouched');
 assert.equal(result.value,17);assert.equal(calls,1);assert.equal(inside,null);assert.equal(currentRunId(),null);assert.equal(result.warnings,warning);
});

test('explicit storeDir has same pre-mutation rule and preserves exact thrown error',async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const base=fixture(t),repo=join(base,'project'),runner=join(base,'runner');init(repo);init(runner);const storeDir=join(repo,'records');const before=tree(repo),original=Error('WORK_SENTINEL');let calls=0,inside;
 const out=await observed(async()=>{try{await envStore(join(base,'external'),()=>withTrackedRun(opts(repo,runner,{storeDir}),async()=>{calls++;inside=currentRunId();throw original;}));assert.fail('work exception was swallowed');}catch(error){assert.equal(error,original);return 'same-error';}});
 assert.deepEqual(tree(repo),before);assert.equal(fs.existsSync(join(base,'external')),false,'must not silently switch to another tracking store');assert.equal(calls,1);assert.equal(inside,null);assert.equal(out.warnings,warning);
});

test('default Git metadata, linked metadata and external sibling-prefix shared store remain supported',async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const {createRunStore}=await mod('store');const base=fixture(t),repo=join(base,'project'),runner=join(base,'runner');init(repo);init(runner);const linked=join(base,'linked');git(repo,'worktree','add','-q','-b','linked',linked);
 for(const [id,target,storeDir] of [['default',repo,undefined],['linked-default',linked,undefined],['external-one',repo,join(base,'project-records')],['external-two',linked,join(base,'project-records')]]){
  let calls=0;const out=await observed(()=>envStore(storeDir,()=>withTrackedRun(opts(target,target===linked?repo:runner,{runId:id}),async()=>{calls++;assert.equal(currentRunId(),id);return 0;})));
  assert.equal(out.value,0);assert.equal(calls,1);assert.equal(out.warnings,'');assert.equal(git(target,'status','--porcelain'),'');
  const actual=storeDir??git(target,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');const s=createRunStore(actual);assert.equal(s.readRun(id).id,id);assert.deepEqual(s.readEvents(id).map(e=>e.type).sort(),['finished','started']);
 }
 assert.equal(createRunStore(join(base,'project-records')).listRuns().length,2);
});

test('direct createRunStore stays a general storage API',async t=>{
 const {createRunStore}=await mod('store');const base=fixture(t),repo=join(base,'project');init(repo);const s=createRunStore(join(repo,'direct-records'));
 assert.deepEqual(s.putRun({schemaVersion:1,id:'direct',repo,revision:git(repo,'rev-parse','HEAD'),runnerRoot:ROOT,runnerRevision:git(ROOT,'rev-parse','HEAD'),workflow:'session',backend:'codex',parentRunId:null,startedAt:'2026-11-10T00:00:00.000Z',settings:{}}),{created:true});assert.equal(s.readRun('direct').id,'direct');
});

function buildProject(base){const repo=join(base,'app');init(repo);git(repo,'switch','-qc','integration/toy');fs.mkdirSync(join(repo,'docs'));fs.writeFileSync(join(repo,'docs/backlog.json'),JSON.stringify({version:1,app:'toy',integrationBranch:'integration/toy',requirements:['R1'],slices:[{id:'S1',title:'one',goal:'one',requirements:['R1'],acceptance:[{id:'S1-AC1',criterion:'works',fails_when:'broken'}],depends_on:[]}]}));git(repo,'add','.');git(repo,'commit','-qm','blueprint');const script=join(base,'steps.json');fs.writeFileSync(script,JSON.stringify([{dev:'done',commits:[{subject:'S1: C1: implement',files:{'src/S1.js':'export const x=1','tests/S1.test.js':'fixture'}}]},{qa:'done'}]));return {repo,script};}
function buildRun(repo,script,storeDir){return spawnSync(process.execPath,[join(ROOT,'graphs/build/skills/build-app/driver/driver.mjs'),'run','--repo',repo,'--app','toy','--no-pr'],{encoding:'utf8',timeout:60000,env:{...process.env,PANDASTACK_RUNS_DIR:storeDir,HARNESS_BUILD_MODEL:'sonnet',HARNESS_BUILD_CLAUDE_BIN:join(ROOT,'graphs/build/tests/fixtures/fake-claude.mjs'),FAKE_CLAUDE_SCRIPT:script,HARNESS_BUILD_VERIFY:'echo VERIFY: PASS',HARNESS_BUILD_MAX_SLEEP_MS:'50',HARNESS_BUILD_BUGHUNT:'0',PANDASTACK_NOTIFY:''}});}
for(const mode of ['clean-internal','clean-external','dirty-internal'])test(`actual build-app fake CLI preserves preflight behavior: ${mode}`,async t=>{
 await mod('tracking');const base=fixture(t),{repo,script}=buildProject(base);const internal=join(repo,'tracking-records'),storeDir=mode==='clean-external'?join(base,'external'):internal;
 if(mode==='dirty-internal')fs.appendFileSync(join(repo,'README.md'),'caller dirty\n');const before=git(repo,'rev-parse','HEAD');
 const result=buildRun(repo,script,storeDir);assert.equal(result.error,undefined);assert.equal(result.signal,null);
 if(mode==='dirty-internal'){assert.equal(result.status,6,result.stdout+result.stderr);assert.equal(fs.existsSync(script+'.calls'),false);assert.equal(git(repo,'rev-parse','HEAD'),before);assert.equal(fs.readFileSync(join(repo,'README.md'),'utf8'),'fixture\ncaller dirty\n');}
 else{assert.equal(result.status,0,result.stdout+result.stderr);assert.ok(fs.existsSync(script+'.calls'));assert.ok(fs.existsSync(join(repo,'src/S1.js')));assert.notEqual(git(repo,'rev-parse','HEAD'),before);assert.equal(git(repo,'status','--porcelain'),'');}
 if(mode!=='clean-external')assert.equal(fs.existsSync(internal),false,'no tracking files before clean check or fake commit');
 assert.equal(git(repo,'ls-files').split('\n').some(p=>p==='tracking-records'||p.startsWith('tracking-records/')),false);
 const ignore=join(repo,'.gitignore');if(fs.existsSync(ignore))assert.equal(fs.readFileSync(ignore,'utf8').includes('tracking-records'),false);
});

for(const backend of ['claude','codex'])test(`actual autobuild ${backend} fake never commits or ignores rejected internal tracking`,async t=>{
 await mod('tracking');const f=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')).href);const repo=f.project(['F-1']);t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));const beforeIgnore=fs.readFileSync(join(repo,'.gitignore'),'utf8'),storeDir=join(repo,'tracking-records');
 const result=f.run(repo,[{build:'F-1'}],{PANDASTACK_RUNS_DIR:storeDir,AUTOBUILD_BACKEND:backend,AUTOBUILD_CLAUDE_BIN:join(f.KIT,'test-fixtures/fake-claude.mjs'),AUTOBUILD_CODEX_BIN:join(f.KIT,'test-fixtures/fake-codex.mjs')});
 assert.equal(result.code,0,result.out);assert.ok(result.calls.length>0);assert.equal(fs.existsSync(storeDir),false);assert.equal(fs.readFileSync(join(repo,'.gitignore'),'utf8'),beforeIgnore);assert.equal(git(repo,'ls-files').split('\n').some(p=>p.startsWith('tracking-records/')),false);assert.equal(JSON.parse(fs.readFileSync(join(repo,'features.json'),'utf8')).features[0].passes,true);
});


test('only exact trusted Git tracking namespace and descendants receive metadata exception',async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const {createRunStore}=await mod('store');const base=fixture(t),repo=join(base,'project');init(repo);
 const namespace=git(repo,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');
 const child=join(namespace,'shared');const good=await observed(()=>envStore(undefined,()=>withTrackedRun(opts(repo,repo,{storeDir:child,runId:'metadata-child'}),async()=>{assert.equal(currentRunId(),'metadata-child');return 0;})));
 assert.equal(good.warnings,'');assert.equal(createRunStore(child).readRun('metadata-child').id,'metadata-child');assert.equal(git(repo,'status','--porcelain'),'');
 const arbitrary=namespace+'-other';let inside,calls=0;
 const refused=await observed(()=>envStore(undefined,()=>withTrackedRun(opts(repo,repo,{storeDir:arbitrary}),async()=>{inside=currentRunId();calls++;return 9;})));
 assert.equal(fs.existsSync(arbitrary),false);assert.equal(inside,null);assert.equal(calls,1);assert.equal(refused.value,9);assert.equal(refused.warnings,warning);
});

test('static metadata namespace alias into source is refused without allowing its resolved target',async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const base=fixture(t),repo=join(base,'project'),runner=join(base,'runner');init(repo);init(runner);const source=join(repo,'source');fs.mkdirSync(source);fs.writeFileSync(join(source,'keep.txt'),'owned fixture');git(repo,'add','.');git(repo,'commit','-qm','source fixture');
 const namespace=git(repo,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');fs.symlinkSync(source,namespace,'dir');const before=tree(repo);let calls=0,inside;
 const out=await observed(()=>envStore(undefined,()=>withTrackedRun(opts(repo,runner),async()=>{calls++;inside=currentRunId();return 0;})));
 assert.deepEqual(tree(repo),before);assert.equal(fs.readlinkSync(namespace),source);assert.equal(calls,1);assert.equal(inside,null);assert.equal(out.value,0);assert.equal(out.warnings,warning);
});

test('explicit external store remains supported for supplied non-Git directories',async t=>{
 const {withTrackedRun,currentRunId}=await mod('tracking');const {createRunStore}=await mod('store');const base=fixture(t),repo=join(base,'project'),runner=join(base,'runner'),storeDir=join(base,'external');fs.mkdirSync(repo);fs.mkdirSync(runner);
 const out=await observed(()=>envStore(undefined,()=>withTrackedRun(opts(repo,runner,{storeDir,runId:'nongit-external'}),async()=>{assert.equal(currentRunId(),'nongit-external');return 0;})));
 assert.equal(out.value,0);assert.equal(out.warnings,'');assert.deepEqual(tree(repo),[]);assert.deepEqual(tree(runner),[]);const record=createRunStore(storeDir).readRun('nongit-external');assert.equal(record.revision,null);assert.equal(record.runnerRevision,null);
});
