const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {invoke,disposeAll,steer,hasThread,explain}=require('../runtimes.cjs'),{Store}=require('../store.cjs');
test.after(disposeAll);
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-p3-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}
// A stand-in for `codex app-server`: one thread per thread/start, a command that needs approval, streamed text, steer support.
const fakeCodex=`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});let n=0,pending=null,turn=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
  if(m.id!=null&&!m.method&&pending){const d=m.result.decision;const p=pending;pending=null;
    send({method:'item/completed',params:{threadId:p.t,item:{id:'cmd',type:'commandExecution',command:"/bin/zsh -lc 'echo hi'",exitCode:d==='decline'?1:0,aggregatedOutput:d}}});
    send({method:'item/agentMessage/delta',params:{threadId:p.t,delta:'答'}});
    send({method:'item/completed',params:{threadId:p.t,item:{id:'m',type:'agentMessage',phase:'final_answer',text:'决定:'+d+' 输入:'+p.text}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:p.t,tokenUsage:{last:{inputTokens:5,cachedInputTokens:1,outputTokens:2,reasoningOutputTokens:1}}}});
    return send({method:'turn/completed',params:{threadId:p.t,turn:{id:'turn'+turn,status:'completed'}}})}
  if(m.method==='initialize')return send({id:m.id,result:{userAgent:'codex/0.166.0'}});
  if(m.method==='thread/start'){
    if(m.params.sandbox==='danger-full-access'&&m.params.approvalPolicy!=='never')return send({id:m.id,error:{message:'Unexpected approval mode'}});
    return send({id:m.id,result:{thread:{id:(m.params.sandbox==='danger-full-access'?'full':'th')+(++n)}}});
  }
  if(m.method==='turn/steer')return send({id:m.id,result:{turnId:m.params.expectedTurnId}});
  if(m.method==='turn/start'){turn++;const t=m.params.threadId,text=m.params.input[0].text;send({id:m.id,result:{turn:{id:'turn'+turn}}});
    send({method:'turn/started',params:{threadId:t,turn:{id:'turn'+turn}}});
    send({method:'item/started',params:{threadId:t,item:{id:'cmd',type:'commandExecution',command:"/bin/zsh -lc 'echo hi'"}}});
    pending={t,text};send({id:900+turn,method:'item/commandExecution/requestApproval',params:{threadId:t,turnId:'turn'+turn,itemId:'cmd',command:"/bin/zsh -lc 'echo hi'",cwd:m.params.cwd}});}
});`;
test('Codex app-server：步骤成对、流式正文、审批往返、同一线程继续对话',async t=>{
  const dir=await temp(t),bin=path.join(dir,'codex');await fs.writeFile(bin,fakeCodex,{mode:0o700});
  const steps=[],deltas=[],asked=[],usage=[];
  const run=(prompt,extra={})=>invoke({name:'Codex',bin,cwd:dir,prompt,report:x=>{if(x.step)steps.push(x.step);if(x.delta)deltas.push(x.delta)},usage:u=>usage.push(u),approve:async r=>{asked.push(r);return extra.answer||'allow'},timeout:10000,...extra});
  const first=await run('写一句话');
  assert.equal(first.text,'决定:accept 输入:写一句话');assert.equal(first.threadId,'th1');
  assert.deepEqual(steps.map(s=>[s.id,s.status]),[['cmd','running'],['cmd','done']]);
  assert.equal(asked[0].kind,'command');assert.equal(asked[0].command,'echo hi');assert.deepEqual(deltas,['答']);assert.equal(usage[0].reasoning,1);
  assert.ok(hasThread(bin,'th1'));
  const again=await run('改得更短',{threadId:'th1',answer:'deny'});
  assert.equal(again.threadId,'th1');assert.equal(again.resumed,true);assert.equal(again.text,'决定:decline 输入:改得更短');
  const fresh=await run('新任务',{answer:'allow-run'});assert.equal(fresh.threadId,'th2');assert.match(fresh.text,/acceptForSession/);
  const full=await run('新节点全部允许',{threadId:'th1',approvalMode:'allow'});
  assert.equal(full.threadId,'full3');
  assert.equal(full.resumed,false);
  assert.equal(hasThread(bin,full.threadId,'auto'),false);
  assert.equal(hasThread(bin,full.threadId,'allow'),true);
  const restored=await run('恢复沙箱',{threadId:full.threadId});
  assert.equal(restored.threadId,'th4');
  assert.equal(restored.resumed,false);
  await assert.rejects(steer(bin,'th9','x'),/没有可追加/);
});
test('ACP 审批：自动模式在目录外询问，「本节点都允许」之后不再询问，全部允许不弹出',async t=>{
  const dir=await temp(t),bin=path.join(dir,'acp');
  await fs.writeFile(bin,`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));const answers=[];let pending;
const options=[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}];
const asks=[{toolCallId:'a',kind:'execute',title:'npm test',locations:[]},{toolCallId:'b',kind:'execute',title:'ls',locations:[]},{toolCallId:'c',kind:'edit',locations:[{path:'/etc/hosts'}]}];
rl.on('line',s=>{const m=JSON.parse(s);
  if(m.id>=900){answers[m.id-900]=m.result.outcome.optionId;if(answers.filter(Boolean).length===asks.length){send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answers.join(',')}}}});send({id:pending,result:{stopReason:'end_turn'}})}return}
  if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:1}});
  if(m.method==='session/new')return send({id:m.id,result:{sessionId:'s'}});
  if(m.method==='session/prompt'){pending=m.id;asks.forEach((toolCall,i)=>send({id:900+i,method:'session/request_permission',params:{sessionId:'s',toolCall,options}}))}
});`,{mode:0o700});
  const asked=[];
  const out=await invoke({name:'Custom',bin,protocol:'acp',args:[],cwd:dir,prompt:'x',approvalMode:'auto',approve:async r=>{asked.push(r.kind);return 'allow-run'}});
  assert.equal(out,'yes,yes,yes');assert.equal(asked.length,1);
  assert.equal(await invoke({name:'Custom',bin,protocol:'acp',args:[],cwd:dir,prompt:'x',approvalMode:'allow',approve:async()=>{throw Error('不应询问')}}),'yes,yes,yes');
  assert.equal(await invoke({name:'Custom',bin,protocol:'acp',args:[],cwd:dir,prompt:'x',approvalMode:'ask',approve:async()=>'deny'}),'no,no,no');
});
test('额度用尽和未登录被识别成可操作的提示',()=>{
  assert.match(explain({name:'Claude',login:'claude'},"You've hit your limit · resets 3pm"),/^额度已用完/);
  assert.match(explain({name:'Codex',login:'codex login'},'401 Unauthorized'),/codex login/);
});
test('SQLite 存储：按工作流增量写入、保持顺序、导入旧工作区、损坏时另存',async t=>{
  const dir=await temp(t),file=path.join(dir,'relay.db');
  let {store}=Store.open(file);assert.equal(store.load(),null);
  store.importWorkspace({selected:'b',settings:{timeout:5},sessions:[{id:'b',flow:{q:1}},{id:'a',flow:{q:2}}]});
  assert.deepEqual(store.load().sessions.map(s=>s.id),['b','a']);
  store.apply({upsert:[{id:'a',json:JSON.stringify({id:'a',flow:{q:3}})}]});
  assert.equal(store.load().sessions[1].flow.q,3);assert.equal(store.load().settings.timeout,5);
  store.apply({remove:['b'],meta:JSON.stringify({selected:'a',sessionOrder:['a']})});
  assert.deepEqual(store.load().sessions.map(s=>s.id),['a']);
  assert.throws(()=>store.apply({upsert:[{id:'x',json:'{bad'}]}));assert.deepEqual(store.load().sessions.map(s=>s.id),['a']);
  store.log('a','n1','step',{label:'运行命令'});assert.equal(store.events('a')[0].json.label,'运行命令');
  store.close();await fs.writeFile(file,'not a database');for(const x of ['-wal','-shm'])await fs.rm(file+x,{force:true});
  const reopened=Store.open(file);assert.ok(reopened.problem.backup);assert.equal(reopened.store.load(),null);reopened.store.close();
});
