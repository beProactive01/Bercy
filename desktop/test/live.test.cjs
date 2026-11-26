const test=require('node:test'),assert=require('node:assert/strict'),Dag=require('../../dist/dag.js'),prompts=require('../prompts.cjs');

// root -> a, b (parallel) -> copy (after b) -> merge(a, copy)
function flow(){
  const d=Dag.definition([
    {id:'root',name:'规划',artifact:'计划',deps:[]},
    {id:'a',name:'开发',artifact:'代码',deps:['root']},
    {id:'b',name:'测试',artifact:'测试报告',deps:['root']},
    {id:'copy',name:'文案审查',artifact:'文案意见',deps:['b'],when:'上游改动涉及用户可见文案'},
    {id:'merge',name:'发布',artifact:'发布说明',deps:['a','copy']},
  ]);
  return {query:'q',pack:d.roles,roles:d.roles,deps:d.deps,overrides:{},dispatch:{},files:{root:{body:'ok'}},time:0,versions:[{deps:structuredClone(d.deps),reason:'init'}]};
}

test('规划约定和节点定义保留 when 条件',()=>{
  const f=flow();assert.equal(f.pack.copy.when,'上游改动涉及用户可见文案');assert.equal(f.pack.a.when,undefined);
  assert.match(prompts.plan('q',[],[]),/"when":""/);
});

test('跳过：下游依赖穿透到被跳过节点的上游，记录版本，不能跳过最终交付',()=>{
  const f=flow();
  const r=Dag.apply(f,[{op:'skip',id:'copy',reason:'没有文案改动'},{op:'skip',id:'merge'}]);
  assert.deepEqual(r.applied.map(a=>a.id),['copy']);assert.equal(r.rejected[0].why,'output');
  assert.deepEqual(f.deps.merge,['a','b']);assert.equal(f.files.copy.skipped,true);
  assert.equal(f.versions.length,2);assert.equal(r.version,2);
  assert.equal(Dag.apply(f,[{op:'skip',id:'copy'}]).rejected[0].why,'delivered');
});

test('新增：插在未开始的下游之前，可与正在执行的节点并行',()=>{
  const f=flow();f.dispatch.a={};f.dispatch.b={};
  const r=Dag.apply(f,[{op:'add',id:'compat',name:'兼容审查',description:'检查旧版客户端',artifact:'兼容报告',after:['root'],before:['merge'],reason:'旧版未覆盖'}],{elapsed:()=>5000});
  assert.deepEqual(r.applied.map(a=>a.id),['compat']);assert.deepEqual(r.restart,[]);
  assert.deepEqual(f.deps.compat,['root']);assert.ok(f.deps.merge.includes('compat'));assert.equal(f.pack.compat.live,true);
  // id collision gets a suffix; unknown deps are rejected; a target running too long drops out
  assert.equal(Dag.apply(f,[{op:'add',id:'compat',name:'x',description:'y',artifact:'z',after:['a']}]).applied[0].id,'compat_2');
  assert.equal(Dag.apply(f,[{op:'add',name:'x',description:'y',artifact:'z',after:['nope']}]).rejected[0].why,'deps');
  assert.equal(Dag.apply(f,[{op:'add',name:'x',description:'y',artifact:'z',before:['a']}],{elapsed:()=>120000}).rejected[0].why,'targets');
});

test('修改：未开始直接改，刚开始的重启，执行较久的延后到交付后重跑',()=>{
  const f=flow();f.dispatch.a={};f.dispatch.b={};
  const ages={a:10000,b:300000};
  const r=Dag.apply(f,[
    {op:'modify',id:'copy',set:{description:'只看新增的提示文案'}},
    {op:'modify',id:'a',set:{description:'改用 userId'}},
    {op:'modify',id:'b',set:{description:'补测旧版客户端'},reason:'接口变化'},
  ],{elapsed:k=>ages[k]??null});
  assert.equal(f.pack.copy.description,'只看新增的提示文案');
  assert.deepEqual(r.restart,['a']);assert.deepEqual(r.defer,{b:'接口变化'});assert.equal(f.deferred.b,'接口变化');
  // no-op modify does not create a version
  const v=f.versions.length;Dag.apply(f,[{op:'modify',id:'copy',set:{description:'只看新增的提示文案'}}]);assert.equal(f.versions.length,v);
  // running too long cannot be skipped; young can
  assert.equal(Dag.apply(f,[{op:'skip',id:'b'}],{elapsed:k=>ages[k]??null}).rejected[0].why,'running');
});

test('批量是原子的：形成循环时整批不生效；旧版本上的提议仍按当前图校验',()=>{
  const f=flow(),before=JSON.stringify(f.deps);
  const r=Dag.apply(f,[{op:'skip',id:'copy'},{op:'modify',id:'a',deps:['merge']}]);
  assert.equal(r.applied.length,0);assert.equal(JSON.stringify(f.deps),before);assert.equal(f.versions.length,1);assert.equal(f.files.copy,undefined);
  Dag.apply(f,[{op:'skip',id:'copy'}]);
  const stale=Dag.apply(f,[{op:'modify',id:'copy',set:{description:'x'}},{op:'modify',id:'merge',set:{description:'汇总'}}],{base:1});
  assert.equal(stale.stale,true);assert.deepEqual(stale.applied.map(a=>a.id),['merge']);
});

