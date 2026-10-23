import {createHash} from 'node:crypto';
import {canonicalModels, selectBinding} from './model-match.js';
import {readManagedText} from './managed-prompt.js';
import {snapshotRequest, compareRequests} from './request-check.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const text = (value, max = 256) => typeof value === 'string' && value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const instruction = m => m && (m.type == null || m.type === 'message') &&
  (m.role === 'system' || m.role === 'developer');

// Inspect instruction containers only. Never record user text, tools, replies,
// endpoints, accounts, key names, or the instruction itself.
function instructionCheck(body, protocol, expected) {
  if (!object(body) || !expected) return 'unknown';
  const fields = [];
  if (protocol === 'responses') {
    fields.push(body.instructions);
    if (Array.isArray(body.input)) for (const m of body.input)
      if (instruction(m)) fields.push(m.content);
  } else if (protocol === 'anthropic') fields.push(body.system);
  else if (protocol === 'chat' && Array.isArray(body.messages)) {
    for (const m of body.messages) if (instruction(m)) fields.push(m.content);
  } else if (protocol === 'gemini') fields.push(body.systemInstruction?.parts, body.system_instruction?.parts);
  else return 'unknown';
  let count = 0, matches = 0, inspected = 0;
  for (const field of fields) {
    const parts = typeof field === 'string' ? [field] : Array.isArray(field)
      ? field.filter(p => typeof p?.text === 'string').map(p => p.text) : [];
    for (const part of parts) {
      inspected += part.length;
      if (inspected > 1024 * 1024) return 'unknown';
      const managed = readManagedText(part);
      if (!managed) continue;
      count++;
      if (digest(managed.prompt) === expected) matches++;
    }
  }
  return count === 1 && matches === 1 ? 'present' : 'missing';
}

