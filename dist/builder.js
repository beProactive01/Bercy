// Manual builder: nodes are placed and connected on a canvas; the side panel edits the selected node.
const NODE_W=168,NODE_H=70;
function buildManually(query='',projectId=null,existing=null,attachments=[]){
  let rows=existing?Object.keys(existing.deps).map(id=>{
    const role=existing.roles[id],pin=existing.overrides[id]||{};
    return {id,stage:role.stage,continueAfter:pin.continueAfter??role.continueAfter,review:pin.review??!!role.review,offline:pin.offline??!!role.offline,name:role.name,artifact:role.artifact,description:pin.description||role.description||'',deps:[...existing.deps[id]],delivery:pin.delivery||Dag.delivery(role),needs:Dag.cleanNeeds(pin.needs||role.needs),runtime:pin.harness||'',model:pin.model||'',avatar:role.avatar};
  }):[];
  let selected=null,link=null,drag=null;
  const avatars=['lead','writer','scout','mix','check'];
  function add(x,y){
    if(rows.length>=32){notify(uiText('最多支持 32 个节点'));return null}
    const n={id:'n_'+uid().slice(0,8),name:'',artifact:'',description:'',delivery:'auto',needs:['shell'],offline:false,runtime:'',deps:[],avatar:avatars[rows.length%avatars.length],x,y};
    rows.push(n);return n;
  }
  function layout(){
    const levels=Dag.levels(Object.fromEntries(rows.map(n=>[n.id,n.deps])));
    const tallest=Math.max(...levels.map(l=>l.length));
    levels.forEach((level,col)=>level.forEach((id,i)=>{
      const n=rows.find(r=>r.id===id);n.x=28+col*(NODE_W+64);n.y=24+(i+(tallest-level.length)/2)*(NODE_H+38);
    }));
  }
  if(rows.length)layout();else add(28,24);
  selected=rows[rows.length-1].id;
  attachments=[...attachments];
  dialog(uiText('流程设计'),existing?uiText('调整节点和依赖'):uiText('手动搭建'),
    uiText('<form id="builder"><div class="build-head"><label class="build-goal"><span class="field">任务描述</span><textarea class="fieldinput" id="goal" required maxlength="4000" rows="2" placeholder="希望这组 Agent 一起完成什么？">')+esc(query)+'</textarea></label>'+
    uiText('<label class="build-project"><span class="field">项目（可选）</span><select class="select" id="buildProject">')+opts(projectId)+'</select></label></div>'+attachmentField()+
    uiText('<div class="board-tools"><button type="button" class="secondary" id="addNode">＋ 添加节点</button><button type="button" class="secondary" id="tidyNodes">整理布局</button><small>拖动节点摆放位置；从节点右侧圆点拖到另一个节点即可连线；点连线删除；双击空白处添加节点。</small></div>')+
    uiText('<div class="board-wrap"><div class="board-scroll" id="boardScroll"><div class="board" id="board" tabindex="0" aria-label="流程画布"><svg class="board-wires" id="boardWires" aria-hidden="true"></svg></div></div><aside class="board-panel" id="boardPanel"></aside></div>')+
    '<div class="actions"><button class="primary">'+(existing?uiText('保存修改'):uiText('生成画布'))+'</button></div></form>');
  bindAttachments($('builder'),attachments);
  const board=$('board'),wires=$('boardWires'),panel=$('boardPanel');
  const find=id=>rows.find(n=>n.id===id);
  // Everything except the task text is optional; blanks get defaults when the canvas is created.
  const label=n=>n.name.trim()||Dag.nameFrom(n.description,rows.indexOf(n));
  const output=n=>n.artifact.trim()||label(n)+uiText('的交付');
  const kind=n=>n.delivery&&n.delivery!=='auto'?n.delivery:Dag.delivery({artifact:n.artifact,description:n.description});
  const runtimeChoices=()=>[['',uiText('自动分配')],...runtimes.map(r=>[r.name,r.name+(db.connections[r.name].online?'':uiText('（未连接）'))])];
  function card(n){
    let el=board.querySelector('.bnode[data-node="'+n.id+'"]');
    if(!el){
      el=document.createElement('div');el.className='bnode';el.dataset.node=n.id;el.tabIndex=-1;
      el.innerHTML=uiText('<span class="bport-in" aria-hidden="true"></span><canvas class="sprite"></canvas><span class="btext"><b></b><small></small></span><span class="bport" title="拖到另一个节点，建立依赖"></span>');
      board.append(el);
    }
    el.style.left=n.x+'px';el.style.top=n.y+'px';el.classList.toggle('selected',n.id===selected);
    el.classList.toggle('incomplete',!n.description.trim());
    el.querySelector('b').textContent=label(n);
    el.querySelector('small').textContent=(n.runtime||uiText('自动分配'))+' · '+({text:uiText('文字'),file:uiText('文件'),mixed:uiText('正文和附件'),project:uiText('项目目录')})[kind(n)];
    if(el.dataset.avatar!==n.avatar){sprite(el.querySelector('canvas'),n.avatar);el.dataset.avatar=n.avatar}
    return el;
  }
  const port=(n,out)=>[n.x+(out?NODE_W:0),n.y+NODE_H/2];
  const curve=([x1,y1],[x2,y2])=>{const m=Math.max(40,Math.abs(x2-x1)/2);return 'M'+x1+' '+y1+' C'+(x1+m)+' '+y1+' '+(x2-m)+' '+y2+' '+x2+' '+y2};
  function drawWires(){
    const w=Math.max(board.parentElement.clientWidth,...rows.map(n=>n.x+NODE_W+60)),h=Math.max(board.parentElement.clientHeight,...rows.map(n=>n.y+NODE_H+40));
    board.style.width=w+'px';board.style.height=h+'px';wires.setAttribute('width',w);wires.setAttribute('height',h);
    let svg='<defs><marker id="boardArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" fill="#9484b5"/></marker></defs>';
    for(const n of rows)for(const p of n.deps){
      const d=curve(port(find(p),true),port(n,false));
      svg+='<g class="bwire" data-edge="'+p+'>'+n.id+'"><path class="bwire-hit" d="'+d+'"/><path class="bwire-line" d="'+d+'" marker-end="url(#boardArrow)"/><title>'+esc(label(find(p))+' → '+label(n)+uiText('（点击删除）'))+'</title></g>';
    }
    if(link)svg+='<path class="bwire-line pending" d="'+curve(port(find(link.from),true),[link.x,link.y])+'"/>';
    wires.innerHTML=svg;
  }
  function paint(){
    for(const el of [...board.querySelectorAll('.bnode')])if(!find(el.dataset.node))el.remove();
    rows.forEach(card);drawWires();
  }
  function inspector(){
    const n=find(selected);
    if(!n){panel.innerHTML=uiText('<p class="board-empty">选择一个节点，写下它要做的事。</p>');return}
    const inputs=n.deps.map(p=>'<span class="dep-chip">'+esc(label(find(p)))+'<button type="button" data-unlink="'+p+uiText('" aria-label="移除输入 ')+esc(label(find(p)))+'">×</button></span>').join('')||uiText('<span class="muted">任务描述</span>');
    panel.innerHTML=uiText('<label>这个节点要做什么<textarea data-field="description" maxlength="1600" rows="4" placeholder="例如：根据上游的稿子写一段 100 字的宣传语">')+esc(n.description)+'</textarea></label>'+
      uiText('<label>运行时<select data-field="runtime" class="select">')+runtimeChoices().map(([v,t])=>'<option value="'+esc(v)+'" '+(v===(n.runtime||'')?'selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label>'+
      needsField(n,'data-needs')+(n.deps.length===1?'<label class="review-pick"><input type="checkbox" data-field-check="review" '+(n.review?'checked':'')+uiText('>审查上游：由另一个运行时交叉审查，不合格时退回修改（最多两轮）</label>'):'')+
      uiText('<div class="dep-label">输入来自</div><div class="dep-chips">')+inputs+'</div>'+
      uiText('<details class="board-more"><summary>更多设置（可选）</summary>')+
      uiText('<label>角色名称<input data-field="name" class="fieldinput" maxlength="80" placeholder="')+esc(label(n))+'" value="'+esc(n.name)+'"></label>'+
      uiText('<label>交付产物<input data-field="artifact" class="fieldinput" maxlength="120" placeholder="')+esc(output(n))+'" value="'+esc(n.artifact)+'"></label>'+
      uiText('<label>交付形式<select data-field="delivery" class="select"><option value="auto" ')+(!n.delivery||n.delivery==='auto'?'selected':'')+uiText('>自动判断（当前：')+({text:uiText('文字'),file:uiText('文件'),mixed:uiText('正文和附件'),project:uiText('项目目录')})[kind(n)]+'）</option>'+outputModeField(n.delivery==='auto'?'':n.delivery)+'</select></label></details>'+
      (rows.length>1?uiText('<button type="button" class="drop-node" id="dropNode">删除此节点</button>'):'');
  }
  function select(id){selected=id;inspector();paint()}
  function remove(id){
    rows=rows.filter(n=>n.id!==id);for(const n of rows)n.deps=n.deps.filter(p=>p!==id);
    select(rows[rows.length-1]?.id||null);
  }
  function connect(from,to){
    const n=find(to);if(!n||from===to||n.deps.includes(from))return;
    try{Dag.levels(Object.fromEntries(rows.map(r=>[r.id,r.id===to?[...r.deps,from]:r.deps])))}catch{notify(uiText('这条连线会形成循环'));return}
    n.deps=[...n.deps,from];if(selected===to)inspector();paint();
  }
  const point=e=>{const box=board.getBoundingClientRect();return [e.clientX-box.left,e.clientY-box.top]};
  board.onpointerdown=e=>{
    if(e.button!==0)return;
    const out=e.target.closest('.bport'),node=e.target.closest('.bnode'),edge=e.target.closest('.bwire');
    if(edge){const [p,c]=edge.dataset.edge.split('>');find(c).deps=find(c).deps.filter(x=>x!==p);if(selected===c)inspector();paint();return}
    if(!node){select(null);return}
    e.preventDefault();board.setPointerCapture(e.pointerId);const [x,y]=point(e),n=find(node.dataset.node);
    if(out){link={from:n.id,x,y};drawWires();return}
    drag={n,dx:x-n.x,dy:y-n.y,x,y,moved:false};
  };
  board.onpointermove=e=>{
    const [x,y]=point(e);
    if(link){link.x=x;link.y=y;drawWires();board.querySelectorAll('.bnode').forEach(el=>el.classList.toggle('target',el.contains(document.elementFromPoint(e.clientX,e.clientY))&&el.dataset.node!==link.from));return}
    if(!drag)return;
    if(Math.hypot(x-drag.x,y-drag.y)>3)drag.moved=true;
    if(drag.moved){drag.n.x=Math.max(4,Math.round(x-drag.dx));drag.n.y=Math.max(4,Math.round(y-drag.dy));card(drag.n);drawWires()}
  };
  board.onpointerup=e=>{
    if(link){
      const over=document.elementFromPoint(e.clientX,e.clientY)?.closest('.bnode'),from=link.from;link=null;
      board.querySelectorAll('.target').forEach(el=>el.classList.remove('target'));
      if(over)connect(from,over.dataset.node);else drawWires();
    }else if(drag){const {n,moved}=drag;drag=null;if(!moved)select(n.id)}
  };
  board.ondblclick=e=>{if(e.target.closest('.bnode'))return;const [x,y]=point(e);const n=add(Math.max(4,x-NODE_W/2),Math.max(4,y-NODE_H/2));if(n){select(n.id);panel.querySelector('input')?.focus()}};
  board.onkeydown=e=>{if((e.key==='Delete'||e.key==='Backspace')&&selected&&rows.length>1){e.preventDefault();remove(selected)}};
  panel.oninput=e=>{
    const n=find(selected);if(!n)return;
    const field=e.target.dataset.field,need=e.target.dataset.needs;
    if(field)n[field]=e.target.value;
    if(field==='runtime')delete n.model;
    if(field==='description'||field==='artifact'){const d=panel.querySelector('[data-field=delivery] option[value=auto]');if(d)d.textContent=uiText('自动判断（当前：')+({text:uiText('文字'),file:uiText('文件'),mixed:uiText('正文和附件'),project:uiText('项目目录')})[kind(n)]+uiText('）')}
    if(e.target.dataset.fieldCheck)n[e.target.dataset.fieldCheck]=e.target.checked;
    if(e.target.hasAttribute('data-needs-online'))n.offline=!e.target.checked;
    if(need)n.needs=e.target.checked?[...new Set([...(n.needs||[]),need])]:(n.needs||[]).filter(x=>x!==need);
    card(n);if(field==='name'||field==='description')drawWires();
  };
  panel.onclick=e=>{
    const n=find(selected);if(!n)return;
    if(e.target.dataset.unlink){n.deps=n.deps.filter(p=>p!==e.target.dataset.unlink);inspector();paint()}
    if(e.target.id==='dropNode')remove(n.id);
  };
  $('addNode').onclick=()=>{
    const last=rows[rows.length-1],n=add(last?last.x+NODE_W+64:28,last?last.y:24);
    if(n){select(n.id);$('boardScroll').scrollLeft=n.x;panel.querySelector('input')?.focus()}
  };
  $('tidyNodes').onclick=()=>{layout();paint()};
  inspector();requestAnimationFrame(paint);
  $('builder').onsubmit=e=>{
    e.preventDefault();const form=e.target,end=setBusy(form,existing?uiText('保存中…'):uiText('生成画布…'));
    try{const goal=$('goal').value.trim();if(!goal)throw Error(uiText('请输入任务描述'));
      const d=Dag.definition(rows.map(n=>({...n,name:label(n),artifact:output(n),delivery:kind(n),
        description:n.description.trim()||uiText('围绕本次任务，完成并检查「')+output(n)+uiText('」。')})));
      for(const n of rows)if(n.offline)(d.overrides[n.id]??={}).offline=true;
      const project=$('buildProject').value||null;
      if(existing){const s=session();s.flow=newRun(goal,d);s.flow.logs=[[0,uiText('手动调整了流程结构'),rows.length+uiText(' 个节点')]];s.project=project;s.attachments=attachments;s.updated=Date.now();run=s.flow;inspected=null;save();dismiss();return}
      dismiss();create(goal,project,d,null,null,attachments,uiText('手动搭建工作流'));
    }catch(err){end(err)}
  };
}
