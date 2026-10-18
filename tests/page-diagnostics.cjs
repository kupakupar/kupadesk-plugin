const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require(process.argv[2] || 'jsdom');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const dom = new JSDOM('<iframe></iframe>', {url: 'http://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true});
  const win = dom.window.document.querySelector('iframe').contentWindow;
  win.document.open(); win.document.write(fs.readFileSync(path.join(root, 'page/index.html'), 'utf8')); win.document.close();
  win.TextEncoder = TextEncoder;
  const $ = id => win.document.getElementById(id);
  const initial = {schemaVersion: 1, enabled: true, bindings: [{id: 'a', name: 'Existing', prompt: 'KEEP_PRIVATE', models: ['one/a']}]};
  let saved = clone(initial), saves = 0;
  win.magpie = {ready: Promise.resolve({dark: true}), onTheme: fn => {win.setTheme = fn;},
    options: {get: async () => clone(saved), set: async value => {saves++; saved = clone(value); return clone(saved);}}, read: async () => []};
  const last = {id: '2', at: new Date().toISOString(), requested: 'one/a', outcome: 'injected', accepted: 'present',
    completion: 'success', binding: {state: 'matched', name: '<img src=x onerror=alert(1)>', models: ['one/a']},
    route: {state: 'matched', provider: 'real', model: 'vendor-model', status: 200}};
  win.KUPADESK_MODEL_CATALOG = {schemaVersion: 1, status: 'ready', models: [{id: 'one/a', name: 'My Selected Model', provider: 'one', providerName: 'My Provider'}],
    providers: [{id: 'real', name: 'Actual Provider'}], injection: {recent: [last, {...last, id: '1', requested: 'two/b', route: {state: 'ambiguous'}}]}};
  win.eval(fs.readFileSync(path.join(root, 'page/kupadesk-native-003-app.js'), 'utf8'));
  try {
    await wait(25);
    assert.equal($('diagnostic-request').options.length, 2);
    assert.equal($('diagnostic-model').textContent, 'My Selected Model · My Provider');
    assert.equal($('diagnostic-provider').textContent, 'Actual Provider');
    assert.equal($('diagnostic-provider-id').textContent, 'real');
    assert.equal($('diagnostic-result').textContent, '已确认加入本次请求');
    assert.ok($('diagnostic-request').options[0].textContent.includes('My Selected Model'));
    assert.equal($('diagnostic-requested-id').textContent, 'one/a');
    assert.equal(win.document.querySelector('.diagnostic-technical').open, false);
    assert.equal($('diagnostic-served-model').textContent, 'vendor-model');
    assert.equal($('diagnostic-accepted').textContent, '宿主接受的请求含绑定提示词');
    assert.equal($('diagnostic-binding').querySelector('img'), null, 'diagnostic labels are never HTML');
    $('binding-prompt').value = 'UNSAVED_DRAFT'; $('binding-prompt').dispatchEvent(new win.Event('input', {bubbles: true}));
    $('diagnostic-request').value = '1'; $('diagnostic-request').dispatchEvent(new win.Event('change', {bubbles: true}));
    assert.equal($('diagnostic-model').textContent, '模型名称暂不可用');
    assert.equal($('diagnostic-provider').textContent, '回复 ID 重复，无法唯一确认');
    const previousOption = $('diagnostic-request').options[0];
    win.KUPADESK_MODEL_CATALOG.injection.recent[1].route = {state: 'waiting'};
    $('refresh-catalog').click();
    const refresh = [...win.document.querySelectorAll('script')].find(script => script.src.includes('fresh='));
    assert.ok(refresh, 'real catalog refresh path is used');
    refresh.dispatchEvent(new win.Event('load'));
    assert.equal($('diagnostic-request').value, '1', 'polling keeps the selected request');
    assert.equal($('diagnostic-request').options[0], previousOption, 'unchanged options are not rebuilt while in use');
    assert.equal($('diagnostic-provider').textContent, '等待本机用量记录');
    for (const theme of ['light', 'dark']) win.setTheme({dark: theme === 'dark'});
    assert.equal($('binding-prompt').value, 'UNSAVED_DRAFT');
    assert.deepEqual(saved, initial);
    assert.equal(saves, 0, 'diagnostics must not save or sync options');
    console.log(JSON.stringify({requestSelection: true, actualProvider: true, ambiguousEvidenceExplicit: true,
      labelsAreText: true, draftsPreserved: true, configurationWrites: saves}));
  } finally {
    win.dispatchEvent(new win.Event('pagehide')); dom.window.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
