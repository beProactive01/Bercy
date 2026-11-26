let customList=null,guideState=null;
function showSettings(){
  if(host)host.planningGuide().then(g=>{guideState=g;settingsSignature='';if(view==='settings')renderSettings()}).catch(()=>{});
  if(host&&!customList)host.customRuntimes().then(list=>{customList=list;settingsSignature='';if(view==='settings')renderSettings()}).catch(()=>{customList=[]});
  view='settings';document.querySelector('.shell').classList.remove('mobileopen');render();
}
let settingsSignature='',settingsTab='runtimes';
// Settings follow the desktop-client pattern: a section list on the left, grouped rows on the right.
const settingsTabs=[['general','通用','界面语言','◐'],['runtimes','运行时','连接本机 CLI、选择默认模型、添加自定义运行时','⌘'],['planning','规划','规划用哪个模型、是否边做边拆、规划指南','✦'],['execution','执行','审批方式、自动运行和超时','▶']];
const visibleTabs=()=>host?settingsTabs:settingsTabs.filter(t=>['general','runtimes'].includes(t[0]));
function choiceCards(name,value,items){
  return '<div class="approval-modes">'+items.map(([v,t,d])=>'<label class="'+(value===v?'on':'')+'"><input type="radio" name="'+name+'" value="'+v+'" '+(value===v?'checked':'')+'><b>'+uiText(t)+'</b><small>'+uiText(d)+'</small></label>').join('')+'</div>';
}
// A titled group of rows; `foot` is a short note under the box.
function group(title,note,body,foot=''){
  return '<section class="pgroup">'+(title||note?'<div class="pgroup-head">'+(title?'<h3>'+title+'</h3>':'')+(note?'<span>'+note+'</span>':'')+'</div>':'')+
    '<div class="pgroup-box">'+body+'</div>'+(foot?'<p class="pgroup-foot">'+foot+'</p>':'')+'</section>';
}
// One setting: label and hint on the left, its control on the right.
function prow(id,label,hint,control,wide=false){
  return '<div class="prow'+(wide?' prow-wide':'')+'"><div class="prow-text"><label'+(id?' for="'+id+'"':'')+'>'+label+'</label>'+(hint?'<small>'+hint+'</small>':'')+'</div><div class="prow-control">'+control+'</div></div>';
}
const toggle=(id,on,attrs='')=>'<input type="checkbox" role="switch" class="switch" '+(id?'id="'+id+'" ':'')+attrs+(on?' checked':'')+'>';
function runtimeState(r,c){
  if(host&&!r.installed)return ['missing',uiText('未检测到 CLI')];
  if(r.account?.signedIn===false)return ['warn',uiText('未登录')];
  return c.online?['on',uiText('已连接','badge')]:['off',uiText('未连接')];
}
function runtimeCard(r,i){
  const c=db.connections[r.name],[state,label]=runtimeState(r,c),missing=host&&!r.installed;
  const control=missing?'<button class="secondary small-button" data-connect="'+esc(r.name)+'">'+uiText('选择 CLI…')+'</button>':
    toggle('',c.online,'data-connect="'+esc(r.name)+'" aria-label="'+esc(uiText('连接')+' '+r.name)+'"');
  const caps='<span class="rt-caps">'+((r.caps||[]).map(x=>'<span class="cap-chip">'+esc(capText([x]))+'</span>').join('')||'<span class="cap-chip">'+uiText('仅文字')+'</span>')+'</span>';
  const shortPath=String(r.bin||'').replace(/^\/Users\/[^/]+/,'~');
  const note=r.name==='OpenClaw'?uiText('（取决于 Gateway 配置）'):r.name==='Pi'?uiText('（无沙箱：命令以你的账户权限运行）'):'';
  const login=r.account?.signedIn===false?'<p class="rt-warn">'+uiText('未登录，请在终端运行 ')+esc(uiText(r.login||r.name))+uiText(' 后点「重新检测」')+'</p>':'';
  const meta='<div class="rt-meta">'+caps+(host&&r.bin?'<span class="rt-path" title="'+esc(r.bin)+'">'+esc(shortPath)+'</span>':'')+(host&&r.bin?'<span>'+(r.supportsImages?uiText('支持图像直传'):uiText('图片以文件提供'))+'</span>':'')+
    (r.account?.signedIn&&r.account.plan?'<span>'+uiText('已登录')+' · '+esc(r.account.plan)+'</span>':'')+(note?'<span>'+note+'</span>':'')+'</div>';
  const body=c.online?'<div class="rt-body">'+
    prow('defaultModel'+i,uiText('默认模型'),uiText('节点没有指定模型时使用'),modelListField('defaultModel'+i,uiText('默认模型'),r.models.map(name=>({name:modelLabel(name),value:name})),c.model))+
    prow('skill'+i,uiText('擅长的工作'),uiText('规划时按此分配节点，清空即恢复默认'),'<input class="fieldinput skill-input" id="skill'+i+'" data-skill="'+esc(r.name)+'" maxlength="60" value="'+esc(skillOf(r))+'" placeholder="'+esc(uiText(r.skill)||uiText('例如：写代码、长文写作、联网调研'))+'">')+
    '</div>':'';
  return '<article class="rt-card '+state+'"><div class="rt-head">'+runtimeIcon(r)+'<div class="rt-title"><b>'+esc(r.name)+'</b><small>'+esc(r.custom?uiText('自定义 · ACP'):r.adapter||'')+'</small></div>'+
    '<span class="rt-badge '+state+'">'+label+'</span>'+control+'</div>'+meta+login+body+'</article>';
}
function generalTab(){
  return group(uiText('外观与语言'),'',prow('uiLanguage',uiText('界面语言'),'Interface language','<select class="select" id="uiLanguage"><option value="system">'+uiText('跟随系统')+'</option><option value="zh-CN" lang="zh-CN">简体中文</option><option value="en" lang="en">English</option></select>'))+
    group(uiText('工作区'),'',prow('',host?uiText('本机工作区'):uiText('本地模拟工作区'),host?uiText('工作流、执行记录和产物保存在此 Mac 上'):uiText('演示数据保存在当前浏览器'),''));
}
function runtimesTab(){
  const connected=runtimes.filter(r=>db.connections[r.name].online);
  return group(uiText('本机运行时'),connected.length+' / '+runtimes.length+uiText(' 已连接')+(host?' · <button class="link-button" id="rescan">'+uiText('重新检测')+'</button>':''),
      runtimes.map(runtimeCard).join(''),
      host?uiText('自动检测本机 CLI，沿用其登录状态。连接两个运行时，审查节点就能交给另一个模型。'):uiText('演示环境使用样例模型目录。'))+
    (host?group(uiText('自定义运行时（ACP）'),uiText('接入任何支持 ACP 协议的 Agent'),customForm()):'');
}
function planningTab(){
  const planners=runtimes.filter(r=>db.connections[r.name].online);
  const pick='<select class="select" id="plannerPick"><option value="">'+uiText('自动')+'</option>'+planners.map(r=>'<option value="'+esc(r.name)+'" '+(db.settings.planner===r.name?'selected':'')+'>'+esc(r.name)+' · '+esc(modelLabel(db.connections[r.name].model))+'</option>').join('')+'</select>';
  return group(uiText('规划'),'',
      prow('plannerPick',uiText('规划使用的运行时'),uiText('规划决定整个工作流的质量。自动时依次选用 Codex、Claude、Pi、DeepSeek Harness、OpenClaw'),pick)+
      prow('expandPref',uiText('按需展开'),uiText('可展开的节点交付后，由规划模型判断是否按其拆解新增节点'),toggle('expandPref',(db.settings.expand||'auto')!=='off')),
      uiText('上限：每次最多新增 ')+Dag.limits.perExpansion+uiText(' 个节点，最多展开 ')+Dag.limits.depth+uiText(' 层、')+Dag.limits.expansions+uiText(' 次，每个工作流最多 ')+Dag.limits.total+uiText(' 个节点。'))+
    group(uiText('规划指南'),guideState?.custom?uiText('已自定义'):uiText('默认版本'),
      '<div class="guide-box"><textarea id="guideText" class="fieldinput guide-text" rows="14" spellcheck="false">'+esc(guideState?.text||'')+'</textarea>'+
      '<div class="actions"><button class="secondary" id="guideReveal">'+uiText('在 Finder 中显示')+'</button><button class="secondary" id="guideReset">'+uiText('恢复默认')+'</button><button class="primary" id="guideSave">'+uiText('保存指南')+'</button></div></div>',
      uiText('规划模型每次规划和展开前都会读这份 Markdown；输出格式由程序固定。每个项目还可以在「管理项目」里补充本项目的规划说明。'));
}
function executionTab(){
  return group(uiText('审批'),uiText('运行中遇到命令或文件改动时'),choiceCards('approvalPref',db.settings.approval||'auto',approvalModes),
      uiText('全部允许从下次派发起生效。Codex 和 Claude 以本机账户权限运行，Pi 开放已安装的工具，ACP 请求自动批准。OpenClaw 的执行权限由 Gateway 决定。'))+
    group(uiText('运行'),'',
      prow('autoStart',uiText('新建任务后自动开始运行'),uiText('关闭后，可以先检查计划再手动运行'),toggle('autoStart',db.settings.autoStart!==false))+
      prow('nodeTimeout',uiText('单个节点最长运行时间'),uiText('留空表示不限制。设置时限后，等待审批的时间不计入。'),'<span class="unit-input"><input class="fieldinput" id="nodeTimeout" type="number" min="1" max="180" step="1" placeholder="'+uiText('不限制')+'" value="'+esc(db.settings.nodeTimeoutMinutes||'')+'"><span>'+uiText('分钟')+'</span></span>')+
      prow('nodeParallel',uiText('每个运行时同时执行的节点数'),uiText('数值越大越快，也越容易触发速率限制'),'<span class="unit-input"><input class="fieldinput" id="nodeParallel" type="number" min="1" max="4" step="1" value="'+esc(slotLimit())+'"></span>'));
}
function systemLanguages(){
  return host?.systemLanguages?.() || navigator.languages;
}
function applyInterfaceLanguage(preference){
  db.settings.languagePreference=preference;
  const language=BercyI18n.setLanguage(BercyI18n.resolveLanguage(preference,systemLanguages()));
  if(host)host.language(language).catch(err=>notify(err.message));
  document.querySelector('.local').innerHTML='<i></i> '+(host?uiText('本机工作区'):uiText('本地模拟工作区'));
  delete $('answerContent').dataset.key;
  delete $('library').dataset.key;
}
function renderSettings(){
  if(!visibleTabs().some(t=>t[0]===settingsTab))settingsTab='runtimes';
  const signature=JSON.stringify([settingsTab,BercyI18n.language,db.connections,db.settings,runtimes.map(r=>[r.name,r.caps,r.account,r.installed,r.models?.length]),customList,guideState&&[guideState.custom,guideState.text.length]]);
  if(signature===settingsSignature)return;
  settingsSignature=signature;
  const scroll=$('preferences').scrollTop,[,title,intro]=settingsTabs.find(t=>t[0]===settingsTab);
  const nav='<nav class="prefs-nav" role="tablist" aria-label="'+uiText('设置')+'"><button class="back-flow" id="backFlow">'+uiText('‹ 返回工作流')+'</button><h1>'+uiText('设置')+'</h1>'+
    visibleTabs().map(([id,t,,glyph])=>'<button role="tab" aria-selected="'+(settingsTab===id)+'" data-settings-tab="'+id+'"><i aria-hidden="true">'+glyph+'</i>'+uiText(t)+'</button>').join('')+'</nav>';
  const page=settingsTab==='general'?generalTab():settingsTab==='planning'?planningTab():settingsTab==='execution'?executionTab():runtimesTab();
  $('preferences').innerHTML='<div class="prefs-shell">'+nav+'<div class="prefs-page"><header class="prefs-head"><h2>'+uiText(title)+'</h2><p>'+uiText(intro)+'</p></header>'+page+'</div></div>';
  $('preferences').scrollTop=scroll;
  if($('uiLanguage'))$('uiLanguage').value=db.settings.languagePreference;
  if(settingsTab!=='runtimes')return;
  for(const [i,r] of runtimes.entries()){
    const c=db.connections[r.name];if(!c.online)continue;
    bindModelList('defaultModel'+i,r.models.map(name=>({name:modelLabel(name),value:name})),c.model,()=>{},value=>{
      c.model=value;save();render();notify(uiText('默认模型已保存'));
    });
  }
}
function customForm(){
  const rows=(customList||[]).map((c,i)=>'<div class="custom-row"><b>'+esc(c.name)+'</b><code>'+esc(c.command+' '+c.args)+'</code><span>'+esc(capText(c.caps)||uiText('仅文字'))+(c.images?uiText(' · 图片'):'')+'</span><button class="secondary" data-custom-remove="'+i+uiText('">删除</button></div>')).join('');
  return '<div class="custom-list">'+(rows||uiText('<p class="muted">还没有添加。例如 Gemini CLI（gemini --experimental-acp）、OpenCode（opencode acp）。</p>'))+'</div>'+
    uiText('<form class="custom-form" id="customForm"><input class="fieldinput" name="name" maxlength="40" placeholder="名称，例如 Gemini" required>')+
    uiText('<div class="custom-cmd"><input class="fieldinput" name="command" placeholder="可执行文件，例如 gemini 或完整路径" required><button type="button" class="secondary" id="pickBinary">选择…</button></div>')+
    uiText('<input class="fieldinput" name="args" placeholder="启动参数，默认 acp" value="acp">')+
    uiText('<div class="need-picks"><label><input type="checkbox" name="cap" value="write" checked>写文件</label><label><input type="checkbox" name="cap" value="shell">执行命令</label><label><input type="checkbox" name="cap" value="network">联网</label><label><input type="checkbox" name="images">支持图片</label></div>')+
    uiText('<div class="actions"><button class="primary">添加运行时</button></div></form>');
}
async function saveCustom(list){
  try{const rows=await host.customRuntimes(list);customList=await host.customRuntimes();await refreshConnections(null,rows);notify(uiText('自定义运行时已更新'))}
  catch(err){notify(String(err.message||err).replace(/^Error invoking remote method '[^']+': Error: /,''))}
}
document.getElementById('preferences').addEventListener('submit',e=>{
  if(e.target.id!=='customForm')return;e.preventDefault();const f=e.target.elements;
  saveCustom([...(customList||[]),{name:f.name.value,command:f.command.value,args:f.args.value,caps:[...e.target.querySelectorAll('[name=cap]:checked')].map(x=>x.value),images:f.images.checked}]);
});
document.getElementById('settings').onclick=showSettings;
function refreshInterfaceLanguage(preference){
  const guide=$('guideText'),draft=guide && guide.value!==guideState?.text ? guide.value : null;
  applyInterfaceLanguage(preference);settingsSignature='';render();
  if(draft!==null && $('guideText'))$('guideText').value=draft;
  const language=BercyI18n.language,initial=$('guideText')?.value;
  if(host)host.planningGuide().then(g=>{
    if(BercyI18n.language!==language)return;
    guideState=g;
    const field=$('guideText');
    if(field && draft===null && field.value===initial)field.value=g.text;
  }).catch(err=>notify(err.message));
}
function syncSystemLanguage(){
  if(db.settings.languagePreference!=='system' || $('modal').open)return;
  if(BercyI18n.resolveLanguage('system',systemLanguages())!==BercyI18n.language)refreshInterfaceLanguage('system');
}
document.getElementById('preferences').onchange=e=>{
  if(e.target.id==='uiLanguage'){
    refreshInterfaceLanguage(e.target.value);save();
    $('uiLanguage').focus();
    return;
  }
  if(e.target.id==='expandPref'){db.settings.expand=e.target.checked?'auto':'off';save();notify(e.target.checked?uiText('已开启自动展开'):uiText('已关闭按需展开'));return}
  if(e.target.dataset.connect){toggleRuntime(e.target.dataset.connect);return}
  if(e.target.name==='approvalPref'){db.settings.approval=e.target.value;save();syncApprovalMode();settingsSignature='';renderSettings();notify(uiText('审批方式已改为「')+uiText(approvalModes.find(m=>m[0]===e.target.value)[1])+uiText('」'));return}
  if(e.target.id==='autoStart'){db.settings.autoStart=e.target.checked;save();notify(e.target.checked?uiText('新建任务后会自动运行'):uiText('新建任务后需手动点击运行'));return}
  if(e.target.id==='plannerPick'){db.settings.planner=e.target.value;save();notify(uiText('规划将使用 ')+(e.target.value||uiText('自动选择')));return}
  if(e.target.dataset.skill!==undefined){
    const name=e.target.dataset.skill,r=runtimeInfo(name),v=e.target.value.trim().slice(0,60),skills=db.settings.skills??={};
    if(!v||v===uiText(r?.skill))delete skills[name];else skills[name]=v;
    e.target.value=skillOf(r||{name});save();notify(name+uiText(' 擅长：')+(skillOf(r||{name})||uiText('未设置')));return;
  }
  if(e.target.id==='nodeParallel'){
    const n=Math.round(Number(e.target.value));
    if(!(n>=1&&n<=4)){e.target.value=slotLimit();notify(uiText('请输入 1 至 4'));return}
    db.settings.parallel=n;save();notify(uiText('每个运行时最多同时执行 ')+n+uiText(' 个节点'));if(host)pump();return;
  }
  if(e.target.id!=='nodeTimeout')return;
  const minutes=Number(e.target.value);
  if(!e.target.validity.valid){
    e.target.value=db.settings.nodeTimeoutMinutes||'';notify(uiText('请输入 1 至 180 分钟'));return;
  }
  db.settings.nodeTimeoutMinutes=minutes;save();
  notify(minutes?uiText('之后派发的节点最长运行 ')+minutes+uiText(' 分钟'):uiText('之后派发的节点不限制运行时间'));
};
document.getElementById('preferences').onclick=e=>{
  const btn=e.target.closest('button');if(!btn)return;
  if(btn.dataset.settingsTab){settingsTab=btn.dataset.settingsTab;renderSettings();$('preferences').scrollTop=0;return}
  if(btn.id==='guideSave'){host.planningGuide($('guideText').value).then(g=>{guideState=g;notify(uiText('规划指南已保存，下一次规划生效'))}).catch(err=>notify(err.message));return}
  if(btn.id==='guideReset'){host.planningGuide(null).then(g=>{guideState=g;settingsSignature='';renderSettings();notify(uiText('已恢复默认规划指南'))});return}
  if(btn.id==='guideReveal'){host.revealGuide();return}
  if(btn.id==='pickBinary'){host.pickBinary().then(p=>{if(p)btn.previousElementSibling.value=p});return}
  if(btn.dataset.customRemove!==undefined){saveCustom(customList.filter((_,i)=>i!==Number(btn.dataset.customRemove)));return}
  if(btn.id==='rescan'){refreshConnections().catch(e=>notify(e.message));return}
  if(btn.id==='backFlow'){view='graph';render();return}
  if(btn.dataset.connect){toggleRuntime(btn.dataset.connect);return}
};
// Connects or disconnects a runtime; one that is not installed asks for its CLI instead.
function toggleRuntime(name){
    const c=db.connections[name];
    if(host&&!runtimeInfo(name).installed){refreshConnections(name).catch(e=>notify(e.message));return}
    c.online=!c.online;if(host)c.enabled=c.online;
    const r=runtimeInfo(name);
    notify(c.online&&r?.account?.signedIn===false?r.name+uiText(' 尚未登录，节点会优先使用其他运行时。请在终端运行 ')+uiText(r.login||r.name)+uiText(' 登录后重新检测'):c.online?uiText('已连接，默认模型可用'):uiText('已断开，新派发将重新匹配'));
  save();render();
}
