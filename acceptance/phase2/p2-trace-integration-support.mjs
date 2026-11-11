import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
export const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
export const load=async()=>({...(await import(pathToFileURL(join(ROOT,'core/skills/decisions/observations.mjs')))),...(await import(pathToFileURL(join(ROOT,'core/skills/decisions/queue.mjs')))),...(await import(pathToFileURL(join(ROOT,'core/skills/run-records/store.mjs')))),fixture:await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')))});
export const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function bounded(p,ms=20000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned fixture deadline')),ms))]);}finally{clearTimeout(timer);}}
const identity=pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const rows=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
export function setup(api,t,backend,{question=true,brokenTracking=false,failedSpawn=false,emissionFailure=false,pipeFailure=false,featureIds=['F-1'],steps=[{build:'F-1'}],limits={}}={}){
 const base=fs.mkdtempSync(join(tmpdir(),'p2-trace-'));fs.chmodSync(base,0o700);
 const repo=api.fixture.project(featureIds,{maxIterations:3,noProgressLimit:1,maxTransientRetries:0,...limits});
 let queue,proc;
 t.after(async()=>{if(proc)await proc.cleanup();queue?.close();fs.rmSync(repo,{recursive:true,force:true});fs.rmSync(base,{recursive:true,force:true});});
 const queueDir=join(base,'queue'),storeDir=join(base,'runs'),callsFile=join(base,'provider-argv.jsonl'),pidFile=join(base,'owned-pids.jsonl'),attemptsFile=join(base,'attempted-events.jsonl');
 if(brokenTracking)fs.writeFileSync(storeDir,'not a directory');
 const file=join(repo,'autobuild.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
 cfg.backend=backend;cfg.codex={sessionTimeoutMinutes:1};if(pipeFailure)cfg.prompt='harmless pipe fixture '.repeat(400000);
 if(question)cfg.decisions={store:queueDir,featureId:'F-1',runId:'logical-trace',ids:['choice'],timeoutMs:1000};
 fs.writeFileSync(file,JSON.stringify(cfg,null,2));git(repo,'add','autobuild.json');git(repo,'commit','-qm','trace fixture');
 const revision=git(repo,'rev-parse','HEAD');
 if(question){
  queue=api.createDecisionQueue(queueDir);
  queue.request({schemaVersion:1,id:'choice',runId:'logical-trace',repo,revision,question:'Pick fixture color',reason:'Need one choice',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}],recommendation:null,evidence:[],kind:'question',scope:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:null});
  queue.answer('choice',{answerId:'answer-trace',value:'blue',actor:'fixture',at:new Date().toISOString(),revision});
 }
 const script=join(repo,'.harness-script.json');fs.writeFileSync(script,JSON.stringify(steps));
 const fake=join(api.fixture.KIT,'test-fixtures',backend==='codex'?'fake-codex.mjs':'fake-claude.mjs');
 const wrapper=join(base,'provider.mjs');
 fs.writeFileSync(wrapper,failedSpawn?'#!'+join(base,'absent-interpreter')+'\n':[
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  'fs.appendFileSync('+JSON.stringify(pidFile)+',JSON.stringify({pid:process.pid,start:fs.readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[19]})+"\\n");',
  'fs.appendFileSync('+JSON.stringify(callsFile)+',JSON.stringify({args:process.argv.slice(2)})+"\\n");',
  pipeFailure?'fs.closeSync(0);process.exit(70);':'await import('+JSON.stringify(pathToFileURL(fake).href)+');'
 ].join('\n'));fs.chmodSync(wrapper,0o755);
 const pipeLog=join(base,'pipe-errors.jsonl'),pipePreload=join(base,'pipe-observer.mjs');
 if(pipeFailure)fs.writeFileSync(pipePreload,[
  "import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';",
  'const original=cp.spawn;cp.spawn=function(...args){const child=original.apply(this,args);if(args[0]==='+JSON.stringify(wrapper)+')child.stdin?.on("error",error=>fs.appendFileSync('+JSON.stringify(pipeLog)+',JSON.stringify({pid:child.pid,code:error.code})+"\\n"));return child;};syncBuiltinESMExports();'
 ].join('\n'));
 const preload=join(base,'sink.mjs');
 if(emissionFailure)fs.writeFileSync(preload,[
  "import fs from 'node:fs';",
  'const original=process.stdout.write.bind(process.stdout);',
  'process.stdout.write=function(value,...rest){const text=String(value);if(text.startsWith("PANDASTACK_DECISION ")){fs.appendFileSync('+JSON.stringify(attemptsFile)+',text);throw Error("OWNED_SINK_FAILURE");}return original(value,...rest);};'
 ].join('\n'));
 function launch(){
  const child=spawn(process.execPath,[...(emissionFailure?['--import',preload]:[]),...(pipeFailure?['--import',pipePreload]:[]),api.fixture.CLI,'run'],{cwd:repo,detached:true,env:{...api.fixture.loopEnv(script),AUTOBUILD_BACKEND:backend,AUTOBUILD_CODEX_BIN:wrapper,AUTOBUILD_CLAUDE_BIN:wrapper,PANDASTACK_RUNS_DIR:storeDir},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,out:output}));});
  async function cleanup(){
   const owned=rows(pidFile);
   const signalOwned=signal=>{for(const record of owned){if(identity(record.pid)!==record.start)continue;try{if(backend==='codex')process.kill(-record.pid,signal);else process.kill(record.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}};
   if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
   signalOwned('SIGTERM');await sleep(100);
   if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
   signalOwned('SIGKILL');await bounded(done,3000);
   await sleep(50);assert.ok(owned.every(r=>identity(r.pid)!==r.start),'owned fake provider survived cleanup');
  }
  proc={child,done,cleanup};return proc;
 }
 return {repo,revision,base,storeDir,queue,launch,pipeErrors:()=>rows(pipeLog),features:()=>JSON.parse(fs.readFileSync(join(repo,'features.json'),'utf8')).features,calls:()=>rows(script+'.calls'),argv:()=>rows(callsFile),attempts:()=>fs.existsSync(attemptsFile)?fs.readFileSync(attemptsFile,'utf8').split('\n').filter(Boolean).map(line=>{assert.ok(line.startsWith('PANDASTACK_DECISION '));return JSON.parse(line.slice('PANDASTACK_DECISION '.length));}):[],passed:()=>JSON.parse(fs.readFileSync(join(repo,'features.json'),'utf8')).features[0].passes};
}

// Owned standalone process, no provider/runner import or project required.
export async function validatePipeFixture(){
 const child=spawn(process.execPath,['-e','require("fs").closeSync(0);process.stdout.write("READY\\n");setTimeout(()=>process.exit(70),200);'],{stdio:['pipe','pipe','pipe']});
 let errorCode=null,ready=false,stderr='';
 child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',e=>{errorCode=e.code;});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 try{
  await bounded(new Promise((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('READY')){ready=true;resolve();}});child.once('error',reject);}),3000);
  child.stdin.end('harmless pipe fixture '.repeat(400000));
  const result=await bounded(done,3000);assert.equal(errorCode,'EPIPE');assert.equal(result.code,70);
  return {ready,writeError:errorCode,childExit:result.code,bytes:Buffer.byteLength('harmless pipe fixture '.repeat(400000)),stderr,providerLaunched:false};
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(done,3000);}
}