test('没有未开始的节点时，仍可在运行中的节点之后新增后续工作',()=>{
  const f=flow();f.files.a={body:'x'};f.files.b={body:'x'};f.files.copy={body:'x'};f.dispatch.merge={};
  const r=Dag.apply(f,[{op:'add',id:'smoke',name:'冒烟测试',description:'启动后检查首页',artifact:'冒烟报告',after:['merge']}],{elapsed:()=>200000});
  assert.deepEqual(r.applied.map(a=>a.id),['smoke']);assert.deepEqual(f.deps.smoke,['merge']);assert.deepEqual(Dag.outputs(f.deps),['smoke']);
  assert.equal(Dag.complete(f),false);
});

test('执行中调整不占用缺口补节点的次数',()=>{
  const f=flow();
  Dag.apply(f,[{op:'modify',id:'copy',set:{description:'1'}}]);Dag.apply(f,[{op:'modify',id:'copy',set:{description:'2'}}]);
  f.files.b={body:'x'};
  assert.ok(Dag.patch(f,'b',{reason:'r',name:'补测',description:'d',artifact:'a',before:['copy']}));
});

test('观察者约定：依据刚交付的内容增删改未交付节点，when 条件在这里判断',()=>{
  const p=prompts.observe('q',{delivered:{id:'b',body:'使用 uid 字段',gaps:'旧版未覆盖'},remaining:[{id:'copy',when:'涉及文案',downstream:true}],done:[]});
  assert.match(p,/"ops"/);assert.match(p,/"op":"skip"/);assert.match(p,/"op":"modify"/);assert.match(p,/"op":"add"/);
  assert.match(p,/条件明确不成立就 skip/);assert.match(p,/至少要保留一个最终交付节点/);
  assert.match(p,/使用 uid 字段/);assert.match(p,/旧版未覆盖/);
});

test('交付之后才启动的下游节点，不论跑了多久都可以重来',()=>{
  const f=flow();f.dispatch.a={};f.dispatch.b={};
  const r=Dag.apply(f,[{op:'modify',id:'a',set:{description:'新'}},{op:'modify',id:'b',set:{description:'新'}}],{elapsed:()=>300000,fresh:k=>k==='a'});
  assert.deepEqual(r.restart,['a']);assert.deepEqual(Object.keys(r.defer),['b']);
});

test('执行中调整不进入保存的流程：去掉新增节点，恢复被改写和被跳过影响的节点',()=>{
  const f=flow(),before={deps:structuredClone(f.deps),desc:f.pack.merge.description};
  Dag.apply(f,[{op:'skip',id:'copy'}]);
  Dag.apply(f,[{op:'add',id:'align',name:'对齐',description:'d',artifact:'a',after:['root'],before:['merge']},{op:'modify',id:'merge',set:{description:'改写后的汇总'}}]);
  Dag.apply(f,[{op:'modify',id:'merge',set:{description:'再次改写'}}]);
  assert.ok(f.deps.align);assert.equal(f.pack.merge.description,'再次改写');
  const p=Dag.planned(f);
  assert.deepEqual(p.deps,before.deps);assert.equal(p.pack.merge.description,before.desc);
  assert.equal(p.pack.align,undefined);assert.equal(p.pack.copy.when,'上游改动涉及用户可见文案');
  // a plan with no live change is returned as is
  const g=flow();assert.deepEqual(Dag.planned(g).deps,g.deps);
});

test('你的例子：1 交付后 2、3 并行刚开始，观察者删 2、改 3、在 3 之后加 4',()=>{
  const d=Dag.definition([{id:'n1',name:'一',artifact:'x',deps:[]},{id:'n2',name:'二',artifact:'x',deps:['n1']},{id:'n3',name:'三',artifact:'x',deps:['n1']}]);
  const f={pack:d.roles,roles:d.roles,deps:d.deps,overrides:{},dispatch:{n2:{},n3:{}},files:{n1:{body:'ok'}},time:0,versions:[{deps:structuredClone(d.deps),reason:'init'}]};
  const r=Dag.apply(f,[
    {op:'skip',id:'n2',reason:'多余'},
    {op:'modify',id:'n3',set:{description:'按交付调整输入'}},
    {op:'add',id:'n4',name:'四',description:'后续工作',artifact:'y',after:['n3']},
  ],{elapsed:()=>90000,fresh:()=>true});
  assert.deepEqual(r.applied.map(a=>a.op+':'+a.id),['skip:n2','modify:n3','add:n4']);
  assert.deepEqual(r.restart.sort(),['n2','n3']);assert.equal(f.files.n2.skipped,true);
  assert.deepEqual(f.deps.n4,['n3']);assert.deepEqual(Dag.outputs(f.deps).filter(k=>!f.files[k]?.skipped),['n4']);
  // the last remaining output cannot be skipped
  assert.equal(Dag.apply(f,[{op:'skip',id:'n4'}]).rejected[0].why,'output');
});
