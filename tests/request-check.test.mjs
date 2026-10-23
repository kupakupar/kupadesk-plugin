import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotRequest, compareRequests} from '../request-check.mjs';
import {createDiagnostics} from '../diagnostics.mjs';
import {onRequest as inject} from '../kupadesk.middleware.js';

const options = {schemaVersion: 1, enabled: true, bindings: [{id: 'a', name: 'Test', prompt: 'SECRET_PROMPT', models: ['one/a']}]};
const context = protocol => ({model: 'one/a', protocol, options, agent: 'dsh', session: 'SECRET_SESSION', state: {}});
const tools = [{type: 'function', name: 'exec', parameters: {type: 'object', properties: {input: {type: 'string'}}}}];
const fixtures = {
  chat: {model: 'one/a', messages: [{role: 'system', content: '', future: 7}, {role: 'user', content: 'SECRET_HISTORY'},
    {role: 'assistant', content: null, reasoning_content: 'SECRET_THINK', tool_calls: [{id: 'c', function: {name: 'exec', arguments: '{}'}}]},
    {role: 'tool', tool_call_id: 'c', content: 'SECRET_RESULT'}], tools, tool_choice: 'auto', reasoning_effort: 'max'},
  responses: {model: 'one/a', input: [{type: 'additional_tools', role: 'developer', id: 'at', tools: [{type: 'namespace', name: 'functions', tools}]},
    {type: 'reasoning', id: 'rs', encrypted_content: 'SECRET_SEAL', summary: []},
    {role: 'user', content: 'SECRET_HISTORY'}, {type: 'function_call_output', call_id: 'c', output: 'SECRET_RESULT'}],
    reasoning: {effort: 'high', summary: 'auto'}, previous_response_id: 'SECRET_RESPONSE'},
  anthropic: {model: 'one/a', system: [{type: 'text', text: '', cache_control: {type: 'ephemeral'}}],
    thinking: {type: 'enabled', budget_tokens: 24000}, tools: [{name: 'exec', input_schema: {type: 'object'}}],
    messages: [{role: 'assistant', content: [{type: 'thinking', thinking: 'SECRET_THINK', signature: 'SECRET_SIG'},
      {type: 'tool_use', id: 'c', name: 'exec', input: {}}]}, {role: 'user', content: [{type: 'tool_result', tool_use_id: 'c', content: 'SECRET_RESULT'}]}]},
  gemini: {model: 'one/a', systemInstruction: {parts: [{text: '', future: 8}]},
    generationConfig: {thinkingConfig: {thinkingBudget: -1, includeThoughts: true}},
    tools: [{functionDeclarations: [{name: 'exec', parameters: {type: 'OBJECT'}}]}],
    contents: [{role: 'model', parts: [{text: 'SECRET_THINK', thought: true, thoughtSignature: 'SECRET_SIG'},
      {functionCall: {name: 'exec', args: {}}, thoughtSignature: 'SECRET_TOOL_SIG'}]},
      {role: 'user', parts: [{functionResponse: {name: 'exec', response: {result: 'SECRET_RESULT'}}}]}]}
};

for (const [protocol, raw] of Object.entries(fixtures)) test(protocol + ': diagnostics preserve injection, metadata and protected fields on first injection and retry', () => {
  const original = structuredClone(raw), c = context(protocol), before = snapshotRequest(raw, protocol);
  assert.ok(before);
  const output = inject(raw, c) || raw;
  const after = snapshotRequest(output, protocol, before.shapes);
  assert.deepEqual(raw, original, 'no observation/injection mutates the caller');
  for (const check of Object.values(compareRequests(before, after))) assert.equal(check.state, 'same');
  const retry = inject(output, context(protocol)) || output;
  for (const check of Object.values(compareRequests(after, snapshotRequest(retry, protocol, before.shapes)))) assert.equal(check.state, 'same');
  const d = createDiagnostics(); d.record('injected', {ctx: c, before, after});
  d.complete({id: 'fixture'}, {...c, request: output, success: true});
  assert.equal(d.snapshot().last.checks.plugin.tools.state, 'same');
  assert.equal(d.snapshot().last.checks.host.history.state, 'same');
  for (const secret of ['SECRET_HISTORY', 'SECRET_RESULT', 'SECRET_THINK', 'SECRET_SEAL', 'SECRET_SIG', 'SECRET_PROMPT', before.tools.hash])
    assert.equal(JSON.stringify(d.snapshot()).includes(secret), false, 'public data contains no text or digests');
});

test('captures actual Lite tool loss and protected mutations at either observation boundary', () => {
  const raw = fixtures.responses, before = snapshotRequest(raw, 'responses');
  assert.equal(before.tools.count, 1, 'namespace containers are not double counted');
  const dropped = structuredClone(raw); dropped.input.shift();
  assert.equal(compareRequests(before, snapshotRequest(dropped, 'responses')).tools.state, 'changed');
  const c = context('responses'), output = inject(raw, c), after = snapshotRequest(output, 'responses', before.shapes);
  const altered = structuredClone(output); altered.reasoning.effort = 'off'; altered.input[1].encrypted_content = 'CHANGED';
  const d = createDiagnostics(); d.record('injected', {ctx: c, before, after});
  d.complete({}, {...c, request: altered});
  assert.equal(d.snapshot().last.checks.plugin.thinking.state, 'same');
  assert.equal(d.snapshot().last.checks.host.thinking.state, 'changed');
  assert.equal(d.snapshot().last.checks.host.history.state, 'changed');
  assert.equal(d.snapshot().last.checks.host.tools.state, 'same');
});

