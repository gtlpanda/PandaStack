// UNFROZEN, NOT EXECUTED. Intended: acceptance/security-audit/provider-refusal.test.mjs
// Generic top-level protocol fixtures only. No blocked finding/reproduction/provider execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,readdirSync,existsSync,lstatSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {REFUSAL,events,refusalEvent,makeFixture} from './provider-refusal-fixtures.mjs';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const imp=p=>import(pathToFileURL(resolve(ROOT,p)));
const [{readCodexResult},{classifyOutcome},native,{reviewStatus}]=await Promise.all([
 imp('graphs/autobuild/tool/lib/codex.mjs'),imp('graphs/autobuild/tool/lib/limits.mjs'),
 imp('graphs/hunt/skills/bughunt/native-runner.mjs'),imp('graphs/hunt/skills/bughunt/review-status.mjs')]);
const statusApi=()=>imp('graphs/hunt/skills/bughunt/native-status.mjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const parse=(t,rows)=>{const dir=mkdtempSync(join(tmpdir(),'refusal-protocol-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'stream.jsonl');writeFileSync(file,events(rows));return readCodexResult(file);};
const start=(f,processRunner,extra={})=>native.runNativeHunt({repo:f.repo,tree:join(f.prep.stateDir,'tree'),stateDir:f.prep.stateDir,config:f.config,mode:'discover',processRunner,...extra});
const noCalls=async()=>assert.fail('guard must prevent any provider/evidence callback');
const receiptFile=f=>join(f.common,'native-hunt-refusal.json');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const noRetryAdvice=text=>assert.doesNotMatch(text,/rephrase|rerun|retry it|remove[^\n]*lock/i);
function verifyReference(f,ref){const p=join(f.common,ref.path),bytes=readFileSync(p);assert.equal(sha(bytes),ref.sha256);assert.equal(bytes.length,ref.bytes);return p;}

for(const event of ['error','turn.failed'])test(`trusted ${event} protocol produces sticky nonretryable refusal`,t=>{
 const row=event==='error'?{type:event,message:REFUSAL}:refusalEvent();
 const parsed=parse(t,[row,{type:'turn.completed',usage:{}}]);
 assert.equal(parsed.is_error,true);assert.equal(parsed.subtype,'error_during_execution');
 assert.deepEqual(parsed.providerRefusal,{kind:'provider_refusal',retryable:false,event,line:1});
 assert.deepEqual(classifyOutcome({result:parsed}),{kind:'provider_refusal',retryable:false,message:'Provider declined this work; automatic retry is blocked.'});
});
test('refusal wording in tool/agent/raw text never grants protocol classification',t=>{
 const parsed=parse(t,[{type:'item.completed',item:{type:'command_execution',aggregated_output:REFUSAL}},
  {type:'item.completed',item:{type:'agent_message',text:REFUSAL}},{type:'turn.completed',usage:{}}]);
 assert.equal(parsed.is_error,false);assert.equal(parsed.providerRefusal,undefined);
 for(const args of [{result:parsed},{text:REFUSAL},{result:{subtype:'error_during_execution',is_error:true,result:REFUSAL}}])assert.equal(classifyOutcome(args).kind,'normal');
});
for(const [message,kind] of [['usage limit reached','usage_limit'],['credit balance is too low','billing'],['authentication required','auth'],['overloaded','transient'],['ordinary generic failure','normal']])test(`existing ${kind} protocol classification remains unchanged`,t=>{
 const parsed=parse(t,[{type:'turn.failed',error:{message}}]);assert.equal(parsed.providerRefusal,undefined);assert.equal(classifyOutcome({result:parsed}).kind,kind);
});

