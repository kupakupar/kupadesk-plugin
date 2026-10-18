// Run with: node tests/page-editor.cjs /path/to/an/existing/jsdom
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(process.argv[2] || 'jsdom');

(async () => {
  const dom = new JSDOM('<iframe></iframe>', {url: 'http://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true});
  const win = dom.window.document.querySelector('iframe').contentWindow;
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'page/index.html'), 'utf8');
  win.document.open(); win.document.write(html); win.document.close();
  win.TextEncoder = TextEncoder;
  let saved = {schemaVersion: 1, enabled: true, bindings: [{id: 'fixture', name: 'Fixture', prompt: 'BASE', models: ['one/m'], enabled: true, chatRole: 'auto'}]};
  let saves = 0;
  win.magpie = {ready: Promise.resolve({dark: true}), onTheme: fn => {win.setTheme = fn;},
    options: {get: async () => structuredClone(saved), set: async value => {saves++; saved = structuredClone(value); return saved;}}, read: async () => []};
  win.KUPADESK_MODEL_CATALOG = {schemaVersion: 1, status: 'ready', models: [{id: 'one/m'}], injection: {last: {outcome: 'injected'}}};
  win.eval(fs.readFileSync(path.join(root, 'page/kupadesk-native-003-app.js'), 'utf8'));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const field = win.document.getElementById('binding-prompt');
  const button = win.document.getElementById('save-options');
  const edit = text => {field.value = text; field.dispatchEvent(new win.Event('input', {bubbles: true}));};
  try {
    await wait(30);
    assert.equal(field.maxLength, -1, 'pasted text must not be truncated');
    for (const text of ['字'.repeat(16001), 'x'.repeat(32768)]) {
      edit(text); button.click(); await wait(30);
      assert.equal(saved.bindings[0].prompt, text);
      await wait(1150);
    }
    const before = saves;
    edit('x'.repeat(32769)); button.click(); await wait(30);
    assert.equal(field.value.length, 32769);
    assert.equal(saves, before);
    assert.match(win.document.getElementById('prompt-error').textContent, /32768/);
    win.setTheme({dark: false}); assert.equal(win.document.documentElement.dataset.theme, 'light');
    win.setTheme({dark: true}); assert.equal(win.document.documentElement.dataset.theme, 'dark');
    assert.match(win.document.getElementById('injection-info').textContent, /已生成提示词注入/);
    edit('UNSAVED_DRAFT');
    saved.bindings[0].name = 'Updated in another view';
    button.click(); await wait(30);
    assert.equal(saves, before, 'a stale draft must not overwrite newer settings');
    assert.equal(saved.bindings[0].name, 'Updated in another view');
    assert.equal(field.value, 'UNSAVED_DRAFT', 'a conflict must preserve the draft');
    assert.match(win.document.getElementById('save-error').textContent, /其他页面或设备/);
    console.log(JSON.stringify({savedLengths: [16001, 32768], oversizedDraftPreserved: true, concurrentEditProtected: true, themes: ['light', 'dark'], saves}));
  } finally {win.dispatchEvent(new win.Event('pagehide')); dom.window.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
