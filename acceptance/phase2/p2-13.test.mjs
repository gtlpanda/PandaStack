// PREPARATION ONLY: two immediate normal-success path cases. Not frozen or executed.
// Host Node test runner stays outside the restricted verifier PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const BASH='/bin/bash';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const owned=new Map();
function birth(pid){try{const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),v=s.slice(s.lastIndexOf(')')+2).split(' ');return {pid,start:v[19],state:v[0]};}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e;}}
const live=r=>{const n=r&&birth(r.pid);return n&&n.start===r.start&&n.state!=='Z';};
function signalOwned(r,sig){if(live(r))try{process.kill(r.pid,sig)}catch(e){if(e.code!=='ESRCH')throw e;}}
const watchdog=setTimeout(()=>{for(const r of [...owned.values()].reverse())signalOwned(r,'SIGKILL');console.error('NORMAL_SUCCESS_WATCHDOG: incomplete; cleanup unconfirmed');process.exit(97)},90000);watchdog.unref();
const quote=s=>"'"+s.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
const runtimeCheck='for tool in node nodejs python python3; do if command -v \"$tool\" >/dev/null 2>&1; then exit 96; fi; done\nprintf \"NO_OPTIONAL_RUNTIME_%s\\n\" \"$kind\"\n';
const markerBody="read_proc() {\n  local id=\"$1\" raw tail\n  IFS= read -r raw < \"/proc/$id/stat\"\n  tail=\"${raw##*) }\"\n  read -r -a proc_fields <<< \"$tail\"\n  ROW_PID=\"$id\"; ROW_PARENT=\"${proc_fields[1]}\"; ROW_START=\"${proc_fields[19]}\"; ROW_PGID=\"${proc_fields[2]}\"; ROW_STATE=\"${proc_fields[0]}\"\n}\nemit_row() { printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$ROW_PID\" \"$ROW_PARENT\" \"$ROW_START\" \"$ROW_PGID\" \"$ROW_STATE\"; }\nself=\"$BASHPID\"\nIFS= read -r scope_line < \"$VERIFY_CAPTURE_SCOPE_DIR/scope-v1.tsv\"\nIFS=$'\\t' read -r -a scope_fields <<< \"$scope_line\"\nIFS= read -r boot < /proc/sys/kernel/random/boot_id\n{\n  printf 'TASK\\t%s\\n' \"$kind\"\n  printf 'BOOT\\t%s\\n' \"$boot\"\n  printf 'SCOPE\\t%s\\n' \"$scope_line\"\n  read_proc \"$self\"; emit_row CURRENT\n  read_proc \"${scope_fields[3]}\"; emit_row OWNER\n  cursor=\"$self\"; reached=false\n  for ((n=0;n<256;n++)); do\n    read_proc \"$cursor\"; emit_row ROW\n    if [[ \"$cursor\" == \"${scope_fields[5]}\" ]]; then reached=true; break; fi\n    cursor=\"$ROW_PARENT\"\n  done\n  [[ \"$reached\" == true ]]\n} >> \"$marker\"\nprintf 'NORMAL_TASK_%s\\n' \"$kind\"\n";
function observation(file,parse){const lines=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(l=>l.split('\t'));const select=tag=>lines.filter(l=>l[0]===tag);for(const tag of ['TASK','BOOT','SCOPE','CURRENT','OWNER'])assert.equal(select(tag).length,1,'one normal task execution and snapshot');const row=a=>({pid:Number(a[1]),parentPid:Number(a[2]),start:a[3],pgid:Number(a[4]),state:a[5]});const record=parse(select('SCOPE')[0].slice(1).join('\t')+'\n');const lineage=select('ROW').map(row);return {record,facts:{bootId:select('BOOT')[0][1],owner:row(select('OWNER')[0]),current:row(select('CURRENT')[0]),anchor:lineage.at(-1),lineage}};}

