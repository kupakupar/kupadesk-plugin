import fs from 'node:fs/promises';
import path from 'node:path';
import {ingestUsageRows} from './diagnostics.mjs';

const active = new Map();

// Read the existing local ledger only. No settings writes or network calls.
export function startDiagnosticsLedger({directory, publish = ingestUsageRows, interval = 1000} = {}) {
  if (!directory) return {stop: async () => {}, refresh: async () => {}};
  const file = path.join(directory, 'usage.jsonl');
  if (active.has(file)) return active.get(file);
  const BATCH = 256 * 1024, MAX_LINE = 64 * 1024;
  let offset = null, identity = '', carry = '', skip = false, stopped = false, timer, inFlight;
  async function perform() {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not_file');
      const nextIdentity = `${stat.dev}:${stat.ino}`;
      if (offset === null) {
        offset = Math.max(0, stat.size - BATCH); skip = offset > 0;
      } else if (identity !== nextIdentity || stat.size < offset) {
        offset = 0; carry = ''; skip = false;
      }
      identity = nextIdentity;
      const size = Math.min(BATCH, Math.max(0, stat.size - offset)), data = Buffer.alloc(size);
      const {bytesRead} = size ? await handle.read(data, 0, size, offset) : {bytesRead: 0};
      offset += bytesRead;
      // Split bytes before UTF-8 decoding so partial multibyte names survive.
      const lines = (carry + data.subarray(0, bytesRead).toString('latin1')).split('\n');
      carry = lines.pop();
      const rows = [];
      for (const line of lines) {
        if (skip) { skip = false; continue; }
        if (!line || line.length > MAX_LINE) continue;
        try { rows.push(JSON.parse(Buffer.from(line, 'latin1').toString('utf8'))); } catch {}
      }
      if (carry.length > MAX_LINE) { carry = ''; skip = true; }
      if (!stopped) publish(rows, offset < stat.size ? 'catching-up' : 'ready');
    } catch (error) {
      if (!stopped) publish([], error.code === 'ENOENT' ? 'missing' : 'unavailable');
    } finally { await handle?.close().catch(() => {}); }
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    if (!inFlight) inFlight = perform().catch(() => {}).finally(() => {inFlight = null;});
    return inFlight;
  }
  async function tick() {
    await refresh();
    if (!stopped) { timer = setTimeout(tick, interval); timer.unref?.(); }
  }
  timer = setTimeout(tick, 0); timer.unref?.();
  const handle = {refresh, async stop() {
    stopped = true; clearTimeout(timer);
    if (active.get(file) === handle) active.delete(file);
    await inFlight;
  }};
  active.set(file, handle);
  return handle;
}
