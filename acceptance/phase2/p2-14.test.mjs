// Conditional preparation only. No scheduling or filesystem-race reproduction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
async function load(){const api=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href);assert.equal(typeof api.prepareCaptureDirectories,'function','prepareCaptureDirectories export must exist');return api.prepareCaptureDirectories;}
function fixture(t){const base=fs.mkdtempSync(join(tmpdir(),'capture-directory-normal-'));fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const state=join(base,'state');fs.mkdirSync(state,{mode:0o700});return {base,state,evidence:join(state,'evidence'),root:join(state,'evidence','logs')};}
const mode=p=>fs.lstatSync(p).mode&0o777;
function snapshot(p){const st=fs.lstatSync(p);return {mode:st.mode,ino:st.ino,dev:st.dev,bytes:st.isFile()?fs.readFileSync(p):null,target:st.isSymbolicLink()?fs.readlinkSync(p):null};}

test('fresh capture preparation creates only fixed evidence and logs directories',async t=>{
 const prepare=await load(),x=fixture(t),before=snapshot(x.state);const out=prepare(x.state);assert.deepEqual(out,{stateDir:x.state,evidence:x.evidence,root:x.root});assert.equal(mode(x.evidence),0o700);assert.equal(mode(x.root),0o700);assert.ok(fs.lstatSync(x.evidence).isDirectory());assert.ok(fs.lstatSync(x.root).isDirectory());assert.deepEqual(fs.readdirSync(x.state),['evidence']);assert.deepEqual(fs.readdirSync(x.evidence),['logs']);assert.deepEqual(fs.readdirSync(x.root),[]);assert.equal(snapshot(x.state).ino,before.ino);assert.equal(mode(x.state),0o700);
});
test('sequential repeated private preparation preserves existing files and directory identities',async t=>{
 const prepare=await load(),x=fixture(t);prepare(x.state);const sentinel=join(x.root,'sentinel');fs.writeFileSync(sentinel,Buffer.from([0,1,92,255]),{mode:0o600});const before=[x.state,x.evidence,x.root,sentinel].map(snapshot);const again=prepare(x.state);assert.deepEqual(again,{stateDir:x.state,evidence:x.evidence,root:x.root});assert.deepEqual([x.state,x.evidence,x.root,sentinel].map(snapshot),before);assert.deepEqual(fs.readdirSync(x.root),['sentinel']);
});
test('existing regular files at either fixed child are refused without changing them',async t=>{
 const prepare=await load();for(const where of ['evidence','root']){const x=fixture(t);if(where==='root')fs.mkdirSync(x.evidence,{mode:0o700});const target=x[where];fs.writeFileSync(target,'ordinary retained bytes',{mode:0o600});const before=snapshot(target);assert.throws(()=>prepare(x.state));assert.deepEqual(snapshot(target),before);assert.deepEqual(fs.readdirSync(x.state),['evidence']);if(where==='root')assert.deepEqual(fs.readdirSync(x.evidence),['logs']);}
});
test('preexisting static directory aliases are refused before adopting or chmodding their targets',async t=>{
 const prepare=await load();for(const where of ['state','evidence','root']){const x=fixture(t),target=join(x.base,'ordinary-target');fs.mkdirSync(target,{mode:0o755});fs.chmodSync(target,0o755);const sentinel=join(target,'sentinel');fs.writeFileSync(sentinel,'untouched',{mode:0o600});if(where==='state')fs.rmdirSync(x.state);if(where==='root')fs.mkdirSync(x.evidence,{mode:0o700});fs.symlinkSync(target,x[where]);const before=[target,sentinel,x[where]].map(snapshot);assert.throws(()=>prepare(x.state));assert.deepEqual([target,sentinel,x[where]].map(snapshot),before);assert.deepEqual(fs.readdirSync(target),['sentinel']);}
});
test('existing real logs directory retains0755-to0700 hardening without tightening evidence-parent policy',async t=>{
 const prepare=await load(),x=fixture(t);fs.mkdirSync(x.evidence,{mode:0o755});fs.mkdirSync(x.root,{mode:0o755});fs.chmodSync(x.evidence,0o755);fs.chmodSync(x.root,0o755);const sentinel=join(x.root,'sentinel');fs.writeFileSync(sentinel,'unchanged',{mode:0o600});const parent=snapshot(x.evidence),root=snapshot(x.root),file=snapshot(sentinel);assert.deepEqual(prepare(x.state),{stateDir:x.state,evidence:x.evidence,root:x.root});assert.equal(mode(x.root),0o700);assert.equal(snapshot(x.root).ino,root.ino);assert.deepEqual(snapshot(x.evidence),parent);assert.deepEqual(snapshot(sentinel),file);assert.equal(mode(x.evidence),0o755);
});
