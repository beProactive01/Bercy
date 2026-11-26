// Both settings and individual nodes use the same searchable, bounded list.
function modelListField(id,label,choices,value){
  const current=choices.find(c=>c.value===value)||choices[0];
  return '<div class="model-field"><label class="field" for="'+id+'">'+esc(label)+'</label>'+
    '<button type="button" id="'+id+'" class="model-trigger" aria-expanded="false" aria-controls="'+id+'Panel">'+
    '<strong>'+esc(current.name)+'</strong><small>'+esc(current.adapter||'')+'</small><i class="rt-chevron" aria-hidden="true"></i></button>'+
    '<div id="'+id+'Panel" class="model-panel" hidden><input type="search" id="'+id+'Filter" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="true" aria-controls="'+id+uiText('Results" aria-label="搜索')+esc(label)+uiText('" placeholder="搜索模型名称…">')+
    '<div role="listbox" aria-label="'+esc(label)+'" id="'+id+uiText('Results" class="model-results"></div><p class="no-models" hidden>没有匹配的模型</p></div></div>');
}
function bindModelList(id,choices,value,onOpen,onSelect){
  const button=$(id),panel=$(id+'Panel'),input=$(id+'Filter'),results=$(id+'Results'),field=button.parentElement;
  let visible=[],active=0;
  function paint(){
    const q=input.value.trim().toLowerCase();
    visible=choices.filter(c=>(c.name+' '+(c.adapter||'')).toLowerCase().includes(q));
    active=Math.max(0,visible.findIndex(c=>c.value===value));
    results.innerHTML=visible.map((c,i)=>'<div role="option" id="'+id+'Row'+i+'" data-row="'+i+'" aria-selected="'+(c.value===value)+'"><span>'+esc(c.name)+'</span><small>'+esc(c.adapter||'')+'</small><b aria-hidden="true">'+(c.value===value?'✓':'')+'</b></div>').join('');
    field.querySelector('.no-models').hidden=visible.length>0;
    highlight();
  }
  function highlight(){
    for(const el of results.children)el.classList.toggle('highlight',Number(el.dataset.row)===active);
    const row=results.children[active];
    if(row){
      input.setAttribute('aria-activedescendant',row.id);
      if(row.offsetTop<results.scrollTop)results.scrollTop=row.offsetTop;
      else if(row.offsetTop+row.offsetHeight>results.scrollTop+results.clientHeight)results.scrollTop=row.offsetTop+row.offsetHeight-results.clientHeight;
    }else input.removeAttribute('aria-activedescendant');
  }
  function close(focus=false){
    panel.hidden=true;button.setAttribute('aria-expanded','false');
    if(focus)button.focus({preventScroll:true});
  }
  function choose(i){
    const selected=visible[i];if(!selected)return;
    close(true);if(selected.value!==value){onSelect(selected.value);$(id)?.focus({preventScroll:true})}
  }
  function open(){
    if(!panel.hidden)return;
    onOpen();panel.hidden=false;button.setAttribute('aria-expanded','true');input.value='';paint();input.focus();
  }
  button.onclick=()=>panel.hidden?open():close(true);
  button.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();open()}};
  input.oninput=paint;
  input.onkeydown=e=>{
    if(e.isComposing)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true)}
    if(e.key==='Enter'){e.preventDefault();choose(active)}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();active=Math.max(0,Math.min(visible.length-1,active+(e.key==='ArrowDown'?1:-1)));highlight()
    }
  };
  results.onmousedown=e=>e.preventDefault();
  results.onclick=e=>{const row=e.target.closest('[data-row]');if(row)choose(Number(row.dataset.row))};
  field.onfocusout=e=>{if(!field.contains(e.relatedTarget))close()};
}
