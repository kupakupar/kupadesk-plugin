import {test, expect} from 'bun:test';
import {onRequest} from '../kupadesk.middleware.js';
import {buildRequestIndex} from '../request-index.mjs';

const START = '<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->';
const index = buildRequestIndex({models: ['one/m', 'two/m', 'one/unique', 'one/m:high', 'one/large[1m]'].map(id => ({id}))}, {
  providerRows: [{id: 'one', was: ['former']}],
  groupRows: [{id: 'pool', name: 'My Pool', members: ['one/m', 'two/m']},
    {id: 'nested', name: 'Nested', members: ['group/pool']},
    {id: 'wild', name: 'Wildcard', members: ['one/*']}],
});
const binding = (models, prompt = 'FIXTURE_PROMPT') => ({id: prompt, enabled: true, models, prompt, chatRole: 'auto'});
const options = bindings => ({schemaVersion: 1, enabled: true, bindings});
const chat = model => ({model, messages: [{role: 'system', content: 'ORIGINAL'}, {role: 'user', content: 'QUESTION'}],
  tools: [{type: 'function', function: {name: 'fixture', parameters: {type: 'object'}}}], stream: false});
function run(body, bindings, protocol = 'chat', context = {}) {
  let error;
  const state = {};
  const result = onRequest(body, {model: body.model, protocol, modelIndex: index, state,
    options: options(bindings), reject: (status, message) => {error = {status, message};}, ...context});
  return {body: result || body, result, error, state};
}

test('full model IDs, effort suffixes, provider renames and unambiguous bare models match', () => {
  for (const model of ['one/unique', 'one/unique:max', 'unique', 'unique:high', 'former/unique', 'anthropic/one/unique', 'anthropic/one/unique:max']) {
    const result = run(chat(model), [binding(['one/unique'])]);
    expect(JSON.stringify(result.body)).toContain('FIXTURE_PROMPT');
    expect(result.error).toBeUndefined();
  }
});

test('equivalent selections in one binding deduplicate; colliding group names remain ambiguous', () => {
  expect(JSON.stringify(run(chat('one/unique'), [binding(['one/unique', 'former/unique', 'unique'])]).body)).toContain('FIXTURE_PROMPT');
  const collision = buildRequestIndex({models: []}, {groupRows: [
    {id: 'a', name: 'Shared', members: ['one/m']}, {id: 'b', name: 'Shared', members: ['two/m']},
  ]});
  const result = run(chat('Shared'), [binding(['group/a'])], 'chat', {modelIndex: collision});
  expect(result.error?.status).toBe(400);
});

test('a native colon model and the 1m context marker keep their identity', () => {
  expect(run(chat('one/m:high'), [binding(['one/m'])]).result).toBeUndefined();
  expect(JSON.stringify(run(chat('one/m:high'), [binding(['one/m:high'])]).body)).toContain('FIXTURE_PROMPT');
  expect(JSON.stringify(run(chat('one/large:max[1m]'), [binding(['one/large[1m]'])]).body)).toContain('FIXTURE_PROMPT');
});

test('ambiguous bare models never silently select a different prompt or an unbound provider', () => {
  expect(run(chat('m'), [binding(['one/m'])]).error?.status).toBe(400);
  expect(run(chat('m'), [binding(['one/m']), binding(['two/m'], 'OTHER')]).error?.status).toBe(400);
  expect(JSON.stringify(run(chat('m'), [binding(['one/m', 'two/m'])]).body)).toContain('FIXTURE_PROMPT');
});

test('group IDs, names, nested groups and complete member coverage agree', () => {
  for (const model of ['group/pool', 'pool', 'My Pool', 'MY POOL', 'pool:max']) {
    expect(JSON.stringify(run(chat(model), [binding(['group/pool'])]).body)).toContain('FIXTURE_PROMPT');
  }
  expect(JSON.stringify(run(chat('group/nested'), [binding(['one/m', 'two/m'])]).body)).toContain('FIXTURE_PROMPT');
  expect(run(chat('pool'), [binding(['one/m'])]).error?.status).toBe(400);
  expect(run(chat('pool'), []).result).toBeUndefined();
  expect(JSON.stringify(run(chat('wild'), [binding(['one/m', 'one/unique', 'one/m:high', 'one/large[1m]'])]).body)).toContain('FIXTURE_PROMPT');
});

test('four protocols preserve input and tools, and retrying does not duplicate instructions', () => {
  const fixtures = {
    chat: chat('one/unique'),
    responses: {model: 'one/unique', instructions: 'ORIGINAL', input: [{role: 'user', content: 'QUESTION'}]},
    anthropic: {model: 'one/unique', system: [{type: 'text', text: 'ORIGINAL', cache_control: {type: 'ephemeral'}}], messages: [{role: 'user', content: 'QUESTION'}]},
    gemini: {model: 'one/unique', systemInstruction: {parts: [{text: 'ORIGINAL'}]}, contents: [{role: 'user', parts: [{text: 'QUESTION'}]}]},
  };
  for (const [protocol, original] of Object.entries(fixtures)) {
    const before = JSON.stringify(original);
    const first = run(original, [binding(['one/unique'])], protocol);
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(first.body)).toContain('ORIGINAL');
    expect(JSON.stringify(first.body)).toContain('QUESTION');
    const second = run(first.body, [binding(['one/unique'])], protocol);
    expect(second.result).toBeUndefined();
    expect(JSON.stringify(second.body).split(START).length - 1).toBe(1);
    expect(first.body.tools).toEqual(original.tools);
  }
});

