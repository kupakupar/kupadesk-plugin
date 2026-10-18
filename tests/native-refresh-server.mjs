// Isolated native transport: packets for the test WebView use 127.0.0.2:80.
// The real Magpie listener on 127.0.0.1/::1:80 is never contacted or changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {execFileSync} from 'node:child_process';
import { startNativeAssets } from '../native-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureName = process.argv[2] || 'native-fixture';
const address = process.argv[3] || '127.0.0.2';
const port = Number(process.argv[4] || 18083);
const baseline = process.argv[5] || '';
const revisions = {'010': '9b29b04', '012': '6f6735a'};
if (!/^[a-z0-9-]+$/.test(fixtureName) || !/^127\.0\.0\.[2-9]$/.test(address) ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || (baseline && !revisions[baseline])) throw Error('invalid fixture parameters');
const fixture = path.join(root, 'evidence', fixtureName);
const page = path.join(fixture, 'page');
await fs.mkdir(page, {recursive: true});
for (const name of await fs.readdir(path.join(root, 'page'))) {
  if (name === 'kupadesk-native-003-model-catalog.js') continue;
  if (baseline) await fs.writeFile(path.join(page, name), execFileSync('git', ['show', `${revisions[baseline]}:page/${name}`], {cwd: root}));
  else await fs.copyFile(path.join(root, 'page', name), path.join(page, name));
}
const models = Array.from({length: 35}, (_, i) => ({id: `test/${i === 0 ? 'a' : i === 1 ? 'b' : i}`,
  name: `Test model ${i + 1}`, provider: 'test', providerName: 'Test provider'}));
await fs.writeFile(path.join(page, 'kupadesk-native-003-model-catalog.js'),
  `window.KUPADESK_MODEL_CATALOG=${JSON.stringify({schemaVersion: 1, status: 'ready', models})};`);
const listener = await startNativeAssets({packageDir: fixture, platform: 'win32', port});
if (!listener.ok) throw Error(listener.code);
let requests = 0;
const server = http.createServer((request, response) => {
  requests++;
  const proxy = http.request({host: '127.0.0.1', port: listener.port,
    path: request.url, method: request.method, headers: request.headers}, remote => {
    response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
  });
  proxy.on('error', () => {response.writeHead(502); response.end();});
  request.pipe(proxy);
});
server.listen({host: address, port: 80, exclusive: true}, () => {
  console.log(JSON.stringify({ready: true, isolatedLoopback: address, page, backendPort: listener.port}));
});
process.on('SIGTERM', async () => {server.close(); await listener.stop(); process.exit();});
setInterval(() => console.log(JSON.stringify({requests})), 30000).unref();
