// A saved definition contains configuration only; each use creates new execution state.
// Live adjustments made during a run are left out: what is saved or rerun is the workflow as planned.
function definitionOf(flow,deps){
  const plan=Dag.planned(flow,deps);deps=plan.deps;flow={...flow,pack:plan.pack};
  const overrides=Object.fromEntries(Object.entries(flow.overrides).filter(([k])=>Object.hasOwn(deps,k)));
  return structuredClone({family:flow.family,mono:flow.mono,roles:Object.fromEntries(Object.keys(deps).map(k=>[k,flow.pack[k]])),deps,overrides,...(flow.workspace?{workspace:flow.workspace}:{})});
}
function showLibrary(){
  view='library';
  document.querySelector('.shell').classList.remove('mobileopen');
  render();
}
function renameFlow(item,libraryItem=false){
  const current=item.name||item.flow.query;
  dialog(libraryItem?uiText('已保存的工作流'):uiText('当前工作流'),uiText('重命名'),uiText('<form id="nameForm"><label class="field" for="flowName">工作流名称</label><input class="fieldinput" id="flowName" maxlength="240" required value="')+esc(current)+uiText('"><div class="actions"><button class="primary">保存名称</button></div></form>'));
  $('flowName').select();
  $('nameForm').onsubmit=e=>{
    e.preventDefault();const name=$('flowName').value.trim();if(!name)return $('flowName').focus();
    item.name=name;item.updated=Date.now();const persisted=save();dismiss();if(persisted)notify(uiText('名称已保存'));
  };
}
function saveDefinition(){
  const s=session(),definition=definitionOf(run,snapshot());
  const base=db.library.find(t=>t.id===s.source?.id);
  const latest=base?.versions.length;
  const canUpdate=base&&latest===s.source.version;
  const prior=canUpdate?base.versions[latest-1]:null;
  const title=canUpdate?base.name:s.name||run.query;
  const note=Object.keys(definition.deps).length+uiText(' 个节点 · 保存角色、依赖、交付要求和运行时设置。');
  dialog(uiText('流程库'),uiText('保存可复用流程'),'<form id="saveDefinition"><p class="muted">'+esc(note)+uiText('</p><label class="field dialoglabel" for="saveName">流程名称</label><input class="fieldinput" id="saveName" maxlength="240" required value="')+esc(title)+'">'+
    uiText('<fieldset class="save-modes"><legend>保存内容</legend><label><input type="radio" name="mode" value="structure" ')+(prior?.mode!=='full'?'checked':'')+uiText('><span><b>只存流程结构</b><small>下次根据新任务，为每个节点重新生成简述。</small></span></label><label><input type="radio" name="mode" value="full" ')+(prior?.mode==='full'?'checked':'')+uiText('><span><b>完整保存</b><small>保留每个节点的任务简述，复用后可直接运行。</small></span></label></fieldset>')+
    (canUpdate?uiText('<p class="muted">沿用此名称可更新版本，改名可另存一份。</p>'):base?uiText('<p class="muted">当前运行来自旧版本，保存会创建一份独立流程。</p>'):'')+
    uiText('<div class="actions"><button class="primary" id="confirmSave">保存到流程库</button></div></form>'));
  $('saveName').select();
  $('saveDefinition').onsubmit=e=>{
    e.preventDefault();const name=$('saveName').value.trim();if(!name)return $('saveName').focus();
    const mode=e.target.elements.mode.value;
    const saved=mode==='structure'?Dag.stripBriefs(definition):{...definition,mode};
    const same=prior&&JSON.stringify(saved)===JSON.stringify(prior);let item;
    if(canUpdate&&name===base.name){
      item=base;if(!same)item.versions.push(saved);
    }else{
      item={id:uid(),name,versions:[saved],updated:Date.now()};db.library.unshift(item);
    }
    item.sample=run.query;
    item.updated=Date.now();s.source={id:item.id,version:item.versions.length};
    const persisted=save();dismiss();showLibrary();if(persisted)notify(uiText('流程已保存 · v')+item.versions.length);
  };
}
function reuseFlow(item,initial='',initialAttachments=[],projectId=null){
  const latest=item.versions.length;
  dialog(uiText('使用已保存流程'),item.name,uiText('<form id="reuseForm"><label class="field" for="edition">流程版本</label><select class="select" id="edition">')+item.versions.map((_,i)=>'<option value="'+(i+1)+'" '+(i+1===latest?'selected':'')+'>v'+(i+1)+(i+1===latest?uiText(' · 最新'):'')+' · '+(item.versions[i].mode==='structure'?uiText('只存结构'):uiText('完整保存'))+'</option>').reverse().join('')+'</select>'+
    uiText('<label class="field" for="reuseBrief">任务描述</label><textarea id="reuseBrief" required maxlength="4000" placeholder="这一次要处理什么？">')+esc(initial)+uiText('</textarea><label class="field" for="reuseProject">项目（可选）</label><select class="select" id="reuseProject">')+opts(projectId)+'</select>'+
    attachmentField()+uiText('<div class="actions"><button class="primary">创建本次工作流</button></div></form>'));
  $('reuseBrief').focus();
  let attachments=[...initialAttachments];bindAttachments($('reuseForm'),attachments);
  $('reuseForm').onsubmit=async e=>{
    e.preventDefault();const query=$('reuseBrief').value.trim();if(!query)return $('reuseBrief').focus();
    const projectId=$('reuseProject').value||null,version=Number($('edition').value);
    const form=e.target,end=setBusy(form,uiText('准备节点…'));
    try{const d=await instantiate(query,item.versions[version-1],attachments,form,projectId);if(!form.isConnected||!$('modal').open)return;dismiss();create(query,projectId,d,{id:item.id,version},null,attachments)}catch(err){end(err)}
  };
}
function renderLibrary(){
  const items=[...db.library].sort((a,b)=>b.updated-a.updated);
  const key=JSON.stringify(items.map(i=>[i.id,i.updated,i.name,i.versions.length,i.schedule?.version,i.schedule?.repeat,i.schedule?.hours,i.schedule?.next,i.schedule?.last,!!(i.schedule?.last&&db.sessions.some(s=>s.id===i.schedule.last))]));
  if($('library').dataset.key===key)return;
  $('library').dataset.key=key;
  const cards=items.map(t=>{
    const version=t.versions.length,d=t.versions[version-1],nodes=Object.keys(d.deps);
    return '<article class="flowcard"><div class="flowcard-top"><span class="library-glyph">▱</span><span>v'+version+'</span></div><h2>'+esc(t.name)+'</h2><p>'+nodes.length+uiText(' 个节点 · ')+(d.mode==='structure'?uiText('只存结构'):uiText('完整保存'))+' · '+esc(Dag.outputs(d.deps).map(k=>d.roles[k].artifact).join(uiText('、')))+'</p><div class="flow-roles">'+nodes.map(k=>'<span>'+esc(d.roles[k].name)+'</span>').join('')+'</div>'+scheduleCard(t)+'<div class="flowcard-actions"><span><button class="secondary" data-retitle="'+t.id+uiText('">重命名</button> ')+(window.relayHost?'<button class="secondary" data-export="'+t.id+uiText('">导出</button> '):'')+'<button class="secondary danger" data-remove="'+t.id+uiText('">删除</button></span><button class="primary" data-reuse="')+t.id+uiText('">使用流程</button></div></article>');
  }).join('');
  $('library').innerHTML=uiText('<div class="library-wrap"><button class="back-flow" id="backFromLibrary">‹ 返回当前工作流</button><div class="lib-header"><h1>已保存的工作流</h1><span>')+(window.relayHost?uiText('<button class="secondary" id="libImport">导入</button> '):'')+uiText('<button class="secondary" id="libBuild">＋ 手动搭建</button></span></div><p class="library-help">选择一套分工，带入本次任务描述。</p>')+
    (cards?'<div class="flowcards">'+cards+'</div>':uiText('<div class="library-empty"><span class="library-glyph">▱</span><h2>还没有保存的流程</h2><p>在工作流右上角点击「保存流程」，之后就可以在这里重复使用。</p><button class="secondary" id="emptyBack">查看当前工作流</button></div>'))+'</div>';
}
// Shares the latest version of a saved workflow as a .bercy.json file.
async function exportFlow(item){
  if(!item||!window.relayHost)return;
  const def=item.versions[item.versions.length-1];
  try{
    const done=await window.relayHost.exportFlow(item.name,JSON.stringify(Dag.toFile(item.name,def),null,2));
    if(done)notify(def.mode==='full'?uiText('已导出 · 完整保存的流程包含每个节点的任务简述，分享前请检查'):uiText('已导出工作流'));
  }catch(err){notify(hostError(err))}
}
async function importFlow(){
  if(!window.relayHost)return;
  try{
    const text=await window.relayHost.importFlow();if(text===null)return;
    let data;try{data=JSON.parse(text)}catch{throw Error(uiText('这不是 Bercy 工作流文件'))}
    const {name,definition}=Dag.fromFile(data);
    const item={id:uid(),name,versions:[definition],updated:Date.now()};db.library.unshift(item);
    const persisted=save();render();if(persisted)notify(uiText('已导入 · ')+name);
  }catch(err){notify(hostError(err))}
}
document.getElementById('saveFlow').onclick=saveDefinition;
document.getElementById('libraryNav').onclick=showLibrary;
document.getElementById('rename').onclick=()=>renameFlow(session());
document.getElementById('library').onclick=e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.id==='libBuild'){buildManually();return}
  if(b.id==='libImport'){importFlow();return}
  if(b.dataset.export){exportFlow(db.library.find(t=>t.id===b.dataset.export));return}if(b.id==='backFromLibrary'||b.id==='emptyBack'){view='graph';render();return}
  if(b.dataset.scheduledRun){activate(b.dataset.scheduledRun);return}
  if(b.dataset.remove){
    if(!b.dataset.armed){b.dataset.armed='1';b.textContent=uiText('确认删除');setTimeout(()=>{if(b.isConnected){delete b.dataset.armed;b.textContent=uiText('删除')}},4000);return}
    db.library=db.library.filter(t=>t.id!==b.dataset.remove);save();render();notify(uiText('已从流程库删除，已创建的工作流不受影响'));return;
  }
  const item=db.library.find(t=>t.id===(b.dataset.reuse||b.dataset.retitle||b.dataset.schedule));
  if(item){if(b.dataset.schedule)scheduleDialog(item);else if(b.dataset.reuse)reuseFlow(item);else renameFlow(item,true)}
};