test('changed prompts replace old blocks and preexisting developer instructions retain their role', () => {
  const body = chat('one/unique');
  body.messages[0].role = 'developer';
  const first = run(body, [binding(['one/unique'], 'OLD')]);
  const second = run(first.body, [binding(['one/unique'], 'NEW')]);
  expect(second.body.messages[0].role).toBe('developer');
  expect(JSON.stringify(second.body)).not.toContain('\nOLD\n');
  expect(JSON.stringify(second.body)).toContain('NEW');
  expect(JSON.stringify(second.body).split(START).length - 1).toBe(1);
});

test('Responses Lite additional_tools developer items survive injection and retry', () => {
  // Captured from Codex 0.163.0-alpha.11: this developer item has tools,
  // rather than message content. Dropping it leaves the model no tools.
  const additional = {type: 'additional_tools', id: 'at_fixture', role: 'developer', tools: [
    {type: 'namespace', name: 'functions', tools: [
      {type: 'custom', name: 'exec', format: {type: 'text'}},
      {type: 'function', name: 'wait', parameters: {type: 'object'}},
    ]},
  ]};
  const body = {model: 'one/unique', input: [additional,
    {type: 'message', role: 'developer', content: [{type: 'input_text', text: 'ORIGINAL'}]},
    {role: 'user', content: 'QUESTION'},
  ], tool_choice: 'auto', parallel_tool_calls: true};
  const before = JSON.stringify(body);
  const first = run(body, [binding(['one/unique'])], 'responses');
  expect(first.error).toBeUndefined();
  expect(first.body.input[0]).toBe(additional);
  expect(first.body.input[0].tools).toBe(additional.tools);
  expect(first.body.input[1].content).toEqual(body.input[1].content);
  expect(first.body.tool_choice).toBe('auto');
  expect(first.body.parallel_tool_calls).toBe(true);
  expect(JSON.stringify(body)).toBe(before);
  const second = run(first.body, [binding(['one/unique'])], 'responses');
  expect(second.result).toBeUndefined();
  expect(second.body.input[0]).toBe(additional);
});

test('replacing a Responses prompt cleans message items and preserves tool declarations', () => {
  const additional = {type: 'additional_tools', role: 'developer', tools: [
    {type: 'namespace', name: 'functions', tools: [
      {type: 'function', name: 'read', parameters: {type: 'object'}},
    ]},
  ]};
  const body = {model: 'one/unique', input: [additional,
    {type: 'message', role: 'developer', content: 'ORIGINAL'},
    {role: 'user', content: 'QUESTION'},
  ]};
  const first = run(body, [binding(['one/unique'], 'OLD')], 'responses');
  const next = run(first.body, [binding(['one/unique'], 'NEW')], 'responses');
  expect(next.error).toBeUndefined();
  expect(next.body.input[0]).toBe(additional);
  expect(next.body.input[1]).toEqual(body.input[1]);
  expect(next.body.instructions).toContain('\nNEW\n');
  expect(next.body.instructions).not.toContain('\nOLD\n');
  expect(next.body.instructions.split(START).length - 1).toBe(1);
});

test('long prompts remain valid; duplicate bindings and malformed instructions are explicit errors', () => {
  const body = chat('one/unique');
  expect(run(body, [binding(['one/unique'], 'x'.repeat(32768))]).error).toBeUndefined();
  expect(run(body, [binding(['one/unique'], 'x'.repeat(32769))]).error).toBeUndefined();
  expect(run(body, [binding(['one/unique']), binding(['one/unique'], 'OTHER')]).error?.status).toBe(400);
  body.messages[0].content = 42;
  expect(run(body, [binding(['one/unique'])]).error?.status).toBe(400);
  expect(body.messages[0].content).toBe(42);
  const gemini = {model: 'one/unique', systemInstruction: {parts: []}, system_instruction: {parts: []}};
  expect(run(gemini, [binding(['one/unique'])], 'gemini').error?.status).toBe(400);
});

test('disabled and unbound requests remain unchanged; a large history is not cloned', () => {
  const body = chat('one/unique');
  body.messages.push({role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024)});
  const first = run(body, [binding(['one/unique'])]);
  expect(first.body.messages[2]).toBe(body.messages[2]);
  expect(run(body, [], 'chat').result).toBeUndefined();
  expect(run(body, [binding(['one/unique'])], 'chat', {options: {enabled: false}}).result).toBeUndefined();
});

test('the portable request index carries no credentials, endpoints or private prompts', () => {
  const value = buildRequestIndex({models: [{id: 'one/m'}]}, {
    providerRows: [{id: 'one', was: ['old'], key: 'SECRET', chat: 'https://private.invalid'}],
    groupRows: [{id: 'g', name: 'Group', members: ['one/m'], prompt: 'PRIVATE'}],
  });
  expect(JSON.stringify(value)).not.toMatch(/SECRET|private.invalid|PRIVATE/);
});
