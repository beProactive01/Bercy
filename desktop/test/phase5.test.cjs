const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const project=require('../project.cjs'),{check}=require('../runtimes.cjs'),prompts=require('../prompts.cjs'),Dag=require('../../dist/dag.js');
async function tmp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p5-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d}

test('越界检测：只报告负责路径和并行节点路径以外的改动，忽略隐藏目录和生成的说明文件',async t=>{
  const root=await tmp(t);
  for(const f of ['src/core/a.js','src/ui/b.js','README.md'])await fs.mkdir(path.dirname(path.join(root,f)),{recursive:true}).then(()=>fs.writeFile(path.join(root,f),'x'));
  const before=await project.snapshot(root);
  await new Promise(r=>setTimeout(r,20));
  await fs.writeFile(path.join(root,'src/core/a.js'),'changed');
  await fs.writeFile(path.join(root,'src/ui/b.js'),'peer change');
  await fs.writeFile(path.join(root,'README.md'),'outside change');
  await fs.mkdir(path.join(root,'.relay'),{recursive:true});await fs.writeFile(path.join(root,'.relay/tmp'),'ignored');
  await fs.writeFile(path.join(root,'AGENTS.md'),'generated');
  await fs.rm(path.join(root,'src/ui/b.js'));await fs.writeFile(path.join(root,'src/ui/c.js'),'peer');
  const changed=project.changes(before,await project.snapshot(root));
  assert.deepEqual(changed,['README.md','src/core/a.js','src/ui/b.js','src/ui/c.js']);
  const own=['src/core/'],peers=[['./src/ui']];
  assert.deepEqual(changed.filter(f=>!project.within(f,own)&&!peers.some(p=>project.within(f,p))),['README.md']);
  assert.equal(project.within('src/corex/a.js',['src/core']),false);
  assert.equal(project.within('index.html',['index.html']),true);
});

test('验收命令：返回退出码和输出末尾，停止时报错',async t=>{
  const root=await tmp(t);
  assert.deepEqual(await check('echo ok',root),{ok:true,code:0,output:'ok\n'});
  const failed=await check('echo boom >&2; exit 3',root);
  assert.equal(failed.ok,false);assert.equal(failed.code,3);assert.match(failed.output,/boom/);
  const leak=await check('echo token sk-abcdef123456',root);assert.match(leak.output,/\[已隐藏\]/);
  const timed=await check('sleep 5',root,undefined,300);assert.equal(timed.ok,false);assert.match(timed.output,/已停止/);
  const controller=new AbortController();setTimeout(()=>controller.abort(),100);
  await assert.rejects(check('sleep 5',root,controller.signal),/已停止/);
});

test('规划约定要求拆分理由和验收命令，展开时能看到项目现有文件',()=>{
  const plan=prompts.plan('做一个小游戏',[{name:'Codex',can:['write','shell']}],[]);
  assert.match(plan,/"split":null/);assert.match(plan,/说不出收益就不要拆/);assert.match(plan,/"check":/);
  const base={query:'q',guide:'',projectGuide:'',node:{id:'a'},output:'拆解',graph:[],workspace:null,budget:{nodes:2,deeper:false}};
  assert.doesNotMatch(prompts.expand(base),/projectFiles/);
  const withFiles=prompts.expand({...base,projectFiles:['src/main.js']});
  assert.match(withFiles,/不要重复做已有的部分/);assert.match(withFiles,/"projectFiles":\["src\/main.js"\]/);
  const brief=prompts.projectBrief({layout:[],conventions:'',run:'',check:'npm test'},['src/'],'/p');
  assert.match(brief,/验收命令（全部完成后会真实执行）\nnpm test/);
});

test('工作区保留单行验收命令，展开时不覆盖已有命令，项目说明写入验收命令',async t=>{
  assert.equal(Dag.cleanWorkspace({check:'npm ci &&\nnpm test'}).check,'npm ci && npm test');
  const d=Dag.definition([{id:'a',name:'实现',artifact:'游戏',delivery:'project',deps:[]}],null);
  assert.equal(d.workspace.check,'');
  const root=await tmp(t);project.memory(root,'目标',{layout:[],check:'npm test'});
  assert.match(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),/## 验收命令\n\n`npm test`/);
});
test('数据目录搬走后，已登记的产物路径跟着更新',async t=>{
  const {Files}=require('../files.cjs');
  const a=await tmp(t),b=await tmp(t),files=new Files(a);
  const cwd=await files.attempt();await fs.writeFile(path.join(cwd,'out','x.md'),'# hi');
  const [r]=await files.output(cwd,'',false);
  await fs.cp(a,b,{recursive:true});
  const moved=new Files(b),got=await moved.get(r.id);
  assert.ok(got.path.startsWith(path.join(await fs.realpath(b),'runs')+path.sep));
  assert.equal(JSON.parse(await fs.readFile(path.join(b,'artifacts.json'),'utf8'))[r.id].root,got.root);
});
test('规划和展开都能看到每个运行时擅长的工作',()=>{
  const runtimes=[{name:'Codex',can:['write','shell'],good:'写代码、跑测试'},{name:'Claude',can:['write'],good:'长文写作'}];
  const plan=prompts.plan('写一份调研报告并做个演示页面',runtimes,[]);
  assert.match(plan,/最擅长它的运行时/);assert.match(plan,/"good":"写代码、跑测试"/);
  const base={query:'q',guide:'',projectGuide:'',node:{id:'a'},output:'拆解',graph:[],workspace:null,budget:{nodes:2,deeper:false}};
  assert.doesNotMatch(prompts.expand(base),/good 最匹配/);
  const e=prompts.expand({...base,runtimes});assert.match(e,/good 最匹配/);assert.match(e,/"good":"长文写作"/);
});
