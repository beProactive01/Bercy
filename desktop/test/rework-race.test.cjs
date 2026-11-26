const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Dag = require('../../dist/dag.js');
const Delivery = require('../../dist/delivery.js');
const {worker} = require('../prompts.cjs');
const {itemStep} = require('../codex-app.cjs');

test('an in-flight sibling cannot publish an obsolete success after its input is returned', async () => {
  const cancelled = [];
  const host = {events() {}, async cancel(key) { cancelled.push(key); }};
  const ctx = {
    window: {relayHost: host}, document: {addEventListener() {}}, Dag, Delivery,
    timers: new Map(), hostLeases: new Map(), uiText: s => s, save() {}, settleApprovals() {},
    structuredClone
  };
  const scripts = ['workflow', 'host-client'].map(f => fs.readFileSync(require.resolve('../../dist/'+f+'.js'), 'utf8'));
  const api = vm.runInNewContext(scripts.join('\n') + '\npump=()=>{};({follow,inflight,runnable})', ctx);
  const roles = Object.fromEntries(['draft','review','copy','unrelated'].map(name => [name,{name,artifact:name,description:name}]));
  const flow = {
    pack:roles, family:'custom', deps:{draft:[],review:['draft'],copy:['draft'],unrelated:[]},
    files:{draft:{body:'old'}, unrelated:{body:'keep'}}, dispatch:{review:{harness:'Codex'},copy:{harness:'Codex'}},
    overrides:{}, events:{}, logs:[], time:0
  };
  const session = {id:'s',flow};
  const copy = Promise.withResolvers();
  api.inflight.set('s/copy',{s:session,id:'copy'});
  api.inflight.set('s/review',{s:session,id:'review'});
  api.follow(session,'copy',copy.promise);
  api.follow(session,'review',Promise.resolve({rework:'replace old'}));
  await new Promise(setImmediate);
  assert.deepEqual(cancelled,['s/copy']);
  assert.equal(flow.restarting.copy,true);
  assert.equal(flow.dispatch.copy.harness,'Codex');
  assert.equal(flow.feedback.draft.note,'replace old');
  flow.files.draft={title:'draft',body:'new'};
  copy.resolve({body:'old',delivery:'text',artifacts:[]});
  await new Promise(setImmediate);
  assert.equal(flow.files.copy,undefined);
  assert.equal(flow.dispatch.copy,undefined);
  assert.equal(flow.errors?.copy,undefined);
  assert.equal(flow.files.unrelated.body,'keep');
  assert.ok(api.runnable(flow).includes('copy'));
});

test('final review can reject after the budget is exhausted and failed nodes are visible', () => {
  const prompt = worker({node:{review:true,canReturn:false,artifact:'批次',description:'审定批次'},
    reviewed:{artifact:'批次',description:'批准的批次'},inputs:[],outDir:'/out'});
  assert.match(prompt,/达到自动修改上限/);
  assert.match(prompt,/仍不通过，以“退回：”/);
  assert.equal(Delivery.finalLabel({errors:{review:'revision limit'},deps:{review:[]},files:{}}),'需要处理');
});

test('source timeline distinguishes opening from searching and preserves HTTP output only on requested tasks', () => {
  const url='https://example.org/spec';
  const native=itemStep({id:'open',type:'webSearch',action:{type:'openPage',url}},true);
  assert.match(native.label,/打开网页/);
  assert.ok(native.label.endsWith(url));
  assert.equal(native.detail,'');
  assert.match(itemStep({type:'webSearch',query:url,action:{type:'search'}},true).label,/联网搜索/);
  assert.equal(itemStep({type:'webSearch',action:{type:'findInPage',url,pattern:'section'}},true).detail,'section');
  const response='relevant source text\nmore\nfooter\nend';
  const command={type:'commandExecution',command:'curl -fsSL '+url,exitCode:0,aggregatedOutput:response};
  assert.equal(itemStep(command,true,true).detail,response);
  assert.equal(itemStep(command,true,false).detail,'footer end');
  assert.doesNotMatch(itemStep({...command,exitCode:1},true,true).detail,/relevant source text/);
});

