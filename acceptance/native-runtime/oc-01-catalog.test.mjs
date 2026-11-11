import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const load=()=>import(pathToFileURL(resolve(ROOT,'core/skills/native-runtime/catalog.mjs')));
const full=()=>JSON.parse(readFileSync(new URL('./oc-01-catalog.fixture.json',import.meta.url)));
const sha=s=>createHash('sha256').update(s).digest('hex');
const bad=e=>e.code==='INVALID_CATALOG_INPUT';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'offering-catalog-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const installationRoot=join(root,'install'),skillsRoot=join(root,'skills');mkdirSync(installationRoot);mkdirSync(skillsRoot);const catalog=full();catalog.offerings=[{...catalog.offerings.find(x=>x.id==='security-audit'),source:'source/security-audit',entrySha256:sha('# inert source\n')}];for(const k of ['workflows','assets','fixedTargets','installerTargets','aliases'])catalog[k]=[];const source=join(installationRoot,'source/security-audit');mkdirSync(source,{recursive:true});writeFileSync(join(source,'SKILL.md'),'# inert source\n');return {root,installationRoot,skillsRoot,catalog,source};}
test('declared catalog covers historical inventory plus explicit native-runtime library and exact current assets',async()=>{
 const api=await load(),catalog=full(),inventory=JSON.parse(readFileSync(resolve(ROOT,'spec/codex-parity-inventory.json')));assert.deepEqual(api.validateCatalog(catalog),[]);assert.equal(inventory.skills.length,45);assert.equal(catalog.offerings.length,inventory.skills.length+1);assert.equal(catalog.workflows.length,6);assert.equal(catalog.assets.length,46);assert.equal(catalog.fixedTargets.length,4);
 assert.deepEqual(catalog.offerings.filter(x=>x.id!=='native-runtime').map(x=>[x.id,x.source]),inventory.skills.map(x=>[x.name,x.source]));
 assert.deepEqual(catalog.installerTargets,[...inventory.installerTargets,{target:'skills/native-runtime',source:'core/skills/native-runtime',codexInstaller:false,kind:'skills'}]);
 assert.deepEqual(catalog.workflows,inventory.workflows.map(x=>({source:x.source,roles:x.roles,nativeReadiness:'unknown'})));assert.deepEqual(catalog.assets,inventory.otherInstallerAssets.map(x=>({target:x.target,source:x.source,kind:x.kind})));assert.deepEqual(catalog.fixedTargets,inventory.fixedInstallerTargets);
 for(const entry of catalog.offerings){const skill=resolve(ROOT,entry.source,'SKILL.md');assert.equal(entry.entrySkill,existsSync(skill));assert.equal(entry.entrySha256,entry.entrySkill?sha(readFileSync(skill)):null);}
 const library=catalog.offerings.find(x=>x.id==='native-runtime');assert.equal(library.entrySkill,false);assert.equal(library.nativeReadiness,'unknown');
 const actual=[];for(const base of ['core','kit',...readdirSync(resolve(ROOT,'graphs')).map(x=>'graphs/'+x)]){const dir=resolve(ROOT,base,'skills');if(existsSync(dir))for(const name of readdirSync(dir))actual.push(base+'/skills/'+name);}
 assert.deepEqual(catalog.offerings.map(x=>x.source).sort(),actual.sort());assert.equal(catalog.offerings.find(x=>x.id==='decisions').entrySkill,false);
});
test('explicit-root load reads inert catalog and never creates missing paths',async t=>{
 const api=await load(),x=fixture(t);assert.throws(()=>api.loadOfferingCatalog({installationRoot:x.installationRoot}),e=>e.code==='NOT_FOUND');assert.equal(existsSync(join(x.installationRoot,'spec')),false);mkdirSync(join(x.installationRoot,'spec'));writeFileSync(join(x.installationRoot,'spec/offering-capabilities.json'),JSON.stringify(x.catalog));const got=api.loadOfferingCatalog({installationRoot:x.installationRoot});assert.deepEqual(got,x.catalog);try{got.offerings[0].id='mutated';}catch{}assert.equal(api.loadOfferingCatalog({installationRoot:x.installationRoot}).offerings[0].id,'security-audit');
});
test('visibility distinguishes absent linked copy and drift without native certification',async t=>{
 const api=await load(),x=fixture(t),entry=join(x.skillsRoot,'security-audit');
 const args={catalog:x.catalog,installationRoot:x.installationRoot,skillsRoot:x.skillsRoot,backend:'codex'};assert.equal(api.discoverOfferings(args).offerings[0].visibility,'absent');symlinkSync(x.source,entry,'dir');let row=api.discoverOfferings(args).offerings[0];assert.equal(row.visibility,'linked');assert.equal(row.nativeReadiness,'unknown');rmSync(entry);mkdirSync(entry);writeFileSync(join(entry,'SKILL.md'),'# inert source\n');assert.equal(api.discoverOfferings(args).offerings[0].visibility,'copy');writeFileSync(join(entry,'SKILL.md'),'changed');assert.equal(api.discoverOfferings(args).offerings[0].visibility,'drifted');assert.equal(readFileSync(join(x.source,'SKILL.md'),'utf8'),'# inert source\n');
});
test('static wrong and broken links remain visible problems without adopting external source',async t=>{
 const api=await load(),x=fixture(t),entry=join(x.skillsRoot,'security-audit'),outside=join(x.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'SKILL.md'),'not installed authority');symlinkSync(outside,entry,'dir');const args={catalog:x.catalog,installationRoot:x.installationRoot,skillsRoot:x.skillsRoot,backend:'codex'};assert.equal(api.discoverOfferings(args).offerings[0].visibility,'wrong-target');assert.equal(readFileSync(join(outside,'SKILL.md'),'utf8'),'not installed authority');rmSync(entry);symlinkSync(join(x.root,'missing'),entry,'dir');assert.equal(api.discoverOfferings(args).offerings[0].visibility,'broken');
});
test('catalog validation rejects duplicate paths refs and executable data before hooks',async()=>{
 const api=await load();let hooks=0;for(const mutate of [c=>c.offerings.push(c.offerings[0]),c=>c.offerings[0].source='../outside',c=>c.offerings[0].dependencies=['absent-id'],c=>{c.offerings[0].dependencies=[c.offerings[1].id];c.offerings[1].dependencies=[c.offerings[0].id];},c=>c.unrecognized=true]){const c=full();mutate(c);assert.ok(api.validateCatalog(c).length>0);}
 const getter={};Object.defineProperty(getter,'schemaVersion',{enumerable:true,get(){hooks++;return 1;}});assert.ok(api.validateCatalog(getter).length>0);assert.ok(api.validateCatalog(new Proxy({},{ownKeys(){hooks++;return [];}})).length>0);assert.equal(hooks,0);
});
test('selected settings preserve real config resolver output while auth runtime payer stay unknown',async t=>{
 const api=await load(),x=fixture(t);symlinkSync(x.source,join(x.skillsRoot,'security-audit'),'dir');const {resolveSettings}=await import(pathToFileURL(resolve(ROOT,'core/skills/run-records/doctor.mjs')));const central=JSON.parse(readFileSync(resolve(ROOT,'agent-config.json')));
 for(const backend of ['codex','claude']){const settings=resolveSettings({backend,central,project:{},env:{},overrides:{}}),discovery=api.discoverOfferings({catalog:x.catalog,installationRoot:x.installationRoot,skillsRoot:x.skillsRoot,backend}),report=api.projectOfferingPreflight({catalog:x.catalog,discovery,offeringId:'security-audit',backend,settings});assert.deepEqual(report.settings,settings);assert.equal(report.readiness,'unknown');for(const key of ['auth','account','payer'])assert.deepEqual(report[key],{status:'unknown',value:null});assert.equal(report.backend,backend);}
});
test('unsupported backend secret-bearing options and missing source never become readiness',async t=>{
 const api=await load(),x=fixture(t),args={catalog:x.catalog,installationRoot:x.installationRoot,skillsRoot:x.skillsRoot,backend:'codex'};assert.throws(()=>api.discoverOfferings({...args,backend:'fallback'}),bad);const discovery=api.discoverOfferings(args),settings={values:{},sources:{}};assert.throws(()=>api.projectOfferingPreflight({catalog:x.catalog,discovery,offeringId:'security-audit',backend:'codex',settings,providerVerified:true}),bad);rmSync(x.source,{recursive:true});const missing=api.discoverOfferings(args);assert.equal(missing.offerings[0].sourceStatus,'missing');assert.equal(api.projectOfferingPreflight({catalog:x.catalog,discovery:missing,offeringId:'security-audit',backend:'codex',settings}).readiness,'degraded');
});
test('source drift and unknown entry inventory remain deterministic and read-only',async t=>{
 const api=await load(),x=fixture(t);writeFileSync(join(x.skillsRoot,'unrecognized.txt'),'inert unknown');writeFileSync(join(x.source,'SKILL.md'),'new owner bytes');const args={catalog:x.catalog,installationRoot:x.installationRoot,skillsRoot:x.skillsRoot,backend:'codex'},a=api.discoverOfferings(args),b=api.discoverOfferings(args);assert.deepEqual(a,b);assert.equal(a.offerings[0].sourceStatus,'drifted');assert.deepEqual(a.unknownEntries,['unrecognized.txt']);assert.equal(readFileSync(join(x.source,'SKILL.md'),'utf8'),'new owner bytes');assert.equal(readFileSync(join(x.skillsRoot,'unrecognized.txt'),'utf8'),'inert unknown');
});