test('generic refused analysis writes immutable receipt and honest current partial status without granting PR completion',async t=>{
 const f=await makeFixture(ROOT,t),log=[];const result=await start(f,f.runner(),{log:s=>log.push(s)});
 assert.equal(result.code,12);assert.equal(result.outcome?.kind,'provider_refusal');assert.equal(result.outcome.retryable,false);
 assert.equal(f.calls.length,1);assert.equal(result.ledger.status,'escalate');assert.equal(reviewStatus(f.repo,'HEAD',{base:'main'}).hunted,false);
 const api=await statusApi(),receipt=api.readNativeHuntRefusal(f.repo);
 assert.deepEqual(Object.keys(receipt).sort(),['version','kind','retryable','repository','run','target','leaf','protocol','observedAt','statusPath'].sort());
 assert.equal(receipt.version,1);assert.equal(receipt.kind,'provider_refusal');assert.equal(receipt.retryable,false);assert.equal(receipt.repository,f.common);
 assert.equal(receipt.leaf.role,'impact-mapper');assert.equal(receipt.protocol.event,'turn.failed');assert.equal(receipt.protocol.line,1);verifyReference(f,receipt.protocol);
 assert.equal(receipt.statusPath,receipt.run.directory+'/status.json');assert.equal(lstatSync(receiptFile(f)).mode&0o777,0o600);
 const view=api.readNativeHuntPartialStatus(f.repo),status=view.status;
 assert.equal(status.refusalSha256,sha(readFileSync(receiptFile(f))));assert.equal(status.state,'blocked');assert.equal(status.retryable,false);
 assert.deepEqual(status.counts,{completed:0,pending:0,active:0,failed:0,blocked:1});assert.equal(status.unplannedWork,'unknown');
 assert.equal(view.report.state,'current');assert.match(view.report.text,/provider.refusal|provider declined/i);assert.match(view.report.text,/provisional|incomplete/i);noRetryAdvice(view.report.text);noRetryAdvice(log.join('\n'));
 assert.equal(lstatSync(join(f.common,receipt.run.directory)).mode&0o777,0o700);
 assert.equal(lstatSync(join(f.common,receipt.statusPath)).mode&0o777,0o600);
 assert.equal(sha(Buffer.from(view.report.text)),status.report.sha256);
 assert.equal(api.renderNativeHuntPartialStatus(status),view.report.text);
 // Pure presentation fixture only: indexes are not an authoritative ledger or a completed hunt.
 const provisional=structuredClone(status);
 provisional.coverage=[{lens:'logic',status:'partial',areas:1}];
 provisional.provisionalFindings=[{findingId:'F90',verificationStatus:'confirmed',fixStatus:'none'}];
 const prose=api.renderNativeHuntPartialStatus(provisional);
 assert.match(prose,/F90/);assert.match(prose,/confirmed/);assert.match(prose,/logic[\s\S]*partial/);
 assert.match(prose,/provisional/i);assert.match(prose,/static|source.only/i);noRetryAdvice(prose);

});

test('completed impact is retained, first refused hunter blocks queued hunters and no evidence runner executes',async t=>{
 const f=await makeFixture(ROOT,t),result=await start(f,f.runner({refuse:'hunter'}));
 assert.equal(result.outcome?.kind,'provider_refusal');assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(c=>c.role),['impact-mapper','hunter']);
 const view=(await statusApi()).readNativeHuntPartialStatus(f.repo),s=view.status;
 assert.equal(s.counts.completed,1);assert.equal(s.counts.blocked,1);assert.equal(s.counts.active,0);assert.equal(s.counts.failed,0);assert.ok(s.counts.pending>=1);
 assert.equal(s.leaves.length,Object.values(s.counts).reduce((a,b)=>a+b,0));
 const completed=s.leaves.find(l=>l.state==='completed');assert.equal(completed.role,'impact-mapper');verifyReference(f,completed.protocol);verifyReference(f,completed.output);
 assert.equal(reviewStatus(f.repo,'HEAD',{base:'main'}).hunted,false);
});

test('later admitted refusal remains nonretryable even after an ordinary sibling failed first',async t=>{
 const f=await makeFixture(ROOT,t);f.config.maxConcurrentSubagents=2;
 const clean=f.runner({refuse:'never'});let hunters=0;
 const processRunner=async(bin,argv,opts)=>{
  if(opts.env.PANDASTACK_HUNT_ROLE!=='hunter')return clean(bin,argv,opts);
  assert.equal(bin,'inert-protocol');hunters++;
  f.calls.push({role:'hunter',label:opts.env.PANDASTACK_HUNT_LABEL,logFile:opts.logFile,runDir:dirname(opts.logFile)});
  writeFileSync(opts.logFile+'.stderr','');
  if(hunters===1){writeFileSync(opts.logFile,events([{type:'turn.failed',error:{message:'ordinary generic failure'}}]));return 1;}
  assert.equal(hunters,2,'no queued third hunter may start');
  await new Promise(resolve=>setImmediate(resolve));
  writeFileSync(opts.logFile,events([refusalEvent()]));return 1;
 };
 const result=await start(f,processRunner);assert.equal(result.outcome?.kind,'provider_refusal');
 const view=(await statusApi()).readNativeHuntPartialStatus(f.repo);assert.equal(view.status.counts.failed,1);assert.equal(view.status.counts.blocked,1);assert.equal(view.status.counts.active,0);
 assert.equal((await start(f,noCalls)).outcome.kind,'provider_refusal');
});

