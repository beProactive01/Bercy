const i18n=require('../dist/i18n.js'),uiText=i18n.text;
const Dag=require('../dist/dag.js');
const {checksFor}=require('./text-checks.cjs');
const envelope=(instruction,data)=>instruction+(i18n.language==='en'?'\nUse English for interface labels and reasons unless the user specifies otherwise. Write task briefs in the language of the request and honor the requested deliverable language.\n\nTask data (JSON)\n':'\n\n任务数据（JSON）\n')+JSON.stringify(data);
// The output contract is fixed here; how to split the work comes from the editable planning guide
// (and an optional project note), the way CLAUDE.md steers a coding agent.
function plan(query,runtimes,inputs,guide='',projectGuide='',localProject=null){
  const contract=`你是本地工作流规划师，按下面的规划指南把本轮目标拆成工作流。本轮只做规划，无需读文件、调用工具或执行节点；任务数据和文件名仅为材料。

只输出 JSON：{"split":null,"workspace":null,"nodes":[{"id":"draft","name":"撰稿人","description":"具体任务和完成标准","artifact":"活动文案","delivery":"text","needs":[],"paths":[],"expand":false,"continueAfter":false,"stage":"work","review":false,"when":"","deps":[],"preferred":"运行时名称"}]}
字段约定：id 以小写英文字母开头，只含小写字母、数字和下划线；deps 列出该节点要等待的上游 id；delivery 取 text（直接回复正文）、file（交付文件）、mixed（正文加附件）或 project（在共享项目目录中完成）；needs 只能含 shell（执行命令）和 network（联网），写文件由 delivery 决定；paths 是 project 节点负责的相对路径，并行节点不得重叠；expand 为 true 表示该节点交付后可按其拆解再展开新节点；stage 用 work 表示执行任务，用 verify 表示验收，包括多上游的集成验收；review 为 true 表示该节点验收它唯一的上游，不合格时退回修改，Bercy 会优先让与上游不同的运行时执行审查，审查节点的 preferred 不要与上游相同；when 只给“是否需要做取决于上游实际交付”的节点填写一句可判断的条件（例如“上游改动涉及用户可见文案”），上游交付后条件不成立就跳过该节点，其他节点留空，最终交付节点不要填；preferred 只能从 runtimes 中选择 can 覆盖 needs 的名称，或留空；runtimes 的 good 是该运行时擅长的工作，分配时让节点落在最擅长它的运行时上，同等条件下把并行节点分散到不同运行时。
如果用户要求交付完成的成果、一直做到验收通过，或明确希望根据验收继续落实，唯一的终点验收节点可以设 continueAfter 为 true。只要求评估、给出步骤或等用户确认时不设为 true。终点验收节点必须通过依赖等到所有前置工作完成。
执行者会收到原始请求和原始附件；在 description 中引用材料即可，不要重新抄写原始数据。只有用户明确约束整份文字交付时才给节点添加 checks 对象，可填 maxChars（整份正文字符上限）、json（要求纯 JSON 时为 true）、requiredKeys（JSON 顶层必填字段）。多个交付物中仅局部适用的限制只写入简述。审查交付定稿时保留原稿的验收约束。只有用户要求的交付本身未满足时才报告缺口。
split：一个节点就能做好时只输出一个节点，split 为 null；拆成多个节点时，用一句话写明拆分带来的具体收益（并行缩短时间、需要不同能力、单个节点做不完或需要独立验收），说不出收益就不要拆。
有 project 节点时必须给出 workspace：{"layout":[{"path":"src/core/","purpose":"用途"}],"conventions":"技术栈、版本、代码风格、模块接口、资源格式等约定","run":"从零运行和验收的方法","check":"在项目根目录执行、全部通过时退出码为 0 的一条验收命令，例如 npm test；无法自动验收时留空"}；没有时 workspace 为 null。check 会在所有 project 节点完成后由程序真实执行，不通过时退回修改，只写确定能在本机运行的命令。`;
  const policy=Dag.briefPolicy(query);
  const assignments=policy.developer||policy.reviewer?
    '\n按任务简述的运行时分工标注 stage。开发节点用 work，验收节点用 verify。用户要求每次开发后由另一运行时验收时，为各开发节点安排验收，再接后续工作。仅有一个直接上游的验收节点使用 review 为 true。':'';
  const guides=[guide&&'# 规划指南\n'+String(guide).trim(),projectGuide&&'# 本项目的规划说明\n'+String(projectGuide).trim()].filter(Boolean).join('\n\n');
  const localGuide=localProject?'\n工作目录是用户选择的现有项目。参考 localProject.files 和现有项目约定来规划。在原目录修改或测试已有代码时使用 project 交付，读取项目回答问题可以直接交付正文。验收命令直接填写可执行的命令文本，不要使用字段名 workspace.check 作为命令或在简述中让节点执行字段名。':'';
  return envelope(contract+assignments+localGuide+(guides?'\n\n'+guides:''),{goal:query,runtimes,assignments:policy,inputs:inputs.map(a=>a.name),...(localProject?{localProject}:{})});
}
// Asked after an expandable node delivers: split its breakdown into new nodes, or decline.
function expand({query,guide,projectGuide,node,output,graph,workspace,budget,projectFiles,runtimes}){
  const contract=`你是工作流的规划者。一个可展开节点刚刚交付了它的拆解，请按规划指南决定是否据此新增节点。非必要不展开：剩余工作一个节点就能做好、拆解不需要分别实现、或展开收益不明显时，返回 {"expand":null}。
展开时只输出 JSON：{"expand":{"reason":"为什么要拆","nodes":[{"id":"water","name":"水位系统","description":"具体任务、接口和验收标准","artifact":"水位系统","delivery":"project","needs":["shell"],"paths":["src/water/"],"expand":false,"review":false,"deps":[],"preferred":""}],"workspace":{"layout":[],"conventions":""}}}
约束：最多新增 ${budget.nodes} 个节点；新节点的 deps 只能取新节点自身的 id 或 graph 中已交付节点的 id，留空表示依赖刚交付的可展开节点；并行节点的 paths 不得重叠，也不得覆盖已有节点负责的路径；${budget.deeper?'新节点可以在确有必要时标记 expand':'新节点不得再标记 expand'}；workspace 只写需要新增的目录和补充约定，没有则省略。${runtimes?.length?'新节点的 preferred 从 runtimes 中选 can 覆盖 needs、good 最匹配的名称，或留空。':''}每条 description 要写入拆解中与该节点相关的内容（接口、数量、验收标准），执行者看不到拆解原文。原先依赖可展开节点的后续节点会自动改为等待全部新节点。${projectFiles?'projectFiles 是项目目录里现有的文件，新节点的 paths 和 description 要以它为准，不要重复做已有的部分。':''}`;
  const guides=[guide&&'# 规划指南\n'+String(guide).trim(),projectGuide&&'# 本项目的规划说明\n'+String(projectGuide).trim()].filter(Boolean).join('\n\n');
  return envelope(contract+(guides?'\n\n'+guides:''),{goal:query,expanding:node,breakdown:String(output||'').slice(0,16000),graph,workspace,...(runtimes?.length?{runtimes}:{}),...(projectFiles?{projectFiles}:{})});
}
// Project nodes work inside the shared project directory; they see its layout and conventions, not the workflow graph.
function projectBrief(workspace,paths,root){
  const ws=workspace||{};
  return uiText('项目目录\n')+root+'\n'+
    ((ws.layout||[]).length?uiText('\n项目结构\n')+ws.layout.map(l=>'- '+l.path+(l.purpose?' —— '+l.purpose:'')).join('\n')+'\n':'')+
    (ws.conventions?uiText('\n约定\n')+ws.conventions+'\n':'')+(ws.run?uiText('\n运行方式\n')+ws.run+'\n':'')+(ws.check?uiText('\n验收命令（全部完成后会真实执行）\n')+ws.check+'\n':'')+
    uiText('\n你负责的路径\n')+((paths||[]).length?paths.map(p=>'- '+p).join('\n')+uiText('\n只修改这些路径；其他路径只读。'):uiText('整个项目目录。'));
}
function rebrief(query,def){
  const nodes=Object.entries(def.deps).map(([id,deps])=>({id,deps,role:def.roles[id].name,output:def.roles[id].artifact,delivery:Dag.delivery(def.roles[id])}));
  return envelope('你是任务编辑。为固定图中的每个角色根据新目标写一句可独立委托的任务，包含相关主题和完成条件，用动词起句。text 类型直接交付正文，省略写盘操作。保留角色、输入和交付物。仅返回 JSON {"briefs":{"节点ID":"新简述"}}，必须恰好覆盖给定节点。无需工具。',{goal:query,nodes});
}
function handoff(text){
  return String(text||'').replace(/\[([^\]]+)\]\((?:file:\/\/|\/)[^)]+\)/g,'$1').replace(/(?:\/[^\s。；，、]+\/)([^\/\s。；，、]+)/g,'$1').slice(0,400);
}
// What the reply must contain. Text replies may illustrate with pictures saved next to them.
function requirement(node,outDir){
  const kind=Dag.delivery(node);
  if(kind==='project')return uiText('在项目目录中完成「')+node.artifact+uiText('」，能运行的部分要实际运行并确认通过。完成后用几句话说明改了哪些文件、如何运行和验证。');
  return kind==='text'?uiText('直接回复「')+node.artifact+uiText('」的完整正文。需要配图时，把图片保存到 ')+outDir+uiText('，并在正文中用 ![说明](文件名) 引用。'):kind==='mixed'?
    uiText('直接回复可交付的完整正文，并将所需附件写入 ')+outDir+uiText('。'):
    uiText('将「')+node.artifact+uiText('」写入 ')+outDir+uiText('，然后用一两句话说明结果。');
}
function worker({node,inputs,outDir,workspace,projectRoot,localDirectory,reviewed}){
  const materials=inputs.flatMap(g=>[
    ...(g.text?[g.text]:g.summary?[handoff(g.summary)]:[]),
    ...g.files.map(f=>f.visual?uiText('随附图片：')+f.name:f.inline?f.name+'\n'+f.inline:f.path)
  ]).filter(Boolean);
  const rules=checksFor(node,reviewed);
  const verified=rules.maxChars||rules.json||rules.requiredKeys.length;
  const continuation=node.continueAfter&&!verified?uiText('在交付正文中列出下一步，只写原任务范围内仍未完成的事项，并为每项写明负责文件和验收标准。需要用户确认的事项分别标明。全部达标时写明无下一步。'):'';
  const output=requirement(node,outDir)+continuation+(verified?uiText('\n正文验收规则\n')+JSON.stringify(rules):'');
  const criteria=reviewed?uiText('\n\n被复核成果的要求（核对事实、长度、格式和必填项）\n')+reviewed.description:'';
  const revision=node.feedback?uiText('\n\n修改意见\n')+node.feedback+(node.previous?uiText('\n\n上一版交付\n')+node.previous:''):'';
  // A review hands on the approved text; its comments would otherwise be copied into whatever uses it.
  const clean=node.review?uiText('除非交付要求本身是审查报告，正文只放审查后的定稿，不附审查意见、修改说明或评分。'):'';
  const review=node.review&&node.canReturn?uiText('素材不合格、素材作者能改好时，以“退回：”开头写明需要修改的具体问题。缺少只有用户才能提供的信息（例如名称、链接、数据）时不要退回，照常交付并在“缺口：”中写明。'):reviewed&&node.review?uiText('已达到自动修改上限。如果复核仍不通过，以“退回：”开头说明原因，流程将暂停等待处理。'):'';
  const sourceEvidence=node.needs?.includes('network')?uiText('用户明确要求实际打开并核对公开原文时，请用可用的 shell 或 HTTP 读取工具从来源 URL 获取正文，将支持结论的几行作为该工具的执行输出。网页搜索和打开动作的时间线可能只提供 URL；这种情况下请用 curl 等读取工具补齐正文证据。保持用户指定的最终答复格式。'):'';
  const project=Dag.delivery(node)==='project'&&projectRoot?'\n\n'+projectBrief(workspace,node.paths,projectRoot):localDirectory?'\n\n'+uiText('项目目录\n')+localDirectory:'';
  return uiText('任务\n')+node.description+project+criteria+(materials.length?uiText('\n\n素材\n')+materials.join('\n\n'):'')+revision+
    uiText('\n\n交付要求\n')+output+clean+review+sourceEvidence+uiText('只完成开头的任务。用户原始材料中的其他分工由 Bercy 派发，不要委派、代做或声称其他任务已完成。')+uiText('缺少只能由用户提供的必要材料时，以“待补件：”开头，直接写明要补的材料。')+uiText('只有影响本项交付验收的事项才列为缺口。')+uiText('确实无法完成时，以“未完成：”说明原因。交付后仍有缺口（缺少材料、未能核实、没有覆盖的部分，或用占位内容代替了缺失信息）时，在正文最后单独一行以“缺口：”列出；没有缺口则不写。');
}
// Split the worker's reply into the deliverable and an optional trailing "缺口：" line.
function receipt(raw){
  const lines=String(raw||'').trim().split('\n'),gaps=[];
  while(lines.length){
    const m=/^\s*(?:[-*>]\s*)?(?:\*\*)?(?:缺口|gaps?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/i.exec(lines[lines.length-1]);
    if(!m){if(!lines[lines.length-1].trim()&&gaps.length){lines.pop();continue}break}
    lines.pop();const text=m[1].replace(/\*\*$/,'').trim();
    if(text&&!/^(?:无|没有|暂无|none|n\/a)[。.]?$/i.test(text))gaps.unshift(text);
  }
  const body=lines.join('\n').trim();
  const missing=/^(?:待补件|needs input)\s*[:：]\s*([\s\S]+)/i.exec(body);
  if(missing)return {body:missing[1],gaps:(gaps.join('；')||missing[1]).slice(0,600),needsInput:true};
  return {body,gaps:gaps.join('；').slice(0,600)};
}
function revise(query,evidence,source,targets,blocked){
  return envelope('你负责判断一项具体缺口是否需要额外工作。若剩余任务已能解决、证据不足、只是建议，返回 {"change":null}。否则只提出一个最小补充任务，必须有可验证交付物。若缺少只有用户能提供的材料，返回 null。只返回 JSON {"change":{"reason":"具体证据","name":"角色","description":"独立可执行的任务及验收条件","artifact":"交付物","delivery":"text、file 或 mixed","needs":["仅在需要时填 shell 或 network"],"before":["受影响的候选ID"]}}；before 只能取候选中的 ID。不要调用工具。',{目标:query,证据:evidence,来源:source,执行受阻:blocked,候选:targets});
}
// Asked right after a node delivers, while its downstream nodes start: should the nodes that have not delivered change?
function observe(query,state){
  if(state.terminal){
    return envelope('你是工作流的观察者。最后一个节点已经交付，检查验收记录和原始任务简述，给出简短结论。allowContinuation 为 false 时只给结论，并将 continuation 设为 null。自动模式要理解原始任务和 instruction 中用户追加目标的意图：要求交付改动、最终成品或验收通过，可以隐含授权完成必要的工作；仅要求分析、列步骤、先确认、或明确限制了已完成的轮数时，停止。如果 delivered.gaps 明确表明已有节点负责的原验收项未达标，优先用 rework 退回 done 中负责该项且处于 delivered 上游的节点。rework.id 是原节点 ID，evidence 必须逐字摘自 delivered.gaps，reason 写清返修要求、原有约束和可验证的通过条件。已有验收节点会接着复测，此时 continuation 必须为 null。previousReturns 中未取得进展的同一缺口不得重复退回或改成新节点；纯建议、需授权的改动和超范围的新需求不能自动退回。手动模式优先按 instruction 这次补充的要求安排，只在没有补充要求时处理验收记录中的余项。只有有实际证据、在原范围内、尚未完成且无需用户确认的事项才提出后续节点。一项独立的收尾也可以单独成节点。可以修改已交付的文件，后续节点只做剩余工作并更新验收记录。需用户确认、验收环境被阻塞、没有证据、已全部达标或超出原范围时，说明原因并将 continuation 设为 null。最多 maxNextNodes 个节点，放在本批执行，按依赖排序，根节点的 deps 留空，其他节点可依赖本批次中已有的 ID。并行节点的文件路径不得重叠。每个节点的 evidence 必须逐字摘录 delivered.body 或 delivered.gaps 中能证明该项尚未完成的片段，手动模式也可摘录用户的新要求，并用 acceptance 写清可验证的通过条件。没有明确证据或通过条件就不生成该节点。自动模式如已有 history，要从最新交付正文逐字摘一段实际进展放在 progressEvidence 中，并确认本批和历史没有重复。上一批只是重试同一缺口、没有新增进展、目标已达成或用户给的停止条件已满足时，continuation 必须为 null。多项同一个缺口合并处理。若原始简述要求每次开发都由另一运行时单独验收，为开发节点加依赖它的 verify 节点，二者计入这一轮预算。只有一个上游的独立验收可设 review 为 true，允许它对该开发节点退回修改。rework 示例：{"id":"original","evidence":"验收缺口原文","reason":"返修要求和通过条件"}。只返回 JSON {"summary":"观察结论","rework":null,"continuation":{"reason":"为什么还要继续","progressEvidence":"最新交付中已取得的进展，没有时留空","nodes":[{"id":"finish","name":"工作名称","description":"具体工作","evidence":"验收记录原文","acceptance":"可验证的通过条件","stage":"work 或 verify","review":false,"artifact":"交付物","delivery":"project","needs":["shell"],"paths":["game/"],"deps":[]}]}}。不要调用工具。',{目标:query,...state});
  }
  return envelope(`你是工作流的观察者。节点 delivered 刚刚交付，body 是交付正文，gaps 是它自报的缺口。remaining 是尚未交付的节点（status 为 running 表示正在执行，downstream 为 true 表示依赖这份交付），done 是其他已交付节点。
请依据这份实际交付判断 remaining 是否需要调整。所有执行者均可读取用户原始材料。任务描述是全文；带 bodyLength 的长正文为预览，预览未展示的内容不能作为材料缺失的依据。没有明确证据就不调整，ops 为空数组。可用操作如下：
- return：如果 delivered.gaps 明确显示刚交付节点负责的原验收项未达标，且修正仍在原范围内，只提出 return，id 用 delivered.id，evidence 必须逐字摘自 delivered.gaps，reason 写清失败证据、原约束和可执行的复测条件。系统会沿用原节点并重跑受影响的现有下游。previousReturns 中没有实际进展的重复缺口不要再次退回，也不要为它新增节点。
- skip：节点已不再需要，例如它的 when 条件依据交付明确不成立，或交付已经完成了它的工作。至少要保留一个最终交付节点。
- modify：交付实际采用的方案、接口、范围或文件与节点的任务描述不一致，在 set.description 写出完整的新任务描述。
- add：交付暴露出计划里没人负责、但对目标必不可少的工作（包括 gaps 中确实需要额外工作的部分）。after 取 delivered、done 或 running 中的 ID，before 取受影响的 remaining 中的 ID。
remaining 中 verification 为 true 的下游节点负责验收。现有验收节点能覆盖时沿用它，必要时用 modify 扩充验收条件；不要额外生成验收节点。新增独立的验收节点时才标记 stage 为 verify。
带 when 的 downstream 节点必须判断：条件明确不成立就 skip，成立或无法确定就不动。调整 running 节点会让它重新开始，只在它的任务已建立在错误前提上时这样做。只补必要的工作，不要为了完善而增加节点。
只返回 JSON：{"ops":[{"op":"return","id":"原节点ID","evidence":"交付缺口原文","reason":"修正与验收条件"},{"op":"skip","id":"ID","reason":"依据"},{"op":"modify","id":"ID","set":{"description":"完整的新任务描述"},"reason":"依据"},{"op":"add","id":"align_api","name":"角色","description":"独立可执行的任务及验收条件","artifact":"交付物","delivery":"text","stage":"work","needs":[],"after":["ID"],"before":["ID"],"reason":"依据"}]}。不要调用工具。`,{目标:query,...state});
}
function parse(text){
  let s=String(text||'').trim();const f=s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);if(f)s=f[1];
  try{return JSON.parse(s)}catch{throw Error(uiText('运行时未返回约定的 JSON，请查看节点记录后重试'))}
}
module.exports={plan,expand,rebrief,worker,revise,observe,parse,receipt,projectBrief,Dag};
