import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

// WebView2's legacy resource filter misses opaque-origin iframe subresources.
// The HTML, its token, sandbox and policy still come from Magpie. This listener
// supplies only this package's five namespaced static files on loopback.
const HOSTS = ['127.0.0.1', '::1'];
const HEALTH_PATH = '/_magpie/kupadesk-native-003/health';
const MARKER = '__KUPADESK_ASSET_NONCE__';
const MAX_ASSET = 16 * 1024 * 1024;
const ASSETS = new Map([
  ['kupadesk-native-003-style.css', 'text/css; charset=utf-8'],
  ['kupadesk-native-003-app.js', 'text/javascript; charset=utf-8'],
  ['kupadesk-native-003-model-catalog.js', 'text/javascript; charset=utf-8'],
  ['kupadesk-native-003-icon.svg', 'image/svg+xml'],
  ['kupadesk-native-003-bridge.js', 'text/javascript; charset=utf-8'],
]);
const noop = async () => {};

function failure(code) { return Object.assign(new Error(code), { nativeAssetsCode: code }); }
function emit(log, code) { try { log(code); } catch {} }
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    Buffer.byteLength(a) === 64 && Buffer.byteLength(b) === 64 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function proof(key, challenge) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`kupadesk-native-assets-v1\n${challenge}`).digest('hex');
}
function childOf(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readKey(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 66) throw failure('native_assets_key_invalid');
  const value = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(value)) throw failure('native_assets_key_invalid');
  return value;
}

async function obtainKey(packageDir) {
  const file = path.join(packageDir, '.native-assets-key');
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    const value = randomBytes(32).toString('hex');
    await handle.writeFile(value, 'utf8');
    await handle.close();
    return value;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code !== 'EEXIST') throw failure('native_assets_key_unavailable');
    // Another Bun host may be between its exclusive open and first write.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await readKey(file); }
      catch (readError) {
        if (attempt === 4 || readError.nativeAssetsCode !== 'native_assets_key_invalid') {
          throw failure(readError.nativeAssetsCode || 'native_assets_key_unavailable');
        }
        await pause(20);
      }
    }
  }
}

function fixedHeaders(response, type = 'text/plain; charset=utf-8') {
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}
function reject(response, status = 404) {
  fixedHeaders(response);
  response.writeHead(status);
  response.end();
}

function handler(pageDir, key, log) {
  return async (request, response) => {
    try {
      const host = request.headers.host;
      if (typeof host !== 'string' || !['wails.localhost', 'wails.localhost:80'].includes(host.toLowerCase())) {
        reject(response); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { reject(response, 405); return; }
      if (request.headers.origin !== undefined && request.headers.origin !== 'null') {
        reject(response); return;
      }
      if (typeof request.url !== 'string' || request.url.length > 1024 || !request.url.startsWith('/')) {
        reject(response); return;
      }
      const url = new URL(request.url, 'http://wails.localhost');
      if (url.pathname === HEALTH_PATH) {
        const challenge = url.searchParams.get('challenge');
        if (url.searchParams.size !== 1 || !/^[a-f0-9]{64}$/u.test(challenge || '')) {
          reject(response); return;
        }
        const data = Buffer.from(JSON.stringify({ protocol: 1, proof: proof(key, challenge) }));
        fixedHeaders(response, 'application/json; charset=utf-8');
        response.setHeader('Content-Length', data.length);
        response.writeHead(200);
        response.end(request.method === 'HEAD' ? undefined : data);
        return;
      }
      // Match the raw path too: URL normalization must never turn traversal,
      // escaped separators or an absolute-form target into a permitted file.
      const rawPath = request.url.split('?')[0];
      const match = rawPath.match(/^\/_magpie\/plugin\/[a-f0-9]{32}\/(kupadesk-native-003-[a-z.-]+)$/u);
      const params = url.searchParams;
      const cacheBust = match?.[1] === 'kupadesk-native-003-model-catalog.js' &&
        params.size === 2 && params.getAll('fresh').length === 1 && /^\d{1,16}$/u.test(params.get('fresh'));
      if (!match || url.pathname !== rawPath || !ASSETS.has(match[1]) ||
          params.getAll('kupaAsset').length !== 1 || (params.size !== 1 && !cacheBust) ||
          !equal(params.get('kupaAsset'), key)) {
        reject(response); return;
      }
      const file = path.join(pageDir, match[1]);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET ||
          !childOf(pageDir, await fs.realpath(file))) { reject(response); return; }
      const data = await fs.readFile(file);
      if (data.length > MAX_ASSET) { reject(response); return; }
      fixedHeaders(response, ASSETS.get(match[1]));
      response.setHeader('Content-Length', data.length);
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      emit(log, 'native_assets_read_failed');
      if (!response.headersSent) reject(response); else response.destroy();
    }
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) { resolve(); return; }
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

async function bind(host, port, serve) {
  const server = http.createServer({ maxHeaderSize: 8192 }, serve);
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 32;
  try {
    await new Promise((resolve, rejectPromise) => {
      const failed = (error) => { server.off('listening', ready); rejectPromise(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen({ host, port, ipv6Only: host === '::1', exclusive: true });
    });
    // Keep unexpected listener errors contained within this optional UI helper.
    server.on('error', () => {});
    server.unref();
    return server;
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

function verifyOwner(host, port, key, timeout) {
  return new Promise((resolve) => {
    const challenge = randomBytes(32).toString('hex');
    let settled = false;
    let deadline;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
    const request = http.request({ host, port, method: 'GET',
      path: `${HEALTH_PATH}?challenge=${challenge}`, headers: { Host: 'wails.localhost', Connection: 'close' },
      timeout,
    }, (response) => {
      let length = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 1024) { response.destroy(); done(false); } else chunks.push(chunk);
      });
      response.on('error', () => done(false));
      response.on('close', () => done(false));
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(response.statusCode === 200 && value.protocol === 1 && equal(value.proof, proof(key, challenge)));
        } catch { done(false); }
      });
    });
    request.on('timeout', () => { request.destroy(); done(false); });
    request.on('error', () => done(false));
    // Bound the entire handshake, including a peer that trickles a body.
    deadline = setTimeout(() => { request.destroy(); done(false); }, timeout);
    request.end();
  });
}

