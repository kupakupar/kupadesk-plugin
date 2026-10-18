import {test, expect} from 'bun:test';
import {onRequest, onProvider} from '../kupadesk.middleware.js';
import {buildRequestIndex} from '../request-index.mjs';
import {supportsProviderHook} from '../catalog-sync.mjs';

const index = buildRequestIndex({models: [{id:'a/m'},{id:'b/m'},{id:'codex/gpt-6'}]}, {
  providerHook:true, groupRows:[{id:'pool',name:'Pool',members:['a/m','b/m']}],
});
const options = {schemaVersion:1,enabled:true,bindings:[
  {id:'a',models:['a/m'],prompt:'PROMPT_A'}, {id:'b',models:['b/m'],prompt:'PROMPT_B'},
]};
const body = {model:'m',messages:[{role:'system',content:'ORIGINAL'},{role:'user',content:'QUESTION'}]};
const ctx = extra => ({model:'m',protocol:'chat',options,modelIndex:index,state:{},...extra});
const call = (input, provider, extra={}) => onProvider(input,ctx({provider,...extra})) || input;
const texts = value => JSON.stringify(value);

test('modern hosts defer ambiguous entry models until an actual provider is known', () => {
  let rejected=false; const context=ctx({reject(){rejected=true;}});
  expect(onRequest(body,context)).toBeUndefined();
  expect(rejected).toBe(false);
  expect(context.state.kupadeskOutcome).toBe('deferred');
  expect(texts(call(body,{id:'a',model:'m'}))).toContain('PROMPT_A');
  expect(texts(call(body,{id:'b',model:'m'}))).toContain('PROMPT_B');
});

test('fallback switches prompts and an unbound provider removes stale managed text', () => {
  const first=call(body,{id:'a',model:'m'});
  const second=call(first,{id:'b',model:'m'});
  expect(texts(second)).toContain('PROMPT_B');
  expect(texts(second)).not.toContain('PROMPT_A');
  expect(texts(second)).toContain('ORIGINAL');
  expect(texts(call(second,{id:'unbound',model:'m'}))).not.toContain('PROMPT_');
  expect(texts(body)).not.toContain('PROMPT_');
  expect(texts(call(second,{id:'b',model:'m'})).split('KUPADESK-NATIVE-PAGE-TEST:BEGIN').length).toBe(2);
});

test('an explicitly bound routing group retains precedence across provider attempts', () => {
  const grouped={...options,bindings:[...options.bindings,{id:'pool',models:['group/pool'],prompt:'GROUP_PROMPT'}]};
  for(const provider of [{id:'a',model:'m'},{id:'b',model:'m'}]) {
    const result=call({...body,model:'Pool'},provider,{model:'Pool',options:grouped});
    expect(texts(result)).toContain('GROUP_PROMPT');
    expect(texts(result)).not.toContain('PROMPT_A');
    expect(texts(result)).not.toContain('PROMPT_B');
  }
});

test('individual subscription seats match their reported provider kind', () => {
  const subscription={...options,bindings:[{id:'sub',models:['codex/gpt-6'],prompt:'SUBSCRIPTION_PROMPT'}]};
  expect(texts(call(body,{id:'seat-123',account:'codex',model:'gpt-6'},{options:subscription}))).toContain('SUBSCRIPTION_PROMPT');
  expect(texts(call(body,{id:'unrelated-key',model:'gpt-6'},{options:subscription}))).not.toContain('SUBSCRIPTION_PROMPT');
});

test('an explicit group prompt still chooses its chat role from the actual model', () => {
  const grouped={...options,bindings:[{models:['group/pool'],prompt:'GROUP_PROMPT'}]};
  const result=call(body,{id:'codex',model:'gpt-6'},{model:'group/pool',options:grouped});
  expect(result.messages[0].role).toBe('developer');
});

test('invalid or duplicate active bindings reject before provider dispatch', () => {
  for(const bindings of [[{models:['a/m'],prompt:''}], [...options.bindings,{models:['a/m'],prompt:'DUPLICATE'}]]) {
    let status;onRequest(body,ctx({options:{...options,bindings},reject(code){status=code;}}));
    expect(status).toBe(400);
  }
});

test('provider matching preserves every instruction protocol and clears stale fallbacks', () => {
  const cases={chat:body, responses:{model:'m',instructions:'ORIGINAL',input:'QUESTION'},
    anthropic:{model:'m',system:[{type:'text',text:'ORIGINAL'}],messages:[{role:'user',content:'QUESTION'}]},
    gemini:{systemInstruction:{parts:[{text:'ORIGINAL'}]},contents:[{role:'user',parts:[{text:'QUESTION'}]}]}};
  for(const [protocol,input] of Object.entries(cases)) {
    const before=texts(input);
    const first=call(input,{id:'a',model:'m'},{protocol});
    const second=call(first,{id:'b',model:'m'},{protocol});
    const clean=call(second,{id:'other',model:'m'},{protocol});
    expect(texts(second)).toContain('PROMPT_B');expect(texts(second)).not.toContain('PROMPT_A');
    expect(texts(clean)).not.toContain('PROMPT_');expect(texts(clean)).toContain('ORIGINAL');
    expect(texts(input)).toBe(before);
  }
});

test('older and unknown hosts retain entry-model matching', () => {
  for(const version of ['0.1.1279','garbage',undefined]) expect(supportsProviderHook(version)).toBe(false);
  for(const version of ['0.1.1283','v0.1.1285','0.2.0','1.0.0']) expect(supportsProviderHook(version)).toBe(true);
  const result=onRequest({...body,model:'a/m'},ctx({model:'a/m',modelIndex:{...index,providerHook:false}}));
  expect(texts(result)).toContain('PROMPT_A');
});
