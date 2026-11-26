const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const Dag=require('../../dist/dag.js'),{Files}=require('../files.cjs'),prompts=require('../prompts.cjs');
const nodes=[['brief',[]],['write',['brief']],['design',['brief']],['publish',['write','design']]].map(([id,deps])=>({id,name:id,description:'旧任务-'+id,artifact:id+'.md',deps}));
function run(){const d=Dag.definition(nodes);return {...d,pack:d.roles,files:{},dispatch:{},versions:[{deps:structuredClone(d.deps)}]}}
test('并行、汇合与循环检查',()=>{const r=run();assert.deepEqual(Dag.levels(r.deps),[['brief'],['write','design'],['publish']]);assert.throws(()=>Dag.levels({...r.deps,brief:['publish']}));assert.throws(()=>Dag.definition([{...nodes[0],id:'constructor'}]))});
test('保存结构移除默认与自定义简述，保留模型和拓扑',()=>{const r=Dag.definition(nodes);r.overrides.write={description:'覆盖内容',harness:'Codex',model:'test'};const s=Dag.stripBriefs(r);assert(!JSON.stringify(s).includes('旧任务'));assert(!JSON.stringify(s).includes('覆盖内容'));assert.equal(s.overrides.write.model,'test');assert.deepEqual(r.deps,s.deps);assert.equal(r.overrides.write.description,'覆盖内容')});
test('局部更新仅接入被影响的未执行后继，并保留计划快照',()=>{const r=run(),p={name:'复核',artifact:'补充说明',description:'核对数据',reason:'缺少依据',before:['publish']};const added=Dag.patch(r,'write',p);assert.deepEqual(r.deps.publish,['write','design',added]);assert.deepEqual(r.versions[0].deps.publish,['write','design']);r.dispatch.publish={};assert.equal(Dag.patch(r,'design',p),false)});
test('受阻节点可以等待新增前置，已完成的分支不会重新派发',()=>{const r=run();r.files.brief={};r.files.design={};const add=Dag.patch(r,'write',{name:'证据查找',description:'核对材料',artifact:'补充.md',reason:'资料有缺口',before:['write']},true);assert.deepEqual(r.deps[add],['brief']);assert.deepEqual(r.deps.write,['brief',add]);assert.deepEqual(r.files.design,{});assert(!Dag.complete(r))});
test('执行提示词只暴露必要素材和委托，省去拓扑与机器输出协议',()=>{const result=prompts.worker({query:'不应出现在正文的完整历史',node:{description:'写三句活动通知',artifact:'通知.md'},inputs:[{from:'保密角色',summary:'19:30 开始',files:[{path:'/inputs/brief.md'}]}],children:[{id:'保密后续'}],outDir:'/out'});assert.match(result,/19:30/);assert.match(result,/写三句活动通知/);assert.doesNotMatch(result,/保密|完整历史|JSON|工作流|节点|下游/)});
test('原件登记、下游只读来源的独立副本、Markdown 资源和视频范围请求',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-test-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const files=new Files(base),cwd=await files.attempt(),out=path.join(cwd,'out');
 await fs.writeFile(path.join(out,'海报.png'),Buffer.from([137,80,78,71]));
 await fs.writeFile(path.join(out,'说明.md'),'# 交付\n![图](海报.png)\n<script>bad()</script>');
 await fs.writeFile(path.join(out,'剪辑.mp4'),Buffer.from('abcdefgh'));
 const items=await files.output(cwd),md=items.find(a=>a.type==='text/markdown'),video=items.find(a=>a.type==='video/mp4');
 const html=(await files.preview(md.id)).html;assert.match(html,/<h1>交付/);assert.match(html,/relay-asset:\/\/file/);assert(!html.includes('<script>'));
 const response=await files.response(video.id,'bytes=2-4');assert.equal(response.status,206);assert.equal(await response.text(),'cde');
 const dest=await files.attempt(),groups=await files.inputs(dest,[{from:'文案',summary:'已交付',ids:[md.id]}]);assert.deepEqual(groups[0].files.map(f=>f.name),['说明.md']);await fs.writeFile(groups[0].files[0].path,'changed');assert.match(await fs.readFile(md.path,'utf8'),/^# 交付/);
 await fs.symlink(md.path,path.join(out,'跳转.md'));await assert.rejects(files.output(cwd),/符号链接/);
});
test('默认是文字委托，汇合处原样收到两个来源的完整正文',()=>{
 const paragraphs=['第一段观察。'.repeat(160),'第二份评语。'];const node={description:'综合两份材料写结论。',artifact:'评语'};
 const prompt=prompts.worker({node,inputs:paragraphs.map(text=>({text,files:[]})),outDir:'/unused'});
 assert.equal(Dag.delivery(node),'text');assert.match(prompt,/直接回复/);assert.match(prompt,/!\[说明\]\(文件名\)/);for(const p of paragraphs)assert(prompt.includes(p));
 assert.equal(Dag.delivery({artifact:'宣传片.mp4'}),'file');assert.equal(Dag.delivery({artifact:'说明',delivery:'mixed'}),'mixed');
});
test('图片原件登记并带入下轮，短 Markdown 输入可直接阅读',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-image-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const files=new Files(base);
 const pic=await files.importImage('参考.png',Buffer.from([137,80,78,71]));const cwd=await files.attempt();await fs.writeFile(path.join(cwd,'out','说明.md'),'输入正文');
 const records=await files.output(cwd,'说明.md');const folder=await files.attempt();const [inputs]=await files.inputs(folder,[{ids:[pic.id,records[0].id],text:'原样文字'}]);
 assert.equal(inputs.text,'原样文字');assert.equal(inputs.files[0].type,'image/png');assert.equal(inputs.files[1].inline,'输入正文');
});
