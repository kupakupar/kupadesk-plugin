import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatewayURL, normalizeCatalog, startCatalogSync, stopCatalogSync, writeCatalog } from '../catalog-sync.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kupadesk-catalog-test-'));
  const directory = path.join(dir, 'config');
  const packageDir = path.join(dir, 'plugin');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(packageDir, 'page'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'kupadesk.middleware.js'), '// fixture');
  t.after(async () => {
    await stopCatalogSync(directory, packageDir);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = path.join(packageDir, 'page', 'kupadesk-native-003-model-catalog.js');
  return { directory, packageDir, file,
    async read() {
      const source = await fs.readFile(file, 'utf8');
      return JSON.parse(source.match(/window\.KUPADESK_MODEL_CATALOG\s*=\s*([\s\S]*);\s*$/u)[1]);
    },
    async save(name, data) { await fs.writeFile(path.join(directory, name), JSON.stringify(data)); },
  };
}
const result = (data, extras = {}) => new Response(JSON.stringify({ data, ...extras }), {
  headers: { 'Content-Type': 'application/json' },
});

test('gateway discovery uses this host, normalizes bind addresses and rejects remote targets', () => {
  assert.equal(gatewayURL({}, {}), 'http://127.0.0.1:3425/v1/models');
  assert.equal(gatewayURL({}, { port: 4594 }), 'http://127.0.0.1:4594/v1/models');
  for (const addr of ['localhost:4567', '0.0.0.0:4567', '[::]:4567', '[::1]:4567']) {
    assert.equal(gatewayURL({ MAGPIE_ADDR: addr }, { port: 4594 }), 'http://127.0.0.1:4567/v1/models');
  }
  for (const addr of ['example.com:3425', 'http://user:pass@127.0.0.1:3425', '127.0.0.1:3425/path',
    '127.0.0.1:3425?key=secret', 'https://127.0.0.1:3425', '127.0.0.1:80', '127.1.2.3:3425']) {
    assert.throws(() => gatewayURL({ MAGPIE_ADDR: addr }), /gateway_address_invalid/);
  }
  assert.throws(() => gatewayURL({}, { port: '4594' }), /gateway_address_invalid/);
});

test('normalization copies only display metadata and refuses partial or malformed lists', () => {
  const clean = normalizeCatalog({ data: [{ id: 'original/model', display_name: 'My model', owned_by: 'upstream-author',
    apiKey: 'DO-NOT-COPY', baseURL: 'https://private', token: 'DO-NOT-COPY' }] }, {
    configured: new Map([['original', 'Original provider']]),
  });
  assert.deepEqual(clean.models, [{ id: 'original/model', name: 'My model', provider: 'original', providerName: 'Original provider' }]);
  assert.equal(JSON.stringify(clean).includes('DO-NOT-COPY'), false);
  assert.equal(JSON.stringify(clean).includes('https://private'), false);
  assert.throws(() => normalizeCatalog({ data: [], has_more: true }), /catalog_incomplete/);
  assert.throws(() => normalizeCatalog({ data: [{ secret: 'broken' }] }), /catalog_invalid/);
});

test('sync is metadata only, adds and deletes empty configured providers, and removes empty successful models', async (t) => {
  const f = await fixture(t);
  await f.save('settings.json', { port: 4594, lanKey: 'NEVER-PUBLISH' });
  await f.save('providers.json', { providers: [
    { id: 'original', name: 'Original', key: 'NEVER-PUBLISH', url: 'https://private' },
    { id: 'empty', name: 'Empty' }, { id: 'disabled', name: 'Disabled', off: true },
  ] });
  await f.save('plugin-providers.json', [{ id: 'plug', name: 'Plugin supplier', accounts: [{ key: 'NEVER-PUBLISH' }] },
    { id: 'old', name: 'Stale cache' }]);
  let models = [{ id: 'original/a', owned_by: 'original', display_name: 'A' }, { id: 'plug/b', owned_by: 'plug', name: 'B' }];
  let calls = 0;
  const sync = startCatalogSync({ ...f, env: {}, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:4594/v1/models');
    assert.equal(init.proxy, '');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return result(models);
  } });
  assert.equal(calls, 0, 'startup must not await or start a gateway request synchronously');
  assert.equal(startCatalogSync({ ...f }), sync, 'same module must not create a duplicate timer');
  await sync.refresh();
  let saved = await f.read();
  assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.providers, [{ id: 'empty', name: 'Empty' }, { id: 'original', name: 'Original' }, { id: 'plug', name: 'Plugin supplier' }]);
  assert.equal(JSON.stringify(saved).includes('NEVER-PUBLISH'), false);
  assert.equal(JSON.stringify(saved).includes('https://private'), false);
  const original = saved.revision;
  models = [];
  await f.save('providers.json', { providers: [{ id: 'new-empty', name: 'New empty' }] });
  await sync.refresh();
  saved = await f.read();
  assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.models, []);
  assert.deepEqual(saved.providers, [{ id: 'new-empty', name: 'New empty' }]);
  assert.notEqual(saved.revision, original);
});

