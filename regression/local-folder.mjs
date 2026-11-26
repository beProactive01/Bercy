import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {connect} from './desktop.mjs';

const require = createRequire(import.meta.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bercy-folder-'));
const folder = await fs.realpath(await fs.mkdir(path.join(temp, '示例 repo'), {recursive:true}));
const profile = path.join(temp, 'profile');
await fs.writeFile(path.join(folder,'message.txt'), 'draft\n');
await fs.writeFile(path.join(folder,'check.cjs'),"require('node:assert/strict').equal(require('node:fs').readFileSync('message.txt','utf8'),'ready\\n');\n");
await fs.writeFile(path.join(folder,'AGENTS.md'), '# Existing project instructions\n');
const entry = path.join(temp,'start.cjs');
// Supply the native picker's result without driving Finder on the user's desktop.
await fs.writeFile(entry, `const {dialog}=require('electron');
dialog.showOpenDialog=async (_win,options)=>{
  if(!options.properties.includes('openDirectory'))throw Error('Expected a folder picker');
  return {canceled:false,filePaths:[${JSON.stringify(folder)}]};
};
require(${JSON.stringify(require.resolve('../desktop/main.cjs'))});`);
const child = spawn(require('electron'),[entry,'--remote-debugging-port=0'],{
  env:{...process.env,BERCY_PROFILE:profile},stdio:'ignore'
});
let client;
try {
  client = await connect(profile,child);
  const ev = client.evaluate;
  for(let i=0;i<150;i++){
    if(await ev("typeof scanned!=='undefined'&&scanned"))break;
    await delay(200);
  }
  assert.ok(await ev("typeof scanned!=='undefined'&&scanned"),'Runtime scan did not finish');
  await ev(`(async()=>{
    for(const [name,c] of Object.entries(db.connections))c.enabled=c.online=name==='Codex'&&runtimeInfo(name).installed;
    if(!db.connections.Codex.online)throw Error('Codex unavailable');
    db.settings.planner='Codex';db.settings.autoStart=true;db.settings.live='off';
    await host.approvalMode('allow');
    $('projectNew').click();await $('pickFolder').onclick();$('projectForm').requestSubmit();
    return saveNow();
  })()`);
  const project = await ev('db.projects.at(-1)');
  assert.equal(project.name,'示例 repo');
  assert.equal(project.directory,folder);
  await ev(`(async()=>{
    document.querySelector('[data-new-in]').click();
    if($('project').value!==${JSON.stringify(project.id)})throw Error('Project not selected');
    $('input').value='在现有项目中，将 message.txt 的内容从 draft 改为 ready（保留末尾换行）。运行项目已有的 node check.cjs 进行验收，然后报告结果。';
    await $('newForm').onsubmit({preventDefault(){},target:$('newForm')});return true;
  })()`);
  const id=await ev('session().id');
  for(let i=0;i<300;i++){
    const state=await ev('({done:Dag.complete(run),errors:run.errors,active:timers.has(session().id)})');
    if(state.done)break;
    assert.ok(state.active,JSON.stringify(state));
    await delay(500);
  }
  assert.equal(await ev('Dag.complete(run)'),true);
  assert.equal(await fs.readFile(path.join(folder,'message.txt'),'utf8'),'ready\n');
  assert.equal((await ev(`host.projectInfo(${JSON.stringify(id)})`)).root,folder);
  assert.equal(await fs.readFile(path.join(folder,'AGENTS.md'),'utf8'),'# Existing project instructions\n');
  assert.deepEqual((await fs.readdir(folder)).sort(),['AGENTS.md','check.cjs','message.txt']);
  const attachment = await ev(`host.execute({
    key:${JSON.stringify(id+'/export')},kind:'node',directory:${JSON.stringify(folder)},runtime:'Codex',
    query:'读取 message.txt，将内容写到交付目录中的 receipt.txt。',groups:[],needs:['shell'],
    node:{id:'export',name:'导出',delivery:'file',artifact:'receipt.txt',description:'读取当前项目中的 message.txt，把相同内容写到指定交付目录下的 receipt.txt。'}
  })`);
  assert.equal(await fs.readFile(attachment.artifacts[0].path,'utf8'),'ready\n');
  await ev('saveNow();setTimeout(()=>location.reload(),0);true');
  for(let i=0;i<150;i++){
    await delay(200);
    if(await ev("typeof scanned!=='undefined'&&scanned&&!!db.projects.length"))break;
  }
  assert.equal(await ev('db.projects.at(-1).directory'),folder);
  await ev(`projectDialog(${JSON.stringify(project.id)});$('clearFolder').click();$('projectForm').requestSubmit();saveNow()`);
  assert.equal(await ev('db.projects.at(-1).directory'),'');
  assert.equal((await ev(`host.projectInfo(${JSON.stringify(id)})`)).root,folder);
  await fs.rename(folder,folder+'-moved');
  await assert.rejects(ev(`host.projectInfo(${JSON.stringify(id)})`),/项目目录不可用|Project folder unavailable/);
  console.log('PASS · 选择目录、默认项目名、项目内新任务、Codex 在原目录改文件、验收、保留仓库约定、附件交付、重新加载、解绑后历史记录、目录移走时提示');
} finally {
  client?.close();
  if(child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await stopped}
  await fs.rm(temp,{recursive:true,force:true});
}
