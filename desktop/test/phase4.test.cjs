const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const prompts=require('../prompts.cjs'),Dag=require('../../dist/dag.js'),project=require('../project.cjs');
const guide=require('node:fs').readFileSync(path.join(__dirname,'../planning-guide.md'),'utf8');
test('规划合约：项目目录、负责路径、可展开节点；指南随提示词发出',()=>{
  const p=prompts.plan('做一个游戏',[{name:'Codex',can:['write','shell']}],[],guide,'只用 Godot');
  for(const k of ['"workspace"','project','"paths"','"expand"','# 规划指南','要文档，还是要成品','# 本项目的规划说明','只用 Godot'])assert.ok(p.includes(k),k);
});
test('定义：清理越界路径和工作区；并行节点的路径重叠时改为先后执行',()=>{
  const d=Dag.definition([
    {id:'scope',name:'范围界定',artifact:'范围',delivery:'project',paths:['docs/','../etc','/abs','C:\\\\x'],deps:[]},
    {id:'core',name:'骨架',artifact:'骨架',delivery:'project',paths:['src/'],deps:['scope']},
    {id:'ui',name:'界面',artifact:'界面',delivery:'project',paths:['src/ui/'],deps:['scope']},
    {id:'art',name:'资源',artifact:'资源',delivery:'project',paths:['assets/'],deps:['scope']}],{layout:[{path:'../x',purpose:'坏'},{path:'src/',purpose:'代码'}],conventions:'Godot 4'});
  assert.deepEqual(d.roles.scope.paths,['docs/']);assert.deepEqual(d.workspace.layout,[{path:'src/',purpose:'代码'}]);
  assert.deepEqual(d.deps.ui,['scope','core']);assert.deepEqual(d.deps.art,['scope']);assert.equal(d.notes.length,1);
});
test('展开：新节点接在可展开节点后，原下游等待全部新节点；深度、数量和路径冲突受限',()=>{
  const d=Dag.definition([{id:'lead',name:'制作总监',artifact:'模块划分',expand:true,deps:[]},{id:'qa',name:'集成',artifact:'可运行项目',delivery:'project',deps:['lead']}]);
  const f={...d,pack:d.roles,files:{lead:{}},dispatch:{},versions:[{deps:structuredClone(d.deps)}]};
  const many=Array.from({length:12},(_,i)=>({id:'m'+i,name:'模块'+i,artifact:'模块'+i,delivery:'project',paths:['src/m'+i+'/'],expand:true}));
  const added=Dag.expand(f,'lead',{reason:'按模块实现',nodes:[...many,{id:'dup',name:'重叠',artifact:'x',delivery:'project',paths:['src/m0/sub/']}]});
  assert.equal(added.length,Dag.limits.perExpansion);
  for(const k of added){assert.deepEqual(f.deps[k],['lead']);assert.equal(f.pack[k].depth,1);assert.equal(f.pack[k].origin,'lead')}
  assert.deepEqual(f.deps.qa,['lead',...added]);assert.equal(f.versions.length,2);assert.equal(f.expansions,1);
  assert.equal(f.pack[added[0]].expand,true);
  f.files[added[0]]={};
  const second=Dag.expand(f,added[0],{nodes:[{id:'deep',name:'更深',artifact:'y',expand:true,deps:[]}]});
  assert.equal(f.pack[second[0]].depth,2);assert.equal(f.pack[second[0]].expand,undefined);
  f.files[second[0]]={};assert.equal(Dag.expand(f,second[0],{nodes:[{id:'z',name:'太深',artifact:'z'}]}),false);
  const f2={...Dag.definition([{id:'a',name:'甲',artifact:'x',expand:true,deps:[]},{id:'b',name:'乙',artifact:'y',delivery:'project',paths:['src/'],deps:[]}]),files:{a:{}},dispatch:{},versions:[{deps:{}}]};f2.pack=f2.roles;
  const ids=Dag.expand(f2,'a',{nodes:[{id:'c',name:'丙',artifact:'z',delivery:'project',paths:['src/c/']}]});
  assert.deepEqual(f2.deps[ids[0]],['a','b']);
});
test('展开提示词说明预算；项目节点的提示词只给项目结构、约定和负责路径',()=>{
  const e=prompts.expand({query:'做游戏',guide,node:{name:'制作总监'},output:'模块：水位、UI',graph:[],workspace:null,budget:{nodes:3,deeper:false}});
  assert.match(e,/最多新增 3 个节点/);assert.match(e,/不得再标记 expand/);assert.match(e,/\{"expand":null\}/);
  const w=prompts.worker({node:{description:'实现水位系统',artifact:'水位系统',delivery:'project',paths:['src/water/']},inputs:[],outDir:'/o',workspace:{layout:[{path:'src/water/',purpose:'水位'}],conventions:'Godot 4，GDScript',run:'godot --headless --script tests/run.gd'},projectRoot:'/p/game'});
  for(const k of ['项目目录\n/p/game','src/water/ —— 水位','Godot 4','godot --headless','你负责的路径\n- src/water/','只修改这些路径'])assert.ok(w.includes(k),k);
  assert.doesNotMatch(w,/节点|下游|上游|工作流|保存到 \/o/);
});
test('项目目录：每个工作流一个，AGENTS.md 由规划生成并保留手写内容，CLAUDE.md 引用它',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p4-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=project.root(dir,'0123abcd-ffff','做一个游戏/原型');assert.equal(project.root(dir,'0123abcd-eeee','别的名字'),root);assert.match(path.basename(root),/^做一个游戏-原型-0123abcd$/);
  project.memory(root,'做一个游戏',{layout:[{path:'src/',purpose:'代码'}],conventions:'Godot 4',run:'godot .'});
  await fs.appendFile(path.join(root,'AGENTS.md'),'\n\n## 手写的决定\n- 用 60 帧\n');
  project.memory(root,'做一个游戏',{layout:[{path:'src/',purpose:'代码'},{path:'assets/',purpose:'资源'}],conventions:'Godot 4.3',run:'godot .'});
  const text=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
  assert.match(text,/`assets\/` —— 资源/);assert.match(text,/Godot 4\.3/);assert.match(text,/手写的决定/);assert.equal(text.match(/relay-room:start/g).length,1);
  assert.equal(await fs.readFile(path.join(root,'CLAUDE.md'),'utf8'),'@AGENTS.md\n');
});
