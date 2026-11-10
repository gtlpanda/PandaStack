import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const ROOT=resolve(process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url)));
const {createSuiteExport}=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')));
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('GIT_'))delete env[k];
Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
function git(repo,...args){return execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],{env,timeout:15000,maxBuffer:1024*1024});}
for(const name of ['ordinary-project','project space "quoted"','project:one','project:space "quoted"'])test('source-only export preserves literal repository path '+name,t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'pandastack-export-path-'));fs.chmodSync(root,0o700);
 const repo=join(root,name);fs.mkdirSync(repo,{mode:0o700});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 git(repo,'init','-q','--template=');git(repo,'config','user.name','Export fixture');git(repo,'config','user.email','fixture@example.test');
 const bytes=Buffer.from([0,255,13,10,65,66]);fs.writeFileSync(join(repo,'data.bin'),bytes,{mode:0o644});
 const executable=Buffer.from('inert executable source bytes\n');fs.writeFileSync(join(repo,'entry.txt'),executable,{mode:0o755});
 git(repo,'add','--','data.bin','entry.txt');git(repo,'commit','-qm','owned literal-path fixture');
 const head=git(repo,'rev-parse','HEAD').toString().trim(),tree=git(repo,'rev-parse','HEAD^{tree}').toString().trim();
 const before=git(repo,'status','--porcelain=v1').toString();assert.equal(before,'');
 const exported=createSuiteExport({repo,tree:head});t.after(()=>exported.cleanup());
 assert.notEqual(fs.realpathSync(exported.directory),fs.realpathSync(repo));
 for(const [file,want,mode]of [['data.bin',bytes,0o644],['entry.txt',executable,0o755]]){
  const output=join(exported.directory,file);assert.ok(fs.lstatSync(output).isFile());assert.deepEqual(fs.readFileSync(output),want);assert.equal(fs.statSync(output).mode&0o777,mode);
  assert.deepEqual(git(exported.directory,'show','HEAD:'+file),want,'export must retain self-contained objects without caller alternate env');
  assert.deepEqual(fs.readFileSync(join(repo,file)),want);assert.equal(fs.statSync(join(repo,file)).mode&0o777,mode);
 }
 assert.equal(git(exported.directory,'rev-parse','HEAD^{tree}').toString().trim(),tree);
 assert.equal(fs.existsSync(join(exported.directory,'.git','objects','info','alternates')),false);
 assert.equal(git(repo,'rev-parse','HEAD').toString().trim(),head);assert.equal(git(repo,'status','--porcelain=v1').toString(),before);
 exported.cleanup();exported.cleanup();assert.equal(fs.existsSync(exported.directory),false);
});
