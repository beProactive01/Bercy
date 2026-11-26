// Live view of running nodes: step timeline, streaming text, follow-up instructions and approval requests.
const drafts=new Map(),pendingApprovals=new Map();
const approvalModes=[['auto','自动','沙箱内的操作直接执行，越界时询问'],['ask','每次询问','每个命令和文件改动都先问你'],['allow','全部允许','新节点以本机账户权限运行，无需审批']];
function liveKey(s,id){return s.id+'/'+id}
function upsertStep(flow,id,step,time){
  const list=(flow.steps??={})[id]??=[];
  const i=list.findIndex(x=>x.id===step.id);
  if(i<0)list.push({...step,label:step.label||uiText('步骤'),t:time});
  else list[i]={...list[i],...Object.fromEntries(Object.entries(step).filter(([,v])=>v!==undefined&&v!==''))};
  if(list.length>300)list.splice(0,list.length-300);
}
// Running and waiting states shown on the node card and in its title.
function livePhase(s,id){
  const key=liveKey(s,id);
  if([...pendingApprovals.values()].some(a=>a.key===key))return uiText('等待审批');
  if(!inflight.has(key))return '';
  return (s.flow.steps?.[id]?.length||drafts.has(key))?uiText('执行中'):uiText('启动中');
}
function stepIcon(status){return status==='failed'?'×':status==='running'?'○':'✓'}
function stepHTML(step){
  const status=['running','failed'].includes(step.status)?step.status:'done';
  const label=status==='running'?uiText('进行中'):status==='failed'?uiText('失败'):uiText('完成');
  const output=step.detail?'<details class="step-output" data-node-disclosure="step:'+esc(step.id)+'"><summary>'+
    uiText('查看输出')+'</summary><pre data-disclosure-scroll>'+esc(step.detail)+'</pre></details>':'';
  return '<li class="tl-step '+status+'"><i role="img" aria-label="'+label+'">'+stepIcon(status)+'</i><div>'+
    '<span class="step-label">'+esc(step.label)+'</span>'+output+'</div><time>'+stamp(step.t||0)+'</time></li>';
}
function timelineHTML(f,id){
  const list=f.steps?.[id]||[];
  if(!list.length){
    const message=inflight.has(liveKey(session(),id))?'正在启动运行时，等待第一个输出…':
      f.files?.[id]?'这一步没有调用工具，直接写出了交付产物':'暂无执行步骤';
    return '<p class="empty">'+uiText(message)+'</p>';
  }
  const active=list.filter(step=>step.status==='running');
  const completed=list.filter(step=>step.status!=='running').reverse();
  const recent=completed.slice(0,4),older=completed.slice(4);
  const rows=steps=>'<ul class="trace-rows">'+steps.map(stepHTML).join('')+'</ul>';
  return (active.length?'<div class="trace-active"><p>'+uiText('正在执行的步骤')+'</p>'+rows(active)+'</div>':'')+
    (recent.length?'<p class="trace-heading">'+uiText('最近完成的步骤')+'</p>'+rows(recent):'')+
    (older.length?'<details class="trace-history" data-node-disclosure="history"><summary>'+
      uiText('更早的 {count} 步').replace('{count}',older.length)+'</summary>'+rows(older)+'</details>':'');
}
function traceSummary(list){
  const active=list.filter(x=>x.status==='running').length,failed=list.filter(x=>x.status==='failed').length;
  return [
    list.length+uiText(' 步'),
    active?uiText('{count} 步进行中').replace('{count}',active):'',
    failed?uiText('{count} 步失败').replace('{count}',failed):''
  ].filter(Boolean).join(' · ');
}
function lastStep(list){return (list.findLast(x=>x.status==='running')||list.at(-1))?.label||''}
// Keep accordion and output scroll positions when the stream or node details rerender.
const nodeDisclosures=new Map();
function rememberNodeDisclosures(root){
  const focus=document.activeElement;
  let focused;
  for(const item of root.querySelectorAll('[data-node-disclosure]')){
    const key=item.dataset.nodeDisclosure,body=item.querySelector(':scope > [data-disclosure-scroll]');
    nodeDisclosures.set(key,{open:item.open,scroll:body?.scrollTop||0});
    if(item.firstElementChild===focus)focused=key;
  }
  return focused;
}
function restoreNodeDisclosures(root,focused){
  for(const item of root.querySelectorAll('[data-node-disclosure]')){
    const key=item.dataset.nodeDisclosure,state=nodeDisclosures.get(key);
    if(state){
      item.open=state.open;
      const body=item.querySelector(':scope > [data-disclosure-scroll]');
      if(item.open&&body)body.scrollTop=state.scroll;
    }
    if(key===focused&&item.firstElementChild?.getClientRects().length)item.firstElementChild.focus({preventScroll:true});
  }
}
function refreshLive(s,id,draftOnly=false){
  if(shownNode!==id||session()!==s||!$('modal').open)return;
  const box=draftOnly?null:$('liveSteps');
  if(box){
    const focused=rememberNodeDisclosures(box);
    box.innerHTML=timelineHTML(s.flow,id);restoreNodeDisclosures(box,focused);
    const list=s.flow.steps?.[id]||[];
    $('liveTotal').textContent=traceSummary(list);$('liveLast').textContent=lastStep(list);
  }
  const draft=$('liveDraft'),text=drafts.get(liveKey(s,id));
  if(draft){draft.hidden=!text;draft.querySelector('.draft-text').textContent=text||''}
  const phase=livePhase(s,id);if(phase)$('dtype').textContent=uiText('Agent 节点 · ')+phase;
}
function liveSection(k){
  const s=session(),key=liveKey(s,k),running=host&&inflight.has(key),list=run.steps?.[k]||[];
  const runtime=runtimeInfo(run.dispatch[k]?.harness||'');
  const steer=running&&runtime?.steer?uiText('<form class="steer" id="steerForm"><input class="fieldinput" id="steerText" maxlength="2000" placeholder="追加要求，例如：再补一个英文版本" autocomplete="off"><button class="secondary">发送</button></form>'):'';
  return '<details class="live" data-node-disclosure="process" open><summary class="trace-summary">'+
    '<strong>'+uiText('执行过程')+'</strong><span class="trace-last" id="liveLast">'+esc(lastStep(list))+'</span>'+
    '<span class="trace-total" id="liveTotal">'+traceSummary(list)+'</span></summary>'+
    '<div class="timeline" id="liveSteps">'+timelineHTML(run,k)+'</div>'+
    '<details class="live-draft" data-node-disclosure="draft" id="liveDraft" '+(drafts.get(key)?'':'hidden')+
    '><summary>'+uiText('正在生成')+'</summary><div class="draft-text" data-disclosure-scroll>'+
    esc(drafts.get(key)||'')+'</div></details></details>'+steer;
}
function bindLive(k){
  renderApprovals();
  const form=$('steerForm');if(!form)return;
  form.onsubmit=async e=>{
    e.preventDefault();const text=$('steerText').value.trim();if(!text)return;
    const s=session();$('steerText').value='';
    try{await host.steer(liveKey(s,k),text);upsertStep(s.flow,k,{id:'steer-'+uid(),status:'done',label:uiText('追加要求 · ')+text},s.flow.time);recordNode(s.flow,k,uiText('追加要求 · ')+text);save();refreshLive(s,k)}
    catch(err){notify(String(err.message||err).replace(/^Error invoking remote method '[^']+': Error: /,''))}
  };
}
function approvalWhat(a){
  if(a.kind==='command')return {title:uiText('想要运行命令'),body:a.command||a.title};
  if(a.kind==='file')return {title:uiText('想要修改文件'),body:(a.files||[]).join(uiText('、'))||a.title||a.grantRoot};
  if(a.kind==='network')return {title:uiText('想要联网'),body:a.title};
  return {title:uiText('请求使用工具'),body:a.title||a.command};
}
// Pending approvals of the visible workflow appear over its canvas; others are counted so none is missed.
function approvalCard({approval:a,id,s}){
  const w=approvalWhat(a);
  return '<article class="approval-card" data-approval="'+esc(a.id)+'"><header><b>'+esc(s.flow.pack[id]?.name||a.node||uiText('节点'))+'</b><span>'+esc(a.runtime)+' '+w.title+'</span></header>'+
    (w.body?'<pre>'+esc(w.body)+'</pre>':'')+(a.reason?'<p>'+esc(a.reason)+'</p>':'')+
    uiText('<div class="approval-actions"><button class="secondary" data-decide="deny">拒绝</button><button class="secondary" data-decide="allow-run">本节点都允许</button><button class="primary" data-decide="allow">允许</button></div>')+
    uiText('<button class="approval-always" data-decide="allow-all">允许这次，并让后续节点使用全权限</button></article>');
}
function renderApprovals(){
  const tray=$('approvalTray');if(!tray)return;
  const s=session(),mine=[...pendingApprovals.values()].filter(a=>a.s===s),others=pendingApprovals.size-mine.length;
  tray.hidden=!pendingApprovals.size||view!=='graph';
  tray.innerHTML=mine.map(approvalCard).join('')+(others>0?uiText('<button class="approval-elsewhere" id="approvalElsewhere">其他工作流还有 ')+others+uiText(' 个待审批</button>'):'');
  // The node panel covers the canvas, so its own pending approvals are repeated inside it.
  const inPanel=$('liveApprovals');
  if(inPanel&&shownNode){const key=liveKey(s,shownNode);inPanel.innerHTML=[...pendingApprovals.values()].filter(a=>a.key===key).map(approvalCard).join('')}
}
async function decide(approvalId,decision){
  try{
    if(decision==='allow-all'){db.settings.approval='allow';save();syncApprovalMode();notify(uiText('已切换为「全部允许」，全权限从下次派发起生效'))}
    await host.approve(approvalId,decision);
  }catch(err){notify(err.message)}
}
function syncApprovalMode(){
  const pick=$('approvalMode');if(pick)pick.value=db.settings.approval||'auto';
  if(host)host.approvalMode(db.settings.approval||'auto').catch(()=>{});
}
function onHostEvent({key,message,prompt,usage,sentInputs,step,delta,thread,approval,approvalDone}){
  const job=inflight.get(key);
  if(approvalDone){
    const a=pendingApprovals.get(approvalDone);pendingApprovals.delete(approvalDone);
    if(a){const ok=arguments[0].decision!=='deny';upsertStep(a.s.flow,a.id,{id:'approval-'+approvalDone,status:ok?'done':'failed',label:(ok?uiText('已允许 · '):uiText('已拒绝 · '))+approvalWhat(a.approval).title},a.s.flow.time);save(a.s);refreshLive(a.s,a.id)}
    renderApprovals();if(a?.s===session())graph();return;
  }
  if(!job)return;
  const f=job.s.flow,now=job.base+Math.round((Date.now()-job.begin)/1000);
  if(approval){
    pendingApprovals.set(approval.id,{key,s:job.s,id:job.id,approval});
    upsertStep(f,job.id,{id:'approval-'+approval.id,status:'running',label:uiText('等待审批 · ')+approvalWhat(approval).title},now);
    renderApprovals();refreshLive(job.s,job.id);graph();
    if(document.hidden||!document.hasFocus())try{new Notification(uiText('Bercy 需要你审批'),{body:(f.pack[job.id]?.name||uiText('节点'))+' '+approvalWhat(approval).title})}catch{}
    return;
  }
  if(delta!=null){drafts.set(key,delta);refreshLive(job.s,job.id,true);return}
  if(thread)(f.threads??={})[job.id]=thread;
  if(step){upsertStep(f,job.id,step,now);save(job.s);refreshLive(job.s,job.id);if(job.s===session())graph();return}
  if(usage)(f.usage??={})[job.id]=usage;
  else if(prompt){(f.prompts??={})[job.id]=prompt;if(sentInputs)(f.sentInputs??={})[job.id]=sentInputs}
  else if(message)recordNode(f,job.id,message,now);
  save(job.s);if(shownNode===job.id&&session()===job.s)render();
}
function settleApprovals(key){
  for(const [aid,a] of pendingApprovals)if(a.key===key){pendingApprovals.delete(aid);const st=a.s.flow.steps?.[a.id]?.find(x=>x.id==='approval-'+aid);if(st)st.status='failed'}
  drafts.delete(key);renderApprovals();
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-decide]');
  if(b){const card=b.closest('[data-approval]');b.disabled=true;decide(card.dataset.approval,b.dataset.decide);return}
  if(e.target.closest('#approvalElsewhere')){const a=[...pendingApprovals.values()].find(x=>x.s!==session());if(a)activate(a.s.id)}
});
