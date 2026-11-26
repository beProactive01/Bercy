// Sample manifests returned by the demo runtime connections. No credentials or host processes are accessed.
const runtimes = [
  {name:'Codex', skill:'写代码、跑命令和测试、浏览器操控、电脑操控', adapter:'app-server', icon:'source-codex.png', models:['GPT-5.4','GPT-5.4 mini'], caps:['write','shell','network'], strengths:['工作区文件','验证清单'], tools:['文本交付','结构化汇总','工作区文件','验证清单']},
  {name:'Claude', skill:'长文写作、分析推理、复杂代码修改与审查', adapter:'Agent SDK', icon:'source-claude.svg', models:['Claude Sonnet 4.6','Claude Opus 4.6'], caps:['write','network'], strengths:['长文编排','材料复核'], tools:['文本交付','结构化汇总','长文编排','材料复核']},
  {name:'OpenClaw', skill:'联网检索、浏览网页、调用外部工具和服务', adapter:'Gateway', icon:'source-openclaw.svg', models:['openai/gpt-5.4','anthropic/claude-sonnet-4-6'], caps:['write','shell','network'], strengths:['素材连接器','材料复核'], tools:['文本交付','结构化汇总','素材连接器','材料复核']},
  {name:'DeepSeek Harness', skill:'中文写作与资料整理，适合量大的文字活', adapter:'ACP · stdio', icon:'source-deepseek.svg', models:['deepseek-flash','deepseek-v4-pro'], caps:['write'], strengths:['验证清单','长文编排'], tools:['文本交付','结构化汇总','验证清单','长文编排']},
  {name:'Pi', skill:'精简的编码代理，读写文件、按需运行命令，可接入多家模型', adapter:'JSON events', icon:'source-pi.svg', models:['运行时默认'], caps:['write','shell'], strengths:['工作区文件','验证清单'], tools:['文本交付','结构化汇总','工作区文件','验证清单']}
];
function initialConnections(existing=false){
  return Object.fromEntries(runtimes.map((r,i)=>[r.name,{online:(existing&&i<3)||i===0,model:r.models[0]}]));
}
function runtimeInfo(name){return runtimes.find(r=>r.name===name)}
// What a runtime is good at, as the planner sees it: the user's own words, or the built-in default.
function skillOf(r){
  const saved=db.settings?.skills?.[r.name];
  const own=typeof saved==='string'?saved.trim():'';
  return own && own!==r.skill ? own : uiText(r.skill)||'';
}
function requirements(flow,id){
  const interests={root:'长文编排',a:'长文编排',b:flow.family==='release'?'验证清单':'素材连接器',review:'材料复核',merge:'工作区文件'};
  return {required:id==='merge'?'结构化汇总':'文本交付',preferred:interests[id]};
}
const capLabels={write:uiText('写文件'),shell:uiText('执行命令'),network:uiText('联网')};
// Running commands is a hard requirement used for routing; going online is on by default and can be turned off per node.
function needsField(role,attr){return '<div class="need-picks"><label><input type="checkbox" '+attr+'="shell" '+(Dag.cleanNeeds(role.needs).includes('shell')?'checked':'')+uiText('>需要执行命令</label><label><input type="checkbox" ')+attr+'-online '+(role.offline?'':'checked')+uiText('>允许联网</label></div>')}
// Execution needs: routing needs plus network unless the node is offline.
function runNeeds(flow,id){const spec={...flow.pack[id],...flow.overrides[id]};return [...new Set([...nodeNeeds(flow,id),...(spec.offline?[]:['network'])])].filter(c=>c!=='network'||!spec.offline)}
const capText=list=>list.map(c=>uiText(capLabels[c])||c).join(uiText('、'));
function nodeNeeds(flow,id){return Dag.needs({...flow.pack[id],...flow.overrides[id]})}
// Needs that the given runtime (or, without one, every connected runtime) cannot cover.
function missingCaps(flow,id,runtime){
  const want=nodeNeeds(flow,id);
  if(runtime)return want.filter(c=>!(runtime.caps||[]).includes(c));
  const online=runtimes.filter(r=>db.connections[r.name].online);
  return want.filter(c=>!online.some(r=>(r.caps||[]).includes(c)));
}
function candidates(flow,id,override=flow.overrides[id]||{}){
  const config=db.connections,need=requirements(flow,id),want=nodeNeeds(flow,id);
  // A runtime the user pinned is kept even when it lacks a capability; the route note warns instead.
  const candidatesList=runtimes.filter(r=>config[r.name].online&&r.tools.includes(need.required)&&
    (override.harness?override.harness===r.name:want.every(c=>(r.caps||[]).includes(c)))&&(!override.model||r.models.includes(override.model)))
    .sort((a,b)=>Number(a.account?.signedIn===false)-Number(b.account?.signedIn===false)||Number(b.name===flow.pack[id].harness)-Number(a.name===flow.pack[id].harness)||Number(b.strengths.includes(need.preferred))-Number(a.strengths.includes(need.preferred)));
  if(window.relayHost&&!override.harness){
    const parentFiles=(flow.deps[id]||[]).flatMap(p=>flow.files[p]?.artifacts||[]);
    const rootFiles=db.sessions.find(s=>s.flow===flow)?.attachments||[];
    const image=[...parentFiles,...rootFiles,...(flow.extraInputs?.[id]||[])].some(a=>a.type?.startsWith('image/'));
    const visual=image?candidatesList.filter(r=>r.supportsImages):[];if(visual.length)return override.harness?visual:Dag.crossReview(visual,reviewedBy(flow,id));
  }
  return override.harness?candidatesList:Dag.crossReview(candidatesList,reviewedBy(flow,id));
}
// For a review node: the runtime that produced (or is set to produce) the single upstream result it checks.
function reviewedBy(flow,id){
  const spec={...flow.pack[id],...flow.overrides[id]},parents=flow.deps[id]||[];
  if(!spec.review||parents.length!==1)return '';
  const p=parents[0];return flow.dispatch?.[p]?.harness||flow.overrides[p]?.harness||'';
}
const leases=new Map();
// On the desktop each running node holds one slot (keyed by its run key); a runtime takes up to
// `settings.parallel` nodes at once. The browser demo keeps one slot per runtime in `leases`.
const hostLeases=new Map();
function slotLimit(){return Math.max(1,Math.min(4,Math.round(Number(db.settings?.parallel)||defaultSettings.parallel)))}
function busy(name){
  if(!window.relayHost)return leases.has(name);
  let n=0;for(const r of hostLeases.values())if(r===name)n++;
  return n>=slotLimit();
}
function releaseSlots(flow){
  for(const [name,slot] of leases)if(slot.flow===flow)leases.delete(name);
}
function route(flow,id,executor){
  const pinned=flow.overrides[id]||{};
  const list=candidates(flow,id),selected=executor||list[0],need=requirements(flow,id);
  if(!selected){const lack=missingCaps(flow,id);return {harness:pinned.harness||uiText('待连接'),model:pinned.model||'—',reason:pinned.harness?uiText('指定的运行时或模型当前不可用。'):lack.length?uiText('节点需要「')+capText(lack)+uiText('」，已连接的运行时都不具备。'):uiText('连接一个支持')+uiText(need.required)+uiText('的运行时。'),available:false}}
  const lack=pinned.harness?missingCaps(flow,id,selected):[];
  const upstream=pinned.harness?'':reviewedBy(flow,id);
  if(upstream){
    const reason=selected.name!==upstream?uiText('交叉审查：上游由 ')+upstream+uiText(' 完成，改由 ')+selected.name+uiText(' 复核。'):
      uiText('审查与上游使用同一运行时。再连接一个运行时，就能让另一个模型交叉审查。');
    return {harness:selected.name,model:pinned.model||db.connections[selected.name].model,reason,available:true,cross:selected.name!==upstream};
  }
  const reason=pinned.harness?(lack.length?uiText('手动指定运行时。注意：此运行时不具备「')+capText(lack)+uiText('」，执行可能失败。'):uiText('手动指定运行时。')):selected.strengths.includes(need.preferred)?uiText('节点优先使用「')+uiText(need.preferred)+uiText('」，此连接提供该能力。'):
    list[0]!==selected?uiText('优先连接的执行槽已占用，使用可交付同类产物的空闲连接。'):uiText('当前连接支持节点需要的「')+uiText(need.required)+uiText('」。');
  return {harness:selected.name,model:pinned.model||db.connections[selected.name].model,reason,available:true};
}
