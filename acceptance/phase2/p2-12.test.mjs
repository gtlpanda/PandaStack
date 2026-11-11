// PROPOSED ONLY. Independent review and supervisor authorization required before execution.
// Never sources/launches capture-owner or calls any owner/group/signal function.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
function predicates(){
 const file=join(ROOT,'core/skills/verify/capture-owner.sh'),bytes=readFileSync(file),source=bytes.toString('utf8');
 const root=source.slice(source.indexOf('co_root() {'),source.indexOf('co_main() {'));
 const lines=root.split('\n').filter(line=>line.includes('-u "$STOP_FD"')&&line.includes('message'));
 assert.equal(lines.length,4,'all four actual decision sites must be bound');
 return lines.map((line,i)=>{
  let condition=line.trim();
  if(condition.startsWith('if '))condition=condition.slice(3).split('; then co_stop_local')[0];
  else condition=condition.split(' && { co_stop_local')[0];
  // Only the exact inert builtin predicate may be extracted; fail rather than execute
  // arbitrary source changes, following shell commands, owner code, or substitutions.
  assert.match(condition,/^IFS= read -r (?:-d '' )?-t 0\.(?:01|02|05) -u "\$STOP_FD" -n 16 message(?: \|\| \[\[ \$message \]\])?$/);
  return {site:i+1,sourceHash:createHash('sha256').update(bytes).digest('hex'),condition:condition.replace(' -u "$STOP_FD"','')};
 });
}
function observed(predicate,input){
 const script="message=''; if "+predicate.condition+"; then printf observed; else printf empty; fi";
 const r=spawnSync('/bin/bash',['--noprofile','--norc','-c',script],{input,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},timeout:2000,maxBuffer:1024});
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0);assert.equal(r.stderr,'');return r.stdout;
}
test('finite inert stdin NUL and ordinary bytes are observed by each source-bound decision predicate',()=>{
 for(const p of predicates())for(const [label,bytes] of [['nul',Buffer.from([0])],['nul then literal',Buffer.from([0,120])],['newline',Buffer.from([10])],['one byte EOF',Buffer.from('x')],['bounded ordinary bytes',Buffer.from('abcdefghijklmnop')]])assert.equal(observed(p,bytes),'observed',`${label}, site ${p.site}, source ${p.sourceHash}`);
});
test('finite empty stdin EOF does not report input at any source-bound decision predicate',()=>{
 for(const p of predicates())assert.equal(observed(p,Buffer.alloc(0)),'empty',`site ${p.site}, source ${p.sourceHash}`);
});
