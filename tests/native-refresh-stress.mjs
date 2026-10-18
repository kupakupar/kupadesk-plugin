import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const port = Number(process.env.KUPA_TEST_CDP_PORT || 14648);
const cycles = Number(process.argv[2] || 30);
const label = process.argv[3] || 'navigation-012';
const action = process.argv[4] || 'refresh';
const pause = Number(process.env.KUPA_TEST_CYCLE_PAUSE || 150);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(3000)});
  return response.json();
}
async function connect(type) {
  const target = (await targets()).find(item => item.type === type && (type !== 'page' || new URL(item.url).pathname === '/'));
  if (!target) throw Error(`missing isolated ${type} target`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    const handler = pending.get(reply.id);
    if (handler) {clearTimeout(handler.timer); pending.delete(reply.id); handler.resolve(reply);}
  };
  return {async call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {pending.delete(next); reject(Error(`timeout: ${method}`));}, 4000);
      pending.set(next, {timer, resolve}); socket.send(JSON.stringify({id: next, method, params}));
    });
  }, async evaluate(expression) {
    const reply = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (reply.error || reply.result?.exceptionDetails) throw Error('isolated runtime evaluation failed');
    return reply.result?.result?.value;
  }, close() {socket.close();}};
}
const parent = await connect('page');
const started = Date.now();
const rows = [];
let failure;
const before = await parent.evaluate('JSON.stringify(fixture.options)');
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  for (let i = 0; i < cycles; i++) {
    const cycleStart = Date.now();
    const initial = await parent.evaluate('fixture.hello');
    const child = await connect('iframe');
    try {
      const state = await child.evaluate(`({connected:document.getElementById('connection-label')?.dataset.connected,version:document.querySelector('.version')?.textContent,button:!!document.getElementById('refresh-page')})`);
      if (state.connected !== 'true') throw Error('page SDK did not reconnect');
      if (action === 'remount' || (action === 'mixed' && i % 20 === 19)) await parent.evaluate('fixture.remount();true');
      else await child.evaluate(`setTimeout(()=>{for(let n=0;n<${action === 'burst' || (action === 'mixed' && i % 7 === 0) ? 25 : 1};n++)document.getElementById('refresh-page').click();},0);true`);
    } finally {child.close();}
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      const count = await parent.evaluate('fixture.hello');
      if (count > initial) {ready = true; break;}
      await wait(50);
    }
    if (!ready) throw Error('refresh did not reconnect within 8 seconds');
    const check = await connect('iframe');
    try {
      const metrics = await check.evaluate(`({connected:document.getElementById('connection-label')?.dataset.connected,nodes:document.querySelectorAll('*').length,version:document.querySelector('.version')?.textContent})`);
      const heap = await check.call('Runtime.getHeapUsage');
      rows.push({cycle: i + 1, ...metrics, elapsedMs: Date.now() - cycleStart, heapBytes: heap.result.usedSize});
    } finally {check.close();}
    if (i % 5 === 0) await parent.evaluate('fixture.toggleTheme();true');
    if ((i + 1) % 10 === 0) console.log(JSON.stringify({label, completed: i + 1}));
    await wait(pause);
  }
} catch (error) {failure = error.message;}
const final = await parent.evaluate('({hello:fixture.hello,reads:fixture.reads,writes:fixture.writes,heartbeat:fixture.heartbeat,errors:fixture.errors,options:JSON.stringify(fixture.options)})').catch(() => null);
parent.close();
const result = {label, requestedCycles: cycles, completedCycles: rows.length, elapsedMs: Date.now() - started,
  failure, settingsPreserved: final && hash(final.options) === hash(before), writes: final?.writes,
  errors: final?.errors, heartbeat: final?.heartbeat, rows};
await fs.writeFile(new URL(`../evidence/${label}.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({...result, rows: undefined}));
if (failure || !result.settingsPreserved || result.writes !== 0) process.exitCode = 1;