async function preparePage(packageDir) {
  const pageDir = await fs.realpath(path.join(packageDir, 'page'));
  if (!childOf(packageDir, pageDir)) throw failure('native_assets_invalid_path');
  const file = path.join(pageDir, 'index.template.html');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET) throw failure('native_assets_template_invalid');
  const template = await fs.readFile(file, 'utf8');
  if (!template.includes(MARKER)) throw failure('native_assets_template_invalid');
  return { pageDir, template };
}

async function renderPage(pageDir, template, key) {
  const pages = [['index', template]];
  try {
    const file = path.join(pageDir, 'provider.template.html');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET) throw failure('native_assets_template_invalid');
    const source = await fs.readFile(file, 'utf8');
    if (!source.includes(MARKER)) throw failure('native_assets_template_invalid');
    pages.push(['provider', source]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [name, source] of pages) {
  const temporary = path.join(pageDir, `.native-index.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, source.replaceAll(MARKER, key), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(pageDir, name + '.html'));
  } catch { throw failure('native_assets_index_unavailable'); }
  finally { await fs.unlink(temporary).catch(() => {}); }
  }
}

// port/ownerCheckMs/healthTimeoutMs allow focused tests to use ephemeral
// loopback ports. Runtime callers omit them; no host address is configurable.
export async function startNativeAssets({ packageDir, platform = process.platform, log = () => {},
  port = 80, ownerCheckMs = 2000, healthTimeoutMs = 750 } = {}) {
  if (platform !== 'win32') return { ok: true, mode: 'skipped', code: 'native_assets_platform_skipped', stop: noop };
  let states = [];
  let stopped = false;
  let timer;
  let checking;
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    await checking?.catch(() => {});
    await Promise.all(states.map((state) => closeServer(state.server)));
  };
  try {
    if (typeof packageDir !== 'string' || !packageDir || !Number.isInteger(port) || port < 0 || port > 65535 ||
        !Number.isFinite(ownerCheckMs) || ownerCheckMs < 20 || ownerCheckMs > 30000 ||
        !Number.isFinite(healthTimeoutMs) || healthTimeoutMs < 20 || healthTimeoutMs > 5000) {
      throw failure('native_assets_invalid_path');
    }
    const root = await fs.realpath(packageDir);
    const key = await obtainKey(root);
    const { pageDir, template } = await preparePage(root);
    const serve = handler(pageDir, key, log);
    let listeningPort = port;
    async function claim(state) {
      try {
        const server = await bind(state.host, listeningPort, serve);
        if (stopped) { await closeServer(server); return; }
        state.server = server;
        state.mode = 'owned';
        if (listeningPort === 0) listeningPort = server.address().port;
      } catch (error) {
        if (state.host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
          state.mode = 'unsupported'; return;
        }
        if (error.code === 'EADDRINUSE' && await verifyOwner(state.host, listeningPort, key, healthTimeoutMs)) {
          state.mode = 'reused'; return;
        }
        throw failure(error.code === 'EADDRINUSE' ? 'native_assets_port_in_use' : 'native_assets_bind_failed');
      }
    }
    for (const host of HOSTS) {
      const state = { host, mode: 'unbound', server: undefined, lastError: undefined };
      states.push(state);
      await claim(state);
    }
    await renderPage(pageDir, template, key);
    const mode = states.some((state) => state.mode === 'owned') ? 'started' : 'reused';
    const code = mode === 'started' ? 'native_assets_ready' : 'native_assets_reused';
    emit(log, code);
    async function checkOwners() {
      for (const state of states) {
        if (stopped || state.mode === 'unsupported') continue;
        if (state.mode === 'owned' && state.server?.listening) continue;
        if (state.mode === 'reused' && await verifyOwner(state.host, listeningPort, key, healthTimeoutMs)) continue;
        if (stopped) return;
        try {
          await claim(state);
          if (stopped) return;
          state.lastError = undefined;
          emit(log, state.mode === 'owned' ? 'native_assets_owner_acquired' : 'native_assets_reused');
        } catch (error) {
          state.mode = 'unbound';
          if (state.lastError !== error.nativeAssetsCode) emit(log, error.nativeAssetsCode || 'native_assets_bind_failed');
          state.lastError = error.nativeAssetsCode;
        }
      }
    }
    function schedule() {
      if (stopped) return;
      timer = setTimeout(() => {
        checking = checkOwners().catch(() => emit(log, 'native_assets_bind_failed'))
          .finally(() => { checking = undefined; schedule(); });
      }, ownerCheckMs);
      timer.unref?.();
    }
    schedule();
    return { ok: true, mode, code, port: listeningPort, hosts: states.filter((state) => state.mode !== 'unsupported').map((state) => state.host), stop };
  } catch (error) {
    await stop();
    const code = error.nativeAssetsCode || 'native_assets_start_failed';
    emit(log, code);
    return { ok: false, mode: 'error', code, stop: noop };
  }
}
