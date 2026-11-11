import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const api=()=>import(pathToFileURL(join(ROOT,'core/skills/verify/scope-record.mjs')).href);
const scope='11111111-2222-3333-4444-555555555555',boot='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const line=(fields=['1',scope,boot,'101','9007199254740993','202','9007199254740995','202'])=>fields.join('\t')+'\n';
const record=()=>({schemaVersion:1,scopeId:scope,bootId:boot,ownerPid:101,ownerStart:'9007199254740993',anchorPid:202,anchorStart:'9007199254740995',pgid:202});
const row=(pid,parentPid,start,pgid=202)=>({pid,parentPid,start,pgid,state:'S'});
const facts=()=>{const owner=row(101,90,'9007199254740993',90),anchor=row(202,101,'9007199254740995'),middle=row(303,202,'9007199254740997'),current=row(404,303,'9007199254740999');return {bootId:boot,owner,anchor,current,lineage:[{...current},middle,{...anchor}]};};
const clone=x=>JSON.parse(JSON.stringify(x));

test('exact eight-field scope record preserves large birth tokens as strings',async()=>{
 const m=await api(),a=m.parseScopeRecord(line()),b=m.parseScopeRecord(line());assert.deepEqual(a,record());assert.notStrictEqual(a,b);assert.equal(typeof a.ownerStart,'string');try{a.ownerPid=999}catch{}assert.deepEqual(b,record());
 const fields=['1',scope,boot,'2147483647','99999999999999999999','1','1','1'];assert.equal(m.parseScopeRecord(line(fields)).ownerPid,2147483647);
});
test('scope parser rejects malformed encoding and scalar grammar without input echo',async()=>{
 const m=await api();const bad=[null,{},Buffer.from(line()),'',line().slice(0,-1),line()+'\n','\ufeff'+line(),line().replace('\n','\r\n'),line().replace('\t',' '),line().replace('\t','\t\t'),line().replace(/^1/,'2'),line()+'EXTRA',line().replace(scope,scope.toUpperCase().replace('11111111','AAAAAAAA'))];
 for(const [i,v] of [[3,'0'],[3,'01'],[3,'-1'],[3,'2147483648'],[3,'1.0'],[4,'0'],[4,'01'],[4,'1'.repeat(21)],[4,'+1'],[5,'NaN'],[7,'Infinity']]){const fields=line().trimEnd().split('\t');fields[i]=v;bad.push(line(fields));}
 bad.push('OWNED_INVALID_SCOPE_SENTINEL'.repeat(20));for(const value of bad)assert.throws(()=>m.parseScopeRecord(value),e=>e.code==='INVALID_SCOPE'&&typeof e.message==='string'&&!e.message.includes('OWNED_INVALID_SCOPE_SENTINEL'));
});
test('join predicate accepts exact live contiguous observed lineage without mutation',async()=>{
 const m=await api(),r=record(),f=facts(),before=clone({r,f});assert.equal(m.validateScopeJoin(r,f),true);assert.deepEqual({r,f},before);
 const single=facts();single.current={...single.anchor};single.lineage=[{...single.anchor}];assert.equal(m.validateScopeJoin(record(),single),true);
});
test('join predicate rejects mismatched boot, birth, owner and group observations',async()=>{
 const m=await api();for(const mutate of [f=>f.bootId=scope,f=>f.owner.start='9007199254740992',f=>f.anchor.start='9007199254740994',f=>f.owner.pid=102,f=>f.anchor.pid=203,f=>f.anchor.parentPid=102,f=>f.anchor.pgid=203,f=>f.current.pgid=203,f=>f.owner.pgid=202,f=>f.owner.state='Z',f=>f.anchor.state='X']){const f=facts();mutate(f);assert.equal(m.validateScopeJoin(record(),f),false);}
 const r=record();r.pgid=203;assert.equal(m.validateScopeJoin(r,facts()),false);
});
test('join predicate requires complete ordered live lineage and exact snapshots',async()=>{
 const m=await api();for(const mutate of [f=>f.lineage=[],f=>f.lineage.pop(),f=>f.lineage.shift(),f=>f.lineage.reverse(),f=>f.lineage[1].parentPid=999,f=>f.lineage[1].pgid=203,f=>f.lineage[1].pid=f.current.pid,f=>f.lineage[0].start='2',f=>f.lineage.at(-1).state='Z',f=>f.lineage[1].state='X',f=>f.lineage=Array(257).fill(f.current)]){const f=facts();mutate(f);assert.equal(m.validateScopeJoin(record(),f),false);}
});
test('malformed data fails closed without invoking accessors or custom records',async()=>{
 const m=await api();for(const [r,f] of [[null,facts()],[record(),null],[{...record(),targetPid:777},facts()],[record(),{...facts(),grant:true}]])assert.equal(m.validateScopeJoin(r,f),false);
 let reads=0;const r=record();Object.defineProperty(r,'ownerPid',{enumerable:true,get(){reads++;throw Error('must not run')}});assert.equal(m.validateScopeJoin(r,facts()),false);
 const f=facts();Object.defineProperty(f.anchor,'start',{enumerable:true,get(){reads++;throw Error('must not run')}});assert.equal(m.validateScopeJoin(record(),f),false);assert.equal(reads,0);
 const custom=Object.assign(Object.create({custom:true}),record());assert.equal(m.validateScopeJoin(custom,facts()),false);
});
