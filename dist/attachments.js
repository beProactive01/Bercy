const imageURLs=new Map();
let imageDb;
function blobStore(){return imageDb??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('relay-room-images',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('images');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
})}
async function putBrowserImage(file){
  const id=uid(),db=await blobStore();
  await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put(file,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
  imageURLs.set(id,URL.createObjectURL(file));return {id,name:file.name||uiText('粘贴的图片.png'),type:file.type,bytes:file.size};
}
async function pictureURL(item){
  if(host)return 'relay-asset://file/'+item.id;
  if(!imageURLs.has(item.id)){
    const db=await blobStore(),blob=await new Promise((resolve,reject)=>{const q=db.transaction('images').objectStore('images').get(item.id);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
    if(blob)imageURLs.set(item.id,URL.createObjectURL(blob));
  }
  return imageURLs.get(item.id);
}
function attachmentField(){return uiText('<div class="attachbox"><div class="attachlist"></div><div class="attachbar"><button type="button" class="secondary pick-attachment">＋ 添加')+(host?uiText('文件或图片'):uiText('图片'))+uiText('</button><small>也可拖入或粘贴图片</small></div><input class="browser-pick" type="file" accept="image/*" multiple hidden></div>')}
function bindAttachments(parent,items,changed=()=>{},beforeAdd=()=>{}){
  const box=parent.querySelector('.attachbox');if(!box)return;
  // A dialog can show many nodes over its lifetime. Remove the previous binding when its contents change.
  parent.attachCleanup?.abort();const controller=new AbortController();parent.attachCleanup=controller;
  const options={signal:controller.signal},list=box.querySelector('.attachlist'),input=box.querySelector('.browser-pick'),pick=box.querySelector('.pick-attachment');
  const paint=()=>{list.replaceChildren();for(const item of items){
    const chip=document.createElement('div');chip.className='attachment-chip';const label=document.createElement('span');label.textContent=item.name;
    if(item.type?.startsWith('image/')){const img=document.createElement('img');img.alt=item.name;chip.append(img);pictureURL(item).then(url=>{if(url)img.src=url}).catch(()=>{})}
    const remove=document.createElement('button');remove.type='button';remove.ariaLabel=uiText('移除 ')+item.name;remove.textContent='×';
    remove.onclick=()=>{items.splice(items.indexOf(item),1);paint();changed()};chip.append(label,remove);list.append(chip);
  }};
  let busy=false;
  async function add(operation){
    if(busy)return;beforeAdd();busy=true;const controls=[...parent.querySelectorAll('button.primary,#manualBuild,.pick-attachment')],previous=controls.map(b=>b.disabled);
    controls.forEach(b=>b.disabled=true);
    try{const selected=await operation();if(!box.isConnected)return;items.push(...selected);paint();changed()}
    catch(err){notify(err.message)}
    finally{busy=false;controls.forEach((b,i)=>b.disabled=previous[i])}
  }
  const incoming=async file=>{
    if(!file.type.startsWith('image/'))throw Error(uiText('这里支持粘贴和拖入图片'));
    const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'})[file.type];
    if(!ext)throw Error(uiText('请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片'));
    const fileName=/\.(?:png|jpe?g|webp|gif|avif)$/i.test(file.name||'')?file.name:uiText('图片.')+ext;
    return host?host.image(fileName,await file.arrayBuffer()):putBrowserImage(file);
  };
  function receive(files){if(files.length)add(()=>Promise.all(files.map(incoming)))}
  pick.onclick=()=>host?add(()=>host.attach()):input.click();input.onchange=()=>{receive([...input.files]);input.value=''};
  parent.addEventListener('paste',e=>{if(!box.isConnected)return;const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();receive(files)}},options);
  parent.addEventListener('dragover',e=>{if(box.isConnected&&e.dataTransfer.types.includes('Files')){e.preventDefault();box.classList.add('over')}},options);
  parent.addEventListener('dragleave',()=>box.classList.remove('over'),options);
  parent.addEventListener('drop',e=>{if(!box.isConnected)return;e.preventDefault();box.classList.remove('over');receive([...e.dataTransfer.files])},options);
  paint();
}
