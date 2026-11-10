import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const ROOT=resolve(process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url)));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>{console.error('Isolated symlink acceptance watchdog expired; cleanup unconfirmed');process.exit(1);},120000);watchdog.unref();
function identity(pid){try{const v=fs.readFileSync('/proc/'+pid+'/stat','utf8');const f=v.slice(v.lastIndexOf(')')+2).split(' ');return {pid,parent:Number(f[1]),start:f[19],state:f[0]};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const alive=r=>{const now=identity(r.pid);return now?.start===r.start&&now.state!=='Z';};
function fixture(t,exit){
 const root=fs.mkdtempSync(join(tmpdir(),'pandastack-verify-link-'));fs.chmodSync(root,0o700);
 let uncertain=false;t.after(()=>{if(!uncertain)fs.rmSync(root,{recursive:true,force:true});});
 const source=join(root,'source'),skills=join(root,'.claude','skills'),task=join(root,'task'),evidence=join(root,'evidence');
 fs.mkdirSync(source);fs.mkdirSync(skills,{recursive:true});fs.mkdirSync(join(task,'scripts'),{recursive:true});fs.mkdirSync(evidence,{mode:0o700});
 for(const n of ['verify.sh','retention.mjs','retention.sh','packages.mjs'])fs.copyFileSync(join(ROOT,'core/skills/verify',n),join(source,n));
 const link=join(skills,'verify');fs.symlinkSync(source,link,'dir');
 fs.writeFileSync(join(task,'scripts/test.sh'),'#!/bin/sh\nprintf "ACTUAL_TASK_RAN\\n"\nprintf "ran\\n" > task-marker\nexit '+exit+'\n',{mode:0o700});
 const env={...process.env,VERIFY_EVIDENCE_DIR:evidence};for(const k of ['VERIFY_CAPTURE_SESSION','VERIFY_ALLOW_NO_TESTS'])delete env[k];
 async function run(command,args){
  const child=spawn(command,args,{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  const tracked=new Map();const first=identity(child.pid);if(first)tracked.set(first.pid,first);
  let stdout='',stderr='',closed=false,status=null,signal=null,error=null;
  const scan=()=>{try{const all=fs.readdirSync('/proc').filter(s=>/^\d+$/.test(s)).map(s=>identity(Number(s))).filter(Boolean);let changed;do{changed=false;for(const r of all){const parent=tracked.get(r.parent);if(parent&&alive(parent)&&!tracked.has(r.pid)){tracked.set(r.pid,r);changed=true;}}}while(changed);}catch(e){error??=e;}};
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024*1024)error??=Error('owned stdout bound exceeded');});
  child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1024*1024)error??=Error('owned stderr bound exceeded');});
  child.once('error',e=>{error=e;});child.once('close',(code,sig)=>{closed=true;status=code;signal=sig;});
  const end=Date.now()+15000;
  while(!closed&&!error&&Date.now()<end){scan();await delay(20);}
  scan();
  if(!closed||error||signal||[...tracked.values()].some(alive)){
   uncertain=true;
   for(const sig of ['SIGTERM','SIGKILL']){for(const row of [...tracked.values()].reverse())if(alive(row)){try{process.kill(row.pid,sig);}catch(e){if(e.code!=='ESRCH')error??=e;}}
    const bound=Date.now()+1500;while((!closed||[...tracked.values()].some(alive))&&Date.now()<bound)await delay(20);}
   child.stdout.destroy();child.stderr.destroy();
   assert.fail('Owned fixture execution did not settle normally; evidence retained '+root+'; remaining='+JSON.stringify([...tracked.values()].filter(alive))+'; '+(error?.message||signal||'deadline'));
  }
  assert.equal([...tracked.values()].some(alive),false,'owned tracked descendants must terminate');
  return {status,stdout,stderr};
 }
 return {root,source,link,task,evidence,run};
}
test('directory-symlink retention CLI dispatch matches direct refusal; imports remain inert',async t=>{
 const f=fixture(t,7);
 for(const dir of [f.source,f.link]){
  const url=pathToFileURL(join(dir,'retention.mjs')).href;
  const imported=await f.run(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(url)+'); console.log("IMPORT_ONLY")']);
  assert.equal(imported.status,0);assert.equal(imported.stdout.trim(),'IMPORT_ONLY');assert.equal(imported.stderr,'');assert.deepEqual(fs.readdirSync(f.evidence),[]);
  const r=await f.run(process.execPath,[join(dir,'retention.mjs'),'invalid-operation']);assert.equal(r.status,125);assert.match(r.stderr,/Verification evidence capture failed/);
 }
});
for(const exit of [7,0])test('installed directory-symlink verify executes actual task and preserves exit '+exit,async t=>{
 const f=fixture(t,exit),r=await f.run('bash',[join(f.link,'verify.sh'),f.task]);
 assert.equal(fs.existsSync(join(f.task,'task-marker')),true,'the task must actually execute');
 assert.match(r.stdout,/ACTUAL_TASK_RAN/);assert.equal(r.status,exit===0?0:1);
 assert.match(r.stdout,exit===0?/VERIFY: PASS\s*$/:/VERIFY: FAIL\s*$/);
 assert.match(r.stdout,new RegExp('\\['+exit+'\\] scripts/test\\.sh'));
 const match=r.stdout.match(/^VERIFY_EVIDENCE: (.+)$/m);assert.ok(match);assert.notEqual(match[1],'/manifest.json');
 const manifestPath=resolve(match[1]),inside=relative(f.evidence,manifestPath);assert.ok(inside&&inside!=='..'&&!inside.startsWith('../')&&!isAbsolute(inside));
 for(let path=manifestPath;;path=dirname(path)){assert.equal(fs.lstatSync(path).isSymbolicLink(),false);if(path===f.evidence)break;}
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));assert.equal(manifest.steps.length,1);assert.equal(manifest.steps[0].exitCode,exit);
 const log=manifest.steps[0].log;assert.equal(log.complete,true);assert.equal(typeof log.path,'string');assert.ok(log.path&&!isAbsolute(log.path)&&!log.path.split('/').includes('..'));
 const logPath=resolve(dirname(manifestPath),log.path),logInside=relative(f.evidence,logPath);assert.ok(logInside&&logInside!=='..'&&!logInside.startsWith('../')&&!isAbsolute(logInside));
 for(let path=logPath;;path=dirname(path)){assert.equal(fs.lstatSync(path).isSymbolicLink(),false);if(path===f.evidence)break;}
 const stat=fs.lstatSync(logPath);assert.ok(stat.isFile());assert.equal(stat.mode&0o777,0o600);
 const bytes=fs.readFileSync(logPath);assert.equal(bytes.length,log.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),log.sha256);assert.match(bytes.toString(),/ACTUAL_TASK_RAN/);
});
