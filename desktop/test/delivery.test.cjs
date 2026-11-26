const test=require('node:test'), assert=require('node:assert/strict');
const Delivery=require('../../dist/delivery.js'), Dag=require('../../dist/dag.js');
const {checksFor,violation}=require('../text-checks.cjs');

test('quick routing only applies to short self-contained writing',()=>{
  for(const q of ['把这次发版写成一句内测通知。','请翻译这一句：Good morning.','Rewrite this in plain English.'])assert.equal(Delivery.simpleText(q),true);
  for(const q of ['翻译附件并独立复核','核对下面的台账','Rewrite the attached file','翻译'+'字'.repeat(601)])assert.equal(Delivery.simpleText(q),false);
});

test('the action for a file follows its final extension, including legacy filenames',()=>{
  for(const name of ['report.PDF','导出.csv'])assert.equal(Delivery.canOpen(name),true);
  for(const name of ['index.html','calendar.ics','data.pdf.command','README'])assert.equal(Delivery.canOpen(name),false);
});

test('workflow completion distinguishes final review gaps from resolved upstream gaps',()=>{
  const flow={deps:{draft:[],verify:['draft']},pack:{verify:{review:true}},files:{draft:{gaps:'待复核'},verify:{gaps:'需要原件'}}};
  assert.ok(Dag.complete(flow));assert.equal(Delivery.finalLabel(flow),'复核待确认');
  flow.deps.publish=['verify'];flow.files.publish={gaps:''};assert.equal(Delivery.finalLabel(flow),'复核待确认');
  delete flow.deps.publish;delete flow.files.publish;
  flow.files.verify.gaps='';assert.equal(Delivery.finalLabel(flow),'已交付');
  flow.files.verify.gaps='附件缺失';flow.overrides={verify:{review:false}};assert.equal(Delivery.finalLabel(flow),'交付有缺口');
});

test('a final copy review inherits its source requirements and counts Unicode code points',()=>{
  const source={artifact:'通知初稿',description:'写一条通知，最多 4 个字符。'};
  const rules=checksFor({artifact:'已审通知',review:true},source);
  assert.equal(violation('🐱🟢OK',rules),'');assert.match(violation('🐱🟢OK!',rules),/5 \/ 4/);
  assert.equal(checksFor({artifact:'审查报告',review:true},source).maxChars,null);
  assert.equal(checksFor({artifact:'通知及验收表',description:'分别写 80 字以内的通知，以及验收表。'}).maxChars,null);
});

test('JSON and field requirements persist in full templates and are dropped with stripped briefs',()=>{
  const checks={json:true,requiredKeys:['repo_id'],maxChars:100};
  const d=Dag.definition([{id:'data',name:'data',artifact:'JSON',delivery:'text',description:'return JSON',deps:[],checks}]);
  const saved=Dag.fromFile(Dag.toFile('export',d)).definition;
  assert.deepEqual(saved.roles.data.checks,checks);assert.equal(Dag.stripBriefs(saved).roles.data.checks,undefined);
  const rules=checksFor(saved.roles.data);
  assert.ok(violation('text',rules));assert.ok(violation('{}',rules));assert.equal(violation('{"repo_id":0}',rules),'');
});

test('a request for missing input stays readable and marks the workflow as needing input',()=>{
  const {receipt}=require('../prompts.cjs');
  const r=receipt('待补件：请提供访谈逐字稿。');
  assert.deepEqual(r,{body:'请提供访谈逐字稿。',gaps:'请提供访谈逐字稿。',needsInput:true});
  assert.equal(Delivery.finalLabel({files:{draft:r},deps:{draft:[]}}),'待补件');
  assert.ok(receipt('Needs input: Please upload the source.').needsInput);
});

test('ready-to-send final copy omits only the separate artifact label',()=>{
  const {copyBody}=require('../text-checks.cjs');
  const node={review:true,artifact:'内测通知定稿',description:'交付可直接复制发送的定稿'};
  assert.equal(copyBody('内测通知定稿：\n\n周五开始内测。',node),'周五开始内测。');
  assert.equal(copyBody('周五内测：\n如何报名',node),'周五内测：\n如何报名');
});
