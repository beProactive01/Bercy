function nodeInputs(id,parents,snap){
  if(snap)return [];
  const refs=run.sentInputs?.[id];
  const items=refs?refs.map(r=>lookupAsset(r.id)).filter(Boolean):[
    ...(session().attachments||[]),...parents.flatMap(p=>run.files[p]?.artifacts||[]),
    ...(run.extraInputs?.[id]||[])
  ];
  return [...new Map(items.map(a=>[a.id,a])).values()];
}
function imageFigure(asset){
  return '<figure class="inline-figure"><button data-asset="'+esc(asset.id)+uiText('" aria-label="放大 ')+esc(asset.name)+'"><img data-picture="'+esc(asset.id)+'" alt="'+esc(asset.name)+'" '+(host?'src="relay-asset://file/'+esc(asset.id)+'"':'')+'></button><figcaption>'+esc(asset.name)+'</figcaption></figure>';
}
function showFiles(items,inlineText=false){
  return items.map(a=>{
    if(a.type?.startsWith('image/'))return imageFigure(a);
    if(host&&/^(video|audio)\//.test(a.type))return mediaBlock(a);
    if(inlineText&&host&&!textTypes.includes(a.type))return '<div class="dock-file"><span>'+esc(a.name)+'</span>'+artifactButton(a)+'</div>';
    if(inlineText&&host&&['text/markdown','text/plain','application/json'].includes(a.type))return '<div class="document-inline" data-document="'+esc(a.id)+'"><button data-asset="'+esc(a.id)+'">'+esc(a.name)+'</button><div class="document-body"></div></div>';
    return '<button class="file-token" data-asset="'+esc(a.id)+'">'+esc(a.name)+'</button>';
  }).join('');
}
function materializeFiles(root){
  if(!host)for(const img of root.querySelectorAll('img[data-picture]')){
    const a=lookupAsset(img.dataset.picture);if(a)pictureURL(a).then(url=>{if(url)img.src=url}).catch(()=>{});
  }
  if(host)fillProjects(root);
  if(host)for(const doc of root.querySelectorAll('[data-document]')){
    host.preview(doc.dataset.document).then(p=>{const el=doc.querySelector('.document-body');if(!doc.isConnected)return;
      if(p.type==='markdown'){el.className='document-body md';el.innerHTML=p.html}else el.textContent=p.text||'';
    }).catch(()=>{doc.querySelector('.document-body').textContent=uiText('无法读取本地文件')});
  }
}
// What the node was (or will be) asked: the prompt and its input files.
function sentPanel(k,parents,snap,spec){
  const actual=!snap&&run.prompts?.[k],items=nodeInputs(k,parents,snap),pending=editable(k);
  const heading=actual?uiText('实际发送的提示词'):snap||pending||!host?uiText('提示词预览'):uiText('实际发送的提示词');
  let text;
  if(actual){
    text=actual;
    for(const ref of run.sentInputs?.[k]||[]){const a=items.find(a=>a.id===ref.id);if(a?.type.startsWith('image/')&&ref.path)text=text.replaceAll(ref.path,a.name)}
  }else if(!pending&&host&&!snap)text=uiText('此历史运行没有记录提示词。');
  else{
    const material=snap?[]:parents.map(id=>run.files[id]?.body).filter(Boolean);
    text=uiText('任务\n')+spec.description+(material.length?uiText('\n\n素材\n')+material.join('\n\n'):'')+uiText('\n\n交付要求\n')+(Dag.delivery(spec)==='text'?uiText('直接回复「')+nodeTitle(k)+uiText('」的完整正文。'):uiText('交付「')+nodeTitle(k)+uiText('」。'));
  }
  const extras=pending?(run.extraInputs?.[k]||[]):[];
  const originalInputs=items.filter(a=>!extras.some(x=>x.id===a.id));
  const preview=!actual&&pending&&parents.some(p=>!run.files[p])?uiText('<small class="pending-input">上游交付后会补入素材。</small>'):'';
  return '<section class="sent-panel"><div class="panel-head"><h3>'+heading+'</h3>'+(actual?uiText('<button type="button" id="copyPrompt" class="panel-action">复制原文</button>'):'')+'</div>'+
    '<pre class="sent-text">'+esc(text)+'</pre>'+showFiles(originalInputs)+preview+(pending?attachmentField():'')+'</section>';
}
// What the node delivered.
function deliveredPanel(k,f){
  return '<section class="delivered-panel"><div class="panel-head"><h3>'+esc(nodeTitle(k))+'</h3><small>'+(f?uiText(Delivery.pendingLabel(run,k)||'已交付')+' · '+stamp(f.time):uiText('待交付'))+'</small></div>'+
    (f?.delivery==='project'?richAnswer(f.body,[],session().id)+projectCard():'')+(f&&f.delivery!=='project'?richAnswer(f.body,f.artifacts)+showFiles(f.delivery==='text'?unreferenced(f.body,f.artifacts||[]):(f.artifacts||[]),true):'')+
    (!f?uiText('<p class="empty">节点完成后，交付内容会显示在这里。</p>'):'')+'</section>';
}
