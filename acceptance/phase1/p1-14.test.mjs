import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
const ROOT=resolve(process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url)));
const mod=name=>import(pathToFileURL(join(ROOT,'core/skills/run-records',name+'.mjs')).href);
const rawGit=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000});
const gitPath=(root,...args)=>{const value=rawGit(root,...args);assert.ok(value.endsWith('\n'),'Git output must have its protocol terminator');return value.slice(0,-1);};
const gitToken=(root,...args)=>rawGit(root,...args).trim();
function base(t){const dir=fs.mkdtempSync(join(tmpdir(),'p1-git-discovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function init(root,metadata){fs.mkdirSync(root,{recursive:true});rawGit(root,'init','-q','-b','main',...(metadata?['--separate-git-dir',metadata]:[]));rawGit(root,'config','user.name','Acceptance');rawGit(root,'config','user.email','test@example.com');fs.writeFileSync(join(root,'README.md'),'owned fixture\n');rawGit(root,'add','.');rawGit(root,'commit','-qm','initial');}
const opts=(repo,runnerRoot,storeDir,runId)=>({repo,runnerRoot,workflow:'autobuild',backend:'codex',settings:{},...(storeDir===undefined?{}:{storeDir}),runId});
const warning='PandaStack: run tracking unavailable; execution continues.\n';
async function scopeEnv(patch,work){const prior=new Map(Object.keys(patch).map(k=>[k,process.env[k]]));try{for(const [k,v]of Object.entries(patch)){if(v===undefined)delete process.env[k];else process.env[k]=v;}return await work();}finally{for(const [k,v]of prior){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
async function observe(work){const saved=process.stderr.write;let text='';process.stderr.write=function(value,...args){text+=String(value);args.find(x=>typeof x==='function')?.();return true;};try{return {value:await work(),warnings:text};}finally{process.stderr.write=saved;}}
async function invoke(api,options,callback){return scopeEnv({PANDASTACK_RUNS_DIR:undefined},()=>observe(()=>api.withTrackedRun(options,callback)));}
const suffixes=[['space',' '],['tab','\t'],['CR','\r'],['LF','\n']];

for(const role of ['repo','runner'])for(const [label,suffix]of suffixes)test(`${role} trailing ${label}: existing trimmed sibling must not redirect protected root`,async t=>{
 const api=await mod('tracking'),dir=base(t),normal=join(dir,'normal'),trimmed=join(dir,'tree'),actual=trimmed+suffix;init(normal);init(actual);fs.mkdirSync(trimmed);
 assert.equal(rawGit(actual,'rev-parse','--show-toplevel'),actual+'\n','fixture demonstrates exact output bytes, including path newline');
 const repo=role==='repo'?actual:normal,runner=role==='runner'?actual:normal,storeDir=join(actual,'records');let calls=0,inside;
 const result=await invoke(api,opts(repo,runner,storeDir,role+'-'+label),async()=>{calls++;inside=api.currentRunId();return 23;});
 assert.equal(fs.existsSync(storeDir),false,'actual whitespace worktree must remain unwritten');assert.deepEqual(fs.readdirSync(trimmed),[],'trimmed sibling must not become a proxy');assert.equal(rawGit(actual,'status','--porcelain'),'');assert.equal(calls,1);assert.equal(inside,null);assert.equal(result.value,23);assert.equal(result.warnings,warning);assert.equal(api.currentRunId(),null);
});

for(const role of ['repo','runner'])for(const [label,suffix]of suffixes)test(`${role} trailing ${label}: external and default metadata tracking preserve exact identities`,async t=>{
 const api=await mod('tracking'),{createRunStore}=await mod('store'),dir=base(t),normal=join(dir,'normal'),actual=join(dir,'tree')+suffix;init(normal);init(actual);assert.equal(fs.existsSync(join(dir,'tree')),false);assert.equal(gitPath(actual,'rev-parse','--show-toplevel'),actual);
 const repo=role==='repo'?actual:normal,runner=role==='runner'?actual:normal;
 for(const kind of ['external','default']){const storeDir=kind==='external'?join(dir,'external'):undefined,id=role+'-'+label+'-'+kind;let calls=0,inside;
  const result=await invoke(api,opts(repo,runner,storeDir,id),async()=>{calls++;inside=api.currentRunId();return 0;});
  assert.equal(inside,id);assert.equal(calls,1);assert.equal(result.value,0);assert.equal(result.warnings,'');const location=storeDir??gitPath(repo,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');
  const s=createRunStore(location),record=s.readRun(id);assert.equal(record.repo,repo);assert.equal(record.runnerRoot,runner);assert.equal(record.revision,gitToken(repo,'rev-parse','HEAD'));assert.equal(record.runnerRevision,gitToken(runner,'rev-parse','HEAD'));assert.deepEqual(s.readEvents(id).map(x=>x.type).sort(),['finished','started']);
 }
 assert.equal(rawGit(actual,'status','--porcelain'),'');assert.equal(fs.existsSync(join(dir,'tree')),false);
});

for(const [label,suffix]of suffixes)test(`linked worktree trailing ${label} retains exact root and allowed default namespace`,async t=>{
 const api=await mod('tracking'),{createRunStore}=await mod('store'),dir=base(t),main=join(dir,'main'),linked=join(dir,'linked')+suffix;init(main);rawGit(main,'worktree','add','-q','-b','linked',linked);assert.equal(rawGit(linked,'rev-parse','--show-toplevel'),linked+'\n');const location=gitPath(linked,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');
 let inside;const result=await invoke(api,opts(linked,main,undefined,'linked-'+label),async()=>{inside=api.currentRunId();return 0;});assert.equal(inside,'linked-'+label);assert.equal(result.warnings,'');assert.equal(result.value,0);assert.equal(createRunStore(location).readRun('linked-'+label).repo,linked);assert.equal(rawGit(linked,'status','--porcelain'),'');
});

for(const [label,suffix]of suffixes.slice(0,2))test(`separate Git metadata owner trailing ${label} is preserved rather than trimmed`,async t=>{
 const api=await mod('tracking'),{createRunStore}=await mod('store'),dir=base(t),repo=join(dir,'project'),metadata=join(dir,'metadata')+suffix;init(repo,metadata);assert.equal(rawGit(repo,'rev-parse','--absolute-git-dir'),metadata+'\n');assert.equal(fs.existsSync(join(dir,'metadata')),false);
 const location=gitPath(repo,'rev-parse','--path-format=absolute','--git-path','pandastack-runs');assert.equal(location,join(metadata,'pandastack-runs'));
 let inside;const result=await invoke(api,opts(repo,repo,undefined,'separate-'+label),async()=>{inside=api.currentRunId();return 0;});assert.equal(inside,'separate-'+label);assert.equal(result.warnings,'');assert.equal(createRunStore(location).readRun('separate-'+label).repo,repo);assert.equal(rawGit(repo,'status','--porcelain'),'');
});

for(const role of ['repo','runner'])for(const nested of [false,true])test(`broken valid-format gitdir pointer in ${role} ${nested?'ancestor':'supplied root'} never becomes non-Git fallback`,async t=>{
 const api=await mod('tracking'),dir=base(t),normal=join(dir,'normal'),damaged=join(dir,'damaged');init(normal);fs.mkdirSync(damaged);const pointer='gitdir: '+join(dir,'missing-metadata')+'\n';fs.writeFileSync(join(damaged,'.git'),pointer);const selected=nested?join(damaged,'packages','app'):damaged;fs.mkdirSync(selected,{recursive:true});const query=spawnSync('git',['-C',selected,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000});assert.equal(query.status,128);assert.match(query.stderr,/not a git repository/);
 const external=join(dir,'external');let calls=0,inside;const result=await invoke(api,opts(role==='repo'?selected:normal,role==='runner'?selected:normal,external,'broken-'+role),async()=>{calls++;inside=api.currentRunId();return 7;});
 assert.equal(fs.existsSync(external),false,'invalid discovery must fail before store creation');assert.equal(calls,1);assert.equal(inside,null);assert.equal(result.value,7);assert.equal(result.warnings,warning);assert.equal(fs.readFileSync(join(damaged,'.git'),'utf8'),pointer);assert.equal(fs.existsSync(join(dir,'missing-metadata')),false);
});

for(const kind of ['invalid-file','empty-directory','broken-symlink'])for(const role of ['repo','runner'])test(`${kind} Git metadata in ${role} is indeterminate, not genuine absence`,async t=>{
 const api=await mod('tracking'),dir=base(t),normal=join(dir,'normal'),damaged=join(dir,'damaged');init(normal);fs.mkdirSync(damaged);const entry=join(damaged,'.git');if(kind==='invalid-file')fs.writeFileSync(entry,'ordinary invalid metadata\n');if(kind==='empty-directory')fs.mkdirSync(entry);if(kind==='broken-symlink')fs.symlinkSync(join(dir,'missing-owner'),entry,'dir');const selected=join(damaged,'nested');fs.mkdirSync(selected);assert.notEqual(spawnSync('git',['-C',selected,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000}).status,0);const storeDir=join(dir,'external');let calls=0,inside;
 const result=await invoke(api,opts(role==='repo'?selected:normal,role==='runner'?selected:normal,storeDir,'metadata-'+role),async()=>{calls++;inside=api.currentRunId();return 0;});assert.equal(fs.existsSync(storeDir),false);assert.equal(calls,1);assert.equal(inside,null);assert.equal(result.value,0);assert.equal(result.warnings,warning);assert.ok(fs.lstatSync(entry));
});

test('genuine non-Git project and runner still record to explicit external shared store',async t=>{
 const api=await mod('tracking'),{createRunStore}=await mod('store'),dir=base(t),repo=join(dir,'project','nested'),runner=join(dir,'runner'),storeDir=join(dir,'external');fs.mkdirSync(repo,{recursive:true});fs.mkdirSync(runner);let inside;
 const out=await invoke(api,opts(repo,runner,storeDir,'nongit'),async()=>{inside=api.currentRunId();return 0;});assert.equal(inside,'nongit');assert.equal(out.warnings,'');assert.equal(out.value,0);const record=createRunStore(storeDir).readRun('nongit');assert.equal(record.repo,repo);assert.equal(record.runnerRoot,runner);assert.equal(record.revision,null);assert.equal(record.runnerRevision,null);
});

test('invalid discovery preserves work error identity and emits only generic warning',async t=>{
 const api=await mod('tracking'),dir=base(t),repo=join(dir,'project'),runner=join(dir,'runner'),storeDir=join(dir,'external');fs.mkdirSync(repo);init(runner);fs.writeFileSync(join(repo,'.git'),'gitdir: '+join(dir,'missing')+'\n');const original=Error('PRIVATE_WORK_DETAIL');let calls=0,inside;
 const out=await observe(async()=>{try{await scopeEnv({PANDASTACK_RUNS_DIR:storeDir},()=>api.withTrackedRun({...opts(repo,runner,undefined,'error')},async()=>{calls++;inside=api.currentRunId();throw original;}));assert.fail('work error swallowed');}catch(error){assert.equal(error,original);return 'same-error';}});assert.equal(fs.existsSync(storeDir),false);assert.equal(inside,null);assert.equal(calls,1);assert.equal(out.warnings,warning);assert.equal(out.value,'same-error');
});

for(const control of ['GIT_DIR','GIT_CEILING_DIRECTORIES'])test(`failed discovery under owned ${control} never grants non-Git publication`,async t=>{
 const api=await mod('tracking'),dir=base(t),repo=join(dir,'project'),runner=join(dir,'runner');init(repo);init(runner);const nested=join(repo,'packages','app');fs.mkdirSync(nested,{recursive:true});const storeDir=join(dir,'external');const value=control==='GIT_DIR'?join(dir,'missing-gitdir'):repo;let calls=0,inside;
 const before=process.env[control];const out=await scopeEnv({[control]:value},async()=>{const query=spawnSync('git',['-C',nested,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000});assert.notEqual(query.status,0,'fixture control must cause actual discovery failure');return invoke(api,opts(nested,runner,storeDir,'env-discovery'),async()=>{calls++;inside=api.currentRunId();return 0;});});
 assert.equal(process.env[control],before);assert.equal(fs.existsSync(storeDir),false);assert.equal(inside,null);assert.equal(calls,1);assert.equal(out.value,0);assert.equal(out.warnings,warning);assert.equal(rawGit(repo,'status','--porcelain'),'');
});
