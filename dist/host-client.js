const host=window.relayHost;
let scanned=false,initialScan;
const inflight=new Map(),stoppingWorkflows=new Set();
async function refreshConnections(name,list){
  if(!host)return;
  list??=name?await host.choose(name):await host.scan();
  // Runtimes the user added show up as new entries; removed ones disappear.
  for(let i=runtimes.length-1;i>=0;i--)if(runtimes[i].custom&&!list.some(r=>r.name===runtimes[i].name))runtimes.splice(i,1);
  for(const row of list)if(!runtimeInfo(row.name))runtimes.push({name:row.name,custom:true,icon:'',models:row.models,strengths:[],tools:['文本交付','结构化汇总']});
  // The first runtime that is installed and not known to be signed out is connected by default.
  const firstInstalled=(list.find(r=>r.installed&&r.account?.signedIn!==false)||list.find(r=>r.installed))?.name;
  for(const row of list){
    const runtime=runtimeInfo(row.name),c=db.connections[row.name]??={online:false,model:'运行时默认'};
    Object.assign(runtime,{models:row.models,adapter:row.adapter,bin:row.path,installed:row.installed,supportsImages:row.supportsImages,caps:row.caps||runtime.caps,steer:!!row.steer,protocol:row.protocol,account:row.account,login:row.login,custom:!!row.custom});
    if(name===row.name&&row.installed)c.enabled=true;
    if(c.enabled==null&&row.installed)c.enabled=row.name===firstInstalled;
    c.online=row.installed&&c.enabled===true;
    if(!row.models.includes(c.model))c.model=row.models[0];
  }
  // Workflows waiting for a runtime (for example runs picked up after a reload) continue once connections are known.
  scanned=true;settingsSignature='';save();pump();
}
function soloDefinition(q,plainText=false){
  const delivery=plainText?'text':Dag.delivery({artifact:q}),needs=[];
  if(!plainText&&/联网|最新|今天|今日|实时|新闻|搜索|查一下|网上/.test(q))needs.push('network');
  if(!plainText&&/运行|执行脚本|转码|ffmpeg|编译|跑一下|安装|命令行/i.test(q))needs.push('shell');
  const d=Dag.definition([{id:'solo',name:uiText('执行者'),description:q,artifact:delivery==='text'?uiText('答复'):uiText('交付文件'),delivery,needs,deps:[]}]);
  d.scopedBriefs=true;return d;
}
// Character-bigram overlap between the brief and a saved flow's name, sample brief, roles and outputs.
function grams(text){const s=String(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,''),g=new Set();for(let i=0;i<s.length-1;i++)g.add(s.slice(i,i+2));return g}
function similarFlow(q){
  const a=grams(q);if(a.size<3)return null;let best=null;
  for(const item of db.library){
    const d=item.versions[item.versions.length-1],b=grams([item.name,item.sample||'',...Object.values(d.roles).flatMap(r=>[r.name,r.artifact])].join(' '));
    let both=0;for(const x of a)if(b.has(x))both++;
    const score=2*both/(a.size+b.size);if(score>=.22&&(!best||score>best.score))best={item,score};
  }
  return best?.item||null;
}
// Planning decides the quality of the whole workflow, so it uses the runtime's default (stronger) model;
// The runtime the user picked in settings comes first; otherwise the first connected one in plannerOrder, then any.
// The same choice plans workflows and runs the observer.
const plannerOrder=['Codex','Claude','Pi','DeepSeek Harness','OpenClaw'];
function plannerChoice(connected,query,kind){
  const policy=Dag.briefPolicy(query);
  const requested=kind==='observe'?policy.reviewer||policy.planner:policy.planner;
  const pick=(requested?connected.find(r=>r.name===requested):connected.find(r=>r.name===db.settings?.planner)||plannerOrder.map(n=>connected.find(r=>r.name===n)).find(Boolean)||connected[0]);
  if(!pick)throw Error(uiText('任务指定的运行时未连接 · ')+requested);
  return {runtime:pick.name,model:db.connections[pick.name].model};
}
async function requestPlanner(query,extra,kind,form,owner){
  if(!scanned)await initialScan;
  if(owner?.stopped)return null;
  const connected=runtimes.filter(r=>db.connections[r.name].online&&r.installed);
  if(!connected.length)throw Error(scanned?uiText('请先在「设置 → 运行时」连接本机 CLI'):uiText('正在检测本机 CLI，请稍后再试'));
  if(kind==='plan'){
    const {planner,developer,reviewer}=Dag.briefPolicy(query);
    const missing=[planner,developer,reviewer].find(name=>name&&!connected.some(r=>r.name===name));
    if(missing)throw Error(uiText('任务指定的运行时未连接 · ')+missing);
  }
  const key=owner?owner.id+'/@'+uid():uid();if(form)form.dataset.plannerJob=key;
  try{return await host.execute({key,...plannerChoice(connected,query,kind),kind,query,available:connected.map(r=>({name:r.name,can:[...(r.caps||[]),...(r.supportsImages?['image']:[])],...(skillOf(r)?{good:skillOf(r)}:{})})),...extra})}
  finally{if(form)delete form.dataset.plannerJob}
}
async function instantiate(query,definition,attachments,form,projectId){
  const policy=Dag.briefPolicy(query);
  if(!definition && host && !attachments?.length && !project(projectId)?.guide && !project(projectId)?.directory && Delivery.simpleText(query)&&!policy.planner&&!policy.developer&&!policy.reviewer&&!policy.autoContinue){
    if(!scanned)await initialScan;
    const guide=await host.planningGuide();
    if(!guide.custom){
      const direct=soloDefinition(query,true);direct.fast=true;return direct;
    }
  }
  if(!definition){if(!host)return;const d=await requestPlanner(query,{attachments,directory:project(projectId)?.directory,projectGuide:project(projectId)?.guide||''},'plan',form);d.scopedBriefs=true;return d}
  const d=structuredClone(definition);
  if(d.mode==='structure'){
    const briefs=host?await requestPlanner(query,{definition:d,directory:project(projectId)?.directory},'brief',form):Object.fromEntries(Object.keys(d.deps).map(k=>[k,uiText('围绕「')+query+uiText('」，以')+d.roles[k].name+uiText('的职责完成并检查「')+d.roles[k].artifact+uiText('」。')]));
    for(const id of Object.keys(d.deps))d.roles[id].description=briefs[id];d.scopedBriefs=true;
  }
  const final=Dag.outputs(d.deps);
  if(policy.autoContinue&&final.length===1)d.roles[final[0]].continueAfter=true;
  return Dag.assignBriefRuntimes(d,policy);
}
function setBusy(form,text){
  const btn=form.querySelector('button.primary'),original=btn.textContent;
  btn.disabled=true;btn.textContent=text;let line=form.querySelector('.form-error');
  const began=Date.now(),tick=setInterval(()=>{if(!btn.isConnected)return clearInterval(tick);btn.textContent=text.replace(/…$/,'')+'… '+Math.round((Date.now()-began)/1000)+uiText(' 秒')},1000);
  if(!line){line=document.createElement('p');line.className='form-error';line.setAttribute('role','alert');btn.parentElement.before(line)}
  line.textContent='';
  return err=>{clearInterval(tick);btn.disabled=false;btn.textContent=original;if(err)line.textContent=String(err.message||err).replace(/^Error invoking remote method '[^']+': Error: /,'')};
}
function workflowStopping(s){
  return stoppingWorkflows.has(s.id)||(s.stopped&&[...inflight.values()].some(job=>job.s===s));
}
async function liveStop(s){
  if(stoppingWorkflows.has(s.id))return;
  const f=s.flow;
  timers.delete(s.id);delete s.scheduledPending;
  const first=!s.stopped;
  s.stopped=true;stoppingWorkflows.add(s.id);
  if(first)f.logs.unshift([f.time,uiText('已请求停止工作流'),'']);
  save(s);saveNow();render();
  try{
    await host.cancelWorkflow(s.id);
    for(const id of new Set([...Object.keys(f.dispatch),...Object.keys(f.restarting||{})])){
      if(inflight.has(s.id+'/'+id)||f.files[id])continue;
      delete f.dispatch[id];
      if(f.restarting)delete f.restarting[id];
      for(const step of f.steps?.[id]||[])if(step.status==='running')step.status='failed';
    }
  }catch(err){notify(hostError(err))}
  finally{stoppingWorkflows.delete(s.id);save(s);pump()}
}
function liveStart(s){
  if(timers.has(s.id)||Dag.complete(s.flow)||workflowStopping(s))return;
  // Pressing run again retries the nodes that failed.
  if(s.flow.errors&&Object.keys(s.flow.errors).length)s.flow.errors={};
  if(!canProceed(s.flow)){
    const id=runnable(s.flow)[0],why=id?route(s.flow,id).reason:'';
    showSettings();notify(why||uiText('请选择已连接的运行时'));return;
  }
  if(s.directory){save();if(!saveNow())return}
  delete s.stopped;s.flow.started=true;timers.set(s.id,Symbol());save();pump();
}
// After an expandable node delivers, the planner decides whether its breakdown becomes new nodes.
// Bounded by Dag.limits; the user can turn this off in settings. Downstream nodes wait until it settles.
function canContinueAfter(f,id){
  if(!host||db.settings?.expand==='off')return false;
  const final=Dag.outputs(f.deps);
  return final.length===1&&final[0]===id;
}
async function continueFromDelivery(s,id,instruction="",form){
  const f=s.flow,file=f.files[id];
  if(!Dag.complete(f)||!Dag.outputs(f.deps).includes(id)||!file||file.needsInput||file.skipped||f.expanding?.[id])return false;
  const options={manual:true,instruction,form};
  const observation=await observeFinal(s,id,nodeSpec(f,id),file,options);
  if(s.stopped||f.files[id]!==file||form&&(!form.isConnected||!$('modal').open))return false;
  if(observation?.rework&&applyObserverReturn(s,id,file,observation.rework,true)){
    s.answerOpen=false;start(s);return true;
  }
  if(!observation?.continuation||!appendContinuation(f,id,file,observation.continuation,options))return false;
  s.answerOpen=false;start(s);return true;
}
function appendContinuation(f,id,delivery,plan,options={}){
  const policy=Dag.briefPolicy(f.query);
  const updated=Dag.briefPolicy(options.instruction||f.continuationInstruction);
  for(const role of ['planner','developer','reviewer'])if(updated[role])policy[role]=updated[role];
  const history=f.continuationHistory||[];
  const checked=Dag.checkedContinuation(delivery,plan,{...options,history});
  if(!checked)return false;
  const nodes=checked.nodes.map(node=>({...node,description:node.description.slice(0,1750)+'\n\n'+
    uiText('验收标准 · ')+node.acceptance.trim()}));
  let ids;
  try{ids=Dag.expand(f,id,{...checked,nodes},{continuation:true})}
  catch(err){recordNode(f,id,uiText('后续节点无效 · ')+hostError(err));return false}
  if(!ids)return false;
  if(options.instruction)f.continuationInstruction=options.instruction;
  (f.continuationHistory??=[]).push({from:id,progressEvidence:checked.progressEvidence||'',
    nodes:nodes.map(({name,evidence,acceptance})=>({name,evidence,acceptance}))});
  Dag.assignBriefRuntimes({roles:Object.fromEntries(ids.map(key=>[key,f.pack[key]])),overrides:f.overrides},policy);
  recordNode(f,id,uiText('已展开 ')+ids.length+uiText(' 个节点 · ')+(plan.reason||''));
  f.logs.unshift([f.time,uiText('观察者新增了后续节点'),ids.map(k=>f.pack[k].name).join(uiText('、'))]);
  return true;
}
async function considerExpand(s,id,spec,output){
  const f=s.flow,L=Dag.limits;
  if(db.settings?.expand==='off'||Dag.usedContinuation(f)||(f.expansions||0)>=L.expansions||(spec.depth||0)>=L.depth)return false;
  const room=Math.min(L.perExpansion,L.total-Object.keys(f.deps).length);if(room<1)return false;
  (f.expanding??={})[id]=true;recordNode(f,id,uiText('判断是否需要展开'));save();render();
  try{
    const graph=Object.keys(f.deps).map(k=>({id:k,name:f.pack[k].name,artifact:f.pack[k].artifact,deps:f.deps[k],delivered:!!f.files[k]||k===id,paths:f.pack[k].paths||[]}));
    const change=await requestPlanner(f.query,{node:{id,name:spec.name,artifact:spec.artifact,description:spec.description},output,graph,workspace:f.workspace||null,budget:{nodes:room,deeper:(spec.depth||0)+1<L.depth},projectGuide:project(s.project)?.guide||'',session:s.id},'expand',null,s);
    if(s.stopped||f.restarting?.[id])return false;
    if(!change){recordNode(f,id,uiText('无需展开 · 剩余工作按原计划进行'));return false}
    const added=Dag.expand(f,id,change);
    if(!added){recordNode(f,id,uiText('展开未被采纳 · 超出限制或节点无效'));return false}
    recordNode(f,id,uiText('已展开 ')+added.length+uiText(' 个节点 · ')+(change.reason||''));
    for(const n of f.expandNotes||[])f.logs.unshift([f.time,uiText('展开已调整'),n]);
    f.logs.unshift([f.time,spec.name+uiText('展开了 ')+added.length+uiText(' 个节点'),added.map(k=>f.pack[k].name).join(uiText('、'))]);
    return true;
  }catch(err){if(s.stopped)return false;recordNode(f,id,uiText('展开失败，按原计划继续 · ')+String(err.message||err).replace(/^Error invoking remote method '[^']+': Error: /,''));return false}
  finally{delete f.expanding[id];save()}
}
// Runs only on an explicit receipt: "未完成：" (blocked) or a trailing "缺口：" line.
async function considerPatch(s,id,evidence,children,blocked){
  const f=s.flow;
  if(Dag.usedContinuation(f)||!evidence||!children.length||(f.revisionChecks||0)>=2)return false;
  f.revisionChecks=(f.revisionChecks||0)+1;
  save();recordNode(f,id,uiText('检查交付缺口 · ')+evidence);
  try{
    const change=await requestPlanner(f.query,{evidence,source:f.pack[id].name,targets:children,blocked},'revise',null,s);
    if(s.stopped||f.restarting?.[id])return false;
    const extra=Dag.patch(f,id,change,blocked);if(!extra)return false;
    recordNode(f,extra,uiText('新增依据 · ')+change.reason);f.logs.unshift([f.time,uiText('工作流新增{name}').replace('{name}',()=>f.pack[extra].name),change.reason]);return true;
  }catch(err){if(s.stopped)return false;recordNode(f,id,uiText('无法生成局部调整 · ')+err.message);return false}
}
// Applies a batch of live changes (add / skip / modify) without pausing anything else: the graph edit itself is a
// synchronous local step. A running node that a change makes obsolete is cancelled and dispatched again when it
// started recently (restartWindow) or after `since`, the delivery the change was judged from, so it began from inputs
// that are now being revised. Older runs finish first and then rerun with the change as feedback (see follow()).
const restartWindow=60000;
function applyLive(s,ops,{reason='',source='',base=null,since=null}={}){
  const f=s.flow,begun=k=>inflight.get(s.id+'/'+k)?.begin??null;
  const elapsed=k=>{const b=begun(k);return b==null?null:Date.now()-b};
  const fresh=k=>since!=null&&begun(k)!=null&&begun(k)>=since;
  const r=Dag.apply(f,ops,{reason,base,elapsed,window:restartWindow,fresh});
  if(!r.applied.length)return r;
  const label={add:uiText('新增'),skip:uiText('跳过'),modify:uiText('调整')};
  for(const a of r.applied){
    recordNode(f,a.id,uiText('工作流')+label[a.op]+(source?' · '+source:'')+(a.reason?' · '+a.reason:''));
    f.logs.unshift([f.time,uiText('工作流已调整 · ')+label[a.op]+f.pack[a.id].name,a.reason||reason]);
  }
  for(const n of r.notes||[])f.logs.unshift([f.time,uiText('工作流已调整'),n]);
  for(const k of r.restart){
    const key=s.id+'/'+k;if(!inflight.has(key))continue;
    (f.restarting??={})[k]=true;recordNode(f,k,f.files[k]?.skipped?uiText('停止执行 · 已跳过'):uiText('按调整后的任务重新开始'));
    host.cancel(key).catch(()=>{});
  }
  save(s);if(timers.has(s.id))pump();else render();
  return r;
}
// Observer: when a node delivers, one planner call reads the delivery and decides whether nodes that have not
// delivered should be skipped, rewritten, or joined by a new node (this also covers `when` conditions and reported
// gaps). It runs alongside the downstream nodes, which start at once; a change that affects one of them restarts it.
// Conditional children and children of an incomplete delivery wait for the verdict.
// A separate final observation reads the acceptance result before the workflow settles.
const observeTimeout=3;
const liveOn=()=>!!host&&db.settings?.live!=='off';
function returnToNode(s,id,note,current){
  const f=s.flow;
  return invalidate(f,id,note,k=>k!==current&&inflight.has(s.id+'/'+k),k=>{
    (f.restarting??={})[k]=true;
    recordNode(f,k,uiText('上游已退回，等待新版输入后重做'));
    host.cancel(s.id+'/'+k).catch(()=>{});
  });
}
function applyObserverReturn(s,source,file,proposal,terminal=false,current){
  const f=s.flow,repair=Dag.observerReturn(f,source,file,proposal,terminal);
  if(!repair||s.stopped)return false;
  const {id,reason,evidence}=repair,note=reason+'\n'+evidence;
  returnToNode(s,id,note,current);
  (f.observerReturns??=[]).push(repair);
  recordNode(f,id,uiText('观察者退回原节点')+' · '+reason);
  f.logs.unshift([f.time,uiText('观察者退回原节点')+' · '+f.pack[id].name,reason]);
  save(s);return true;
}
async function observeFinal(s,id,spec,delivery,{manual=false,instruction='',allowContinuation=true,form}={}){
  const f=s.flow;
  (f.expanding??={})[id]=true;
  recordNode(f,id,uiText('观察者检查最终交付'));save(s);render();
  try{
    const done=Object.entries(f.files).filter(([key,file])=>key!==id&&!file.skipped).map(([key,file])=>({
      id:key,name:f.pack[key].name,task:nodeSpec(f,key).description,deps:f.deps[key],paths:f.pack[key].paths||[],
      verification:Dag.verification(f.pack[key]),summary:String(file.summary||'').slice(0,400),gaps:file.gaps||''
    }));
    const body=String(delivery.body||'');
    const history=f.continuationHistory||[];
    const state={terminal:true,manual,instruction:instruction||f.continuationInstruction||'',allowContinuation,history,previousReturns:f.observerReturns||[],maxNextNodes:Dag.limits.continuationNodes,done,delivered:{id,name:spec.name,deps:f.deps[id],verification:Dag.verification(spec),task:spec.description,
      body:body.length>30000?body.slice(0,24000)+'\n…\n'+body.slice(-6000):body,
      ...(body.length>30000?{bodyLength:body.length}:{}),gaps:delivery.gaps||'',verificationPending:!!delivery.verificationPending}};
    const observation=await requestPlanner(f.query,{state,timeout:observeTimeout},'observe',form,s);
    if(s.stopped||f.restarting?.[id])return null;
    if(observation?.summary)recordNode(f,id,uiText('观察者 · ')+observation.summary);
    if(observation?.rework)return {...observation,rework:allowContinuation?observation.rework:null,continuation:null};
    if(!observation?.continuation)return observation;
    if(!state.allowContinuation)return {...observation,continuation:null};
    const continuation=Dag.checkedContinuation(delivery,observation.continuation,{manual,instruction,history});
    if(!continuation&&!delivery.verificationPending)recordNode(f,id,uiText('验收证据或通过标准不足，本轮结束'));
    return {...observation,continuation};
  }catch(err){
    if(!s.stopped)recordNode(f,id,uiText('观察者未完成，按原计划继续 · ')+hostError(err));
    return null;
  }finally{delete f.expanding[id];save(s)}
}
function observe(s,id){
  const f=s.flow,open=k=>!f.files[k];
  const runToken=timers.get(s.id);
  if(!runToken||!liveOn()||Dag.usedContinuation(f)||!Dag.descendants(f.deps,id).some(open))return false;
  const active=()=>timers.get(s.id)===runToken&&!s.stopped&&!Dag.usedContinuation(f);
  const since=Date.now(),base=Dag.revision(f),file=f.files[id],below=new Set(Dag.descendants(f.deps,id));
  const hold=Object.keys(f.deps).filter(k=>open(k)&&f.deps[k].includes(id)&&(f.pack[k].when||file.gaps)&&!f.dispatch[k]);
  for(const k of hold)(f.holding??={})[k]=(f.holding[k]||0)+1;
  recordNode(f,id,uiText('观察者检查后续节点'));
  const node=k=>({id:k,name:f.pack[k].name,task:String(nodeSpec(f,k).description||''),artifact:f.pack[k].artifact,deps:f.deps[k],verification:Dag.verification(f.pack[k]),status:f.dispatch[k]?'running':'pending',downstream:below.has(k),...(f.pack[k].when?{when:f.pack[k].when}:{}),...(f.pack[k].paths?{paths:f.pack[k].paths}:{})});
  const state={
    delivered:{id,name:f.pack[id].name,task:String(nodeSpec(f,id).description||''),artifact:f.pack[id].artifact,body:String(file.body||'').slice(0,4000),...(file.body?.length>4000?{bodyLength:file.body.length}:{}),gaps:file.gaps||''},
    remaining:Object.keys(f.deps).filter(open).map(node),
    previousReturns:f.observerReturns||[],
    done:Object.keys(f.files).filter(k=>k!==id&&!f.files[k].skipped).map(k=>({id:k,name:f.pack[k].name,summary:String(f.files[k].summary||'').slice(0,200)})),
  };
  requestPlanner(f.query,{state,timeout:observeTimeout},'observe',null,s).then(async r=>{
    if(!active()||f.files[id]!==file)return;
    if(timers.has(s.id)&&r?.ops?.some(op=>op?.op!=='return')&&state.delivered.bodyLength){
      // A preview can suggest a change, but only a decision based on the full delivery may mutate the graph.
      if(file.body.length>30000){
        recordNode(f,id,uiText('交付正文过长，保留当前计划'));return;
      }
      const delivered={...state.delivered,body:file.body};
      delete delivered.bodyLength;
      r=await requestPlanner(f.query,{state:{...state,delivered},timeout:observeTimeout},'observe',null,s);
    }
    // A workflow that finished or was stopped meanwhile takes no more changes.
    if(!active()||f.files[id]!==file)return;
    const ops=(r?.ops||[]).filter(o=>o&&typeof o==='object');
    if(!ops.length){recordNode(f,id,uiText('观察者：后续按原计划进行'));return}
    const repair=ops.find(o=>o.op==='return');
    if(repair&&applyObserverReturn(s,id,file,repair))return;
    const changes=ops.filter(o=>o.op!=='return').map(o=>o.op==='add'&&o.stage==='verify'&&!o.after?.length?{...o,after:[id]}:o);
    const res=applyLive(s,changes,{base,since,source:uiText('观察者')});
    for(const x of res.rejected)recordNode(f,id,x.why==='existing-verification'?uiText('沿用已有的下游验收节点'):
      uiText('观察者的一项调整未采纳 · ')+(x.op?.op||'')+' '+(x.op?.id||x.op?.name||'')+' · '+x.why);
  }).catch(err=>{if(active())recordNode(f,id,uiText('观察者未完成，按原计划继续 · ')+hostError(err))})
  .finally(()=>{for(const k of hold)if(f.holding?.[k]&&!--f.holding[k])delete f.holding[k];save(s);pump()});
  return true;
}
// Matches the sign-in message runtimes.cjs explain() returns, in either interface language.
const signedOut=message=>/尚未登录或登录已失效|is signed out or its session has expired/.test(message);
const hostError=err=>String(err?.message||err).replace(/^Error invoking remote method '[^']+': Error: /,'');
function pump(){
  for(const s of db.sessions){
    const f=s.flow;if(!timers.has(s.id))continue;
    // A failed node waits for the user; its siblings keep going and only its downstream waits with it.
    for(const id of runnable(f).filter(k=>!f.errors?.[k]&&!f.expanding?.[k]&&!f.holding?.[k])){
      const key=s.id+'/'+id;if(inflight.has(key))continue;
      // A cross-model review waits for a runtime other than its upstream's instead of falling back to it.
      const pool=candidates(f,id),checked=f.overrides[id]?.harness?'':reviewedBy(f,id),cross=checked?pool.filter(r=>r.name!==checked):[];
      const executor=(cross.length?cross:pool).find(r=>!busy(r.name));if(!executor)continue;
      const spec=nodeSpec(f,id),routeInfo=route(f,id,executor);
      f.dispatch[id]={...routeInfo,description:spec.description};
      if(s.scheduledPending){
        // Persist the first dispatch before invoking the runtime so reload can reattach by its job key.
        delete s.scheduledPending;
        save(s);
        if(!saveNow()){
          delete f.dispatch[id];s.scheduledPending=true;timers.delete(s.id);save(s);
          notify(uiText('工作区存储不可用，定时执行稍后重试'));break;
        }
      }
      delete (f.usage??={})[id];delete (f.errors??={})[id];delete (f.steps??={})[id];hostLeases.set(key,executor.name);inflight.set(key,{s,id,begin:Date.now(),base:f.time});
      recordNode(f,id,uiText('开始执行 · ')+executor.name+' / '+routeInfo.model);
      f.logs.unshift([f.time,uiText('启动{name}').replace('{name}',()=>spec.name),executor.name]);save(s);
      const parents=f.deps[id],groups=parents.map(p=>{
        const item=f.files[p],isText=item.delivery==='text'||item.delivery==='mixed'||!item.artifacts?.length;
        const gap=item.gaps?uiText('\n\n上游报告的缺口：')+item.gaps:'';
        return {title:item.title,text:isText?item.body+gap:'',summary:isText?'':(item.summary||item.body)+gap,ids:(item.artifacts||[]).map(a=>a.id)};
      });
      const sourceIds=(s.attachments||[]).map(a=>a.id);
      if(sourceIds.length || f.query!==spec.description){
        groups.unshift({title:uiText('用户原始材料'),text:f.query!==spec.description?uiText('用户原始材料（按本项任务使用）')+'\n'+f.query:'',ids:sourceIds});
      }
      if(f.extraInputs?.[id]?.length)groups.push({from:uiText('补充素材'),summary:'',ids:f.extraInputs[id].map(a=>a.id)});
      const fb=f.feedback?.[id],canReturn=!!spec.review&&parents.length===1&&(f.rounds?.[id]||0)<2;
      if(fb)recordNode(f,id,uiText('带修改意见执行 · ')+fb.note);
      const job=host.execute({key,kind:'node',directory:s.directory,projectName:s.name||f.query,workspace:f.workspace||null,runtime:executor.name,model:routeInfo.model,query:f.query,reviewed:spec.review&&parents.length===1?nodeSpec(f,parents[0]):null,node:{...spec,feedback:fb?.note||'',previous:fb?.previous||'',review:!!spec.review,canReturn},groups,needs:runNeeds(f,id),timeout:db.settings?.nodeTimeoutMinutes});
      follow(s,id,job);
    }
  }render();
}
// Every other project node of the workflow has delivered: the project is complete enough to run its acceptance check.
function projectSettled(f,id){return Object.keys(f.deps).every(k=>k===id||f.files[k]||Dag.delivery({...f.pack[k],...f.overrides[k]})!=='project')}
// After the last project node delivers, the workspace's check command runs in the project directory.
// A failure sends that node back once with the command output; a second failure is kept as a gap.
async function acceptance(s,id,key,spec,result){
  const f=s.flow,command=f.workspace?.check;
  if(result.delivery!=='project'||!command||!projectSettled(f,id))return true;
  recordNode(f,id,uiText('运行验收命令 · ')+command);save(s);
  const r=await host.check(key,command).catch(err=>({error:hostError(err)}));
  if(s.stopped||f.restarting?.[id])return false;
  if(!r?.ok)result.verificationPending=true;
  if(r?.skipped){result.gaps=[result.gaps,uiText('验收命令未运行 · 已拒绝')].filter(Boolean).join('；');recordNode(f,id,uiText('验收命令未运行 · 已拒绝'));return true}
  if(r?.error){result.gaps=[result.gaps,uiText('验收命令无法运行 · ')+r.error].filter(Boolean).join('；');recordNode(f,id,uiText('验收命令无法运行 · ')+r.error);return true}
  if(r?.ok){recordNode(f,id,uiText('验收通过 · ')+command);f.logs.unshift([f.time,uiText('项目验收通过'),command]);return true}
  const tail=String(r?.output||'').slice(-1500);
  if((f.checkRounds||0)<1){
    f.checkRounds=(f.checkRounds||0)+1;
    (f.feedback??={})[id]={note:uiText('验收命令「')+command+uiText('」没有通过（退出码 ')+r.code+uiText('）。请找到原因并修复，再运行这条命令确认通过；修复确实需要改动你负责路径以外的文件时可以改，并在交付说明里写明改了什么。\n命令输出末尾：\n')+tail,previous:String(result.body||'').slice(0,6000)};
    if(result.thread)(f.threads??={})[id]=result.thread;
    delete f.dispatch[id];recordNode(f,id,uiText('验收未通过，带着失败输出重做 · 退出码 ')+r.code);
    f.logs.unshift([f.time,uiText('项目验收未通过'),spec.name+uiText('将带着失败输出重做')]);
    return false;
  }
  result.gaps=[result.gaps,uiText('验收命令「')+command+uiText('」仍未通过（退出码 ')+r.code+uiText('）')].filter(Boolean).join('；');
  recordNode(f,id,uiText('验收仍未通过 · ')+tail.slice(-300));f.logs.unshift([f.time,uiText('项目验收未通过'),tail.slice(-200)]);
  return true;
}
// Settles one node execution: the promise comes from a new dispatch or, after the window reloaded, from a run still in progress.
function follow(s,id,promise){
  const f=s.flow,key=s.id+'/'+id,spec=nodeSpec(f,id),parents=f.deps[id],begin=Date.now(),previousTime=f.time;
  const children=Object.keys(f.deps).filter(k=>f.deps[k].includes(id)).map(k=>({id:k,role:f.pack[k].name,task:nodeSpec(f,k).description.slice(0,300),deliverable:f.pack[k].artifact}));
  // A run cancelled by a live change ends here without an error: the node was skipped or is dispatched again.
  const superseded=()=>!!(s.stopped||f.restarting?.[id]);
  promise.then(async result=>{
    if(superseded())return;
    f.time=Math.max(f.time,previousTime+Math.max(1,Math.round((Date.now()-begin)/1000)));
    // The task changed while this run was too far along to restart: run once more with the change as feedback.
    if(f.deferred?.[id]&&!result.blocked&&!result.rework){
      const why=f.deferred[id];delete f.deferred[id];
      (f.feedback??={})[id]={note:uiText('执行期间任务已调整：')+why+uiText('\n调整后的任务：')+f.pack[id].description,previous:String(result.body||'').slice(0,6000)};
      if(result.thread)(f.threads??={})[id]=result.thread;
      delete f.dispatch[id];recordNode(f,id,uiText('任务在执行中已调整，按新要求再执行一轮'));return;
    }
    if(result.rework){
      // A review node sent its single input back: that input reruns with the reason, then the review runs again.
      const parent=parents[0];(f.rounds??={})[id]=(f.rounds[id]||0)+1;delete f.dispatch[id];
      returnToNode(s,parent,result.rework,id);
      recordNode(f,id,uiText('退回第 ')+f.rounds[id]+uiText(' 轮 · ')+result.rework);recordNode(f,parent,uiText('被')+spec.name+uiText('退回 · ')+result.rework);
      f.logs.unshift([f.time,spec.name+uiText('退回了')+f.pack[parent].name,result.rework]);return;
    }
    if(result.blocked){
      recordNode(f,id,uiText('执行受阻 · ')+result.blocked);
      const fixed=await considerPatch(s,id,result.blocked,[{id,role:spec.name,task:spec.description}],true);
      if(fixed){delete f.dispatch[id];return}throw Error(result.blocked);
    }
    if(result.outside?.length){
      const list=result.outside.slice(0,8).join(uiText('、'))+(result.outside.length>8?uiText(' 等 ')+result.outside.length+uiText(' 个文件'):'');
      recordNode(f,id,uiText('改动了不归它负责的文件 · ')+list);f.logs.unshift([f.time,spec.name+uiText('越界修改'),list]);
    }
    // With live adjustment on, the observer weighs reported gaps after delivery instead of holding the delivery here.
    if(result.gaps){recordNode(f,id,uiText('交付缺口 · ')+result.gaps);if(!liveOn())await considerPatch(s,id,result.gaps,children,false)}
    if(superseded())return;
    if(spec.expand&&!spec.continueAfter&&!result.needsInput)await considerExpand(s,id,spec,result.body);
    if(superseded()||!await acceptance(s,id,key,spec,result)||superseded())return;
    const terminal=canContinueAfter(f,id)&&!result.needsInput;
    const autoContinue=spec.continueAfter!==false&&(spec.continueAfter===true||liveOn());
    const observation=terminal&&(spec.continueAfter===true||liveOn()&&Object.keys(f.deps).length>1)?
      await observeFinal(s,id,spec,result,{allowContinuation:autoContinue}):null;
    if(!superseded()&&observation?.rework&&!result.verificationPending&&applyObserverReturn(s,id,result,observation.rework,true,id))return;
    if(!superseded()&&autoContinue&&!result.verificationPending&&observation?.continuation){
      appendContinuation(f,id,result,observation.continuation);
    }
    if(superseded())return;
    if(f.feedback)delete f.feedback[id];
    if(result.thread)(f.threads??={})[id]=result.thread;
    f.files[id]={project:result.project||'',title:spec.artifact,body:result.body,summary:result.summary,gaps:result.gaps||'',...(result.needsInput?{needsInput:true}:{}),...(result.verificationPending?{verificationPending:true}:{}),...(observation?{observation}:{}),delivery:result.delivery,time:f.time,inputs:parents.map(p=>f.files[p].title),artifacts:result.artifacts};
    recordNode(f,id,(result.delivery==='text'?uiText('已交付正文'):result.delivery==='project'?uiText('已在项目目录中完成'):result.delivery==='mixed'?uiText('已交付正文与 ')+result.artifacts.length+uiText(' 个附件'):uiText('已登记 ')+result.artifacts.length+uiText(' 个文件'))+' · '+tidyNote(result.summary,result.artifacts||[]));
    f.logs.unshift([f.time,uiText('{name}已交付').replace('{name}',()=>spec.name),tidyNote(result.summary,result.artifacts||[])]);
    if(!result.needsInput)observe(s,id);
  }).catch(err=>{
    if(superseded())return;
    const message=hostError(err);
    const ran=f.dispatch[id]?.harness;
    if(ran&&signedOut(message))(runtimeInfo(ran)||{}).account={signedIn:false};
    (f.errors??={})[id]=message;delete f.dispatch[id];recordNode(f,id,uiText('执行中断 · ')+message);
    f.logs.unshift([f.time,spec.name+uiText('需要处理'),message]);
  }).finally(()=>{
    if(superseded()){
      if(f.restarting)delete f.restarting[id];
      if(!f.files[id]?.skipped)delete f.dispatch[id];
      if(s.stopped)recordNode(f,id,uiText('已停止运行'));
    }
    hostLeases.delete(key);inflight.delete(key);settleApprovals(key);s.updated=Date.now();
    for(const st of f.steps?.[id]||[])if(st.status==='running')st.status='failed';
    if(Dag.complete(f)){
      if(timers.has(s.id)&&Dag.usedContinuation(f))f.logs.unshift([f.time,uiText('本次续跑已结束'),'']);
      timers.delete(s.id);s.answerOpen=true;
    }
    if(timers.has(s.id)&&![...inflight.values()].some(v=>v.s===s)){
      const ready=runnable(f).filter(k=>!f.errors?.[k]);
      if(!ready.length&&Delivery.awaitingInput(f)){timers.delete(s.id);s.answerOpen=true}
      else if(!ready.length&&Object.keys(f.errors||{}).length){timers.delete(s.id);f.logs.unshift([f.time,Object.keys(f.files).length?uiText('其余工作已完成'):uiText('执行已暂停'),uiText('有节点需要处理：')+Object.keys(f.errors).map(k=>f.pack[k].name).join(uiText('、'))])}
      else if(!ready.some(k=>candidates(f,k).length)&&ready.length){timers.delete(s.id);f.logs.unshift([f.time,uiText('调度已暂停'),uiText('就绪节点缺少可用的运行时')])}
    }
    save();pump();
  });
}
// After the window reloads (or its renderer crashed), runs that are still going in the main process are picked up again;
// runs that finished meanwhile are settled from their kept result. Only runs the main process no longer knows are marked failed.
async function reattach(){
  let state={running:[],finished:{},approvals:[]};
  try{state=await host.jobs()}catch{}
  let changed=false;
  for(const key of state.running)if(key.includes('/@'))host.cancel(key).catch(()=>{});
  for(const s of db.sessions){
    const f=s.flow;
    // An observer verdict in flight when the window closed is not waited for again.
    if(f.holding)delete f.holding;
    if(f.expanding){delete f.expanding;changed=true}
    if(s.stopped){liveStop(s);continue}
    for(const id of new Set([...Object.keys(f.dispatch),...Object.keys(f.restarting||{})])){
      const obsolete=!!f.restarting?.[id];
      if(f.files[id]&&!obsolete)continue;
      const key=s.id+'/'+id;changed=true;
      if(state.running.includes(key)||Object.hasOwn(state.finished,key)){
        if(obsolete&&state.running.includes(key))host.cancel(key).catch(()=>{});
        hostLeases.set(key,f.dispatch[id]?.harness||f.pack[id].harness);inflight.set(key,{s,id,begin:Date.now(),base:f.time});if(!timers.has(s.id))timers.set(s.id,Symbol());
        recordNode(f,id,uiText('窗口重新载入，已接上这次执行'));follow(s,id,host.awaitJob(key));
      }else if(obsolete){delete f.restarting[id];delete f.dispatch[id];if(!Dag.complete(f)&&!timers.has(s.id))timers.set(s.id,Symbol())}
      else{delete f.dispatch[id];(f.errors??={})[id]=uiText('上次退出时执行未完成，请检查后继续');recordNode(f,id,f.errors[id])}
    }
  }
  for(const a of state.approvals||[])onHostEvent({key:a.key,approval:a.approval});
  if(changed){save();if(scanned)pump();else render()}
}
function stopNode(s,id){const key=s.id+'/'+id;if(host&&inflight.has(key))host.cancel(key).catch(e=>notify(e.message))}
function assetLinks(list){
  return (list||[]).map(a=>'<button class="asset-link" data-asset="'+esc(a.id)+'"><span>'+esc(a.name)+'</span><small>'+esc(a.path||a.type||'')+'</small></button>').join('');
}
function lookupAsset(id){return db.sessions.flatMap(s=>[...(s.attachments||[]),...Object.values(s.flow.extraInputs||{}).flat(),...Object.values(s.flow.files).flatMap(f=>f.artifacts||[])]).find(f=>f.id===id)}
async function previewAsset(id){
  try{
    const a=lookupAsset(id);const p=host?await host.preview(id):{type:a.type,url:await pictureURL(a)};
    const from=shownNode;if(from)finishInline();shownNode=null;
    const media=p.type==='markdown'?'<article class="md">'+p.html+'</article>':p.type==='text'?'<pre class="output">'+esc(p.text)+'</pre>':p.type.startsWith('image/')?'<img class="media-preview" src="'+esc(p.url)+uiText('" alt="图片产物">'):p.type.startsWith('video/')?'<video class="media-preview" controls preload="metadata" src="'+esc(p.url)+'"></video>':p.type.startsWith('audio/')?'<audio controls src="'+esc(p.url)+'"></audio>':uiText('<p>此格式可在 Finder 中查看。</p>');
    dialog(uiText('本地产物'),a?.name||uiText('文件预览'),media+'<p class="asset-path">'+esc(p.type.startsWith('image/')?'':a?.path||'')+'</p><div class="actions">'+(from?uiText('<button class="secondary" id="backToNode">返回节点</button>'):'')+(host?uiText('<button class="secondary" id="reveal">在 Finder 中显示</button>'):'')+'</div>');
    if(host)$('reveal').onclick=()=>host.reveal(id).catch(e=>notify(e.message));if(from)$('backToNode').onclick=()=>details(from);
  }catch(e){notify(e.message)}
}
document.addEventListener('click',e=>{const reveal=e.target.closest('[data-reveal]');if(reveal&&host){host.reveal(reveal.dataset.reveal).catch(err=>notify(err.message));return}const open=e.target.closest('#mbody [data-open]');if(open&&host){host.open(open.dataset.open).catch(err=>notify(err.message));return}const asset=e.target.closest('[data-asset]');if(asset){e.preventDefault();previewAsset(asset.dataset.asset)}});
// live.js loads after this file, so resolve the handler when an event arrives.
if(host)host.events(data=>onHostEvent(data));
