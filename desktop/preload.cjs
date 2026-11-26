const {contextBridge,ipcRenderer}=require('electron');
const call=(k,...args)=>ipcRenderer.invoke('relay:'+k,...args);
contextBridge.exposeInMainWorld('relayHost',{
  read:()=>ipcRenderer.sendSync('relay:state'),save:patch=>ipcRenderer.sendSync('relay:state',patch),store:patch=>call('store',patch),
  systemLanguages:()=>ipcRenderer.sendSync('relay:system-languages'),
  onSystemLanguagesChanged:fn=>ipcRenderer.on('relay:system-languages-changed',()=>fn()),
  language:value=>call('language',value),scan:()=>call('scan'),choose:name=>call('choose',name),attach:()=>call('attach'),image:(name,bytes)=>call('image',name,bytes),execute:req=>call('execute',req),
  preview:id=>call('preview',id),forget:ids=>call('forget',ids),open:id=>call('open',id),reveal:id=>call('reveal',id),cancel:id=>call('cancel',id),cancelWorkflow:id=>call('cancel-workflow',id),
  steer:(key,text)=>call('steer',key,text),approve:(id,decision)=>call('approve',id,decision),approvalMode:mode=>call('approval-mode',mode),
  customRuntimes:list=>call('custom-runtimes',list),pickProjectDirectory:()=>call('pick-project-directory'),pickBinary:()=>call('pick-binary'),history:id=>call('events',id),planningGuide:text=>call('planning-guide',text),projectInfo:id=>call('project-info',id),openProject:id=>call('project-open',id),openProjectFile:(id,rel)=>call('project-file',id,rel),revealGuide:()=>call('reveal-guide'),
  exportFlow:(name,text)=>call('export-flow',name,text),importFlow:()=>call('import-flow'),
  jobs:()=>call('jobs'),awaitJob:key=>call('await-job',key),check:(key,command)=>call('check',key,command),
  events:fn=>ipcRenderer.on('relay:event',(_e,data)=>fn(data))
});
