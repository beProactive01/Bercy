const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {invoke}=require('../runtimes.cjs');
async function fixture(t,body){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'relay-cli-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const bin=path.join(cwd,'fixture');await fs.writeFile(bin,'#!/usr/bin/env node\n'+body,{mode:0o700});
  return {cwd,bin,prompt:'task',model:'example',signal:AbortSignal.timeout(5000)};
}
test('Claude stream-json 消费工具事件并取最终回答',async t=>{
  const args=await fixture(t,`const flags=process.argv.slice(2);if(!flags.includes('stream-json')||!flags.includes('example'))process.exit(2);
  process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:'/r/out/a.md'}}]}}));console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))});`);
  const events=[];assert.equal(await invoke({...args,name:'Claude',event:m=>events.push(m)}),'done');assert.deepEqual(events,['写入文件 · a.md']);
});
test('OpenClaw 接受 Gateway 封装，也能显式报告负回执',async t=>{
  const args=await fixture(t,`const flags=process.argv.slice(2);const message=flags[flags.indexOf('--message')+1];const bad=message==='bad';console.log(JSON.stringify({status:'ok',result:{payloads:[{text:bad?'LLM request failed.':message,isError:bad}]}}));`);
  assert.equal(await invoke({...args,name:'OpenClaw'}),'task');assert.equal(await invoke({...args,name:'OpenClaw',approvalMode:'allow'}),'/exec security=full ask=off task');await assert.rejects(invoke({...args,name:'OpenClaw',prompt:'bad'}),/LLM request failed/);
});
test('DeepSeek ACP 走初始化、会话、模型选择和多段文本回执',async t=>{
  const args=await fixture(t,`const readline=require('node:readline');let model;
  readline.createInterface({input:process.stdin}).on('line',s=>{
    const {id,method,params}=JSON.parse(s);const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));let result={};
    if(method==='initialize')result={protocolVersion:1};else if(method==='session/new')result={sessionId:'s',configOptions:[{id:'model',category:'model'}]};
    else if(method==='session/set_config_option')model=params.value;
    else if(method==='session/prompt'){if(model!=='example')process.exit(2);for(const text of ['do','ne'])send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});result={stopReason:'end_turn'}}
    send({id,result});
  });`);assert.equal(await invoke({...args,name:'DeepSeek Harness'}),'done');
});
test('Codex 以 --image 参数传递图像，Claude 以 image 内容块传递字节',async t=>{
 const args=await fixture(t,`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
 process.stdin.on('end',()=>{const a=process.argv.slice(2);if(a.includes('exec')){if(!a.includes('--image')||!require('node:fs').existsSync(a[a.indexOf('--image')+1]))process.exit(2);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'vision'}}))}
 else{const msg=JSON.parse(input);if(!a.includes('--input-format')||!msg.message.content.some(i=>i.type==='image'&&i.source.data==='UE5H'))process.exit(2);console.log(JSON.stringify({type:'result',subtype:'success',result:'vision'}))}});`);
 const file=path.join(args.cwd,'pic.png');await fs.writeFile(file,'PNG');for(const name of ['Codex','Claude'])assert.equal(await invoke({...args,name,protocol:name==='Codex'?'codex-exec':undefined,images:[{path:file,type:'image/png'}]}),'vision');
});
test('CLI 结束后，它在同一进程组里启动的后台命令也会被清理',{skip:process.platform==='win32'},async t=>{
  const args=await fixture(t,`const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
  const child=spawn('sleep',['30'],{stdio:'ignore'});child.unref();fs.writeFileSync(path.join(process.cwd(),'bg.pid'),String(child.pid));
  process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}));process.exit(0)});`);
  assert.equal(await invoke({...args,name:'Claude'}),'done');
  const pid=Number(await fs.readFile(path.join(args.cwd,'bg.pid'),'utf8'));
  const alive=()=>{try{process.kill(pid,0);return true}catch{return false}};
  for(let i=0;i<20&&alive();i++)await new Promise(r=>setTimeout(r,50));
  if(alive())process.kill(pid,'SIGKILL');
  assert.equal(alive(),false);
});
test('大量流式输出只保留尾部，仍能取到最终回答',async t=>{
  const args=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>{const line=JSON.stringify({type:'stream_event',event:{type:'ping',pad:'x'.repeat(2000)}})+'\\n';
  let out='';for(let i=0;i<6000;i++)out+=line;process.stdout.write(out);console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))});`);
  const began=Date.now();assert.equal(await invoke({...args,name:'Claude'}),'done');assert.ok(Date.now()-began<4000);
});
test('Pi JSON 事件流：提示词走 stdin，工具步骤、流式正文、最后一轮的回答、用量；按需开放 bash，规划不给工具',async t=>{
  const args=await fixture(t,`const a=process.argv.slice(2),out=e=>console.log(JSON.stringify(e));
  if(a[0]!=='-p'||a[1]!=='--mode'||a[2]!=='json'||!a.includes('--no-session')||a[a.indexOf('--model')+1]!=='example')process.exit(2);
  const tools=a.includes('--no-tools')?'none':a[a.indexOf('--tools')+1];let msg='';
  process.stdin.setEncoding('utf8');process.stdin.on('data',d=>msg+=d);process.stdin.on('end',()=>{
    if(a.some(x=>x===msg))process.exit(3);
    if(msg==='bad'){out({type:'agent_end',messages:[{role:'assistant',content:[],stopReason:'error',errorMessage:'401 invalid api key'}]});return}
    if(msg==='retry'){out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'529 overloaded'}});out({type:'auto_retry_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok<|end|>'}],stopReason:'stop'}});return}
    out({type:'session',id:'s1'});out({type:'turn_start'});out({type:'message_start',message:{role:'assistant'}});
    out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'看一下'}});
    out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'看一下'},{type:'toolCall',id:'c1',name:'write'}],usage:{input:10,output:2,cacheRead:3},stopReason:'toolUse'}});
    out({type:'tool_execution_start',toolCallId:'c1',toolName:'write',args:{path:'/r/out/a.md'}});
    out({type:'tool_execution_end',toolCallId:'c1',toolName:'write',isError:false,result:{content:[]}});
    out({type:'turn_start'});
    out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:tools+'|'+msg.length}],usage:{input:5,output:4},stopReason:'stop'}});
    out({type:'agent_settled',aborted:false});
  });`);
  const steps=[],deltas=[],usage=[];
  const r=await invoke({...args,name:'Pi',prompt:'短任务',report:x=>{if(x.step)steps.push(x.step);if(x.delta)deltas.push(x.delta)},usage:u=>usage.push(u)});
  assert.equal(r,'read,write,edit,grep,find,ls|3');
  assert.deepEqual(steps.map(s=>s.status+':'+(s.label||s.id)),['done:说明 · 看一下','running:写入文件 · a.md','done:c1']);
  assert.deepEqual(deltas,['看一下']);assert.deepEqual(usage.at(-1),{input:15,cached:3,output:6});
  assert.equal(await invoke({...args,name:'Pi',prompt:'x',needs:['shell']}),'read,write,edit,grep,find,ls,bash|1');
  assert.equal(await invoke({...args,name:'Pi',prompt:'x',approvalMode:'allow'}),'*|1');
  assert.equal(await invoke({...args,name:'Pi',prompt:'x',needs:['shell'],planning:true}),'none|1');
  assert.equal(await invoke({...args,name:'Pi',prompt:'长'.repeat(20000)}),'read,write,edit,grep,find,ls|20000');
  // a provider error cleared by a retry is not a failure; control tokens are stripped
  assert.equal(await invoke({...args,name:'Pi',prompt:'retry'}),'ok');
  // older pi reports a bad key only in agent_end and exits 0
  await assert.rejects(invoke({...args,name:'Pi',prompt:'bad'}),/尚未登录或登录已失效.*pi（在其中输入 \/login）/);
});

test('全部允许同时解除 Codex CLI 和 Claude 的沙箱与审批',async t=>{
  const args=await fixture(t,`const flags=process.argv.slice(2);
    const value=key=>flags[flags.indexOf(key)+1];
    const result=flags.includes('--sandbox')?[value('--sandbox'),value('-c')]:
      [value('--permission-mode'),JSON.parse(value('--settings')).sandbox.enabled];
    const text=JSON.stringify(result);
    const event=flags.includes('--sandbox')?{type:'item.completed',item:{type:'agent_message',text}}:
      {type:'result',subtype:'success',result:text};
    console.log(JSON.stringify(event));`);
  assert.deepEqual(JSON.parse(await invoke({...args,name:'Codex',protocol:'codex-exec',approvalMode:'allow'})),
    ['danger-full-access','approval_policy="never"']);
  assert.deepEqual(JSON.parse(await invoke({...args,name:'Claude',approvalMode:'allow'})),['bypassPermissions',false]);
  assert.deepEqual(JSON.parse(await invoke({...args,name:'Claude',approvalMode:'auto'})),['acceptEdits',true]);
});
