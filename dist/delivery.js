'use strict';
const Delivery = (() => {
  // Keep the desktop opener and the actions shown for older saved artifacts in sync.
  const openable = new Set('pdf doc docx ppt pptx xls xlsx csv txt md json png jpg jpeg gif webp mp4 mov m4v webm mp3 wav m4a'.split(' '));
  function canOpen(name) {
    const extension = /\.([a-z0-9]+)$/i.exec(name || '');
    return !!extension && openable.has(extension[1].toLowerCase());
  }

  function simpleText(query) {
    const text = query.trim();
    if (!text || text.length > 600 || /(?:复核|审查|分工|独立核|联网|搜索|附件|文件|脚本|统计|验收表|同时|分别|核实|查证|\b(?:review|research|verify|file|attach|also)\b)/i.test(text)) return false;
    return /^(?:(?:请|帮我)\s*)?(?:翻译|改写|润色|精简|排版|把[^。！？\n]{1,100}(?:翻译成|改写成|写成一句|整理成一句)|(?:translate|rewrite|rephrase|reformat|proofread)\b)/i.test(text);
  }

  // All sinks have finished, but a reported gap in a final deliverable still needs attention.
  function pendingLabel(flow, id) {
    if (flow.files[id]?.needsInput) return '待补件';
    if (!flow.files[id]?.gaps || flow.files[id].skipped) return '';
    return (flow.overrides?.[id]?.review ?? flow.pack?.[id]?.review) ? '复核待确认' : '交付有缺口';
  }
  function finalLabel(flow) {
    if (Object.keys(flow.errors || {}).length) return '需要处理';
    const parents = new Set(Object.values(flow.deps).flat());
    let label = '已交付';
    for (const id of Object.keys(flow.deps)) {
      const pending = pendingLabel(flow, id);
      if (pending === '待补件') return pending;
      if (pending === '复核待确认') label = pending;
      if (pending && label === '已交付' && !parents.has(id)) label = pending;
    }
    return label;
  }

  function awaitingInput(flow) {
    return Object.keys(flow.files).find(id => flow.files[id]?.needsInput);
  }
  return {canOpen, simpleText, pendingLabel, finalLabel, awaitingInput};
})();
if (typeof module !== 'undefined') module.exports = Delivery;
