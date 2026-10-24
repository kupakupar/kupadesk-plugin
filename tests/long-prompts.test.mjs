import {test, expect} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCipheriv, createHash, pbkdf2Sync} from 'node:crypto';
import {onRequest} from '../kupadesk.middleware.js';
import {readManagedText, appendManagedText, cleanManagedText} from '../managed-prompt.js';
import {snapshotRequest, compareRequests} from '../request-check.mjs';
import {mergeSettings, SettingsSync} from '../settings-sync.mjs';

const binding = prompt => ({id: 'long', name: 'Long prompt', enabled: true, models: ['fixture/model'], prompt});
const options = prompt => ({schemaVersion: 1, enabled: true, bindings: [binding(prompt)]});
const tools = [{type: 'function', name: 'fixture_read', parameters: {type: 'object'}}];
const fixtures = {
  chat: {messages: [{role: 'system', content: 'ORIGINAL'}, {role: 'user', content: 'QUESTION'},
    {role: 'assistant', content: 'PROGRESS', reasoning_content: 'THOUGHT'},
    {role: 'tool', tool_call_id: 'call_1', content: 'RESULT'}], tools, reasoning_effort: 'high'},
  responses: {instructions: 'ORIGINAL', input: [{type: 'additional_tools', role: 'developer', tools},
    {role: 'user', content: 'QUESTION'}, {type: 'reasoning', encrypted_content: 'SEALED'},
    {type: 'function_call_output', call_id: 'call_1', output: 'RESULT'}], reasoning: {effort: 'high'}},
  anthropic: {system: [{type: 'text', text: 'ORIGINAL', cache_control: {type: 'ephemeral'}}],
    messages: [{role: 'assistant', content: [{type: 'thinking', thinking: 'THOUGHT', signature: 'SIG'}]},
      {role: 'user', content: 'QUESTION'}], tools, thinking: {type: 'enabled', budget_tokens: 4096}},
  gemini: {systemInstruction: {parts: [{text: 'ORIGINAL'}]},
    contents: [{role: 'model', parts: [{text: 'THOUGHT', thought: true, thoughtSignature: 'SIG'}]}],
    tools: [{functionDeclarations: tools}], generationConfig: {thinkingConfig: {thinkingBudget: 4096}}},
};

for (const prompt of ['x'.repeat(32769), '中文😀\n'.repeat(40001), 'x'.repeat(2 * 1024 * 1024)]) {
  test(`managed suffix round trip beyond old character limit (${prompt.length})`, () => {
    const original = 'ORIGINAL_SYSTEM\nUnrelated quoted text';
    const text = appendManagedText(original, prompt);
    const read = readManagedText(text);
    expect(read).not.toBeNull();
    expect(read.original === original && read.prompt === prompt && read.kind === 'text').toBe(true);
    expect(cleanManagedText(text)).toBe(original);
    expect(readManagedText(text.replace('ORIGINAL_SYSTEM', 'CHANGED_SYSTEM'))).toBeNull();
  });
}

for (const [protocol, fixture] of Object.entries(fixtures)) {
  test(`${protocol}: long injection, retry and replacement preserve protected request fields`, () => {
    const body = {model: 'fixture/model', ...structuredClone(fixture)}, saved = structuredClone(body);
    const before = snapshotRequest(body, protocol);
    const prompt = '中文😀\n'.repeat(25001);
    const run = (value, text) => onRequest(value, {model: body.model, protocol, options: options(text), state: {},
      reject(status, message) {throw Error(`${status}: ${message}`);}}) || value;
    const first = run(body, prompt);
    expect(JSON.stringify(first).includes(JSON.stringify(prompt.slice(0, 100)).slice(1, -1))).toBe(true);
    expect(body).toEqual(saved);
    expect(Object.values(compareRequests(before, snapshotRequest(first, protocol, before.shapes))).every(c => c.state === 'same')).toBe(true);
    expect(run(first, prompt)).toBe(first);
    const next = run(first, 'REPLACEMENT\n' + prompt);
    expect(Object.values(compareRequests(before, snapshotRequest(next, protocol, before.shapes))).every(c => c.state === 'same')).toBe(true);
    const serialized = JSON.stringify(next);
    expect(serialized.split('KUPADESK:MANAGED:1:').length - 1).toBe(1);
  });
}

test('settings merge retains full conflict copies within the 64 KiB save budget', () => {
  const base = options('原文'.repeat(4000));
  const local = structuredClone(base), remote = structuredClone(base);
  local.bindings[0].prompt += 'LOCAL'; remote.bindings[0].prompt += 'REMOTE';
  const merged = mergeSettings(local, remote, base);
  expect(merged.options.bindings[0].prompt).toBe(local.bindings[0].prompt);
  expect(merged.options.bindings.find(b => b.enabled === false)?.prompt).toBe(remote.bindings[0].prompt);
  expect(mergeSettings(merged.options, remote, remote).options).toEqual(merged.options);
});

test('64 KiB budget includes the complete save envelope, UTF-8 and escaped characters', () => {
  const bytes = value => Buffer.byteLength(JSON.stringify({spec: 'github:kupakupar/kupadesk-plugin', options: value}));
  for (const delta of [-1, 0, 1]) {
    const value = options('中文😀\n"\\');
    value.bindings[0].prompt += 'x'.repeat(64 * 1024 + delta - bytes(value));
    expect(bytes(value)).toBe(64 * 1024 + delta);
    const saved = structuredClone(value);
    if (delta <= 0) expect(mergeSettings({}, value).options).toEqual(value);
    else expect(() => mergeSettings({}, value)).toThrow('settings_merge_too_large');
    expect(value).toEqual(saved);
  }
});

test('large settings survive the existing encrypted-cache sync and retain another plugin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kupa-long-sync-'));
  const sha = raw => createHash('sha256').update(raw).digest('hex');
  const config = {url: 'https://example.invalid/dav', user: 'fixture', passphrase: 'synthetic-pass'};
  const salt = Buffer.alloc(16, 1), nonce = Buffer.alloc(12, 2), iterations = 100000;
  const large = options('云端完整提示词😀\n'.repeat(2000));
  const bundle = {plugins: [{spec: 'github:kupakupar/kupadesk-plugin', options: large}]};
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(config.passphrase, salt, iterations, 32, 'sha256'), nonce);
  cipher.setAAD(Buffer.from(`magpie-backup/1/pbkdf2-sha256/${iterations}/${salt.toString('hex')}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final(), cipher.getAuthTag()]);
  const raw = Buffer.from(JSON.stringify({format: 'magpie-backup', version: 1, kdf: 'pbkdf2-sha256', iterations,
    salt: salt.toString('base64'), nonce: nonce.toString('base64'), data: data.toString('base64')}));
  const json = (name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value));
  try {
    const other = {spec: 'unrelated', options: {retain: true}};
    await json('sync.json', config);
    await json('sync-state.json', {key: sha(config.url + '\0' + config.user + '\0' + config.passphrase), sum: sha(raw)});
    await fs.writeFile(path.join(dir, 'sync-server.magpie-backup'), raw);
    await json('plugins.json', {plugins: [other, {spec: 'github:kupakupar/kupadesk-plugin', options: {schemaVersion: 1, bindings: []}}]});
    await new SettingsSync({directory: dir}).tick();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'plugins.json'), 'utf8'));
    expect(saved.plugins[0]).toEqual(other);
    expect(sha(JSON.stringify(saved.plugins[1].options))).toBe(sha(JSON.stringify(large)));
    expect(JSON.parse(await fs.readFile(path.join(dir, 'kupadesk-private-sync/status.json'), 'utf8')).code).toBe('synced');
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});
