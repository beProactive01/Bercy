// Local calendar arithmetic keeps a recurring plan at the chosen wall-clock time across DST.
function localMinute(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function dueOccurrence(plan, now) {
  if (!plan.next || plan.next > now) return null;
  if (plan.repeat === 'once') return {at: plan.next, next: null};
  if (plan.repeat === 'hourly') {
    const interval = plan.hours * 3600000;
    const at = plan.next + Math.floor((now - plan.next) / interval) * interval;
    return {at, next:at + interval};
  }
  const days = plan.repeat === 'weekly' ? 7 : 1;
  const anchor = new Date(plan.first);
  const date = new Date(now);
  const offset = days === 7 ? (date.getDay() - anchor.getDay() + 7) % 7 : 0;
  date.setDate(date.getDate() - offset);
  const [hour, minute] = plan.first.slice(11).split(':').map(Number);
  date.setHours(hour, minute, 0, 0);
  if (+date > now) {
    date.setDate(date.getDate() - days);
    date.setHours(hour, minute, 0, 0);
  }
  const at = Math.max(plan.next, +date);
  date.setTime(at);
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return {at, next: +date};
}

const scheduleFrequency = {once:'单次', hourly:'按小时', daily:'每天', weekly:'每周'};
function scheduleTime(value) {
  return new Date(value).toLocaleString(BercyI18n.language, {dateStyle:'medium', timeStyle:'short'});
}

function scheduleDialog(item) {
  const plan = item.schedule;
  const current = item.flow;
  const options = item.versions?.map((_, i) => '<option value="'+(i+1)+'">v'+(i+1)+'</option>').reverse();
  const versionField = current ? '' :
    '<label class="field" for="scheduleVersion">'+uiText('流程版本')+'</label>'+
    '<select class="select" id="scheduleVersion">'+options.join('')+'</select>';
  const briefField = current ?
    '<p class="muted">'+uiText('保存时会采用当前节点、任务描述和输入附件。')+'</p>' :
    '<label class="field" for="scheduleBrief">'+uiText('任务描述')+'</label>'+
    '<textarea id="scheduleBrief" required maxlength="4000">'+esc(plan?.query ?? item.sample ?? '')+'</textarea>';
  const lastRun = plan?.last && db.sessions.some(s=>s.id===plan.last);
  dialog(uiText('定时执行'), item.name || current.query,
    '<form id="scheduleForm">'+versionField+briefField+
    '<label class="field" for="scheduleRepeat">'+uiText('执行频率')+'</label>'+
    '<select id="scheduleRepeat" class="select">'+Object.entries(scheduleFrequency).map(([key,label]) =>
      '<option value="'+key+'">'+uiText(label)+'</option>').join('')+'</select>'+
    '<div id="hoursField"><label class="field" for="scheduleHours">'+uiText('间隔小时数')+'</label>'+
    '<input class="fieldinput" id="scheduleHours" type="number" required min="1" step="1"></div>'+
    '<label class="field" for="scheduleFirst">'+uiText('下次执行（本机时间）')+'</label>'+
    '<input class="fieldinput" id="scheduleFirst" type="datetime-local" required>'+
    (plan && !plan.next ? '<p class="muted">'+uiText('上次单次计划已触发。')+'</p>' : '')+
    '<p class="muted schedule-hint">'+uiText('请保持百溪打开。休眠或退出后，恢复时补跑最近一次。')+'</p>'+
    (lastRun?'<button type="button" class="back-flow" id="lastScheduledRun">'+uiText('查看最近运行')+'</button>':'')+
    '<div class="actions">'+(plan?'<button type="button" class="secondary danger" id="removeSchedule">'+uiText('取消定时')+'</button>':'')+
    '<button class="primary">'+uiText('保存定时')+'</button></div></form>');
  const form = $('scheduleForm');
  if (!current) $('scheduleVersion').value = plan?.version || item.versions.length;
  if (lastRun) $('lastScheduledRun').onclick = () => { dismiss(); activate(plan.last); };
  $('scheduleRepeat').value = plan?.repeat || 'hourly';
  $('scheduleHours').value = plan?.hours || 1;
  const toggleHours = () => {
    const hourly = $('scheduleRepeat').value === 'hourly';
    $('hoursField').hidden = !hourly;
    $('scheduleHours').disabled = !hourly;
  };
  $('scheduleRepeat').onchange = toggleHours;
  toggleHours();
  $('scheduleFirst').value = localMinute(plan?.next > Date.now() ? plan.next : Date.now()+3600000);
  if (plan) confirmClick($('removeSchedule'), uiText('确认取消定时'), () => {
    if (storeSchedule(item, null)) dismiss();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    const query = current ? current.query : $('scheduleBrief').value.trim();
    if (!current && !query) return $('scheduleBrief').focus();
    const first = $('scheduleFirst').value, next = +new Date(first);
    const version = current ? current.versions.length : Number($('scheduleVersion').value);
    const repeat = $('scheduleRepeat').value, hours = Number($('scheduleHours').value);
    const end = setBusy(form, uiText('准备节点…'));
    try {
      const checkTime = () => {
        if (!Number.isFinite(next) || next <= Date.now() || localMinute(next) !== first)
          throw Error(uiText('请选择有效的未来时间'));
      };
      checkTime();
      if (repeat === 'hourly' && (!Number.isSafeInteger(hours) || hours < 1 || !Number.isFinite(+new Date(next + hours * 3600000))))
        throw Error(uiText('请输入有效的正整数小时数'));
      const saved = current ? definitionOf(current, current.deps) : item.versions[version-1];
      // Prepare structure-only templates once, using the same brief and planner as manual reuse.
      let prepared;
      if (current) prepared = {...saved, scopedBriefs:!!current.scopedBriefs};
      else if (saved.mode === 'structure') {
        const sameBrief = plan?.version === version && plan.query === query;
        prepared = (sameBrief && plan.prepared) || await instantiate(query, saved, [], form);
      }
      if (!form.isConnected || !$('modal').open) return;
      checkTime();
      const updated = {version, query, first, next, repeat, last:item.schedule?.last};
      if (repeat === 'hourly') updated.hours = hours;
      if (current) {
        updated.attachments = structuredClone(item.attachments || []);
        updated.extraInputs = structuredClone(current.extraInputs || {});
      }
      if (prepared) updated.prepared = prepared;
      if (storeSchedule(item, updated)) dismiss();
      else end(uiText('定时设置未保存，请重试'));
    } catch (error) { end(error); }
  };
}

// The schedule cursor and its new run go to SQLite together, before any runtime receives work.
function persistSchedules() {
  save();
  return saveNow();
}

function storeSchedule(item, plan) {
  const previous = item.schedule;
  if (plan) item.schedule = plan;
  else delete item.schedule;
  if (persistSchedules()) return true;
  item.schedule = previous;
  save();
  notify(uiText('定时设置未保存，请重试'));
  return false;
}

function scheduleCard(item) {
  if (!host) return '';
  const plan = item.schedule;
  const frequency = plan?.repeat === 'hourly' ? (plan.hours === 1 ? uiText('每小时') : uiText('每 {n} 小时').replace('{n}', plan.hours)) :
    plan && uiText(scheduleFrequency[plan.repeat]);
  const info = plan ? 'v'+plan.version+' · '+frequency+' · '+
    (plan.next ? uiText('下次执行')+' '+scheduleTime(plan.next) : uiText('已触发')) : '';
  return '<div class="schedule-row"><button class="secondary" data-schedule="'+esc(item.id)+'">'+
    uiText(plan?'编辑定时':'定时执行')+'</button>'+(info?'<small>'+esc(info)+'</small>':'')+
    (plan?.last && db.sessions.some(s=>s.id===plan.last) ? '<button class="back-flow" data-scheduled-run="'+
      esc(plan.last)+'">'+uiText('查看最近运行')+'</button>':'')+'</div>';
}

function checkSchedules(now = Date.now()) {
  let changed = false;
  for (const item of [...db.library, ...db.sessions]) {
    const plan = item.schedule;
    if (!plan) continue;
    const due = dueOccurrence(plan, now);
    if (!due) continue;
    const s = fresh(plan.query, item.project || null, plan.prepared || item.versions[plan.version-1]);
    if (item.flow) {
      if (item.source) s.source = {...item.source};
      s.attachments = structuredClone(plan.attachments || []);
      s.flow.extraInputs = structuredClone(plan.extraInputs || {});
    } else s.source = {id:item.id, version:plan.version};
    s.name = (item.name || plan.query)+' · '+scheduleTime(due.at);
    s.scheduledPending = true;
    s.flow.logs.unshift([0, uiText('定时触发'), scheduleTime(due.at)]);
    db.sessions.unshift(s);
    const previousNext = plan.next, previousLast = plan.last;
    plan.next = due.next;
    plan.last = s.id;
    if (!persistSchedules()) {
      db.sessions.shift();
      plan.next = previousNext;
      plan.last = previousLast;
      save();
      notify(uiText('工作区存储不可用，定时执行稍后重试'));
      return;
    }
    changed = true;
  }
  for (const s of db.sessions) {
    if (!s.scheduledPending || !scanned || timers.has(s.id) || !canProceed(s.flow)) continue;
    start(s);
    changed = true;
  }
  if (changed) render();
}
