import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
function birth(pid){try{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');const fields=s.slice(s.lastIndexOf(')')+2).split(' ');return {pid,start:fields[19],state:fields[0]};}catch{return null;}}
function live(record){const now=record&&birth(record.pid);return now&&now.start===record.start&&now.state!=='Z';}
function killOwned(record){if(live(record))try{process.kill(record.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
const owned=new Set();
const watchdog=setTimeout(()=>{for(const record of owned)killOwned(record);process.stderr.write('CAPTURE_DESCENDANT_WATCHDOG cleanup uncertain\n');process.exit(97);},20000);watchdog.unref();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bound(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned capture deadline')),ms))]);}finally{clearTimeout(timer);}}
test('bounded capture failure settles same-group child after its direct payload parent exits',{timeout:15000},async t=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'capture-descendant-'));fs.chmodSync(dir,0o700);
 const marker=join(dir,'child.json'),writer=join(dir,'writer.mjs'),launcher=join(dir,'launcher.mjs'),output=join(dir,'transcript.log');
 fs.writeFileSync(writer,[
  "import fs from 'node:fs';",
  "const me=fs.readFileSync('/proc/self/stat','utf8');const fields=me.slice(me.lastIndexOf(')')+2).split(' ');",
  "fs.writeFileSync("+JSON.stringify(marker)+",JSON.stringify({pid:process.pid,start:fields[19]}));",
  "const parent=Number(process.argv[2]);let gone=false;const deadline=Date.now()+3000;",
  "while(!gone&&Date.now()<deadline){try{const raw=fs.readFileSync('/proc/'+parent+'/stat','utf8');gone=raw.slice(raw.lastIndexOf(')')+2).split(' ')[0]==='Z';}catch(e){if(e.code==='ENOENT')gone=true;else throw e;}if(!gone)await new Promise(r=>setTimeout(r,10));}",
  "if(!gone)throw Error('owned payload parent did not exit');",
  "process.stdout.on('error',()=>{});process.stdout.write(Buffer.alloc(17*1024*1024,120));setInterval(()=>{},1000);"
 ].join('\n'),{mode:0o600});
 fs.writeFileSync(launcher,[
  "import {spawn} from 'node:child_process';",
  "spawn(process.execPath,["+JSON.stringify(writer)+",String(process.pid)],{stdio:['ignore','inherit','inherit']});process.exit(0);"
 ].join('\n'),{mode:0o600});
 const fd=fs.openSync(output,'wx',0o600);let child,helper,leaf,done,stderr='',inspectionUncertain=false;
 const tree=new Map();
 function remember(record){if(record){tree.set(record.pid+':'+record.start,record);owned.add(record);}}
 function observeTree(record){
  if(!live(record))return;remember(record);
  let children;try{children=fs.readFileSync('/proc/'+record.pid+'/task/'+record.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean);}
  catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')inspectionUncertain=true;return;}
  for(const pid of children){const found=birth(Number(pid));if(found)observeTree(found);}
 }
 t.after(async()=>{
  try{
   if(!leaf&&fs.existsSync(marker)){leaf=JSON.parse(fs.readFileSync(marker,'utf8'));owned.add(leaf);}
   observeTree(helper);if(leaf)remember(leaf);for(const record of [...tree.values()].reverse())killOwned(record);killOwned(leaf);killOwned(helper);
   if(done)await bound(done,3000);
   const until=Date.now()+3000;while((live(leaf)||live(helper)||[...tree.values()].some(live))&&Date.now()<until)await sleep(10);
   assert.ok(!inspectionUncertain&&!live(leaf)&&!live(helper)&&![...tree.values()].some(live),'cleanup must settle captured owned tree identities');
   fs.rmSync(dir,{recursive:true,force:true});
  }finally{for(const record of tree.values())if(!live(record))owned.delete(record);if(leaf&&!live(leaf))owned.delete(leaf);if(helper&&!live(helper))owned.delete(helper);}
 });
 try{child=spawn(process.execPath,[join(ROOT,'core/skills/verify/retention.mjs'),'relay','--',process.execPath,launcher],{detached:true,stdio:['ignore',fd,'pipe']});}finally{fs.closeSync(fd);}
 helper=birth(child.pid);remember(helper);observeTree(helper);child.stderr.on('data',b=>{if(stderr.length<8192)stderr+=b.toString();});
 done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 const deadline=Date.now()+5000;while(!fs.existsSync(marker)&&Date.now()<deadline){observeTree(helper);await sleep(10);}
 assert.ok(fs.existsSync(marker),'owned writer must actually launch');leaf=JSON.parse(fs.readFileSync(marker,'utf8'));remember(leaf);observeTree(helper);
 const result=await bound(done,6000);assert.equal(result.code,125,stderr);assert.equal(result.signal,null);
 assert.ok(fs.statSync(output).size<=16*1024*1024,'retained prefix stays bounded');
 const settle=Date.now()+1000;while(live(leaf)&&Date.now()<settle)await sleep(10);
 assert.equal(Boolean(live(leaf)),false,'capture returned after abandoning its still-running owned descendant');
});
