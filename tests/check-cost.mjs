import {performance} from 'node:perf_hooks';
import {snapshotRequest} from '../request-check.mjs';
import {onRequest} from '../kupadesk.middleware.js';
const options = {schemaVersion: 1, enabled: true, bindings: [{id: 'a', prompt: 'Synthetic prompt', models: ['one/a']}]};
for (const bytes of [80 * 1024, 2 * 1024 * 1024]) {
  const body = {model: 'one/a', messages: [{role: 'system', content: 'Original'}, {role: 'user', content: 'x'.repeat(bytes)}],
    tools: [{type: 'function', function: {name: 'read', parameters: {type: 'object'}}}], reasoning_effort: 'high'};
  const times = [];
  for (let i = 0; i < 8; i++) {
    const start = performance.now(), before = snapshotRequest(body, 'chat');
    const after = onRequest(body, {model: 'one/a', protocol: 'chat', options, state: {}});
    const snapshot = snapshotRequest(after, 'chat', before.shapes);
    if (!snapshot || snapshot.history.hash !== before.history.hash) throw Error('Invalid check');
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({historyBytes: bytes, rounds: times.length, medianMs: +times[4].toFixed(2), maxMs: +times.at(-1).toFixed(2)}));
}
