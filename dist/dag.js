'use strict';
const Dag = (() => {
  const uiText = typeof module === 'object' && module.exports ? require('./i18n.js').text : BercyI18n.text;
  const validId = id => typeof id==='string' && /^[a-z][a-z0-9_]{0,39}$/.test(id) && !(id in Object.prototype);
  function levels(deps) {
    const rows=[],done=new Set(), ids=Object.keys(deps);
    if (!ids.length || ids.length>32) throw Error(uiText('每套流程支持 1 至 32 个节点'));
    for (const id of ids) {
      const parents=deps[id];
      if (!validId(id)||!Array.isArray(parents)||new Set(parents).size!==parents.length||parents.some(p=>!Object.hasOwn(deps,p))) throw Error(uiText('节点依赖无效'));
    }
    while(done.size<ids.length){
      const row=ids.filter(k=>!done.has(k)&&deps[k].every(p=>done.has(p)));
      if(!row.length)throw Error(uiText('依赖形成循环，请调整连线'));
      rows.push(row);row.forEach(k=>done.add(k));
    }
    return rows;
  }
  function delivery(role){
    if(['text','file','mixed','project'].includes(role.delivery))return role.delivery;
    return /\.(?:md|txt|pdf|docx?|pptx?|xlsx?|csv|json|png|jpe?g|webp|mp[34]|mov|webm|wav)\b|图片文件|视频文件|样片|PNG|MP4/.test(role.artifact||'')||
      /(?:生成|制作|导出|输出|保存|写入|做成|渲染)[^。；\n]{0,12}(?:\.(?:md|pdf|docx?|pptx?|xlsx?|csv|png|jpe?g|mp4|mov|wav)\b|PNG|JPE?G|MP4|PDF|图片文件|视频|音频文件|表格文件|代码文件)/.test(role.description||'')?'file':'text';
  }
  // Capabilities a node needs beyond writing text. File delivery adds "write" on its own.
  const needList=['shell','network'];
  function briefPolicy(query){
    const text=String(query||'');
    const clauses=text.split(/[。；;！？!?\n]+/);
    const automatic=/自动(?:续跑|继续(?:运行|执行|处理|做)|(?:生成|追加|新增|规划|安排)[^。；;！？!?\n]{0,32}(?:继续|执行|运行))/i;
    const negated=/(?:不要|无需|不必|禁止|不得|不允许|不需要|不能|不应|不再|不)\s*自动/;
    const followup=/(?:验收|交付|做完|完成)(?:完成|通过)?后|续跑\s*[:：]|自动(?:续跑|继续(?:执行|运行))|后续节点|新节点|下一步/;
    const autoContinue=clauses.some(clause=>automatic.test(clause)&&followup.test(clause)&&!negated.test(clause));
    const runtimes='(Codex|Claude(?:\\s+Code)?|DeepSeek\\s+Harness|OpenClaw|Pi)';
    const names=['Codex','Claude','DeepSeek Harness','OpenClaw','Pi'];
    function assigned(role,verb){
      const label=new RegExp('(?:^|[\\n。；;，,、])\\s*(?:'+role+')\\s*[:：]\\s*'+runtimes+'\\b','i');
      const actor=new RegExp('\\b'+runtimes+'\\b\\s*(?:(?:来|负责|进行|做)\\s*){0,3}(?:'+verb+')','i');
      const verbFirst=new RegExp('(?:'+verb+')\\s*(?:由|交给|使用|用)\\s*'+runtimes+'\\b','i');
      const choice=(label.exec(text)||actor.exec(text)||verbFirst.exec(text))?.[1]?.toLowerCase().replace(/\s+/g,' ').replace(/^claude code$/,'claude');
      return names.find(name=>name.toLowerCase()===choice);
    }
    return {autoContinue,planner:assigned('规划(?:模型)?|planner','规划|制定计划'),
      developer:assigned('开发|实现|developer','开发|实现|写代码'),
      reviewer:assigned('验收|复核|审查|reviewer','验收|复核|审查')};
  }
  function assignBriefRuntimes(def,policy){
    for(const [id,role] of Object.entries(def.roles)){
      const reviewer=role.review||role.stage==='verify';
      const runtime=reviewer?policy.reviewer:role.stage==='work'||role.delivery==='project'?policy.developer:undefined;
      if(runtime)(def.overrides[id]??={}).harness=runtime;
    }
    return def;
  }
  const cleanNeeds=list=>Array.isArray(list)?needList.filter(n=>list.includes(n)):[];
  function needs(role){return [...(delivery(role)==='text'?[]:['write']),...cleanNeeds(role.needs)]}
  // Repairs common planner slips before validation: odd ids, unknown or duplicate deps,
  // runtimes that are not connected, and relay-only nodes that just pass text along.
  // `known` lists ids outside this batch that deps may still point at (used when expanding a running workflow).
  function tidy(nodes,runtimeNames=[],known=[]){
    if(!Array.isArray(nodes))return {nodes,notes:[]};
    const notes=[],map=new Map(known.map(k=>[k,k])),used=new Set(known);
    let list=nodes.filter(n=>n&&typeof n==='object').map((n,i)=>{
      let id=String(n.id??'').toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^[^a-z]+/,'').slice(0,40)||'node';
      if(!validId(id))id='n_'+id;
      let unique=id;for(let k=2;used.has(unique);k++)unique=(id.slice(0,36)+'_'+k);
      used.add(unique);if(!map.has(n.id)||known.includes(n.id))map.set(n.id,unique);return {...n,id:unique,_raw:n.id};
    });
    if(list.some(n=>n.id!==n._raw))notes.push(uiText('统一了节点标识'));
    for(const n of list){
      const deps=[...new Set((Array.isArray(n.deps)?n.deps:[]).map(d=>map.get(d)).filter(d=>d&&d!==n.id))];
      if(deps.length!==(Array.isArray(n.deps)?n.deps.length:0))notes.push(uiText('去掉了「')+(n.name||n.id)+uiText('」的无效依赖'));
      n.deps=deps;delete n._raw;
      if(n.preferred&&runtimeNames.length&&!runtimeNames.includes(n.preferred)){delete n.preferred}
    }
    const relay=/转述|转交|传达|转发|搬运|原样整理|格式整理/;
    for(const n of [...list]){
      const children=list.filter(c=>c.deps.includes(n.id));
      if(list.length>1&&n.deps.length===1&&children.length===1&&delivery(n)==='text'&&relay.test((n.name||'')+(n.description||''))){
        for(const c of children)c.deps=[...new Set(c.deps.map(d=>d===n.id?n.deps[0]:d))];
        list=list.filter(x=>x!==n);notes.push(uiText('合并了只做转述的「')+n.name+'」');
      }
    }
    return {nodes:list,notes:[...new Set(notes)]};
  }
  // Cross-model review: a review node checks the work of its single upstream. Unless the user pinned a runtime,
  // runtimes other than the one that produced that work go first, so a second model looks at it.
  // With only the upstream's runtime connected, the list is returned unchanged.
  function crossReview(list,upstream){
    if(!upstream)return list;
    const others=list.filter(r=>r.name!==upstream);
    return others.length?[...others,...list.filter(r=>r.name===upstream)]:list;
  }
  // Short role name taken from the task text, for nodes the user left unnamed.
  function nameFrom(description,index){
    const head=String(description||'').trim().split(/[，。；,.;:：\n]/)[0].replace(/^(?:请|帮我|负责|根据[^，]*?，?)/,'').slice(0,10);
    return head||uiText('节点 ')+(index+1);
  }
  // Relative paths only, no parent references; directories end with "/".
  const cleanPath=p=>typeof p==='string'&&p.trim()&&!/(^|[\\/])\.\.([\\/]|$)/.test(p)&&!/^([\\/]|[a-z]:)/i.test(p.trim())?p.trim().replace(/\\/g,'/').slice(0,160):null;
  const cleanPaths=list=>Array.isArray(list)?[...new Set(list.map(cleanPath).filter(Boolean))].slice(0,12):[];
  function cleanWorkspace(ws){
    if(!ws||typeof ws!=='object')return null;
    const layout=(Array.isArray(ws.layout)?ws.layout:[]).map(l=>({path:cleanPath(l?.path),purpose:String(l?.purpose||'').slice(0,200)})).filter(l=>l.path).slice(0,40);
    return {layout,conventions:String(ws.conventions||'').slice(0,4000),run:String(ws.run||'').slice(0,1000),check:String(ws.check||'').replace(/[\r\n]+/g,' ').trim().slice(0,300)};
  }
  function roleOf(n,index){
    const fallback=!n.deps?.length?'lead':n.deps.length>1?'mix':index%2?'writer':'scout';
    const r={name:n.name.trim().slice(0,80),description:String(n.description||'').slice(0,2400),artifact:n.artifact.trim().slice(0,120),delivery:delivery(n),avatar:['lead','writer','scout','check','mix'].includes(n.avatar)?n.avatar:fallback,harness:n.preferred||''};
    if(n.checks && r.delivery==='text'){
      const {maxChars,json,requiredKeys}=n.checks,checks={};
      if(Number.isSafeInteger(maxChars)&&maxChars>0)checks.maxChars=maxChars;
      if(json===true)checks.json=true;
      if(Array.isArray(requiredKeys))checks.requiredKeys=[...new Set(requiredKeys.filter(k=>typeof k==='string'&&k.length>0&&k.length<=120))].slice(0,32);
      if(Object.keys(checks).length)r.checks=checks;
    }
    const want=cleanNeeds(n.needs);if(want.length)r.needs=want;
    if(n.review===true)r.review=true;
    if(n.stage==='work'||n.stage==='verify')r.stage=n.stage;
    if(n.offline===true)r.offline=true;
    if(n.expand===true)r.expand=true;
    if(n.continueAfter===true)r.continueAfter=true;
    if(typeof n.when==='string'&&n.when.trim())r.when=n.when.trim().slice(0,300);
    const paths=cleanPaths(n.paths);if(paths.length)r.paths=paths;
    return r;
  }
  function verification(role){
    return !!(role?.review||role?.stage==='verify'||(!role?.stage&&/验收|复核|审查|验证|\b(?:review|verification|verify|acceptance)\b/i.test(role?.name||'')));
  }
  function observerReturn(flow,source,delivery,proposal,terminal=false){
    const id=proposal?.id, evidence=String(proposal?.evidence||'').trim(), reason=String(proposal?.reason||'').trim();
    const gaps=String(delivery?.gaps||'').trim();
    if(!validId(id)||!Object.hasOwn(flow.files,id)||flow.files[id].skipped||!evidence||!reason||!gaps.includes(evidence))return null;
    if(terminal?!descendants(flow.deps,id).includes(source):id!==source)return null;
    const gap=gaps.replace(/\s/g,'').slice(0,1600),quote=evidence.replace(/\s/g,'').slice(0,600);
    if((flow.observerReturns||[]).some(r=>r.id===id&&(r.gap===gap||r.quote===quote)))return null;
    return {id,gap,quote,evidence:evidence.slice(0,600),reason:reason.slice(0,1200)};
  }
  function definition(nodes,workspace){
    if(!Array.isArray(nodes)||nodes.some(n=>!validId(n?.id)||typeof n.name!=='string'||!n.name.trim()||typeof n.artifact!=='string'||!n.artifact.trim())||new Set(nodes.map(n=>n.id)).size!==nodes.length)throw Error(uiText('节点需要唯一标识、角色名和交付物'));
    const roles={},deps={},overrides={};
    for(const [index,n] of nodes.entries()){
      roles[n.id]=roleOf(n,index);deps[n.id]=n.deps;
      if(n.runtime)overrides[n.id]={harness:n.runtime,...(n.model?{model:n.model}:{})};
    }
    const notes=serializeOverlaps(deps,roles);
    levels(deps);
    const project=Object.values(roles).some(r=>r.delivery==='project');
    return {family:'custom',mono:false,roles,deps,overrides,...(notes.length?{notes}:{}),...(project?{workspace:cleanWorkspace(workspace)||{layout:[],conventions:'',run:'',check:''}}:{})};
  }
  // Workflow files (.bercy.json) let people share a saved workflow. Only the definition travels: never past
  // task text, results or files. Reading one treats it as untrusted and rebuilds it through `definition`.
  const fileFormat=1;
  function toFile(name,def){
    return {bercy:'workflow',format:fileFormat,name:String(name||'').slice(0,240),definition:structuredClone(def)};
  }
  function fromFile(data){
    if(!data||typeof data!=='object'||data.bercy!=='workflow')throw Error(uiText('这不是 Bercy 工作流文件'));
    if(data.format!==fileFormat)throw Error(uiText('工作流文件的版本不受支持'));
    const d=data.definition,name=typeof data.name==='string'&&data.name.trim()?data.name.trim().slice(0,240):'';
    if(!name||!d||typeof d!=='object'||!d.roles||typeof d.roles!=='object'||!d.deps||typeof d.deps!=='object')throw Error(uiText('工作流文件内容不完整'));
    const text=v=>typeof v==='string'?v:'';
    const nodes=Object.keys(d.deps).map(id=>{
      const r=d.roles[id];if(!r||typeof r!=='object')throw Error(uiText('工作流文件内容不完整'));
      const o=d.overrides?.[id]&&typeof d.overrides[id]==='object'?d.overrides[id]:{};
      return {id,name:text(r.name),description:text(o.description)||text(r.description),artifact:text(r.artifact),delivery:r.delivery,checks:r.checks,avatar:r.avatar,needs:r.needs,
        review:o.review??r.review,offline:o.offline??r.offline,expand:r.expand,continueAfter:o.continueAfter??r.continueAfter,stage:r.stage,when:r.when,paths:r.paths,preferred:text(r.harness).slice(0,80),
        runtime:text(o.harness).slice(0,80),model:text(o.model).slice(0,120),deps:Array.isArray(d.deps[id])?d.deps[id]:[]};
    });
    const def=definition(nodes,d.workspace);
    return {name,definition:d.mode==='structure'?stripBriefs(def):{...def,mode:'full'}};
  }
  function descendants(deps,id){
    const out=new Set([id]);let grew=true;
    while(grew){grew=false;for(const [k,ps] of Object.entries(deps))if(!out.has(k)&&ps.some(p=>out.has(p))){out.add(k);grew=true}}
    out.delete(id);return [...out];
  }
  const complete=flow=>Object.keys(flow.deps).every(id=>!!flow.files[id]);
  function outputs(deps){const used=new Set(Object.values(deps).flat());return Object.keys(deps).filter(id=>!used.has(id))}
  function stripBriefs(def){
    const d=structuredClone(def);
    d.roles=Object.fromEntries(Object.keys(d.deps).map(id=>{const {description,checks,...role}=d.roles[id];return [id,role]}));
    for(const o of Object.values(d.overrides))delete o.description;
    d.mode='structure';return d;
  }
  // Adds the nodes an expandable node's breakdown calls for. Limits: nodes per expansion, total nodes, depth.
  // Successors of `from` that have not started now also wait for every new sink node.
  const limits={perExpansion:8,total:32,depth:2,expansions:6,continuationNodes:4};
  function usedContinuation(flow){
    if(flow.continuationFrom)return true;
    // Older runs can already have follow-up nodes without the persisted marker.
    return Object.values(flow.pack||flow.roles||{}).some(role=>role.origin&&flow.files?.[role.origin]?.observation?.continuation);
  }
  function checkedContinuation(delivery,plan,{manual=false,instruction='',history=[]}={}){
    if(delivery.needsInput||(!manual&&delivery.verificationPending)||!Array.isArray(plan?.nodes)||
       !plan.nodes.length||plan.nodes.length>limits.continuationNodes)return null;
    const normalized=value=>typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
    const source=normalized([delivery.body,delivery.gaps].filter(Boolean).join('\n'));
    const quoteSource=normalized([source,manual?instruction:''].filter(Boolean).join('\n'));
    const key=value=>normalized(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,'');
    const progress=normalized(plan.progressEvidence);
    if(!manual&&history.length&&(progress.length<8||!source.includes(progress)||
       history.some(batch=>key(batch.progressEvidence)===key(progress))))return null;
    const prior=manual?[]:history.flatMap(batch=>batch.nodes);
    const ids=new Set(),quotes=new Map();
    for(const node of plan.nodes){
      const quote=normalized(node?.evidence),criteria=normalized(node?.acceptance);
      if(!node||!validId(node.id)||ids.has(node.id)||!normalized(node.name)||!normalized(node.artifact)||
         !normalized(node.description)||!Array.isArray(node.deps)||node.deps.some(dep=>!ids.has(dep))||
         quote.length<(manual&&instruction?Math.min(8,normalized(instruction).length):8)||quote.length>300||!quoteSource.includes(quote)||
         criteria.length<8||criteria.length>600)return null;
      if(prior.some(old=>key(old.evidence)===key(quote)||
         (key(old.name)===key(node.name)&&key(old.acceptance)===key(criteria))))return null;
      if(!manual&&history.length&&key(progress)===key(quote))return null;
      const previous=quotes.get(quote);
      if(previous&&(node.stage!=='verify'||previous.verified||!node.deps.includes(previous.id)))return null;
      if(previous)previous.verified=true;
      else quotes.set(quote,{id:node.id,verified:false});
      ids.add(node.id);
    }
    return plan;
  }
  // Project nodes that may run at the same time must not own overlapping paths (or both own the whole project).
  // Overlaps are resolved by making the later node wait for the earlier one.
  function ancestors(deps,id){const out=new Set(),stack=[...(deps[id]||[])];while(stack.length){const p=stack.pop();if(!out.has(p)){out.add(p);stack.push(...(deps[p]||[]))}}return out}
  const overlap=(a=[],b=[])=>!a.length||!b.length||a.some(x=>b.some(y=>x.startsWith(y)||y.startsWith(x)));
  function serializeOverlaps(deps,roles,ids=Object.keys(deps)){
    const notes=[],project=ids.filter(k=>roles[k]?.delivery==='project');
    for(let i=0;i<project.length;i++)for(let j=i+1;j<project.length;j++){
      const a=project[i],b=project[j];
      if(ancestors(deps,a).has(b)||ancestors(deps,b).has(a))continue;
      if(overlap(roles[a].paths,roles[b].paths)){deps[b]=[...new Set([...deps[b],a])];notes.push('「'+roles[b].name+uiText('」与「')+roles[a].name+uiText('」负责的路径重叠，改为先后执行'))}
    }
    return notes;
  }
  function expand(flow,from,change,{continuation=false}={}){
    if((!continuation&&usedContinuation(flow))||!change||!Array.isArray(change.nodes)||!change.nodes.length)return false;
    if(continuation&&change.nodes.length>limits.continuationNodes)return false;
    const origin=flow.pack[from],depth=(origin.depth||0)+1,ids=Object.keys(flow.deps);
    if(!continuation&&(depth>limits.depth||(flow.expansions||0)>=limits.expansions))return false;
    const room=continuation?limits.continuationNodes:Math.min(limits.perExpansion,limits.total-ids.length);
    if(room<1)return false;
    const delivered=ids.filter(k=>flow.files[k]);
    let {nodes}=tidy(change.nodes.slice(0,room).map(n=>({...n,deps:(Array.isArray(n.deps)?n.deps:[])})),[],ids);
    nodes=nodes.filter(n=>typeof n.name==='string'&&n.name.trim()&&typeof n.artifact==='string'&&n.artifact.trim());
    if(!nodes.length)return false;
    const fresh=new Set(nodes.map(n=>n.id));
    for(const n of nodes){n.deps=n.deps.filter(d=>fresh.has(d)||delivered.includes(d));if(!n.deps.some(d=>fresh.has(d)))n.deps=[...new Set([from,...(continuation?outputs(flow.deps):[]),...n.deps])]}
    const sinks=nodes.filter(n=>!nodes.some(m=>m.deps.includes(n.id))).map(n=>n.id);
    const next=structuredClone(flow.deps);
    for(const n of nodes)next[n.id]=n.deps;
    for(const k of ids)if(next[k].includes(from)&&!flow.files[k]&&!flow.dispatch[k])next[k]=[...new Set([...next[k],...sinks])];
    const pack={...flow.pack};
    nodes.forEach((n,i)=>{
      const r=roleOf({...n,expand:!continuation&&n.expand===true&&depth<limits.depth,continueAfter:false},i);
      r.depth=depth;r.origin=from;pack[n.id]=r;
    });
    // New nodes may not collide with each other or with project nodes that have not run yet.
    const pending=Object.keys(next).filter(k=>!flow.files[k]&&!flow.dispatch[k]);
    const notes=serializeOverlaps(next,pack,pending);
    levels(next);
    flow.deps=next;flow.pack=pack;flow.roles=pack;
    if(!continuation)flow.expansions=(flow.expansions||0)+1;
    const ws=cleanWorkspace(change.workspace);
    if(ws&&(ws.layout.length||ws.conventions)){
      const cur=flow.workspace||{layout:[],conventions:'',run:''};
      flow.workspace={...cur,layout:[...cur.layout,...ws.layout.filter(l=>!cur.layout.some(c=>c.path===l.path))],conventions:[cur.conventions,ws.conventions].filter(Boolean).join('\n'),check:cur.check||ws.check};
    }else if(nodes.some(n=>delivery(n)==='project')&&!flow.workspace)flow.workspace={layout:[],conventions:'',run:''};
    flow.versions.push({deps:structuredClone(next),reason:uiText('展开「')+origin.name+'」：'+String(change.reason||uiText('按拆解新增节点')).slice(0,300)});
    if(continuation)flow.continuationFrom=from;
    flow.expandNotes=notes;
    return nodes.map(n=>n.id);
  }
  function patch(flow,from,change,blocked=false){
    if(usedContinuation(flow)||!change||['reason','name','description','artifact'].some(k=>typeof change[k]!=='string'||!change[k].trim())||!Array.isArray(change.before)||!change.before.length)return false;
    const targets=[...new Set(change.before)];
    if(flow.versions.filter(v=>!v.live).length>=3||Object.keys(flow.deps).length>=32||targets.some(k=>!Object.hasOwn(flow.deps,k)||(blocked?k!==from:!flow.deps[k].includes(from))||flow.dispatch[k]||flow.files[k]))return false;
    const id='extra_'+flow.versions.length, next=structuredClone(flow.deps);
    if(Object.hasOwn(next,id))return false;
    next[id]=blocked?[...next[from]]:[from];
    for(const target of targets)next[target]=[...next[target],id];
    levels(next);flow.deps=next;
    flow.pack={...flow.pack,[id]:{name:change.name.slice(0,80),description:change.description.slice(0,1600),artifact:change.artifact.slice(0,120),delivery:delivery(change),avatar:'check',harness:'',...(cleanNeeds(change.needs).length?{needs:cleanNeeds(change.needs)}:{})}};
    flow.roles=flow.pack;
    flow.versions.push({deps:structuredClone(next),reason:change.reason.slice(0,400)});
    return id;
  }
  // Live changes to a running workflow: one atomic batch of add / skip / modify operations.
  // Every op is validated against the graph as it is now (optimistic: a batch computed from an older
  // version still applies wherever its targets are untouched), so callers never wait on each other.
  // Delivered nodes are never touched. A running node is restarted if it began less than `window` ms ago (or `fresh` says
  // it started from inputs the change revises);
  // after that a change to it is deferred (it reruns with the change once it delivers) and a skip is refused.
  // Returns {version, applied, restart, defer, rejected}; nothing changes when no op applies.
  const revision=flow=>flow.versions.length;
  function apply(flow,ops,{reason='',base=null,elapsed=()=>null,window=60000,fresh=()=>false}={}){
    const out={version:revision(flow),stale:base!=null&&base!==revision(flow),applied:[],restart:[],defer:{},rejected:[]};
    if(!Array.isArray(ops)||!ops.length)return out;
    const next=structuredClone(flow.deps),pack={...flow.pack},skipped={},restart=new Set(),defer={},orig={};
    // The plan as it was before any live change, per node, so saving the workflow keeps the original (see planned()).
    const keep=k=>{if(!flow.pack[k]?.live&&Object.hasOwn(flow.deps,k)&&!flow.liveOriginal?.[k])orig[k]??={deps:structuredClone(flow.deps[k]),role:structuredClone(flow.pack[k])}};
    const done=k=>!!flow.files[k]||!!skipped[k],running=k=>!!flow.dispatch[k]&&!flow.files[k];
    const young=k=>{if(fresh(k))return true;const ms=elapsed(k);return ms!=null&&ms<window};
    // Final outputs still to come; a skipped node keeps no children, so it is no output.
    const sinks=()=>outputs(next).filter(k=>!skipped[k]&&!flow.files[k]?.skipped);
    // Whether node k may change now: 'now' (idle), 'restart' (running, young), 'defer' (running, old) or a refusal reason.
    const access=k=>!Object.hasOwn(next,k)?'unknown':done(k)?'delivered':!running(k)?'now':young(k)?'restart':'defer';
    const reject=(op,why)=>out.rejected.push({op,why});
    for(const op of ops){
      const kind=op?.op,why=String(op?.reason||reason).slice(0,400);
      if(kind==='skip'){
        const k=op.id,a=access(k);
        if(a!=='now'&&a!=='restart'){reject(op,a==='defer'?'running':a);continue}
        // An output may go only while another output remains, so the workflow still delivers something.
        if(sinks().includes(k)&&sinks().length<2){reject(op,'output');continue}
        for(const c of Object.keys(next))if(next[c].includes(k))keep(c),next[c]=[...new Set(next[c].flatMap(p=>p===k?next[k]:[p]))];
        skipped[k]=why;if(a==='restart')restart.add(k);out.applied.push({op:'skip',id:k,reason:why});
      }else if(kind==='modify'){
        const k=op.id,a=access(k);
        if(!['now','restart','defer'].includes(a)){reject(op,a);continue}
        const set=op.set&&typeof op.set==='object'?op.set:{},role={...pack[k]};
        for(const f of ['name','description','artifact'])if(typeof set[f]==='string'&&set[f].trim())role[f]=set[f].trim().slice(0,f==='description'?2400:f==='name'?80:120);
        if(typeof set.harness==='string')role.harness=set.harness;
        if(Array.isArray(set.needs)){const n=cleanNeeds(set.needs);if(n.length)role.needs=n;else delete role.needs}
        if(Array.isArray(set.paths)){const p=cleanPaths(set.paths);if(p.length)role.paths=p;else delete role.paths}
        if(typeof set.when==='string'){if(set.when.trim())role.when=set.when.trim().slice(0,300);else delete role.when}
        let deps=next[k];
        if(Array.isArray(op.deps)){
          deps=[...new Set(op.deps)];
          if(deps.some(d=>d===k||!Object.hasOwn(next,d))){reject(op,'deps');continue}
        }
        const changed=JSON.stringify(role)!==JSON.stringify(pack[k])||JSON.stringify(deps)!==JSON.stringify(next[k]);
        if(!changed)continue;
        keep(k);pack[k]=role;next[k]=deps;
        if(a==='restart')restart.add(k);else if(a==='defer')defer[k]=why;
        out.applied.push({op:'modify',id:k,reason:why});
      }else if(kind==='add'){
        if(Object.keys(next).length>=limits.total){reject(op,'full');continue}
        if(['name','description','artifact'].some(f=>typeof op[f]!=='string'||!op[f].trim())){reject(op,'fields');continue}
        const after=[...new Set(Array.isArray(op.after)?op.after:[])],before=[...new Set(Array.isArray(op.before)?op.before:[])];
        if(after.some(d=>!Object.hasOwn(next,d)||skipped[d])){reject(op,'deps');continue}
        // Targets that already delivered or ran too long to restart drop out; the node still joins if any target remains (or none was asked).
        const targets=before.filter(t=>['now','restart'].includes(access(t)));
        if(before.length&&!targets.length){reject(op,'targets');continue}
        if(op.stage==='verify'&&after.length){
          const coverage=after.map(id=>new Set(descendants(next,id)));
          if(Object.keys(next).some(k=>!done(k)&&verification(pack[k])&&coverage.every(set=>set.has(k)))){reject(op,'existing-verification');continue}
        }
        let id=String(op.id||'').toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^[^a-z]+/,'').slice(0,36)||'live';
        if(!validId(id))id='n_'+id;
        let unique=id;for(let i=2;Object.hasOwn(next,unique);i++)unique=id+'_'+i;
        next[unique]=after;
        for(const t of targets){keep(t);next[t]=[...next[t],unique];if(access(t)==='restart')restart.add(t)}
        pack[unique]=roleOf({...op,deps:after,expand:false,review:false},Object.keys(next).length);pack[unique].live=true;
        out.applied.push({op:'add',id:unique,reason:why});
      }else reject(op,'op');
    }
    if(!out.applied.length)return out;
    try{levels(next)}catch(err){out.rejected.push(...out.applied.map(a=>({op:a,why:'cycle'})));out.applied=[];return out}
    const pending=Object.keys(next).filter(k=>!done(k)&&!running(k));
    const notes=serializeOverlaps(next,pack,pending);
    flow.deps=next;flow.pack=pack;flow.roles=pack;
    if(Object.keys(orig).length)flow.liveOriginal={...orig,...flow.liveOriginal};
    for(const [k,why] of Object.entries(skipped))flow.files[k]={skipped:true,reason:why,title:pack[k].artifact,body:'',summary:'',gaps:'',delivery:'text',time:flow.time,inputs:[],artifacts:[]};
    if(Object.keys(defer).length)Object.assign(flow.deferred??={},defer);
    flow.versions.push({deps:structuredClone(next),reason:String(reason||out.applied.map(a=>a.reason).filter(Boolean).join('；')||uiText('执行中调整')).slice(0,400),live:out.applied.map(a=>({op:a.op,id:a.id}))});
    out.version=revision(flow);out.restart=[...restart];out.defer=defer;out.notes=notes;
    return out;
  }
  // The workflow without its live changes: live-added nodes dropped, touched nodes back to their planned role and deps.
  // Saving to the library and running a finished workflow again start from this, never from one run's adjustments.
  function planned(flow,deps=flow.deps){
    const orig=flow.liveOriginal||{},live=new Set(Object.keys(flow.pack).filter(k=>flow.pack[k]?.live)),out={},pack={};
    for(const k of Object.keys(deps)){
      if(live.has(k))continue;
      out[k]=(orig[k]?.deps??deps[k]).filter(d=>!live.has(d)&&Object.hasOwn(deps,d));
      pack[k]=orig[k]?.role??flow.pack[k];
    }
    return {deps:out,pack};
  }
  return {crossReview,toFile,fromFile,planned,levels,descendants,tidy,nameFrom,definition,expand,briefPolicy,assignBriefRuntimes,usedContinuation,checkedContinuation,verification,observerReturn,limits,cleanWorkspace,cleanPaths,delivery,needs,cleanNeeds,needList,outputs,complete,stripBriefs,patch,apply,revision};
})();
if(typeof module!=='undefined')module.exports=Dag;
