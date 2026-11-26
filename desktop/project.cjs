const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
// Shared project directories: one per workflow, planned by the planner, kept when the workflow is deleted.
function root(projectsDir,sessionId,name){
  fs.mkdirSync(projectsDir,{recursive:true});
  const id=String(sessionId).replace(/[^a-z0-9-]/gi,'').slice(0,8);
  const existing=fs.readdirSync(projectsDir).find(d=>d.endsWith('-'+id));
  if(existing)return path.join(projectsDir,existing);
  const slug=String(name||'项目').replace(/[\\/:*?"<>|\s]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'项目';
  const dir=path.join(projectsDir,slug+'-'+id);fs.mkdirSync(dir,{recursive:true});return dir;
}
// The planned layout and conventions become the project's AGENTS.md (read natively by Codex) and CLAUDE.md imports it,
// so every agent working in the directory shares one contract. Text outside the generated block is kept.
function memory(root,goal,ws){
  const start='<!-- relay-room:start -->',end='<!-- relay-room:end -->',file=path.join(root,'AGENTS.md');
  const block=[start,'# 项目说明','','> 由 Bercy 根据规划生成，规划更新时会覆盖这一段；需要补充的内容写在本段之外。','','## 目标','',goal,
    ...((ws?.layout||[]).length?['','## 项目结构','',...ws.layout.map(l=>'- `'+l.path+'`'+(l.purpose?' —— '+l.purpose:''))]:[]),
    ...(ws?.conventions?['','## 约定','',ws.conventions]:[]),...(ws?.run?['','## 运行与验收','',ws.run]:[]),...(ws?.check?['','## 验收命令','','`'+ws.check+'`（在项目根目录执行，全部通过时退出码为 0）']:[]),
    '','## 协作规则','','- 只修改任务写明由你负责的路径，其他路径只读；需要改公共部分时，在交付说明里写清楚原因和建议。','- 能运行的部分要实际运行并确认通过，不要只写不跑。','- 保持项目随时可以从零运行；新增依赖要写进运行方式。',end].join('\n');
  let text='';try{text=fs.readFileSync(file,'utf8')}catch{}
  const i=text.indexOf(start),j=text.indexOf(end);
  text=i>=0&&j>i?text.slice(0,i)+block+text.slice(j+end.length):block+(text?'\n\n'+text:'')+'\n';
  fs.writeFileSync(file,text);
  const claude=path.join(root,'CLAUDE.md');if(!fs.existsSync(claude))fs.writeFileSync(claude,'@AGENTS.md\n');
}
// Files of a project directory with a size/mtime signature, for spotting which files a node changed.
// Hidden entries, dependency folders and the generated AGENTS.md/CLAUDE.md are left out.
const skipDirs=new Set(['node_modules','__pycache__','venv','.venv']),generated=new Set(['AGENTS.md','CLAUDE.md']);
async function snapshot(root,limit=20000){
  const out=new Map();
  async function walk(rel){
    if(out.size>=limit)return;
    let ents;try{ents=await fsp.readdir(path.join(root,rel),{withFileTypes:true})}catch{return}
    for(const e of ents){
      if(out.size>=limit)return;
      if(e.name.startsWith('.')||skipDirs.has(e.name))continue;
      const p=rel?rel+'/'+e.name:e.name;
      if(e.isDirectory())await walk(p);
      else if(e.isFile()&&!(rel===''&&generated.has(e.name))){try{const s=await fsp.stat(path.join(root,p));out.set(p,s.size+':'+s.mtimeMs)}catch{}}
    }
  }
  await walk('');return out;
}
function changes(before,after){
  const list=[];for(const [p,v] of after)if(before.get(p)!==v)list.push(p);
  for(const p of before.keys())if(!after.has(p))list.push(p);return list.sort();
}
// Whether a project-relative file falls under one of the planned paths ("src/core/" is a directory, "index.html" a file).
function within(file,paths){
  return paths.some(raw=>{const p=String(raw).replace(/^\.\//,'').replace(/\/+$/,'');return !p||file===p||file.startsWith(p+'/')});
}
module.exports={root,memory,snapshot,changes,within};
