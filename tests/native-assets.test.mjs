import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startNativeAssets } from '../native-assets.mjs';

const BASENAMES = ['style.css', 'app.js', 'model-catalog.js', 'icon.svg', 'bridge.js']
  .map((name) => `kupadesk-native-003-${name}`);
const token = 'a'.repeat(32);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await fn()) return; await wait(25); }
  assert.fail('listener ownership did not recover');
}
async function fixture(t) {
  // Every generated file stays in the task's data-drive test directory.
  const parent = new URL('./.native-assets-fixtures/', import.meta.url);
  await fs.mkdir(parent, { recursive: true });
  const packageDir = await fs.mkdtemp(path.join(fileURLToPath(parent), 'run-'));
  const pageDir = path.join(packageDir, 'page');
  await fs.mkdir(pageDir);
  const template = '<!doctype html><script src="kupadesk-native-003-app.js?kupaAsset=__KUPADESK_ASSET_NONCE__"></script>';
  await fs.writeFile(path.join(pageDir, 'index.template.html'), template);
  await fs.writeFile(path.join(pageDir, 'provider.template.html'), template);
  await fs.writeFile(path.join(pageDir, 'index.html'), 'UNCHANGED');
  for (const name of BASENAMES) await fs.writeFile(path.join(pageDir, name), `fixture:${name}`);
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.stop();
    const resolved = path.resolve(packageDir);
    const expectedRoot = path.resolve(fileURLToPath(parent)) + path.sep;
    if (!resolved.startsWith(expectedRoot)) throw new Error('unexpected fixture cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { packageDir, pageDir, handles, async start(options = {}) {
    const handle = await startNativeAssets({ packageDir, platform: 'win32', port: 0, ownerCheckMs: 80,
      healthTimeoutMs: 100, ...options });
    handles.push(handle); return handle;
  }, key: () => fs.readFile(path.join(packageDir, '.native-assets-key'), 'utf8') };
}
function get(port, target, { method = 'GET', host = 'wails.localhost', address = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: address, port, path: target, method,
      headers: { Host: host, Connection: 'close', ...headers }, timeout: 1500,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject); request.end();
  });
}
const assetPath = (key, name = BASENAMES[1]) => `/_magpie/plugin/${token}/${name}?kupaAsset=${key}`;

