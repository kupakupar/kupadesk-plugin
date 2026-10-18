// Run with node tests/page-009.cjs /path/to/existing/jsdom
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
  // JSDOM has no native dialog; browser QA separately verifies inert/focus trapping.
  const dialog = $('model-drawer');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => dialog.removeAttribute('open');
  const initial = {schemaVersion: 1, enabled: true, customFuture: {preserve: true}, bindings: [
    {id: 'a', name: 'Alpha', enabled: true, prompt: 'LONG\n'.repeat(3000), models: ['one/a', 'missing/kept'], chatRole: 'auto', customField: 42},
    {id: 'b', name: 'Beta', enabled: true, prompt: 'SECOND', models: ['two/b'], chatRole: 'developer'}
  ]};
  let saved = clone(initial), saves = 0;
  win.magpie = {ready: Promise.resolve({dark: true}), onTheme: fn => {win.setTheme = fn;},
    options: {get: async () => clone(saved), set: async value => {saves++; saved = clone(value); return clone(saved);}}, read: async () => []};
  const models = [{id:'one/a',name:'Alpha Model',provider:'one'}, {id:'one/c',name:'Another Model',provider:'one'}, {id:'two/b',name:'Beta Model',provider:'two'}, {id:'two/d',name:'Delta Model',provider:'two'}];
  win.KUPADESK_MODEL_CATALOG = {schemaVersion: 1, status: 'ready', models};
  win.eval(fs.readFileSync(path.join(root, 'page/kupadesk-native-003-app.js'), 'utf8'));
  const edit = (id, value) => {$(id).value = value; $(id).dispatchEvent(new win.Event('input', {bubbles:true}));};
  const change = id => $(id).dispatchEvent(new win.Event('change', {bubbles:true}));
  const selected = () => $('binding-models').value.split('\n').filter(Boolean);
  const row = id => [...win.document.querySelectorAll('[data-model-id]')].find(el => el.dataset.modelId === id);
  try {
    await wait(25);
    assert.equal($('binding-prompt').value, initial.bindings[0].prompt);
    assert.equal($('bound-model-summary').textContent, '已绑定 2 个模型');
    assert.equal($('extra-selected-models').hidden, false, 'unavailable bindings remain visible');
    $('manage-models').focus(); $('manage-models').click();
    assert.equal(dialog.open, true);
    assert.equal(win.document.activeElement.id, 'model-search');
    assert.equal(row('two/b').disabled, true, 'another prompt keeps ownership');
    edit('model-search', 'Another');
    assert.equal($('model-list').children.length, 1);
    row('one/c').click();
    assert.deepEqual(selected(), ['one/a', 'missing/kept', 'one/c']);
    edit('model-search', ''); $('model-provider').value = 'two'; change('model-provider');
    row('two/d').click();
    assert.deepEqual(selected(), ['one/a', 'missing/kept', 'one/c', 'two/d'], 'changing filters does not discard hidden selections');
    $('models-selected-only').checked = true; change('models-selected-only');
    assert.equal($('model-list').children.length, 1);
    dialog.dispatchEvent(new win.Event('cancel', {cancelable:true}));
    assert.equal(dialog.open, false);
    assert.equal(win.document.activeElement.id, 'manage-models');
    assert.equal($('bound-model-summary').textContent, '已绑定 4 个模型');
    assert.equal(saves, 0, 'closing the drawer stages edits without saving');
    $('manage-models').click();
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(dialog.open, false, 'Escape closes the drawer and preserves the draft');
    assert.equal($('bound-model-summary').textContent, '已绑定 4 个模型');
    edit('binding-name', 'Alpha changed');
    win.document.querySelector('[data-binding-id="b"]').click();
    assert.equal($('binding-prompt').value, 'SECOND');
    win.document.querySelector('[data-binding-id="a"]').click();
    assert.equal($('binding-name').value, 'Alpha changed', 'switching prompts preserves drafts');
    assert.equal($('binding-prompt').value, initial.bindings[0].prompt);
    $('focus-editor').click();
    assert.equal($('app-shell').dataset.focus, 'true');
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    assert.equal($('app-shell').dataset.focus, 'false');
    $('save-options').click(); await wait(25);
    assert.equal(saves, 1);
    assert.equal(saved.bindings[0].prompt, initial.bindings[0].prompt);
    assert.deepEqual(saved.bindings[0].models, ['one/a', 'missing/kept', 'one/c', 'two/d']);
    assert.equal(saved.bindings[0].customField, 42);
    assert.deepEqual(saved.customFuture, {preserve:true});
    assert.deepEqual(saved.bindings[1], initial.bindings[1]);
    edit('binding-prompt', 'unsaved'); $('discard-changes').click();
    assert.equal($('binding-prompt').value, initial.bindings[0].prompt);
    $('prompt-actions').open = true; $('copy-binding').click();
    assert.equal($('prompt-actions').open, false);
    assert.deepEqual(selected(), [], 'a copy does not steal bindings');
    assert.equal($('binding-enabled').checked, false);
    assert.equal($('binding-prompt').value, initial.bindings[0].prompt);
    $('delete-binding').click(); $('undo-delete').click();
    assert.equal($('binding-prompt').value, initial.bindings[0].prompt, 'undo restores the whole prompt');
    win.setTheme({dark:false}); assert.equal(win.document.documentElement.dataset.theme, 'light');
    win.setTheme({dark:true}); assert.equal(win.document.documentElement.dataset.theme, 'dark');
    console.log(JSON.stringify({drawer:true,searchAndProviderFilters:true,multipleSelection:true,unavailableBindingsPreserved:true,duplicateBindingsBlocked:true,draftsPreserved:true,focusMode:true,copyAndUndo:true,unknownFieldsPreserved:true,privatePromptChars:initial.bindings[0].prompt.length,themes:['light','dark']}));
  } finally {win.dispatchEvent(new win.Event('pagehide')); dom.window.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
