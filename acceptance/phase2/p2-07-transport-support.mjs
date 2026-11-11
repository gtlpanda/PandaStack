import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {load,setup,git,bounded} from './p2-trace-integration-support.mjs';
export const count=200;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runCliTransport(t,stalled){
 const api=await load(),f=setup(api,t,'codex');
 const ids=Array.from({length:count},(_,i)=>'bulk-'+i),cfgPath=join(f.repo,'autobuild.json'),cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
 cfg.decisions.ids=ids;fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));git(f.repo,'add','autobuild.json');git(f.repo,'commit','-qm','bounded transport fixture');
 const revision=git(f.repo,'rev-parse','HEAD');
 for(const id of ids){f.queue.request({schemaVersion:1,id,runId:'logical-trace',repo:f.repo,revision,question:'Pick fixture color',reason:'Bounded stdout fixture',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}],recommendation:null,evidence:[],kind:'question',scope:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:null});f.queue.answer(id,{answerId:'answer-'+id,value:'blue',actor:'fixture',at:new Date().toISOString(),revision});}
 const marker=join(f.base,'closure-write.json'),observer=join(f.base,'stdout-observer.mjs');
 fs.writeFileSync(observer,[
 "import fs from 'node:fs';",
 "const original=process.stdout.write;",
 "process.stdout.write=function(value,...args){const result=original.call(this,value,...args);const line=String(value);if(line.startsWith('PANDASTACK_DECISION ')&&JSON.parse(line.slice(20)).event==='trace_closed')fs.writeFileSync("+JSON.stringify(marker)+",JSON.stringify({returned:result,pendingBytes:this.writableLength,at:Date.now()}));return result;};"
 ].join('\n'));
 const previous=process.env.NODE_OPTIONS;
 let proc;try{process.env.NODE_OPTIONS=(previous?previous+' ':'')+'--import='+pathToFileURL(observer).href;proc=f.launch();}finally{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
 if(stalled)proc.child.stdout.pause();
 if(stalled){
  try{
   const deadline=Date.now()+60000;while(!fs.existsSync(marker)){if(Date.now()>deadline)throw Error('closure marker deadline');if(proc.child.exitCode!==null||proc.child.signalCode!==null)throw Error('CLI exited before closure attempt marker');await sleep(2);}
   await sleep(100);
  }finally{proc.child.stdout.resume();}
 }
 const result=await bounded(proc.done,60000),events=[],malformed=[];
 for(const line of result.out.split('\n'))if(line.startsWith('PANDASTACK_DECISION ')){try{events.push(JSON.parse(line.slice(20)));}catch{malformed.push(line.length);}}
 return {code:result.code,signal:result.signal,events,malformed,marker:fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')):null,featurePassed:f.passed(),calls:f.argv().length,bytes:Buffer.byteLength(result.out)};
}