function verifyRetained(evidence,stdout){
 const refs=[...stdout.matchAll(/^VERIFY_EVIDENCE: (.+)$/gm)];assert.ok(refs.length);const top=resolve(refs.at(-1)[1]);const seen=new Set(),texts=[];let manifests=0;
 function file(path,limit){const rel=relative(evidence,path);assert.ok(rel&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel));for(let p=path;;p=dirname(p)){const st=fs.lstatSync(p);assert.equal(st.isSymbolicLink(),false);if(p===evidence)break;}const st=fs.lstatSync(path);assert.ok(st.isFile());assert.equal(st.mode&0o777,0o600);assert.ok(st.size<=limit);return fs.readFileSync(path);}
 function referenced(parent,ref,limit){assert.equal(ref.complete,true);assert.equal(typeof ref.path,'string');assert.ok(ref.path&&!isAbsolute(ref.path)&&!ref.path.includes(String.fromCharCode(92))&&!ref.path.split('/').some(x=>!x||x==='.'||x==='..'));const path=resolve(parent,ref.path),bytes=file(path,limit);assert.equal(bytes.length,ref.bytes);assert.match(ref.sha256,/^[0-9a-f]{64}$/,'BUGHUNT-F3 digest must not contain checksum filename escaping');assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256,'BUGHUNT-F3 retained bytes must match digest');return {path,bytes};}
 function walk(path,depth){assert.ok(depth<=4);assert.equal(seen.has(path),false);seen.add(path);manifests++;const raw=file(path,1024*1024);let doc;assert.doesNotThrow(()=>{doc=JSON.parse(raw.toString('utf8'));},'BUGHUNT-F3 normal completion must publish valid JSON');assert.equal(doc.schemaVersion,1);assert.equal(doc.steps.length,1);for(const step of doc.steps){assert.equal(step.exitCode,0);texts.push(referenced(dirname(path),step.log,16*1024*1024).bytes.toString());}for(const child of doc.children??[]){const next=referenced(dirname(path),child,1024*1024);walk(next.path,depth+1);}}
 walk(top,0);assert.equal(manifests,2,'root and actual nested verification manifests retained');assert.ok(texts.some(t=>t.includes('NORMAL_TASK_outer')));assert.ok(texts.some(t=>t.includes('NORMAL_TASK_inner')));assert.ok(texts.some(t=>t.includes('NO_OPTIONAL_RUNTIME_outer')));assert.ok(texts.some(t=>t.includes('NO_OPTIONAL_RUNTIME_inner')));
}

