// Unexecuted ordinary inert reader proposal; no provider/process/target code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(sort(x));
function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
const err=c=>e=>e?.code===c;
async function fixture(t){
 const api=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/source-reader.mjs')));
 const base=mkdtempSync(join(tmpdir(),'pandastack-reader-')),sourceRoot=join(base,'source'),contextRoot=join(base,'context');
 mkdirSync(sourceRoot);mkdirSync(contextRoot);const text=Buffer.from('alpha.* beta alpha.*\n雪🙂tail'),context=Buffer.from('full critic evidence: ordinary source observation');
 writeFileSync(join(sourceRoot,'a.txt'),text);writeFileSync(join(sourceRoot,'b.txt'),'second');writeFileSync(join(contextRoot,'evidence.txt'),context);
 for(const p of [join(sourceRoot,'a.txt'),join(sourceRoot,'b.txt'),join(contextRoot,'evidence.txt')])chmodSync(p,0o444);
 chmodSync(sourceRoot,0o555);chmodSync(contextRoot,0o555);
 t.after(()=>{chmodSync(sourceRoot,0o755);chmodSync(contextRoot,0o755);rmSync(base,{recursive:true,force:true});});
 const manifest={version:1,sourceRef:{commit:'a'.repeat(40),tree:'b'.repeat(40)},files:[{path:'a.txt',sha256:sha(text),bytes:text.length},{path:'b.txt',sha256:sha('second'),bytes:6}],contexts:[{manifestId:'critic-1',artifacts:[{artifactId:'evidence',path:'evidence.txt',sha256:sha(context),bytes:context.length}]}]};
 const create=(m=manifest,extra={})=>api.createSourceReader({sourceRoot,contextRoot,manifest:m,expectedManifestHash:sha(canonical(m)),...extra});
 const reader=create();t.after(()=>reader.close());return {api,base,sourceRoot,contextRoot,manifest,text,context,reader,create};
}
test('bounded source listing has exact pagination and detached inventory',async t=>{
 const x=await fixture(t);const a=x.reader.listSource({after:null,limit:1});assert.deepEqual(a.entries.map(e=>e.path),['a.txt']);assert.equal(a.nextAfter,'a.txt');
 const b=x.reader.listSource({after:a.nextAfter,limit:1});assert.deepEqual(b.entries.map(e=>e.path),['b.txt']);assert.equal(b.nextAfter,null);
 try{a.entries[0].path='changed';}catch{}assert.equal(x.reader.listSource({after:null,limit:1}).entries[0].path,'a.txt');
});
test('raw byte pages preserve multibyte and binary boundaries exactly',async t=>{
 const x=await fixture(t),parts=[];let offset=0;
 do{const p=x.reader.readSource({path:'a.txt',offset,limit:3});assert.equal(p.offset,offset);assert.equal(p.sha256,sha(x.text));parts.push(Buffer.from(p.dataBase64,'base64'));assert.ok(p.nextOffset===null||(Number.isSafeInteger(p.nextOffset)&&p.nextOffset>offset&&p.nextOffset<=x.text.length));offset=p.nextOffset;}while(offset!==null);
 assert.deepEqual(Buffer.concat(parts),x.text);
});
test('literal search is not regex and window overlap keeps boundary matches',async t=>{
 const x=await fixture(t);const a=x.reader.searchSource({path:'a.txt',literal:'alpha.*',offset:0,scanBytes:2,limit:1});assert.deepEqual(a.matches,[0]);assert.ok(a.nextOffset>0);
 const b=x.reader.searchSource({path:'a.txt',literal:'.*',offset:0,scanBytes:1048576,limit:128});assert.deepEqual(b.matches,[5,18]);assert.equal(b.nextOffset,null);
});
test('immutable context IDs retrieve full evidence without arbitrary path lookup',async t=>{
 const x=await fixture(t);const p=x.reader.readContext({manifestId:'critic-1',artifactId:'evidence',offset:0,limit:65536});assert.deepEqual(Buffer.from(p.dataBase64,'base64'),x.context);
 assert.throws(()=>x.reader.readContext({manifestId:'critic-1',artifactId:'../run-metadata.json',offset:0,limit:1}),err('INVALID_READER_INPUT'));
 assert.throws(()=>x.reader.readContext({manifestId:'other',artifactId:'evidence',offset:0,limit:1}),err('NOT_FOUND'));
});
test('wrong manifest and sequential changed file bytes refuse before content return',async t=>{
 const x=await fixture(t);assert.throws(()=>x.create(x.manifest,{expectedManifestHash:'0'.repeat(64)}),err('MANIFEST_MISMATCH'));
 const p=join(x.sourceRoot,'a.txt');chmodSync(p,0o644);writeFileSync(p,Buffer.alloc(x.text.length,120));chmodSync(p,0o444);
 assert.throws(()=>x.reader.readSource({path:'a.txt',offset:0,limit:10}),err('SOURCE_MISMATCH'));
});
test('static root and addressed file symlinks refuse without changing outside sentinel',async t=>{
 const x=await fixture(t),sentinel=join(x.base,'outside.txt');writeFileSync(sentinel,'ordinary outside sentinel');const before=readFileSync(sentinel);
 const alias=join(x.base,'source-alias');symlinkSync(x.sourceRoot,alias);
 assert.throws(()=>x.create(x.manifest,{sourceRoot:alias}),err('UNSAFE_PATH'));
 chmodSync(x.sourceRoot,0o755);rmSync(join(x.sourceRoot,'a.txt'));symlinkSync(sentinel,join(x.sourceRoot,'a.txt'));chmodSync(x.sourceRoot,0o555);
 assert.throws(()=>x.reader.readSource({path:'a.txt',offset:0,limit:10}),err('UNSAFE_PATH'));assert.deepEqual(readFileSync(sentinel),before);
});
test('invalid request bounds and unlisted paths refuse; close is final',async t=>{
 const x=await fixture(t);
 for(const path of ['../outside.txt','/etc/passwd','a.txt/../b.txt'])assert.throws(()=>x.reader.readSource({path,offset:0,limit:1}),err('INVALID_READER_INPUT'));
 assert.throws(()=>x.reader.readSource({path:'missing.txt',offset:0,limit:1}),err('NOT_FOUND'));
 assert.throws(()=>x.reader.listSource({after:null,limit:129}),err('INVALID_READER_INPUT'));
 assert.throws(()=>x.reader.readSource({path:'a.txt',offset:0,limit:65537}),err('INVALID_READER_INPUT'));
 x.reader.close();x.reader.close();assert.throws(()=>x.reader.listSource({after:null,limit:1}),err('CLOSED'));
});
test('manifest Proxy traps are not invoked and captured manifest ignores later caller mutation',async t=>{
 const x=await fixture(t);let traps=0;const proxy=new Proxy(x.manifest,{getPrototypeOf(){traps++;return Object.prototype;},ownKeys(){traps++;return [];},get(){traps++;return undefined;}});
 assert.throws(()=>x.api.createSourceReader({sourceRoot:x.sourceRoot,contextRoot:x.contextRoot,manifest:proxy,expectedManifestHash:'0'.repeat(64)}),err('INVALID_READER_INPUT'));assert.equal(traps,0);
 x.manifest.files[0].sha256='0'.repeat(64);assert.equal(x.reader.readSource({path:'a.txt',offset:0,limit:1}).sha256,sha(x.text));
});
