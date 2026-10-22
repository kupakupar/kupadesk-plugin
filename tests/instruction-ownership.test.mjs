import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../kupadesk.middleware.js';
import {createDiagnostics} from '../diagnostics.mjs';
import {appendManagedText, readManagedText} from '../managed-prompt.js';

const START = '<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->';
const END = '<!-- KUPADESK-NATIVE-PAGE-TEST:END -->';
const model = 'fixture/model';
const index = {schemaVersion: 1, models: [model], aliases: {}, groups: {}};
const settings = prompt => ({schemaVersion: 1, enabled: true,
  bindings: [{id: 'fixture', name: 'Fixture', models: [model], prompt, enabled: true, chatRole: 'auto'}]});
function run(body, protocol, prompt = 'CURRENT_PROMPT', chatRole = 'auto') {
  const options = settings(prompt);
  options.bindings[0].chatRole = chatRole;
  const ctx = {model, protocol, modelIndex: index, options, state: {},
    reject(status, message) {throw new Error(`${status} ${message}`);}};
  return {body: onRequest(body, ctx) || body, ctx};
}
function fixture(protocol, original) {
  const common = {model, reasoning_effort: 'high', tools: [{type: 'function', name: 'read_fixture', parameters: {type: 'object'}}]};
  if (protocol === 'chat') return {...common, messages: [{role: 'system', content: original}, {role: 'user', content: 'QUESTION'}]};
  if (protocol === 'responses') return {...common, instructions: original, input: [
    {type: 'additional_tools', role: 'developer', tools: common.tools}, {role: 'user', content: 'QUESTION'}]};
  if (protocol === 'anthropic') return {...common, system: [{type: 'text', text: original, cache_control: {type: 'ephemeral'}}],
    messages: [{role: 'user', content: 'QUESTION'}]};
  return {...common, systemInstruction: {parts: [{text: original}]}, contents: [{role: 'user', parts: [{text: 'QUESTION'}]}]};
}
function instructionText(body, protocol) {
  if (protocol === 'chat') return body.messages.filter(m => ['system', 'developer'].includes(m.role)).flatMap(m =>
    typeof m.content === 'string' ? [m.content] : (m.content || []).map(part => part.text || '')).join('\n');
  if (protocol === 'responses') return body.instructions;
  if (protocol === 'anthropic') return body.system.map(part => part.text || '').join('\n');
  return body.systemInstruction.parts.map(part => part.text || '').join('\n');
}

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
  test(`${protocol}: quoted paired, partial and legacy markers preserve original instructions`, () => {
    const examples = [
      `ORIGINAL_SYSTEM\nQuoted example: ${START}\nORIGINAL_LITERAL\n${END}\nEnd quote.`,
      `ORIGINAL_SYSTEM\nQuoted start: ${START}`,
      `ORIGINAL_SYSTEM\nQuoted end: ${END}`,
      `ORIGINAL_SYSTEM\n\n${START}\nLEGACY_UNKNOWN_PROMPT\n${END}`,
      `ORIGINAL_SYSTEM\n\n\`\`\`text\n${START}\nORIGINAL_LITERAL\n${END}\n\`\`\``,
      `ORIGINAL_SYSTEM 中文🙂 e\u0301\r\n  whitespace\nQuoted end: ${END}`,
    ];
    for (const original of examples) {
      const body = fixture(protocol, original), before = JSON.stringify(body);
      const first = run(body, protocol);
      assert(instructionText(first.body, protocol).includes(original), 'original text was removed');
      assert.deepEqual(first.body.tools, body.tools);
      assert.equal(first.body.reasoning_effort, body.reasoning_effort);
      const second = run(first.body, protocol, 'REPLACEMENT_PROMPT');
      assert(instructionText(second.body, protocol).includes(original), 'replacement removed original text');
      assert(!instructionText(second.body, protocol).includes('\nCURRENT_PROMPT\n'), 'previous managed prompt survived');
      assert.equal(run(second.body, protocol, 'REPLACEMENT_PROMPT').body, second.body, 'retry must be a no-op');
      assert.equal(JSON.stringify(body), before);
      const diagnostics = createDiagnostics();
      diagnostics.record(first.ctx.state.kupadeskOutcome, {ctx: first.ctx, index});
      diagnostics.complete({id: 'fixture_reply'}, {...first.ctx, request: first.body, success: true});
      assert.equal(diagnostics.snapshot().last.accepted, 'present', 'literal markers confused diagnostics');
    }
  });
  test(`${protocol}: copied or damaged management metadata never authorizes deleting original text`, () => {
    const generated = run(fixture(protocol, 'ORIGINAL_SYSTEM'), protocol).body;
    const text = instructionText(generated, protocol);
    const originals = ['ORIGINAL_SYSTEM\nQuoted request:\n' + text, text + '\nquoted suffix', text.slice(0, -1)];
    for (const original of originals) {
      const next = run(fixture(protocol, original), protocol, 'NEW_PROMPT').body;
      assert(instructionText(next, protocol).includes(original), 'unverified original text was deleted');
    }
  });
}

