const {text:uiText} = require('../dist/i18n.js');

// Manual flows and old templates can have an explicit limit in prose only. Infer it
// for a single short copy deliverable, never for one section of a larger report.
function copyLimit(node) {
  const brief = node?.description || '';
  if (!/通知|文案|标语|短句|标题|译文|答复|翻译|notice|headline|caption|translation/i.test(node?.artifact || '')) return;
  if (/分别|每(?:条|段|句)|各(?:不超过|限)|以及|验收表|报告|each|per (?:line|item)/i.test(brief)) return;
  const match = /(?:不超过|不多于|最多|限|上限为?)\s*(\d+)\s*(?:个\s*)?(?:汉字|字符|字)|(?:at most|up to|no more than)\s+(\d+)\s+characters/i.exec(brief);
  return match && Number(match[1] || match[2]);
}

function checksFor(node, reviewed) {
  const sources = [node];
  // An independent audit report has a different format from the work it audits.
  if (reviewed && !/报告|评语|意见|结论|差异|清单|核算结果|report|feedback|verdict|findings|checklist/i.test(node.artifact)) sources.push(reviewed);
  const limits = sources.map(s => s.checks?.maxChars || copyLimit(s)).filter(n => Number.isSafeInteger(n) && n > 0);
  return {
    maxChars: limits.length ? Math.min(...limits) : null,
    json: sources.some(s => s.checks?.json),
    requiredKeys: [...new Set(sources.flatMap(s => s.checks?.requiredKeys || []))]
  };
}

// A standalone artifact label is UI metadata when a reviewer delivers copy ready to send.
function copyBody(body, node) {
  if (!node.review || !/直接(?:复制|发送)|只(?:交付|返回|回复)正文|ready to send|copy.ready/i.test(node.description || '')) return body;
  const newline = body.indexOf('\n');
  if (newline < 0) return body;
  const label = body.slice(0, newline).trim().replace(/[:：]$/, '');
  return label === node.artifact ? body.slice(newline).trimStart() : body;
}

function violation(body, rules) {
  const count = Array.from(body).length;
  if (rules.maxChars && count > rules.maxChars) return uiText('正文字符数超过上限') + ' (' + count + ' / ' + rules.maxChars + ')';
  if (rules.json || rules.requiredKeys.length) {
    let value;
    try { value = JSON.parse(body); } catch { return uiText('正文须为有效 JSON'); }
    const missing = rules.requiredKeys.filter(k => !value || typeof value !== 'object' || !Object.hasOwn(value, k));
    if (missing.length) return uiText('缺少必填字段') + ' · ' + missing.join(', ');
  }
  return '';
}
module.exports = {checksFor, copyBody, violation};
