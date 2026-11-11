import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const err=code=>e=>e?.code===code;
async function fixture(t){
 const {createSourceReader}=await import(pathToFileURL(resolve(ROOT,'graphs/security-audit/skills/security-audit/source-reader.mjs')));
 const base=fs.mkdtempSync(join(tmpdir(),'sr01a-identities-')),sourceRoot=join(base,'source'),parent=join(base,'context-parent'),contextRoot=join(parent,'context');
 for(const p of [sourceRoot,parent,contextRoot])fs.mkdirSync(p);
 for(const [root,body] of [[sourceRoot,'source bytes'],[contextRoot,'context bytes']])fs.writeFileSync(join(root,'a.txt'),body,{mode:0o444});
 for(const p of [sourceRoot,contextRoot])fs.chmodSync(p,0o555);
 t.after(()=>{for(const p of [sourceRoot,contextRoot])fs.chmodSync(p,0o755);fs.rmSync(base,{recursive:true,force:true});});
 const item=body=>({path:'a.txt',sha256:sha(body),bytes:Buffer.byteLength(body)});
 const manifest={version:1,sourceRef:{commit:'a'.repeat(40),tree:'b'.repeat(40)},files:[item('source bytes')],contexts:[{manifestId:'issued',artifacts:[{artifactId:'a',...item('context bytes')}]}]};
 const create=()=>createSourceReader({sourceRoot,contextRoot,manifest,expectedManifestHash:sha(JSON.stringify(canonical(manifest)))});
 return {base,sourceRoot,parent,contextRoot,create};
}
function observedIdentity(path,identity,check){
 const original=fs.lstatSync;
 fs.lstatSync=function(file,...options){const value=original.call(fs,file,...options);if(file!==path)return value;return Object.assign(Object.create(Object.getPrototypeOf(value)),value,identity);};
 syncBuiltinESMExports();
 try{return check();}finally{fs.lstatSync=original;syncBuiltinESMExports();}
}
test('distinct source/context roots sharing ordinary ancestors retain separate bytes',async t=>{
 const x=await fixture(t),r=x.create();try{
 assert.equal(Buffer.from(r.readSource({path:'a.txt',offset:0,limit:100}).dataBase64,'base64').toString(),'source bytes');
 assert.equal(Buffer.from(r.readContext({manifestId:'issued',artifactId:'a',offset:0,limit:100}).dataBase64,'base64').toString(),'context bytes');
 }finally{r.close();}
});
test('pure metadata alias of the two roots refuses despite different path strings',async t=>{
 const x=await fixture(t),s=fs.lstatSync(x.sourceRoot,{bigint:true});
 observedIdentity(x.contextRoot,{dev:s.dev,ino:s.ino},()=>assert.throws(x.create,err('INVALID_READER_INPUT')));
});
test('pure metadata alias in opposite ancestor chains refuses both containment directions',async t=>{
 const x=await fixture(t),s=fs.lstatSync(x.sourceRoot,{bigint:true}),b=fs.lstatSync(x.base,{bigint:true});
 observedIdentity(x.parent,{dev:s.dev,ino:s.ino},()=>assert.throws(x.create,err('INVALID_READER_INPUT')));
 observedIdentity(x.contextRoot,{dev:b.dev,ino:b.ino},()=>assert.throws(x.create,err('INVALID_READER_INPUT')));
});
test('unavailable or lossy directory identity fails closed without fallback spelling rules',async t=>{
 const x=await fixture(t),s=fs.lstatSync(x.sourceRoot,{bigint:true});
 for(const identity of [{dev:s.dev,ino:0n},{dev:-1n,ino:s.ino},{dev:Number(s.dev),ino:Number(s.ino)},{dev:undefined,ino:s.ino}])
 observedIdentity(x.sourceRoot,identity,()=>assert.throws(x.create,err('UNSAFE_PATH')));
});
