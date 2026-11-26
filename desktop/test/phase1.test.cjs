const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {invoke}=require('../runtimes.cjs'),{Files,atomicAsync,atomicNow}=require('../files.cjs'),prompts=require('../prompts.cjs'),Dag=require('../../dist/dag.js');
async function fixture(t,body){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p1-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const bin=path.join(cwd,'fixture');await fs.writeFile(bin,'#!/usr/bin/env node\n'+body,{mode:0o700});
  return {cwd,bin,prompt:'task',model:'',signal:AbortSignal.timeout(5000)};
}
test('缺口回执从正文末尾拆出，“无”不算缺口',()=>{
  assert.deepEqual(prompts.receipt('正文\n\n缺口：未核实价格'),{body:'正文',gaps:'未核实价格'});
  assert.deepEqual(prompts.receipt('正文\n**缺口：** 缺少图'),{body:'正文',gaps:'缺少图'});
  assert.deepEqual(prompts.receipt('正文\n缺口：无'),{body:'正文',gaps:''});
  assert.deepEqual(prompts.receipt('文中提到缺口：这不是末行\n结尾'),{body:'文中提到缺口：这不是末行\n结尾',gaps:''});
  assert.match(prompts.worker({node:{description:'写通知',artifact:'通知'},inputs:[],outDir:'/o'}),/缺口：/);
});
test('节点能力：文件交付需要写文件，规划给出的能力会被过滤并保存',()=>{
  assert.deepEqual(Dag.needs({artifact:'样片.mp4',needs:['shell','root']}),['write','shell']);
  assert.deepEqual(Dag.needs({artifact:'文案'}),[]);
  const d=Dag.definition([{id:'cut',name:'剪辑',artifact:'样片.mp4',deps:[],needs:['shell','x']}]);
  assert.deepEqual(d.roles.cut.needs,['shell']);assert.deepEqual(Dag.stripBriefs(d).roles.cut.needs,['shell']);
  assert.match(prompts.plan('目标',[{name:'Codex',can:['write','shell']}],[]),/"needs"/);
});
test('正文和附件模式允许没有附件，文件模式仍要求产物',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p1-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const files=new Files(base),cwd=await files.attempt();
  assert.deepEqual(await files.output(cwd,'说明',true),[]);await assert.rejects(files.output(cwd,'说明'),/交付目录为空/);
});
test('状态写入按序号生效，旧写入不会覆盖新内容',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p1-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'workspace.json');
  const slow=atomicAsync(file,{v:1},101);atomicNow(file,{v:2},102);await slow;
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{v:2});
  assert.equal(await atomicAsync(file,{v:0},100),false);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{v:2});
  assert.deepEqual((await fs.readdir(dir)).filter(n=>n.endsWith('.tmp')),[]);
});
test('超时会结束 CLI 并给出明确原因',async t=>{
  const args=await fixture(t,`setTimeout(()=>{},60000);process.stdin.resume();`);
  await assert.rejects(invoke({...args,name:'Claude',timeout:300}),/超过 1 秒仍未完成/);
});
test('Codex 仅在节点需要联网时打开沙箱网络',async t=>{
  const args=await fixture(t,`const a=process.argv.slice(2).join(' ');process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:a.includes('network_access=true')?'net':'local'}})))`);
  assert.equal(await invoke({...args,protocol:'codex-exec',name:'Codex'}),'local');assert.equal(await invoke({...args,protocol:'codex-exec',name:'Codex',needs:['network']}),'net');
  assert.equal(await invoke({...args,protocol:'codex-exec',name:'Codex',needs:['network'],planning:true}),'local');
});
test('DeepSeek ACP 只批准运行目录内的读写，其余一律拒绝',async t=>{
  const args=await fixture(t,`const readline=require('node:readline'),path=require('node:path');const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
  const options=[{optionId:'yes',kind:'allow_once',name:'允许'},{optionId:'no',kind:'reject_once',name:'拒绝'}];
  const asks=[{toolCallId:'t1'},{toolCallId:'t2',kind:'edit',locations:[{path:'/etc/hosts'}]},{toolCallId:'t3',kind:'execute',locations:[{path:'out'}]},{toolCallId:'t4',kind:'edit',locations:[{path:'out/../../escape.md'}]}];
  const answers=[];let pending;
  readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);
    if(m.id>=900){answers[m.id-900]=m.result.outcome.optionId||m.result.outcome.outcome;
      if(answers.filter(Boolean).length===asks.length){send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answers.join(',')}}}});send({id:pending,result:{stopReason:'end_turn'}})}return}
    if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:1}});
    if(m.method==='session/new')return send({id:m.id,result:{sessionId:'s'}});
    if(m.method==='session/prompt'){pending=m.id;
      send({method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'edit',locations:[{path:path.join(process.cwd(),'out','a.md')}]}}});
      asks.forEach((toolCall,i)=>send({id:900+i,method:'session/request_permission',params:{sessionId:'s',toolCall,options}}));}
  });`);
  assert.equal(await invoke({...args,name:'DeepSeek Harness'}),'yes,no,no,no');
});
