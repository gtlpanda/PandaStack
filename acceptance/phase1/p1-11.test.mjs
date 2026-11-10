import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,accessSync,statSync,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
function executable(repo,bin,path){const rooted=p=>isAbsolute(p)?p:repo+'/'+p;return (bin.includes('/')?[rooted(bin)]:path.split(':').map(p=>rooted((p||'.')+'/'+bin))).some(p=>{try{accessSync(p,constants.X_OK);return statSync(p).isFile();}catch{return false;}});}
const cases=[
 ['relative prefix',{prefix:['local'],expected:true}],
 ['dot prefix',{prefix:['.'],where:'root',expected:true}],
 ['inherited relative PATH',{inherited:'local',expected:true}],
 ['project relative PATH',{override:'local',expected:true}],
 ['explicit empty PATH',{override:'',where:'root',expected:true}],
 ['explicit relative binary',{bin:'local/fixture-provider',expected:true}],
 ['explicit absolute binary',{bin:'ABS_BIN',expected:true}],
 ['absolute prefix literal colon remains PATH delimiter',{prefix:['ABS'],colonExpected:false,expected:true}],
 ['inherited absolute PATH literal colon remains delimiter',{inherited:'ABS',colonExpected:false,expected:true}],
 ['project absolute PATH literal colon remains delimiter',{override:'ABS',colonExpected:false,expected:true}],
 ['relative prefix containing colon is split',{prefix:['left:right'],where:'left',expected:true}],
 ['literal colon directory alone is not a PATH entry',{prefix:['left:right'],where:'literal-colon',expected:false}],
 ['empty prefix is still omitted',{prefix:[''],where:'root',expected:false}],
 ['missing prefix is still omitted',{prefix:['missing'],where:'root',expected:false}],
];
for(const backend of ['codex','claude'])for(const repoName of ['repo:part','repo with spaces'])for(const [name,spec] of cases)test(`${backend} ${repoName}: ${name}`,async()=>{
 const {inspectDoctor}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')));
 const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));
 const {buildEnv}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/proc.mjs')));
 const root=mkdtempSync(join(tmpdir(),'p1-path-serialization-')),repo=join(root,repoName),outside=join(root,'outside'),cwd=process.cwd(),oldPath=process.env.PATH;
 try{
  for(const dir of [repo,outside,join(repo,'local'),join(repo,'left'),join(repo,'left:right')])mkdirSync(dir,{recursive:true});
  const location={root:repo,left:join(repo,'left'),'literal-colon':join(repo,'left:right'),local:join(repo,'local')}[spec.where??'local'];
  writeFileSync(join(location,'fixture-provider'),'#!/bin/sh\nexit 91\n',{mode:0o700});
  const expand=x=>x==='ABS'?join(repo,'local'):x==='ABS_BIN'?join(repo,'local','fixture-provider'):x;
  const env={pathPrepend:(spec.prefix??[]).map(expand),vars:{}};if(Object.hasOwn(spec,'override'))env.vars.PATH=expand(spec.override);
  writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,[`${backend}Bin`]:expand(spec.bin??'fixture-provider'),env}));
  const inherited=expand(spec.inherited??'');process.env.PATH=inherited;process.chdir(repo);
  const cfg=loadConfig(repo,{PATH:inherited},{backend}),managed=buildEnv(cfg),expected=executable(repo,cfg[`${backend}Bin`],managed.PATH);
  assert.equal(expected,repoName.includes(':')?(spec.colonExpected??spec.expected):spec.expected,'owned fixture must establish actual managed PATH semantics');
  for(const inspectionCwd of [repo,outside]){process.chdir(inspectionCwd);const result=await inspectDoctor({repo,pandaRoot:ROOT,backend,env:{PATH:inherited}});assert.equal(result.checks.find(c=>c.id==='configuration')?.status,'pass');assert.equal(result.checks.find(c=>c.id==='binary')?.status,expected?'pass':'fail',`PATH-SERIALIZATION ${name}; cwd=${inspectionCwd}; actual launcher PATH=${managed.PATH}`);assert.equal(result.status,expected?'degraded':'blocked');}
 }finally{process.chdir(cwd);if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;rmSync(root,{recursive:true,force:true});}
});
