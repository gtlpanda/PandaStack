// External draft: review and supervisor authorization before execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const api=()=>import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/schema.mjs')));
const code=c=>e=>e?.code===c;
const str={type:'string'},obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required}),wire=v=>({json:JSON.stringify(v)});
const bad=(fn,v,s)=>{const e=fn(v,s);assert.ok(Array.isArray(e)&&e.length>0&&e.length<=100);};
test('exact wire contract; optional omission remains absent',async()=>{
 const {encodeOutputContract,schemaProblems}=await api(),s=obj({decision:{type:'string',enum:['verified','replace']},fingerprint:str,reason:str},['decision']),c=encodeOutputContract(s);
 assert.deepEqual(c.wireSchema,{type:'object',properties:{json:{type:'string'}},required:['json'],additionalProperties:false});
 const out=c.decode(wire({decision:'verified',fingerprint:'f'}));assert.equal(Object.hasOwn(out,'reason'),false);assert.deepEqual(schemaProblems(out,s),[]);
 assert.throws(()=>c.decode(wire({decision:'verified',reason:null})),code('INVALID_RESULT'));
});
test('actual audit open candidate fields and optional canonical lifecycle preserved',async()=>{
 const {encodeOutputContract}=await api();
 // Exact relevant shapes from security-audit-flow CANONICAL_REFS_SCHEMA and HUNT_SCHEMA.
 const s=obj({canonical_refs:obj({surface:str,boundary:str,subsystem:str,attack_class:str,lifecycle:str},['surface','boundary','subsystem','attack_class']),candidates:{type:'array',items:obj({fingerprint:str,proposed_verdict:{type:'string',enum:['confirmed','needs_validation']}})}});
 const v={canonical_refs:{surface:'src/app.js#route',boundary:'src/db.js#q',subsystem:'src',attack_class:'Access control'},candidates:[{fingerprint:'fp',proposed_verdict:'needs_validation',title:'claim',evidence:[{file:'src/app.js',line:1,quote:'inert source'}],validation_plan:{steps:['inspect'],observed:false}}]};
 const out=encodeOutputContract(s).decode(wire(v));assert.deepEqual(out,v);assert.notEqual(out,v);assert.equal(Object.hasOwn(out.canonical_refs,'lifecycle'),false);
});
test('null union exact and no primitive coercion',async()=>{
 const {schemaProblems,encodeOutputContract}=await api(),s=obj({artifact:{type:['string','null']}});
 for(const artifact of [null,'path'])assert.deepEqual(schemaProblems({artifact},s),[]);
 for(const artifact of [0,false,[],{}])bad(schemaProblems,{artifact},s);
 for(const [v,schema] of [['1',{type:'integer'}],[1,str],['false',{type:'boolean'}],[1,{type:'null'}]])assert.throws(()=>encodeOutputContract(schema).decode(wire(v)),code('INVALID_RESULT'));
});
test('required and prototype-looking property names use own data',async()=>{
 const {schemaProblems,encodeOutputContract}=await api(),properties=JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"toString":{"type":"boolean"}}'),s=obj(properties),v=JSON.parse('{"__proto__":"data","constructor":4,"toString":true}');
 assert.deepEqual(schemaProblems(v,s),[]);assert.deepEqual(encodeOutputContract(s).decode(wire(v)),v);bad(schemaProblems,{},s);
 assert.deepEqual(schemaProblems({x:1},{type:'object',required:['x']}),[]);bad(schemaProblems,{}, {type:'object',required:['toString']});assert.equal(Object.prototype.polluted,undefined);
});
test('objects open by default and explicit closure respected',async()=>{
 const {schemaProblems}=await api();assert.deepEqual(schemaProblems({x:{a:[null,true]}},{type:'object'}),[]);
 bad(schemaProblems,{x:1},{type:'object',additionalProperties:false});
 assert.deepEqual(schemaProblems([1,'x',null],{type:'array'}),[]);
 const s={type:'object',properties:{x:str},additionalProperties:false};assert.deepEqual(schemaProblems({x:'yes'},s),[]);bad(schemaProblems,{x:'yes',y:2},s);
});
test('inclusive numeric and array bounds; union constraints only applicable type',async()=>{
 const {schemaProblems}=await api(),s={type:'integer',minimum:1,maximum:4};
 for(const v of [1,4])assert.deepEqual(schemaProblems(v,s),[]);for(const v of [0,5,1.5])bad(schemaProblems,v,s);
 const a={type:'array',items:s,minItems:2,maxItems:2};assert.deepEqual(schemaProblems([1,4],a),[]);for(const v of [[],[1],[1,2,3],[1,'2']])bad(schemaProblems,v,a);
 assert.deepEqual(schemaProblems(null,{type:['integer','null'],minimum:1}),[]);
});
test('annotations allowed; unsupported schema never silently ignored',async()=>{
 const {schemaProblems,encodeOutputContract}=await api();assert.deepEqual(schemaProblems('x',{type:'string',title:'name',description:'data',$comment:'note'}),[]);
 for(const extra of [{pattern:'x'},{minLength:1},{maxLength:2},{format:'email'},{$ref:'#/x'},{$schema:'anything'},{anyOf:[]},{allOf:[]},{oneOf:[]},{const:'x'},{default:'x'},{unknown:true}])assert.throws(()=>encodeOutputContract({...str,...extra}),code('UNSUPPORTED_SCHEMA'));
 assert.throws(()=>encodeOutputContract({type:'object',enum:[{}]}),code('UNSUPPORTED_SCHEMA'));
 assert.throws(()=>encodeOutputContract({type:'object',additionalProperties:str}),code('UNSUPPORTED_SCHEMA'));
});
test('malformed supported schema and nested unsupported fields reject upfront',async()=>{
 const {encodeOutputContract}=await api();
 for(const s of [{},{type:'imaginary'},{type:[]},{type:['string','string']},{type:'string',required:['x']},{type:'object',required:['x','x']},{type:'object',properties:[]},{type:'object',additionalProperties:'yes'},{type:'array',items:[]},{type:'array',minItems:-1},{type:'array',minItems:3,maxItems:2},{type:'integer',minimum:3,maximum:1},{type:'string',enum:[]},{type:'string',enum:['a','a']},{type:'string',title:3}])assert.throws(()=>encodeOutputContract(s),code('INVALID_SCHEMA'));
 assert.throws(()=>encodeOutputContract(obj({unused:{type:'string',pattern:'x'}},[])),code('UNSUPPORTED_SCHEMA'));
});
test('data descriptor validation never invokes getters or serialization hooks',async()=>{
 const {schemaProblems,encodeOutputContract}=await api();let calls=0;const accessor={};Object.defineProperty(accessor,'x',{enumerable:true,get(){calls++;return 1;}});
 const hook={toJSON(){calls++;return {};}},hidden={};Object.defineProperty(hidden,'x',{value:1});const cyclic={};cyclic.x=cyclic;
 for(const v of [accessor,hook,hidden,cyclic,{x:undefined},{x:NaN},{x:Infinity},{x:1n},Object.create({x:1}),Object.assign({}, {[Symbol('x')]:1})])bad(schemaProblems,v,{type:'object'});
 bad(schemaProblems,[,,],{type:'array'});
 const s={type:'object'};Object.defineProperty(s,'properties',{enumerable:true,get(){calls++;return {};}});
 assert.throws(()=>encodeOutputContract(s),code('INVALID_SCHEMA'));assert.equal(calls,0);
 assert.deepEqual(schemaProblems(Object.assign(Object.create(null),{x:1}),{type:'object'}),[]);
});
test('schema and wire mutations cannot loosen captured decoder; results detached',async()=>{
 const {encodeOutputContract}=await api(),s=obj({x:{type:'string'}}),original=structuredClone(s),c=encodeOutputContract(s);
 assert.deepEqual(s,original);s.properties.x.type='integer';s.required=[];try{c.wireSchema.additionalProperties=true;c.wireSchema.required=[];}catch{}
 assert.deepEqual(c.decode(wire({x:'ok'})),{x:'ok'});assert.throws(()=>c.decode(wire({x:3})),code('INVALID_RESULT'));assert.throws(()=>c.decode({json:'{"x":"ok"}',extra:true}),code('INVALID_WIRE'));
 const a=c.decode(wire({x:'ok'})),b=c.decode(wire({x:'ok'}));try{a.x='changed';}catch{}assert.equal(b.x,'ok');
});
test('wire exact and JSON parsed once; no prose or markdown repair',async()=>{
 const {encodeOutputContract}=await api(),c=encodeOutputContract({type:'object'});
 for(const v of [null,[],{},{json:1},{json:'{}',extra:1}])assert.throws(()=>c.decode(v),code('INVALID_WIRE'));
 for(const json of ['',String.fromCharCode(96).repeat(3)+'json\n{}','{broken','{"x":1e400}'])assert.throws(()=>c.decode({json}),code('INVALID_JSON'));
 assert.throws(()=>c.decode({json:JSON.stringify('{}')}),code('INVALID_RESULT'));
});
test('UTF8 limits apply to schema, whole wire and JSON values',async()=>{
 const {schemaProblems,encodeOutputContract}=await api(),huge='é'.repeat(524289);
 bad(schemaProblems,huge,str);assert.throws(()=>encodeOutputContract({type:'string',description:huge}),code('INVALID_SCHEMA'));
 const c=encodeOutputContract(str);assert.throws(()=>c.decode(wire(huge)),code('INVALID_WIRE'));assert.equal(c.decode(wire('é'.repeat(1000))).length,1000);
});
test('depth64 supported but depth65 rejected including unconstrained open values',async()=>{
 const {schemaProblems,encodeOutputContract}=await api(),nest=n=>{let v=0;for(let i=0;i<n;i++)v={x:v};return v;};
 assert.deepEqual(schemaProblems(nest(64),{type:'object'}),[]);bad(schemaProblems,nest(65),{type:'object'});
 const c=encodeOutputContract({type:'object'});assert.deepEqual(c.decode(wire(nest(64))),nest(64));assert.throws(()=>c.decode(wire(nest(65))),code('INVALID_RESULT'));
 let s=str;for(let i=0;i<65;i++)s={type:'array',items:s};assert.throws(()=>encodeOutputContract(s),code('INVALID_SCHEMA'));
});
test('diagnostic count and length bounded; keys and contents never echoed',async()=>{
 const {schemaProblems,encodeOutputContract}=await api(),secret='PRIVATE_SENTINEL',v={},p={}; // allow-secret: inert sentinel used only to assert diagnostic redaction
 for(let i=0;i<150;i++){v[secret+i]=secret;p[secret+i]={type:'integer'};}
 const errors=schemaProblems(v,obj(p));assert.ok(errors.length>0&&errors.length<=100);assert.ok(errors.every(x=>typeof x==='string'&&x.length<=256&&!x.includes(secret)));
 assert.throws(()=>encodeOutputContract(obj(p)).decode(wire(v)),e=>e.code==='INVALID_RESULT'&&!e.message.includes(secret));
});

test('Proxy rejected before reflection for schema, values and wire without invoking traps',async()=>{
 const {schemaProblems,encodeOutputContract}=await api();let calls=0;
 const proxy=target=>new Proxy(target,{getPrototypeOf(){calls++;return Object.prototype;},ownKeys(){calls++;return [];},getOwnPropertyDescriptor(){calls++;return undefined;},get(){calls++;return undefined;}});
 assert.throws(()=>encodeOutputContract(proxy({type:'object'})),code('INVALID_SCHEMA'));
 assert.throws(()=>encodeOutputContract(obj({nested:proxy(str)})),code('INVALID_SCHEMA'));
 bad(schemaProblems,proxy({x:1}),{type:'object'});
 bad(schemaProblems,{nested:proxy({x:1})},{type:'object'});
 const c=encodeOutputContract({type:'object'});
 assert.throws(()=>c.decode(proxy({json:'{}'})),code('INVALID_WIRE'));
 assert.equal(calls,0);
});
