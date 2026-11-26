const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../../dist/i18n.js');
const prompts = require('../prompts.cjs');

test('interface language switches in both directions and falls back to Simplified Chinese', t => {
  t.after(() => i18n.setLanguage('zh-CN'));
  const label = '<button title="新建任务">新建任务</button>';
  assert.equal(i18n.setLanguage('en'), 'en');
  assert.equal(i18n.text(label), '<button title="New task">New task</button>');
  assert.equal(i18n.setLanguage('zh-CN'), 'zh-CN');
  assert.equal(i18n.text(label), label);
  assert.equal(i18n.setLanguage(undefined), 'zh-CN');
  assert.equal(i18n.setLanguage('unsupported'), 'zh-CN');
});

test('English worker instructions preserve the exact task, input materials and output name', t => {
  t.after(() => i18n.setLanguage('zh-CN'));
  i18n.setLanguage('en');
  const request = {
    node: {description:'请用中文写一段设置说明', artifact:'交付产物', delivery:'text', review:true, canReturn:true},
    inputs:[{text:'原始资料：设置', files:[{name:'参考图.png', visual:true}]}],
    outDir:'/out'
  };
  const prompt = prompts.worker(request);
  assert.match(prompt, /^Task\n请用中文写一段设置说明/);
  assert.match(prompt, /原始资料：设置/);
  assert.match(prompt, /Attached image: 参考图.png/);
  assert.match(prompt, /Return “交付产物” in full/);
  assert.match(prompt, /“Return:”/);
  assert.deepEqual(prompts.receipt('中文正文\nGap: Missing source'), {body:'中文正文', gaps:'Missing source'});
  i18n.setLanguage('zh-CN');
  assert.match(prompts.worker(request), /^任务\n请用中文写一段设置说明/);
});

test('system language respects OS preference order and supports explicit overrides', () => {
  const resolve = locales => i18n.resolveLanguage('system', locales);
  assert.equal(resolve(['fr-FR','zh-Hant-HK','en-US']), 'zh-CN');
  assert.equal(resolve(['en-GB','zh-Hans-CN']), 'en');
  assert.equal(resolve(['de-DE']), 'en');
  assert.equal(resolve([]), 'en');
  assert.equal(i18n.resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(i18n.resolveLanguage('en', ['zh-CN']), 'en');
});

test('legacy default moves to system and explicit language preferences survive reload', () => {
  assert.equal(i18n.languagePreference(), 'system');
  assert.equal(i18n.languagePreference({language:'zh-CN'}), 'system');
  assert.equal(i18n.languagePreference({language:'en'}), 'en');
  for (const value of ['en', 'zh-CN', 'system'])
    assert.equal(i18n.languagePreference({language:'en',languagePreference:value}), value);
});
