// UNSELECTED / UNFROZEN / NOT EXECUTED. Proposed destination:
// acceptance/security-audit/review-baseline-correction.test.mjs
// Existing fake Codex transport + ordinary owned Git fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const {project,run,KIT}=await import(pathToFileURL(resolve(ROOT,'graphs/autobuild/tool/test-fixtures/project.mjs')));
const env={AUTOBUILD_BACKEND:'codex',AUTOBUILD_CODEX_BIN:join(KIT,'test-fixtures/fake-codex.mjs'),AUTOBUILD_CLAUDE_BIN:'/no/claude',AUTOBUILD_BUGHUNT:'0'};
const selected='features-security-audit.json';
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const read=(root,name)=>JSON.parse(readFileSync(join(root,name),'utf8'));
const put=(root,name,value)=>writeFileSync(join(root,name),JSON.stringify(value,null,2)+'\n');
const commit=(root,message)=>{git(root,'add','-A');git(root,'commit','-qm',message);return git(root,'rev-parse','HEAD');};
function fixture(t,{history='missing',passing=2,total=2,limits={},hunt=false}={}){
 const ids=Array.from({length:total},(_,i)=>`F-${i+1}`);
 const root=project(ids,{finalReview:true,reviewEvery:99,...limits});
 // Only the directory returned by existing project() is owned by this fixture.
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src/feature.js'),'export function feature() { return 0; }\n');
 if(history!=='missing')writeFileSync(join(root,selected),typeof history==='string'?history:JSON.stringify(history));
 writeFileSync(join(root,'PROGRESS.md'),'# progress\n\nREVIEW: earlier ordinary review\n');
 const anchor=commit(root,'chore(review): earlier ordinary review');
 if(hunt)git(root,'branch','main');
 const config=read(root,'autobuild.json');config.featuresFile=selected;if(hunt)config.bughuntBase='main';
 put(root,'autobuild.json',config);
 const current=read(root,'features.json');
 put(root,selected,current);const selectedAt=commit(root,'select security backlog with pending features');
 current.features.forEach((f,i)=>{f.passes=i<passing;if(f.passes)writeFileSync(join(root,`${f.id}.done`),'ordinary fixture success\n');});
 put(root,selected,current);writeFileSync(join(root,'src/feature.js'),'export function feature() { return -1; }\n');
 const before=commit(root,'complete selected ordinary fixtures');
 return {root,anchor,selectedAt,before,current};
}
const reviewCommits=root=>git(root,'log','--format=%H','--grep=^chore(review):').split('\n').filter(Boolean);
function assertReview(result,f,count=1){
 assert.equal(result.code,0,result.out);
 assert.equal(result.calls.length,count,result.out);
 for(const call of result.calls)assert.ok(call.input.includes(`${f.anchor}..HEAD`),'review retains the old full SHA range');
 assert.notEqual(reviewCommits(f.root)[0],f.anchor,'host must acknowledge a new review commit');
 assert.match(git(f.root,'log','-1','--format=%s'),/^chore\(review\): Codex drift and defect review$/);
 const at=result.loopLog.indexOf('review: done'),done=result.loopLog.indexOf('every feature passes. Done.');
 assert.ok(at>=0&&done>at,result.loopLog);
 assert.equal(git(f.root,'status','--porcelain'),'');
}

test('missing selected backlog at old review requires actual Codex final review over the original range',t=>{
 const f=fixture(t),before=readFileSync(join(f.root,selected),'utf8');
 const result=run(f.root,[{review:true}],env);
 assertReview(result,f);
 assert.match(result.loopLog,/review: final review, 2 features passed since/);
 assert.equal(readFileSync(join(f.root,selected),'utf8'),before);
 assert.deepEqual(git(f.root,'diff','--name-only',f.before,'HEAD').split('\n'),['PROGRESS.md']);
 // A successful acknowledgment clears the obligation on an ordinary restart.
 const again=run(f.root,[],env);
 assert.equal(again.code,0,again.out);assert.equal(again.calls.length,result.calls.length);
 assert.equal(reviewCommits(f.root).length,2);
});

test('missing historical backlog triggers periodic startup review before the pending builder',t=>{
 const f=fixture(t,{total:3,passing:2,limits:{reviewEvery:2,finalReview:false}});
 const result=run(f.root,[{review:true},{build:'F-3'}],env);
 assert.equal(result.code,0,result.out);assert.equal(result.calls.length,2);
 assert.equal(result.calls[0].step.review,true);assert.equal(result.calls[1].step.build,'F-3');
 assert.ok(result.calls[0].input.includes(`${f.anchor}..HEAD`));
 const reviewed=result.loopLog.indexOf('review: done'),built=result.loopLog.indexOf('iteration 1: F-3');
 assert.ok(reviewed>=0&&built>reviewed,result.loopLog);
 assert.equal(read(f.root,selected).features.find(f=>f.id==='F-3').passes,true);
});

