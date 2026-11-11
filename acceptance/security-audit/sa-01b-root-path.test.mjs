// Draft: ordinary static paths only. No execution before independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT?pathToFileURL(resolve(process.env.PANDASTACK_CANDIDATE_ROOT)+'/'):new URL('../../',import.meta.url);
const load=()=>import(new URL('graphs/security-audit/skills/security-audit/snapshot-protection.mjs',ROOT));
function fixture(t){const root=mkdtempSync(join(tmpdir(),'sa01b-static-')),real=join(root,'real'),child=join(real,'child');mkdirSync(real);mkdirSync(child);const file=join(child,'inert');writeFileSync(file,'ordinary fixed bytes\n');symlinkSync(real,join(root,'alias'),'dir');chmodSync(file,0o444);chmodSync(child,0o555);chmodSync(real,0o555);const before={bytes:readFileSync(file),modes:[real,child,file].map(p=>lstatSync(p).mode)};t.after(()=>{chmodSync(root,0o700);chmodSync(real,0o700);chmodSync(child,0o700);rmSync(root,{recursive:true,force:true});});return {root,real,child,file,before};}
function unchanged(f){assert.deepEqual(readFileSync(f.file),f.before.bytes);assert.deepEqual([f.real,f.child,f.file].map(p=>lstatSync(p).mode),f.before.modes);}
test('static symlink ancestor refuses root before subtree traversal',async t=>{const {inspectSnapshotProtection}=await load();const f=fixture(t);assert.deepEqual(inspectSnapshotProtection(join(f.root,'alias','child')),{ok:false,problems:[{path:'.',code:'SYMLINK'}]});unchanged(f);});
test('root-link dot and explicit dot/dotdot components reject before normalization',async t=>{const {inspectSnapshotProtection}=await load();const f=fixture(t);for(const path of [f.root+'/alias/.',f.root+'/alias/./child',f.real+'/./child',f.child+'/../child'])assert.deepEqual(inspectSnapshotProtection(path),{ok:false,problems:[{path:'.',code:'INVALID_ROOT'}]},path);unchanged(f);});
test('canonical real root and trailing separators preserve ordinary permission inspection',async t=>{const {inspectSnapshotProtection}=await load();const f=fixture(t);for(const path of [f.child,f.child+'/',f.child+'///'])assert.deepEqual(inspectSnapshotProtection(path),{ok:true,problems:[]});unchanged(f);});
