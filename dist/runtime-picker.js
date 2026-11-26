function runtimeIcon(runtime){
  if(!runtime.icon)return '<span class="runtime-brand runtime-glyph" aria-hidden="true">'+esc((runtime.name||'?').slice(0,1))+'</span>';
  return '<img class="runtime-brand" src="icons/'+runtime.icon+'" alt="">';
}
function runtimeFace(runtime){
  return runtimeIcon(runtime)+'<b class="rt-name">'+esc(runtime.name)+'</b><span class="rt-adapter">'+esc(runtime.adapter)+'</span>';
}
function choiceFace(choice){
  if(choice.icon)return runtimeFace(choice);
  return '<span class="choice-icon" aria-hidden="true">'+(choice.value?'◇':'✧')+'</span><b class="rt-name">'+esc(choice.name)+'</b><span class="rt-adapter">'+esc(choice.adapter||'')+'</span>';
}
function choiceField(id,label,choices,value){
  const selected=choices.find(choice=>choice.value===value)||choices[0];
  const listId=id+'List';
  return '<div class="rt-field"><div class="rt-caption"><label id="'+id+'Label" for="'+id+'">'+label+'</label>'+
    (id==='runtime'?'<small id="savedState" role="status"></small>':'')+'</div><div class="rt-picker">'+
    '<button id="'+id+'" type="button" role="combobox" value="'+esc(selected.value)+'" aria-label="'+label+uiText('，')+esc(selected.name)+
    '" aria-haspopup="listbox" aria-expanded="false" aria-controls="'+listId+'">'+choiceFace(selected)+'<i class="rt-chevron" aria-hidden="true"></i></button>'+
    '<div id="'+listId+'" class="choice-list" role="listbox" aria-labelledby="'+id+'Label" hidden>'+
    choices.map((c,i)=>'<div role="option" id="'+id+'Option'+i+'" aria-label="'+esc(c.name)+'" aria-selected="'+(c===selected)+'" data-index="'+i+'">'+
    choiceFace(c)+'<i class="rt-check" aria-hidden="true"></i></div>').join('')+'</div></div></div>';
}
function nodeChoices(k){
  const pin=run.overrides[k]||{},spec=nodeSpec(run,k);
  const runners=[{value:'',name:uiText('自动分配'),adapter:candidates(run,k,{})[0]?.name||uiText('等待连接')},
    ...runtimes.filter(r=>db.connections[r.name].online||r.name===pin.harness).map(r=>({...r,value:r.name,adapter:db.connections[r.name].online?(r.custom?uiText('自定义 · ACP'):r.adapter):uiText('已断开')}))];
  const catalog=runtimeInfo(spec.harness);
  const models=[{value:'',name:uiText('跟随默认模型'),adapter:modelLabel(db.connections[spec.harness]?.model)||uiText('等待连接')},
    ...(catalog?.models||[]).map(name=>({value:name,name:modelLabel(name)}))];
  return {runners,models};
}
function bindChoicePicker(id,choices,onOpen,onSelect){
  const trigger=document.getElementById(id),list=document.getElementById(id+'List');
  const options=[...list.children];
  let active=0,search='',typedAt=0;
  function highlight(i) {
    active=(i+options.length)%options.length;
    options.forEach((row,n)=>row.classList.toggle('rt-active',n===active));
    trigger.setAttribute('aria-activedescendant',options[active].id);
    options[active].scrollIntoView({block:'nearest'});
  }
  function open() {
    if(!list.hidden)return;
    onOpen();
    const box=trigger.getBoundingClientRect(),dialog=trigger.closest('dialog').getBoundingClientRect();
    const below=dialog.bottom-box.bottom-10,above=box.top-dialog.top-10;
    const up=below<170&&above>below;
    list.classList.toggle('rt-up',up);
    list.style.maxHeight=Math.max(52,up?above:below)+'px';
    list.hidden=false;
    trigger.setAttribute('aria-expanded','true');
    highlight(choices.findIndex(r=>r.value===trigger.value));
  }
  function close() {
    list.hidden=true;search='';
    trigger.setAttribute('aria-expanded','false');
    trigger.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const r=choices[index],changed=r.value!==trigger.value;
    trigger.value=r.value;trigger.setAttribute('aria-label',document.getElementById(id+'Label').textContent+uiText('，')+r.name);
    trigger.innerHTML=choiceFace(r)+'<i class="rt-chevron" aria-hidden="true"></i>';
    options.forEach((row,n)=>row.setAttribute('aria-selected',String(n===index)));
    close();
    if(changed)onSelect(r.value);
  }
  trigger.onclick=()=>list.hidden?open():close();
  trigger.onblur=close;
  list.onpointerdown=e=>e.preventDefault();
  list.onclick=e=>{const option=e.target.closest('[role="option"]');if(option)choose(Number(option.dataset.index))};
  trigger.onkeydown=e=>{
    if(e.key==='Tab'){close();return}
    if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();close();return}
    if(['Enter',' '].includes(e.key)){e.preventDefault();list.hidden?open():choose(active);return}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      e.preventDefault();const wasClosed=list.hidden;open();
      if(e.key==='Home')highlight(0);
      else if(e.key==='End')highlight(options.length-1);
      else if(!wasClosed)highlight(active+(e.key==='ArrowDown'?1:-1));
    }else if(/^[a-z]$/i.test(e.key)&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
      e.preventDefault();open();const now=performance.now();
      search=(now-typedAt<650?search:'')+e.key.toLowerCase();typedAt=now;
      const i=choices.findIndex(r=>r.name.toLowerCase().startsWith(search));if(i>=0)highlight(i);
    }
  };
}
// A click on a plain label or blank dialog space may leave the trigger focused.
document.addEventListener('pointerdown',e=>{
  const trigger=document.querySelector('.rt-picker [aria-expanded=true]');
  if(trigger?.getAttribute('aria-expanded')==='true'&&!trigger.parentElement.contains(e.target))trigger.blur();
});
