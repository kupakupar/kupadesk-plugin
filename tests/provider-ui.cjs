const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require(process.argv[2]||'jsdom');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.resolve(__dirname,'..');

async function check(panel) {
  const dom=new JSDOM('<iframe></iframe>',{url:'http://fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window.document.querySelector('iframe').contentWindow;
  win.document.open();win.document.write(fs.readFileSync(path.join(root,'page',panel?'provider.html':'index.html'),'utf8'));win.document.close();
  win.TextEncoder=TextEncoder;
  let saved={schemaVersion:1,enabled:true,bindings:[
    {id:'one',name:'One',models:['one/m'],prompt:'PROMPT_ONE'},
    {id:'two',name:'Two',models:['two/m'],prompt:'PROMPT_TWO'}]};
  let saves=0;
  win.magpie={ready:Promise.resolve({dark:true}),context:panel?{provider:{id:'two',name:'Two'}}:{},
    onTheme(fn){win.setTheme=fn;},onAction(fn){win.action=fn;},
    options:{get:async()=>structuredClone(saved),set:async v=>{saves++;saved=structuredClone(v);return saved;}},read:async()=>[]};
  win.KUPADESK_MODEL_CATALOG={schemaVersion:1,status:'ready',providerHook:true,
    models:[{id:'one/m',provider:'one'},{id:'two/m',provider:'two'},{id:'two/n',provider:'two'}]};
  win.eval(fs.readFileSync(path.join(root,'page/kupadesk-native-003-app.js'),'utf8'));
  const $=id=>win.document.getElementById(id);
  try {
    await wait(20);
    if(!panel)win.action({id:'configure-provider-prompts',provider:{id:'two',name:'Two'}});
    assert.equal($('model-provider').value,'two');
    assert.equal($('binding-prompt').value,'PROMPT_TWO');
    assert.equal($('model-provider').disabled,panel);
    assert.equal($('clear-provider-context').hidden,panel);
    assert.equal(win.document.querySelectorAll('#model-list [data-model-id]').length,2);
    assert.equal(saves,0,'opening a provider must never save or alter bindings');
    assert.equal(saved.bindings[0].models[0],'one/m');
    $('binding-prompt').value='UNSAVED_DRAFT';$('binding-prompt').dispatchEvent(new win.Event('input',{bubbles:true}));
    if(!panel) {
      win.action({id:'configure-provider-prompts',provider:{id:'one',name:'One'}});
      assert.equal($('binding-prompt').value,'UNSAVED_DRAFT');
      $('clear-provider-context').click();assert.equal($('model-provider').value,'');
    }
    saved.bindings[0].name='Changed in another view';
    $('save-options').click();await wait(30);
    assert.equal(saves,0,'a stale panel draft must not overwrite another page');
    assert.match($('save-error').textContent,/其他页面或设备/);
    assert.equal($('binding-prompt').value,'UNSAVED_DRAFT');
    for(const dark of [false,true]){win.setTheme({dark});assert.equal(win.document.documentElement.dataset.theme,dark?'dark':'light');}
    console.log(JSON.stringify({view:panel?'provider panel':'native page',providerScoped:true,openingWrites:0,draftPreserved:true,concurrentEditProtected:true}));
  }finally{win.dispatchEvent(new win.Event('pagehide'));dom.window.close();}
}
(async()=>{await check(false);await check(true);})().catch(error=>{console.error(error);process.exitCode=1;});
