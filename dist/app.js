'use strict';
const $=id=>document.getElementById(id);
const esc=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=t=>String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
const uid=()=>crypto.randomUUID();
const key='relay-room.client.v1',timers=new Map(),closedGroups=new Set(),defaultSettings={languagePreference:'system',nodeTimeoutMinutes:0,parallel:4,autoStart:true,planner:'',approval:'auto',expand:'auto'};
let db,run,view='graph',inspected=null,shownNode=null,pausedForEdit=null,toastTimer,speed=1;
function session(){return db.sessions.find(s=>s.id===db.selected)}
function project(id){return db.projects.find(p=>p.id===id)}
function fresh(query,projectId,definition){
  const flow=newRun(query,definition);
  flow.logs.push([0,uiText('初始工作流已生成'),Object.keys(flow.deps).length+uiText(' 个 Agent 节点')]);
  return {id:uid(),project:projectId,...(projectId&&project(projectId)?.directory?{directory:project(projectId).directory}:{}),pinned:false,updated:Date.now(),flow};
}
const sampleName='示例 · 深夜电台开场';
function starter(){const s=fresh(examples[0],null);s.example=true;if(host)s.name=sampleName;return s}
function sampleSession(s){return s.example || (s.flow.family==='radio' && s.flow.query===examples[0] && s.name===sampleName)}
function sessionLabel(s){
  if(sampleSession(s) && (!s.name || s.name===sampleName))return uiText(s.name||examples[0]);
  return s.name||s.flow.query;
}
function restore(){
  let raw=null,lost='';
  try{raw=host?host.read():localStorage.getItem(key)}catch{lost=uiText('无法读取已保存的工作区')}
  if(raw?.storageError){lost=uiText('工作区文件无法读取')+(raw.backup?uiText('，原文件已另存为 ')+raw.backup.split(/[\\/]/).pop():'');raw=null}
  try{
    if(raw){
      const data=typeof raw==='string'?JSON.parse(raw):raw;
      data.connections={...initialConnections(false),...(data.connections||initialConnections(true))};
      const rawSettingsLimit=data.settings?.nodeTimeoutMinutes;
      data.library??=[];data.projects??=[];data.sessions??=[];data.settings={...defaultSettings,...data.settings,languagePreference:BercyI18n.languagePreference(data.settings)};
      // Older profiles stored 12 even when the user had never set a time limit.
      if(data.settings.timeout!=null && rawSettingsLimit===undefined){
        const minutes=Number(data.settings.timeout);
        if(Number.isInteger(minutes)&&minutes>=1&&minutes<=180&&minutes!==12)data.settings.nodeTimeoutMinutes=minutes;
      }
      delete data.settings.timeout;
      delete data.settings.language;
      for(const s of data.sessions){
        const flow=s.flow;
        flow.pack=flow.roles||planFor(flow.query).pack;
        // Unfinished runs are checked against the main process by reattach() once the window is up.
        flow.family??=flow.pack===radio?'radio':flow.pack===release?'release':'general';
      }
      if(host)for(const c of Object.values(data.connections))c.online=false;
      if(!data.sessions.some(s=>s.id===data.selected))data.selected=data.sessions[0]?.id??null;
      return data;
    }
  }catch{
    lost=uiText('无法读取已保存的工作区');
    // Browser storage has no file backup, so keep the unreadable copy beside the new workspace.
    if(!host&&typeof raw==='string')try{localStorage.setItem(key+'.corrupt',raw)}catch{}
  }
  if(lost)notify(lost+uiText('，已新建工作区'));
  const s=starter();
  return {selected:s.id,projects:[],library:[],sessions:[s],settings:{...defaultSettings},connections:host?Object.fromEntries(runtimes.map(r=>[r.name,{online:false,model:'运行时默认'}])):initialConnections()};
}
// Saves are coalesced and incremental: only workflows whose content changed since the last write are sent,
// so a busy run does not rewrite the whole workspace (each workflow is one SQLite row on the desktop).
// save(s) marks one workflow as changed (the hot path while nodes stream steps); save() rescans every workflow.
let saveTimer=null;const written=new Map();let writtenMeta='',dirtyAll=true;const dirty=new Set(),removed=new Set();
const keep=(k,v)=>k==='pack'?undefined:v;
function patch(){
  const all=dirtyAll,ids=new Set(dirty),upsert=[],live=new Set(db.sessions.map(s=>s.id));
  dirtyAll=false;dirty.clear();
  for(const s of db.sessions){if(!all&&!ids.has(s.id))continue;const json=JSON.stringify(s,keep);if(written.get(s.id)!==json)upsert.push({id:s.id,json})}
  const remove=all?[...new Set([...written.keys(),...removed])].filter(id=>!live.has(id)):[];
  const {sessions,...rest}=db,meta=all?JSON.stringify({...rest,sessionOrder:sessions.map(s=>s.id)},keep):writtenMeta;
  return {upsert,remove,meta:meta===writtenMeta?undefined:meta,
    commit(){for(const u of upsert)written.set(u.id,u.json);for(const id of remove){written.delete(id);removed.delete(id)}writtenMeta=meta},
    // A failed write is retried with the next save.
    retry(){if(all)dirtyAll=true;for(const id of ids)dirty.add(id)}};
}
function save(s){if(s?.id)dirty.add(s.id);else dirtyAll=true;clearTimeout(saveTimer);saveTimer=setTimeout(flushSave,400);return true}
async function flushSave(){
  clearTimeout(saveTimer);saveTimer=null;let p;
  try{
    if(!host){localStorage.setItem(key,JSON.stringify(db,keep));return}
    p=patch();if(!p.upsert.length&&!p.remove.length&&p.meta===undefined)return;
    await host.store({upsert:p.upsert,remove:p.remove,meta:p.meta});p.commit();
  }catch{p?.retry();notify(uiText('工作区存储不可用，本次更改仅在当前页面保留'))}
}
function saveNow(){
  if(!saveTimer)return true;clearTimeout(saveTimer);saveTimer=null;let p;
  try{
    if(!host){localStorage.setItem(key,JSON.stringify(db,keep));return true}
    p=patch();if(host.save({upsert:p.upsert,remove:p.remove,meta:p.meta})===true){p.commit();return true}p.retry();
  }catch{p?.retry()}
  return false;
}
addEventListener('pagehide',saveNow);addEventListener('beforeunload',saveNow);
function notify(text){$('notice').textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('notice').textContent='',3300)}
function activate(id){
  db.selected=id;run=session()?.flow;view='graph';inspected=null;shownNode=null;
  document.querySelector('.shell').classList.remove('mobileopen');save();render();
}
function create(query,projectId,definition,source,name,attachments=[],reason){
  const s=fresh(query,projectId,definition);
  s.attachments=attachments;
  if(reason){s.flow.logs[0][1]=reason;s.flow.versions[0].reason=reason}
  if(source)s.source={...source};
  if(name)s.name=name;
  if(definition&&!reason)s.flow.versions[0].reason=uiText('沿用已选流程的节点、依赖和配置。');
  db.sessions.unshift(s);closedGroups.delete(projectId);$('search').value='';activate(s.id);
  // New tasks start right away; a missing runtime opens the settings with the reason instead.
  if(db.settings?.autoStart!==false)start(s);
}
// A two-step button: the first click arms it, the second within a few seconds confirms.
function confirmClick(btn,label,action){
  btn.onclick=()=>{
    if(btn.dataset.armed){action();return}
    btn.dataset.armed='1';const original=btn.textContent;btn.textContent=label;
    setTimeout(()=>{if(btn.isConnected){delete btn.dataset.armed;btn.textContent=original}},4000);
  };
}
function sessionAssets(s){return [...(s.attachments||[]),...Object.values(s.flow.extraInputs||{}).flat(),...(s.schedule?.attachments||[]),...Object.values(s.schedule?.extraInputs||{}).flat(),...Object.values(s.flow.files).flatMap(f=>f.artifacts||[])].map(a=>a.id)}
function deleteSession(s){
  if(host){
    s.stopped=true;
    host.cancelWorkflow(s.id).catch(err=>notify(hostError(err)));
  }
  // Local files go with the workflow unless another workflow still uses them.
  const shared=new Set(db.sessions.filter(x=>x!==s).flatMap(sessionAssets)),own=[...new Set(sessionAssets(s))].filter(id=>!shared.has(id));
  if(host&&own.length)host.forget(own).catch(()=>{});
  if(host)timers.delete(s.id);else stop(s.id);
  const wasSelected=s.id===db.selected;
  db.sessions=db.sessions.filter(x=>x!==s);
  removed.add(s.id);
  if($('modal').open)dismiss();
  // Deleting another workflow from the sidebar keeps the one on screen.
  if(wasSelected||!session()){
    const next=db.sessions.slice().sort((a,b)=>b.updated-a.updated)[0];
    activate(next?.id??null);
  }else{save();render()}
  saveNow();
  notify(uiText('工作流已删除'));
}
function stop(id){if(host){timers.delete(id);return}clearInterval(timers.get(id));timers.delete(id);const s=db.sessions.find(s=>s.id===id);if(s)releaseSlots(s.flow)}
function start(s){
  if(host){liveStart(s);return}
  if(timers.has(s.id)||Dag.complete(s.flow))return;
  if(!canProceed(s.flow)){showSettings();notify(uiText('连接可用运行时，或修改节点上手动指定的运行时'));return}
  s.flow.started=true;
  const tick=()=>{if(!canProceed(s.flow)){stop(s.id);render();return}advance(s.flow);s.updated=Date.now();if(Dag.complete(s.flow)){stop(s.id);s.answerOpen=true}save();render()};
  timers.set(s.id,setInterval(tick,950/speed));save();render();
}
function play(){
  const s=session();inspected=null;
  const missing=Delivery.awaitingInput(run);
  if(missing&&!timers.has(s.id)){details(missing);return}
  if(Dag.complete(run)){create(run.query,s.project,definitionOf(run,run.deps),s.source,s.name,s.attachments);start(session());return}
  if(timers.has(s.id)){
    if(host){liveStop(s);return}
    delete s.scheduledPending;stop(s.id);save();render();
  }else start(s);
}
function canProceed(flow){return runnable(flow).some(k=>flow.dispatch[k]||candidates(flow,k).length)}
function step(){stop(session().id);inspected=null;const count=run.logs.length;
  if(!canProceed(run)){showSettings();return}
  do{if(!advance(run))break}while(!Dag.complete(run)&&run.logs.length===count);
  if(Dag.complete(run))session().answerOpen=true;releaseSlots(run);session().updated=Date.now();save();render();
}
function snapshot(){return run.versions[inspected??run.versions.length-1].deps}
function phase(k,deps){
  if(inspected!==null)return uiText('计划快照');
  if(run.files[k]?.skipped)return uiText('已跳过');
  if(run.files[k])return uiText(Delivery.pendingLabel(run,k)||'✓ 已交付');
  if(host&&session().stopped&&inflight.has(session().id+'/'+k))return uiText('正在停止…');
  if(host&&inflight.has(session().id+'/'+k))return livePhase(session(),k)||uiText('执行中');
  if(run.errors?.[k])return uiText('需要处理');
  if(run.expanding?.[k])return uiText('正在展开');
  if(run.dispatch[k])return timers.has(session().id)?uiText('执行中'):uiText('执行已暂停');
  if(runnable(run).includes(k)){
    const choices=candidates(run,k);
    if(!choices.length)return uiText('等待可用连接');
    return choices.every(r=>busy(r.name))?uiText('等待执行槽'):uiText('待启动');
  }
  return deps[k].length>1?uiText('汇合 ')+deps[k].filter(i=>run.files[i]).length+' / '+deps[k].length:uiText('等待上游');
}
function nodeTitle(k){return k==='merge'&&run.mono?uiText('纯旁白定稿'):displayRole(run,k).artifact}
function sessionRow(s){
  const state=Dag.complete(s.flow)?(Delivery.finalLabel(s.flow)==='已交付'?'done':'attention'):timers.has(s.id)?'active':'';
  return '<div class="session-row" aria-current="'+(s.id===db.selected)+'"><button class="session" data-session="'+s.id+'" aria-current="'+(s.id===db.selected)+'" title="'+esc(sessionLabel(s))+'"><i class="mark '+state+'"></i><span>'+esc(sessionLabel(s))+'</span></button>'+
    '<button class="session-more" data-row-menu="'+s.id+uiText('" aria-label="更多操作：')+esc(sessionLabel(s))+uiText('" aria-haspopup="menu" title="更多操作">···</button></div>');
}
function sidebar(){
  const q=$('search').value.trim().toLowerCase();
  const sessions=db.sessions.filter(s=>(sessionLabel(s)+' '+s.flow.query).toLowerCase().includes(q)).sort((a,b)=>b.updated-a.updated);
  const pinned=sessions.filter(s=>s.pinned);
  $('pins').innerHTML=pinned.length?pinned.map(sessionRow).join(''):'<div class="empty">'+(q?uiText('无匹配的置顶工作流'):uiText('暂无置顶工作流'))+'</div>';
  const solo=sessions.filter(s=>!s.project);
  $('standalone').innerHTML=solo.length?solo.map(sessionRow).join(''):'<div class="empty">'+(q?uiText('没有匹配的工作流'):uiText('暂无独立工作流'))+'</div>';
  $('projects').innerHTML=db.projects.map(p=>{
    const group=sessions.filter(s=>s.project===p.id),open=q||!closedGroups.has(p.id);
    return '<div class="projecthead"><button data-group="'+p.id+'" aria-expanded="'+Boolean(open)+'"><i class="folder">'+(open?'▾':'▸')+'</i>'+esc(p.name)+'</button><button data-new-in="'+p.id+'" title="'+uiText('在项目中新建任务')+'" aria-label="'+uiText('在项目中新建任务')+'">＋</button><button data-manage="'+p.id+uiText('" aria-label="管理项目 ')+esc(p.name)+'">···</button></div>'+
    (open?(group.length?group.map(sessionRow).join(''):'<div class="empty">'+(q?uiText('没有匹配的工作流'):uiText('暂无工作流'))+'</div>'):'');
  }).join('');
}
// The status bar shows one line: delivery summaries lose their Markdown markers there.
function plainLine(text){return String(text).replace(/^[\s|:-]*$/gm,'').replace(/^\s*(?:#{1,6}|[-*+]|\d+\.|>)\s+/gm,'').replace(/[*`]+/g,'').replace(/\|+/g,' ').replace(/\s+/g,' ').trim()}
// Old workspace files store the initial system event as a formatted line.
function activityLine(entry){
  const [time,title,detail]=entry;
  const count=/^(\d+)\s*(?:个 Agent 节点|agent nodes?)$/i.exec(detail);
  if(time===0 && count && ['初始工作流已生成','Initial workflow generated'].includes(title)){
    return [time,uiText('初始工作流已生成'),count[1]+uiText(' 个 Agent 节点')];
  }
  return entry;
}
function render(){
  sidebar();const s=session();
  const settings=view==='settings',library=view==='library',outside=settings||library||!s;
  $('workspaceEmpty').hidden=settings||library||!!s;
  $('emptyTitle').textContent=uiText('暂无工作流');
  $('workspace').hidden=outside;$('library').hidden=!library;$('libraryNav').setAttribute('aria-current',String(library));
  $('savedCount').textContent=db.library.length;$('saveFlow').hidden=outside;
  $('saveFlow').textContent=uiText('保存流程');
  $('scheduleFlow').hidden=outside||!host;
  $('scheduleFlow').textContent=uiText(s?.schedule?'编辑定时':'定时执行');
  $('preferences').hidden=!settings;document.querySelector('.taskhead').hidden=outside;
  $('pin').hidden=outside;$('more').hidden=outside;$('settings').setAttribute('aria-current',String(settings));
  $('pageType').textContent=settings?uiText('设置'):uiText('工作流');
  if(outside)pauseAnswerMedia();
  if(library){$('crumb').textContent=uiText('工作区');$('pageType').textContent=uiText('已保存');
    $('stage').hidden=true;$('listview').hidden=true;$('lastlog').textContent=host?uiText('保存在此 Mac'):uiText('保存在当前浏览器');$('stat').textContent='';renderLibrary();return}
  if(settings){$('crumb').textContent=uiText('工作区');$('stage').hidden=true;$('listview').hidden=true;
    $('lastlog').textContent=host?uiText('本地工作区'):uiText('本地模拟工作区');$('stat').textContent='';renderSettings();return}
  if(!s){
    $('crumb').textContent=uiText('工作区');$('lastlog').textContent='';$('stat').textContent='';return;
  }
  const live=timers.has(s.id),done=Dag.complete(run),deps=snapshot(),files=Object.entries(run.files),v=inspected??run.versions.length-1;
  $('crumb').textContent=project(s.project)?.name||uiText('工作区');$('pin').textContent=s.pinned?uiText('取消置顶'):uiText('置顶','action');$('pin').setAttribute('aria-pressed',String(s.pinned));
  $('query').textContent=sessionLabel(s);$('query').title=sessionLabel(s);
  const template=db.library.find(t=>t.id===s.source?.id);
  const brief=[template?uiText('来自「')+template.name+uiText('」 v')+s.source.version:'',s.name&&s.name!==run.query?uiText('本次任务 · ')+(sampleSession(s)?uiText(examples[0]):run.query):''].filter(Boolean).join('　');
  $('briefline').textContent=brief;$('briefline').hidden=!brief;
  const stopping=host&&workflowStopping(s);
  $('continueFlow').hidden=!host||!done||!completedOutput(run);
  $('continueFlow').textContent=uiText('继续执行');
  $('status').textContent=inspected!==null?uiText('计划快照'):done?uiText(Delivery.finalLabel(run)):live?uiText('运行中'):stopping?uiText('正在停止…'):s.stopped?uiText('已停止运行'):Delivery.awaitingInput(run)?uiText('待补件'):Object.keys(run.errors||{}).length?uiText('需要处理'):run.started?uiText('已暂停'):s.scheduledPending?uiText('等待可用连接'):uiText('计划就绪');
  $('count').textContent=files.length;$('play').disabled=!!stopping;$('play').textContent=stopping?uiText('正在停止…'):!live&&Delivery.awaitingInput(run)?uiText('补充材料'):done?uiText('↻ 再跑一轮'):live?(host?uiText('停止运行'):uiText('Ⅱ 暂停')):run.started?uiText('▶ 继续运行'):uiText('▶ 运行工作流');
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.view===view)));
  $('stage').hidden=view!=='graph';$('listview').hidden=view==='graph';$('version').innerHTML=run.versions.map((_,i)=>'<option value="'+i+'" '+(i===v?'selected':'')+'>v'+(i+1)+(i===run.versions.length-1?uiText(' · 当前计划'):i===0?uiText(' · 初始计划'):uiText(' · 历史计划'))+'</option>').join('');
  $('version').title=run.versions[v].reason;$('seq').textContent=stamp(run.time);$('step').disabled=done;$('rate').textContent=speed+'×';$('demoTools').hidden=!!host;$('inject').disabled=run.family==='custom'||inspected!==null||!run.deps.b||!!run.deps.review||!!run.files.b||run.clear;
  $('lastlog').textContent=inspected!==null?run.versions[v].reason:activityLine(run.logs[0]).slice(1).map(plainLine).join(' · ');$('stat').textContent=Object.keys(deps).length+uiText(' 个节点');
  renderAnswerDock(s,done);renderApprovals();$('approvalChip').hidden=!host;
  if(view==='graph')graph();else{
    $('listtitle').textContent=view==='log'?uiText('执行记录'):uiText('产物架');
    $('rows').innerHTML=view==='log'?run.logs.map(activityLine).map(([t,a,b])=>'<div class="log"><time>'+stamp(t)+'</time><div><b>'+esc(String(a).replace(/([\u4e00-\u9fff])(?=[A-Za-z0-9])/g,'$1 '))+'</b><p>'+esc(plainLine(String(b??'').replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm,'')))+'</p></div></div>').join(''):
      files.length?files.reverse().map(([k,f])=>'<section class="file-group"><button class="log file" data-file="'+k+'"><time>'+stamp(f.time)+'</time><div><b>'+esc(f.title)+'</b><p>'+esc(displayRole(run,k).name)+' · '+(f.delivery==='file'?uiText('文件交付'):f.delivery==='project'?uiText('项目目录'):f.delivery==='mixed'?uiText('正文和附件'):uiText('查看交付'))+'</p></div></button>'+assetLinks(f.artifacts)+'</section>').join(''):uiText('<p class="empty">节点完成后，正文和文件都会出现在这里。</p>');
  }
  if(shownNode&&$('modal').open)nodeBody(shownNode,true);
}
function dialog(type,title,body){
  $('modal').classList.remove('node-dialog');$('dtype').textContent=type;$('mtitle').textContent=title;$('mtitle').title=title;$('mbody').innerHTML=body;$('mbody').scrollTop=0;
  if(!$('modal').open)$('modal').showModal();
}
function dismiss(){
  const job=$('mbody').querySelector('[data-planner-job]')?.dataset.plannerJob;if(host&&job)host.cancel(job);
  if(shownNode)finishInline();
  $('modal').close();shownNode=null;render();
  if(pausedForEdit){const s=db.sessions.find(x=>x.id===pausedForEdit);pausedForEdit=null;if(s)start(s)}
}
function editable(k){return inspected===null&&!run.dispatch[k]&&!run.files[k]}
let editBaseline=null;
// The node panel follows the node's state: before it runs you edit the brief; while it runs you watch the process;
// once delivered you mainly read the result, with the process, the prompt and the log one tab away.
let nodeTab=null,deliverableOnly=false;
function details(k,opts={}){editBaseline=null;nodeDisclosures.clear();shownNode=k;nodeTab=null;deliverableOnly=!!opts.deliverable&&!!run.files[k];dialog(deliverableOnly?uiText('交付产物'):uiText('Agent 节点'),displayRole(run,k).name,'');$('modal').classList.add('node-dialog');nodeBody(k,false)}
function nodeBody(k,preserve){
  const holder=$('mbody'),focusId=holder.contains(document.activeElement)?document.activeElement.id:null;
  const deps=snapshot()[k]??[],snap=inspected!==null,spec=nodeSpec(run,k),f=snap?null:run.files[k],logs=snap?[]:(run.events[k]??[]);
  const running=host&&inflight.has(session().id+'/'+k),started=!snap&&!editable(k);
  const tabs=started?[...(f?[['result',uiText('交付产物')]]:[]),['process',uiText('执行过程')],['prompt',uiText('提示词')],['log',uiText('记录 ')+logs.length]]:[];
  const tab=tabs.some(t=>t[0]===nodeTab)?nodeTab:f?'result':'process';
  const signature=JSON.stringify([k,spec,deps,run.extraInputs?.[k]?.length,phase(k,snapshot()).replace(/^(启动中|等待审批|Starting|Awaiting approval)$/,uiText('执行中')),deps.map(id=>!!run.files[id]),f?.time,tab==='log'?logs.length:0,tabs.length,!!run.prompts?.[k],run.usage?.[k],editable(k),tab,deliverableOnly,run.expanding?.[k],f?.observation?.summary,run.errors?.[k]]);
  if(preserve&&(holder.dataset.signature===signature||(editBaseline&&editable(k))))return;
  const disclosureFocus=rememberNodeDisclosures(holder),steerField=$('steerText');
  const steerDraft=steerField&&{value:steerField.value,start:steerField.selectionStart,end:steerField.selectionEnd};
  holder.dataset.signature=signature;
  if(deliverableOnly&&f){
    $('dtype').textContent=uiText('交付产物 · ')+displayRole(run,k).name;
    holder.innerHTML=f.skipped?uiText('<div class="route-note">已跳过 · ')+esc(f.reason||'')+'</div>':deliveredPanel(k,f)+(f.gaps?uiText('<div class="route-note gap-note">交付缺口 · ')+esc(f.gaps)+'</div>':'')+uiText('<button type="button" class="link-button node-more" id="showNodeDetail">查看执行过程与提示词 ›</button>');
    $('showNodeDetail').onclick=()=>{deliverableOnly=false;nodeTab='process';$('dtype').textContent=uiText('Agent 节点');nodeBody(k,false)};
    materializeFiles(holder);return;
  }
  $('dtype').textContent=uiText('Agent 节点 · ')+phase(k,snapshot());
  const {runners,models}=nodeChoices(k),pin=run.overrides[k]||{},capabilities=capText(nodeNeeds(run,k));
  const fields=editable(k)?
    uiText('<label class="field" for="description">任务简述</label><textarea id="description" class="inlinebrief" maxlength="1600" required>')+esc(spec.description)+'</textarea>'+
    '<div class="node-picks">'+choiceField('runtime',uiText('运行时'),runners,pin.harness||'')+modelListField('model',uiText('模型'),models,pin.model||'')+'</div>'+
    uiText('<label class="output-choice">交付形式<select class="select" id="deliveryKind">')+outputModeField(Dag.delivery(spec))+'</select></label>'+
    needsField(spec,'data-need')+(deps.length===1?'<label class="review-pick"><input type="checkbox" id="reviewNode" '+(spec.review?'checked':'')+uiText('>审查节点：由另一个运行时交叉审查，不合格时退回上游修改（最多两轮）</label>'):''):
    '<div class="node-summary"><div class="node-meta"><span class="chip">'+esc(spec.harness)+' · '+esc(modelLabel(spec.model))+'</span>'+
    (capabilities?'<span class="node-capabilities">'+esc(capabilities)+'</span>':'')+
    (running?uiText('<button type="button" class="secondary danger" id="stopNode">停止执行</button>'):'')+
    '</div><details class="node-brief" data-node-disclosure="brief"><summary>'+
    '<strong>'+uiText('任务简述')+'</strong><span class="brief-preview">'+esc(spec.description)+'</span></summary>'+
    '<p>'+esc(spec.description)+'</p></details></div>';
  const canRunNext=canContinueAfter(run,k);
  const continueToggle=editable(k)&&canRunNext?
    '<label class="review-pick"><input type="checkbox" id="continueAfter" '+(spec.continueAfter!==false?'checked':'')+'>'+uiText('按任务目标自动续跑')+'</label>':'';
  const notes=(editable(k)&&spec.reason?'<div class="route-note">'+esc(spec.reason)+'</div>':'')+
    (run.errors?.[k]?uiText('<div class="route-note error-note">需要处理 · ')+esc(run.errors[k])+'</div>':'')+
    (f?.gaps?uiText('<div class="route-note gap-note">交付缺口 · ')+esc(f.gaps)+'</div>':'');
  const usage=host&&run.usage?.[k]?uiText('<p class="usage">本次执行用量 · ')+Object.entries({input:uiText('输入'),cached:uiText('缓存读取'),output:uiText('输出')}).filter(([key])=>Number.isFinite(run.usage[k][key])).map(([key,label])=>label+' '+run.usage[k][key].toLocaleString(BercyI18n.language)).join(' · ')+' tokens</p>':'';
  const logList='<div class="node-log">'+(logs.length?logs.map(([t,text])=>'<div class="event"><time>'+stamp(t)+'</time><span>'+esc(text)+'</span></div>').join(''):uiText('<p class="empty">节点尚未开始执行</p>'))+'</div>';
  let body;
  if(!started)body=sentPanel(k,deps,snap,spec);
  else body='<nav class="node-tabs" role="tablist">'+tabs.map(([id,t])=>'<button role="tab" data-node-tab="'+id+'" aria-selected="'+(id===tab)+'">'+t+'</button>').join('')+'</nav>'+
    '<div class="node-tab">'+(tab==='result'?deliveredPanel(k,f):tab==='process'?liveSection(k)+usage:tab==='prompt'?sentPanel(k,deps,snap,spec):logList)+'</div>';
  holder.innerHTML=fields+continueToggle+notes+(running?'<div id="liveApprovals" class="live-approvals"></div>':'')+body;
  restoreNodeDisclosures(holder,disclosureFocus);
  if(steerDraft&&$('steerText')){
    $('steerText').value=steerDraft.value;
    $('steerText').setSelectionRange(steerDraft.start,steerDraft.end);
  }
  for(const b of holder.querySelectorAll('[data-node-tab]'))b.onclick=()=>{nodeTab=b.dataset.nodeTab;nodeBody(k,false)};
  if(f?.observation?.summary&&tab==='result'){
    holder.querySelector('.delivered-panel')?.insertAdjacentHTML('beforeend',
      '<div class="route-note">'+uiText('观察者 · ')+esc(f.observation.summary)+'</div>');
  }
  if(host&&f&&tab==='result'&&!snap&&Dag.complete(run)&&Dag.outputs(run.deps).includes(k)&&!f.needsInput&&!f.skipped){
    const working=!!run.expanding?.[k];
    holder.querySelector('.delivered-panel')?.insertAdjacentHTML('beforeend',
      '<div class="actions"><button class="secondary" id="continueDelivery" '+(working?'disabled':'')+'>'+
      uiText(working?'正在规划下一步…':'继续执行')+'</button></div>');
    if($('continueDelivery'))$('continueDelivery').onclick=()=>continueDialog(session(),k);
  }
  if(host&&f&&tab==='result'&&!snap){
    const busy=[k,...Dag.descendants(run.deps,k)].some(id=>inflight.has(session().id+'/'+id));
    holder.querySelector('.delivered-panel')?.insertAdjacentHTML('beforeend',uiText('<div class="redo-box"><textarea id="redoNote" rows="2" maxlength="1200" placeholder="修改意见（可选）：哪里需要改、怎么改"></textarea><div class="redo-actions"><button type="button" class="secondary" id="editBody"')+(busy?' disabled':'')+uiText('>编辑正文</button><button type="button" class="secondary" id="redoNode"')+(busy?' disabled':'')+'>'+(Dag.descendants(run.deps,k).length?uiText('重做此节点及下游'):uiText('重做此节点'))+'</button></div></div>');
    if(f.needsInput&&!busy){
      const section=holder.querySelector('.redo-box');
      if(section){
        section.insertAdjacentHTML('afterbegin',attachmentField());
        bindAttachments(section,session().attachments??=[],()=>save());
      }
    }
  }
  materializeFiles(holder);
  bindLive(k);
  if($('redoNode'))$('redoNode').onclick=()=>redoNode(k,$('redoNote').value.trim());
  if($('editBody'))$('editBody').onclick=()=>editBody(k);
  if($('stopNode'))$('stopNode').onclick=()=>{$('stopNode').disabled=true;$('stopNode').textContent=uiText('正在停止…');stopNode(session(),k)};
  if($('copyPrompt'))$('copyPrompt').onclick=()=>navigator.clipboard.writeText(run.prompts[k]).then(()=>notify(uiText('已复制原始提示词'))).catch(()=>notify(uiText('请选择提示词复制')));
  if($('continueAfter'))$('continueAfter').onchange=e=>{
    if(!editable(k))return;
    (run.overrides[k]??={}).continueAfter=e.target.checked;
    save(session());
  };
  if($('deliveryKind'))$('deliveryKind').onchange=e=>{(run.overrides[k]??={}).delivery=e.target.value;save();recordNode(run,k,uiText('调整交付形式'));nodeBody(k,false)};
  if(editable(k))bindAttachments(holder,((run.extraInputs??={})[k]??=[]),()=>{save();if($('savedState'))$('savedState').textContent=uiText('素材已保存')},()=>{if(timers.has(session().id)){pausedForEdit=session().id;stop(pausedForEdit)}});
  if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
  if(editable(k)){
    const begin=()=>{
      if(!editable(k))return;
      editBaseline??={...nodeSpec(run,k)};
      if(timers.has(session().id)){pausedForEdit=session().id;stop(pausedForEdit);$('savedState').textContent=uiText('关闭后继续运行');render()}
    };
    const update=()=>{
      begin();
      if(!editable(k))return;
      const description=$('description').value.trim();
      if(!description){$('savedState').textContent=uiText('请输入任务简述');return}
      run.overrides[k]={...run.overrides[k],description};
      session().updated=Date.now();save();$('savedState').textContent=pausedForEdit?uiText('已自动保存 · 关闭后继续运行'):uiText('已自动保存');
    };
    function select(which,value){
      begin();
      const pin=run.overrides[k]??={};
      if(which==='runtime'){
        if(value)pin.harness=value;else delete pin.harness;
        delete pin.model;
      }else if(value){
        pin.harness=spec.harness;pin.model=value;
      }else delete pin.model;
      session().updated=Date.now();save();finishInline();nodeBody(k,false);
      $('savedState').textContent=uiText('已自动保存');$(which).focus();
    }
    bindChoicePicker('runtime',runners,begin,v=>select('runtime',v));
    bindModelList('model',models,pin.model||'',begin,v=>select('model',v));
    for(const box of holder.querySelectorAll('[data-need],[data-need-online]'))box.onchange=()=>{
      begin();if(!editable(k))return;
      const o=run.overrides[k]??={},online=holder.querySelector('[data-need-online]').checked;
      o.offline=!online;o.needs=[...(holder.querySelector('[data-need]').checked?['shell']:[]),...(online?Dag.cleanNeeds(spec.needs).filter(c=>c==='network'):[])];
      session().updated=Date.now();save();recordNode(run,k,uiText('调整能力 · ')+(o.needs.includes('shell')?uiText('需要执行命令 · '):'')+(online?uiText('允许联网'):uiText('不联网')));nodeBody(k,false);
    };
    if($('reviewNode'))$('reviewNode').onchange=e=>{begin();(run.overrides[k]??={}).review=e.target.checked;save();recordNode(run,k,e.target.checked?uiText('设为审查节点'):uiText('取消审查节点'))};
    $('description').onfocus=begin;$('description').oninput=update;$('description').onchange=finishInline;
  }
}
function completedOutput(flow){
  return Dag.outputs(flow.deps).find(k=>flow.files[k]&&!flow.files[k].needsInput&&!flow.files[k].skipped);
}
$('continueFlow').onclick=()=>{if(run&&Dag.complete(run)){const id=completedOutput(run);if(id)continueDialog(session(),id)}};
function continueDialog(s,id){
  shownNode=null;
  dialog(uiText('工作流'),uiText('继续执行'),
    uiText('<form id="continueForm"><label class="field" for="continuationBrief">接下来做什么？</label><textarea id="continuationBrief" maxlength="4000" placeholder="留空则检查本次验收还有哪些可执行的余项"></textarea><div class="actions"><button class="primary">继续执行</button></div></form>'));
  const form=$('continueForm');
  $('continuationBrief').focus();
  form.onsubmit=async event=>{
    event.preventDefault();
    const end=setBusy(form,uiText('正在规划下一步…'));
    try{
      const added=await continueFromDelivery(s,id,$('continuationBrief').value.trim(),form);
      if(form.isConnected){if(added)dismiss();else end(uiText('没有可自动执行的下一步'))}
    }catch(err){end(err)}
  };
}
function redoNode(k,note){
  if(run.files[k]?.needsInput)note=[uiText('按本次补充的材料完成原始请求中本项交付。'),note].filter(Boolean).join('\n');
  const s=session(),ids=invalidate(run,k,note||uiText('按原任务重新完成，给出与上一版不同、更好的结果。'),id=>inflight.has(s.id+'/'+id));
  if(!ids){notify(uiText('相关节点正在执行，完成后再重做'));return}
  for(const id of ids)if(run.rounds)delete run.rounds[id];
  recordNode(run,k,uiText('请求重做')+(note?' · '+note:''));run.logs.unshift([run.time,uiText('重做')+displayRole(run,k).name,(ids.length>1?uiText('连同 ')+(ids.length-1)+uiText(' 个下游节点 · '):'')+(note||uiText('无额外意见'))]);
  s.answerOpen=false;s.updated=Date.now();save();start(s);details(k);
}
// Hand-edited deliveries replace the body; downstream nodes that used the old text run again.
function editBody(k){
  const f=run.files[k];
  dialog(uiText('编辑交付'),displayRole(run,k).name+' · '+f.title,'<form id="bodyForm"><textarea id="bodyText" class="fieldinput body-edit" rows="16">'+esc(f.body)+uiText('</textarea><p class="muted">保存后，已使用旧内容的下游节点会重新执行。</p><div class="actions"><button type="button" class="secondary" id="bodyBack">取消</button><button class="primary">保存正文</button></div></form>'));
  $('bodyBack').onclick=()=>details(k);
  $('bodyForm').onsubmit=e=>{
    e.preventDefault();const s=session(),text=$('bodyText').value.trim();if(!text)return $('bodyText').focus();
    const below=Dag.descendants(run.deps,k);
    if(below.some(id=>inflight.has(s.id+'/'+id))){notify(uiText('下游节点正在执行，完成后再修改'));return}
    const stale=below.filter(id=>run.files[id]);for(const id of below){delete run.files[id];delete run.dispatch[id];if(run.rounds)delete run.rounds[id]}
    f.body=text;f.summary=text.slice(0,400);f.edited=true;f.editedAt=Date.now();recordNode(run,k,uiText('正文已手动修改'));
    run.logs.unshift([run.time,uiText('手动修改')+displayRole(run,k).name+uiText('的交付'),stale.length?stale.length+uiText(' 个下游节点将重新执行'):uiText('无下游需要重跑')]);
    s.updated=Date.now();save();if(stale.length)start(s);details(k);
  };
}
function finishInline(){
  if(!editBaseline||!shownNode)return;
  const current=nodeSpec(run,shownNode);
  if(current.description!==editBaseline.description||current.harness!==editBaseline.harness||current.model!==editBaseline.model){
    recordNode(run,shownNode,uiText('更新节点配置 · ')+current.harness+' / '+current.model);
    run.logs.unshift([run.time,uiText('更新')+current.name+uiText('的节点配置'),current.harness+' · '+current.description]);save();
  }
  if($('description')&&!$('description').value.trim())$('description').value=current.description;
  editBaseline=null;
}
function opts(selected){return '<option value="" '+(!selected?'selected':'')+uiText('>不加入项目</option>')+db.projects.map(p=>'<option value="'+p.id+'" '+(selected===p.id?'selected':'')+'>'+esc(p.name)+'</option>').join('')}
function newTask(initial='',projectId=null){
  dialog(uiText('工作区'),uiText('新建任务'),
    uiText('<div class="build-tabs"><button class="selected" type="button">自动规划</button><button type="button" id="manualBuild">手动搭建</button></div>')+
    '<form id="newForm"><div class="new-task-fields">'+
    uiText('<label class="field" for="input">任务描述</label><textarea id="input" required maxlength="4000" placeholder="描述希望交付的结果">')+
    esc(initial)+'</textarea>'+attachmentField()+
    uiText('<label class="field" for="project">项目（可选）</label><select id="project" class="select">')+opts(projectId)+'</select>'+
    uiText('<fieldset class="plan-mode"><legend>分工方式</legend><label><input type="radio" name="planMode" value="team" ')+
    (db.settings.planMode!=='solo'?'checked':'')+uiText('>多 Agent 分工</label><label><input type="radio" name="planMode" value="solo" ')+
    (db.settings.planMode==='solo'?'checked':'')+uiText('>单个 Agent</label><small id="planHint"></small></fieldset>')+
    '<div id="similarFlow" class="similar-flow" hidden></div></div>'+
    uiText('<div class="actions"><button class="primary">生成工作流</button></div></form>'));
  let attachments=[];
  bindAttachments($('newForm'),attachments);
  $('manualBuild').onclick=()=>buildManually($('input').value,$('project').value||null,null,attachments);
  const mode=()=>$('newForm').elements.planMode.value,solo=()=>mode()==='solo';
  const hint=()=>{
    const q=$('input').value.trim();
    $('planHint').textContent=mode()==='solo'?uiText('由一个 Agent 直接完成，不调用规划模型。'):uiText('由规划模型按「规划指南」拆分节点，简单任务也可能只生成一个节点。');
    const match=q&&mode()!=='solo'?similarFlow(q):null;$('similarFlow').hidden=!match;
    if(match){$('similarFlow').innerHTML=uiText('<span>流程库里有相似的「')+esc(match.name)+uiText('」，复用可省去规划。</span><button type="button" class="secondary" id="useSimilar">使用该流程</button>');$('useSimilar').onclick=()=>reuseFlow(match,$('input').value,attachments,$('project').value)}
  };
  let typing;$('input').oninput=()=>{clearTimeout(typing);typing=setTimeout(hint,250)};
  $('newForm').onchange=e=>{if(e.target.name==='planMode'){db.settings.planMode=e.target.value;save()}hint()};hint();$('input').focus();
  $('newForm').onsubmit=async e=>{e.preventDefault();const form=e.target,q=$('input').value.trim(),p=$('project').value;if(!q)return $('input').focus();
    if(solo()){dismiss();create(q,p||null,soloDefinition(q),null,null,attachments,uiText('由单个 Agent 直接完成'));return}
    const end=setBusy(form,uiText('正在规划…'));
    try{const d=await instantiate(q,null,attachments,form,p||null);if(!form.isConnected||!$('modal').open)return;dismiss();create(q,p||null,d,null,null,attachments,d?.fast?uiText('简单文字任务直接执行'):d?.split?uiText('拆分理由：')+d.split:uiText('根据本次简报生成初始工作流'));
      if(d?.notes?.length){run.logs.unshift([0,uiText('规划已自动修整'),d.notes.join('；')]);save();render()}}catch(err){end(err)}};
}
function setMembership(s,projectId){
  s.project=projectId;
  if(!s.flow.started)s.directory=project(projectId)?.directory||null;
}
function projectDialog(pid,onCreate){
  const p=project(pid);
  let directory=p?.directory||'';
  const folderField=host?`<label class="field" for="pickFolder">${uiText('本地目录（可选）')}</label>
    <div class="project-folder">
      <button class="folder-picker" type="button" id="pickFolder">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4h5l2.5 3H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/></svg>
        <span id="folderAction"></span>
      </button>
      <button type="button" class="folder-unlink" id="clearFolder">${uiText('解除关联')}</button>
      <span id="folderPath" dir="auto"></span>
    </div>`:'';
  dialog(uiText('项目'),p?uiText('管理项目'):uiText('新建项目'),uiText('<form id="projectForm"><label for="pname" class="field">项目名称</label><input class="fieldinput" id="pname" maxlength="60" required value="')+esc(p?.name||'')+'">'+folderField+(host?uiText('<label for="pguide" class="field">本项目的规划说明（可选）</label><textarea id="pguide" class="fieldinput" rows="5" maxlength="8000" placeholder="例如：交付物一律用中文；涉及数据的结论都要有一个核对节点；优先使用 Codex">')+esc(p?.guide||'')+uiText('</textarea><small class="muted">在此项目下自动规划时，规划模型会在通用规划指南之后读到这段说明。</small>'):'')+'<div class="actions">'+(p?uiText('<button type="button" class="secondary danger" id="deleteProject">删除项目</button>'):'')+'<button class="primary">'+(p?uiText('保存'):uiText('创建项目'))+'</button></div></form>');
  if(host){
    const pick=$('pickFolder'),clear=$('clearFolder'),label=$('folderPath'),name=$('pname');
    function showFolder(){
      label.textContent=directory;label.hidden=clear.hidden=!directory;
      $('folderAction').textContent=directory?uiText('更换目录'):uiText('添加目录');
    }
    pick.onclick=async()=>{
      try{const selected=await host.pickProjectDirectory();if(!selected||!pick.isConnected)return;
        directory=selected;if(!name.value.trim())name.value=selected.split(/[\\/]/).filter(Boolean).pop()?.slice(0,60)||selected;
        showFolder();
      }catch(err){notify(err.message)}
    };
    clear.onclick=()=>{directory='';showFolder()};
    showFolder();
  }
  if(p)confirmClick($('deleteProject'),uiText('确认删除？工作流会移到独立工作流'),()=>{
    for(const s of db.sessions)if(s.project===p.id)setMembership(s,null);
    db.projects=db.projects.filter(x=>x!==p);closedGroups.delete(p.id);dismiss();save();render();notify(uiText('项目已删除，其中的工作流已保留'));
  });
  $('projectForm').onsubmit=e=>{e.preventDefault();const n=$('pname').value.trim();if(!n)return $('pname').focus();
    const guide=$('pguide')?.value.trim()||'';
    let created=null;if(p){p.name=n;p.guide=guide;p.directory=directory;
      for(const s of db.sessions)if(s.project===p.id&&!s.flow.started)s.directory=directory||null;
    }else{created={id:uid(),name:n,guide,directory};db.projects.push(created)}
    dismiss();if(created&&onCreate)onCreate(created);save();render()};
}
$('more').onclick=()=>{dialog(uiText('工作流'),uiText('工作流选项'),uiText('<label for="moveProject" class="field">所属项目</label><select class="select" id="moveProject">')+opts(session().project)+'</select><div class="actions">'+(!run.started?uiText('<button class="secondary" id="editGraph">调整节点和依赖</button>'):'')+uiText('<button class="secondary" id="fork">修改简报并新建</button><button class="primary" id="move">保存归属</button></div><div class="actions danger-zone"><button class="secondary danger" id="deleteFlow">删除工作流</button></div>'));confirmClick($('deleteFlow'),uiText('再次点击确认删除（不可恢复）'),()=>deleteSession(session()));if($('editGraph'))$('editGraph').onclick=()=>buildManually(run.query,session().project,definitionOf(run,run.deps),session().attachments);$('fork').onclick=()=>newTask(run.query,session().project);$('move').onclick=()=>{setMembership(session(),$('moveProject').value||null);closedGroups.delete(session().project);dismiss();save();render()}};
$('pin').onclick=()=>{session().pinned=!session().pinned;save();render()};
$('sideToggle').onclick=()=>document.querySelector('.shell').classList.toggle(matchMedia('(max-width:760px)').matches?'mobileopen':'folded');
$('scrim').onclick=()=>document.querySelector('.shell').classList.remove('mobileopen');
$('new').onclick=()=>newTask();$('projectNew').onclick=()=>projectDialog();$('search').oninput=sidebar;
$('play').onclick=play;$('step').onclick=step;$('speed').onclick=()=>{speed=speed===1?2:1;for(const id of [...timers.keys()]){stop(id);start(db.sessions.find(s=>s.id===id))}render()};
$('version').onchange=()=>{const i=Number($('version').value);inspected=i===run.versions.length-1?null:i;render()};
$('inject').onclick=()=>{
  // Hold this workflow while the user decides whether to supply new evidence.
  if(timers.has(session().id)){pausedForEdit=session().id;stop(pausedForEdit);render()}
  dialog(uiText('分支条件'),uiText('注入变量'),uiText('<button class="option" data-change="review">提前要求')+run.pack.review.name+uiText('复核</button><button class="option" data-change="clear">分支输入已经确认</button>'));
};
$('close').onclick=dismiss;$('modal').oncancel=e=>{e.preventDefault();dismiss()};
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(!e.target.closest('#demoTools'))$('demoTools').open=false;
  if(b.dataset.session)activate(b.dataset.session);
  if(b.dataset.group){const id=b.dataset.group;if(closedGroups.has(id))closedGroups.delete(id);else closedGroups.add(id);sidebar()}
  if(b.dataset.newIn)newTask('',b.dataset.newIn);
  if(b.dataset.manage)projectDialog(b.dataset.manage);
  if(b.dataset.view){view=b.dataset.view;render()}
  if(b.dataset.id)details(b.dataset.id);
  if(b.dataset.file){inspected=null;details(b.dataset.file,{deliverable:true});document.querySelector('.delivered-panel')?.scrollIntoView({block:'nearest'})}
  if(b.dataset.change){if(b.dataset.change==='review')addReview(run,uiText('用户要求提前复核，已更新汇合输入。'));else{run.clear=true;run.logs.unshift([run.time,uiText('分支输入已确认'),uiText('沿用当前工作流')])}dismiss();save();render()}
});
// Sidebar "···" menu: pin, rename, move to a project, delete.
function closeRowMenu(){const m=$('rowMenu');if(m){document.querySelector('[data-row-menu][aria-expanded=true]')?.setAttribute('aria-expanded','false');m.remove()}}
function openRowMenu(id,anchor){
  closeRowMenu();const s=db.sessions.find(x=>x.id===id);if(!s)return;
  const menu=document.createElement('div');menu.id='rowMenu';menu.className='row-menu';menu.setAttribute('role','menu');
  const main=()=>'<button role="menuitem" data-row-act="pin">'+(s.pinned?uiText('取消置顶'):uiText('置顶','action'))+uiText('</button><button role="menuitem" data-row-act="rename">重命名</button>')+
    uiText('<button role="menuitem" data-row-act="projects">移到项目<span>›</span></button><hr><button role="menuitem" class="danger" data-row-act="delete">删除</button>');
  const projects=()=>uiText('<button role="menuitem" data-row-act="back" class="row-back">‹ 移到项目</button><hr>')+
    '<button role="menuitem" data-row-move="">'+(!s.project?'✓ ':'')+uiText('不加入项目</button>')+db.projects.map(p=>'<button role="menuitem" data-row-move="'+esc(p.id)+'">'+(s.project===p.id?'✓ ':'')+esc(p.name)+'</button>').join('')+
    uiText('<hr><button role="menuitem" data-row-act="newproject">＋ 新建项目…</button>');
  menu.innerHTML=main();document.body.append(menu);anchor.setAttribute('aria-expanded','true');
  const place=()=>{const r=anchor.getBoundingClientRect(),h=menu.offsetHeight;menu.style.left=Math.min(r.left,innerWidth-menu.offsetWidth-8)+'px';menu.style.top=(r.bottom+4+h>innerHeight?r.top-h-4:r.bottom+4)+'px'};
  place();menu.querySelector('button').focus();
  menu.onclick=e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.rowMove!==undefined){setMembership(s,b.dataset.rowMove||null);closedGroups.delete(s.project);s.updated=Date.now();closeRowMenu();save();render();notify(s.project?uiText('已移到「')+project(s.project).name+uiText('」'):uiText('已移出项目'));return}
    const act=b.dataset.rowAct;
    if(act==='pin'){s.pinned=!s.pinned;closeRowMenu();save();render();notify(s.pinned?uiText('已置顶'):uiText('已取消置顶'))}
    else if(act==='rename'){closeRowMenu();renameFlow(s)}
    else if(act==='projects'){menu.innerHTML=projects();place();menu.querySelector('[data-row-move]').focus()}
    else if(act==='back'){menu.innerHTML=main();place();menu.querySelector('button').focus()}
    else if(act==='newproject'){closeRowMenu();projectDialog(null,p=>{setMembership(s,p.id);notify(uiText('已移到新项目「')+p.name+uiText('」'))})}
    else if(act==='delete'){
      if(!b.dataset.armed){b.dataset.armed='1';b.textContent=uiText('确认删除？再点一次');return}
      closeRowMenu();deleteSession(s);
    }
  };
  menu.onkeydown=e=>{
    const items=[...menu.querySelectorAll('button')],i=items.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();closeRowMenu();anchor.focus()}
    else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus()}
  };
}
document.addEventListener('click',e=>{
  const more=e.target.closest('[data-row-menu]');
  if(more){e.stopPropagation();more.getAttribute('aria-expanded')==='true'?closeRowMenu():openRowMenu(more.dataset.rowMenu,more);return}
  if(!e.target.closest('#rowMenu'))closeRowMenu();
},true);
document.addEventListener('scroll',e=>{if(!e.target.closest?.('#rowMenu'))closeRowMenu()},true);
$('scheduleFlow').onclick=()=>scheduleDialog(session());
BercyI18n.setLanguage(BercyI18n.resolveLanguage('system',systemLanguages()));
db=restore();applyInterfaceLanguage(db.settings.languagePreference);run=session()?.flow;save();render();new ResizeObserver(graph).observe($('graphScroll'));
addEventListener('languagechange',syncSystemLanguage);
addEventListener('focus',syncSystemLanguage);
$('modal').addEventListener('close',syncSystemLanguage);
host?.onSystemLanguagesChanged?.(syncSystemLanguage);
if(host){
  syncApprovalMode();
  initialScan=refreshConnections().catch(e=>notify(e.message));
  Promise.allSettled([reattach(),initialScan]).then(()=>{
    checkSchedules();
    setInterval(checkSchedules,5000);
  });
}
$('approvalMode').onchange=e=>{db.settings.approval=e.target.value;save();syncApprovalMode();notify(uiText('审批方式：')+uiText(approvalModes.find(m=>m[0]===e.target.value)[1])+' · '+uiText(approvalModes.find(m=>m[0]===e.target.value)[2]))};
