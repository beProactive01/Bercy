import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {connect} from './desktop.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json')));
const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const c of cases) console.log(c.group, c.id, c.prompt);
  process.exit(0);
}
const filters = new Set(args);
for (const filter of filters) {
  if (!cases.some(c => c.id === filter || c.group === filter)) throw new Error('Unknown case or group: ' + filter);
}
const selected = cases.filter(c => !filters.size || filters.has(c.group) || filters.has(c.id));
if (selected.some(c => c.id === 'reuse') && !selected.some(c => c.id === 'timezone')) {
  selected.unshift(cases.find(c => c.id === 'timezone'));
}
const runRoot = path.join(repo, 'build', 'regression');
fs.mkdirSync(runRoot, {recursive:true});
const dir = fs.mkdtempSync(path.join(runRoot, new Date().toISOString().replace(/[:.]/g,'-') + '-'));
const profile = path.join(dir, 'profile');
const {Files} = require('../desktop/files.cjs');
const project = require('../desktop/project.cjs');
const inputs = new Files(profile);
const attachments = {};
for (const name of new Set(selected.flatMap(c => c.inputs || []))) {
  [attachments[name]] = await inputs.import([path.join(here, 'inputs', name)]);
}
const defaultPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const python = process.env.REGRESSION_PYTHON || (fs.existsSync(defaultPython) ? defaultPython : 'python3');
const grade = (...params) => spawnSync(python, ['-B', path.join(here,'grade.py'), dir, ...params], {stdio:'inherit'});
const preflight = grade('--check', ...selected.map(c => c.id));
if (preflight.status !== 0) throw new Error('Verifier unavailable: ' + (preflight.error?.message || 'see output above'));
console.log('Run directory:', dir);
const binary = process.env.BERCY_APP || require('electron');
const logfile = fs.openSync(path.join(dir,'desktop.log'),'w');
const child = spawn(binary, [...(process.env.BERCY_APP ? [] : [repo]), '--remote-debugging-port=0'], {
  cwd:repo, env:{...process.env, BERCY_PROFILE:profile}, stdio:['ignore',logfile,logfile]
});
fs.closeSync(logfile);
const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
process.once('exit',stop);
process.once('SIGINT',() => process.exit(130));
process.once('SIGTERM',() => process.exit(143));

