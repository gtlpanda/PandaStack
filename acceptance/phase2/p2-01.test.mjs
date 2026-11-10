import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mod,decision,approval,REV,NOW} from './support.mjs';

test('decision construction validates complete snapshots and detaches caller data',async()=>{
 const {validateDecision,createDecision}=await mod('records');
 const input=decision(),before=structuredClone(input),out=createDecision(input);
 assert.deepEqual(validateDecision(out),[]);assert.deepEqual(out,before);assert.deepEqual(input,before);
 input.options[0].label='Changed';input.evidence[0].label='Changed';input.question='Changed';
 assert.deepEqual(out,before,'record aliases mutable caller input');
 assert.deepEqual(validateDecision(approval()),[]);
 assert.deepEqual(validateDecision(decision({recommendation:null,evidence:[],expiresAt:'2026-11-11T12:00:00.000Z'})),[]);
});

test('malformed decisions fail safely without accepting extra data or invalid boundaries',async()=>{
 const {validateDecision,createDecision}=await mod('records');
 const bad=[null,[],{},decision({schemaVersion:2}),decision({id:'../SECRET'}),decision({runId:''}),
 decision({repo:'relative/SECRET'}),decision({revision:'A'.repeat(40)}),decision({revision:'a'.repeat(39)}),
 decision({question:''}),decision({reason:'x'.repeat(4097)}),decision({question:'x'.repeat(4097)}),
 decision({options:[{id:'one',label:'One'}]}),decision({options:[{id:'x',label:'One'},{id:'x',label:'Two'}]}),
 decision({options:[{id:'x',label:''},{id:'y',label:'Two'}]}),decision({recommendation:'missing'}),
 decision({evidence:[{label:'Secret',uri:'javascript:SECRET'}]}),decision({evidence:[{label:'Secret',uri:'http://example.test/SECRET'}]}),
 decision({kind:'unknown'}),decision({scope:{action:'merge',resource:'x',revision:REV}}),
 approval({scope:null}),approval({scope:{action:'delete',resource:'x',revision:REV}}),
 approval({scope:{action:'deploy',resource:'x',revision:'b'.repeat(40)}}),approval({options:decision().options}),
 decision({createdAt:'2026-02-30T12:00:00.000Z'}),decision({createdAt:'not-a-time'}),decision({expiresAt:NOW}),
 decision({expiresAt:'2026-11-09T12:00:00.000Z'}),decision({secret:'SECRET'}),
 decision({options:[{id:'x',label:'X',secret:'SECRET'},{id:'y',label:'Y'}]}),
 decision({evidence:[{label:'X',uri:'/tmp/evidence',secret:'SECRET'}]})];
 for(const value of bad){
  const problems=validateDecision(value);assert.ok(Array.isArray(problems)&&problems.length>0);
  assert.ok(problems.every(p=>typeof p==='string'));assert.doesNotMatch(JSON.stringify(problems),/SECRET/);
  assert.throws(()=>createDecision(value),e=>e.code==='INVALID_DECISION'&&!e.message.includes('SECRET'));
 }
});

test('size limits and local evidence preserve a useful valid boundary',async()=>{
 const {validateDecision}=await mod('records');
 const value=decision({question:'q'.repeat(4096),reason:'r'.repeat(4096),recommendation:'o0',
  options:Array.from({length:20},(_,i)=>({id:'o'+i,label:'l'.repeat(256)})),
  evidence:Array.from({length:20},(_,i)=>({label:'l'.repeat(256),uri:'/tmp/evidence-'+i}))});
 assert.deepEqual(validateDecision(value),[]);
 assert.ok(validateDecision({...value,options:[...value.options,{id:'o20',label:'Extra'}]}).length);
 assert.ok(validateDecision({...value,evidence:[...value.evidence,{label:'Extra',uri:'/tmp/extra'}]}).length);
 assert.ok(validateDecision({...value,options:[{id:'o0',label:'l'.repeat(257)},{id:'o1',label:'One'}]}).length);
});
