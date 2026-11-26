function point(id,deps,mobile){
  if(!deps.b)return (mobile?{root:[50,14],a:[50,49],merge:[50,85]}:{root:[15,50],a:[50,50],merge:[85,50]})[id];
  if(mobile){return {root:[50,12],a:[24,42],b:[76,42],review:[76,67],merge:[50,88]}[id]}
  return {root:[12,50],a:[45,23],b:[deps.review?34:45,77],review:[62,77],merge:[88,50]}[id];
}
function graph(){
  if(!run)return;
  const deps=snapshot(),history=inspected!==null;
  const mobile=$('graphScroll').clientWidth<595;
  if(!$('graph').clientWidth)return;
  $('stage').classList.toggle('running',timers.has(session().id)&&!history);
  const layer=$('nodes'),custom=run.family==='custom'||Object.keys(deps).some(k=>k.startsWith('extra_'));
  const levels=custom?Dag.levels(deps):null;
  function position(id){
    if(!custom)return point(id,deps,mobile);
    const col=levels.findIndex(row=>row.includes(id)),row=levels[col],i=row.indexOf(id);
    const x=(col+.5)*100/levels.length,y=(i+.5)*100/row.length;
    return mobile?[y,x]:[x,y];
  }
  for(const btn of [...layer.children])if(!deps[btn.dataset.id])btn.remove();
  for(const id of Object.keys(deps)){
    const [x,y]=position(id),status=phase(id,deps),spec=nodeSpec(run,id);
    const style=history?'':run.files[id]?.skipped?'skipped':run.files[id]?'finished':run.pack[id]?.live?'revised '+(runnable(run).includes(id)?'active':''):runnable(run).includes(id)?'active':id==='review'?'revised':'';
    let btn=layer.querySelector('[data-id="'+id+'"]');
    if(!btn){
      btn=document.createElement('button');btn.dataset.id=id;
      btn.innerHTML='<span class="nodetop"><canvas class="sprite"></canvas><span><b></b><small></small></span></span><span class="nodeoutput"></span><span class="nodestate"></span>';
      layer.append(btn);
    }
    btn.className='node '+style+(spec.origin?' expanded':'');
    btn.title=!history&&run.errors?.[id]?uiText('需要处理 · ')+run.errors[id]:spec.origin?uiText('由「')+(run.pack[spec.origin]?.name||'')+uiText('」展开'):'';btn.style.left=x+'%';btn.style.top=y+'%';
    btn.setAttribute('aria-label',spec.name+uiText('，')+status);
    btn.querySelector('b').textContent=spec.name;const harnessTag=btn.querySelector('small');
    const runtime=runtimeInfo(spec.harness);
    if(harnessTag.dataset.runtime!==spec.harness){
      harnessTag.dataset.runtime=spec.harness;
      harnessTag.innerHTML=(runtime?runtimeIcon(runtime):'')+esc(spec.harness);
    }
    btn.querySelector('.nodeoutput').textContent=nodeTitle(id);btn.querySelector('.nodestate').textContent=status;
    if(btn.dataset.avatar!==spec.avatar){sprite(btn.querySelector('canvas'),spec.avatar);btn.dataset.avatar=spec.avatar}
  }
  const surface=$('graph');
  if(custom){
    // A translated role or a runtime label can wrap when the answer dock opens.
    // Leave a gutter between the actual cards in each row and column.
    const cards=new Map([...layer.children].map(btn=>[btn.dataset.id,btn]));
    let minWidth=0,minHeight=0;
    for(const level of levels){
      for(const id of level){
        const card=cards.get(id);
        minWidth=Math.max(minWidth,(mobile?level.length:levels.length)*(card.offsetWidth+24));
        minHeight=Math.max(minHeight,(mobile?levels.length:level.length)*(card.offsetHeight+24));
      }
    }
    surface.style.minWidth=minWidth+'px';
    surface.style.minHeight=minHeight+'px';
  }else{
    surface.style.minWidth='';
    surface.style.minHeight='';
  }
  const canvas=$('wires'),box=surface.getBoundingClientRect(),scale=devicePixelRatio||1;
  canvas.width=Math.round(box.width*scale);canvas.height=Math.round(box.height*scale);
  const ctx=canvas.getContext('2d');ctx.scale(scale,scale);
  for(const [id,parents] of Object.entries(deps))for(const parent of parents){
    const src=$('nodes').querySelector('[data-id="'+parent+'"]').getBoundingClientRect();
    const dst=$('nodes').querySelector('[data-id="'+id+'"]').getBoundingClientRect();
    const ready=!history&&!!run.files[parent], custom=id==='review'||parent==='review';
    ctx.strokeStyle=ready?'#498773':custom?'#a57a35':'#9484b5';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2.3;ctx.setLineDash(ready?[]:[5,4]);
    const startX=src.left-box.left+src.width*(mobile?.5:1),startY=src.top-box.top+src.height*(mobile?1:.5);
    const endX=dst.left-box.left+dst.width*(mobile?.5:0),endY=dst.top-box.top+dst.height*(mobile?0:.5);
    ctx.beginPath();ctx.moveTo(startX,startY);
    if(mobile){const mid=(startY+endY)/2;ctx.bezierCurveTo(startX,mid,endX,mid,endX,endY)}
    else{const mid=(startX+endX)/2;ctx.bezierCurveTo(mid,startY,mid,endY,endX,endY)}
    ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(endX,endY);
    if(mobile){ctx.lineTo(endX-4,endY-7);ctx.lineTo(endX+4,endY-7)}else{ctx.lineTo(endX-7,endY-4);ctx.lineTo(endX-7,endY+4)}
    ctx.closePath();ctx.fill();
  }
}
