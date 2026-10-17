import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {buildRequestIndex, writeRequestIndex} from './request-index.mjs';
import {injectionDiagnostics} from './diagnostics.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 50000;
const DEFAULT_INTERVAL = 10000;
const HEARTBEAT_INTERVAL = 30000;
const active = new Map();
const CODES = new Set(['gateway_unavailable', 'gateway_timeout', 'gateway_http_error',
  'catalog_invalid', 'catalog_too_large', 'catalog_incomplete', 'gateway_address_invalid',
  'settings_unreadable']);

function failure(code) { return Object.assign(new Error(code), { catalogCode: code }); }
function text(value, limit = 512) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim() : '';
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Discover only this host's local listener. Never use PluginInput.serverUrl:
// the OpenCode compatibility host gives it a fixed, unrelated port.
export function gatewayURL(env = {}, settings = {}) {
  const override = text(env.MAGPIE_ADDR);
  let port;
  if (override) {
    let address;
    try { address = new URL(override.includes('://') ? override : `http://${override}`); }
    catch { throw failure('gateway_address_invalid'); }
    if (address.protocol !== 'http:' || address.username || address.password ||
        address.pathname !== '/' || address.search || address.hash ||
        !['127.0.0.1', 'localhost', '0.0.0.0', '[::]', '[::1]'].includes(address.hostname.toLowerCase())) {
      throw failure('gateway_address_invalid');
    }
    port = Number(address.port || 80);
  } else {
    port = settings.port === undefined || settings.port === 0 ? 3425 : settings.port;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw failure('gateway_address_invalid');
  return `http://127.0.0.1:${port}/v1/models`;
}

async function readJSON(file, optional = false) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) throw failure('catalog_too_large');
    const raw = await fs.readFile(file);
    if (raw.byteLength > MAX_BYTES) throw failure('catalog_too_large');
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    if (error.catalogCode) throw error;
    throw failure('settings_unreadable');
  }
}

async function providerMetadata(directory) {
  const configured = new Map();
  const cached = new Map();
  const data = await readJSON(path.join(directory, 'providers.json'), true);
  if (data !== undefined && (!object(data) || !Array.isArray(data.providers))) throw failure('settings_unreadable');
  for (const row of data?.providers ?? []) {
    const id = text(row?.id);
    if (id && row.off !== true) configured.set(id, text(row.name) || id);
  }
  const plugins = await readJSON(path.join(directory, 'plugin-providers.json'), true);
  if (plugins !== undefined && !Array.isArray(plugins)) throw failure('settings_unreadable');
  for (const row of plugins ?? []) {
    const id = text(row?.id);
    if (id) cached.set(id, text(row.name) || id);
  }
  return { configured, cached, providerRows: data?.providers ?? [], groupRows: data?.groups ?? [] };
}

