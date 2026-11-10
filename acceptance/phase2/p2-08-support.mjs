import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
export const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
export function fixture(t,deny=true){
 const dir=fs.mkdtempSync(join(tmpdir(),'p2-sqlite-boundary-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const marker=join(dir,'sqlite-imports.jsonl'),loader=join(dir,'sqlite-loader.mjs'),store=join(dir,'queue');
 fs.writeFileSync(loader,[
 "import fs from 'node:fs';",
 "export async function resolve(specifier,context,nextResolve){if(specifier==='node:sqlite'){fs.appendFileSync("+JSON.stringify(marker)+",JSON.stringify({specifier})+'\\n');"+
 (deny?"const error=new Error('No such built-in module: node:sqlite');error.code='ERR_UNKNOWN_BUILTIN_MODULE';throw error;":"")+
 "}return nextResolve(specifier,context);}"
 ].join('\n'));
 const run=(args)=>spawnSync(process.execPath,['--experimental-loader',pathToFileURL(loader).href,...args],{cwd:dir,env:{...process.env,NODE_OPTIONS:''},encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:1024*1024});
 return {dir,store,run,imports:()=>fs.existsSync(marker)?fs.readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse):[],url:rel=>pathToFileURL(join(ROOT,rel)).href};
}
export function sourceRun(f,source){return f.run(['--input-type=module','-e',source]);}
export function gateSource(f,mode){
 return [
 "import fs from 'node:fs';",
 'import {prepareDecisionGate} from '+JSON.stringify(f.url('graphs/autobuild/tool/lib/decisions.mjs'))+';',
 "let reads=0;const observed=[];const trace=new Proxy({}, {get:(_,method)=>(...args)=>{observed.push(String(method));return undefined;}});",
 'const config={root:'+JSON.stringify(f.dir)+',decisions:'+JSON.stringify(mode==='disabled'?undefined:{store:f.store,runId:'logical',featureId:'F-1',ids:['choice'],timeoutMs:0})+'};',
 'const feature='+JSON.stringify({id:mode==='unassigned'?'F-2':'F-1',passes:mode==='completed'})+';',
 "try{const gate=await prepareDecisionGate({config,feature,trace,readRevision:()=>{reads++;return 'a'.repeat(40);}});console.log(JSON.stringify({returnedNull:gate===null,reads,observed,storeExists:fs.existsSync("+JSON.stringify(f.store)+")}));gate?.close();}catch(error){console.log(JSON.stringify({error:{code:error.code??null,message:String(error.message)},reads,observed,storeExists:fs.existsSync("+JSON.stringify(f.store)+")}));}"
 ].join('\n');
}