const invalidHistories=[
 ['invalid JSON','{'],['null document',null],['array document',[]],['missing features',{}],['non-array features',{features:{}}],
 ['null row',{features:[{id:'F-1',passes:true},null]}],
 ['duplicate IDs',{features:[{id:'F-1',passes:true},{id:'F-1',passes:false}]}],
 ['empty ID',{features:[{id:'F-1',passes:true},{id:'',passes:false}]}],
 ['nonstring ID',{features:[{id:'F-1',passes:true},{id:2,passes:false}]}],
 ['missing passes',{features:[{id:'F-1',passes:true},{id:'F-2'}]}],
 ['truthy passes',{features:[{id:'F-1',passes:true},{id:'F-2',passes:'yes'}]}],
 ['falsy nonboolean passes',{features:[{id:'F-1',passes:true},{id:'F-2',passes:0}]}],
];
for(const [label,history] of invalidHistories)test(`unusable historical ${label} counts all current passing work`,t=>{
 const f=fixture(t,{history}),result=run(f.root,[{review:true}],env);
 assertReview(result,f);
 assert.match(result.loopLog,/review: final review, 2 features passed since/,'no partial historical row grants clearance');
});

for(const [label,history,outstanding] of [
 ['known passing subset',{features:[{id:'F-1',passes:true,legacy:'allowed'},{id:'F-2',passes:false}]},1],
 ['all current passing covered',{features:[{id:'F-1',passes:true},{id:'F-2',passes:true}]},0],
 ['removed historical IDs ignored',{features:[{id:'F-1',passes:true},{id:'OLD',passes:true}]},1],
 ['empty historical list',{features:[]},2],
])test(`valid historical ${label} preserves set difference`,t=>{
 const f=fixture(t,{history}),result=run(f.root,outstanding?[{review:true}]:[],env);
 assert.equal(result.code,0,result.out);
 if(outstanding){assertReview(result,f);assert.ok(result.loopLog.includes(`review: final review, ${outstanding} features passed since`),result.loopLog);}
 else{assert.equal(result.calls.length,0);assert.equal(reviewCommits(f.root)[0],f.anchor);assert.doesNotMatch(result.loopLog,/review: comparing/);}
});

test('two finite unacknowledged Codex reviews retain range and block Done and hunt',t=>{
 const f=fixture(t,{hunt:true}),result=run(f.root,[{ok:true},{ok:true}],{...env,AUTOBUILD_BUGHUNT:'1'});
 assert.equal(result.code,13,result.out);assert.equal(result.calls.length,2);
 for(const call of result.calls)assert.ok(call.input.includes(`${f.anchor}..HEAD`));
 assert.equal(reviewCommits(f.root)[0],f.anchor);
 assert.doesNotMatch(result.loopLog,/every feature passes\. Done\.|bug hunt: \/bughunt/);
 assert.equal(existsSync(join(f.root,'.harness-script.json.hunt-calls')),false);
});

test('missing backlog Codex review is acknowledged before existing ordinary fake hunt starts',t=>{
 const f=fixture(t,{hunt:true}),result=run(f.root,[{review:true}],{...env,AUTOBUILD_BUGHUNT:'1',FAKE_HUNT_MODE:'clean'});
 assert.equal(result.code,0,result.out);assert.equal(result.calls.length,1);
 assert.ok(result.calls[0].input.includes(`${f.anchor}..HEAD`));
 const reviewed=result.loopLog.indexOf('review: done'),hunted=result.loopLog.indexOf('bug hunt: /bughunt');
 assert.ok(reviewed>=0&&hunted>reviewed,result.loopLog);
 const calls=readFileSync(join(f.root,'.harness-script.json.hunt-calls'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(calls.some(c=>c.role==='impact-mapper'));assert.ok(calls.every(c=>c.args.includes('read-only')));
 const newer=reviewCommits(f.root)[0];assert.notEqual(newer,f.anchor);
 assert.match(git(f.root,'log','-1','--format=%s'),/^chore\(bughunt\): pass$/);
 assert.equal(git(f.root,'merge-base','--is-ancestor',newer,'HEAD'),'');
 assert.ok(result.loopLog.indexOf('every feature passes. Done.')>hunted,result.loopLog);
});

test('explicit finalReview false below periodic threshold remains an opt-out',t=>{
 const f=fixture(t,{limits:{finalReview:false,reviewEvery:99}}),result=run(f.root,[],env);
 assert.equal(result.code,0,result.out);assert.equal(result.calls.length,0);
 assert.equal(reviewCommits(f.root)[0],f.anchor);assert.doesNotMatch(result.loopLog,/review: comparing/);
});