export function normalizeCatalog(payload, metadata = {}) {
  if (!object(payload) || !Array.isArray(payload.data)) throw failure('catalog_invalid');
  if (payload.has_more === true) throw failure('catalog_incomplete');
  if (payload.data.length > MAX_MODELS) throw failure('catalog_too_large');
  const { configured = new Map(), cached = new Map() } = metadata;
  const providers = new Map(configured);
  const models = new Map();
  for (const row of payload.data) {
    const id = text(row?.id, 2048);
    if (!id) throw failure('catalog_invalid');
    // Full gateway IDs are the binding identity; owned_by may name the
    // upstream model author rather than the configured Magpie supplier.
    const provider = (id.includes('/') ? id.split('/')[0] : '') || text(row.owned_by) || 'other';
    const providerName = configured.get(provider) || cached.get(provider) || provider;
    const name = text(row.display_name) || text(row.name) || id;
    models.set(id, { id, name, provider, providerName });
    providers.set(provider, providerName);
  }
  return {
    providers: [...providers].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function readModels(url, fetchImpl, signal) {
  // Bun accepts proxy:''; host.js also honors this explicit property before
  // applying global proxy settings. Node ignores the Bun extension.
  const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' },
    redirect: 'error', cache: 'no-store', proxy: '', signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failure('gateway_http_error');
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('catalog_too_large');
  }
  if (!response.body) throw failure('catalog_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw failure('catalog_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw failure('catalog_invalid'); }
}

function revision(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

export async function writeCatalog(file, value) {
  const temporary = path.join(path.dirname(file), `.model-catalog.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const json = JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  try {
    await fs.writeFile(temporary, `// Local display metadata only. No credentials or provider addresses.\nwindow.KUPADESK_MODEL_CATALOG = ${json};\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function previousCatalog(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) return undefined;
    const source = await fs.readFile(file, 'utf8');
    const match = source.match(/window\.KUPADESK_MODEL_CATALOG\s*=\s*([\s\S]*);\s*$/u);
    const saved = match && JSON.parse(match[1]);
    if (saved?.mode !== 'automatic' || typeof saved.importedAt !== 'string' || !saved.importedAt) return undefined;
    const configured = new Map((saved.providers ?? []).map((p) => [text(p?.id), text(p?.name)]).filter(([id]) => id));
    const clean = normalizeCatalog({ data: (saved.models ?? []).map((m) => ({ id: m.id, name: m.name, owned_by: m.provider })) }, { configured });
    return { ...clean, importedAt: saved.importedAt };
  } catch { return undefined; }
}

// Returning immediately is essential: GET /v1/models may itself need the Bun
// host to have completed plugin initialization before it can list providers.
export function startCatalogSync({ directory, packageDir, options = {}, env = process.env,
  fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof directory !== 'string' || !directory || typeof packageDir !== 'string' || !packageDir) {
    throw failure('settings_unreadable');
  }
  const key = `${path.resolve(directory)}\0${path.resolve(packageDir)}`;
  if (active.has(key)) return active.get(key);
  const settings = object(options.catalogSync) ? options.catalogSync : {};
  const interval = Math.max(2000, Math.min(300000,
    Number.isFinite(settings.intervalMs) ? settings.intervalMs : DEFAULT_INTERVAL));
  const timeout = Math.max(1000, Math.min(30000,
    Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 6000));
  const file = path.join(packageDir, 'page', 'kupadesk-native-003-model-catalog.js');
  let stopped = false;
  let timer;
  let inFlight;
  let controller;
  let last;
  let loaded = false;
  let lastWrite = 0;
  let published = '';
  let writeFailed = false;

  async function perform() {
    if (!loaded) { last = await previousCatalog(file); loaded = true; }
    if (stopped) return;
    const checkedAt = new Date(now()).toISOString();
    let status = 'ready';
    let errorCode;
    let deadline;
    try {
      const savedSettings = await readJSON(path.join(directory, 'settings.json'), true) ?? {};
      if (!object(savedSettings)) throw failure('settings_unreadable');
      const url = gatewayURL(env, savedSettings);
      const names = await providerMetadata(directory);
      if (stopped) return;
      controller = new AbortController();
      deadline = setTimeout(() => controller.abort(), timeout);
      deadline.unref?.();
      const payload = await readModels(url, fetchImpl, controller.signal);
      const clean = normalizeCatalog(payload, names);
      await writeRequestIndex(packageDir, buildRequestIndex(clean, names));
      last = { ...clean, importedAt: checkedAt };
    } catch (error) {
      if (stopped) return;
      status = last ? 'stale' : 'waiting';
      errorCode = CODES.has(error.catalogCode) ? error.catalogCode : controller?.signal.aborted ? 'gateway_timeout' : 'gateway_unavailable';
    } finally {
      clearTimeout(deadline);
      controller = undefined;
    }
    if (stopped) return;
    const content = { providers: last?.providers ?? [], models: last?.models ?? [] };
    const hash = revision(content);
    const injection = injectionDiagnostics();
    const signature = `${hash}:${status}:${errorCode ?? ''}:${JSON.stringify(injection)}`;
    if (signature === published && now() - lastWrite < HEARTBEAT_INTERVAL) return;
    const value = { schemaVersion: 1, mode: 'automatic', status, checkedAt,
      importedAt: last?.importedAt ?? '', revision: hash, source: '当前 Magpie', ...content, injection,
      ...(errorCode ? { errorCode } : {}) };
    try {
      await writeCatalog(file, value);
      published = signature;
      lastWrite = now();
      writeFailed = false;
    } catch {
      if (!writeFailed) {
        writeFailed = true;
        try { log('catalog_write_failed'); } catch {}
      }
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = perform().catch(() => {
      try { log('catalog_sync_failed'); } catch {}
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  async function tick() {
    await refresh();
    if (stopped) return;
    timer = setTimeout(tick, interval);
    timer.unref?.();
  }
  const handle = {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      active.delete(key);
      return inFlight ?? Promise.resolve();
    },
  };
  active.set(key, handle);
  timer = setTimeout(tick, 0);
  timer.unref?.();
  return handle;
}

export async function stopCatalogSync(directory, packageDir) {
  const key = `${path.resolve(directory)}\0${path.resolve(packageDir)}`;
  await active.get(key)?.stop();
}
