const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require.resolve('../../dist/schedules.js'), 'utf8');
const date = value => new Date(value).getTime();
function scheduler(context = {}) {
  return vm.runInNewContext(script + '\n;({dueOccurrence, checkSchedules})', context);
}

test('a one-time schedule triggers only at or after the deadline', () => {
  const {dueOccurrence} = scheduler();
  const next = date('2026-11-25T12:15');
  const plan = {next, repeat:'once'};
  assert.equal(dueOccurrence(plan, next - 1), null);
  const due = dueOccurrence(plan, next);
  assert.equal(due.at, next);
  assert.equal(dueOccurrence({...plan, next:due.next}, next + 10000), null);
});

test('daily and weekly schedules catch up only the most recent local occurrence', () => {
  const {dueOccurrence} = scheduler();
  const first = '2026-11-25T12:15';
  for (const [repeat, now, at, next] of [
    ['daily','2026-12-10T12:14','2026-12-09T12:15','2026-12-10T12:15'],
    ['weekly','2027-01-06T12:15','2027-01-06T12:15','2027-01-13T12:15'],
    ['weekly','2027-01-06T12:14','2026-12-30T12:15','2027-01-06T12:15'],
  ]) {
    const due = dueOccurrence({repeat, first, next:date(first)}, date(now));
    assert.equal(due.at, date(at));
    assert.equal(due.next, date(next));
  }
});

test('clock shifts do not move the following day away from the requested local time', t => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const {dueOccurrence} = scheduler();
  const first = '2026-03-07T02:30';
  const due = dueOccurrence({first, repeat:'daily', next:date(first)}, date('2026-03-08T05:00'));
  assert.equal(due.at, date('2026-03-08T03:30'));
  assert.equal(due.next, date('2026-03-09T02:30'));
});

test('storage failure rolls back the cursor and retries once, preserving the selected session and template version', () => {
  const due = date('2026-11-25T12:15');
  const item = {id:'template', name:'Test', versions:['pinned','new'], schedule:{repeat:'once', next:due, version:1, query:'brief'}};
  const db = {selected:'manual', library:[item], sessions:[]};
  let writable = false;
  const context = {db, BercyI18n:{language:'en'}, scanned:false, timers:new Map(), fresh:(query, project, definition) =>
    ({id:'scheduled', definition, flow:{query,logs:[]}}), uiText:s=>s, save(){}, saveNow:()=>writable, notify(){}, render(){}};
  const {checkSchedules} = scheduler(context);
  checkSchedules(due);
  assert.equal(item.schedule.next, due);
  assert.equal(db.sessions.length, 0);
  writable = true;
  checkSchedules(due);
  checkSchedules(due + 1000);
  assert.equal(item.schedule.next, null);
  assert.equal(db.sessions.length, 1);
  assert.equal(db.sessions[0].scheduledPending, true);
  assert.equal(db.sessions[0].definition, 'pinned');
  assert.equal(db.selected, 'manual');
  assert.equal(item.schedule.last, db.sessions[0].id);
});

test('hourly catch-up keeps the first run’s minute and the whole-hour interval', () => {
  const {dueOccurrence} = scheduler();
  const first = '2026-11-25T09:17';
  for (const hours of [1, 2, 6, 25]) {
    const interval = hours * 3600000;
    const next = date(first);
    const now = next + 17 * interval + 21 * 60000;
    const due = dueOccurrence({first, repeat:'hourly', hours, next}, now);
    assert.equal(due.at, next + 17 * interval);
    assert.equal(due.next, next + 18 * interval);
  }
});

test('an unsaved workflow schedules an independent run with its captured nodes and both input types', () => {
  const next = date('2026-11-25T09:17');
  const plan = {next, repeat:'hourly', hours:2, query:'Original', prepared:{name:'Captured graph'},
    attachments:[{id:'attached'}], extraInputs:{root:[{id:'node-input'}]}};
  const origin = {id:'original', project:'project', flow:{}, schedule:plan};
  const db = {selected:'original', library:[], sessions:[origin]};
  const {checkSchedules} = scheduler({db, structuredClone, BercyI18n:{language:'en'}, scanned:false,
    fresh:(query,project,definition)=>({id:'child',project,definition,flow:{query,logs:[]}}),
    uiText:s=>s, save(){}, saveNow:()=>true, notify(){}, render(){}});
  checkSchedules(next);
  const child = db.sessions[0];
  assert.equal(child.project, 'project');
  assert.deepEqual(child.definition, plan.prepared);
  assert.deepEqual(child.attachments, plan.attachments);
  assert.deepEqual(child.flow.extraInputs, plan.extraInputs);
  assert.notEqual(child.flow.extraInputs, plan.extraInputs);
  assert.equal(child.schedule, undefined);
  checkSchedules(next+10000);
  assert.equal(db.sessions.length, 2);
  assert.equal(origin.schedule.next, next+2*3600000);
  assert.equal(db.library.length, 0);
});
