import fs from 'node:fs/promises';
import {onRequest as inject} from './kupadesk.middleware.js';
import {recordOutcome, recordCompletion} from './diagnostics.mjs';

let cached;
let checked = 0;
async function modelIndex() {
  if (cached && Date.now() - checked < 1000) return cached;
  const source = await fs.readFile(new URL('./request-index.js', import.meta.url), 'utf8');
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error('request_index_too_large');
  const match = source.match(/export const REQUEST_INDEX = ([\s\S]+);\s*$/);
  if (!match) throw new Error('request_index_invalid');
  const next = JSON.parse(match[1]);
  if (next.schemaVersion !== 1) throw new Error('request_index_invalid');
  cached = next; checked = Date.now();
  return cached;
}

export async function onRequest(body, ctx) {
  let index;
  try {
    try { index = await modelIndex(); } catch { index = cached; }
    const state = {};
    const result = inject(body, {...ctx, state, modelIndex: index,
      reject() { throw new Error('prompt_binding_invalid'); }});
    const outcome = state.kupadeskOutcome || 'invalid';
    recordOutcome(outcome, {ctx, index});
    ctx.report?.(outcome === 'unbound' ? 'unbound' : outcome === 'invalid' ? 'invalid'
      : outcome === 'disabled' ? 'skipped' : 'ready');
    return result;
  } catch {
    recordOutcome('invalid', {ctx, index});
    ctx.report?.('invalid');
    // The synchronous guard reports a request error for invalid bindings.
    // The host rolls this hook back, then runs that guard.
    throw new Error('KupaDesk prompt binding validation failed');
  }
}

// Best-effort observation only: no response rewrite or second injection.
export function onResponse(reply, ctx) { recordCompletion(reply, ctx); }
