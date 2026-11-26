const {text:uiText}=require('../dist/i18n.js');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),{randomUUID}=require('node:crypto'),{Readable}=require('node:stream');
const mime={'.md':'text/markdown','.markdown':'text/markdown','.txt':'text/plain','.json':'application/json','.csv':'text/plain','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.html':'text/html','.py':'text/plain','.js':'text/plain','.ts':'text/plain','.css':'text/plain','.sh':'text/plain','.yaml':'text/plain','.yml':'text/plain','.toml':'text/plain'};
function atomic(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{mode:0o600});fs.renameSync(temp,file);
}
// Writes arrive in order; a write older than the newest one is dropped so it cannot replace newer state.
let newest=0;
async function atomicAsync(file,data,seq){
  if(seq<=newest)return false;newest=seq;
  await fsp.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+seq+'.tmp';
  await fsp.writeFile(temp,JSON.stringify(data),{mode:0o600});
  if(seq!==newest){await fsp.rm(temp,{force:true});return false}
  fs.renameSync(temp,file);return true;
}
function atomicNow(file,data,seq){if(seq<newest)return false;newest=seq;atomic(file,data);return true}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
async function previewText(file){
  const handle=await fsp.open(file);
  try{
    const stat=await handle.stat();
    if(!stat.isFile())throw Error(uiText('无法读取本地文件'));
    const buffer=Buffer.alloc(Math.min(1024*1024,stat.size));
    const {bytesRead}=await handle.read(buffer);
    return buffer.toString('utf8',0,bytesRead)+(stat.size>buffer.length?uiText('\n…（预览前 1 MiB）'):'');
  }finally{await handle.close()}
}
async function imageNames(directory){
  const entries=await fsp.readdir(directory,{withFileTypes:true});
  return entries.filter(e=>e.isFile()&&mime[path.extname(e.name).toLowerCase()]?.startsWith('image/')).map(e=>e.name).sort();
}
class Files{
  constructor(base){
    this.base=base;this.indexFile=path.join(base,'artifacts.json');this.index=read(this.indexFile,{});
    // Records keep absolute paths; when the data folder moved (renamed app, restored backup), they follow it.
    let home=base;try{home=fs.realpathSync(base)}catch{}
    const move=p=>{const i=String(p).lastIndexOf(path.sep+'runs'+path.sep);return i>=0&&p.slice(0,i)!==home?home+p.slice(i):p};
    let moved=false;
    for(const r of Object.values(this.index)){const root=move(r.root),file=move(r.path);if(root!==r.root||file!==r.path){r.root=root;r.path=file;moved=true}}
    if(moved)atomic(this.indexFile,this.index);
  }
  async attempt(){const cwd=path.join(this.base,'runs',randomUUID());await fsp.mkdir(path.join(cwd,'out'),{recursive:true});return cwd}
  // Remove a finished run directory (or only its input copies when its outputs are registered).
  async discard(cwd,keepOut=false){
    if(path.dirname(path.resolve(cwd))!==path.join(this.base,'runs'))return;
    await fsp.rm(keepOut?path.join(cwd,'inputs'):cwd,{recursive:true,force:true});
  }
  // Unregister files and delete each run directory that no longer holds a registered file.
  async forget(ids){
    const runs=path.join(this.base,'runs'),dirs=new Set();
    for(const id of ids){
      const r=Object.hasOwn(this.index,id)?this.index[id]:null;if(!r)continue;
      delete this.index[id];dirs.add(path.dirname(r.root));
    }
    atomic(this.indexFile,this.index);
    const kept=new Set(Object.values(this.index).map(r=>path.dirname(r.root)));
    for(const dir of dirs){
      if(kept.has(dir))continue;
      const real=await fsp.realpath(dir).catch(()=>null),home=await fsp.realpath(runs).catch(()=>null);
      if(real&&home&&path.dirname(real)===home)await fsp.rm(real,{recursive:true,force:true});
    }
  }
  // Delete run directories that hold no registered file and have not changed for a while (failed or abandoned runs).
  async sweep(maxAge=3*24*3600*1000){
    const runs=path.join(this.base,'runs'),home=await fsp.realpath(runs).catch(()=>null);if(!home)return 0;
    const kept=new Set(Object.values(this.index).map(r=>path.dirname(r.root)));let removed=0;
    for(const ent of await fsp.readdir(home,{withFileTypes:true})){
      const dir=path.join(home,ent.name);if(!ent.isDirectory()||kept.has(dir))continue;
      const stat=await fsp.stat(dir);if(Date.now()-stat.mtimeMs<maxAge)continue;
      await fsp.rm(dir,{recursive:true,force:true});removed++;
    }
    return removed;
  }
  async outputRoot(cwd){
    const dir=await fsp.realpath(cwd),runs=await fsp.realpath(path.join(this.base,'runs'));
    const root=await fsp.realpath(path.join(cwd,'out'));
    if(path.dirname(dir)!==runs||root!==path.join(dir,'out'))throw Error(uiText('交付目录不属于本次执行'));
    return root;
  }
  async register(cwd,names){
    const root=await this.outputRoot(cwd),records=[];
    for(const name of [...new Set(names)]){
      if(typeof name!=='string'||path.isAbsolute(name)||name.includes('..'+path.sep))throw Error(uiText('产物路径必须位于当前节点的 out 目录'));
      const file=path.resolve(root,name),real=await fsp.realpath(file);
      if(real!==file||!real.startsWith(root+path.sep))throw Error(uiText('产物越过当前交付目录'));
      const stat=await fsp.stat(real);if(!stat.isFile()||stat.size===0||stat.nlink!==1)throw Error(uiText('文件为空或无法登记 · ')+name);
      records.push({id:randomUUID(),name:path.relative(root,real),path:real,bytes:stat.size,type:mime[path.extname(real).toLowerCase()]||'application/octet-stream',root});
    }
    for(const r of records)this.index[r.id]=r;
    atomic(this.indexFile,this.index);return records;
  }
  async output(cwd,expected='',allowEmpty=false,only=null){
    const root=await this.outputRoot(cwd),names=[];
    async function collect(dir){
      for(const ent of await fsp.readdir(dir,{withFileTypes:true})){
        if(ent.name.startsWith('.'))continue;
        const file=path.join(dir,ent.name);
        if(ent.isSymbolicLink())throw Error(uiText('产物包含符号链接 · ')+ent.name);
        if(ent.isDirectory()){await collect(file);continue}
        if(ent.isFile()&&(!only||only.includes(path.extname(ent.name).toLowerCase())))names.push(path.relative(root,file));
        if(names.length>128)throw Error(uiText('单次交付超过 128 个文件'));
      }
    }
    await collect(root);if(!names.length&&allowEmpty)return [];if(!names.length)throw Error(uiText('交付目录为空，请检查节点记录后重试'));
    const formats={png:['.png'],mp4:['.mp4','.m4v'],webm:['.webm'],jpeg:['.jpg','.jpeg'],jpg:['.jpg','.jpeg'],pdf:['.pdf'],md:['.md','.markdown']};
    for(const [format,exts] of Object.entries(formats)){
      if(new RegExp('(?:^|[^a-z0-9])'+format+'(?:$|[^a-z0-9])','i').test(expected)&&!names.some(name=>exts.includes(path.extname(name).toLowerCase())))throw Error(uiText('交付目录缺少要求的 ')+format.toUpperCase()+uiText(' 文件'));
    }
    return this.register(cwd,names);
  }
  async importImage(name,bytes){
    const data=Buffer.from(bytes);if(!data.length||data.length>32*1024*1024)throw Error(uiText('粘贴或拖入的图片须小于 32 MiB，大图可通过选择文件添加'));
    const file=path.basename(name||uiText('图片.png')).replaceAll('\u0000','');
    if(!mime[path.extname(file).toLowerCase()]?.startsWith('image/'))throw Error(uiText('暂不支持此图片格式'));
    const cwd=await this.attempt();await fsp.writeFile(path.join(cwd,'out',file),data,{flag:'wx'});return (await this.register(cwd,[file]))[0];
  }
  async import(paths){
    const cwd=await this.attempt(),names=[];
    for(const [i,file] of paths.entries()){const name=String(i+1)+'-'+path.basename(file);await fsp.copyFile(file,path.join(cwd,'out',name),fs.constants.COPYFILE_FICLONE);names.push(name)}
    return this.register(cwd,names);
  }
  async get(id){
    const r=this.index[id];if(!r||!Object.hasOwn(this.index,id))throw Error(uiText('未登记的产物'));
    const real=await fsp.realpath(r.path),s=await fsp.stat(real);if(real!==r.path||!s.isFile()||s.nlink!==1||!real.startsWith(r.root+path.sep))throw Error(uiText('产物路径已经变化'));return r;
  }
  async inputs(cwd,groups){
    return Promise.all(groups.map(async (g,i)=>{
      const dest=path.join(cwd,'inputs',String(i+1));
      const files=await Promise.all(g.ids.map(async id=>{
        const r=await this.get(id),target=path.join(dest,r.name);await fsp.mkdir(path.dirname(target),{recursive:true});
        await fsp.copyFile(r.path,target,fs.constants.COPYFILE_FICLONE);
        const inline=['text/markdown','text/plain'].includes(r.type)&&r.bytes<=32768?await fsp.readFile(target,'utf8'):undefined;
        return {id:r.id,name:r.name,path:target,type:r.type,inline};
      }));return {title:String(g.title||''),text:String(g.text||''),summary:String(g.summary||'').slice(0,400),files};
    }));
  }
  // Keeps the inline material under a budget: the longest upstream texts move to files and the prompt keeps an excerpt.
  async budget(cwd,groups,limit=30000){
    let total=groups.reduce((n,g)=>n+g.text.length,0);
    for(const [i,g] of [...groups.entries()].sort((a,b)=>b[1].text.length-a[1].text.length)){
      if(total<=limit||g.text.length<=2000)break;
      const name=(g.title||uiText('上游交付')).replace(/[\\/:*?"<>|\u0000]/g,'_').slice(0,60)+'.md',dir=path.join(cwd,'inputs','text-'+(i+1)),file=path.join(dir,name);
      await fsp.mkdir(dir,{recursive:true});await fsp.writeFile(file,g.text);
      const excerpt=g.text.slice(0,1500);total-=g.text.length-excerpt.length;
      g.text='「'+(g.title||uiText('上游交付'))+uiText('」全文 ')+g.text.length+uiText(' 字，完整内容在 ')+file+uiText('，需要时请完整阅读。开头摘录：\n')+excerpt;
      g.spilled=file;
    }
    return groups;
  }
  async preview(id){
    const r=await this.get(id),url='relay-asset://file/'+r.id;
    if(!['text/markdown','text/plain','application/json'].includes(r.type))return {type:r.type,url};
    const text=await previewText(r.path);
    if(r.type!=='text/markdown')return {type:'text',text};
    const md=require('markdown-it')({html:false,linkify:false});
    const lookup=src=>{try{const target=path.resolve(path.dirname(r.path),decodeURIComponent(src));return Object.values(this.index).find(v=>v.root===r.root&&v.path===target)}catch{return null}};
    md.renderer.rules.image=(tokens,i)=>{const token=tokens[i],a=lookup(token.attrGet('src'));return a?.type.startsWith('image/')?'<img src="relay-asset://file/'+a.id+'" alt="'+md.utils.escapeHtml(token.content)+'">':md.utils.escapeHtml(token.content)};
    md.renderer.rules.link_open=(tokens,i)=>{const a=lookup(tokens[i].attrGet('href'));return a?'<a href="#" data-asset="'+a.id+'">':'<a>'};
    return {type:'markdown',html:md.render(text)};
  }
  async response(id,range){
    try{const r=await this.get(id),size=(await fsp.stat(r.path)).size;
      const headers={'Content-Type':r.type,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
      if(!/^(image|audio|video)\//.test(r.type))return new Response(null,{status:415});
      let start=0,end=size-1;
      if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416});
        if(!m[1])start=Math.max(0,size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]))}
        if(start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
        headers['Content-Range']='bytes '+start+'-'+end+'/'+size;
      }
      headers['Content-Length']=String(end-start+1);
      return new Response(Readable.toWeb(fs.createReadStream(r.path,{start,end})),{status:range?206:200,headers});
    }catch{return new Response(null,{status:404})}
  }
  async projectImage(file){
    const type=mime[path.extname(file).toLowerCase()];
    if(!type?.startsWith('image/'))return new Response(null,{status:415});
    try{
      const stat=await fsp.stat(file);
      if(!stat.isFile()||!stat.size)return new Response(null,{status:404});
      return new Response(Readable.toWeb(fs.createReadStream(file)),{headers:{'Content-Type':type,'Content-Length':String(stat.size),'X-Content-Type-Options':'nosniff'}});
    }catch{return new Response(null,{status:404})}
  }
}
module.exports={Files,atomic,atomicAsync,atomicNow,read,previewText,imageNames};
