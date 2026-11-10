// Prospective correction only; no execution before independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t){
 const api=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/dispatch-journal.mjs')));
 const {newInit}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/tests/stage-fixtures.mjs')));
 const {runDir}=newInit(),file=join(runDir,'run-metadata.json'),original=readFileSync(file);
 const h=api.openAuditJournal({runDir,invocationLimit:2});h.prepare({id:'ordinary',input:{text:'inert owned record'}});h.close();
 t.after(()=>assert.deepEqual(readFileSync(file),original));
 return {api,runDir,file,original,before:api.readAuditJournal(runDir)};
}
test('matching current metadata reads unchanged retained journal',async t=>{
 const x=await fixture(t);assert.equal(x.before.rows[0].state,'prepared');assert.deepEqual(x.api.readAuditJournal(x.runDir),x.before);assert.deepEqual(readFileSync(x.file),x.original);
});
for(const field of ['commit','run_id'])test('reader refuses valid changed '+field+' and recovers only after exact metadata restoration',async t=>{
 const x=await fixture(t),meta=JSON.parse(x.original);
 if(field==='commit')meta.source_ref.commit=(meta.source_ref.commit[0]==='a'?'b':'a').repeat(meta.source_ref.commit.length);
 else meta.run_id=meta.run_id+'-different';
 try{writeFileSync(x.file,JSON.stringify(meta)+'\n');assert.throws(()=>x.api.readAuditJournal(x.runDir),e=>e?.code==='CONFLICT');}
 finally{writeFileSync(x.file,x.original);}
 assert.deepEqual(x.api.readAuditJournal(x.runDir),x.before);
});