test('receipt blocks direct, standalone and autobuild hunt before preparation, and changed run/head cannot clear it',async t=>{
 const f=await makeFixture(ROOT,t);await start(f,f.runner());const original=readFileSync(receiptFile(f));
 const sentinel=join(f.prep.stateDir,'tree','retained-sentinel.txt');writeFileSync(sentinel,'keep');
 const entries=()=>readdirSync(join(f.prep.stateDir,'native')).sort(),before=entries();
 const direct=await start(f,noCalls,{runId:'different-run'});assert.equal(direct.code,12);assert.equal(direct.outcome.kind,'provider_refusal');
 let prepared=false;await assert.rejects(native.withNativeRepoLock(f.repo,async()=>{prepared=true;}),{code:'NATIVE_HUNT_REFUSED'});assert.equal(prepared,false);
 const cli=await imp('graphs/hunt/skills/bughunt/native-cli.mjs');
 await assert.rejects(cli.main(['--repo',f.repo,'--base','main','--mode','discover']),{code:'NATIVE_HUNT_REFUSED'});
 const {runBughunt}=await imp('graphs/autobuild/tool/lib/bughunt.mjs'),messages=[];
 assert.equal(await runBughunt(f.config,{runId:'new-id',log:s=>messages.push(s)}),12);noRetryAdvice(messages.join('\n'));
 assert.equal(readFileSync(sentinel,'utf8'),'keep');assert.deepEqual(entries(),before);assert.deepEqual(readFileSync(receiptFile(f)),original);
 writeFileSync(join(f.repo,'unrelated.txt'),'ordinary separate change');f.git('add','.');f.git('commit','-qm','independent ordinary change');
 assert.equal((await start(f,noCalls)).outcome.kind,'provider_refusal');assert.deepEqual(readFileSync(receiptFile(f)),original);
});

test('existing malformed refusal is corruption, never absence or a reason to dispatch',async t=>{
 const f=await makeFixture(ROOT,t),api=await statusApi();assert.equal(api.readNativeHuntRefusal(f.repo),null);
 writeFileSync(receiptFile(f),'{}',{mode:0o600});assert.throws(()=>api.readNativeHuntRefusal(f.repo),{code:'REFUSAL_STATE_INVALID'});
 let called=false;await assert.rejects(native.withNativeRepoLock(f.repo,async()=>{called=true;}),{code:'REFUSAL_STATE_INVALID'});assert.equal(called,false);
});

test('ordinary report write failure preserves refusal and does not call stale prose current',async t=>{
 const f=await makeFixture(ROOT,t),result=await start(f,f.runner({beforeRefusal:({opts})=>mkdirSync(join(dirname(opts.logFile),'partial-report.md'))}));
 assert.equal(result.outcome?.kind,'provider_refusal');assert.ok(existsSync(receiptFile(f)));
 const view=(await statusApi()).readNativeHuntPartialStatus(f.repo);assert.ok(['pending','unavailable','stale'].includes(view.report.state));assert.equal(view.report.text,null);
 assert.equal((await start(f,noCalls)).outcome.kind,'provider_refusal');
});

test('ordinary receipt publication failure retains admission lock and cannot redispatch',async t=>{
 const f=await makeFixture(ROOT,t),result=await start(f,f.runner({beforeRefusal:()=>mkdirSync(receiptFile(f))}));
 assert.notEqual(result.code,0);assert.equal(f.calls.length,1);assert.ok(existsSync(join(f.common,'native-hunt.lock')));
 let called=false;await assert.rejects(native.withNativeRepoLock(f.repo,async()=>{called=true;}));assert.equal(called,false);
});

test('a hunt refusal receipt does not prevent a separately selected ordinary build when no hunt is entered',async t=>{
 const f=await makeFixture(ROOT,t);await start(f,f.runner());const before=readFileSync(receiptFile(f));
 const result=f.run(f.repo,[{build:'F-1'}],f.env);assert.equal(result.code,0,result.out);assert.equal(result.calls.length,1);
 assert.equal(json(join(f.repo,'features.json')).features[0].passes,true);assert.deepEqual(readFileSync(receiptFile(f)),before);
});

