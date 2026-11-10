import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,accessSync,statSync,symlinkSync,constants} from 'node:fs';
import {join,isAbsolute,relative} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
// Preserve filesystem traversal semantics: path.resolve would collapse symlink/..
// before the kernel sees it, unlike the managed child's exec PATH search.
function executable(repo,bin,path){const rooted=p=>isAbsolute(p)?p:repo+'/'+p;const candidates=bin.includes('/')?[rooted(bin)]:path.split(':').map(dir=>rooted((dir||'.')+'/'+bin));return candidates.some(p=>{try{accessSync(p,constants.X_OK);return statSync(p).isFile();}catch{return false;}});}
const cases=[
 ['empty prefix',{prefix:[''],where:'root',expected:false}],
 ['empty and missing prefixes',{prefix:['','missing'],where:'root',expected:false}],
 ['missing prefix',{prefix:['missing'],where:'root',expected:false}],
 ['dot prefix',{prefix:['.'],where:'root',expected:true}],
 ['relative prefix',{prefix:['local'],where:'local',expected:true}],
 ['absolute prefix',{prefix:['ABS'],where:'absolute',expected:true}],
 ['tilde prefix expansion belongs to loadConfig',{prefix:['TILDE'],where:'absolute',expected:true}],
 ['HOME prefix expansion belongs to loadConfig',{prefix:['HOMEVAR'],where:'absolute',expected:true}],
 ['non executable file',{prefix:['local'],where:'local',mode:0o600,expected:false}],
 ['directory named binary',{prefix:['local'],where:'local',directory:true,expected:false}],
 ['existing nondirectory prefix',{prefix:['prefix-file'],where:'root',expected:false}],
 ['inherited empty components dropped',{inherited:':missing::',where:'root',expected:false}],
 ['inherited relative component',{inherited:'local',where:'local',expected:true}],
 ['inherited absolute component',{inherited:'ABS',where:'absolute',expected:true}],
 ['project PATH overrides prefixes',{prefix:['local'],override:'missing',where:'local',expected:false}],
 ['project PATH overrides inherited',{inherited:'ABS',override:'missing',where:'absolute',expected:false}],
 ['project PATH relative component',{override:'local',where:'local',expected:true}],
 ['project PATH absolute component',{override:'ABS',where:'absolute',expected:true}],
 ['project PATH empty means current directory',{override:'',where:'root',expected:true}],
 ['project PATH empty components retained',{override:'missing::',where:'root',expected:true}],
 ['relative symlink parent traversal',{prefix:['link/../bin'],where:'external-bin',expected:true}],
 ['inherited symlink parent traversal',{inherited:'link/../bin',where:'external-bin',expected:true}],
 ['project PATH symlink parent traversal',{override:'link/../bin',where:'external-bin',expected:true}],
 ['symlink prefix must not select lexical parent',{prefix:['link/../bin'],where:'repo-bin',expected:false}],
 ['symlink inherited PATH must not select lexical parent',{inherited:'link/../bin',where:'repo-bin',expected:false}],
 ['symlink project PATH must not select lexical parent',{override:'link/../bin',where:'repo-bin',expected:false}],
 ['symlink explicit binary must not select lexical parent',{bin:'link/../bin/fixture-provider',where:'repo-bin',expected:false}],
 ['explicit relative binary bypasses PATH',{bin:'local/fixture-provider',where:'local',expected:true}],
 ['explicit symlink parent binary',{bin:'link/../bin/fixture-provider',where:'external-bin',expected:true}],
];
for(const backend of ['codex','claude'])for(const [name,spec] of cases)test(`${backend} PATH parity: ${name}`,async()=>{
 const {inspectDoctor}=await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs')));
 const {loadConfig}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')));
 const {buildEnv}=await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/proc.mjs')));
 const root=mkdtempSync(join(tmpdir(),'p1-path-matrix-')),repo=join(root,'repo'),outside=join(root,'outside'),absolute=join(root,'absolute'),external=join(root,'external');
 const cwd=process.cwd(),oldPath=process.env.PATH;
 try{
  for(const dir of [repo,outside,absolute,external,join(repo,'local'),join(repo,'bin'),join(external,'child'),join(external,'bin')])mkdirSync(dir,{recursive:true});
  symlinkSync(join(external,'child'),join(repo,'link'));writeFileSync(join(repo,'prefix-file'),'not a directory');
  const location={root:repo,local:join(repo,'local'),absolute,'repo-bin':join(repo,'bin'),'external-bin':join(external,'bin')}[spec.where],file=join(location,'fixture-provider');
  if(spec.directory)mkdirSync(file);else writeFileSync(file,'#!/bin/sh\nexit 91\n',{mode:spec.mode??0o700});
  const expand=x=>x==='ABS'?absolute:x==='TILDE'?'~/'+relative(homedir(),absolute):x==='HOMEVAR'?'$HOME/'+relative(homedir(),absolute):x,env={pathPrepend:(spec.prefix??[]).map(expand),vars:{}};
  if(Object.hasOwn(spec,'override'))env.vars.PATH=expand(spec.override);
  const bin=spec.bin??'fixture-provider';writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,[`${backend}Bin`]:bin,env}));
  const inherited=expand(spec.inherited??'');process.env.PATH=inherited;process.chdir(repo);
  const config=loadConfig(repo,{PATH:inherited},{backend}),managed=buildEnv(config),expected=executable(repo,config[`${backend}Bin`],managed.PATH);
  assert.equal(expected,spec.expected,'fixture must establish actual managed selection');
  for(const inspectionCwd of [repo,outside]){
   process.chdir(inspectionCwd);const result=await inspectDoctor({repo,pandaRoot:ROOT,backend,env:{PATH:inherited}});
   assert.equal(result.checks.find(c=>c.id==='configuration')?.status,'pass',JSON.stringify(result));
   assert.equal(result.checks.find(c=>c.id==='binary')?.status,expected?'pass':'fail',`PATH-PARITY ${name}; inspector=${inspectionCwd}; managed PATH=${managed.PATH}; ${JSON.stringify(result)}`);
   assert.equal(result.status,expected?'degraded':'blocked');
  }
 }finally{process.chdir(cwd);if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;rmSync(root,{recursive:true,force:true});}
});
