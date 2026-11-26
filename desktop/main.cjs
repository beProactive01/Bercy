const Delivery=require('../dist/delivery.js'),textChecks=require('./text-checks.cjs');
const i18n=require('../dist/i18n.js'),uiText=i18n.text;
const {app,BrowserWindow,ipcMain,protocol,dialog,shell,Menu,nativeTheme,systemPreferences}=require('electron');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const fs=require('node:fs'),{Files,read,atomic,previewText,imageNames}=require('./files.cjs'),runtime=require('./runtimes.cjs'),prompts=require('./prompts.cjs'),{Store}=require('./store.cjs'),{randomUUID}=require('node:crypto'),project=require('./project.cjs');
const entry=path.join(__dirname,'../dist/index.html'),entryURL=pathToFileURL(entry).href;
protocol.registerSchemesAsPrivileged([{scheme:'relay-asset',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
const profile=process.env.BERCY_PROFILE||process.env.RELAY_PROFILE;
if(profile)app.setPath('userData',path.resolve(profile));
// The app was called Relay Room before: its data folder moves over once, before anything opens it. Electron may
// already have created an empty folder under the new name; anything more in it is kept and the old folder is used.
else{
  const now=app.getPath('userData'),old=path.join(path.dirname(now),'Relay Room');
  if(fs.existsSync(path.join(old,'relay.db'))&&!fs.existsSync(path.join(now,'relay.db'))){
    try{if(fs.existsSync(now)&&!fs.readdirSync(now).length)fs.rmdirSync(now);fs.renameSync(old,now)}catch{app.setPath('userData',old)}
  }
}
if(!app.requestSingleInstanceLock()){app.quit()}else{
const base=app.getPath('userData'),stateFile=path.join(base,'workspace.json'),configFile=path.join(base,'runtime-paths.json'),customFile=path.join(base,'custom-runtimes.json'),files=new Files(base);
let win,catalog=[],overrides=read(configFile,{}),custom=read(customFile,[]);const jobs=new Map();
// Approval policy for running nodes. Allow uses the fullest access supported by each adapter.
let approvalMode='auto';const approvals=new Map();
function trusted(e){if(e.sender!==win?.webContents||e.senderFrame?.url!==entryURL)throw Error(uiText('请求来自未知窗口'))}
function handle(name,fn){ipcMain.handle('relay:'+name,(e,...args)=>{trusted(e);return fn(...args)})}
// Workspace in SQLite. The JSON file of earlier versions is imported once and kept as workspace.imported.json.
// Planning guide: the user's copy in the profile folder, or the one shipped with the app.
const guideFile=path.join(base,'planning-guide.md'),defaultGuide=()=>path.join(__dirname,i18n.language==='en'?'planning-guide.en.md':'planning-guide.md');
const planningGuide=()=>{try{return fs.readFileSync(guideFile,'utf8')}catch{try{return fs.readFileSync(defaultGuide(),'utf8')}catch{return ''}}};
const projectsDir=path.join(base,'projects'),projectRoot=(id,name)=>project.root(projectsDir,id,name),writeProjectMemory=project.memory;
// Only directories chosen through the native dialog may become execution roots.
const directoryFile=path.join(base,'project-directories.json');
const chosenDirectories=new Set(read(directoryFile,[]));
function localDirectory(directory){
  if(!directory)return null;
  if(!chosenDirectories.has(directory))throw Error(uiText('请重新选择项目目录'));
  try{if(fs.realpathSync(directory)===directory&&fs.statSync(directory).isDirectory())return directory}catch{}
  throw Error(uiText('项目目录不可用，请检查路径或磁盘连接')+' · '+directory);
}
handle('pick-project-directory',async()=>{
  const result=await dialog.showOpenDialog(win,{title:uiText('选择项目目录'),properties:['openDirectory']});
  if(result.canceled||!result.filePaths.length)return null;
  const directory=fs.realpathSync(result.filePaths[0]);
  atomic(directoryFile,[...new Set([...chosenDirectories,directory])]);chosenDirectories.add(directory);
  return directory;
});
// The existing project directory of a workflow, or null.
function findProject(sessionId){
  const selected=localDirectory(store.directory(sessionId));if(selected)return selected;
  const id=String(sessionId).replace(/[^a-z0-9-]/gi,'').slice(0,8);if(!id||!fs.existsSync(projectsDir))return null;
  const dir=fs.readdirSync(projectsDir).find(d=>d.endsWith('-'+id));return dir?path.join(projectsDir,dir):null;
}
const dbFile=path.join(base,'relay.db'),{store,problem}=Store.open(dbFile);let startupProblem=problem||null;
if(store.empty()&&fs.existsSync(stateFile)){
  try{const data=read(stateFile,null);if(data){store.importWorkspace(data);fs.renameSync(stateFile,stateFile.replace(/\.json$/,'.imported.json'))}}
  catch(err){const backup=stateFile.replace(/\.json$/,'.corrupt-'+Date.now()+'.json');try{fs.renameSync(stateFile,backup)}catch{}startupProblem={storageError:err.message,backup}}
}
if(!store.empty())store.backup(path.join(base,'relay.bak.db'));
ipcMain.on('relay:state',(e,patch)=>{
  try{trusted(e);if(patch!==undefined){store.apply(patch);e.returnValue=true}else{const p=startupProblem;startupProblem=null;e.returnValue=p||store.load()}}
  catch(err){e.returnValue={storageError:err.message}}
});
const send=data=>win?.webContents.send('relay:event',data);
async function scan(){catalog=await runtime.detect(overrides,custom);return catalog.map(({bin,...r})=>({...r,installed:!!bin,path:bin}))}
ipcMain.on('relay:system-languages',e=>{
  trusted(e);e.returnValue=app.getPreferredSystemLanguages();
});
handle('language',value=>i18n.setLanguage(value));
handle('scan',scan);
handle('store',patch=>store.apply(patch));
handle('events',sessionId=>store.events(String(sessionId)));
// User-added ACP runtimes: name, executable, arguments, capabilities and image support.
handle('custom-runtimes',async list=>{
  if(list!==undefined){
    if(!Array.isArray(list)||list.length>12)throw Error(uiText('最多添加 12 个自定义运行时'));
    custom=list.map(c=>({name:String(c.name||'').trim().slice(0,40),command:String(c.command||'').trim(),args:String(c.args??'acp').split(/\s+/).filter(Boolean).slice(0,12),caps:['write','shell','network'].filter(x=>(c.caps||[]).includes(x)),images:c.images===true}))
      .filter(c=>c.name&&c.command);
    atomic(customFile,custom);return scan();
  }
  return custom.map(c=>({...c,args:c.args.join(' ')}));
});
// What the answer panel shows for a project: where it is, its top-level files and its README.
handle('project-info',async sessionId=>{
  const root=findProject(sessionId);if(!root)return null;
  const dir=path.basename(root),tree=[];
  const walk=(rel,depth)=>{for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&e.name!=='node_modules').sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name))){
    if(tree.length>=80)return;const p=rel?rel+'/'+e.name:e.name;tree.push({path:p,dir:e.isDirectory(),depth});if(e.isDirectory()&&depth<1)walk(p,depth+1)}};
  walk('',0);
  let readme='';for(const n of ['README.md','readme.md']){try{readme=fs.readFileSync(path.join(root,n),'utf8').slice(0,60000);break}catch{}}
  const md=require('markdown-it')({html:false,linkify:false});
  return {root,name:dir,tree,readme:readme?md.render(readme):''};
});
// Links inside a project delivery: pages and documents open in their default app, anything else is shown in Finder.
// Paths are resolved inside the project directory only.
function resolveProjectFile(root,rel){
  let clean=String(rel||'').trim().replace(/^<|>$/g,'').replace(/^file:\/\//,'').split(/[?#]/)[0];
  try{clean=decodeURIComponent(clean)}catch{}
  const target=path.isAbsolute(clean)?clean:path.join(root,clean);
  let real;try{real=fs.realpathSync(target)}catch{throw Error(uiText('项目里没有这个文件：')+clean)}
  if(real!==root&&!real.startsWith(root+path.sep))throw Error(uiText('只能打开项目目录里的文件'));
  return real;
}
function projectFileRoot(sessionId){
  const directory=findProject(sessionId);
  if(!directory)throw Error(uiText('找不到项目目录'));
  return fs.realpathSync(directory);
}
handle('project-file',async(sessionId,rel)=>{
  const real=resolveProjectFile(projectFileRoot(sessionId),rel);
  if(fs.statSync(real).isFile()&&(Delivery.canOpen(real)||['.html','.htm','.svg'].includes(path.extname(real).toLowerCase()))){const err=await shell.openPath(real);if(err)throw Error(err);return 'opened'}
  shell.showItemInFolder(real);return 'revealed';
});
const pathForPreview=value=>value.split(path.sep).map(encodeURIComponent).join('/');
handle('project-preview',async(sessionId,rel)=>{
  const root=projectFileRoot(sessionId),file=resolveProjectFile(root,rel);
  const ext=path.extname(file).toLowerCase();
  if(!['.md','.markdown','.json'].includes(ext)||!fs.statSync(file).isFile())return null;
  const directory=path.dirname(file),base=pathForPreview(path.relative(root,directory)),text=await previewText(file);
  if(ext!=='.json')return {type:'markdown',base,text};
  let value;try{value=JSON.parse(text)}catch{return {type:'json',text,tests:[]}}
  const tests=[],pending=[['',value]];
  while(pending.length&&tests.length<40){
    const [name,item]=pending.pop();
    if(!item||typeof item!=='object')continue;
    if(typeof item.exit!=='number'&&typeof item.pass!=='string'){
      for(const entry of Object.entries(item).reverse())pending.push(entry);
      continue;
    }
    let images=[];
    if(typeof item.folder==='string'&&item.folder.trim()){
      const folder=path.resolve(directory,item.folder);
      try{
        const real=resolveProjectFile(root,pathForPreview(folder));
        images=(await imageNames(real)).map(name=>pathForPreview(path.relative(root,path.join(real,name))));
      }catch{}
    }
    tests.push({name,exit:typeof item.exit==='number'?item.exit:null,output:typeof item.pass==='string'?item.pass:'',images});
  }
  return {type:'json',text,tests};
});
handle('project-open',async sessionId=>{const root=findProject(sessionId);if(root){const err=await shell.openPath(root);if(err)throw Error(err)}});
handle('planning-guide',async text=>{
  if(text===null){fs.rmSync(guideFile,{force:true})}
  else if(typeof text==='string'){if(text.length>20000)throw Error(uiText('规划指南不能超过 2 万字'));atomicText(guideFile,text)}
  return {text:planningGuide(),custom:fs.existsSync(guideFile),path:guideFile};
});
function atomicText(file,text){const tmp=file+'.tmp';fs.writeFileSync(tmp,text,{mode:0o600});fs.renameSync(tmp,file)}
handle('reveal-guide',()=>{if(!fs.existsSync(guideFile))atomicText(guideFile,planningGuide());shell.showItemInFolder(guideFile)});
handle('pick-binary',async()=>{const res=await dialog.showOpenDialog(win,{title:uiText('选择运行时的可执行文件'),properties:['openFile']});return res.canceled?'':res.filePaths[0]});
handle('choose',async name=>{
  if(!catalog.some(r=>r.name===name))throw Error(uiText('未知运行时'));
  const res=await dialog.showOpenDialog(win,{title:uiText('选择 ')+name+uiText(' 的 CLI 可执行文件'),properties:['openFile']});
  if(!res.canceled){overrides[name]=res.filePaths[0];atomic(configFile,overrides)}return scan();
});
handle('attach',async()=>{const res=await dialog.showOpenDialog(win,{title:uiText('添加本次任务的输入文件'),properties:['openFile','multiSelections']});return res.canceled?[]:files.import(res.filePaths)});
handle('image',(name,bytes)=>files.importImage(name,bytes));
// Workflow files: the renderer builds and validates the JSON; the main process only picks the path and moves text.
const flowFileLimit=1024*1024,flowFilters=[{name:uiText('Bercy 工作流'),extensions:['json']}];
handle('export-flow',async(name,text)=>{
  if(typeof text!=='string'||text.length>flowFileLimit)throw Error(uiText('工作流文件过大'));
  const safe=String(name||'workflow').replace(/[\\/:*?"<>|\x00-\x1f]+/g,' ').trim().slice(0,80)||'workflow';
  const res=await dialog.showSaveDialog(win,{title:uiText('导出工作流'),defaultPath:safe+'.bercy.json',filters:flowFilters});
  if(res.canceled||!res.filePath)return false;
  fs.writeFileSync(res.filePath,text,'utf8');return true;
});
handle('import-flow',async()=>{
  const res=await dialog.showOpenDialog(win,{title:uiText('导入工作流'),properties:['openFile'],filters:flowFilters});
  if(res.canceled||!res.filePaths[0])return null;
  if(fs.statSync(res.filePaths[0]).size>flowFileLimit)throw Error(uiText('工作流文件过大'));
  return fs.readFileSync(res.filePaths[0],'utf8');
});
handle('forget',ids=>files.forget(Array.isArray(ids)?ids.filter(id=>typeof id==='string'):[]));
// Only document and media formats open in their default app; scripts, apps and pages never do.
handle('open',async id=>{const r=await files.get(id);if(!Delivery.canOpen(r.path))throw Error(uiText('此类文件请在 Finder 中查看'));const err=await shell.openPath(r.path);if(err)throw Error(err)});
handle('preview',id=>files.preview(id));handle('reveal',async id=>shell.showItemInFolder((await files.get(id)).path));
function cancelJob(key){
  jobs.get(key)?.controller.abort();
  for(const approval of approvals.values())if(approval.key===key)approval.resolve('deny');
}
handle('cancel',cancelJob);
handle('cancel-workflow',async sessionId=>{
  sessionId=String(sessionId);
  const prefix=sessionId+'/';
  for(const key of jobs.keys())if(key.startsWith(prefix))cancelJob(key);
  const pending=[...running,...checks].filter(([key])=>key.startsWith(prefix)).map(([,promise])=>promise);
  await Promise.all([Promise.allSettled(pending),runtime.stopWorkflow(sessionId)]);
});
handle('steer',async(key,text)=>{
  const job=jobs.get(key);if(!job?.thread||!job.runner.steer)throw Error(uiText('当前运行时不支持执行中追加要求'));
  const t=String(text||'').trim().slice(0,2000);if(!t)return;
  await runtime.steer(job.runner.bin,job.thread,t,job.scope);store.log(...ids(key),'steer',{text:t});
});
function ids(key){const [session,node]=String(key).split('/');return [session,node]}
// Approvals wait for the user unless the policy (or an earlier "allow for this run") already answers them.
function ask(key,runner,node,request){
  const job=jobs.get(key);
  if(job?.controller.signal.aborted)return Promise.resolve('deny');
  if(approvalMode==='allow'||job?.allowRun)return Promise.resolve('allow');
  const id=randomUUID(),approval={id,runtime:runner.name,node,...request,at:Date.now()};
  store.log(...ids(key),'approval',approval);
  return new Promise(resolve=>{
    approvals.set(id,{key,approval,resolve:decision=>{approvals.delete(id);send({key,approvalDone:id,decision});store.log(...ids(key),'decision',{id,decision});resolve(decision)}});
    send({key,approval});
  });
}
handle('approve',(id,decision)=>{
  const a=approvals.get(id);if(!a)return false;
  if(decision==='allow-all'){approvalMode='allow';for(const x of [...approvals.values()])x.resolve('allow');return true}
  if(decision==='allow-run'){const job=jobs.get(a.key);if(job)job.allowRun=true;for(const x of [...approvals.values()])if(x.key===a.key)x.resolve('allow-run');return true}
  a.resolve(decision==='allow'?'allow':'deny');return true;
});
handle('approval-mode',mode=>{
  if(!['auto','ask','allow'].includes(mode))throw Error(uiText('未知审批方式'));approvalMode=mode;
  if(mode==='allow')for(const x of [...approvals.values()])x.resolve('allow');return mode;
});
// Results are kept for a while after a run ends, so a window that reloaded mid-run can still collect them.
const running=new Map(),checks=new Map(),finished=new Map(),keepFor=10*60*1000;
function remember(key,outcome){
  finished.set(key,{...outcome,at:Date.now()});
  for(const [k,v] of finished)if(finished.size>20||Date.now()-v.at>keepFor)finished.delete(k);else break;
}
handle('execute',req=>{
  const key=String(req?.key||'');if(!key)throw Error(uiText('缺少执行标识'));
  if(running.has(key)||jobs.has(key))throw Error(uiText('本次执行已经在运行'));
  const p=execute(req);running.set(key,p);
  p.then(value=>remember(key,{value}),err=>remember(key,{error:err.message})).finally(()=>running.delete(key));
  return p;
});
handle('jobs',()=>({running:[...running.keys()],finished:Object.fromEntries([...finished.keys()].map(k=>[k,true])),approvals:[...approvals.values()].map(a=>({key:a.key,approval:a.approval}))}));
handle('await-job',async key=>{
  key=String(key);const p=running.get(key);if(p)return p;
  const f=finished.get(key);if(!f)throw Error(uiText('这次执行的结果已经不在了，请重新运行该节点'));
  finished.delete(key);if(f.error)throw Error(f.error);return f.value;
});
// Acceptance check: the project's own command, run in its directory after the last project node delivers.
// It runs outside any sandbox, so it is asked about unless the policy allows everything.
handle('check',(key,command)=>{
  key=String(key);
  if(checks.has(key))throw Error(uiText('本次执行已经在运行'));
  const promise=checkProject(key,command).finally(()=>checks.delete(key));
  checks.set(key,promise);
  return promise;
});
async function checkProject(key,command){
  key=String(key);const cmd=String(command||'').replace(/[\r\n]+/g,' ').trim().slice(0,300);if(!cmd)return null;
  const [session,node]=ids(key),root=findProject(session);if(!root)throw Error(uiText('找不到项目目录'));
  if(jobs.has(key))throw Error(uiText('本次执行已经在运行'));
  const controller=new AbortController();jobs.set(key,{controller,runner:{name:'Bercy'},allowRun:false});
  try{
    const decision=await ask(key,{name:'Bercy'},'',{kind:'command',title:uiText('项目验收命令'),command:cmd,cwd:root,reason:uiText('所有项目节点已交付，运行规划给出的验收命令（不在沙箱中执行）')});
    if(decision==='deny')return {skipped:true};
    const r=await runtime.check(cmd,root,controller.signal);
    store.log(session,node,'check',{command:cmd,ok:r.ok,code:r.code});return r;
  }finally{jobs.delete(key);for(const a of [...approvals.values()])if(a.key===key)a.resolve('deny')}
}
async function execute(req){
  const runner=catalog.find(r=>r.name===req.runtime);if(!runner?.bin)throw Error(uiText('运行时不可用，请在设置中连接 CLI'));
  const scope=String(req.key).includes('/')?ids(req.key)[0]:undefined;
  const controller=new AbortController(),job={controller,runner,scope,thread:null,allowRun:false};jobs.set(req.key,job);
  let cwd,keep='all';
  const runApprovalMode=approvalMode;
  try{
    const dbg=(...a)=>process.env.RELAY_DEBUG&&console.log('[execute]',req.key,...a);dbg('begin');
    cwd=await files.attempt();let prompt,images=[],sentInputs=[],reviewRoot='';dbg('attempt');
    const selected=localDirectory(req.directory);
    if(req.kind==='plan')prompt=prompts.plan(req.query,req.available,req.attachments||[],planningGuide(),String(req.projectGuide||'').slice(0,8000),selected?{directory:selected,files:[...(await project.snapshot(selected,300)).keys()]}:null);
    else if(req.kind==='brief')prompt=prompts.rebrief(req.query,req.definition);
    else if(req.kind==='revise')prompt=prompts.revise(req.query,req.evidence,req.source,req.targets,req.blocked);
    else if(req.kind==='observe')prompt=prompts.observe(req.query,req.state);
    else if(req.kind==='expand')prompt=prompts.expand({runtimes:Array.isArray(req.available)?req.available:undefined,projectFiles:await projectFiles(req.session),query:req.query,guide:planningGuide(),projectGuide:String(req.projectGuide||'').slice(0,8000),node:req.node,output:req.output,graph:req.graph,workspace:req.workspace,budget:req.budget});
    else if(req.kind==='node'){
      // Project nodes work inside the shared directory; their inputs sit in a hidden folder there for the duration of the run.
      if(prompts.Dag.delivery(req.node)==='project'){
        job.project=selected||projectRoot(String(req.key).split('/')[0],req.projectName);
        if(!selected)writeProjectMemory(job.project,req.query,req.workspace);
        // Scope check: files changed outside the node's planned paths are reported. Paths of project nodes running
        // at the same time count as theirs; a concurrent node that owns the whole project makes changes unattributable.
        job.paths=Array.isArray(req.node.paths)?req.node.paths.map(String):[];job.peers=[];
        for(const other of jobs.values())if(other!==job&&other.project===job.project&&other.paths){other.peers.push(job.paths);job.peers.push(other.paths)}
        if(job.paths.length)job.before=await project.snapshot(job.project);
        if(!selected){job.inputDir=path.join(job.project,'.relay',path.basename(cwd));fs.mkdirSync(job.inputDir,{recursive:true})}
      }
      // A review of a project node works in that project, so it checks the actual code rather than the upstream's own account of it.
      if(!job.project&&!selected&&req.node.review&&req.reviewed&&prompts.Dag.delivery(req.reviewed)==='project'){
        const root=projectRoot(String(req.key).split('/')[0],req.projectName);
        if(fs.existsSync(root))reviewRoot=root;
      }
      const inputRoot=job.inputDir||cwd;
      const inputs=await files.budget(inputRoot,await files.inputs(inputRoot,req.groups));
      const spilled=inputs.filter(g=>g.spilled).map(g=>g.title||uiText('上游交付'));
      if(spilled.length)send({key:req.key,message:uiText('素材较长，改为文件提供 · ')+spilled.join('、')});
      sentInputs=inputs.flatMap(g=>g.files).map(f=>({id:f.id,path:f.path}));
      const pictures=inputs.flatMap(g=>g.files).filter(f=>['image/png','image/jpeg','image/webp','image/gif'].includes(f.type));
      if(runner.supportsImages){images=pictures;for(const f of pictures)f.visual=true}
      if(pictures.length)send({key:req.key,message:(images.length?uiText('图像直传 · '):uiText('图片文件输入 · '))+pictures.map(f=>f.name).join('、')});
      prompt=prompts.worker({...req,inputs,outDir:path.join(cwd,'out'),workspace:req.workspace,projectRoot:job.project,localDirectory:selected||reviewRoot});
    }else throw Error(uiText('不支持的执行类型'));
    const node=req.kind==='node';dbg('prompt ready');
    if(node)send({key:req.key,prompt,sentInputs});
    const minutes=Number(req.timeout)>0?Math.min(180,Math.max(1,Number(req.timeout))):(node?0:12);
    const needs=Array.isArray(req.needs)?req.needs.filter(n=>typeof n==='string'):[];
    const [,nodeId]=ids(req.key);
    const persistThread=!!(node&&scope&&nodeId&&runner.protocol==='codex-app');
    const threadContext=JSON.stringify([runner.bin,selected||job.project||null,runApprovalMode]);
    const resumeThread=persistThread?store.nodeThread(scope,nodeId,threadContext):undefined;
    // Live progress goes to the window; finished steps also go to the event log.
    let lastDelta=0;
    const report=x=>{
      if(!node)return;
      if(x.thread){
        job.thread=x.thread;
        if(persistThread)store.putNodeThread(scope,nodeId,x.thread,threadContext);
        send({key:req.key,thread:x.thread,...(x.thread===resumeThread&&x.resumed?{prompt:uiText('（在同一对话中继续）\n\n')+prompt,sentInputs}:{})});
        return;
      }
      if(x.delta!=null){const now=Date.now();if(now-lastDelta<120)return;lastDelta=now;send({key:req.key,delta:x.delta.slice(-20000)});return}
      if(x.step){send({key:req.key,step:x.step});if(x.step.status!=='running')store.log(...ids(req.key),'step',x.step)}
    };
    const opts={name:runner.name,bin:runner.bin,scope,protocol:runner.protocol,args:runner.args,model:req.model,cwd:selected||job.project||reviewRoot||cwd,attemptDir:cwd,extraDirectory:(selected||reviewRoot)&&req.kind==='node'?cwd:undefined,images,signal:controller.signal,report,
      usage:value=>{if(node)send({key:req.key,usage:value})},planning:!node,persistThread,captureSources:node&&req.node.needs?.includes('network'),needs,timeout:minutes*60*1000,approvalMode:runApprovalMode,
      approve:request=>ask(req.key,runner,req.node?.name||'',request)};
    dbg('invoke');
    const out=await runtime.invoke({...opts,prompt,threadId:resumeThread});
    let raw=typeof out==='string'?out:out.text,thread=typeof out==='object'?out.threadId:null;
    if(node && prompts.Dag.delivery(req.node)==='text'){
      raw=textChecks.copyBody(raw,req.node);
      const rules=textChecks.checksFor(req.node,req.reviewed);
      const validate=reply=>{
        const {body,needsInput}=prompts.receipt(reply);
        if(needsInput)return '';
        if(/^(?:未完成|无法完成|blocked)\s*[:：]/i.test(body))return '';
        if(req.node.review&&/^(?:退回|return)\s*[:：]/i.test(body))return '';
        return textChecks.violation(body,rules);
      };
      const issue=validate(raw);
      if(issue){
        send({key:req.key,message:uiText('文字验收未通过 · ')+issue});
        const retryPrompt=prompt+'\n\n'+uiText('上一版正文')+'\n'+raw+'\n\n'+uiText('请修正以下验收问题，只返回符合原要求的完整交付。')+'\n'+issue;
        const retry=await runtime.invoke({...opts,prompt:retryPrompt,threadId:thread||undefined});
        raw=textChecks.copyBody(typeof retry==='string'?retry:retry.text,req.node);thread=retry.threadId||null;
        const remaining=validate(raw);
        if(remaining)throw Error(uiText('文字验收未通过 · ')+remaining);
      }
    }
    if(node)store.log(...ids(req.key),'result',{runtime:runner.name,chars:raw.length});
    if(node){
      const {body,gaps,needsInput}=prompts.receipt(raw),summary=body.slice(0,400);
      if(needsInput){keep='none';return {summary,body,gaps,needsInput:true,delivery:'text',artifacts:[],thread}}
      if(/^(?:未完成|无法完成|blocked)\s*[:：]/i.test(summary)){keep='none';return {blocked:summary}}
      if(req.node.review&&/^(?:退回|return)\s*[:：]/i.test(summary)){
        keep='none';
        const reason=body.replace(/^(?:退回|return)\s*[:：]\s*/i,'').slice(0,1200);
        if(!req.node.canReturn)throw Error(uiText('复核未通过，已停止自动退回。')+' '+reason);
        return {rework:reason||uiText('复核未通过')};
      }
      const delivery=prompts.Dag.delivery(req.node);
      if(delivery==='project'){
        let outside;
        if(job.before&&!job.peers.some(p=>!p.length)){
          const changed=project.changes(job.before,await project.snapshot(job.project));
          outside=changed.filter(f=>!project.within(f,job.paths)&&!job.peers.some(p=>project.within(f,p))).slice(0,40);
          if(outside.length)store.log(...ids(req.key),'scope',{outside});
        }
        return {summary,body,gaps,delivery,artifacts:[],thread,project:job.project,...(outside?.length?{outside}:{})};
      }
      // Text replies may still bring pictures they reference inline; those are registered so the answer can show them.
      const artifacts=delivery==='text'?await files.output(cwd,'',true,['.png','.jpg','.jpeg','.gif','.webp']):await files.output(cwd,req.node.artifact,delivery==='mixed');
      keep=artifacts.length?'out':'none';
      return {summary,body,gaps,delivery,artifacts,thread};
    }
    keep='none';
    if(req.kind==='plan'){
      const names=(req.available||[]).map(r=>r.name);
      const build=text=>{
        const parsed=prompts.parse(text),{nodes,notes}=prompts.Dag.tidy(parsed.nodes,names);
        const policy=prompts.Dag.briefPolicy(req.query);
        const d=prompts.Dag.assignBriefRuntimes(prompts.Dag.definition(nodes,parsed.workspace),policy);
        const final=prompts.Dag.outputs(d.deps);
        if(policy.autoContinue&&final.length===1)d.roles[final[0]].continueAfter=true;
        d.notes=[...notes,...(d.notes||[])];
        if(nodes.length>1&&typeof parsed.split==='string'&&parsed.split.trim())d.split=parsed.split.trim().slice(0,300);
        return d;
      };
      try{return build(raw)}catch(err){
        // One repair attempt: the planner sees exactly why its plan was rejected.
        const retry=await runtime.invoke({...opts,prompt:prompt+'\n\n上一次输出无法使用：'+err.message+'。请重新只输出符合约定的 JSON。'});
        const d=build(retry);d.notes=[...d.notes,uiText('规划经过一次修正')];return d;
      }
    }
    const result=prompts.parse(raw);
    if(req.kind==='revise')return result.change||null;
    if(req.kind==='expand')return result.expand||null;
    if(req.kind==='observe'&&req.state?.terminal){
      const continuation=result.continuation,rework=result.rework;
      return {summary:String(result.summary||'').slice(0,500),...(rework?.id&&rework?.evidence&&rework?.reason?{rework:{
        id:String(rework.id).slice(0,80),evidence:String(rework.evidence).slice(0,600),reason:String(rework.reason).slice(0,1200)
      }}:{}),
        continuation:Array.isArray(continuation?.nodes)&&continuation.nodes.length?
          {reason:String(continuation.reason||'').slice(0,300),progressEvidence:String(continuation.progressEvidence||'').slice(0,600),nodes:continuation.nodes.slice(0,prompts.Dag.limits.continuationNodes+1)}:null};
    }
    if(req.kind==='observe')return {ops:Array.isArray(result.ops)?result.ops.slice(0,8):[]};
    if(req.kind==='brief'){
      const ids=Object.keys(req.definition.deps),briefs=result.briefs;
      if(!briefs||Object.keys(briefs).length!==ids.length||ids.some(id=>typeof briefs[id]!=='string'||!briefs[id].trim()))throw Error(uiText('新简述没有覆盖全部节点'));
      return Object.fromEntries(ids.map(id=>[id,briefs[id].trim().slice(0,1600)]));
    }
    throw Error(uiText('未知规划请求'));
  }finally{
    jobs.delete(req.key);
    for(const a of [...approvals.values()])if(a.key===req.key)a.resolve('deny');
    if(job.inputDir)fs.promises.rm(job.inputDir,{recursive:true,force:true}).catch(()=>{});
    // Failed runs stay for inspection; the startup sweep removes them later.
    if(cwd&&keep!=='all')files.discard(cwd,keep==='out').catch(()=>{});
  }
}
// What the planner sees of a workflow's project when expanding it: up to 300 file paths.
async function projectFiles(sessionId){
  const root=sessionId&&findProject(sessionId);if(!root)return undefined;
  const list=[...(await project.snapshot(root,300)).keys()];return list.length?list:undefined;
}
function windowBackground(){return nativeTheme.shouldUseDarkColors?'#19181e':'#ffffff'}
function openWindow(){
  win=new BrowserWindow({title:'Bercy',width:1390,height:870,minWidth:780,minHeight:550,backgroundColor:windowBackground(),webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))shell.openExternal(url).catch(()=>{});return {action:'deny'}});
  win.webContents.on('will-navigate',(e,url)=>{if(url!==entryURL)e.preventDefault()});
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.on('close',e=>{
    if(!jobs.size)return;
    const choice=dialog.showMessageBoxSync(win,{type:'warning',buttons:[uiText('继续执行'),uiText('停止并关闭')],defaultId:0,cancelId:0,message:uiText('还有 ')+jobs.size+uiText(' 项执行没有完成'),detail:uiText('关闭后这些执行会停止，已交付的内容会保留。')});
    if(choice===0)e.preventDefault();
  });
  // A crashed renderer is reloaded; the page picks up runs still going in this process. At most 3 reloads a minute.
  let crashes=[];
  win.webContents.on('render-process-gone',(_e,d)=>{
    if(d.reason==='clean-exit'||!win)return;crashes=crashes.filter(t=>Date.now()-t<60000);
    if(crashes.length<3){crashes.push(Date.now());win.reload()}
  });
  win.on('closed',()=>{for(const j of jobs.values())j.controller.abort();win=null});win.loadFile(entry);
}
app.whenReady().then(()=>{
  nativeTheme.themeSource='system';
  nativeTheme.on('updated',()=>win?.setBackgroundColor(windowBackground()));
  if(process.platform==='darwin'){
    const token=systemPreferences.subscribeLocalNotification('NSCurrentLocaleDidChangeNotification',()=>{
      win?.webContents.send('relay:system-languages-changed');
    });
    app.once('will-quit',()=>systemPreferences.unsubscribeLocalNotification(token));
  }
  protocol.handle('relay-asset',req=>{
    const url=new URL(req.url),id=url.pathname.slice(1);
    if(url.hostname==='file')return files.response(id,req.headers.get('range'));
    if(url.hostname==='project'&&/^[a-f0-9-]{36}$/i.test(id)&&url.searchParams.has('path')){
      try{return files.projectImage(resolveProjectFile(projectFileRoot(id),url.searchParams.get('path')))}
      catch{return new Response(null,{status:404})}
    }
    return new Response(null,{status:404});
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'windowMenu'}]));
  openWindow();
  files.sweep().catch(()=>{});
});
app.on('will-quit',()=>{runtime.disposeAll();store.close()});
app.on('second-instance',()=>{win?.show();win?.focus()});app.on('window-all-closed',()=>app.quit());
}