test('reloading the window discards a completed obsolete job before redispatch', async () => {
  const flow = {pack:{copy:{name:'copy',description:'copy',artifact:'copy'}},family:'custom',
    deps:{copy:[]},overrides:{},dispatch:{copy:{harness:'Codex'}},files:{},restarting:{copy:true},
    events:{},time:0,logs:[]};
  const session = {id:'s',flow};
  const result = Promise.withResolvers();
  const host = {events() {}, async jobs(){return {running:[],finished:{'s/copy':true},approvals:[]};},
    awaitJob(){return result.promise;}};
  const ctx = {window:{relayHost:host},document:{addEventListener(){}},db:{sessions:[session]},
    Dag, Delivery, uiText:s=>s, timers:new Map(),hostLeases:new Map(),save(){},render(){},settleApprovals(){}};
  const scripts=['workflow','host-client'].map(f=>fs.readFileSync(require.resolve('../../dist/'+f+'.js'),'utf8'));
  const api=vm.runInNewContext(scripts.join('\n')+'\npump=()=>{};({reattach,inflight})',ctx);
  await api.reattach();
  assert.ok(api.inflight.has('s/copy'));
  result.resolve({body:'old version',artifacts:[],delivery:'text'});
  // Keep the scheduler idle while examining the state before the next dispatch.
  ctx.timers.clear();
  await new Promise(setImmediate);
  assert.equal(flow.files.copy,undefined);
  assert.equal(flow.errors?.copy,undefined);
  assert.equal(flow.dispatch.copy,undefined);
  assert.equal(flow.restarting.copy,undefined);
});

test('stopping a workflow cancels its jobs and discards late results without discarding deliveries', async () => {
  const cancelled=[];
  const shutdown=Promise.withResolvers();
  const host={events(){},cancelWorkflow(id){cancelled.push(id);return shutdown.promise}};
  const flow={pack:{done:{name:'done'},one:{name:'one'},two:{name:'two'}},family:'custom',
    deps:{done:[],one:['done'],two:['done']},overrides:{},files:{done:{body:'keep'}},
    dispatch:{one:{harness:'Codex'},two:{harness:'Codex'}},events:{},time:0,logs:[]};
  const session={id:'selected',flow};
  const timers=new Map([['selected',Symbol()],['other',Symbol()]]);
  const ctx={window:{relayHost:host},document:{addEventListener(){}},Dag,Delivery,timers,
    hostLeases:new Map(),uiText:s=>s,save(){},saveNow(){},render(){},settleApprovals(){}};
  const scripts=['workflow','host-client'].map(f=>fs.readFileSync(require.resolve('../../dist/'+f+'.js'),'utf8'));
  const api=vm.runInNewContext(scripts.join('\n')+'\npump=()=>{};({inflight,follow,liveStop,workflowStopping,runnable})',ctx);
  const one=Promise.withResolvers(),two=Promise.withResolvers();
  for(const [id,job] of [['one',one],['two',two]]){
    api.inflight.set(session.id+'/'+id,{s:session,id});
    api.follow(session,id,job.promise);
  }
  const stopping=api.liveStop(session);
  assert.deepEqual(cancelled,['selected']);
  assert.ok(!timers.has('selected')&&timers.has('other'));
  assert.equal(api.workflowStopping(session),true);
  one.resolve({body:'late',delivery:'text',artifacts:[]});
  two.reject(Error('cancelled'));
  await new Promise(setImmediate);
  assert.deepEqual(Object.keys(flow.files),['done']);
  assert.deepEqual(Object.keys(flow.errors||{}),[]);
  assert.deepEqual([...api.runnable(flow)],['one','two']);
  assert.equal(api.workflowStopping(session),true);
  shutdown.resolve();
  await stopping;
  assert.equal(api.workflowStopping(session),false);
});

