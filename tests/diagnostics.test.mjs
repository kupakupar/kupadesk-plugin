import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDiagnostics} from '../diagnostics.mjs';
import {startDiagnosticsLedger} from '../diagnostics-ledger.mjs';
import {onRequest as inject} from '../kupadesk.middleware.js';
import {onRequest as hooked, onResponse} from '../kupadesk.hooks.mjs';

const now = Date.now();
const prompt = 'PRIVATE_PROMPT_测试';
const options = {schemaVersion: 1, enabled: true, bindings: [
  {id: 'a', name: 'Alpha', prompt, models: ['one/a'], chatRole: 'auto'},
  {id: 'b', name: 'Beta', prompt: 'SECOND_PRIVATE_PROMPT', models: ['two/b'], chatRole: 'system'}]};
const ctx = (model = 'one/a', protocol = 'chat') => ({model, protocol, agent: 'dsh', session: 'PRIVATE_SESSION', options, state: {}});
const body = () => ({model: 'one/a', messages: [{role: 'system', content: 'ORIGINAL'},
  {role: 'user', content: 'PRIVATE_USER'}], tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
  tool_choice: 'auto', stream: true});
function record(d, c = ctx(), raw = body()) {
  const result = inject(raw, c) || raw;
  d.record(c.state.kupadeskOutcome, {ctx: c});
  return {c, result};
}
const row = (id, extra = {}) => ({response_id: id, provider: 'actual', model: 'vendor-model', req: 'one/a',
  agent: 'dsh', session: 'PRIVATE_SESSION', t: new Date(now).toISOString(), route_id: 1, status: 200,
  host: 'PRIVATE_ENDPOINT', providerAccount: 'PRIVATE_ACCOUNT', callerKeyName: 'PRIVATE_KEY', err: 'PRIVATE_ERROR', ...extra});

test('reply ID, never timing alone, joins concurrent requests completed out of order', () => {
  const d = createDiagnostics({now: () => now});
  const a = record(d), b = record(d, ctx('two/b'), {...body(), model: 'two/b'});
  d.complete({id: 'b'}, {...b.c, request: b.result, success: true});
  d.ingest([row('b', {req: 'two/b', route_id: 2, provider: 'two', model: 'b'})]);
  d.complete({id: 'a'}, {...a.c, request: a.result, success: true});
  d.ingest([row('a', {provider: 'one', model: 'a'})]);
  const rows = d.snapshot().recent;
  assert.equal(rows[0].binding.name, 'Beta');
  assert.equal(rows[0].route.provider, 'two');
  assert.equal(rows[1].route.provider, 'one');
  assert.equal(rows[0].accepted, 'present');
  assert.equal(rows[1].accepted, 'present');
  const publicJSON = JSON.stringify(d.snapshot());
  for (const secret of [prompt, 'PRIVATE_USER', 'PRIVATE_SESSION', 'PRIVATE_ACCOUNT', 'PRIVATE_KEY', 'PRIVATE_ENDPOINT', 'PRIVATE_ERROR'])
    assert.equal(publicJSON.includes(secret), false, secret);
});

test('duplicates, reused reply IDs and conflicting provider evidence stay ambiguous', () => {
  const d = createDiagnostics({now: () => now});
  const a = record(d);
  d.complete({id: 'same'}, {...a.c, request: a.result, success: true});
  d.ingest([row('same'), row('same')]);
  assert.equal(d.snapshot().last.route.state, 'matched', 'repeated identical ledger rows are harmless');
  d.ingest([row('same', {route_id: 2})]);
  assert.equal(d.snapshot().last.route.state, 'ambiguous');
  const d2 = createDiagnostics({now: () => now});
  const x = record(d2), y = record(d2);
  d2.complete({id: 'reused'}, {...x.c, request: x.result});
  d2.complete({id: 'reused'}, {...y.c, request: y.result});
  d2.ingest([row('reused')]);
  assert.ok(d2.snapshot().recent.every(e => e.route.state === 'ambiguous' && !e.route.provider));
  const d3 = createDiagnostics({now: () => now});
  const z = record(d3);
  d3.complete({id: 'conflict'}, {...z.c, request: z.result});
  d3.ingest([row('conflict'), row('conflict', {provider: 'other'})]);
  assert.equal(d3.snapshot().last.route.state, 'ambiguous');
});

test('missing callbacks, missing ledger and missing IDs never claim upstream success', () => {
  let time = now;
  const d = createDiagnostics({now: () => time});
  const a = record(d);
  assert.equal(d.snapshot().last.accepted, 'pending');
  d.complete(null, {...a.c, success: false});
  assert.equal(d.snapshot().last.route.state, 'no-response-id');
  const b = record(d);
  d.complete({id: 'later'}, {...b.c, request: b.result, success: true});
  d.ingest([], 'missing');
  assert.equal(d.snapshot().last.route.state, 'missing');
  d.ingest([], 'ready'); time += 31000;
  assert.equal(d.snapshot().last.route.state, 'unconfirmed');
  d.ingest([row('later')]);
  assert.equal(d.snapshot().last.route.state, 'matched');
});

