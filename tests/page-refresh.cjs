const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require(process.argv[2] || 'jsdom');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(connected = true, native = false) {
  let reloads = 0, writes = 0, finishSave;
  const console = new VirtualConsole();
  console.on('jsdomError', error => {
    if (/not implemented: navigation/i.test(error.message)) reloads++;
    else throw error;
  });
  const frame = native ? '<iframe src="http://wails.localhost/_magpie/plugin/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html"></iframe>' : '<iframe></iframe>';
  const dom = new JSDOM(frame, {url: 'http://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console});
  const win = dom.window.document.querySelector('iframe').contentWindow;
  const html = fs.readFileSync(path.join(root, 'page/index.html'), 'utf8').replaceAll('__KUPADESK_ASSET_NONCE__', 'a'.repeat(64));
  win.document.open(); win.document.write(html); win.document.close();
  win.TextEncoder = TextEncoder;
  let saved = {schemaVersion: 1, enabled: true, bindings: [{id: 'a', name: 'Existing', prompt: 'KEEP_ORIGINAL', models: ['one/a']}]};
  win.magpie = {ready: connected ? Promise.resolve({dark: true}) : Promise.reject(new Error('host temporarily unavailable')),
    onTheme: () => {}, read: async () => [], options: {get: async () => clone(saved),
      set: value => {writes++; return new Promise(resolve => {finishSave = () => {saved = clone(value); resolve(clone(value));};});}}};
  win.KUPADESK_MODEL_CATALOG = {schemaVersion: 1, status: 'ready', models: []};
  win.eval(fs.readFileSync(path.join(root, 'page/kupadesk-native-003-app.js'), 'utf8'));
  await wait(25);
  return {win, $: id => win.document.getElementById(id), reloads: () => reloads,
    writes: () => writes, finishSave: () => finishSave(), saved: () => clone(saved),
    close() {win.dispatchEvent(new win.Event('pagehide')); dom.window.close();}};
}

(async () => {
  const rapid = await fixture();
  try {
    for (let n = 0; n < 25; n++) rapid.$('refresh-page').click();
    rapid.$('refresh-page').dispatchEvent(new rapid.win.MouseEvent('click', {bubbles: true}));
    assert.equal(rapid.reloads(), 1, 'rapid clicks must start only one navigation');
    assert.equal(rapid.$('refresh-page').disabled, true);
    assert.ok(rapid.$('refresh-page').textContent.includes('正在刷新'));
    assert.equal(rapid.writes(), 0);
  } finally {rapid.close();}
  const f = await fixture();
  try {
    f.$('binding-prompt').value = 'UNSAVED'.repeat(5000);
    f.$('binding-prompt').dispatchEvent(new f.win.Event('input', {bubbles: true}));
    f.$('refresh-page').click();
    assert.equal(f.reloads(), 0, 'unsaved and oversized drafts block navigation');
    assert.equal(f.$('binding-prompt').value.length, 35000, 'the full draft is preserved');
    assert.ok(f.$('save-error').textContent.includes('先保存设置或还原修改'));
    f.$('discard-changes').click();
    assert.equal(f.$('binding-prompt').value, 'KEEP_ORIGINAL');
    f.$('binding-prompt').value = 'SAVE_THIS'; f.$('binding-prompt').dispatchEvent(new f.win.Event('input', {bubbles: true}));
    f.$('save-options').click(); await wait(10);
    assert.equal(f.$('refresh-page').disabled, true, 'a pending save blocks refresh');
    f.$('refresh-page').click(); assert.equal(f.reloads(), 0);
    f.finishSave(); await wait(20);
    assert.equal(f.$('refresh-page').disabled, false);
    f.$('refresh-page').click(); assert.equal(f.reloads(), 1);
    assert.equal(f.saved().bindings[0].prompt, 'SAVE_THIS');
    assert.deepEqual(f.saved().bindings[0].models, ['one/a']);
  } finally {f.close();}
  const offline = await fixture(false);
  try {
    assert.equal(offline.$('refresh-page').disabled, false);
    offline.$('refresh-page').click(); assert.equal(offline.reloads(), 1, 'refresh remains available after handshake failure');
    assert.equal(offline.writes(), 0);
  } finally {offline.close();}
  const native = await fixture(true, true);
  try {
    native.$('refresh-page').click(); assert.equal(native.reloads(), 1, 'native page navigates through the authenticated page refresh route');
    assert.equal(native.writes(), 0);
  } finally {native.close();}
  const unavailable = await fixture(true, true);
  try {
    unavailable.win.document.querySelectorAll('script').forEach(script => script.remove());
    unavailable.$('refresh-page').click();
    assert.equal(unavailable.reloads(), 0, 'missing native capability does not navigate to a blank page');
    assert.ok(unavailable.$('save-error').textContent.includes('暂时无法刷新'));
    assert.equal(unavailable.$('refresh-page').disabled, false);
  } finally {unavailable.close();}
  const blocked = await fixture();
  try {
    blocked.$('refresh-page').click();
    await wait(8100);
    assert.equal(blocked.$('refresh-page').disabled, false, 'a blocked navigation releases the button after its timeout');
    assert.ok(blocked.$('save-error').textContent.includes('刷新未完成'));
    blocked.$('refresh-page').click();
    assert.equal(blocked.reloads(), 2, 'the user can retry a blocked navigation');
  } finally {blocked.close();}
  console.log(JSON.stringify({cleanReload: true, singleNavigation: true, blockedNavigationRecovery: true, unsavedDraftProtected: true, pendingSaveProtected: true,
    refreshAfterSave: true, offlineRecovery: true, bindingsPreserved: true}));
})().catch(error => {console.error(error); process.exitCode = 1;});