test('Windows listener serves only nonce-protected namespaced assets on both loopback families', async (t) => {
  const f = await fixture(t);
  const handle = await f.start();
  assert.equal(handle.ok, true);
  assert.equal(handle.mode, 'started');
  const key = await f.key();
  assert.match(key, /^[a-f0-9]{64}$/u);
  for (const address of handle.hosts) {
    for (const name of BASENAMES) {
      const response = await get(handle.port, assetPath(key, name), { address });
      assert.equal(response.status, 200);
      assert.equal(response.body, `fixture:${name}`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  const head = await get(handle.port, assetPath(key), { method: 'HEAD', host: 'wails.localhost:80' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), `fixture:${BASENAMES[1]}`.length);
  assert.equal((await get(handle.port, `${assetPath(key, BASENAMES[2])}&fresh=${Date.now()}`)).status, 200);
  const html = await fs.readFile(path.join(f.pageDir, 'index.html'), 'utf8');
  assert.equal(html.includes('__KUPADESK_ASSET_NONCE__'), false);
  assert.equal(html.includes(key), true);
  assert.equal((await fs.readFile(path.join(f.pageDir, 'provider.html'),'utf8')).includes(key),true);
});

test('wrong Host, nonce, method and non-allowlisted or normalized paths never expose files', async (t) => {
  const f = await fixture(t);
  const handle = await f.start();
  assert.equal(handle.ok, true);
  const key = await f.key();
  for (const target of [assetPath(randomBytes(32).toString('hex')), assetPath(key).replace(/\?.*$/u, ''),
    `${assetPath(key)}&extra=1`, `${assetPath(key)}&kupaAsset=${key}`,
    `${assetPath(key)}&fresh=123`, `${assetPath(key, BASENAMES[2])}&fresh=invalid`,
    `${assetPath(key, BASENAMES[2])}&fresh=123&fresh=456`,
    `${assetPath(key, BASENAMES[2])}&fresh=${'1'.repeat(17)}`,
    `/_magpie/plugin/${token}/index.html?kupaAsset=${key}`, '/api/providers', '/',
    `/_magpie/plugin/${token}/../${token}/${BASENAMES[1]}?kupaAsset=${key}`,
    `/_magpie/plugin/${token}/%2e%2e/${token}/${BASENAMES[1]}?kupaAsset=${key}`,
    `/_magpie/plugin/${token}/app.js?kupaAsset=${key}`,
    `http://wails.localhost/_magpie/plugin/${token}/${BASENAMES[1]}?kupaAsset=${key}`]) {
    assert.equal((await get(handle.port, target)).status, 404);
  }
  for (const host of ['127.0.0.1', 'localhost', 'wails.localhost.evil', 'wails.localhost:81']) {
    assert.equal((await get(handle.port, assetPath(key), { host })).status, 404);
  }
  assert.equal((await get(handle.port, assetPath(key), { method: 'POST' })).status, 405);
  assert.equal((await get(handle.port, assetPath(key), { headers: { Origin: 'https://other.example' } })).status, 404);
  assert.equal((await get(handle.port, assetPath(key), { headers: { Origin: 'null' } })).status, 200);
});

test('same-directory process reuses authenticated owner then takes ownership after old owner stops', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  assert.equal(first.ok, true);
  const before = await f.key();
  const second = await f.start({ port: first.port });
  assert.equal(second.ok, true);
  assert.equal(second.mode, 'reused');
  assert.equal(await f.key(), before);
  await first.stop();
  await until(async () => {
    try { return (await get(second.port, assetPath(before))).status === 200; } catch { return false; }
  });
  assert.equal((await get(second.port, assetPath(before))).body, `fixture:${BASENAMES[1]}`);
  for (const address of second.hosts) {
    await until(async () => {
      try { return (await get(second.port, assetPath(before), { address })).status === 200; } catch { return false; }
    });
  }
});

test('stopping a reuser cannot close another process owner and does not subsequently claim its port', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start({ port: first.port });
  assert.equal(second.mode, 'reused');
  await second.stop();
  assert.equal((await get(first.port, assetPath(await f.key()))).status, 200);
  await first.stop();
  await wait(160);
  await assert.rejects(get(first.port, assetPath(await f.key())));
});

test('unknown occupied port receives only a random challenge and keeps original HTML untouched', async (t) => {
  const f = await fixture(t);
  const paths = [];
  const occupied = http.createServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ protocol: 1, proof: '0'.repeat(64) }));
  });
  await new Promise((resolve) => occupied.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const messages = [];
  const handle = await f.start({ port: occupied.address().port, log: (code) => messages.push(code) });
  assert.equal(handle.ok, false);
  assert.equal(handle.code, 'native_assets_port_in_use');
  const key = await f.key();
  assert.equal(paths.length, 1);
  assert.equal(paths[0].includes(key), false);
  assert.match(paths[0], /^\/_magpie\/kupadesk-native-003\/health\?challenge=[a-f0-9]{64}$/u);
  assert.deepEqual(messages, ['native_assets_port_in_use']);
  assert.equal((await fs.readFile(path.join(f.pageDir, 'index.html'), 'utf8')), 'UNCHANGED');
});

test('different installation cannot authenticate owner, and non-Windows creates neither key nor listener', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const owner = await f.start();
  const rejected = await other.start({ port: owner.port });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'native_assets_port_in_use');
  assert.equal(await fs.readFile(path.join(other.pageDir, 'index.html'), 'utf8'), 'UNCHANGED');
  const skipped = await startNativeAssets({ packageDir: 'does-not-exist', platform: 'darwin', port: owner.port });
  assert.equal(skipped.mode, 'skipped');
  assert.equal((await get(owner.port, assetPath(await f.key()))).status, 200);
});