test('accepted body verification covers four protocols and rejects altered or duplicate blocks', () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const d = createDiagnostics({now: () => now}), c = ctx('one/a', protocol);
    const raw = {chat: body(), responses: {model: 'one/a', instructions: 'ORIGINAL', input: 'PRIVATE_USER'},
      anthropic: {model: 'one/a', system: 'ORIGINAL', messages: []},
      gemini: {systemInstruction: {parts: [{text: 'ORIGINAL'}]}, contents: []}}[protocol];
    const a = record(d, c, raw);
    d.complete({id: 'ok'}, {...c, request: a.result, success: true});
    assert.equal(d.snapshot().last.accepted, 'present', protocol);
  }
  for (const raw of [body(), {...body(), messages: [{role: 'user', content: '<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->\n' + prompt + '\n<!-- KUPADESK-NATIVE-PAGE-TEST:END -->'}]}]) {
    const d = createDiagnostics({now: () => now}), a = record(d);
    d.complete({id: 'missing'}, {...a.c, request: raw});
    assert.equal(d.snapshot().last.accepted, 'missing');
  }
  const duplicate = createDiagnostics({now: () => now}), a = record(duplicate);
  const duplicateBody = structuredClone(a.result);
  duplicateBody.messages.unshift(structuredClone(duplicateBody.messages[0]));
  duplicate.complete({id: 'duplicate'}, {...a.c, request: duplicateBody});
  assert.equal(duplicate.snapshot().last.accepted, 'missing');
});

test('unrelated computers, non-gateway records, model/session/agent mismatches are not attributed', () => {
  for (const extra of [{req: 'different'}, {agent: 'different'}, {session: 'different'}]) {
    const d = createDiagnostics({now: () => now}), a = record(d);
    d.complete({id: 'a'}, {...a.c, request: a.result});
    d.ingest([row('a', extra)]);
    assert.equal(d.snapshot().last.route.state, 'mismatch');
  }
  for (const extra of [{computer: 'remote'}, {source: 'reported'}, {operation: 'title'}]) {
    const d = createDiagnostics({now: () => now}), a = record(d);
    d.complete({id: 'a'}, {...a.c, request: a.result}); d.ingest([row('a', extra)]);
    assert.equal(d.snapshot().last.route.state, 'waiting');
  }
});

test('new hook preserves 009 request output, tools, original instructions and error behavior', async () => {
  for (const c of [ctx(), {...ctx(), options: {...options, enabled: false}}, ctx('unbound/x')]) {
    const original = body(), before = structuredClone(original), expectedCtx = {...c, state: {}};
    const expected = inject(original, expectedCtx);
    const actual = await hooked(original, c);
    assert.deepEqual(actual, expected);
    assert.deepEqual(original, before);
    assert.deepEqual((actual || original).tools, before.tools);
    assert.equal((actual || original).model, before.model);
    assert.equal((actual || original).stream, true);
    const reply = {id: 'tool-reply', choices: [{message: {tool_calls: [{function: {name: 'read_file', arguments: '{}'}}]}}]};
    const savedReply = structuredClone(reply);
    assert.equal(onResponse(reply, {...c, request: actual || original, success: true}), undefined);
    assert.deepEqual(reply, savedReply);
  }
  await assert.rejects(hooked(body(), {...ctx(), options: {...options, schemaVersion: 99}}),
    /KupaDesk prompt binding validation failed/);
});

test('ledger reader handles missing files, partial lines, malformed lines, UTF-8 and truncation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kupa-diagnostic-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const messages = [], reader = startDiagnosticsLedger({directory, interval: 60000,
    publish: (rows, status) => messages.push({rows, status})});
  t.after(() => reader.stop());
  await reader.refresh(); assert.equal(messages.at(-1).status, 'missing');
  const file = path.join(directory, 'usage.jsonl'), raw = Buffer.from(JSON.stringify(row('utf', {provider: '测试供应商'})) + '\n');
  const split = raw.indexOf(Buffer.from('测试')) + 1;
  await fs.writeFile(file, raw.subarray(0, split)); await reader.refresh();
  assert.equal(messages.at(-1).rows.length, 0);
  await fs.appendFile(file, raw.subarray(split)); await reader.refresh();
  assert.equal(messages.at(-1).rows[0].provider, '测试供应商');
  await fs.appendFile(file, 'malformed\n' + JSON.stringify(row('next')) + '\n'); await reader.refresh();
  assert.equal(messages.at(-1).rows.length, 1);
  await fs.writeFile(file, '{}\n'); await reader.refresh();
  assert.deepEqual(messages.at(-1).rows, [{}]);
  await reader.stop();
  const count = messages.length;
  await reader.refresh(); assert.equal(messages.length, count);
});

test('retained diagnostics are bounded, snapshots cannot mutate records, no I/O is needed to inject', () => {
  const d = createDiagnostics({now: () => now, limit: 3});
  for (let i = 0; i < 15; i++) record(d);
  const snap = d.snapshot(); assert.equal(snap.recent.length, 3);
  snap.last.binding.name = 'changed';
  assert.equal(d.snapshot().last.binding.name, 'Alpha');
});
