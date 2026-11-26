import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Communicate only with the Electron instance started with this run's fresh profile.
export async function connect(profile, child) {
  let tab;
  for (let attempt = 0; attempt < 150 && !tab; attempt++) {
    if (child.exitCode !== null) throw new Error('Bercy exited during startup');
    try {
      const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      tab = pages.find(page => page.type === 'page' && page.url.startsWith('file:'));
    } catch { /* The app has not opened its window yet. */ }
    if (!tab) await delay(200);
  }
  if (!tab) throw new Error('Bercy did not open a renderer');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map();
  let next = 0;
  ws.onmessage = ({data}) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  ws.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Bercy renderer disconnected'));
    pending.clear();
  };
  async function evaluate(expression) {
    const id = ++next;
    const response = await new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      ws.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression, awaitPromise:true, returnByValue:true}}));
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  return {evaluate, close:() => ws.close()};
}
