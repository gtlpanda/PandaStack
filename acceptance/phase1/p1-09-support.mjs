import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const load=async()=>({...await import(pathToFileURL(join(ROOT,'core/skills/run-records/doctor.mjs'))),...await import(pathToFileURL(join(ROOT,'graphs/autobuild/tool/lib/config.mjs')))});
export const supported=()=>({version:'fixture-1.0',controls:Object.fromEntries(['model','effort','concurrency'].map(k=>[k,{status:'supported',evidence:'Trusted injected callback only; no process executes.'}]))});
export async function inspect({backend,project={},env={},overrides={}}){
 const {inspectDoctor,loadConfig}=await load();
 const repo=mkdtempSync(join(tmpdir(),'p1-effective-model-'));
 try{
  writeFileSync(join(repo,'autobuild.json'),JSON.stringify({backend,...project}));
  let selected=null,launchError=null,calls=0;
  try{selected=loadConfig(repo,env,{backend,...overrides});}catch(e){launchError=e.message;}
  const report=await inspectDoctor({repo,pandaRoot:ROOT,backend,env,overrides,capabilityProbe:async()=>{calls++;return supported();}});
  return {selected,launchError,calls,report};
 }finally{rmSync(repo,{recursive:true,force:true});}
}
