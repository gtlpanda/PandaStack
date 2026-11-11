// UNFROZEN, NOT EXECUTED. Intended: acceptance/security-audit/provider-refusal-fixtures.mjs
// Existing-owner fixtures only; generic protocol literals, no target/reproduction code.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
export const REFUSAL='This content was flagged for possible cybersecurity risk.';
export const events=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
export const refusalEvent=()=>({type:'turn.failed',error:{message:REFUSAL}});
export async function makeFixture(root,t){
 const imp=p=>import(pathToFileURL(resolve(root,p)));
 const [{project,run,KIT},{loadConfig},{prepareHunt},{fakeHuntResponse}]=await Promise.all([
  imp('graphs/autobuild/tool/test-fixtures/project.mjs'),imp('graphs/autobuild/tool/lib/config.mjs'),
  imp('graphs/hunt/skills/bughunt/land.mjs'),imp('graphs/autobuild/tool/test-fixtures/fake-hunt-response.mjs')]);
 const repo=project(['F-1'],{finalReview:false,reviewEvery:99});
 t.after(()=>rmSync(repo,{recursive:true,force:true}));
 const git=(...a)=>execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...a],{encoding:'utf8'}).trim();
 git('branch','main');mkdirSync(join(repo,'src'));
 writeFileSync(join(repo,'src/ordinary.mjs'),'export const ordinaryFixture = 1;\n');git('add','.');git('commit','-qm','ordinary source fixture');
 const cfg=JSON.parse(readFileSync(join(repo,'autobuild.json'),'utf8'));cfg.bughuntBase='main';writeFileSync(join(repo,'autobuild.json'),JSON.stringify(cfg,null,2));git('add','.');git('commit','-qm','select ordinary review base');
 const prep=prepareHunt({repo,target:'autobuild',base:'main',stamp:'protocol-fixture'});assert.ok(prep.stateDir,JSON.stringify(prep));
 const env={AUTOBUILD_BACKEND:'codex',AUTOBUILD_CODEX_BIN:join(KIT,'test-fixtures/fake-codex.mjs'),AUTOBUILD_CLAUDE_BIN:'/no/claude',AUTOBUILD_BUGHUNT:'0'};
 const config={...loadConfig(repo,{...process.env,...env},{backend:'codex'}),codexBin:'inert-protocol',maxConcurrentSubagents:1};
 const common=git('rev-parse','--path-format=absolute','--git-common-dir');
 const calls=[];
 function runner({refuse='impact-mapper',beforeRefusal=()=>{}}={}){
  return async(bin,argv,opts)=>{
   assert.equal(bin,'inert-protocol','no provider or evidence process may run');
   const role=opts.env.PANDASTACK_HUNT_ROLE,label=opts.env.PANDASTACK_HUNT_LABEL;
   assert.ok(['impact-mapper','hunter'].includes(role),'only ordinary analysis roles are in this fixture');
   calls.push({role,label,logFile:opts.logFile,runDir:dirname(opts.logFile)});writeFileSync(opts.logFile+'.stderr','');
   if(role===refuse){beforeRefusal({opts,common});writeFileSync(opts.logFile,events([refusalEvent()]));return 1;}
   writeFileSync(opts.logFile,events([{type:'turn.completed',usage:{}}]));
   writeFileSync(argv[argv.indexOf('--output-last-message')+1],JSON.stringify(fakeHuntResponse(role,label,'clean')));return 0;
  };
 }
 return {repo,prep,config,common,calls,runner,git,run,env};
}