test('terminal continuation waits for verification and keeps prior deliveries', async () => {
  const calls=[];
  let checkOk=true;
  const host={events(){},async check(){
    calls.push('verify');
    return checkOk?{ok:true}:{ok:false,code:1,output:'verification failed'};
  }};
  const def=Dag.definition([
    {id:'cave',name:'Cave',artifact:'Cave',delivery:'project',deps:[]},
    {id:'coast',name:'Coast',artifact:'Coast',delivery:'project',deps:[]},
    {id:'verify',name:'Verification',artifact:'Report',delivery:'project',continueAfter:true,deps:['cave','coast']},
  ],{check:'npm test'});
  const flow=()=>({...structuredClone(def),query:'验收后自动续跑一轮',pack:structuredClone(def.roles),files:{cave:{},coast:{}},
    dispatch:{verify:{harness:'Codex'}},events:{},logs:[],time:0,versions:[{deps:structuredClone(def.deps)}]});
  const ctx={window:{relayHost:host},document:{addEventListener(){}},Dag,Delivery,db:{settings:{live:'off'}},
    timers:new Map(),hostLeases:new Map(),uiText:s=>s,save(){},render(){},settleApprovals(){},structuredClone};
  const scripts=['workflow','host-client'].map(f=>fs.readFileSync(require.resolve('../../dist/'+f+'.js'),'utf8'));
  const api=vm.runInNewContext(scripts.join('\n')+
    '\npump=()=>{};({follow,continueFromDelivery,runnable,stub(planner,startRun){requestPlanner=planner;start=startRun}})',{...ctx,start(){},route:()=>({harness:'Codex',model:'test'})});
  api.stub(async(query,req,kind)=>{
    calls.push(kind);
    assert.equal(req.state.terminal,true);
    if(/仅给建议/.test(query)&&!req.state.manual)return {summary:'Advice only',continuation:null};
    const manual=req.state.manual&&req.state.instruction;
    return {summary:'Replay remains',continuation:{
      ...(req.state.delivered.body.includes('Checkpoint 4 fixed')?{progressEvidence:'Checkpoint 4 fixed and retested'}:{}),
      nodes:[{id:'verify',name:manual?'Implement requested follow-up':'Retest',
        artifact:'Evidence',delivery:'project',description:'Rerun the replay',
        evidence:manual||'remaining: replay',acceptance:'Replay exits with status 0',deps:[],expand:true,continueAfter:true}]
    }};
  },()=>calls.push('resume'));
  const delivery=()=>({delivery:'project',body:'remaining: replay',summary:'remaining',artifacts:[],gaps:''});
  const s={id:'s',flow:flow()};
  // No explicit wording is required when the task's requested outcome implies completion.
  s.flow.query='Implement the feature and deliver a passing replay';
  delete s.flow.pack.verify.continueAfter;
  ctx.db.settings.live='auto';
  api.follow(s,'verify',Promise.resolve(delivery()));
  await new Promise(setImmediate);
  assert.deepEqual(calls,['verify','observe']);
  assert.deepEqual(Object.keys(s.flow.files),['cave','coast','verify']);
  assert.deepEqual([...api.runnable(s.flow)],['verify_2']);
  assert.deepEqual([...s.flow.deps.verify_2],['verify']);
  assert.equal(s.flow.pack.verify_2.continueAfter,undefined);
  assert.equal(s.flow.pack.verify_2.expand,undefined);
  assert.match(s.flow.pack.verify_2.description,/Replay exits with status 0/);

  // A repeated defect cannot dispatch another automatic round, even with a fresh progress quote.
  calls.length=0;
  const restored={id:'restored',flow:JSON.parse(JSON.stringify(s.flow))};
  restored.flow.dispatch.verify_2={harness:'Codex'};
  api.follow(restored,'verify_2',Promise.resolve({...delivery(),body:'Checkpoint 4 fixed and retested. remaining: replay'}));
  await new Promise(setImmediate);
  assert.deepEqual(calls,['verify','observe']);
  assert.equal(Dag.complete(restored.flow),true);
  assert.deepEqual(Object.keys(restored.flow.files),['cave','coast','verify','verify_2']);

  // The user can start again from existing work without the original brief authorizing continuation.
  calls.length=0;
  restored.flow.query='完成验收并仅给建议';
  await api.continueFromDelivery(restored,'verify_2','补上第二条独立的回放测试');
  assert.deepEqual(calls,['observe','resume']);
  assert.equal(restored.flow.continuationHistory.length,2);
  assert.deepEqual([...api.runnable(restored.flow)],['verify_3']);

  checkOk=false;calls.length=0;
  const failed={id:'failed',flow:flow()};
  failed.flow.checkRounds=1;
  api.follow(failed,'verify',Promise.resolve(delivery()));
  await new Promise(setImmediate);
  assert.deepEqual(calls,['verify','observe']);
  assert.equal(failed.flow.files.verify.verificationPending,true);
  assert.equal(Dag.complete(failed.flow),true);

  calls.length=0;checkOk=true;
  const observeOnly={id:'observe-only',flow:flow()};
  observeOnly.flow.query='验收完成后仅给建议';
  api.follow(observeOnly,'verify',Promise.resolve(delivery()));
  await new Promise(setImmediate);
  assert.deepEqual(calls,['verify','observe']);
  assert.equal(Dag.complete(observeOnly.flow),true);
  assert.equal(observeOnly.flow.files.verify.observation.summary,'Advice only');
});