test('failures retain last success across retries and host restarts, then recover without stale errors', async (t) => {
  const f = await fixture(t);
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('secret upstream details MUST NOT APPEAR');
    return result([{ id: 'p/m', owned_by: 'p', name: 'M' }]);
  };
  let sync = startCatalogSync({ ...f, env: {}, fetchImpl });
  await sync.refresh();
  const good = await f.read();
  fail = true;
  await sync.refresh();
  let saved = await f.read();
  assert.equal(saved.status, 'stale');
  assert.equal(saved.errorCode, 'gateway_unavailable');
  assert.deepEqual(saved.models, good.models);
  assert.equal(saved.importedAt, good.importedAt);
  assert.equal(JSON.stringify(saved).includes('MUST NOT APPEAR'), false);
  await sync.stop();
  sync = startCatalogSync({ ...f, env: {}, fetchImpl });
  await sync.refresh();
  saved = await f.read();
  assert.equal(saved.status, 'stale');
  assert.deepEqual(saved.models, good.models);
  fail = false;
  await sync.refresh();
  saved = await f.read();
  assert.equal(saved.status, 'ready');
  assert.equal('errorCode' in saved, false);
});

test('first failure waits, partial or oversized catalogs are not treated as complete', async (t) => {
  const f = await fixture(t);
  let mode = 'partial';
  const sync = startCatalogSync({ ...f, env: {}, fetchImpl: async () => mode === 'partial'
    ? result([], { has_more: true })
    : new Response('tiny', { headers: { 'content-length': String(17 * 1024 * 1024) } }),
  });
  await sync.refresh();
  assert.equal((await f.read()).status, 'waiting');
  assert.equal((await f.read()).errorCode, 'catalog_incomplete');
  mode = 'oversized';
  await sync.refresh();
  assert.equal((await f.read()).errorCode, 'catalog_too_large');
});

test('unchanged refreshes avoid rewriting until heartbeat and catalog writes are atomic', async (t) => {
  const f = await fixture(t);
  let timestamp = Date.now();
  const sync = startCatalogSync({ ...f, env: {}, now: () => timestamp,
    fetchImpl: async () => result([{ id: 'p/m', name: '<M>\u2028', owned_by: 'p' }]),
  });
  await sync.refresh();
  const original = await fs.readFile(f.file, 'utf8');
  timestamp += 10000;
  await sync.refresh();
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  timestamp += 21000;
  await sync.refresh();
  assert.notEqual(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter((s) => s.endsWith('.tmp')), []);
  await writeCatalog(f.file, { schemaVersion: 1, source: '</script>' });
  assert.equal((await fs.readFile(f.file, 'utf8')).includes('</script>'), false);
  assert.equal((await f.read()).source, '</script>');
});

test('plugin initialization returns without making or waiting for a model request', async (t) => {
  const f = await fixture(t);
  const sourceDir = fileURLToPath(new URL('../', import.meta.url));
  // Exercise the real entry point and catalog scheduler without opening the
  // production asset port or generating an index in the source package.
  for (const name of ['index.mjs', 'catalog-sync.mjs', 'request-index.mjs', 'diagnostics.mjs', 'request-check.mjs', 'diagnostics-ledger.mjs', 'model-match.js', 'managed-prompt.js', 'settings-sync.mjs']) {
    await fs.copyFile(path.join(sourceDir, name), path.join(f.packageDir, name));
  }
  await fs.writeFile(path.join(f.packageDir, 'native-assets.mjs'),
    "export async function startNativeAssets() { return { ok: true, mode: 'skipped' }; }\n");
  const { default: plugin } = await import(pathToFileURL(path.join(f.packageDir, 'index.mjs')).href);
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not run before return'); };
  try {
    assert.deepEqual(await plugin({ directory: f.directory }), {});
    assert.equal(calls, 0);
  } finally {
    // The copied module has its own module-local timer registry.
    const copiedCatalog = await import(pathToFileURL(path.join(f.packageDir, 'catalog-sync.mjs')).href);
    await copiedCatalog.stopCatalogSync(f.directory, f.packageDir);
    globalThis.fetch = before;
  }
});
