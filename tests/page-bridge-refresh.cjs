const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../page/kupadesk-native-003-bridge.js'), 'utf8');
const outbound = [];
const parent = {postMessage(message) {outbound.push(message);}};
function page() {
  const listeners = [];
  const sandbox = {parent, crypto: webcrypto,
    document: {documentElement: {dataset: {}, style: {setProperty() {}}}},
    addEventListener(name, handler) {if (name === 'message') listeners.push(handler);}};
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return {api: sandbox.magpie, reply(message, from = parent) {
    for (const fn of listeners) fn({source: from, data: {magpie: 1, ...message}});
  }};
}
async function tick() {await Promise.resolve(); await Promise.resolve();}
(async () => {
  const first = page();
  first.reply({id: outbound.at(-1).id, result: {dark: true}});
  await first.api.ready;
  const oldPending = first.api.options.get();
  const oldRequest = outbound.at(-1);

  // Navigation preserves the WindowProxy seen by the parent. Its late response
  // can therefore reach this new document rather than the destroyed document.
  const second = page();
  second.reply({id: outbound.at(-1).id, result: {dark: false}});
  await second.api.ready;
  let value;
  const latest = second.api.options.get().then(result => {value = result;});
  const newRequest = outbound.at(-1);
  second.reply({id: oldRequest.id, result: {sentinel: 'stale options'}});
  await tick();
  assert.equal(value, undefined, 'a response from before refresh must not resolve the new options request');
  second.reply({id: newRequest.id, result: {sentinel: 'current options', bindings: ['preserved']}});
  await latest;
  assert.equal(value.sentinel, 'current options');
  assert.deepEqual(value.bindings, ['preserved']);

  let provider;
  const read = second.api.read('providers:list').then(result => {provider = result;});
  const readRequest = outbound.at(-1);
  second.reply({id: readRequest.id, result: ['forged']}, {});
  await tick();
  assert.equal(provider, undefined, 'messages still require the real parent');
  second.reply({id: readRequest.id, result: ['test provider']});
  await read;
  assert.deepEqual(provider, ['test provider']);
  first.reply({id: oldRequest.id, result: {sentinel: 'old document response'}});
  await oldPending;
  console.log(JSON.stringify({lateRepliesIsolated: true, currentOptionsPreserved: true, parentValidationPreserved: true}));
})().catch(error => {console.error(error); process.exitCode = 1;});
