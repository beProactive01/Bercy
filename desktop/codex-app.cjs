const {text:uiText}=require('../dist/i18n.js');
// Long-lived `codex app-server` connection: one process serves every Codex node, so threads stay loaded
// for follow-up turns (redo with feedback, review send-back) and runs can stream, be steered, interrupted and approved.
const {spawn,execFile}=require('node:child_process'),{createInterface}=require('node:readline');
const {promisify}=require('node:util');
const exec=promisify(execFile);

const clip=(text,n=160)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s};
const base=p=>String(p||'').split(/[\\/]/).pop();
function shellText(cmd){
  const s=Array.isArray(cmd)?cmd.join(' '):String(cmd||'');
  const m=/^\/bin\/(?:ba|z)?sh -l?c ['"]([\s\S]*)['"]$/.exec(s);return clip(m?m[1]:s,180);
}
// One timeline row per thread item; started rows are updated in place when the item completes.
function itemStep(item,done,captureSources=false){
  const id=item.id,status=done?(item.status==='failed'||item.status==='declined'||(item.exitCode!=null&&item.exitCode!==0)?'failed':'done'):'running';
  switch(item.type){
    case 'commandExecution':{
      const output=String(item.aggregatedOutput||'').trim();
      const command=Array.isArray(item.command)?item.command.join(' '):String(item.command||'');
      const source=captureSources&&done&&item.exitCode===0&&/\b(?:curl|wget|urlopen|fetch)\b/i.test(command)&&/https?:\/\//i.test(command);
      // A source extract often precedes the last lines of a command. Keep a bounded excerpt for explicit network tasks.
      const out=source?(output.length<=4096?output:output.slice(0,2048)+'\n…\n'+output.slice(-2048)):clip(output.split('\n').slice(-2).join(' '),140);
      return {id,status,label:uiText('运行命令 · ')+shellText(item.command),detail:done?(item.exitCode===0?out:uiText('退出码 ')+item.exitCode+(out?' · '+out:'')):''};
    }
    case 'fileChange':return {id,status,label:uiText('修改文件 · ')+(item.changes||[]).map(c=>base(c.path)+(c.kind?.type==='add'||c.kind==='add'?uiText('（新建）'):c.kind?.type==='delete'||c.kind==='delete'?uiText('（删除）'):'')).join('、')};
    case 'webSearch':{
      const action=item.action;
      if(action?.url&&['openPage','findInPage','open_page','find_in_page'].includes(action.type)){
        const find=action.type==='findInPage'||action.type==='find_in_page';
        const excerpt=(item.results||[]).find(r=>typeof r?.snippet==='string'&&r.snippet.trim());
        return {id,status,label:uiText(find?'页内查找 · ':'打开网页 · ')+clip(action.url,200),detail:clip(excerpt?.snippet||(find?action.pattern:''),300)};
      }
      const q=item.query||item.action?.query,sites=[...new Set((item.results||[]).map(r=>r.domain).filter(Boolean))].slice(0,3);
      return done&&q?{id,status,label:uiText('联网搜索 · ')+clip(q,100),detail:sites.join('、')}:{id,status,label:uiText('联网搜索')};
    }
    case 'mcpToolCall':return {id,status,label:uiText('调用工具 · ')+[item.server,item.tool].filter(Boolean).join('.'),detail:item.error?.message?clip(item.error.message):''};
    case 'dynamicToolCall':return {id,status,label:uiText('调用工具 · ')+(item.tool||'')};
    case 'reasoning':{const t=[].concat(item.summary||[]).map(x=>x.text||x).join(' ');return done&&t?{id,status:'done',label:uiText('思考 · ')+clip(t,140)}:null}
    case 'plan':return done&&item.text?{id,status:'done',label:uiText('计划 · ')+clip(item.text,160)}:null;
    case 'agentMessage':return done&&item.phase!=='final_answer'&&item.text?{id,status:'done',label:uiText('说明 · ')+clip(item.text,180)}:null;
    case 'imageView':return {id,status,label:uiText('查看图片 · ')+base(item.path)};
    case 'imageGeneration':return {id,status,label:uiText('生成图片')+(item.savedPath?' · '+base(item.savedPath):'')};
    case 'collabAgentToolCall':{
      const verb={spawnAgent:'启动子任务',sendInput:'给子任务发消息',sendMessage:'给子任务发消息',followupTask:'追加子任务',resumeAgent:'恢复子任务',wait:'等待子任务',closeAgent:'结束子任务',interruptAgent:'中断子任务',listAgents:'查看子任务'}[item.tool]||'子任务';
      return {id,status,label:uiText(verb)+(item.prompt?' · '+clip(item.prompt,120):'')};
    }
    case 'subAgentActivity':{
      const what={started:'子任务开始',interacted:'子任务收到消息',interrupted:'子任务被中断',completed:'子任务完成'}[item.kind]||'子任务';
      return {id,status:item.kind==='interrupted'?'failed':'done',label:uiText(what)+(item.agentPath?' · '+base(item.agentPath):'')};
    }
    default:return null;
  }
}
// Turn errors become actionable messages; usage limits and sign-in problems are named as such.
function turnError(err){
  const info=typeof err?.codexErrorInfo==='string'?err.codexErrorInfo:Object.keys(err?.codexErrorInfo||{})[0]||'';
  const msg=clip(err?.message||uiText('Codex 执行失败'),400);
  if(info==='usageLimitExceeded'||info==='rateLimitExceeded')return uiText('额度已用完 · ')+msg;
  if(info==='unauthorized')return uiText('Codex 尚未登录或登录已失效，请在终端运行 codex login 后重试。');
  if(info==='modelNotFound')return uiText('模型不可用 · ')+msg;
  return msg;
}

function sandboxMode(planning,approvalMode){
  if(planning)return 'read-only';
  return approvalMode==='allow'?'danger-full-access':'workspace-write';
}

class CodexApp{
  constructor(bin,env,isolated=false){this.bin=bin;this.env=env;this.isolated=isolated;this.proc=null;this.ready=null;this.serial=0;this.waiting=new Map();this.turns=new Map();this.threads=new Map()}
  start(){
    if(this.ready)return this.ready;
    const p=spawn(this.bin,['app-server'],{env:this.env,stdio:['pipe','pipe','pipe'],detached:this.isolated&&process.platform!=='win32',windowsHide:true});
    this.proc=p;let stderr='';
    p.stderr.on('data',s=>{stderr=(stderr+s).slice(-1500)});p.stdin.on('error',()=>{});
    const dead=err=>{
      if(this.proc!==p)return;this.proc=null;this.ready=null;this.threads.clear();
      const e=Error(err?.message||clip(stderr,300)||uiText('Codex app-server 已退出'));
      for(const w of this.waiting.values())w.reject(e);this.waiting.clear();
      for(const t of this.turns.values())t.fail(e);this.turns.clear();
    };
    p.once('error',dead);p.once('exit',()=>dead());
    createInterface({input:p.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}this.receive(m)});
    this.ready=this.request('initialize',{clientInfo:{name:'bercy',version:'0.2.0'},capabilities:{experimentalApi:true}})
      .then(hello=>{this.notify('initialized');return hello});
    this.ready.catch(()=>{});
    return this.ready;
  }
  send(m){this.proc?.stdin.write(JSON.stringify(m)+'\n')}
  notify(method,params){this.send(params?{method,params}:{method})}
  request(method,params,timeout=60000){
    if(!this.proc)return Promise.reject(Error(uiText('Codex app-server 未启动')));
    return new Promise((resolve,reject)=>{
      const id=++this.serial,timer=setTimeout(()=>{this.waiting.delete(id);reject(Error(uiText('Codex 没有响应 ')+method))},timeout);
      this.waiting.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});
      this.send({id,method,params});
    });
  }
  async call(method,params,timeout){await this.start();return this.request(method,params,timeout)}
  receive(m){
    if(m.id!=null&&!m.method){const w=this.waiting.get(m.id);if(!w)return;this.waiting.delete(m.id);m.error?w.reject(Error(m.error.message||uiText('Codex 请求失败'))):w.resolve(m.result);return}
    const p=m.params||{};
    if(m.id!=null&&m.method){
      const t=this.turns.get(p.threadId);
      if(t&&/requestApproval$/.test(m.method))t.approval(m.method,p).then(decision=>this.send({id:m.id,result:{decision}}),()=>this.send({id:m.id,result:{decision:'decline'}}));
      else this.send({id:m.id,error:{code:-32601,message:'Unsupported client method'}});
      return;
    }
    const t=this.turns.get(p.threadId);if(t)t.notice(m.method,p);
  }
  async models(){
    const r=await this.call('model/list',{limit:100,includeHidden:false},15000);
    return (r.data||[]).map(x=>x.id||x.model).filter(Boolean);
  }
  async account(){return this.call('account/read',{refreshToken:false},15000)}
  async steer(threadId,text){
    const t=this.turns.get(threadId);if(!t?.turnId)throw Error(uiText('当前没有可追加要求的执行'));
    await this.request('turn/steer',{threadId,expectedTurnId:t.turnId,input:[{type:'text',text}]});
  }
  async run({cwd,extraDirectory,prompt,images=[],model,planning,network,captureSources=false,approvalMode='auto',threadId,persistThread=false,signal,timeout,step=()=>{},delta=()=>{},usage=()=>{},approve,onThread}){
    await this.start();
    if(signal?.aborted)throw Error(uiText('本次运行已停止'));
    const policy=planning?'never':approvalMode==='ask'?'untrusted':approvalMode==='allow'?'never':'on-request';
    const sandbox=sandboxMode(planning,approvalMode);
    const config={...(sandbox==='workspace-write'&&extraDirectory?{'sandbox_workspace_write.writable_roots':[extraDirectory]}:{}),...(sandbox==='workspace-write'&&network?{'sandbox_workspace_write.network_access':true}:{}),...(planning?{model_reasoning_effort:'medium'}:{})};
    const settings={cwd,...(model?{model}:{}),approvalPolicy:policy,sandbox,config};
    const loaded=threadId&&this.threads.has(threadId);
    let id=loaded&&this.threads.get(threadId)===sandbox?threadId:null;
    if(!id&&threadId&&!loaded&&persistThread&&!planning){
      try{
        const r=await this.request('thread/resume',{...settings,threadId,excludeTurns:true});
        if(r.thread.id!==threadId)throw Error(uiText('Codex 返回了不同的会话'));
        id=threadId;this.threads.set(id,sandbox);
      }catch(err){
        if(!/no rollout|thread (?:not found|does not exist)|unknown thread|cannot resume.*ephemeral|ephemeral.*cannot be resumed/i.test(err.message))throw err;
      }
    }
    const resumed=!!id;
    if(!id){
      if(signal?.aborted)throw Error(uiText('本次运行已停止'));
      const r=await this.request('thread/start',{...settings,ephemeral:planning||!persistThread});
      id=r.thread.id;this.threads.set(id,sandbox);
    }
    if(signal?.aborted)throw Error(uiText('本次运行已停止'));
    onThread?.(id,resumed);
    return new Promise((resolve,reject)=>{
      let finalText='',draft='',settled=false,paused=false,remaining=timeout,since=Date.now(),timer;
      const arm=()=>{if(!timeout||settled||signal?.aborted)return;since=Date.now();timer=setTimeout(()=>{if(turn.turnId)this.request('turn/interrupt',{threadId:id,turnId:turn.turnId}).catch(()=>{});finish(Error(uiText('超过 ')+Math.round(timeout/60000)+uiText(' 分钟仍未完成，已停止')))},remaining)};
      const pause=()=>{if(!timeout||paused)return;paused=true;clearTimeout(timer);remaining-=Date.now()-since};
      const resume=()=>{if(!paused)return;paused=false;arm()};
      const finish=(err,text)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);this.turns.delete(id);err?reject(err):resolve({text,threadId:id,resumed})};
      let interruptRequested=false;
      const stop=()=>{
        clearTimeout(timer);
        if(!turn.turnId||interruptRequested)return;
        interruptRequested=true;
        this.request('turn/interrupt',{threadId:id,turnId:turn.turnId}).catch(err=>finish(err));
      };
      const turn={turnId:null,fail:e=>finish(e),
        // Waiting for the user does not count toward the node's time limit.
        approval:async(method,p)=>{
          pause();
          try{
            const kind=method.includes('fileChange')?'file':'command';
            const answer=await approve({kind,command:p.command?shellText(p.command):'',cwd:p.cwd||'',reason:p.reason||'',files:(p.changes||[]).map(c=>base(c.path)),grantRoot:p.grantRoot||''});
            return answer==='allow'?'accept':answer==='allow-run'?'acceptForSession':'decline';
          }finally{resume()}
        },
        notice:(method,p)=>{
          if(method==='turn/started'){
            turn.turnId=p.turn?.id||turn.turnId;if(signal?.aborted)stop();
          }
          else if(method==='item/agentMessage/delta'){draft+=p.delta||'';delta(draft)}
          else if(method==='item/started'||method==='item/completed'){
            const it=p.item||{};
            if(it.type==='agentMessage'&&method==='item/started')draft='';
            if(it.type==='agentMessage'&&method==='item/completed'&&it.text){if(it.phase==='final_answer'||!it.phase)finalText=it.text;else if(!finalText)finalText=it.text}
            const s=itemStep(it,method==='item/completed',captureSources);if(s)step(s);
          }else if(method==='thread/tokenUsage/updated'){
            const u=p.tokenUsage?.last||p.tokenUsage?.total;
            if(u)usage({input:u.inputTokens,cached:u.cachedInputTokens,output:u.outputTokens,reasoning:u.reasoningOutputTokens});
          }else if(method==='turn/completed'){
            const t=p.turn||{};
            if(signal?.aborted)finish(Error(uiText('本次运行已停止')));
            else if(t.status==='completed')finish(finalText?null:Error(uiText('Codex 结束，但没有返回交付结果')),finalText);
            else if(t.status==='interrupted')finish(Error(uiText('执行被中断')));
            else finish(Error(turnError(t.error)));
          }else if(method==='error'&&p.error&&!p.willRetry)step({id:'err-'+Date.now(),status:'failed',label:uiText('错误 · ')+clip(p.error.message)});
        }};
      this.turns.set(id,turn);arm();
      signal?.addEventListener('abort',stop,{once:true});
      if(signal?.aborted)stop();
      const input=[{type:'text',text:prompt},...images.map(f=>({type:'localImage',path:f.path}))];
      // Each attempt has a fresh output directory even when it reuses the conversation.
      const sandboxPolicy=resumed&&sandbox==='workspace-write'?{type:'workspaceWrite',writableRoots:extraDirectory?[extraDirectory]:[],networkAccess:!!network}:undefined;
      this.request('turn/start',{threadId:id,cwd,input,...(model?{model}:{}),approvalPolicy:policy,...(sandboxPolicy?{sandboxPolicy}:{})})
        .then(r=>{turn.turnId=r.turn?.id||turn.turnId;if(signal?.aborted)stop()},err=>finish(err));
    });
  }
  async stopProcessTree(){
    const proc=this.proc;
    if(!proc?.pid)return;
    if(process.platform==='win32'){
      try{await exec('taskkill',['/PID',String(proc.pid),'/T','/F'])}
      catch(err){if(proc.exitCode===null&&proc.signalCode===null)throw err}
      return;
    }
    const {stdout}=await exec('ps',['-axo','pid=,ppid=,pgid='],{timeout:3000});
    const processes=stdout.trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));
    const owned=new Set([proc.pid]);
    // A scoped app-server and the command groups it creates belong to one workflow.
    for(let found=true;found;){
      found=false;
      for(const [pid,parent] of processes){
        if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);found=true}
      }
    }
    const groups=new Set(processes.filter(([pid,,group])=>owned.has(pid)&&owned.has(group)).map(([, ,group])=>group));
    const signal=(pid)=>{try{process.kill(pid,'SIGKILL')}catch(err){if(err.code!=='ESRCH')throw err}};
    for(const [pid,,group] of processes.reverse()){
      if(pid!==proc.pid&&owned.has(pid)&&!groups.has(group))signal(pid);
    }
    for(const group of groups)if(group!==proc.pid)signal(-group);
    if(groups.has(proc.pid))signal(-proc.pid);
    else if(proc.exitCode===null&&proc.signalCode===null)signal(proc.pid);
  }
  dispose(){try{this.proc?.kill()}catch{}}
}
module.exports={CodexApp,itemStep,turnError,sandboxMode};