export function createDiagnostics({now = Date.now, limit = 30} = {}) {
  const boot = now();
  const totals = {injected: 0, already: 0, unbound: 0, invalid: 0, disabled: 0};
  const events = [], rows = new Map();
  let sequence = 0, ledger = 'waiting';
  const iso = time => new Date(time).toISOString();

  function match(event) {
    const pub = event.public;
    if (!event.finished) { pub.route = {state: 'pending'}; return; }
    if (!event.response) { pub.route = {state: 'no-response-id'}; return; }
    if (events.some(other => other !== event && other.response === event.response)) {
      pub.route = {state: 'ambiguous'}; return;
    }
    const candidates = [...rows.values()].filter(row => row.response === event.response && !row.handedOn);
    if (!candidates.length) {
      pub.route = {state: ledger === 'missing' || ledger === 'unavailable' ? ledger :
        now() - event.finished > 30000 ? 'unconfirmed' : 'waiting'};
      return;
    }
    if (new Set(candidates.map(row => row.identity)).size !== 1) {
      pub.route = {state: 'ambiguous'}; return;
    }
    const row = candidates[candidates.length - 1];
    if ((row.requested && !event.models.includes(row.requested)) ||
        (row.agent && pub.agent && row.agent !== pub.agent) ||
        (row.session && event.session && row.session !== event.session) ||
        row.time < event.started - 60000 || row.time > event.finished + 5000) {
      pub.route = {state: 'mismatch'}; return;
    }
    pub.route = {state: 'matched', provider: row.provider, model: row.model,
      served: row.served, status: row.status, source: 'response-id', effort: row.effort};
    if (!event.routes) { pub.route.attemptState = 'disabled'; return; }
    const attempts = row.route ? [...rows.values()].filter(candidate => candidate.route === row.route &&
      candidate.time >= event.started - 60000 && candidate.time <= event.finished + 5000 &&
      (!candidate.requested || event.models.includes(candidate.requested)) &&
      (!candidate.agent || !pub.agent || candidate.agent === pub.agent) &&
      (!candidate.session || !event.session || candidate.session === event.session)).sort((a, b) => a.time - b.time) : [row];
    const routeConflict = attempts.some(candidate => !candidate.handedOn && candidate.identity !== row.identity);
    // A terminal response anchors its own route only. Never borrow tries by
    // model name/time, or turn incomplete/contradictory evidence into success.
    pub.route.attemptState = routeConflict ? 'ambiguous' : !row.route ? 'final-only' :
      attempts.length < (row.tries || 1) ? 'partial' : 'recorded';
    pub.route.total = row.tries || attempts.length;
    pub.route.attempts = routeConflict ? [] : attempts.slice(0, 20).map(candidate => ({
      provider: candidate.provider, model: candidate.model, status: candidate.status,
      handedOn: candidate.handedOn, effort: candidate.effort}));
  }

  function record(outcome, details) {
    try {
      if (!Object.hasOwn(totals, outcome)) return;
      totals[outcome]++;
      const {ctx = {}, index, before, after} = details || {};
      const model = text(ctx.model);
      let binding, matchState = 'unbound';
      try {
        if (model && ctx.options?.enabled === true && Array.isArray(ctx.options?.bindings)) {
          binding = selectBinding(ctx.options, model, index);
          matchState = binding ? 'matched' : 'unbound';
        }
      } catch { matchState = 'ambiguous'; }
      const started = now(), id = String(++sequence);
      const entry = {id, at: iso(started), outcome, requested: model,
        protocol: ['chat', 'responses', 'anthropic', 'gemini'].includes(ctx.protocol) ? ctx.protocol : '',
        agent: text(ctx.agent, 80), binding: binding ? {state: 'matched',
          id: text(binding.id), name: text(binding.name, 80),
          models: binding.models.map(x => text(x)).filter(Boolean).slice(0, 12)} : {state: matchState},
        accepted: 'pending', route: {state: 'pending'},
        checks: {plugin: ctx.options?.diagnostics?.checks === false ? {state: 'disabled'} : compareRequests(before, after),
          host: {state: 'pending'}}};
      events.unshift({public: entry, started, models: [...new Set([model, ...canonicalModels(model, index)])],
        expected: typeof binding?.prompt === 'string' ? digest(binding.prompt) : '',
        after, routes: ctx.options?.diagnostics?.routes !== false,
        session: text(ctx.session, 512) ? digest(ctx.session) : ''});
      if (events.length > limit) events.length = limit;
      if (object(ctx.state)) ctx.state.kupadeskDiagnostic = id;
      return id;
    } catch { /* Optional observation must never change an injection result. */ }
  }

  function complete(reply, ctx) {
    try {
      const event = events.find(row => row.public.id === ctx?.state?.kupadeskDiagnostic);
      if (!event || event.finished) return;
      event.finished = now();
      event.public.completedAt = iso(event.finished);
      event.public.completion = ctx.success === true ? 'success' : 'failed';
      event.public.accepted = event.expected ? instructionCheck(ctx.request, ctx.protocol, event.expected) : 'not-bound';
      event.public.checks.host = event.public.checks.plugin.state === 'disabled' ? {state: 'disabled'} :
        compareRequests(event.after, event.after ? snapshotRequest(ctx.request, ctx.protocol, event.after.shapes) : null);
      event.after = null;
      const id = text(reply?.id || reply?.responseId, 512);
      event.response = id ? digest(id) : '';
      for (const row of events) match(row);
    } catch { /* No return value, request mutation or synchronous I/O. */ }
  }

  function ingest(rawRows, status = 'ready') {
    try {
      ledger = status;
      for (const raw of rawRows) {
        if (!object(raw) || raw.computer || raw.source || raw.operation || raw.rejected) continue;
        const id = text(raw.response_id, 512), provider = text(raw.provider), model = text(raw.model);
        const time = Date.parse(raw.t);
        if (!provider || !model || !Number.isFinite(time) || time < boot - 60000) continue;
        const route = Number.isSafeInteger(raw.route_id) && raw.route_id > 0 ? String(raw.route_id) : '';
        if (!id && !route) continue;
        const row = {response: id ? digest(id) : '', route, provider, model, time,
          requested: text(raw.req), agent: text(raw.agent, 80),
          session: text(raw.session, 512) ? digest(raw.session) : '',
          status: Number.isInteger(raw.status) ? raw.status : 0,
          handedOn: raw.handed_on === true, tries: Number.isSafeInteger(raw.tries) && raw.tries > 0 ? raw.tries : 0,
          served: text(raw.served), effort: text(raw.effort, 40)};
        row.identity = digest(JSON.stringify([route, row.time, row.provider, row.model, row.requested, row.agent,
          row.session, row.status, row.handedOn, row.served, row.effort]));
        rows.set(row.response + ':' + row.identity, row);
      }
      for (const [key, row] of rows) if (row.time < now() - 15 * 60000) rows.delete(key);
      while (rows.size > 1024) rows.delete(rows.keys().next().value);
      for (const event of events) match(event);
    } catch { ledger = 'unavailable'; }
  }

  function snapshot() {
    for (const event of events) match(event);
    return {totals: {...totals}, last: events[0] ? structuredClone(events[0].public) : null,
      recent: events.slice(0, 12).map(event => structuredClone(event.public)), ledger};
  }
  return {record, complete, ingest, snapshot};
}

const diagnostics = createDiagnostics();
export function recordOutcome(outcome, details) { return diagnostics.record(outcome, details); }
export function recordCompletion(reply, ctx) { diagnostics.complete(reply, ctx); }
export function ingestUsageRows(rows, status) { diagnostics.ingest(rows, status); }
export function injectionDiagnostics() { return diagnostics.snapshot(); }
