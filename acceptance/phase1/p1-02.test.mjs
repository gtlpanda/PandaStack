import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mod, modulePath, temp, cleanup, baseRun, event } from './support.mjs';
const findJson = (root, predicate) => {
 for (const name of readdirSync(root)) { const p = join(root, name); if (lstatSync(p).isDirectory()) { const hit = findJson(p, predicate); if (hit) return hit; } else { try { if (predicate(JSON.parse(readFileSync(p)))) return p; } catch {} } }
};
test('store preserves immutable records, replay, conflict and filters', async () => {
 const { createRunStore } = await mod('store'); const dir=temp();
 try { const s=createRunStore(dir); const run=baseRun();
 assert.deepEqual(s.putRun(run), {created:true}); assert.deepEqual(s.putRun(structuredClone(run)), {created:false});
 assert.throws(()=>s.putRun({...run, backend:'claude'}),e=>e.code==='CONFLICT');
 assert.deepEqual(s.readRun(run.id),run); assert.equal(s.readRun('missing'),null);
 s.putRun(baseRun({id:'run-2',repo:'/project/two',backend:'claude',parentRunId:'run-1'}));
 assert.deepEqual(s.listRuns({repo:'/project/one'}).map(x=>x.id),['run-1']);
 assert.deepEqual(s.listRuns({backend:'claude',parentRunId:'run-1'}).map(x=>x.id),['run-2']);
 assert.deepEqual(s.appendEvent(event()),{created:true}); assert.deepEqual(s.appendEvent(event()),{created:false});
 assert.throws(()=>s.appendEvent(event({at:'2026-11-10T12:00:00.000Z'})),e=>e.code==='CONFLICT');
 assert.throws(()=>s.appendEvent(event({runId:'missing'})),e=>e.code==='NOT_FOUND');
 assert.throws(()=>s.readRun('../escape'),e=>e.code==='INVALID_RECORD');
 assert.deepEqual(s.readRun(run.id),run);
 } finally {cleanup(dir);}
});
test('independent processes cannot lose concurrent records or duplicate the same event', async () => {
 await mod('store'); const dir=temp();
 try { const code=`import {createRunStore} from ${JSON.stringify(pathToFileURL(modulePath('store')).href)}; const s=createRunStore(process.argv[1]); s.putRun(JSON.parse(process.argv[2])); s.appendEvent(JSON.parse(process.argv[3])); s.appendEvent(JSON.parse(process.argv[4]));`;
 await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--input-type=module','-e',code,dir,JSON.stringify(baseRun()),JSON.stringify(event()),JSON.stringify(event({id:'event-'+i}))],{stdio:['ignore','pipe','pipe']}); let err=''; child.stderr.on('data',d=>err+=d); child.on('error',reject); child.on('close',n=>n===0?resolve():reject(new Error(err)));
 })));
 const s=(await mod('store')).createRunStore(dir); assert.equal(s.listRuns().length,1); assert.equal(s.readEvents('run-1').length,9);
 } finally {cleanup(dir);}
});
test('corrupt and symlinked committed records are rejected, never followed or hidden', async () => {
 const {createRunStore}=await mod('store'); const dir=temp(), outside=temp();
 try {const s=createRunStore(dir);s.putRun(baseRun());const file=findJson(dir,x=>x.id==='run-1'&&x.workflow==='autobuild');assert.ok(file);
 writeFileSync(file,'{broken');assert.throws(()=>s.readRun('run-1'),e=>e.code==='CORRUPT');
 unlinkSync(file); const target=join(outside,'record.json');writeFileSync(target,JSON.stringify(baseRun()));symlinkSync(target,file);
 assert.throws(()=>s.readRun('run-1'));assert.throws(()=>s.putRun(baseRun()));assert.equal(readFileSync(target,'utf8'),JSON.stringify(baseRun()));
 } finally {cleanup(dir);cleanup(outside);}
});