for (const [label,evidenceName] of [['ordinary','evidence'],['literal-backslash','verify'+String.fromCharCode(92)+'logs']]) test('no-Node immediate normal completion retains valid evidence under '+label+' parent',async t=>{
 const {parseScopeRecord,validateScopeJoin}=await import(pathToFileURL(join(ROOT,'core/skills/verify/scope-record.mjs')).href);
 const base=fs.mkdtempSync(join(tmpdir(),'verify-no-node-normal-group-'));fs.chmodSync(base,0o700);let uncertain=false;
 t.after(()=>{if(!uncertain)fs.rmSync(base,{recursive:true,force:true});});
 const outer=join(base,'outer'),inner=join(base,'inner'),evidence=join(base,evidenceName);for(const p of [outer,inner])fs.mkdirSync(join(p,'scripts'),{recursive:true});fs.mkdirSync(evidence,{mode:0o700});
 const verify=join(ROOT,'core/skills/verify/verify.sh'),outerMarker=join(base,'outer.tsv'),innerMarker=join(base,'inner.tsv');
 fs.writeFileSync(join(inner,'scripts/test.sh'),'#!/bin/bash\nset -euo pipefail\nkind=inner\nmarker='+quote(innerMarker)+'\n'+runtimeCheck+markerBody+'exit 0\n',{mode:0o700});
 fs.writeFileSync(join(outer,'scripts/test.sh'),'#!/bin/bash\nset -euo pipefail\nkind=outer\nmarker='+quote(outerMarker)+'\n'+runtimeCheck+markerBody+quote(BASH)+' '+quote(verify)+' '+quote(inner)+'\nexit 0\n',{mode:0o700});
 const bin=join(base,'bin');fs.mkdirSync(bin,{mode:0o700});
 // Historical compatibility fixture allowlist, excluding its flood-only `yes`;
 // timeout is an existing mandatory primitive of the reviewed scope protocol.
 const tools=['bash','dirname','tail','env','stat','sha256sum','mktemp','mkdir','chmod','head','wc','mv','rm','setsid','sleep','mkfifo','rmdir','timeout'];
 for(const tool of tools){const target=fs.realpathSync('/usr/bin/'+tool);assert.ok(fs.statSync(target).isFile());fs.accessSync(target,fs.constants.X_OK);fs.symlinkSync(target,join(bin,tool));}
 assert.deepEqual(fs.readdirSync(bin).sort(),tools.slice().sort());
 for(const absent of ['node','nodejs','python','python3'])assert.equal(fs.existsSync(join(bin,absent)),false);
 const env={...process.env,PATH:bin,HOME:base,VERIFY_EVIDENCE_DIR:evidence};for(const k of ['VERIFY_CAPTURE_SESSION','VERIFY_CAPTURE_SCOPE_DIR','VERIFY_ALLOW_NO_TESTS','NODE_OPTIONS','BASH_ENV','ENV'])delete env[k];
 const child=spawn(BASH,[verify,outer],{cwd:base,env,detached:true,stdio:['ignore','pipe','pipe']});const anchor=birth(child.pid);if(anchor)owned.set(anchor.pid,anchor);let stdout='',stderr='',closed=false,code=null,signal=null,error=null;
 child.stdout.on('data',b=>{if(stdout.length+b.length<=1024*1024)stdout+=b;else error??=Error('unexpected normal-output bound');});child.stderr.on('data',b=>{if(stderr.length+b.length<=1024*1024)stderr+=b;else error??=Error('unexpected normal-error bound');});child.on('error',e=>error=e);child.on('close',(c,s)=>{closed=true;code=c;signal=s;});
 function inspect(r){if(!live(r))return;let ids;try{ids=fs.readFileSync(`/proc/${r.pid}/task/${r.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean);}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return;throw e;}for(const id of ids){const n=birth(Number(id));if(n){const prior=owned.get(n.pid);if(prior&&prior.start!==n.start)throw Error('owned process identity changed');owned.set(n.pid,n);inspect(n);}}}
 try{
  const until=Date.now()+30000;while(!closed&&!error&&Date.now()<until){inspect(anchor);await delay(20);}inspect(anchor);
  if(!closed||signal||error||[...owned.values()].some(live)){uncertain=true;throw Error('normal completion incomplete: '+(error?.message||signal||'deadline or live owned resource'));}
  assert.equal(code,0,stderr+'\n'+stdout);assert.match(stdout,/VERIFY: PASS\s*$/);verifyRetained(evidence,stdout);
  const a=observation(outerMarker,parseScopeRecord),b=observation(innerMarker,parseScopeRecord);assert.equal(validateScopeJoin(a.record,a.facts),true);assert.equal(validateScopeJoin(b.record,b.facts),true);
  assert.deepEqual(a.record,b.record,'one root-issued scope for this outer tree');assert.equal(a.facts.current.pgid,b.facts.current.pgid);assert.equal(a.facts.current.pgid,a.record.anchorPid);assert.equal(a.record.anchorPid,a.record.pgid);assert.notEqual(a.facts.owner.pgid,a.record.pgid);
  for(const x of [a,b]){assert.equal(x.facts.anchor.pid,x.record.anchorPid);assert.equal(x.facts.anchor.start,x.record.anchorStart);assert.equal(x.facts.anchor.parentPid,x.record.ownerPid);assert.equal(x.facts.owner.start,x.record.ownerStart);assert.equal(x.facts.bootId,x.record.bootId);assert.ok(x.facts.lineage.every(r=>r.pgid===x.record.pgid));}
 }finally{
  if(!closed||[...owned.values()].some(live)){uncertain=true;for(const sig of ['SIGTERM','SIGKILL']){for(const r of [...owned.values()].reverse())signalOwned(r,sig);const end=Date.now()+1500;while((!closed||[...owned.values()].some(live))&&Date.now()<end)await delay(20);}child.stdout.destroy();child.stderr.destroy();}
  if(!closed||[...owned.values()].some(live)){uncertain=true;throw Error('owned cleanup unconfirmed; retained '+base);}
  for(const [pid,r] of owned)if(!live(r))owned.delete(pid);
 }
});
