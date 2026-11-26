const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Dag=require('../../dist/dag.js'),i18n=require('../../dist/i18n.js');
const script=fs.readFileSync(require.resolve('../../dist/connections.js'),'utf8');

// Loads the renderer's routing code with Codex and Claude connected.
function routing(online=['Codex','Claude']){
  const db={settings:{},sessions:[],connections:{}};
  const ctx={Dag,uiText:i18n.text,window:{},db};
  vm.runInNewContext(script+'\n;this.api={runtimes,candidates,route,reviewedBy};',ctx);
  for(const r of ctx.api.runtimes)db.connections[r.name]={online:online.includes(r.name),model:r.models[0]};
  return ctx.api;
}
// write → check, where check reviews write.
function flow(reviewOverrides={}){
  const d=Dag.definition([
    {id:'write',name:'Implement',artifact:'patch',description:'implement',deps:[]},
    {id:'check',name:'Review',artifact:'review',description:'review',deps:['write'],review:true},
  ]);
  return {...d,pack:d.roles,overrides:{...d.overrides,check:reviewOverrides},files:{},dispatch:{}};
}

test('crossReview puts runtimes other than the upstream first and keeps the rest',()=>{
  const list=[{name:'Codex'},{name:'Claude'},{name:'Pi'}];
  assert.deepEqual(Dag.crossReview(list,'Codex').map(r=>r.name),['Claude','Pi','Codex']);
  assert.deepEqual(Dag.crossReview(list,'').map(r=>r.name),['Codex','Claude','Pi']);
  assert.deepEqual(Dag.crossReview([{name:'Codex'}],'Codex').map(r=>r.name),['Codex']);
});

test('a review node routes to a different runtime from the one that produced its input',()=>{
  const {candidates,route}=routing(),f=flow();
  f.dispatch.write={harness:'Codex'};
  assert.equal(candidates(f,'check')[0].name,'Claude');
  const r=route(f,'check');
  assert.equal(r.harness,'Claude');assert.equal(r.cross,true);assert.match(r.reason,/Codex/);
  f.dispatch.write={harness:'Claude'};
  assert.equal(route(f,'check').harness,'Codex');
});

test('a pinned runtime, a non-review node or a single connection is left alone',()=>{
  const {route,candidates}=routing();
  const pinned=flow({harness:'Codex'});pinned.dispatch.write={harness:'Codex'};
  assert.equal(route(pinned,'check').harness,'Codex');
  const plain=flow();plain.pack.check={...plain.pack.check,review:false};plain.dispatch.write={harness:'Codex'};
  assert.equal(candidates(plain,'check')[0].name,'Codex');
  const solo=routing(['Codex']),f=flow();f.dispatch.write={harness:'Codex'};
  const r=solo.route(f,'check');assert.equal(r.harness,'Codex');assert.equal(r.cross,false);
});

test('a workflow file round-trips the definition without task history',()=>{
  const d=Dag.definition([
    {id:'write',name:'Implement',artifact:'patch',description:'secret brief',deps:[],preferred:'Codex'},
    {id:'check',name:'Review',artifact:'review',description:'review it',deps:['write'],review:true},
  ]);
  d.overrides.write={harness:'Codex',model:'m1'};
  const structure=JSON.parse(JSON.stringify(Dag.toFile('Code + review',Dag.stripBriefs(d))));
  assert(!JSON.stringify(structure).includes('secret brief'));
  const back=Dag.fromFile(structure);
  assert.equal(back.name,'Code + review');assert.equal(back.definition.mode,'structure');
  assert.deepEqual(back.definition.deps,d.deps);assert.equal(back.definition.roles.check.review,true);
  assert.deepEqual(back.definition.overrides.write,{harness:'Codex',model:'m1'});
  const full=Dag.fromFile(JSON.parse(JSON.stringify(Dag.toFile('Full',{...d,mode:'full'}))));
  assert.equal(full.definition.mode,'full');assert.equal(full.definition.roles.write.description,'secret brief');
});

test('reading a workflow file rejects foreign, broken or cyclic content',()=>{
  assert.throws(()=>Dag.fromFile({hello:1}));
  assert.throws(()=>Dag.fromFile({bercy:'workflow',format:99,name:'x',definition:{roles:{},deps:{}}}));
  assert.throws(()=>Dag.fromFile({bercy:'workflow',format:1,name:'x',definition:{roles:{a:{name:'A',artifact:'x'}},deps:{a:['b']}}}));
  const cyclic={roles:{a:{name:'A',artifact:'x'},b:{name:'B',artifact:'y'}},deps:{a:['b'],b:['a']}};
  assert.throws(()=>Dag.fromFile({bercy:'workflow',format:1,name:'x',definition:cyclic}));
  assert.throws(()=>Dag.fromFile({bercy:'workflow',format:1,name:'x',definition:{roles:{constructor:{name:'A',artifact:'x'}},deps:{constructor:[]}}}));
  // Unknown fields are dropped; long text is clipped.
  const r=Dag.fromFile({bercy:'workflow',format:1,name:'x',definition:{roles:{a:{name:'A',artifact:'x',description:'d'.repeat(9000),evil:'<script>'}},deps:{a:[]},overrides:{a:{harness:'Codex',command:'rm -rf /'}}}});
  assert.equal(r.definition.roles.a.evil,undefined);assert.equal(r.definition.overrides.a.command,undefined);
  assert(r.definition.roles.a.description.length<=2400);
});
