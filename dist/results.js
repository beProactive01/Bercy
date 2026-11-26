const answerMd=window.markdownit({html:false,breaks:true,linkify:false});
function linkedFile(token,attribute,env){
  const raw=token.attrGet(attribute)||'';
  let dest;try{dest=decodeURIComponent(raw)}catch{return}
  return (env.assets||[]).find(a=>a.path===dest||a.name===dest||'out/'+a.name===dest||'./'+a.name===dest);
}
function projectImage(href,project){
  if(!host||!project||!href||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href))return null;
  let path;try{path=decodeURIComponent(href.split(/[?#]/)[0])}catch{return null}
  if(!/\.(?:png|jpe?g|gif|webp|avif)$/i.test(path))return null;
  return {url:'relay-asset://project/'+encodeURIComponent(project)+'?path='+encodeURIComponent(href),name:path.split('/').pop()};
}
answerMd.renderer.rules.link_open=(tokens,i,options,env)=>{
  const t=tokens[i],asset=linkedFile(t,'href',env),href=t.attrGet('href')||'';
  const image=asset?.type.startsWith('image/')?{asset,url:'relay-asset://file/'+asset.id,name:asset.name}:projectImage(href,env.project);
  env.imageLink=!!(env.previews&&image);
  if(env.imageLink){
    env.previews.links.set(image.url,image);
    return '<span>';
  }
  if(asset)return '<a href="#" data-asset="'+esc(asset.id)+'">';
  // In a project delivery, relative links point at files in the project directory.
  if(env.project&&href&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(href)&&!href.startsWith('#'))return '<a href="#" data-project-file="'+esc(href)+'" data-project-id="'+esc(env.project)+uiText('" title="打开 ')+esc(href)+'">';
  return /^https?:\/\//i.test(href)?'<a target="_blank" rel="noopener noreferrer" href="'+esc(href)+'">':'<a>';
};
answerMd.renderer.rules.link_close=(_tokens,_i,_options,env)=>{
  if(!env.imageLink)return '</a>';
  env.imageLink=false;return '</span>';
};
answerMd.renderer.rules.image=(tokens,i,options,env)=>{
  const token=tokens[i],alt=esc(token.content),item=linkedFile(token,'src',env);
  const url=host&&item?.type.startsWith('image/')?'relay-asset://file/'+item.id:projectImage(token.attrGet('src'),env.project)?.url;
  if(!url)return alt;
  env.previews?.embedded.add(url);
  return '<img src="'+esc(url)+'" alt="'+alt+'" loading="lazy">';
};
function richAnswer(body,assets=[],project='',previews){return '<div class="answer-md md">'+answerMd.render(body||'',{assets,project,previews})+'</div>'}
function answerImage({url,name,asset}){
  return '<figure class="dock-image"><button type="button" '+(asset?'data-asset="'+esc(asset.id)+'"':'data-project-image')+
    ' aria-label="'+esc(uiText('放大 ')+name)+'"><img src="'+esc(url)+'" alt="'+esc(name)+'" loading="lazy"></button><figcaption>'+esc(name)+'</figcaption></figure>';
}
function mediaBlock(a){
  const url='relay-asset://file/'+esc(a.id);
  const media=a.type.startsWith('image/')?'<img src="'+url+'" alt="'+esc(a.name)+'" loading="lazy">':
    a.type.startsWith('video/')?'<video src="'+url+'" controls preload="metadata"></video>':
    a.type.startsWith('audio/')?'<audio src="'+url+'" controls preload="metadata"></audio>':'';
  return '<figure class="result-asset">'+media+'<button data-asset="'+esc(a.id)+'">'+esc(a.name)+uiText(' <span>查看文件 ↗</span></button></figure>');
}
function outputModeField(value){
  const choices=[['text',uiText('直接文字')],['file',uiText('文件')],['mixed',uiText('正文和附件')],['project',uiText('项目目录')]];
  return choices.map(([key,label])=>'<option value="'+key+'" '+(value===key?'selected':'')+'>'+label+'</option>').join('');
}
const copyMark='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="6.5" width="9.5" height="10" rx="2"/><path d="M12.5 4.5V4a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>';

function pauseAnswerMedia(){
  for(const el of $('answerContent').querySelectorAll('audio,video'))if(!el.paused)el.pause();
}

const textTypes=['text/markdown','text/plain','application/json'];
// File-delivery notes often name absolute paths; readers only need the file name.
function tidyNote(body,assets){
  let text=String(body||'');
  for(const a of assets)if(a.path)text=text.split(a.path).join(a.name);
  return text.replace(/`?(?:\/[^\s`'"“”）)]+\/)+([^\/\s`'"“”）)]+)`?/g,'$1');
}
// Text files show their content, media plays in place, other formats get one open button.
function artifactButton(a){
  if(!host)return '';
  const open=Delivery.canOpen(a.name);
  return '<button type="button" class="secondary" '+(open?'data-open':'data-reveal')+'="'+esc(a.id)+'">'+uiText(open?'用默认应用打开':'在 Finder 中显示')+'</button>';
}
function deliveredFiles(assets){
  return assets.map(a=>{
    if(a.type.startsWith('image/'))return answerImage({url:'relay-asset://file/'+a.id,name:a.name,asset:a});
    if(/^(video|audio)\//.test(a.type))return mediaBlock(a);
    if(host&&textTypes.includes(a.type))return '<section class="dock-doc" data-document="'+esc(a.id)+'"><div class="dock-doc-head"><b>'+esc(a.name)+'</b><button type="button" data-asset="'+esc(a.id)+uiText('">放大查看</button></div><div class="document-body"></div></section>');
    return '<div class="dock-file"><span>'+esc(a.name)+'</span>'+artifactButton(a)+'</div>';
  }).join('');
}
// Pictures the text already embeds are not repeated below it.
function unreferenced(body,assets){const text=String(body||'');return assets.filter(a=>!text.includes(a.name)&&!(a.path&&text.includes(a.path)))}
// A project delivery is a directory: show where it is, what is in it and its README, with one click to open it.
function projectCard(){return host?'<section class="project-card" data-project="'+esc(session().id)+uiText('"><p class="muted">正在读取项目目录…</p></section>'):''}
function fillProjects(root){
  for(const box of root.querySelectorAll('[data-project]')){
    if(box.dataset.filled)continue;box.dataset.filled='1';
    host.projectInfo(box.dataset.project).then(p=>{
      if(!p){box.innerHTML=uiText('<p class="muted">项目目录还没有内容。</p>');return}
      box.innerHTML='<div class="project-head"><div><b>'+esc(p.name)+'</b><small>'+esc(p.root)+'</small></div><button type="button" class="secondary" data-open-project="'+esc(box.dataset.project)+uiText('">在 Finder 中打开</button></div>')+
        '<ul class="project-tree">'+p.tree.map(t=>'<li style="padding-left:'+(t.depth*16)+'px"><a href="#" data-project-file="'+esc(t.path)+'" data-project-id="'+esc(box.dataset.project)+'">'+(t.dir?'📁 ':'')+esc(t.path.split('/').pop())+'</a></li>').join('')+'</ul>'+
        (p.readme?'<details class="project-readme" open><summary>README</summary><div class="md">'+p.readme+'</div></details>':'');
    }).catch(()=>{box.innerHTML=uiText('<p class="muted">无法读取项目目录。</p>')});
  }
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-open-project]');if(b){host.openProject(b.dataset.openProject).catch(err=>notify(err.message));return}
  const link=e.target.closest('[data-project-file]');
  if(link){e.preventDefault();host.openProjectFile(link.dataset.projectId,link.dataset.projectFile).then(r=>notify(r==='opened'?uiText('已用默认应用打开 ')+link.dataset.projectFile:uiText('已在 Finder 中显示 ')+link.dataset.projectFile)).catch(err=>notify(String(err.message||err).replace(/^Error invoking remote method '[^']+': Error: /,'')))}
});
// The body often opens with the same line as the card title; showing it twice reads as a glitch.
function withoutTitle(body,title){
  const lines=String(body||'').split('\n'),i=lines.findIndex(l=>l.trim());
  const bare=x=>String(x).replace(/^\s*#{1,6}\s+/,'').replace(/[*_`]/g,'').replace(/[:：]\s*$/,'').trim();
  return i>=0&&bare(lines[i])===bare(title)?lines.slice(i+1).join('\n').replace(/^\s*(?:-{3,}|\*{3,})\s*\n/,''):body;
}
function replyArticle(k){
  const file={...run.files[k]};file.body=withoutTitle(file.body,file.title);
  const all=file.artifacts||[],previews={links:new Map(),embedded:new Set()};
  const project=file.delivery==='project'?session().id:'';
  const body=file.delivery==='text'||project?file.body:tidyNote(file.body,all);
  const rich=richAnswer(body,all,project,previews);
  const linkedImages=[...previews.links.values()].filter(a=>!previews.embedded.has(a.url));
  const assets=all.filter(a=>{
    if(!a.type.startsWith('image/'))return file.delivery!=='text'||unreferenced(file.body,[a]).length;
    const url='relay-asset://file/'+a.id;
    return !previews.embedded.has(url)&&!previews.links.has(url);
  });
  const shown=assets.some(a=>/^(image|video|audio)\//.test(a.type)||textTypes.includes(a.type));
  const simpleFileNote=file.delivery==='file'&&shown&&!previews.links.size&&!previews.embedded.size;
  const note=simpleFileNote?'<p class="dock-note">'+esc(body.slice(0,300))+'</p>':rich;
  const images=linkedImages.length?'<div class="dock-images">'+linkedImages.map(answerImage).join('')+'</div>':'';
  const attachments=assets.length?'<div class="result-attachments">'+deliveredFiles(assets)+'</div>':'';
  return '<article class="dock-reply"><div class="dock-byline"><button class="dock-author" type="button" data-id="'+esc(k)+uiText('" title="查看交付节点"><canvas aria-hidden="true"></canvas>')+esc(displayRole(run,k).name)+'</button>'+
    '<button class="dock-copy" type="button" data-copy="'+esc(k)+uiText('" aria-label="复制正文" title="复制正文">')+copyMark+'</button></div>'+
    '<h3>'+esc(file.title)+'</h3>'+(simpleFileNote?attachments+note:note+images+attachments)+(project?projectCard():'')+
    (file.gaps?uiText('<p class="route-note gap-note">交付缺口 · ')+esc(file.gaps)+'</p>':'')+'</article>';
}

function renderAnswerDock(s,done){
  const panel=$('answer'),handle=$('answerHandle'),content=$('answerContent');
  const open=s.answerOpen??done;
  if(!open||content.dataset.session!==s.id)pauseAnswerMedia();
  panel.hidden=!open;
  handle.hidden=open;
  handle.setAttribute('aria-expanded',String(open));
  handle.classList.toggle('delivered',done&&Delivery.finalLabel(s.flow)==='已交付');
  if(!open)return;

  const ends=Dag.outputs(run.deps).filter(id=>!run.files[id]?.skipped),ready=ends.filter(id=>run.files[id]);
  // A hand-edited delivery keeps its id and time, so its edit stamp is part of the key.
  const key=JSON.stringify([s.id,run.versions.length,Object.entries(run.files).map(([k,f])=>[k,f.time,f.editedAt||0]),run.errors,run.started]);
  if(content.dataset.key===key)return;
  const sameSession=content.dataset.session===s.id,scroll=sameSession?content.scrollTop:0;
  const briefExpanded=sameSession&&content.querySelector('.dock-brief')?.open;
  const visibleIds=new Set(ready.flatMap(id=>(run.files[id].artifacts||[]).map(a=>a.id)));
  const rest=[];
  const sources=Object.entries(run.files).map(([id,file])=>{
    const media=[];
    for(const a of file.artifacts||[]){
      if(visibleIds.has(a.id))continue;
      visibleIds.add(a.id);
      (/^(image|video|audio)\//.test(a.type)?media:rest).push(a);
    }
    if(!media.length)return '';
    return '<section class="dock-media"><h3>'+esc(displayRole(run,id).name)+'</h3><div class="result-attachments">'+media.map(a=>
      a.type.startsWith('image/')?answerImage({url:'relay-asset://file/'+a.id,name:a.name,asset:a}):mediaBlock(a)).join('')+'</div></section>';
  }).join('');
  const count=Object.keys(run.deps).length,delivered=Object.keys(run.files).length;
  const blocked=Object.keys(run.errors||{}).length>0;
  // Gaps reported further up may have been settled downstream or silently carried into the answer: list them for the reader to check.
  const upstreamGaps=Object.entries(run.files).filter(([k,f])=>f.gaps&&!f.skipped&&!ready.includes(k));
  const gapList=ready.length&&upstreamGaps.length?uiText('<section class="route-note gap-note dock-gaps"><b>上游节点报告的缺口</b><ul>')+upstreamGaps.map(([k,f])=>'<li><b>'+esc(displayRole(run,k).name)+'</b> · '+esc(f.gaps)+'</li>').join('')+'</ul></section>':'';
  const pending='<div class="dock-pending"><h3>'+(blocked?uiText('等待处理'):run.started?uiText('等待最终交付'):uiText('等待工作流运行'))+uiText('</h3><progress aria-label="已交付节点" max="')+count+'" value="'+delivered+'"></progress><p>'+delivered+' / '+count+uiText(' 个节点已交付</p></div>');
  content.innerHTML=(ready.length?ready.map(replyArticle).join('')+gapList+sources:pending)+
    (ready.length&&rest.length?uiText('<details class="dock-detail"><summary>其他交付文件（')+rest.length+'）</summary>'+assetLinks(rest)+'</details>':'')+
    '<details class="dock-detail dock-brief" '+(briefExpanded?'open':'')+uiText('><summary>本次任务</summary><p>')+esc(run.query)+'</p><div class="question-images"></div></details>';
  content.dataset.key=key;
  content.dataset.session=s.id;
  for(const button of content.querySelectorAll('.dock-author')){
    sprite(button.querySelector('canvas'),run.pack[button.dataset.id].avatar||'writer');
  }
  const pictures=content.querySelector('.question-images');
  for(const item of (s.attachments||[]).filter(a=>a.type.startsWith('image/'))){
    const button=document.createElement('button'),img=document.createElement('img');
    button.type='button';button.dataset.asset=item.id;img.alt=item.name;button.append(img);pictures.append(button);
    pictureURL(item).then(url=>{if(url)img.src=url}).catch(()=>{});
  }
  materializeFiles(content);if(host)fillProjects(content);
  content.scrollTop=scroll;
}

function toggleAnswer(open){
  session().answerOpen=open;
  save();render();
  $(open?'answerClose':'answerHandle').focus({preventScroll:true});
}
document.getElementById('answerHandle').onclick=()=>toggleAnswer(true);
document.getElementById('answerClose').onclick=()=>toggleAnswer(false);
function installAnswerResize(){
  const panel=document.getElementById('answer'),handle=document.getElementById('answerResize');
  const key='bercy.answerWidth';
  const apply=width=>panel.style.setProperty('--answer-width',width+'px');
  const persist=()=>{try{localStorage.setItem(key,String(panel.offsetWidth))}catch{}};
  try{
    const width=Number(localStorage.getItem(key));
    if(Number.isFinite(width)&&width>0)apply(width);
  }catch{}
  const limits=()=>{
    const style=getComputedStyle(panel);
    return [Math.ceil(parseFloat(style.minWidth)),Math.floor(parseFloat(style.maxWidth))];
  };
  new ResizeObserver(()=>{
    if(panel.hidden)return;
    const [min,max]=limits();
    handle.setAttribute('aria-valuemin',String(min));
    handle.setAttribute('aria-valuemax',String(max));
    handle.setAttribute('aria-valuenow',String(panel.offsetWidth));
  }).observe(panel);
  let drag;
  handle.addEventListener('pointerdown',e=>{
    if(e.button!==0||drag)return;
    e.preventDefault();
    handle.focus({preventScroll:true});
    drag={pointer:e.pointerId,x:e.clientX,width:panel.offsetWidth};
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove',e=>{
    if(drag?.pointer===e.pointerId)apply(drag.width+drag.x-e.clientX);
  });
  handle.addEventListener('lostpointercapture',()=>{
    drag=undefined;
    handle.classList.remove('dragging');
    apply(panel.offsetWidth);
    persist();
  });
  handle.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    const [min,max]=limits(),step=e.shiftKey?80:24,current=panel.offsetWidth;
    const width={ArrowLeft:current+step,ArrowRight:current-step,Home:min,End:max}[e.key];
    apply(Math.max(min,Math.min(max,width)));
    persist();
  });
  handle.addEventListener('dblclick',()=>{
    panel.style.removeProperty('--answer-width');
    try{localStorage.removeItem(key)}catch{}
  });
}
installAnswerResize();
document.getElementById('answer').addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();toggleAnswer(false)}
});
document.getElementById('answer').onclick=async e=>{
  const image=e.target.closest('[data-project-image]')?.querySelector('img');
  if(image){
    if(image.naturalWidth)dialog(uiText('本地产物'),image.alt,'<img class="media-preview" src="'+esc(image.currentSrc)+'" alt="'+esc(image.alt)+'">');
    return;
  }
  const open=e.target.closest('[data-open]')?.dataset.open;
  if(open){host.open(open).catch(err=>notify(err.message));return}
  const k=e.target.closest('[data-copy]')?.dataset.copy;
  if(k){try{await navigator.clipboard.writeText(run.files[k].body);notify(uiText('已复制正文'))}catch{notify(uiText('请选择正文并复制'))}}
};
