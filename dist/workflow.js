// A node starts only after every declared input has produced an artifact.
const examples = [
  '给深夜电台做一段 60 秒的开场白和声音制作单',
  '为记账 App 的订阅功能准备上线说明和回归清单',
  '给城市散步播客写一份纯旁白稿，无需音效'
];
const role = (name, harness, artifact, description, avatar) => ({name, harness, artifact, description, avatar});
const radio = {
  root:role('策划','Claude','节目简报','确定节目主题、时长，以及各分支之间的输入约定。','lead'),
  a:role('编剧','Claude','旁白稿','根据节目简报独立创作旁白，留出声音设计空间。','writer'),
  b:role('采样员','OpenClaw','素材清单','为节目寻找声音，同时记录每条录音的使用条件。','scout'),
  review:role('核验员','Claude','可用声音清单','核查素材来源，将存疑录音替换成自录声音。','check'),
  merge:role('制作人','Codex','开场制作单','收到上游产物后，将旁白和可用声音合成一张制作单。','mix')
};
const release = {
  root:role('负责人','Claude','发布简报','划定发布范围，并将文案与验证工作并行派发。','lead'),
  a:role('文案师','Claude','上线说明','整理用户可见的变化和操作路径。','writer'),
  b:role('测试员','Codex','回归清单','检查新功能主流程与异常场景。','scout'),
  review:role('兼容审查员','Codex','兼容补充项','为旧版客户端补全回归条件。','check'),
  merge:role('发布经理','OpenClaw','发布包','汇总上线说明及完整回归条件。','mix')
};
const general = {
  root:role('协调员','Claude','任务简报','明确交付目标，分配方案与审查工作。','lead'),
  a:role('方案师','Claude','执行提案','为目标拟定可执行的第一版方案。','writer'),
  b:role('评审员','OpenClaw','验收清单','独立列出可检查的验收条件。','scout'),
  review:role('复核员','Claude','复核结论','补齐验收条件中缺少的依据。','check'),
  merge:role('整合员','Codex','交付草案','将方案与验收条件整合为交付草案。','mix')
};
function planFor(query){
  const pack=/电台|播客|旁白|音效|音频/.test(query)?radio:/发布|上线|回归|订阅/.test(query)?release:general;
  const mono=pack===radio&&/纯旁白|无需音效|只要旁白/.test(query);
  const deps=mono?{root:[],a:['root'],merge:['a']}:{root:[],a:['root'],b:['root'],merge:['a','b']};
  if(!mono&&/核验授权|兼容审查|提前复核/.test(query)){deps.review=['b'];deps.merge=['a','review']}
  return {pack,mono,deps};
}
function newRun(query,definition){
  const familyFromQuery=definition?null:planFor(query);
  const pack=definition?structuredClone(definition.roles):familyFromQuery.pack;
  const family=definition?definition.family:pack===radio?'radio':pack===release?'release':'general';
  const {mono,deps}=definition?structuredClone(definition):familyFromQuery;
  return {query,pack,family,workspace:structuredClone(definition?.workspace||null),scopedBriefs:!!definition?.scopedBriefs,roles:definition?pack:undefined,mono,deps,overrides:structuredClone(definition?.overrides||{}),dispatch:{},events:{},time:0,progress:{},files:{},logs:[],versions:[{deps:structuredClone(deps),reason:uiText('根据任务目标生成初始分工。')}],clear:/全部自录|已验证|已确认/.test(query),started:false};
}
const work={root:3,a:6,b:4,review:5,merge:3};
function runnable(run){return Object.keys(run.deps).filter(k=>!run.files[k]&&run.deps[k].every(id=>run.files[id]&&!run.files[id].needsInput))}
function displayRole(flow,id){
  const role=flow.pack[id],sample=({radio,release,general})[flow.family]?.[id];
  if(!sample)return role;
  const display={...role};
  for(const field of ['name','description','artifact'])if(role[field]===sample[field])display[field]=uiText(role[field]);
  return display;
}
function modelLabel(model){return model==='运行时默认'?uiText('运行时默认'):model}
function nodeSpec(run,id){
  const spec={...displayRole(run,id),...run.overrides[id]};
  return {...spec,...(run.dispatch[id]?{model:uiText('历史记录未采集'),...run.dispatch[id]}:route(run,id))};
}
// Clears a delivered node and everything downstream of it so they run again. Returns false while any of them is running.
function invalidate(run,id,feedback,running=()=>false,restart){
  const ids=[id,...Dag.descendants(run.deps,id)];
  const active=new Set(ids.filter(running));
  if(active.size&&!restart)return false;
  const previous=run.files[id]?.body||'';
  for(const k of ids){
    delete run.files[k];
    if(run.errors)delete run.errors[k];
    if(run.deferred)delete run.deferred[k];
    if(run.feedback)delete run.feedback[k];
    if(active.has(k))restart(k);
    else delete run.dispatch[k];
  }
  if(feedback)(run.feedback??={})[id]={note:feedback,previous:previous.slice(0,6000)};
  return ids;
}
function recordNode(run,id,message,time=run.time){
  (run.events[id]??=[]).push([time,message]);
}
function dispatchNode(run,id,executor){
  const {harness,model,reason}=route(run,id,executor);
  const description=nodeSpec(run,id).description;
  const inputs=run.deps[id].map(parent=>run.files[parent].title);
  run.dispatch[id]={harness,model,reason,description,inputs};
  recordNode(run,id,uiText('启动模拟运行 · ')+harness+' / '+model);
  recordNode(run,id,uiText('执行简述 · ')+description);
  recordNode(run,id,uiText('已接收 ')+(inputs.join(uiText('、'))||uiText('用户任务')));
}
function addReview(run,reason){
  if(run.family==='custom'||!run.deps.b||run.deps.review||run.progress.merge||run.files.merge)return false;
  if(!run.pack.review){const review=({radio,release,general})[run.family].review;run.pack={...run.pack,review};run.roles=run.pack}
  run.deps.review=['b'];
  recordNode(run,'review',uiText('加入当前工作流 · ')+reason);
  run.deps.merge=run.deps.merge.map(id=>id==='b'?'review':id);
  run.versions.push({deps:structuredClone(run.deps),reason});
  run.logs.unshift([run.time,uiText('工作流已调整 · 新增')+displayRole(run,'review').name,reason]);
  return true;
}
function evidence(run){
  if(run.family==='radio')return uiText('采样员发现一段录音缺少授权。声音分支增加核验，编剧继续写稿。');
  if(run.family==='release')return uiText('测试员发现旧版客户端缺少覆盖。新增兼容审查，文案分支继续执行。');
  return uiText('评审员发现一项验收条件缺少依据。新增复核，方案分支继续执行。');
}
function produce(run,id){
  const query=run.query,pack=Object.fromEntries(Object.keys(run.pack).map(id=>[id,displayRole(run,id)]));
  const deps=run.deps[id];
  const inputs=deps.map(k=>run.files[k].title);
  let body='';
  if(run.family==='custom'){body=uiText('任务　')+query+uiText('\n节点　')+pack[id].name+uiText('\n简述　')+nodeSpec(run,id).description+uiText('\n输入　')+(deps.map(k=>run.files[k].body).join('\n')||uiText('任务简报'))+uiText('\n模拟交付　')+pack[id].artifact}
  else if(id==='root'){body=uiText('目标　')+query+uiText('\n并行分工　')+Object.keys(run.deps).filter(k=>run.deps[k].includes('root')).map(k=>pack[k].artifact).join(uiText('、'))+uiText('\n最终交付　')+(run.mono?uiText('纯旁白定稿'):pack.merge.artifact)}
  else if(id==='merge'){body=uiText('任务　')+query+'\n\n'+deps.map(k=>'【'+run.files[k].title+'】\n'+run.files[k].body).join('\n\n');if(run.family==='radio'&&!run.mono){const seconds=Math.max(5,Math.min(300,Number(query.match(/(\d+)\s*秒/)?.[1]||60)));body+=uiText('\n\n制作时间码\n0–')+Math.round(seconds*.15)+uiText(' 秒　环境声淡入\n')+Math.round(seconds*.15)+'–'+Math.round(seconds*.85)+uiText(' 秒　旁白\n')+Math.round(seconds*.85)+'–'+seconds+uiText(' 秒　淡出')}}
  else if(run.family==='radio'){
    const city=/城市|散步/.test(query),noise=city?uiText('街角商店的背景乐'):uiText('末班车站内广播'),safe=city?uiText('自行车铃与脚步声'):uiText('雨点与车门轻响');
    if(id==='a')body=city?uiText('一声车铃从街角经过。放慢脚步，听听石板路上自己的回声。欢迎来到城市散步，今天从这个路口出发。'):/深夜/.test(query)?uiText('雨点敲了三下车窗。末班车在路口转弯，街道慢慢安静下来。如果你也刚结束漫长的一天，这盏灯，为你留着。'):uiText('今天的节目从这个主题开始：')+query+uiText('。让我们用一个片刻听见身边的故事。');
    if(id==='b')body=run.clear?uiText('已确认素材　')+safe+uiText('（自录）'):uiText('候选素材　')+safe+uiText('（自录）\n待核素材　')+noise+uiText('（缺少授权证明）');
    if(id==='review')body=uiText('已核对《')+inputs[0]+uiText('》。保留')+safe+uiText('，以自录环境底噪替换来源不明的录音。');
  }else if(run.family==='release'){
    if(id==='a')body=uiText('发布主题　')+query+uiText('\n订阅页新增权益说明和状态提示。用户可在账户页核对订阅状态。');
    if(id==='b')body=uiText('回归范围　首次订阅、续费和取消。\n')+(run.clear?uiText('旧版客户端验收条件已确认。'):uiText('缺口　旧版客户端的状态回显待覆盖。'));
    if(id==='review')body=run.files.b.body+uiText('\n补充　以旧版客户端验证购买、恢复购买、取消后的状态回显。');
  }else{
    if(id==='a')body=uiText('提案目标　')+query+uiText('\n先制作一份最小样例，交由目标使用者试用，再依据反馈完善交付。');
    if(id==='b')body=uiText('验收范围　覆盖目标场景、检查样例是否可用、记录未解决事项。');
    if(id==='review')body=run.files.b.body+uiText('\n补充依据　每个验收项附一份样例和对应的检查结果。');
  }
  return {title:run.mono&&id==='merge'?uiText('纯旁白定稿'):pack[id].artifact,body,inputs,time:run.time};
}
function advance(run){
  if(Dag.complete(run))return;
  const current=runnable(run),working=[];
  // Reserve all slots before advancing any node. A join first sees results on the next tick.
  for(const id of current){
    const prior=run.dispatch[id];
    const choices=prior?[runtimeInfo(prior.harness)].filter(Boolean):candidates(run,id);
    const executor=choices.find(r=>{
      const owner=leases.get(r.name);
      return !owner||(owner.flow===run&&owner.id===id);
    });
    if(!executor)continue;
    leases.set(executor.name,{flow:run,id});
    if(!prior)dispatchNode(run,id,executor);
    working.push(id);
  }
  if(!working.length)return false;
  run.started=true;run.time++;
  for(const id of working){
    run.progress[id]=(run.progress[id]||0)+1;
    if(id==='b'&&run.progress[id]===2&&!run.clear&&!run.deps.review)addReview(run,evidence(run));
    if(run.progress[id]===(work[id]||3)){
      run.files[id]=produce(run,id);
      leases.delete(run.dispatch[id].harness);
      recordNode(run,id,uiText('交付 ')+run.files[id].title);
      run.logs.unshift([run.time,uiText('{name}已交付').replace('{name}',()=>displayRole(run,id).name),run.files[id].title]);
    }
  }
  const start=runnable(run).filter(id=>!current.includes(id));
  if(start.length)run.logs.unshift([run.time,start.map(k=>displayRole(run,k).name).join(uiText(' 与 '))+(start.length>1?uiText('可并行启动'):uiText('就绪')),uiText('输入已齐备　')+[...new Set(start.flatMap(k=>run.deps[k].map(dep=>run.files[dep].title)))].join(uiText('、'))]);
  return true;
}