test('observer returns owned repairs to the original node and retains the integration check',async()=>{
  const definition=Dag.definition([
    {id:'cave',name:'洞穴开发',artifact:'净宽',description:'原路线至少 1.2 米',paths:['game/cave.gd'],deps:[]},
    {id:'coast',name:'海岸开发',artifact:'布景',deps:[]},
    {id:'verify',name:'集成验收',artifact:'报告',stage:'verify',deps:['cave','coast']}
  ]);
  const makeFlow=()=>({...structuredClone(definition),pack:structuredClone(definition.roles),query:'完成海岸并通过验收',
    files:{cave:{title:'净宽',body:'窗口走查完成',gaps:'实测仅 1.046 米'},coast:{title:'布景',body:'keep'}},
    dispatch:{},events:{},logs:[],time:0,versions:[{deps:structuredClone(definition.deps)}]});
  const host={events(){}};
  const timers=new Map([['s',Symbol('running')]]);
  const ctx={window:{relayHost:host},document:{addEventListener(){}},Dag,Delivery,timers,db:{settings:{}},hostLeases:new Map(),
    uiText:s=>s,save(){},render(){},settleApprovals(){},route:()=>({harness:'Codex',model:'test'})};
  const scripts=['workflow','host-client'].map(f=>fs.readFileSync(require.resolve('../../dist/'+f+'.js'),'utf8'));
  const api=vm.runInNewContext(scripts.join('\n')+'\npump=()=>{};({observe,follow,stub(fn){requestPlanner=fn}})',ctx);
  const s={id:'s',flow:makeFlow()};
  const verdict=Promise.withResolvers();
  api.stub((_q,{state})=>{
    assert.equal(state.remaining[0].id,'verify');
    assert.equal(state.remaining[0].verification,true);
    assert.equal(state.remaining[0].downstream,true);
    return verdict.promise;
  });
  assert.equal(api.observe(s,'cave'),true);
  assert.equal(s.flow.holding.verify,1);
  const repair={op:'return',id:'cave',evidence:'实测仅 1.046 米',reason:'达到 1.2 米，保留交互碰撞'};
  verdict.resolve({ops:[repair]});
  await new Promise(setImmediate);
  assert.equal(s.flow.holding.verify,undefined);
  assert.deepEqual(Object.keys(s.flow.files),['coast']);
  assert.match(s.flow.feedback.cave.note,/保留交互碰撞/);
  assert.deepEqual(Object.keys(s.flow.deps),['cave','coast','verify']);
  assert.equal(Dag.observerReturn(s.flow,'cave',{gaps:repair.evidence},repair),null);
  s.flow.files.cave={title:'净宽',body:'新版',gaps:repair.evidence};
  assert.equal(Dag.observerReturn(s.flow,'cave',s.flow.files.cave,repair),null);
  const duplicate=Dag.apply(s.flow,[{op:'add',id:'extra',name:'再做集成验收',description:'检查新版洞穴',artifact:'报告',stage:'verify',after:['cave']}]);
  assert.equal(duplicate.rejected[0].why,'existing-verification');
  assert.deepEqual(Object.keys(s.flow.deps),['cave','coast','verify']);

  const final={id:'final',flow:makeFlow()};
  final.flow.dispatch.verify={harness:'Codex'};
  api.stub(async(_q,{state})=>{
    assert.equal(state.terminal,true);
    assert.equal(state.done.find(n=>n.id==='cave').paths[0],'game/cave.gd');
    return {summary:'净宽已达标但碰撞变了',rework:{id:'cave',evidence:'石台碰撞发生移动',reason:'保留原石台碰撞'}};
  });
  api.follow(final,'verify',Promise.resolve({delivery:'project',body:'验收说明',gaps:'石台碰撞发生移动'}));
  await new Promise(setImmediate);
  assert.deepEqual(Object.keys(final.flow.files),['coast']);
  assert.match(final.flow.feedback.cave.note,/保留原石台碰撞/);
  assert.deepEqual(Object.keys(final.flow.deps),['cave','coast','verify']);
  assert.equal(final.flow.dispatch.verify,undefined);
});