test('history order, empty items, unknown metadata, call IDs and signatures remain significant', () => {
  for (const mutate of [v => v.messages.reverse(), v => delete v.messages[0].future,
    v => v.messages[0].content = null, v => v.messages[2].tool_calls[0].id = 'other',
    v => v.messages[3].content = 'other', v => v.messages.splice(0, 1)]) {
    const a = structuredClone(fixtures.chat), b = structuredClone(a); mutate(b);
    assert.equal(compareRequests(snapshotRequest(a, 'chat'), snapshotRequest(b, 'chat')).history.state, 'changed');
  }
  for (const key of ['tool_choice', 'parallel_tool_calls', 'function_call']) {
    const a = {...fixtures.chat, [key]: false}, b = {...a}; delete b[key];
    assert.equal(compareRequests(snapshotRequest(a, 'chat'), snapshotRequest(b, 'chat')).tools.state, 'changed');
  }
  for (const key of ['thinkingBudget', 'reasoningEffort', 'enable_thinking', 'thinking', 'think', 'effort']) {
    const a = {...fixtures.chat, [key]: false}, b = {...a}; delete b[key];
    assert.equal(compareRequests(snapshotRequest(a, 'chat'), snapshotRequest(b, 'chat')).thinking.state, 'changed', key);
  }
});

test('absent, null, empty instruction envelopes and owned prompt replacement are checked without false changes', () => {
  for (const protocol of ['responses', 'anthropic', 'gemini']) for (const value of [undefined, null, '']) {
    const key = {responses: 'instructions', anthropic: 'system', gemini: 'systemInstruction'}[protocol];
    if (protocol === 'gemini' && value === '') continue;
    const body = {model: 'one/a', ...(protocol === 'gemini' ? {contents: []} : protocol === 'responses' ? {input: []} : {messages: []})};
    if (value !== undefined) body[key] = value;
    const before = snapshotRequest(body, protocol), result = inject(body, context(protocol));
    assert.equal(compareRequests(before, snapshotRequest(result, protocol, before.shapes)).history.state, 'same');
  }
  const old = inject(fixtures.chat, context('chat'));
  const c = context('chat'); c.options = {...options, bindings: [{...options.bindings[0], prompt: 'REPLACED'}]};
  const result = inject(old, c);
  assert.equal(compareRequests(snapshotRequest(old, 'chat'), snapshotRequest(result, 'chat')).history.state, 'same');
});

test('oversized, deep, malformed and absent snapshots report unknown, never success', () => {
  const huge = {...fixtures.responses, input: 'x'.repeat(9 * 1024 * 1024)};
  assert.equal(snapshotRequest(huge, 'responses'), null);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(snapshotRequest(cyclic, 'chat'), null);
  assert.equal(snapshotRequest({}, 'unknown'), null);
  const checks = compareRequests(null, snapshotRequest(fixtures.chat, 'chat'));
  assert.ok(Object.values(checks).every(x => x.state === 'unknown'));
});

test('diagnostic options disable inspection without changing injection result', () => {
  const c = context('chat'); c.options = {...options, diagnostics: {checks: false, routes: false}};
  const d = createDiagnostics(); d.record('injected', {ctx: c}); d.complete({}, {...c, request: fixtures.chat});
  assert.equal(d.snapshot().last.checks.plugin.state, 'disabled');
  assert.equal(d.snapshot().last.checks.host.state, 'disabled');
  assert.deepEqual(inject(fixtures.chat, c), inject(fixtures.chat, context('chat')));
});

test('actual routes use response identity and route number, including failures without reply IDs', () => {
  const now = Date.now(), d = createDiagnostics({now: () => now}), c = context('chat');
  d.record('injected', {ctx: c}); d.complete({id: 'reply'}, {...c, request: fixtures.chat, success: true});
  const row = {t: new Date(now).toISOString(), agent: 'dsh', session: 'SECRET_SESSION', req: 'one/a', route_id: 7};
  d.ingest([{...row, provider: 'first', model: 'first-model', status: 503, handed_on: true, err: 'SECRET_ERROR'},
    {...row, route_id: 8, provider: 'unrelated', model: 'm', status: 429, handed_on: true},
    {...row, response_id: 'reply', provider: 'last', model: 'vendor-model', served: 'reported-model', effort: 'high', status: 200, tries: 2,
      host: 'SECRET_HOST', providerAccount: 'SECRET_ACCOUNT'}]);
  const route = d.snapshot().last.route;
  assert.equal(route.state, 'matched'); assert.equal(route.attemptState, 'recorded');
  assert.deepEqual(route.attempts.map(x => x.provider), ['first', 'last']);
  assert.equal(route.served, 'reported-model'); assert.equal(route.effort, 'high');
  for (const secret of ['SECRET_ERROR', 'SECRET_HOST', 'SECRET_ACCOUNT', 'SECRET_SESSION'])
    assert.equal(JSON.stringify(d.snapshot()).includes(secret), false);
  const d2 = createDiagnostics({now: () => now}), c2 = context('chat');
  d2.record('injected', {ctx: c2}); d2.complete({id: 'reply'}, {...c2, request: fixtures.chat});
  d2.ingest([{...row, response_id: 'reply', provider: 'last', model: 'vendor-model', status: 200, tries: 3}]);
  assert.equal(d2.snapshot().last.route.attemptState, 'partial');
  d2.ingest([{...row, provider: 'other-terminal', model: 'm', status: 200}]);
  assert.equal(d2.snapshot().last.route.attemptState, 'ambiguous');
  assert.equal(d2.snapshot().last.route.attempts.length, 0);
});