let client;
const results = {};
const sessions = {};
const json = JSON.stringify;
async function runCase(c) {
  const startTime = Date.now();
  const deadline = startTime + (c.id === 'race' ? 180000 : 480000);
  console.log('START',c.id);
  const context = {id:c.id, actions:{}};
  results[c.id] = context;
  try {
    let templateId = null;
    if (c.id === 'reuse') {
      while (!results.timezone?.finished && Date.now() < deadline) await delay(300);
      templateId = sessions.timezone;
      if (!results.timezone?.state?.done || !templateId) throw new Error('Timezone template unavailable');
    }
    const data = {...c, attachments:(c.inputs || []).map(n => attachments[n]), templateId};
    const id = await client.evaluate(`(async data => {
      let d;
      if (data.nodes) {
        d = Dag.definition(data.nodes);
        d.scopedBriefs = true;
      } else {
        const old = db.sessions.find(s => s.id === data.templateId);
        const template = old ? Dag.stripBriefs(definitionOf(old.flow,old.flow.deps)) : null;
        d = await instantiate(data.prompt,template,data.attachments,null,null);
      }
      create(data.prompt,null,d,null,data.id,data.attachments,d.split);
      return session().id;
    })(${json(data)})`);
    sessions[c.id] = id;
    context.session = id;
    if (c.group === 'coding') {
      context.project = project.root(path.join(profile,'projects'),id,c.id);
      if (c.seed) fs.cpSync(path.join(here,'projects',c.seed),context.project,{recursive:true});
    }
    const sessionLookup = 'db.sessions.find(s=>s.id===' + json(id) + ')';
    await client.evaluate('start(' + sessionLookup + ');true');
    while (Date.now() < deadline) {
      const state = await client.evaluate(`(s=>{const f=s.flow;return {active:timers.has(s.id),done:Dag.complete(f),
        running:[...inflight.values()].filter(v=>v.s===s).map(v=>v.id),files:Object.keys(f.files),
        failed:Object.keys(f.errors||{}),waiting:Delivery.awaitingInput(f)}})(${sessionLookup})`);
      if (c.id === 'retry' && !context.actions.stopped && state.running.includes('interrupted')) {
        await client.evaluate("stopNode("+sessionLookup+",'interrupted');true");
        context.actions.stopped = true;
      } else if (c.id === 'retry' && !context.actions.retried && !state.active && state.failed.includes('interrupted') && state.files.includes('steady')) {
        context.actions.beforeRetry = state;
        await client.evaluate("activate("+json(id)+");play();true");
        context.actions.retried = true;
      } else if (c.id === 'missing' && state.waiting === 'source' && !state.active && !context.actions.supplied) {
        context.actions.beforeSupply = state;
        await client.evaluate("activate("+json(id)+");redoNode('source','协调人补充：提货码为 TK-80417。请据此交付。');true");
        context.actions.supplied = true;
      } else if (state.done || !state.active) break;
      await delay(350);
    }
    context.state = await client.evaluate(`(s=>{const f=s.flow;return {done:Dag.complete(f),active:timers.has(s.id),
      label:Delivery.finalLabel(f),files:f.files,deps:f.deps,events:f.events,steps:f.steps,dispatch:f.dispatch,
      threads:f.threads,sent:f.sentInputs,errors:f.errors,rounds:f.rounds,versions:f.versions}})(${sessionLookup})`);
    if (context.state.active) {
      context.error = 'Scenario timed out';
      await client.evaluate(`(s=>{stop(s.id);for(const v of inflight.values())if(v.s===s)stopNode(s,v.id)})(${sessionLookup});true`);
    }
  } catch (err) { context.error = err.message; }
  context.elapsedSeconds = Math.round((Date.now()-startTime)/1000);
  context.finished = true;
  fs.writeFileSync(path.join(dir,'executions.json'),json(results,null,2));
  console.log('END',c.id,context.error || context.state?.label,context.elapsedSeconds+'s');
}

try {
  client = await connect(profile,child);
  for (let i = 0; i < 300; i++) {
    if (await client.evaluate("typeof scanned !== 'undefined' && scanned && typeof db !== 'undefined' && !!db")) break;
    if (i === 299) throw new Error('Bercy runtime scan did not finish');
    await delay(200);
  }
  const config = await client.evaluate(`(async()=>{
    await initialScan;
    for(const [name,c] of Object.entries(db.connections))c.enabled=c.online=name==='Codex'&&runtimeInfo(name).installed;
    db.settings.planner='Codex';db.settings.autoStart=false;save();
    return {runtime:Object.keys(db.connections).filter(n=>db.connections[n].online),planner:db.settings.planner,parallel:slotLimit()};
  })()`);
  if (config.runtime.join() !== 'Codex') throw new Error('Install and sign in to Codex first');
  fs.writeFileSync(path.join(dir,'config.json'),json({...config,binary,selected:selected.map(c=>c.id)},null,2));
  const pending = [...selected.filter(c=>c.group==='coding'),...selected.filter(c=>c.group!=='coding' && c.id!=='race')];
  async function lane() { while (pending.length) await runCase(pending.shift()); }
  await Promise.all(Array.from({length:Math.min(4,pending.length)},lane));
  const race = selected.find(c=>c.id==='race');
  if (race) {
    // Eliminate observer edits so this case specifically exercises invalidation during rework.
    await client.evaluate("db.settings.live='off';true");
    await runCase(race);
  }
  const check = grade(...selected.map(c => c.id));
  process.exitCode = check.status ?? 2;
} finally { client?.close(); stop(); }
