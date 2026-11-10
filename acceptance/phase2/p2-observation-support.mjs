import assert from 'node:assert/strict';
const common='schemaVersion event eventId at traceId queueNamespace spanId repo decisionRunId invocationRunId featureId decisionId revision deliveryId'.split(' ');
export function observations(output){return output.split('\n').filter(s=>s.startsWith('PANDASTACK_DECISION ')).map(s=>validate(JSON.parse(s.slice('PANDASTACK_DECISION '.length))));}
export function validate(v){
 const extras={waiting:[],received:['answerId','waitDurationMs'],wait_failed:['outcome','waitDurationMs'],context_supplied:['answerId','providerRunId','launchId']};
 const close=v.event==='trace_closed';assert.ok(close||Object.hasOwn(extras,v.event));
 const keys=close?'schemaVersion event eventId at traceId repo revision invocationRunId spanIds eventIds contextEventIds complete'.split(' '):[...common,...extras[v.event]];
 assert.deepEqual(Object.keys(v).sort(),keys.sort());assert.equal(v.schemaVersion,2);
 for(const key of ['eventId','traceId',...(close?[]:['queueNamespace','spanId','decisionRunId','featureId','decisionId','deliveryId']),...('answerId'in v?['answerId']:[]),...('launchId'in v?['launchId']:[])])assert.match(v[key],/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
 for(const key of ['invocationRunId',...('providerRunId'in v?['providerRunId']:[])])assert.ok(v[key]===null||/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v[key]));
 assert.match(v.revision,/^[a-f0-9]{40}$/);assert.ok(v.repo.startsWith('/'));assert.match(v.at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);assert.ok(Number.isFinite(Date.parse(v.at)));
 if('waitDurationMs'in v)assert.ok(Number.isSafeInteger(v.waitDurationMs)&&v.waitDurationMs>=0);
 if(v.event==='wait_failed')assert.ok(['timeout','cancelled','expired','stale','manual_handoff','failed'].includes(v.outcome));
 if(close){assert.equal(typeof v.complete,'boolean');for(const k of ['spanIds','eventIds','contextEventIds']){assert.ok(Array.isArray(v[k]));assert.equal(new Set(v[k]).size,v[k].length);for(const id of v[k])assert.match(id,/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);}assert.ok(!v.eventIds.includes(v.eventId));}
 return v;
}
export function completeTrace(events){const close=events.at(-1);assert.equal(close.event,'trace_closed');assert.equal(close.complete,true);assert.deepEqual(close.eventIds,events.slice(0,-1).map(e=>e.eventId));assert.deepEqual(close.spanIds,[...new Set(events.slice(0,-1).map(e=>e.spanId))]);assert.deepEqual(close.contextEventIds,events.filter(e=>e.event==='context_supplied').map(e=>e.eventId));assert.equal(new Set(events.map(e=>e.eventId)).size,events.length);for(const e of events){assert.equal(e.traceId,close.traceId);assert.equal(e.repo,close.repo);assert.equal(e.invocationRunId,close.invocationRunId);}return close;}
