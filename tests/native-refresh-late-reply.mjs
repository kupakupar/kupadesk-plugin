import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const port = Number(process.env.KUPA_TEST_CDP_PORT || 14648);
const label = process.argv[2] || 'late-reply';
const action = process.argv[3] || 'refresh';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function session(type) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(3000)})).json();
  const target = list.find(item => item.type === type && (type !== 'page' || new URL(item.url).pathname === '/'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {const m = JSON.parse(e.data);const p = pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m);}};
  return {async evaluate(expression) {
    const m = await new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {pending.delete(next);reject(Error('isolated CDP timeout'));}, 3000);
      pending.set(next, {resolve, timer});
      ws.send(JSON.stringify({id: next, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}));
    });
    if (m.error || m.result?.exceptionDetails) throw Error('isolated evaluation failed');
    return m.result.result.value;
  }, close() {ws.close();}};
}
async function until(fn) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {if(await fn())return;await wait(40);}
  throw Error('isolated condition timed out');
}
const parent = await session('page');
let result;
try {
  await parent.evaluate(`fixture.held=[];fixture.holdCount=2;fixture.remount();true`);
  await until(async () => await parent.evaluate('fixture.held.length') === 1);
  const first = await session('iframe');
  const firstPending = await first.evaluate(`document.getElementById('connection-label')?.dataset.connected==='true'`);
  assert.equal(firstPending, false, 'the original options reply must actually be held');
  if (action === 'remount') await parent.evaluate('fixture.remount();true');
  else await first.evaluate(`setTimeout(()=>document.getElementById('refresh-page').click(),0);true`);
  first.close();
  await until(async () => await parent.evaluate('fixture.held.length') === 2);
  const collision = await parent.evaluate('fixture.held[0].id===fixture.held[1].id');
  const sameWindowProxy = await parent.evaluate('fixture.held[0].source===fixture.held[1].source');
  const pending = await session('iframe');
  const secondPending = await pending.evaluate(`document.getElementById('connection-label')?.dataset.connected==='true'`);
  assert.equal(secondPending, false, 'the new options reply must actually be held');
  pending.close();
  // Match official pluginpages.js: it captures ev.source, awaits the options
  // HTTP request, then posts to that same WindowProxy even after navigation.
  await parent.evaluate(`fixture.held[0].source.postMessage({magpie:1,id:fixture.held[0].id,error:'stale reply from before refresh'},'*');true`);
  await wait(100);
  await parent.evaluate(`fixture.held[1].source.postMessage({magpie:1,id:fixture.held[1].id,result:fixture.options},'*');true`);
  await wait(200);
  const current = await session('iframe');
  const state = await current.evaluate(`({connected:document.getElementById('connection-label')?.dataset.connected==='true',staleError:document.getElementById('connection-notice')?.textContent.includes('stale reply from before refresh')})`);
  current.close();
  result = {label, action, collision, sameWindowProxy, firstAlreadyConnected: firstPending, secondAlreadyConnected: secondPending, ...state, writes: await parent.evaluate('fixture.writes')};
  await fs.writeFile(new URL(`../evidence/${label}.json`, import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(state.connected, true, 'a stale response must not stop the refreshed page from connecting');
  assert.equal(state.staleError, false);
} finally {
  await parent.evaluate(`fixture.holdCount=0;true`).catch(()=>{});
  parent.close();
}