test('continuation rejects unauditable, duplicate or oversized proposals',()=>{
  const delivery={body:'The replay still fails at checkpoint 4.'};
  const node={id:'repair',name:'Replay',artifact:'Receipt',description:'Correct the replay',
    evidence:'the replay still fails',acceptance:'Replay passes checkpoint 4',deps:[]};
  assert.equal(Dag.checkedContinuation(delivery,{nodes:[node]}),null); // Evidence must be verbatim.
  node.evidence='The replay still fails';
  assert.ok(Dag.checkedContinuation(delivery,{nodes:[node]}));
  const history=[{progressEvidence:'',nodes:[{...node,name:'Different earlier check',evidence:'A different failed test'}]}];
  assert.equal(Dag.checkedContinuation(delivery,{nodes:[node]},{history}),null);
  const later={body:'A prior defect has been verified as fixed. '+delivery.body};
  const next={nodes:[node],progressEvidence:'A prior defect has been verified as fixed.'};
  assert.ok(Dag.checkedContinuation(later,next,{history}));
  assert.equal(Dag.checkedContinuation(later,next,{history:[{...history[0],progressEvidence:next.progressEvidence}]}),null);
  assert.equal(Dag.checkedContinuation(delivery,{nodes:[{...node,acceptance:''}]}),null);
  assert.equal(Dag.checkedContinuation(delivery,{nodes:[node,{...node,id:'duplicate'}]}),null);
  assert.equal(Dag.checkedContinuation(delivery,{nodes:[{...node,deps:['missing']}]}),null);
  assert.equal(Dag.checkedContinuation({...delivery,verificationPending:true},{nodes:[node]}),null);
  assert.equal(Dag.checkedContinuation(delivery,{nodes:Array(Dag.limits.continuationNodes+1).fill(node)}),null);
  assert.equal(Dag.usedContinuation({pack:{later:{origin:'verify'}},files:{verify:{observation:{continuation:{nodes:[node]}}}}}),true);
});

test('initial brief separates runtime ownership from permission to execute follow-up work',()=>{
  const q='想让 Codex 来做开发过程，Claude 来规划。每次 Codex 执行完，Claude 验收并给出接下来的步骤。';
  const policy=Dag.briefPolicy(q);
  assert.deepEqual(policy,{planner:'Claude',developer:'Codex',reviewer:'Claude',autoContinue:false});
  assert.equal(Dag.briefPolicy(q+'验收后自动续跑一轮。').autoContinue,true);
  assert.equal(Dag.briefPolicy(q+'不要自动继续执行。').autoContinue,false);
  assert.equal(Dag.briefPolicy('编写脚本，自动生成报告并运行校验').autoContinue,false);
  const d=Dag.definition([
    {id:'build',name:'Build',artifact:'Files',delivery:'project',deps:[]},
    {id:'verify',name:'Test',artifact:'Evidence',stage:'verify',delivery:'project',deps:['build']},
  ]);
  Dag.assignBriefRuntimes(d,policy);
  assert.deepEqual(d.overrides,{build:{harness:'Codex'},verify:{harness:'Claude'}});
});

test('manual continuation retains past work beyond the ordinary expansion depth and count',()=>{
  const f={pack:{original:{name:'Original',artifact:'Report'}},files:{original:{body:'Ready'}},deps:{original:[]},
    versions:[],dispatch:{},expansions:Dag.limits.expansions};
  let end='original';
  for(let i=0;i<8;i++){
    const id='part'+i;
    const added=Dag.expand(f,end,{nodes:[{id,name:'Follow-up '+i,artifact:'Report',deps:[]}]},{continuation:true});
    assert.deepEqual(added,[id]);
    assert.deepEqual(f.deps[id],[end]);
    f.files[id]={body:'Verified '+i};
    end=id;
  }
  assert.equal(Dag.complete(f),true);
  assert.equal(Object.keys(f.files).length,9);
  assert.equal(f.files.original.body,'Ready');
});

test('brief-specific planner and reviewer take precedence and never fall back silently',()=>{
  const js=fs.readFileSync(require.resolve('../../dist/host-client.js'),'utf8');
  const ctx={window:{},document:{addEventListener(){}},uiText:s=>s,Dag,
    db:{settings:{planner:'Codex'},connections:{Codex:{model:'dev'},Claude:{model:'plan'}}}};
  const {plannerChoice}=vm.runInNewContext(js+'\n({plannerChoice})',ctx);
  const available=[{name:'Codex'},{name:'Claude'}];
  assert.equal(plannerChoice(available,'规划：Claude','plan').runtime,'Claude');
  assert.equal(plannerChoice(available,'规划：Codex；验收：Claude','observe').runtime,'Claude');
  assert.throws(()=>plannerChoice([{name:'Codex'}],'规划：Claude','plan'),/未连接 · Claude/);
});
