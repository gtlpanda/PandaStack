import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ROOT,fixture,sourceRun,gateSource} from './p2-08-support.mjs';
function result(r){assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('pure decision configuration and gate helper imports do not require SQLite',t=>{
 const f=fixture(t);const source=[
 'import {validateDecisionConfig} from '+JSON.stringify(f.url('core/skills/decisions/config.mjs'))+';',
 'import {validateDecisionFeature,decisionRevision} from '+JSON.stringify(f.url('graphs/autobuild/tool/lib/decisions.mjs'))+';',
 'import '+JSON.stringify(f.url('graphs/autobuild/tool/lib/config.mjs'))+';',
 "if(validateDecisionConfig(undefined)!==undefined)throw Error('config API changed');validateDecisionFeature({},{features:[]});console.log(JSON.stringify({revisionHelper:typeof decisionRevision}));"
 ].join('\n');
 assert.deepEqual(result(sourceRun(f,source)),{revisionHelper:'function'});assert.deepEqual(f.imports(),[]);
});
test('actual autobuild CLI help works with simulated unavailable node:sqlite',t=>{
 const f=fixture(t),r=f.run([join(ROOT,'graphs/autobuild/tool/lib/cli.mjs'),'--help']);
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/autobuild run/);assert.deepEqual(f.imports(),[]);
});
for(const mode of ['disabled','completed','unassigned'])test(mode+' decision gate returns null without loading SQLite or reading HEAD',t=>{
 const f=fixture(t),r=result(sourceRun(f,gateSource(f,mode)));
 assert.deepEqual(r,{returnedNull:true,reads:0,observed:[],storeExists:false});assert.deepEqual(f.imports(),[]);
});
test('assigned incomplete gate rejects unavailable storage instead of silently opting out',t=>{
 const f=fixture(t),r=result(sourceRun(f,gateSource(f,'assigned')));
 assert.ok(r.error,'enabled gate must reject missing storage');assert.ok(['ERR_UNKNOWN_BUILTIN_MODULE','IO_ERROR'].includes(r.error.code),'preserve recognized missing-module or existing owning IO error boundary');
 assert.equal(typeof r.error.message,'string');assert.ok(r.error.message.length>0&&r.error.message.length<1024);
 assert.equal(r.storeExists,false);assert.deepEqual(r.observed,[]);assert.ok(f.imports().length>=1,'actual SQLite resolution was attempted only for enabled work');
});
test('available SQLite positive control still opens assigned queue and reports existing NOT_FOUND',t=>{
 const f=fixture(t,false),r=result(sourceRun(f,gateSource(f,'assigned')));
 assert.equal(r.error?.code,'NOT_FOUND');assert.equal(r.storeExists,true);assert.ok(f.imports().length>=1);assert.equal(r.reads,1);
});
