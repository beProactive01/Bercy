const test=require('node:test');
const assert=require('node:assert/strict');
const {CodexApp}=require('../codex-app.cjs');
const runtime=require('../runtimes.cjs');

function codexTurn(timeout){
  const app=new CodexApp('codex');
  app.start=async()=>{};
  const controller=new AbortController();
  let started;
  const ready=new Promise(resolve=>{started=resolve});
  app.request=async(method)=>{
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){started();return {turn:{id:'turn'}}}
    return {};
  };
  const result=app.run({cwd:process.cwd(),prompt:'test',signal:controller.signal,timeout,approve:async()=>'allow'});
  return {app,controller,ready,result};
}

test('不限制的 Codex 节点经过一天和一次审批后仍可手动停止',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const run=codexTurn(0);
  await run.ready;
  await run.app.turns.get('thread').approval('item/commandExecution/requestApproval',{});
  t.mock.timers.tick(24*60*60*1000);
  assert.ok(run.app.turns.has('thread'));
  run.controller.abort();
  assert.ok(run.app.turns.has('thread'));
  run.app.turns.get('thread').notice('turn/completed',{turn:{status:'interrupted'}});
  await assert.rejects(run.result,/本次运行已停止/);
});

test('手动设置的 Codex 节点时限仍然生效',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const run=codexTurn(60000);
  await run.ready;
  t.mock.timers.tick(59999);
  assert.ok(run.app.turns.has('thread'));
  t.mock.timers.tick(1);
  await assert.rejects(run.result,/超过 1 分钟/);
});

test('CLI 节点可以在不限制时限时正常完成或手动取消',async()=>{
  // Use the real shell process and the same CLI timer and termination path.
  assert.equal((await runtime.check('sleep 0.1 && echo done',process.cwd(),undefined,0)).ok,true);
  const controller=new AbortController();
  const pending=runtime.check('sleep 30',process.cwd(),controller.signal,0);
  controller.abort();
  await assert.rejects(pending,/本次运行已停止/);
});

test('hard-stop terminates a scoped Codex server and its detached shell, leaving another server alone', async t=>{
  if(process.platform==='win32'){t.skip('POSIX process groups');return}
  const {spawn}=require('node:child_process');
  const {once}=require('node:events');
  const {setTimeout:delay}=require('node:timers/promises');
  const launch=()=>{
    const server=spawn(process.execPath,['-e',
      "const c=require('node:child_process').spawn('/bin/sh',['-c','sleep 60'],{detached:true,stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)"],
    {detached:true,stdio:['ignore','pipe','ignore']});
    t.after(()=>{try{process.kill(-server.pid,'SIGKILL')}catch{}});
    return server;
  };
  const target=launch(),other=launch();
  const [[stdout],[otherStdout]]=await Promise.all([once(target.stdout,'data'),once(other.stdout,'data')]);
  const shellPid=Number(stdout.toString().trim()),otherShellPid=Number(otherStdout.toString().trim());
  const alive=pid=>{try{process.kill(pid,0);return true}catch(err){if(err.code==='ESRCH')return false;throw err}};
  t.after(()=>{if(alive(shellPid))process.kill(-shellPid,'SIGKILL');if(alive(otherShellPid))process.kill(-otherShellPid,'SIGKILL')});
  const app=new CodexApp('unused');app.proc=target;
  const closed=once(target,'exit');
  await app.stopProcessTree();
  await closed;
  for(let i=0;i<15&&alive(shellPid);i++)await delay(100);
  assert.equal(alive(shellPid),false);
  assert.equal(alive(other.pid),true);
  assert.equal(alive(otherShellPid),true);
});