for (const protocol of ['chat', 'responses']) test(`${protocol}: empty instruction messages and metadata survive replacement`, () => {
  const body = fixture(protocol, 'ORIGINAL_SYSTEM');
  const key = protocol === 'chat' ? 'messages' : 'input';
  const empties = [{type: 'message', role: 'system', content: '', id: 'empty_string', metadata: {keep: 'string'}},
    {type: 'message', role: 'developer', content: [], id: 'empty_array', metadata: {keep: 'array'}},
    {type: 'message', role: 'system', content: null, id: 'null_content', metadata: {keep: 'null'}},
    {type: 'message', role: 'system', id: 'absent_content', metadata: {keep: 'absent'}}];
  body[key].unshift(...empties);
  if (protocol === 'chat') body[key].push({role: 'developer', content: 'ORIGINAL_DEVELOPER'});
  let next = run(body, protocol).body;
  next = run(next, protocol, 'NEW_PROMPT').body;
  for (const empty of empties) assert.deepEqual(next[key].find(item => item.id === empty.id), empty);
});

test('Gemini preserves empty system parts and metadata instead of dropping them', () => {
  const body = fixture('gemini', 'ORIGINAL_SYSTEM');
  const part = {text: '', audit_metadata: 'EMPTY_METADATA'};
  body.systemInstruction.parts.unshift(part);
  let next = run(body, 'gemini').body;
  next = run(next, 'gemini', 'NEW_PROMPT').body;
  assert.deepEqual(next.systemInstruction.parts[0], part);
});

test('changing Chat roles removes only generated messages; original empty containers survive', () => {
  const body = {model, messages: [{role: 'system', content: ''}, {role: 'user', content: 'QUESTION'}]};
  let next = run(body, 'chat', 'FIRST', 'developer').body;
  next = run(next, 'chat', 'SECOND', 'system').body;
  assert.equal(next.messages.filter(item => item.role === 'developer').length, 0);
  next = run(next, 'chat', 'THIRD', 'developer').body;
  assert.deepEqual(next.messages.find(item => item.role === 'system'), body.messages[0]);
  assert.equal(next.messages.length, 3);
});

test('managed suffix validation retains malformed, relocated and modified original text', () => {
  for (let n = 0; n < 64; n++) {
    const original = ('原文🙂 e\u0301\r\n ' + START + '\n').repeat(n);
    const prompt = 'PROMPT_' + n + '\n保持内容';
    const encoded = appendManagedText(original, prompt);
    assert.deepEqual(readManagedText(encoded), {original, prompt, kind: 'text'});
    const altered = [encoded + '\n', 'X' + encoded, encoded.replace('PROMPT_', 'prompt_'),
      encoded.replace('KUPADESK:MANAGED:1:', 'KUPADESK:MANAGED:2:'), encoded.slice(0, -1)];
    if (original) altered.push('X' + encoded.slice(1));
    for (const text of altered) assert.equal(readManagedText(text), null);
  }
});

test('metadata added to a managed part or message survives prompt replacement', () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const first = run(fixture(protocol, 'ORIGINAL_SYSTEM'), protocol).body;
    if (protocol === 'chat') first.messages[0].metadata = {keep: 'message'};
    if (protocol === 'anthropic') first.system.at(-1).cache_control = {type: 'ephemeral'};
    if (protocol === 'gemini') first.systemInstruction.parts.at(-1).audit_metadata = 'keep-part';
    const next = run(first, protocol, 'NEW_PROMPT').body;
    if (protocol === 'chat') assert.deepEqual(next.messages[0].metadata, {keep: 'message'});
    if (protocol === 'anthropic') assert.deepEqual(next.system[1], {type: 'text', text: '', cache_control: {type: 'ephemeral'}});
    if (protocol === 'gemini') assert.deepEqual(next.systemInstruction.parts[1], {text: '', audit_metadata: 'keep-part'});
  }
});
