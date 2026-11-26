const {text:uiText}=require('../dist/i18n.js');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {createInterface}=require('node:readline');
const {CodexApp,itemStep,sandboxMode}=require('./codex-app.cjs');
const defaultModel='运行时默认';
// Built-in runtimes. Orchestration reads `protocol` and `caps`, never the runtime name.
// write: files in the run directory; shell: run commands; network: reach the web.
// Codex and Claude use their own sandbox in normal mode. Pi runs tools with the user's rights.
// OpenClaw applies the Gateway's policy to turn-scoped permission requests.
const builtins=[
  {name:'Codex',command:'codex',protocol:'codex-app',caps:['write','shell','network'],images:true,adapter:'Codex · app-server',steer:true,login:'codex login'},
  {name:'Claude',command:'claude',protocol:'claude-stream',caps:['write','shell','network'],images:true,adapter:'Claude Code · stream-json',login:'claude（在其中输入 /login）'},
  {name:'OpenClaw',command:'openclaw',protocol:'openclaw-cli',caps:['write','shell','network'],images:false,adapter:'OpenClaw CLI · Gateway',login:'openclaw'},
  {name:'DeepSeek Harness',command:'dsh',args:['acp'],protocol:'acp',caps:['write'],images:false,adapter:'DeepSeek Harness · ACP',login:'dsh'},
  {name:'Pi',command:'pi',protocol:'pi-json',caps:['write','shell'],images:true,adapter:'Pi · JSON events',login:'pi（在其中输入 /login）'},
];
const capabilities=Object.fromEntries(builtins.map(b=>[b.name,b.caps]));
const claudeSandbox=JSON.stringify({sandbox:{enabled:true,autoAllowBashIfSandboxed:true}});
const claudeFullAccess=JSON.stringify({sandbox:{enabled:false}});
// PI_SKIP_VERSION_CHECK keeps pi from checking for updates on every start.
const env={...process.env,PI_SKIP_VERSION_CHECK:'1',PATH:[process.env.PATH,path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(path.delimiter)};
function locate(command,override){
  const candidates=override?[override]:path.isAbsolute(command)?[command]:env.PATH.split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,command));
  return candidates.find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile()}catch{return false}});
}
const redact=text=>String(text).replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi,uiText('[已隐藏]'));
function safeError(message){return redact(message||uiText('运行时退出')).slice(-1200)}
// Turns sign-in and quota failures into messages the user can act on.
function explain(spec,message){
  const m=String(message||'');
  if(/not logged in|please run \/login|login required|unauthori[sz]ed|\b401\b|invalid api key|authentication|failed to authenticate|oauth|session expired|token (?:has )?expired/i.test(m))return spec.name+uiText(' 尚未登录或登录已失效，请在终端运行 ')+uiText(spec.login||spec.command)+uiText(' 完成登录后重试。');
  if(!/^额度已用完/.test(m)&&/usage limit|rate limit|hit your limit|quota|insufficient credits|credit balance|too many requests|\b429\b/i.test(m))return uiText('额度已用完 · ')+safeError(m).slice(0,300);
  return safeError(m);
}
const clip=(text,n=160)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s};
const base=p=>path.basename(String(p||''));
function claudeTool(t){
  const i=t.input||{};
  switch(t.name){
    case 'Bash':return uiText('运行命令 · ')+clip(i.command,180);
    case 'Write':return uiText('写入文件 · ')+base(i.file_path);
    case 'Edit':case 'MultiEdit':case 'NotebookEdit':return uiText('修改文件 · ')+base(i.file_path||i.notebook_path);
    case 'Read':return uiText('读取文件 · ')+base(i.file_path);
    case 'Glob':case 'Grep':return uiText('查找 · ')+clip(i.pattern,100);
    case 'WebSearch':return uiText('联网搜索 · ')+clip(i.query,100);
    case 'WebFetch':return uiText('打开网页 · ')+clip(i.url,120);
    case 'TodoWrite':return uiText('计划 · ')+(i.todos||[]).map(x=>(x.status==='completed'?'✓':'·')+clip(x.content,40)).join(' ');
    case 'Task':case 'Agent':return uiText('子任务 · ')+clip(i.description||i.prompt,120);
    default:return uiText('调用工具 · ')+t.name;
  }
}
function piTool(name,i={}){
  switch(name){
    case 'bash':return uiText('运行命令 · ')+clip(i.command,180);
    case 'write':return uiText('写入文件 · ')+base(i.path||i.file_path);
    case 'edit':return uiText('修改文件 · ')+base(i.path||i.file_path);
    case 'read':return uiText('读取文件 · ')+base(i.path||i.file_path);
    case 'grep':case 'find':return uiText('查找 · ')+clip(i.pattern,100);
    case 'ls':return uiText('查看目录 · ')+clip(i.path||'.',100);
    default:return uiText('调用工具 · ')+name;
  }
}
// Timeline rows from Claude's stream: tool calls start as running and are settled by their tool_result.
function claudeSteps(e){
  const steps=[];
  if(e.type==='assistant'){
    const content=e.message?.content||[],tools=content.some(c=>c.type==='tool_use');
    for(const c of content){
      if(c.type==='tool_use')steps.push({id:c.id,status:'running',label:claudeTool(c)});
      // Text next to tool calls is the agent narrating; text alone is the answer itself.
      else if(c.type==='text'&&tools&&c.text?.trim())steps.push({id:'t-'+randomUUID(),status:'done',label:uiText('说明 · ')+clip(c.text,180)});
      else if(c.type==='thinking'&&c.thinking?.trim())steps.push({id:'r-'+randomUUID(),status:'done',label:uiText('思考 · ')+clip(c.thinking,140)});
    }
  }
  if(e.type==='user')for(const c of e.message?.content||[])if(c.type==='tool_result'){
    const text=Array.isArray(c.content)?c.content.map(x=>x.text||'').join(' '):c.content;
    steps.push({id:c.tool_use_id,status:c.is_error?'failed':'done',detail:c.is_error?clip(text,160):''});
  }
  return steps;
}
function acpStep(u,calls){
  if(u.sessionUpdate==='tool_call'){
    const where=(u.locations||[]).map(l=>base(l.path)).filter(Boolean).join('、');
    const label=({read:uiText('读取'),edit:uiText('修改'),delete:uiText('删除'),move:uiText('移动'),search:uiText('查找'),execute:uiText('运行命令'),fetch:uiText('联网'),think:uiText('思考')}[u.kind]||uiText('调用工具'))+' · '+clip(u.title||where||uiText('执行'),160);
    return {id:u.toolCallId,status:u.status==='completed'?'done':u.status==='failed'?'failed':'running',label};
  }
  if(u.sessionUpdate==='tool_call_update'&&['completed','failed'].includes(u.status))return {id:u.toolCallId,status:u.status==='failed'?'failed':'done',...(calls.get(u.toolCallId)?.title?{}:{label:uiText('调用工具')})};
  if(u.sessionUpdate==='plan')return {id:'plan',status:'done',label:uiText('计划 · ')+(u.entries||[]).map(x=>(x.status==='completed'?'✓':'·')+clip(x.content,40)).join(' ')};
  return null;
}
const defaultTimeout=12*60*1000,longPrompt=32*1024;
function spawnCli(bin,args,cwd,signal,timeout=0){
  if(signal?.aborted)throw Error(uiText('本次运行已停止'));
  const proc=spawn(bin,args,{cwd,env,stdio:'pipe',detached:process.platform!=='win32',windowsHide:true});
  let closed=false,stopping=false;
  // Signals go to the whole process group, so commands the CLI started (dev servers, watchers) stop with it.
  const send=sig=>{try{if(process.platform==='win32'){if(!closed)proc.kill(sig)}else if(proc.pid)process.kill(-proc.pid,sig)}catch{}};
  // A CLI that ignores SIGTERM is force-stopped shortly after.
  function kill(){if(stopping)return;stopping=true;send('SIGTERM');setTimeout(()=>send('SIGKILL'),5000).unref()}
  proc.stop=kill;
  let timer;
  const arm=ms=>{if(!timeout)return;clearTimeout(timer);timer=setTimeout(()=>{proc.timedOut=timeout>=60000?Math.round(timeout/60000)+uiText(' 分钟'):Math.ceil(timeout/1000)+uiText(' 秒');kill()},ms)};
  // While the user answers an approval, the clock stops.
  let left=timeout,since=Date.now();arm(timeout);
  proc.pauseClock=()=>{clearTimeout(timer);left-=Date.now()-since};proc.resumeClock=()=>{since=Date.now();if(!closed)arm(Math.max(1000,left))};
  signal?.addEventListener('abort',kill,{once:true});proc.once('close',()=>{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',kill);kill()});
  proc.stdin.on('error',()=>{});return proc;
}
function stopReason(p,signal){return signal?.aborted?uiText('本次运行已停止'):p.timedOut?uiText('超过 ')+p.timedOut+uiText('仍未完成，已停止'):''}
function cli(bin,args,cwd,input,signal,onLine,timeout){
  return new Promise((resolve,reject)=>{
    const p=spawnCli(bin,args,cwd,signal,timeout);let stdout='',stderr='';
    // Streamed output is consumed line by line, so only a tail is kept for error messages. The buffer is trimmed
    // once it doubles, not on every chunk, so a long stream does not copy megabytes per chunk.
    const limit=onLine?16_000:4_000_000;
    p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
    p.stdout.on('data',s=>{stdout+=s;if(stdout.length>2*limit)stdout=stdout.slice(-limit)});
    p.stderr.on('data',s=>{stderr=(stderr+s).slice(-2000)});
    if(onLine)createInterface({input:p.stdout}).on('line',line=>{try{onLine(JSON.parse(line))}catch{}});
    p.once('error',reject);p.once('close',code=>{const stopped=stopReason(p,signal);stdout=stdout.slice(-limit);code===0&&!stopped?resolve(stdout):reject(Error(safeError(stopped||stderr||stdout||uiText('CLI 退出 ')+code)))});
    p.stdin.end(input);
  });
}
// Generic ACP client (DeepSeek Harness and any runtime the user adds).
// Approval modes: allow — approve every request; auto — approve reads/edits inside the run directory, ask about the rest;
// ask — ask about every request. The user can answer allow once, allow for the rest of this run, or deny.
async function acp({bin,args=['acp'],cwd,prompt,model,signal,report=()=>{},images=[],timeout,approvalMode='auto',approve}){
  const p=spawnCli(bin,args,cwd,signal,timeout);let serial=0,answer='',failure,stderr='',runAllowed=false;const waiting=new Map();
  const send=m=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  function fail(err){failure=err;for(const call of waiting.values())call.reject(err);waiting.clear()}
  p.stderr.on('data',s=>{stderr=(stderr+s).slice(-1000)});
  p.once('error',fail);p.once('close',()=>fail(Error(safeError(stopReason(p,signal)||stderr||uiText('ACP 连接已关闭')))));
  function rpc(method,params){
    if(failure)return Promise.reject(failure);
    return new Promise((resolve,reject)=>{const id=++serial;waiting.set(id,{resolve,reject});send({id,method,params})});
  }
  const calls=new Map(),roots=[...new Set([path.resolve(cwd),fs.realpathSync(cwd)])].map(r=>r+path.sep);
  async function permit(params){
    const call={...calls.get(params?.toolCall?.toolCallId),...params?.toolCall},options=params.options||[];
    const pick=kind=>options.find(o=>o.kind===kind);
    const allow=pick('allow_once')||pick('allow_always'),reject=pick('reject_once')||pick('reject_always');
    const yes=allow?{outcome:{outcome:'selected',optionId:allow.optionId}}:{outcome:{outcome:'cancelled'}};
    const no=reject?{outcome:{outcome:'selected',optionId:reject.optionId}}:{outcome:{outcome:'cancelled'}};
    if(!allow)return no;
    const places=Array.isArray(call.locations)?call.locations:[];
    const inside=places.length>0&&places.every(l=>typeof l?.path==='string'&&roots.some(root=>path.resolve(cwd,l.path).startsWith(root)));
    if(approvalMode==='allow'||runAllowed)return yes;
    if(approvalMode==='auto'&&['read','edit'].includes(call.kind)&&inside)return yes;
    if(!approve)return no;
    p.pauseClock();
    try{
      const answer=await approve({kind:call.kind==='execute'?'command':['edit','delete','move'].includes(call.kind)?'file':call.kind==='fetch'?'network':'tool',title:clip(call.title||'',200),files:places.map(l=>base(l.path)),command:call.kind==='execute'?clip(call.title||call.rawInput?.command||'',300):'',cwd});
      if(answer==='allow-run')runAllowed=true;
      return answer==='allow'||answer==='allow-run'?yes:no;
    }finally{p.resumeClock()}
  }
  // A run-wide decision must settle before the next permission request is evaluated.
  let permissionQueue=Promise.resolve();
  createInterface({input:p.stdout}).on('line',line=>{
    let msg;try{msg=JSON.parse(line)}catch{return}
    if(msg.method&&msg.id!=null){
      if(msg.method==='session/request_permission'){
        permissionQueue=permissionQueue.then(async()=>{
          if(failure||signal?.aborted)return;
          let result;
          try{result=await permit(msg.params)}catch{result={outcome:{outcome:'cancelled'}}}
          if(!failure&&!signal?.aborted)send({id:msg.id,result});
        }).catch(fail);
      }
      else send({id:msg.id,error:{code:-32601,message:'Unsupported client method'}});
    }else if(msg.method==='session/update'){
      const u=msg.params.update;
      if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){answer=(answer+u.content.text).slice(-2_000_000);report({delta:answer})}
      if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update')calls.set(u.toolCallId,{...calls.get(u.toolCallId),...u});
      const step=acpStep(u,calls);if(step)report({step});
    }else if(waiting.has(msg.id)){const cb=waiting.get(msg.id);waiting.delete(msg.id);if(msg.error)cb.reject(Error(safeError(msg.error.message)));else cb.resolve(msg.result)}
  });
  try{
    const handshake=await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'bercy',version:'0.2.0'}});
    const session=await rpc('session/new',{cwd,mcpServers:[]}),sid=session.sessionId;
    const config=session.configOptions?.find(o=>o.category==='model'||o.id==='model');
    const acceptsImage=handshake.agentCapabilities?.promptCapabilities?.image===true;
    if(prompt===null)return {models:session.models?.availableModels?.map(m=>m.modelId)||config?.options?.map(o=>o.value).filter(Boolean)||[],supportsImages:acceptsImage};
    if(model){if(config)await rpc('session/set_config_option',{sessionId:sid,configId:config.id,value:model});
      else await rpc('session/set_model',{sessionId:sid,modelId:model})}
    if(images.length&&!acceptsImage)throw Error(uiText('运行时此次 ACP 握手未声明图像输入，请切换支持图片的运行时'));
    const parts=await Promise.all(images.map(async f=>({type:'image',mimeType:f.type,data:(await fs.promises.readFile(f.path)).toString('base64')})));
    const end=await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:prompt},...parts]});
    if(end.stopReason!=='end_turn')throw Error(uiText('ACP 未完成 · ')+end.stopReason);return answer;
  }finally{p.stdin.end();p.stop()}
}
// Keep discovery separate from per-workflow processes so stopping one workflow cannot kill another.
const codexApps=new Map();
function codexKey(bin,scope){return JSON.stringify([bin,scope||null])}
function codexApp(bin,scope){
  const key=codexKey(bin,scope);
  if(!codexApps.has(key))codexApps.set(key,new CodexApp(bin,env,!!scope));
  return codexApps.get(key);
}
function disposeAll(){
  for(const app of codexApps.values()){clearTimeout(app.idleTimer);app.dispose()}
  codexApps.clear();
}
async function stopWorkflow(scope){
  if(!scope)return;
  await Promise.all([...codexApps].filter(([key])=>JSON.parse(key)[1]===scope).map(async ([key,app])=>{
    clearTimeout(app.idleTimer);
    await app.stopProcessTree();
    if(codexApps.get(key)===app)codexApps.delete(key);
  }));
}
// Specs for the built-ins plus the user's own ACP runtimes ({name, command, args, caps, images}).
function catalogSpecs(custom=[]){
  const own=(Array.isArray(custom)?custom:[]).filter(c=>c&&typeof c.name==='string'&&c.name.trim()&&typeof c.command==='string'&&!builtins.some(b=>b.name===c.name)).map(c=>({
    name:c.name.trim().slice(0,40),command:c.command,args:Array.isArray(c.args)?c.args.map(String):['acp'],protocol:'acp',custom:true,
    caps:['write','shell','network'].filter(x=>(c.caps||[]).includes(x)),images:c.images===true,adapter:'自定义 · ACP',login:c.command}));
  return [...builtins,...own];
}
// Claude Code reports its sign-in state without a network call. An expired session reads as signed out.
function claudeAccount(bin){
  return new Promise(resolve=>{
    let out='',p;
    try{p=spawn(bin,['auth','status'],{cwd:os.homedir(),stdio:['ignore','pipe','ignore']})}catch{return resolve(null)}
    const timer=setTimeout(()=>{p.kill();resolve(null)},5000);
    p.stdout.on('data',d=>out+=d);p.on('error',()=>{clearTimeout(timer);resolve(null)});
    p.on('close',()=>{clearTimeout(timer);
      try{const j=JSON.parse(out.slice(out.indexOf('{')));resolve({signedIn:!!j.loggedIn||!!process.env.ANTHROPIC_API_KEY,plan:j.subscriptionType||''})}catch{resolve(null)}});
  });
}
async function detect(overrides={},custom=[]){
  return Promise.all(catalogSpecs(custom).map(async spec=>{
    const bin=locate(spec.command,overrides[spec.name]),models=[defaultModel];
    const r={...spec,bin:bin||'',models,supportsImages:spec.images};
    if(!bin)return r;
    try{
      if(spec.protocol==='codex-app'){
        try{
          const app=codexApp(bin),[list,account]=await Promise.all([app.models(),app.account().catch(()=>null)]);
          models.push(...list);if(account)r.account=account.account?{signedIn:true,plan:account.account.planType||account.account.type||''}:{signedIn:false};
        }catch{
          const cache=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'models_cache.json'),'utf8'));
          models.push(...cache.models.filter(m=>m.visibility!=='hide').map(m=>m.slug));
        }
      }
      if(spec.protocol==='claude-stream'){models.push('sonnet','opus','haiku');const account=await claudeAccount(bin);if(account)r.account=account}
      if(spec.protocol==='openclaw-cli'){
        const sig=AbortSignal.timeout(5500),s=await cli(bin,['models','list','--json'],os.homedir(),'',sig);
        models.push(...JSON.parse(s.slice(s.indexOf('{'))).models.filter(m=>m.available!==false).map(m=>m.key).filter(Boolean));
      }
      if(spec.protocol==='acp'){const cap=await acp({bin,args:spec.args,cwd:os.tmpdir(),prompt:null,signal:AbortSignal.timeout(7000)});models.push(...cap.models);r.supportsImages=cap.supportsImages}
    }catch{/* CLI defaults remain usable when catalog discovery is unavailable. */}
    r.models=[...new Set(models)];return r;
  }));
}
async function codexExec({bin,cwd,extraDirectory,prompt,images,model,planning,approvalMode,network,captureSources,signal,timeout,report,usage}){
  let final='',nativeError='';
  const sandbox=sandboxMode(planning,approvalMode);
  const args=['exec','--skip-git-repo-check',...(sandbox==='workspace-write'&&extraDirectory?['--add-dir',extraDirectory]:[]),'--ephemeral','--sandbox',sandbox,...(approvalMode==='allow'?['-c','approval_policy="never"']:[]),'--json',...(model?['--model',model]:[]),...images.flatMap(f=>['--image',f.path]),...(planning?['-c','model_reasoning_effort="medium"']:[]),...(sandbox==='workspace-write'&&network?['-c','sandbox_workspace_write.network_access=true']:[]),'-'];
  await cli(bin,args,cwd,prompt,signal,e=>{
    if(e.type==='error'&&e.message)nativeError=e.message;
    if(e.item?.type==='agent_message'&&e.type==='item.completed')final=e.item.text;
    if(e.item&&/^item\.(started|completed)$/.test(e.type)){
      const it={...e.item,type:{command_execution:'commandExecution',file_change:'fileChange',web_search:'webSearch',mcp_tool_call:'mcpToolCall',agent_message:'agentMessage',todo_list:'plan'}[e.item.type]||e.item.type,aggregatedOutput:e.item.aggregated_output,exitCode:e.item.exit_code,summary:e.item.text?[e.item.text]:[],phase:'commentary'};
      if(!(it.type==='agentMessage'))(s=>s&&report({step:s}))(itemStep(it,e.type==='item.completed',captureSources));
    }
    if(e.type==='turn.completed'&&e.usage)usage({input:e.usage.input_tokens,cached:e.usage.cached_input_tokens,output:e.usage.output_tokens});
    if(e.type==='turn.failed')nativeError=e.error?.message||uiText('模型执行失败');
  },timeout).catch(err=>{throw Error(nativeError||err.message)});
  if(nativeError)throw Error(nativeError);
  return final;
}
// One node execution. `report` receives {step} timeline rows and {delta} live text; `approve` asks the user.
// Returns the final text, or {text, threadId} for Codex so a follow-up turn can continue the same thread.
async function invoke(opts){
  const {name,bin,cwd,prompt,images=[],signal,usage=()=>{},planning=false,needs=[],timeout=planning?defaultTimeout:0,approvalMode='auto',approve,threadId,extraDirectory,scope}=opts;
  const spec={...(builtins.find(b=>b.name===name)||{name,command:bin,protocol:'acp',args:['acp']}),...(opts.protocol?{protocol:opts.protocol}:{}),...(opts.args?{args:opts.args}:{})};
  const report=opts.report||(x=>x.step?.label&&opts.event?.(x.step.label));
  if(!bin)throw Error(name+uiText(' 尚未连接'));const model=opts.model===defaultModel?'':(opts.model||'');
  if(signal?.aborted)throw Error(uiText('本次运行已停止'));
  const fullAccess=!planning&&approvalMode==='allow';
  const network=!planning&&(fullAccess||needs.includes('network'));
  try{
    if(spec.protocol==='acp')return await acp({bin,args:spec.args,cwd,prompt,model,signal,report,images,timeout,approvalMode:planning?'auto':approvalMode,approve});
    if(spec.protocol==='codex-app'){
      const app=codexApp(bin,scope),key=codexKey(bin,scope);
      clearTimeout(app.idleTimer);app.activeRuns=(app.activeRuns||0)+1;
      try{
        try{await app.start()}catch(err){if(!/app-server|unrecognized|unknown/i.test(err.message))throw err;return await codexExec({bin,cwd,extraDirectory,prompt,images,model,planning,approvalMode,network,captureSources:opts.captureSources,signal,timeout,report,usage})}
        const r=await app.run({cwd,extraDirectory,prompt,images,model,planning,network,captureSources:opts.captureSources,approvalMode,threadId,signal,timeout,step:s=>report({step:s}),delta:d=>report({delta:d}),usage,approve,onThread:id=>report({thread:id})});
        return planning?r.text:{text:r.text,threadId:r.threadId,resumed:r.resumed};
      }finally{
        app.activeRuns--;
        if(scope&&!app.activeRuns&&codexApps.get(key)===app){
          app.idleTimer=setTimeout(()=>{if(codexApps.get(key)===app){codexApps.delete(key);app.dispose()}},120000);
          app.idleTimer.unref();
        }
      }
    }
    if(spec.protocol==='codex-exec')return await codexExec({bin,cwd,extraDirectory,prompt,images,model,planning,approvalMode,network,captureSources:opts.captureSources,signal,timeout,report,usage});
    let final='',nativeError='';
    if(spec.protocol==='claude-stream'){
      const mode=fullAccess?'bypassPermissions':'acceptEdits';
      const args=['-p',...(extraDirectory?['--add-dir',extraDirectory]:[]),'--verbose','--output-format','stream-json','--include-partial-messages','--no-session-persistence',...(model?['--model',model]:[]),...(planning?['--tools','']:['--permission-mode',mode,'--settings',fullAccess?claudeFullAccess:claudeSandbox]),...(network?['--allowedTools','WebSearch,WebFetch']:[])];
      let input=prompt,draft='';
      if(images.length){args.push('--input-format','stream-json');
        const content=await Promise.all(images.map(async f=>({type:'image',source:{type:'base64',media_type:f.type,data:(await fs.promises.readFile(f.path)).toString('base64')}})));
        content.push({type:'text',text:prompt});input=JSON.stringify({type:'user',message:{role:'user',content}})+'\n';
      }
      await cli(bin,args,cwd,input,signal,e=>{
        if(e.type==='stream_event'){const ev=e.event||{};if(ev.type==='message_start')draft='';if(ev.type==='content_block_delta'&&ev.delta?.type==='text_delta'){draft+=ev.delta.text;report({delta:draft})}return}
        if(e.type==='result'){if(e.usage)usage({input:e.usage.input_tokens,cached:e.usage.cache_read_input_tokens,output:e.usage.output_tokens});final=e.result;if(e.is_error||e.subtype!=='success')nativeError=e.result||e.subtype}
        for(const step of claudeSteps(e))report({step});
      },timeout).catch(err=>{throw Error(nativeError||err.message)});
    }else if(spec.protocol==='openclaw-cli'){
      // Long prompts go through a file: argv has a size limit and is visible in the process list.
      let message=prompt;
      if(Buffer.byteLength(prompt)>longPrompt){const file=path.join(opts.attemptDir||cwd,'task.md');await fs.promises.writeFile(file,prompt,{mode:0o600});message=uiText('完整任务写在文件 ')+file+uiText(' 中。先完整阅读该文件，再严格按其中的要求交付。')}
      // Request full shell access for this run only. The Gateway still owns its host and tool policy.
      if(fullAccess)message='/exec security=full ask=off '+message;
      report({step:{id:'openclaw',status:'running',label:uiText('OpenClaw 执行中（完成后返回结果，无逐步记录）')}});
      const sessionId=randomUUID();
      let raw;
      try{
        raw=await cli(bin,['agent','--json','--session-id',sessionId,'--message',message,...(model?['--model',model]:[])],cwd,'',signal,null,timeout);
      }catch(err){
        if(!signal?.aborted)throw err;
        try{
          const rpc=async(method,params)=>{
            const reply=await cli(bin,['gateway','call',method,'--json','--params',JSON.stringify(params)],cwd,'',undefined,null,5000);
            return JSON.parse(reply.slice(reply.indexOf('{')));
          };
          const session=await rpc('sessions.resolve',{sessionId,allowMissing:true});
          if(session.key)await rpc('sessions.abort',{key:session.key});
        }catch(cancelError){
          const label=uiText('OpenClaw Gateway 未确认停止');
          report({step:{id:'openclaw',status:'failed',label,detail:safeError(cancelError.message)}});
        }
        throw err;
      }
      report({step:{id:'openclaw',status:'done'}});
      const envelope=JSON.parse(raw.slice(raw.indexOf('{'))),r=envelope.result||envelope;
      if(envelope.status&&envelope.status!=='ok'&&envelope.status!=='completed')throw Error(safeError(envelope.summary||envelope.status));
      const counts=r.meta?.agentMeta?.usage;if(counts)usage({input:counts.input,cached:counts.cacheRead,output:counts.output});
      const payloads=r.payloads||[];final=payloads.map(p=>p.text||'').join('\n');
      if(payloads.some(p=>p.isError)||r.meta?.aborted||/^LLM request failed\.?$/i.test(final.trim()))nativeError=final||uiText('OpenClaw 模型请求失败');
    }else if(spec.protocol==='pi-json'){
      // One-shot JSON event stream, as multica runs it: `pi -p --mode json`, prompt on stdin (never argv, which has a
      // size limit and is visible in the process list), images as @file arguments. Errors follow multica's rules:
      // a provider error is cleared by a new turn or a retry, and one still standing at exit fails the run even on
      // exit 0 (older pi reports a bad API key only in agent_end).
      const tools=planning?['--no-tools']:fullAccess?['--tools','*']:['--tools',['read','write','edit','grep','find','ls',...(needs.includes('shell')?['bash']:[])].join(',')];
      const args=['-p','--mode','json','--no-session',...(model?['--model',model]:[]),...tools,...images.map(f=>'@'+f.path)];
      const clean=t=>String(t||'').replace(/<\|[^|>]{0,40}\|>/g,'');
      const failure=m=>m?.role==='assistant'&&(m.stopReason==='error'||m.stopReason==='aborted')?(m.errorMessage||m.stopReason):'';
      const textOf=m=>clean((Array.isArray(m?.content)?m.content:[]).filter(c=>c.type==='text').map(c=>c.text||'').join(''));
      let draft='';const total={input:0,cached:0,output:0};
      await cli(bin,args,cwd,prompt,signal,e=>{
        switch(e.type){
          case 'turn_start':case 'auto_retry_start':nativeError='';return;
          case 'message_start':if(e.message?.role==='assistant')draft='';return;
          case 'message_update':{
            const ev=e.assistantMessageEvent||{};
            if(ev.type==='text_delta'&&ev.delta){draft+=ev.delta;report({delta:clean(draft)})}
            return;
          }
          case 'message_end':{
            const m=e.message;if(m?.role!=='assistant')return;
            const content=Array.isArray(m.content)?m.content:[],text=textOf(m),err=failure(m);
            if(m.usage){total.input+=m.usage.input||0;total.cached+=m.usage.cacheRead||0;total.output+=m.usage.output||0;usage({...total})}
            if(err){nativeError=err;return}
            if(text.trim()){final=text;if(content.some(c=>c.type==='toolCall'))report({step:{id:'t-'+randomUUID(),status:'done',label:uiText('说明 · ')+clip(text,180)}})}
            for(const c of content)if(c.type==='thinking'&&c.thinking?.trim())report({step:{id:'r-'+randomUUID(),status:'done',label:uiText('思考 · ')+clip(c.thinking,140)}});
            return;
          }
          case 'tool_execution_start':report({step:{id:e.toolCallId||randomUUID(),status:'running',label:piTool(e.toolName,e.args||{})}});return;
          case 'tool_execution_end':if(e.toolCallId)report({step:{id:e.toolCallId,status:e.isError?'failed':'done'}});return;
          case 'auto_retry_end':if(e.success)nativeError='';else nativeError=e.finalError||nativeError;return;
          case 'agent_end':{
            const last=[...(e.messages||[])].reverse().find(m=>m?.role==='assistant');
            if(failure(last))nativeError=failure(last);else if(!final&&last)final=textOf(last);
            return;
          }
          case 'error':nativeError=String(e.message||e.error||'')||nativeError;return;
        }
      },timeout).catch(err=>{throw Error(nativeError||err.message)});
    }else throw Error(uiText('未知运行时协议'));
    if(nativeError||!final)throw Error(nativeError||uiText('运行时结束，但没有返回交付结果'));
    return final;
  }catch(err){throw Error(explain(spec,err.message))}
}
// Runs a project's acceptance command in its directory. Resolves {ok, code, output} with the tail of the output;
// rejects only when the run was stopped.
function check(command,cwd,signal,timeout=10*60*1000){
  return new Promise((resolve,reject)=>{
    let p;try{p=spawnCli('/bin/sh',['-c',command],cwd,signal,timeout)}catch(err){reject(err);return}
    let out='';const take=s=>{out+=s;if(out.length>32000)out=out.slice(-16000)};
    p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');p.stdout.on('data',take);p.stderr.on('data',take);
    p.once('error',reject);
    p.once('close',code=>{
      const stopped=stopReason(p,signal);if(signal?.aborted)return reject(Error(stopped));
      resolve({ok:code===0&&!stopped,code:stopped?null:code,output:redact((stopped?stopped+'\n':'')+out).slice(-4000)});
    });
    p.stdin.end();
  });
}
async function steer(bin,threadId,text,scope){return codexApp(bin,scope).steer(threadId,text)}
function hasThread(bin,id,approvalMode,scope){
  const sandbox=codexApps.get(codexKey(bin,scope))?.threads.get(id);
  return approvalMode===undefined?!!sandbox:sandbox===sandboxMode(false,approvalMode);
}
module.exports={detect,invoke,check,steer,hasThread,disposeAll,stopWorkflow,catalogSpecs,defaultModel,safeError,explain,capabilities,claudeSteps,acpStep};
