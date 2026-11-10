import fs from 'node:fs';
import os from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
let cleanupUncertain=false;
export function markCleanupUncertain(){cleanupUncertain=true;}
export const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
export const evidenceURL=pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href;
export async function api(){const a=await import(evidenceURL);assert.equal(typeof a.createSuiteExport,'function');assert.equal(typeof a.wrapIsolation,'function');return a;}
export function fixture(t){const base=fs.mkdtempSync(join(os.tmpdir(),'harness-boundary-'));fs.chmodSync(base,0o700);const repo=join(base,'source repo');fs.mkdirSync(repo);const home=join(base,'home');fs.mkdirSync(home);const env={...process.env,HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@invalid'};for(const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','NODE_OPTIONS'])delete env[k];t.after(()=>{if(cleanupUncertain)throw Error('Owned process cleanup unconfirmed; fixture retained at '+base);fs.rmSync(base,{recursive:true,force:true})});return {base,repo,env};}
export function git(f,dir,...args){const r=spawnSync('git',['-C',dir,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],{env:f.env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});assert.equal(r.status,0,r.stderr);return r.stdout.replace(/\n$/,'');}
export function put(p,s,mode){fs.mkdirSync(dirname(p),{recursive:true});fs.writeFileSync(p,s);if(mode)fs.chmodSync(p,mode);}
export function init(f){git(f,f.repo,'init','-q','--template=','-b','main');}
export function commit(f){git(f,f.repo,'add','-A');git(f,f.repo,'commit','-qm','owned fixture');return git(f,f.repo,'rev-parse','HEAD');}
export async function run(argv,{cwd,env,limit=15000}={}){const p=spawn(argv[0],argv.slice(1),{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});const leader=birth(p.pid);let stdout='',stderr='',timeout=false,timer,joinTimer;p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);try{return await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',(code,signal)=>resolve({code,signal,stdout,stderr,timeout}));timer=setTimeout(()=>{timeout=true;if(leader&&runnable(leader)){try{process.kill(-p.pid,'SIGKILL')}catch{cleanupUncertain=true;}}else{cleanupUncertain=true;}joinTimer=setTimeout(()=>{cleanupUncertain=true;reject(Error('Owned child did not join within 3 seconds after kill'));},3000);},limit);});}finally{clearTimeout(timer);clearTimeout(joinTimer);}}

export function birth(pid){try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),v=raw.slice(raw.lastIndexOf(')')+2).split(' ');return {pid,start:v[19],state:v[0]};}catch{return null;}}
export function descendants(pid){const result=[];function visit(id){const b=birth(id);if(!b)return;result.push(b);for(const c of fs.readFileSync(`/proc/${id}/task/${id}/children`,'utf8').trim().split(/\s+/).filter(Boolean))visit(Number(c));}visit(pid);return result;}
export function runnable(b){const n=birth(b.pid);return n&&n.start===b.start&&n.state!=='Z';}
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export const probeSource=String.raw`import fs from 'node:fs';import os from 'node:os';import {spawnSync} from 'node:child_process';import {join} from 'node:path';
const p=fs.mkdtempSync(join(process.argv[2],'permission-'));fs.chmodSync(p,0o500);let permission;
try{fs.writeFileSync(join(p,'owned'),'x');permission='writable'}catch(e){permission=e.code}finally{fs.chmodSync(p,0o700);fs.rmSync(p,{recursive:true,force:true})}
const links=spawnSync('ip',['-j','link','show'],{encoding:'utf8'});if(links.status!==0)throw Error('link inspection failed');
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),pid:process.pid,permission,caps:fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^Cap(Inh|Prm|Eff|Bnd|Amb):/.test(x)),namespaces:Object.fromEntries(['pid','net','user'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)])),links:JSON.parse(links.stdout),args:process.argv.slice(3)}));`;