for(const role of ['builder','review','probe'])test(`typed ${role} refusal terminates ordinary loop once without accepting or retrying`,async t=>{
 const {project,run,KIT}=await imp('graphs/autobuild/tool/test-fixtures/project.mjs');
 const root=project(['F-1'],{finalReview:role==='review',reviewEvery:99});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const env={AUTOBUILD_BACKEND:'codex',AUTOBUILD_CODEX_BIN:join(KIT,'test-fixtures/fake-codex.mjs'),AUTOBUILD_CLAUDE_BIN:'/no/claude',AUTOBUILD_BUGHUNT:'0'};
 const script=role==='review'?[{build:'F-1'},{error:REFUSAL}]:role==='probe'?[{error:'usage limit reached'},{error:REFUSAL}]:[{error:REFUSAL}];
 const result=run(root,script,env);assert.equal(result.code,15,result.out);assert.equal(result.calls.length,role==='builder'?1:2);assert.match(result.loopLog,/provider_refusal|provider declined/i);
 assert.doesNotMatch(result.loopLog,/every feature passes\. Done\./);
 if(role!=='review')assert.equal(json(join(root,'features.json')).features[0].passes,false);
});


test('explicit host adoption binds preexisting generic settled refusal without changing original artifacts',async t=>{
 const f=await makeFixture(ROOT,t),runDir=join(f.prep.stateDir,'native','legacy-protocol-fixture');mkdirSync(runDir,{recursive:true,mode:0o700});
 const intakeFile=join(f.prep.stateDir,'intake.json'),intake=json(intakeFile);
 const logFile=join(runDir,'001-impact-mapper.jsonl'),resultFile=join(runDir,'result.json');
 writeFileSync(logFile,events([refusalEvent()]),{mode:0o600});
 writeFileSync(resultFile,JSON.stringify({status:'escalate',reason:'Generic provider refusal fixture',mode:'discover',head:intake.target.head,findings:[],added:[],merged:[],dropped:[],coverage:[],routing:null,impact:null,history:[]}),{mode:0o600});
 const original=[intakeFile,logFile,resultFile].map(p=>[p,readFileSync(p)]);
 const expected={intakeSha256:sha(original[0][1]),protocolSha256:sha(original[1][1]),resultSha256:sha(original[2][1])};
 assert.equal(typeof native.adoptNativeHuntRefusal,'function');
 await assert.rejects(async()=>native.adoptNativeHuntRefusal({repo:f.repo,lockToken:{},intakeFile,runDir,leaf:{id:'001-impact-mapper',role:'impact-mapper',label:'impact-map'},expected}),{code:'INVALID_NATIVE_HUNT_OWNER'});
 await native.withNativeRepoLock(f.repo,async lockToken=>{
  const args={repo:f.repo,lockToken,intakeFile,runDir,leaf:{id:'001-impact-mapper',role:'impact-mapper',label:'impact-map'},expected};
  for(const field of ['intakeSha256','protocolSha256','resultSha256']){
   await assert.rejects(async()=>native.adoptNativeHuntRefusal({...args,expected:{...expected,[field]:'0'.repeat(64)}}),{code:'REFUSAL_ADOPTION_INVALID'});
   assert.equal(existsSync(receiptFile(f)),false);
  }
  try{
   writeFileSync(logFile,events([{type:'turn.completed'}]));
   await assert.rejects(async()=>native.adoptNativeHuntRefusal({...args,expected:{...expected,protocolSha256:sha(readFileSync(logFile))}}),{code:'REFUSAL_ADOPTION_INVALID'});
   assert.equal(existsSync(receiptFile(f)),false);
  }finally{writeFileSync(logFile,original[1][1]);}
  try{
   writeFileSync(resultFile,JSON.stringify({...json(resultFile),head:'0'.repeat(intake.target.head.length)}));
   await assert.rejects(async()=>native.adoptNativeHuntRefusal({...args,expected:{...expected,resultSha256:sha(readFileSync(resultFile))}}),{code:'REFUSAL_ADOPTION_INVALID'});
   assert.equal(existsSync(receiptFile(f)),false);
  }finally{writeFileSync(resultFile,original[2][1]);}
  const first=await native.adoptNativeHuntRefusal(args),bytes=readFileSync(receiptFile(f));
  assert.deepEqual(first.target,{kind:intake.target.kind,label:intake.target.label,base:intake.target.base,head:intake.target.head});
  assert.deepEqual(await native.adoptNativeHuntRefusal(args),first);assert.deepEqual(readFileSync(receiptFile(f)),bytes);
 });
 for(const [path,bytes] of original)assert.deepEqual(readFileSync(path),bytes);
 assert.equal(f.calls.length,0);assert.equal((await start(f,noCalls)).outcome.kind,'provider_refusal');
 const view=(await statusApi()).readNativeHuntPartialStatus(f.repo);assert.equal(view.status.counts.completed,0);assert.equal(view.status.counts.blocked,1);assert.equal(view.status.unplannedWork,'unknown');
});
