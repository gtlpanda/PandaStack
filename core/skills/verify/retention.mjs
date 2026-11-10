// Private, bounded verification transcripts. Paths in command output are not authority.
import fs from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseScopeRecord,validateScopeJoin} from './scope-record.mjs';
export const STEP_LIMIT=16*1024*1024, RUN_LIMIT=128*1024*1024;
export function noSymlinks(path){
 const full=resolve(path);let current=full;
 for(;;){const st=fs.lstatSync(current);if(st.isSymbolicLink())throw Error('Evidence path contains a symlink');if(current===dirname(current))break;current=dirname(current);}
 return full;
}
export function privateRoot(path){
 const full=noSymlinks(path),st=fs.statSync(full);
 if(!st.isDirectory()||(st.mode&0o777)!==0o700||(process.getuid&&st.uid!==process.getuid()))throw Error('Evidence directory must be owned and private');
 return full;
}
export function invocation(parent){
 if(parent)parent=privateRoot(parent);
 else parent=fs.mkdtempSync(join(tmpdir(),'verify-evidence-'));
 const dir=fs.mkdtempSync(join(parent,'run-'));fs.chmodSync(dir,0o700);return dir;
}
export function writePrivate(path,bytes){
 const fd=fs.openSync(path,'wx',0o600);try{fs.writeFileSync(fd,bytes);}finally{fs.closeSync(fd);}
}
export function reference(root,path,complete=true){
 const full=noSymlinks(path),rel=relative(resolve(root),full);
 if(!rel||rel.startsWith('../')||isAbsolute(rel))throw Error('Evidence reference escapes its owner');
 const st=fs.statSync(full);if(!st.isFile()||(st.mode&0o777)!==0o600||st.size>RUN_LIMIT)throw Error('Evidence file is not a private bounded regular file');
 const data=fs.readFileSync(full);
 return {path:rel,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length,complete};
}
export function verifyManifest(root,path){
 // Check lexical containment before even stat/read: stdout cannot nominate a host file.
 const allocation=privateRoot(root),full=resolve(path),rel=relative(allocation,full);
 if(!rel||rel.startsWith('../')||isAbsolute(rel))throw Error('Verification manifest is outside its allocated capture');
 noSymlinks(full);
 const ref=reference(allocation,full);if(ref.bytes>1024*1024)throw Error('Verification manifest is too large');
 const manifests=[];let entries=0,metadata=0;
 const walk=(dir,depth)=>{if(depth>32)throw Error('Verification capture nesting is too deep');for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++entries>20000)throw Error('Verification capture has too many entries');const path=join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Verification capture contains a symlink');if(entry.isDirectory())walk(path,depth+1);else if(entry.name==='manifest.json'){const st=fs.statSync(path);metadata+=st.size;if(metadata>1024*1024)throw Error('Verification metadata exceeds its limit');manifests.push(path);}}};walk(allocation,0);
 let total=0,complete=!fs.existsSync(join(dirname(full),'.incomplete'));const seen=new Set();
 for(const manifest of manifests){
  complete&&=!fs.existsSync(join(dirname(manifest),'.incomplete'));
  reference(allocation,manifest);const doc=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(doc.schemaVersion!==1||!Array.isArray(doc.steps)||doc.steps.length>10000)throw Error('Invalid verification manifest');
  for(const step of doc.steps){
   const log=step?.log;
   if(typeof step?.label!=='string'||!Number.isInteger(step.exitCode)||!log||typeof log.path!=='string'||!log.path||log.path.includes(String.fromCharCode(92))||isAbsolute(log.path)||log.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid verification step reference');
   const target=resolve(dirname(manifest),log.path),inside=relative(allocation,target);
   if(inside.startsWith('../')||isAbsolute(inside)||seen.has(target))throw Error('Verification step is outside its capture or repeated');seen.add(target);
   const actual=reference(dirname(manifest),target,log.complete);
   if(typeof log.complete!=='boolean'||actual.bytes!==log.bytes||actual.sha256!==log.sha256||actual.bytes>STEP_LIMIT)throw Error('Verification log integrity mismatch');
   total+=actual.bytes;if(total>RUN_LIMIT)throw Error('Verification evidence exceeds invocation limit');complete&&=log.complete;
  }
 }
 const rootDoc=JSON.parse(fs.readFileSync(full,'utf8')),others=manifests.filter(p=>p!==full);
 const children=rootDoc.children||[];if(!Array.isArray(children)||children.length!==others.length)throw Error('Nested verification references are incomplete');
 const childPaths=new Set();for(const child of children){if(!child||typeof child.path!=='string'||isAbsolute(child.path)||child.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid nested manifest reference');const target=resolve(dirname(full),child.path);if(!others.includes(target)||childPaths.has(target))throw Error('Unknown nested manifest reference');childPaths.add(target);const actual=reference(dirname(full),target);if(actual.sha256!==child.sha256||actual.bytes!==child.bytes||child.complete!==true)throw Error('Nested manifest integrity mismatch');}
 return {...ref,complete};
}
function procRow(pid){
 const raw=fs.readFileSync('/proc/'+pid+'/stat','utf8'),v=raw.slice(raw.lastIndexOf(')')+2).split(' ');
 return {pid,parentPid:Number(v[1]),start:v[19],pgid:Number(v[2]),state:v[0]};
}
function scopeFiles(path){
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||/[\r\n\0]/.test(path))throw Error('Invalid capture scope');
 privateRoot(path);
 if((fs.lstatSync(path).mode&0o7777)!==0o700)throw Error('Invalid capture scope');
 for(const [name,fifo] of [['scope-v1.tsv',false],['stop',true]]){
  const st=fs.lstatSync(join(path,name));
  if(st.isSymbolicLink()||(fifo?!st.isFIFO():!st.isFile())||(st.mode&0o7777)!==0o600||st.uid!==process.getuid()||(!fifo&&st.size>256))throw Error('Invalid capture scope');
 }
 return parseScopeRecord(fs.readFileSync(join(path,'scope-v1.tsv'),'utf8'));
}
function joinScope(path){
 const record=scopeFiles(path),owner=procRow(record.ownerPid),anchor=procRow(record.anchorPid),current=procRow(process.pid),lineage=[];
 let row=current;
 for(let n=0;n<256;n++){lineage.push(row);if(row.pid===anchor.pid)break;row=procRow(row.parentPid);}
 const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(!validateScopeJoin(record,{bootId,owner,anchor,current,lineage}))throw Error('Invalid capture scope');
 // Reobserve the authoritative births next to admission, not just at path lookup.
 if(procRow(owner.pid).start!==owner.start||procRow(anchor.pid).start!==anchor.start)throw Error('Invalid capture scope');
 return record;
}
async function requestStop(path,joined){
 const until=performance.now()+250;
 do{
  let fd;
  try{
   if(joined)joinScope(path);
   fd=fs.openSync(join(path,'stop'),fs.constants.O_WRONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
   const st=fs.fstatSync(fd);
   if(!st.isFIFO()||(st.mode&0o7777)!==0o600||st.uid!==process.getuid())return false;
   return fs.writeSync(fd,Buffer.from('STOP\n'))===5;
  }catch(e){if(!['ENOENT','ENXIO','EAGAIN'].includes(e.code))return false;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  await new Promise(r=>setTimeout(r,10));
 }while(performance.now()<until);
 return false;
}
// The shared owner holds local signal authority. Joined helpers never detach.
async function capture(argv,limit,write,allocation){
 const joined=Object.hasOwn(process.env,'VERIFY_CAPTURE_SCOPE_DIR');
 const scope=joined?process.env.VERIFY_CAPTURE_SCOPE_DIR:fs.mkdtempSync(join(privateRoot(allocation),'scope-'));
 try{if(joined)joinScope(scope);else fs.chmodSync(scope,0o700);}
 catch{return {exitCode:125,bytes:0,complete:false};}
 let bytes=0,complete=true,child,deadline,settled=false,stopping=false;
 let finish=()=>{};
 const stop=()=>{
  complete=false;if(stopping)return;stopping=true;
  if(!joined){try{writePrivate(join(scope,'.closing'),'closing\n');}catch{}}
  // No inherited record or message ever becomes a signal destination here.
  void requestStop(scope,joined);
  deadline=setTimeout(()=>{child?.stdout.destroy();child?.unref();finish(125);},4000);
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{return await new Promise(resolveResult=>{
  finish=code=>{
   if(settled)return;settled=true;
   if(joined){try{joinScope(scope);}catch{complete=false;}}
   if(!Number.isInteger(code)||fs.existsSync(join(scope,'.incomplete'))||(!joined&&!fs.existsSync(join(scope,'.settled'))))complete=false;
   resolveResult({exitCode:complete?code:125,bytes,complete});
  };
  try{child=spawn('bash',[fileURLToPath(new URL('./capture-owner.sh',import.meta.url)),'run',scope,'--',...argv],{detached:false,stdio:['ignore','pipe','ignore']});}
  catch{complete=false;return finish(125);}
  child.stdout.on('data',data=>{
   if(!complete)return;
   const remaining=limit-bytes,part=data.subarray(0,Math.max(0,remaining));
   try{write(part);bytes+=part.length;}catch{stop();}
   if(data.length>remaining)stop();
  });
  child.stdout.on('error',stop);
  child.on('error',()=>{complete=false;finish(125);});child.on('close',finish);
 });}finally{clearTimeout(deadline);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
function sessionBudget(session,change){
 const root=privateRoot(session),lock=join(root,'.budget-lock');let locked=false;
 for(let n=0;n<200&&!locked;n++){try{fs.mkdirSync(lock,{mode:0o700});locked=true;}catch(e){if(e.code!=='EEXIST')throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
 if(!locked)throw Error('Verification evidence budget is unavailable');
 try{const path=join(root,'.budget');noSymlinks(path);const used=Number(fs.readFileSync(path,'utf8'));if(!Number.isSafeInteger(used)||used<0||used>RUN_LIMIT)throw Error('Invalid evidence budget');const amount=change===null?Math.min(STEP_LIMIT,RUN_LIMIT-used):change;const next=used+amount;if(next<0||next>RUN_LIMIT)throw Error('Invalid evidence reservation');fs.writeFileSync(path,String(next));return amount;}finally{fs.rmdirSync(lock);}
}
let activeSession=null;
function markIncomplete(){if(activeSession){try{writePrivate(join(activeSession,'.incomplete'),'capture incomplete\n');}catch{}}}
async function main(args){
 if(args[0]==='init'){
  const session=args[2]||null;if(session){const owner=privateRoot(args[1]);const rel=relative(owner,resolve(session));if(rel.startsWith('../')||isAbsolute(rel))throw Error('Invalid capture session');privateRoot(session);}
  const dir=invocation(session||args[1]||undefined);activeSession=session||dir;writePrivate(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,steps:[]})+'\n');if(!session)writePrivate(join(dir,'.budget'),'0');console.log(dir);return 0;
 }
 if(args[0]==='finalize'){
  const dir=privateRoot(args[1]),session=privateRoot(args[2]);if(dir!==session)return 0;
  const path=join(dir,'manifest.json'),doc=JSON.parse(fs.readFileSync(path,'utf8')),children=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory()&&entry.name.startsWith('run')){const child=join(dir,entry.name,'manifest.json');if(fs.existsSync(child))children.push(reference(dir,child));}}
  doc.children=children;const next=join(dir,'final-'+randomUUID()+'.tmp');writePrivate(next,JSON.stringify(doc)+'\n');fs.renameSync(next,path);
  return verifyManifest(dir,path).complete&&!fs.existsSync(join(session,'.incomplete'))?0:125;
 }
 if(args[0]==='relay'){
  let offset=1,receipt=null;if(args[offset]==='--receipt'){receipt=args[offset+1];privateRoot(dirname(receipt));if(basename(receipt)!=='capture.json')throw Error('Invalid capture receipt');offset+=2;}if(args[offset]!=='--'||args.length<offset+2)throw Error('Invalid capture invocation');
  const allocation=receipt?dirname(receipt):invocation();
  const result=await capture(args.slice(offset+1),STEP_LIMIT,b=>fs.writeFileSync(1,b),allocation);if(receipt)writePrivate(receipt,JSON.stringify({schemaVersion:1,...result})+'\n');return result.exitCode;
 }
 if(args[0]==='step'){
  const dir=privateRoot(args[1]),label=args[2];if(!label||args[3]!=='--'||args.length<5)throw Error('Invalid verification capture');
  const manifest=join(dir,'manifest.json');noSymlinks(manifest);
  const doc=JSON.parse(fs.readFileSync(manifest,'utf8'));const session=privateRoot(process.env.VERIFY_CAPTURE_SESSION||dir),inside=relative(session,dir);if(inside.startsWith('../')||isAbsolute(inside))throw Error('Invalid capture session');activeSession=session;const reservation=sessionBudget(session,null);
  const file=join(dir,'step-'+randomUUID()+'.log'),fd=fs.openSync(file,'wx',0o600);let result;
  try{result=reservation?await capture(args.slice(4),reservation,b=>fs.writeFileSync(fd,b),dir):{exitCode:125,bytes:0,complete:false};}finally{let retained;try{retained=fs.fstatSync(fd).size;if(result)result.bytes=retained;}finally{fs.closeSync(fd);}sessionBudget(session,retained-reservation);}
  if(!result.complete)markIncomplete();
  doc.steps.push({label,exitCode:result.exitCode,log:reference(dir,file,result.complete)});
  const next=join(dir,'manifest-'+randomUUID()+'.tmp');writePrivate(next,JSON.stringify(doc)+'\n');fs.renameSync(next,manifest);
  console.log(file);return result.exitCode;
 }
 throw Error('Unknown verification capture operation');
}
function isMain(){
 // Installed skills use directory symlinks; Node canonicalizes the module URL.
 if(!process.argv[1])return false;
 try{return fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}
}
if(isMain()){
 try{process.exitCode=await main(process.argv.slice(2));}catch{markIncomplete();console.error('Verification evidence capture failed');process.exitCode=125;}
}
