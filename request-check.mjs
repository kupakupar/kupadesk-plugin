import {createHash} from 'node:crypto';
import {readManagedText} from './managed-prompt.js';

// Observations only. No request objects, text, tool arguments or hashes escape
// this module's private snapshots. Unknown/oversized data is never a green check.
const MAX_BYTES = 8 * 1024 * 1024;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const instruction = m => m && (m.type == null || m.type === 'message') &&
  (m.role === 'system' || m.role === 'developer');
const toolKey = /^(tools|functions|functionDeclarations|function_declarations|tool_choice|function_call|parallel_tool_calls|allowed_tools|toolConfig|tool_config)$/;
const thinkingKey = /^(reasoning|thinking|thought|think$|include_?thoughts?$|enable_?thinking$|disable_?thinking$|enable_?reasoning$|effort$)/i;
const rootInstructions = {chat: [], responses: ['instructions'], anthropic: ['system'], gemini: ['systemInstruction', 'system_instruction']};

function textContent(value) {
  if (typeof value === 'string') return readManagedText(value)?.original ?? value;
  if (!Array.isArray(value)) return value;
  return value.flatMap(part => {
    if (!part || typeof part !== 'object') return [part];
    const managed = readManagedText(part.text);
    if (!managed) return [part];
    if (managed.kind === 'part' && !managed.original &&
        Object.keys(part).every(k => k === 'type' || k === 'text')) return [];
    return [{...part, text: managed.original}];
  });
}

function normalize(body, protocol, shapes) {
  const out = {...body};
  if (protocol === 'chat' || protocol === 'responses') {
    const key = protocol === 'chat' ? 'messages' : 'input';
    if (Array.isArray(body[key])) out[key] = body[key].flatMap(m => {
      if (!instruction(m)) return [m];
      const managed = readManagedText(m.content);
      if (managed?.kind === 'message' && !managed.original &&
          Object.keys(m).every(k => k === 'role' || k === 'content')) return [];
      return [{...m, ...(own(m, 'content') ? {content: textContent(m.content)} : {})}];
    });
  }
  for (const key of rootInstructions[protocol]) {
    if (!own(body, key)) continue;
    const value = body[key];
    if (protocol === 'gemini' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = {...value, ...(own(value, 'parts') ? {parts: textContent(value.parts)} : {})};
      // Gemini introduces a plain instruction container when none existed.
      if (value.parts?.some(p => readManagedText(p?.text)?.kind === 'part') &&
          out[key].parts?.length === 0 && Object.keys(out[key]).every(k => k === 'parts')) {
        if (shapes[key] === 'missing') delete out[key];
        else if (shapes[key] === 'null') out[key] = null;
      }
    } else {
      out[key] = textContent(value);
      if (readManagedText(value)?.original === '') {
        if (shapes[key] === 'missing') delete out[key];
        else if (shapes[key] === 'null') out[key] = null;
      }
    }
  }
  return out;
}

function canonical(value) {
  let bytes = 0, nodes = 0;
  const seen = new Set();
  function visit(v, depth) {
    if (++nodes > 160000 || depth > 64) throw Error('bounded');
    if (v === null || typeof v !== 'object') {
      if (!['string', 'number', 'boolean'].includes(typeof v) && v !== null) throw Error('not_json');
      if (typeof v === 'number' && !Number.isFinite(v)) throw Error('not_json');
      const s = JSON.stringify(v);
      bytes += Buffer.byteLength(s);
      if (bytes > MAX_BYTES) throw Error('bounded');
      return s;
    }
    if (seen.has(v)) throw Error('cycle');
    seen.add(v);
    const s = Array.isArray(v) ? '[' + v.map(x => visit(x, depth + 1)).join(',') + ']' :
      '{' + Object.keys(v).sort().map(k => {
        bytes += Buffer.byteLength(k) + 4;
        if (bytes > MAX_BYTES) throw Error('bounded');
        return JSON.stringify(k) + ':' + visit(v[k], depth + 1);
      }).join(',') + '}';
    seen.delete(v);
    return s;
  }
  return visit(value, 0);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export function snapshotRequest(body, protocol, originalShapes) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !own(rootInstructions, protocol)) return null;
    const shapes = originalShapes ?? Object.fromEntries(rootInstructions[protocol].map(k =>
      [k, !own(body, k) ? 'missing' : body[k] === null ? 'null' : 'present']));
    // Check the bound before walking a deep/cyclic history or collecting keys.
    canonical(body);
    const normalized = normalize(body, protocol, shapes), tools = [], thinking = [];
    let historyItems = 0, toolItems = 0;
    const history = {};
    for (const key of ['messages', 'input', 'contents']) if (own(normalized, key)) {
      history[key] = normalized[key];
      historyItems += Array.isArray(normalized[key]) ? normalized[key].length : 1;
    }
    for (const key of ['previous_response_id', 'conversation', 'context_management', 'truncation', ...rootInstructions[protocol]])
      if (own(normalized, key)) history[key] = normalized[key];
    function walk(v, at = []) {
      if (!v || typeof v !== 'object') return;
      for (const k of Object.keys(v)) {
        const path = at.concat(k), value = v[k];
        if (toolKey.test(k)) {
          tools.push([path, value]);
          if (['tools', 'functions', 'functionDeclarations', 'function_declarations'].includes(k) && Array.isArray(value))
            toolItems += value.filter(item => !Array.isArray(item?.tools) &&
              !Array.isArray(item?.functionDeclarations) && !Array.isArray(item?.function_declarations)).length;
        }
        if (thinkingKey.test(k)) thinking.push([path, value]);
        walk(value, path);
      }
    }
    walk(normalized);
    return {shapes, tools: {hash: digest(tools), count: toolItems},
      thinking: {hash: digest(thinking), count: thinking.length},
      history: {hash: digest(history), count: historyItems}};
  } catch { return null; }
}

export function compareRequests(before, after) {
  return Object.fromEntries(['tools', 'thinking', 'history'].map(key => [key,
    before && after ? {state: before[key].hash === after[key].hash ? 'same' : 'changed',
      before: before[key].count, after: after[key].count} : {state: 'unknown'}]));
}
