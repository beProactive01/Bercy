const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {invoke}=require('../runtimes.cjs'),{Files}=require('../files.cjs'),prompts=require('../prompts.cjs'),Dag=require('../../dist/dag.js');
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p2-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}
test('规划修整：统一标识、去掉无效依赖和未连接的运行时、合并只做转述的节点',()=>{
  const {nodes,notes}=Dag.tidy([
    {id:'Draft-1',name:'撰稿',artifact:'稿',deps:[]},
    {id:'relay',name:'转述员',description:'把稿子原样转述给编辑',artifact:'稿',deps:['Draft-1','ghost']},
    {id:'edit',name:'编辑',artifact:'定稿',deps:['relay','relay'],preferred:'Nope'}],['Codex']);
  assert.deepEqual(nodes.map(n=>[n.id,n.deps]),[['draft_1',[]],['edit',['draft_1']]]);
  assert.equal(nodes[1].preferred,undefined);assert.ok(notes.includes('合并了只做转述的「转述员」')&&notes.includes('统一了节点标识'));
  assert.doesNotThrow(()=>Dag.definition(nodes));
  const same=Dag.tidy([{id:'a',name:'甲',artifact:'x',deps:[]},{id:'A',name:'乙',artifact:'y',deps:['a']}]).nodes;
  assert.deepEqual(same.map(n=>n.id),['a','a_2']);
});
test('素材超出预算时，最长的上游正文改为文件，只保留开头摘录',async t=>{
  const base=await temp(t),files=new Files(base),cwd=await files.attempt();
  const long='甲'.repeat(40000),short='乙'.repeat(500);
  const groups=await files.budget(cwd,[{title:'长稿',text:long,summary:'',files:[]},{title:'短评',text:short,summary:'',files:[]}]);
  assert.equal(groups[1].text,short);assert.match(groups[0].text,/全文 40000 字/);assert.ok(groups[0].text.length<2000);
  assert.equal(await fs.readFile(groups[0].spilled,'utf8'),long);
  const prompt=prompts.worker({node:{description:'合并',artifact:'定稿'},inputs:groups,outDir:'/o'});assert.ok(prompt.length<4000);
});
test('清理：结束的执行目录被删除，被删工作流的文件解除登记，旧的失败目录被清走',async t=>{
  const base=await temp(t),files=new Files(base);
  const a=await files.attempt();await files.discard(a);await assert.rejects(fs.stat(a));
  const b=await files.attempt();await fs.mkdir(path.join(b,'inputs'));await fs.writeFile(path.join(b,'out','x.md'),'x');const [rec]=await files.output(b,'x.md');
  await files.discard(b,true);await assert.rejects(fs.stat(path.join(b,'inputs')));assert.ok(await fs.stat(rec.path));
  await files.forget([rec.id]);await assert.rejects(fs.stat(b));await assert.rejects(files.get(rec.id),/未登记/);
  const old=await files.attempt(),past=new Date(Date.now()-5*24*3600*1000);await fs.utimes(old,past,past);
  const keep=await files.attempt();assert.equal(await files.sweep(),1);await assert.rejects(fs.stat(old));assert.ok(await fs.stat(keep));
  await files.discard(path.join(os.tmpdir(),'not-a-run'));
});
test('OpenClaw 的长提示词改由文件传递',async t=>{
  const cwd=await temp(t),bin=path.join(cwd,'fixture');
  await fs.writeFile(bin,`#!/usr/bin/env node
const a=process.argv.slice(2),m=a[a.indexOf('--message')+1];console.log(JSON.stringify({status:'ok',result:{payloads:[{text:String(m.length)+'|'+(m.match(/文件 (\\S+) 中/)?.[1]||'')}]}}))`,{mode:0o700});
  const short=await invoke({name:'OpenClaw',bin,cwd,prompt:'短任务'});assert.equal(short,'3|');
  const long='长'.repeat(20000),[len,file]=(await invoke({name:'OpenClaw',bin,cwd,prompt:long})).split('|');
  assert.ok(Number(len)<200);assert.equal(await fs.readFile(file,'utf8'),long);
});
test('重做与审查：修改意见和上一版进入提示词，审查节点才看到退回约定',()=>{
  const p=prompts.worker({node:{description:'写通知',artifact:'通知',feedback:'补上日期',previous:'旧通知'},inputs:[],outDir:'/o'});
  assert.match(p,/修改意见\n补上日期/);assert.match(p,/上一版交付\n旧通知/);assert.doesNotMatch(p,/退回/);
  const r=prompts.worker({node:{description:'验收',artifact:'结论',review:true,canReturn:true},inputs:[{text:'稿',files:[]}],outDir:'/o'});
  assert.match(r,/以“退回：”开头/);assert.doesNotMatch(r,/节点|下游|上游|工作流/);
  // Review output is the approved text alone, so its comments don't leak into later outputs.
  assert.match(r,/正文只放审查后的定稿/);assert.doesNotMatch(prompts.worker({node:{description:'写通知',artifact:'通知'},inputs:[],outDir:'/o'}),/审查后的定稿/);
  assert.doesNotMatch(prompts.worker({node:{description:'验收',artifact:'结论',review:true,canReturn:false},inputs:[],outDir:'/o'}),/退回/);
  const deps={a:[],b:['a'],c:['b'],d:['a'],e:[]};assert.deepEqual(Dag.descendants(deps,'a').sort(),['b','c','d']);
  assert.equal(Dag.definition([{id:'a',name:'甲',artifact:'x',deps:[]},{id:'b',name:'乙',artifact:'y',deps:['a'],review:true}]).roles.b.review,true);
});
test('CLI 以非零码退出时，报出它自己的错误；未登录时给出登录指引',async t=>{
  const cwd=await temp(t),bin=path.join(cwd,'fixture');
  await fs.writeFile(bin,`#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:process.argv.includes('auth')?'Not logged in · Please run /login':'模型额度不足',usage:{}}));process.exit(1)})`,{mode:0o700});
  await assert.rejects(invoke({name:'Claude',bin,cwd,prompt:'x',model:''}),/^Error: 模型额度不足$/);
  await assert.rejects(invoke({name:'Claude',bin,cwd,prompt:'x',model:'auth'}),/尚未登录.*claude/);
});
test('手动编排的默认值：交付形式按任务推断，名称取自任务开头',()=>{
  assert.equal(Dag.delivery({description:'生成一张 PNG 海报'}),'file');
  assert.equal(Dag.delivery({description:'写一段 100 字宣传语'}),'text');
  assert.equal(Dag.delivery({description:'参考上次的 PNG 风格写文案'}),'text');
  assert.equal(Dag.nameFrom('请写宣传语，100 字以内',0),'写宣传语');
  assert.equal(Dag.nameFrom('',2),'节点 3');
  assert.equal(Dag.definition([{id:'a',name:'甲',artifact:'x',deps:[],offline:true}]).roles.a.offline,true);
});
test('执行记录：Codex 和 Claude 的事件转成成对的步骤',()=>{
  const {itemStep}=require('../codex-app.cjs'),{claudeSteps}=require('../runtimes.cjs');
  assert.deepEqual(itemStep({id:'c1',type:'commandExecution',command:"/bin/zsh -lc 'npm test'"},false),{id:'c1',status:'running',label:'运行命令 · npm test',detail:''});
  assert.deepEqual(itemStep({id:'c1',type:'commandExecution',command:'x',exitCode:2,aggregatedOutput:'a\nb\nfailed'},true).status,'failed');
  assert.equal(itemStep({id:'w',type:'webSearch',query:'读书会',results:[{domain:'a.com'},{domain:'a.com'}]},true).detail,'a.com');
  assert.equal(itemStep({id:'m',type:'agentMessage',phase:'final_answer',text:'答案'},true),null);
  const [start]=claudeSteps({type:'assistant',message:{content:[{type:'tool_use',id:'tu1',name:'WebFetch',input:{url:'https://x.dev'}}]}});
  assert.deepEqual(start,{id:'tu1',status:'running',label:'打开网页 · https://x.dev'});
  assert.deepEqual(claudeSteps({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tu1',is_error:true,content:'Permission denied'}]}}),[{id:'tu1',status:'failed',detail:'Permission denied'}]);
  assert.deepEqual(claudeSteps({type:'assistant',message:{content:[{type:'text',text:'最终答案'}]}}),[]);
});
