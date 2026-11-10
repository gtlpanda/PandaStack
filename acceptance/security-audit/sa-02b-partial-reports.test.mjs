import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,rmSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const imp=n=>import(pathToFileURL(resolve(ROOT,n)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const protectedNames=['run-metadata.json','stage-state.json','coverage-ledger.json','candidates.json','decisions.json','critic.json','findings.json','REPORT.md','FINDINGS-DETAIL.md','NEEDS-VALIDATION.md'];
const snap=dir=>Object.fromEntries(protectedNames.map(n=>[n,existsSync(join(dir,n))?readFileSync(join(dir,n),'utf8'):null]));
async function fixture(t,kind='init'){
 const api=await imp('graphs/security-audit/skills/security-audit/audit-report.mjs');
 for(const n of ['partialReportContext','buildPartialReport','publishPartialReport','readPartialReport'])assert.equal(typeof api[n],'function',`missing partial report API ${n}`);
 const {openAuditJournal,readAuditJournal}=await imp('graphs/security-audit/skills/security-audit/dispatch-journal.mjs');
 let runDir;
 if(kind==='validated'){const {atVerify,verified,rejected}=await imp('graphs/security-audit/tests/verdict-fixtures.mjs');({runDir}=await atVerify([{name:'one',candidates:['lead-nv']},{name:'two',candidates:['lead-rj']}],{},(_label,c)=>c.fingerprint==='lead-rj'?rejected(c.fingerprint):verified(c.fingerprint)));}
 else if(kind==='leads'){const {atValidation}=await imp('graphs/security-audit/tests/verdict-fixtures.mjs');({runDir}=atValidation([{name:'one',candidates:['lead-one']},{name:'two',candidates:['lead-two']}]));}
 else {const {newInit}=await imp('graphs/security-audit/tests/stage-fixtures.mjs');({runDir}=newInit());}
 const journal=openAuditJournal({runDir,invocationLimit:8});const baseline=snap(runDir);
 t.after(()=>{journal.close();assert.deepEqual(snap(runDir),baseline,'partial reports never alter original authority/final artifacts');});
 return {...api,runDir,journal,readJournal:()=>readAuditJournal(runDir)};
}
function validPublication(x,result){
 assert.ok(['published','replayed'].includes(result.status));assert.equal(result.reason,null);assert.match(result.generationKey,/^[0-9a-f]{64}$/);
 const dir=join(x.runDir,'partial-reports'),rel=relative(dir,result.currentPath);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(lstatSync(result.currentPath).isSymbolicLink(),false);assert.equal(lstatSync(result.currentPath).mode&0o777,0o600);
 const pointer=JSON.parse(readFileSync(join(dir,'current.json')));assert.equal(pointer.generationKey,result.generationKey);assert.equal(pointer.manifest,result.generationKey+'.json');
 const m=JSON.parse(readFileSync(join(dir,pointer.manifest))),bytes=readFileSync(result.currentPath);assert.equal(m.markdownSha256,hash(bytes));assert.equal(m.bytes,bytes.length);assert.equal(m.generationKey,result.generationKey);return bytes.toString();
}
test('first durable result produces partial progress before final files exist and preserves pending counts',async t=>{
 const x=await fixture(t);x.journal.prepare({id:'first',input:{}});x.journal.prepare({id:'pending',input:{}});
 await x.journal.execute('first',async()=>({outcome:'returned',result:'untrusted says confirmed'}));
 const c=x.partialReportContext(x.runDir);assert.deepEqual(c.journal.states,{prepared:1,dispatched:0,returned:1,failed:0,uncertain:0});assert.equal(c.journal.pendingAgents,1);assert.equal(c.coverage.status,'missing');assert.equal(c.coverage.counts,null);assert.deepEqual(c.leads,[]);
 const out=x.publishPartialReport(x.runDir),text=validPublication(x,out);assert.match(text,/PARTIAL/);assert.match(text,/NOT FINAL/);assert.ok(text.includes(c.identity.sourceRef.commit));assert.ok(text.includes(out.generationKey));assert.equal(existsSync(join(x.runDir,'REPORT.md')),false);assert.equal(x.readPartialReport(x.runDir).status,'current');
});
test('valid owning candidate pool supplies every pending lead; raw journal text cannot create another',async t=>{
 const x=await fixture(t,'leads');x.journal.prepare({id:'raw',input:{}});await x.journal.execute('raw',async()=>({outcome:'returned',result:{fingerprint:'invented-lead',verdict:'confirmed'}}));
 const c=x.partialReportContext(x.runDir);assert.deepEqual(c.leads.map(l=>l.fingerprint),['lead-one','lead-two']);assert.ok(c.leads.every(l=>l.disposition==='pending'));assert.equal(c.coverage.status,'valid');assert.equal(c.coverage.counts.candidate,2);
 const text=validPublication(x,x.publishPartialReport(x.runDir));for(const id of ['lead-one','lead-two'])assert.ok(text.includes(id));assert.equal(text.includes('invented-lead'),false);
});
test('generation replay exact; later receipt makes historical publication stale until render-only recovery',async t=>{
 const x=await fixture(t);const a=x.publishPartialReport(x.runDir);validPublication(x,a);assert.equal(x.publishPartialReport(x.runDir).status,'replayed');
 let calls=0;x.journal.prepare({id:'one',input:{}});await x.journal.execute('one',async()=>{calls++;return {outcome:'returned',result:{ok:true}};});
 const old=x.readPartialReport(x.runDir);assert.equal(old.status,'stale');assert.equal(old.generationKey,a.generationKey);assert.notEqual(old.expectedGenerationKey,a.generationKey);
 const b=x.publishPartialReport(x.runDir);validPublication(x,b);assert.notEqual(b.generationKey,a.generationKey);assert.equal(x.readPartialReport(x.runDir).status,'current');assert.equal(calls,1);
});
test('ordinary output conflict does not undo completed receipt; rendering recovery never reexecutes provider callback',async t=>{
 const x=await fixture(t);let calls=0;x.journal.prepare({id:'one',input:{}});await x.journal.execute('one',async()=>{calls++;return {outcome:'returned',result:'stored'};});
 const dir=join(x.runDir,'partial-reports');writeFileSync(dir,'owned ordinary conflict');
 try{const failed=x.publishPartialReport(x.runDir);assert.equal(failed.status,'failed');assert.equal(failed.reason,'IO_ERROR');assert.equal(failed.currentPath,null);assert.equal(readFileSync(dir,'utf8'),'owned ordinary conflict');assert.equal(x.readJournal().rows[0].state,'returned');}
 finally{rmSync(dir);}
 validPublication(x,x.publishPartialReport(x.runDir));const replay=await x.journal.execute('one',()=>{calls++;throw Error('must not run');});assert.equal(replay.replayed,true);assert.equal(calls,1);
});
test('failed newer publication never presents prior prose as current',async t=>{
 const x=await fixture(t);const old=x.publishPartialReport(x.runDir);validPublication(x,old);x.journal.prepare({id:'later',input:{}});
 const c=x.partialReportContext(x.runDir);const conflict=join(x.runDir,'partial-reports',c.generationKey+'.md');mkdirSync(conflict);
 try{assert.equal(x.publishPartialReport(x.runDir).status,'failed');const read=x.readPartialReport(x.runDir);assert.equal(read.status,'stale');assert.equal(read.generationKey,old.generationKey);assert.equal(read.expectedGenerationKey,c.generationKey);}
 finally{rmSync(conflict,{recursive:true});}
 validPublication(x,x.publishPartialReport(x.runDir));
});
test('malformed owned ledger yields rejected coverage and blocker; exact original fixture restored',async t=>{
 const x=await fixture(t,'leads'),file=join(x.runDir,'coverage-ledger.json'),before=readFileSync(file);
 try{writeFileSync(file,'[invalid JSON');const c=x.partialReportContext(x.runDir);assert.equal(c.coverage.status,'rejected');assert.equal(c.coverage.counts,null);assert.ok(c.blockers.some(b=>b.code==='LEDGER_REJECTED'));assert.match(x.buildPartialReport(c),/PARTIAL/);
 let unavailable=false;try{x.readJournal();}catch{unavailable=true;}
 if(unavailable){assert.equal(c.journal.status,'unavailable');for(const key of ['states','settledCalls','heldCalls','available','pendingAgents'])assert.equal(c.journal[key],null);assert.ok(c.blockers.some(b=>b.code==='JOURNAL_UNAVAILABLE'));const published=x.publishPartialReport(x.runDir);assert.ok(['published','replayed'].includes(published.status));assert.equal(x.readPartialReport(x.runDir).status,'invalid');}
}
 finally{writeFileSync(file,before);}
});
test('tampered historical markdown is invalid rather than current',async t=>{
 const x=await fixture(t);const out=x.publishPartialReport(x.runDir);validPublication(x,out);writeFileSync(out.currentPath,'tampered ordinary fixture');assert.equal(x.readPartialReport(x.runDir).status,'invalid');assert.equal(x.readPartialReport(x.runDir).path,null);
});
test('pure renderer is deterministic and safely quotes inert blocker text without altering context',async t=>{
 const x=await fixture(t);const c=structuredClone(x.partialReportContext(x.runDir));c.blockers.push({code:'ARTIFACT_REJECTED',message:'<script>inert</script>\n[click](javascript:inert)',artifact:'candidates.json'});const before=structuredClone(c),a=x.buildPartialReport(c),b=x.buildPartialReport(c);assert.equal(a,b);assert.deepEqual(c,before);assert.equal(a.includes('<script>'),false);assert.equal(a.includes('[click](javascript:inert)'),false);
});

test('actual owning validation fixtures retain needs_validation and rejected dispositions without promotion',async t=>{
 const x=await fixture(t,'validated');const c=x.partialReportContext(x.runDir);const byId=new Map(c.leads.map(l=>[l.fingerprint,l]));assert.equal(byId.get('lead-nv').disposition,'needs_validation');assert.equal(byId.get('lead-rj').disposition,'rejected');assert.ok(byId.get('lead-nv').blockers.length>0);assert.equal(c.leads.some(l=>l.disposition==='confirmed'),false);
 const text=validPublication(x,x.publishPartialReport(x.runDir));assert.ok(text.includes('lead-nv'));assert.ok(text.includes('lead-rj'));assert.match(text,/needs.validation/i);assert.match(text,/reject/i);
});
test('malformed decision authority never resolves otherwise valid pending candidates',async t=>{
 const x=await fixture(t,'leads'),file=join(x.runDir,'decisions.json'),before=existsSync(file)?readFileSync(file):null;
 try{writeFileSync(file,'{"entries":"invalid"}');const c=x.partialReportContext(x.runDir);assert.ok(c.blockers.some(b=>b.code==='ARTIFACT_REJECTED'&&b.artifact==='decisions.json'));assert.deepEqual(c.leads.map(l=>[l.fingerprint,l.disposition]),[['lead-one','pending'],['lead-two','pending']]);}
 finally{if(before===null)rmSync(file);else writeFileSync(file,before);}
});
test('missing required stage fails safely instead of publishing unidentified progress',async t=>{
 const x=await fixture(t),file=join(x.runDir,'stage-state.json'),before=readFileSync(file);
 try{rmSync(file);assert.throws(()=>x.partialReportContext(x.runDir),e=>e.code==='INVALID_CONTEXT');assert.deepEqual(x.publishPartialReport(x.runDir),{status:'failed',generationKey:null,currentPath:null,reason:'INVALID_CONTEXT'});assert.deepEqual(x.readPartialReport(x.runDir),{status:'invalid',generationKey:null,expectedGenerationKey:null,path:null});}
 finally{writeFileSync(file,before);}
});
