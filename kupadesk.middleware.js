import { REQUEST_INDEX } from './request-index.js';
import { canonicalModels, selectBinding, providerBinding } from './model-match.js';

// Prompts/options remain local. No license lease or remote prompt service.
const START = "<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->";
const END = "<!-- KUPADESK-NATIVE-PAGE-TEST:END -->";
const MAX_PROMPT_CHARS = 32768;

function cleanText(text) {
  if (typeof text !== "string") throw new Error("invalid instruction");
  let at = text.indexOf(START);
  while (at >= 0) {
    const end = text.indexOf(END, at + START.length);
    if (end < 0 || text.slice(at + START.length, end).includes(START)) throw new Error("invalid managed block");
    // Remove the separator we added, while retaining unrelated whitespace.
    const from = at >= 2 && text.slice(at - 2, at) === "\n\n" ? at - 2 : at;
    text = text.slice(0, from) + text.slice(end + END.length);
    at = text.indexOf(START);
  }
  if (text.includes(END)) throw new Error("invalid managed block");
  return text;
}

function cleanContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return cleanText(value);
  if (!Array.isArray(value)) throw new Error("invalid instruction content");
  const result = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("invalid content part");
    if (part.type === "text" || part.type === "input_text") {
      const text = cleanText(part.text);
      if (!text && part.text) continue;
      result.push({ ...part, text });
    } else result.push(part);
  }
  return result;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("invalid messages");
  const result = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid message");
    if (message.role !== "system" && message.role !== "developer") {
      result.push(message);
      continue;
    }
    const content = cleanContent(message.content);
    if (content === "" || (Array.isArray(content) && content.length === 0)) continue;
    result.push({ ...message, content });
  }
  return result;
}

function append(content, block) {
  if (typeof content === "string") return content ? content + "\n\n" + block : block;
  if (Array.isArray(content)) return [...content, { type: "text", text: block }];
  throw new Error("invalid content");
}

function inject(body, protocol, block, roleChoice, model) {
  if (protocol === "responses") {
    body.instructions = append(cleanText(body.instructions == null ? "" : body.instructions), block);
    if (Array.isArray(body.input)) body.input = cleanMessages(body.input);
  } else if (protocol === "anthropic") {
    body.system = append(cleanContent(body.system), block);
  } else if (protocol === "chat") {
    body.messages = cleanMessages(body.messages);
    const developer = body.messages.some(m => m.role === "developer") || /(^|\/)(o1|o3|o4|gpt-5|gpt-6)/i.test(model);
    const role = roleChoice === "auto" ? (developer ? "developer" : "system") : roleChoice;
    let last = -1;
    for (let i = 0; i < body.messages.length; i++) if (body.messages[i].role === role) last = i;
    if (last < 0) body.messages.unshift({ role, content: block });
    else body.messages[last].content = append(body.messages[last].content, block);
  } else if (protocol === "gemini") {
    const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction";
    const instruction = body[key] == null ? { parts: [] } : body[key];
    if (!instruction || typeof instruction !== "object" || Array.isArray(instruction) || !Array.isArray(instruction.parts)) throw new Error("invalid system instruction");
    const parts = [];
    for (const part of instruction.parts) {
      if (part && typeof part.text === "string") {
        const text = cleanText(part.text);
        if (text) parts.push({ ...part, text });
      } else parts.push(part);
    }
    parts.push({ text: block });
    body[key] = { ...instruction, parts };
  } else throw new Error("unsupported protocol");
  return body;
}

function alreadyApplied(body, protocol, block, roleChoice, model) {
  let fields = [];
  if (protocol === 'chat' && Array.isArray(body?.messages)) {
    const developer = body.messages.some(m => m?.role === 'developer') || /(^|\/)(o1|o3|o4|gpt-5|gpt-6)/i.test(model);
    const role = roleChoice === 'auto' ? (developer ? 'developer' : 'system') : roleChoice;
    fields = body.messages.filter(m => m?.role === 'system' || m?.role === 'developer')
      .map(m => ({content: m.content, eligible: m.role === role}));
  } else if (protocol === 'responses') {
    fields = [{content: body?.instructions, eligible: true}];
    if (Array.isArray(body?.input)) fields = fields.concat(body.input
      .filter(m => m?.role === 'system' || m?.role === 'developer').map(m => ({content: m.content, eligible: false})));
  } else if (protocol === 'anthropic') fields = [{content: body?.system, eligible: true}];
  else if (protocol === 'gemini') {
    if (body?.systemInstruction && body?.system_instruction) return false;
    fields = [{content: (body?.systemInstruction || body?.system_instruction)?.parts, eligible: true}];
  }
  let starts = 0, ends = 0, exact = false;
  for (const field of fields) {
    const parts = typeof field.content === 'string' ? [field.content] : Array.isArray(field.content)
      ? field.content.filter(p => typeof p?.text === 'string').map(p => p.text) : [];
    for (const text of parts) {
      starts += text.split(START).length - 1;
      ends += text.split(END).length - 1;
      if (field.eligible && text.includes(block)) exact = true;
    }
  }
  return starts === 1 && ends === 1 && exact;
}

function outcome(ctx, value) { if (ctx?.state) ctx.state.kupadeskOutcome = value; }

function validPrompt(binding) {
  return typeof binding.prompt === 'string' && binding.prompt.trim() && binding.prompt.length <= MAX_PROMPT_CHARS &&
    !binding.prompt.includes(START) && !binding.prompt.includes(END) &&
    ['auto', 'system', 'developer'].includes(binding.chatRole == null ? 'auto' : binding.chatRole);
}

function validateBindings(options, index) {
  const used = new Map();
  for (const binding of options.bindings) {
    if (!binding || binding.enabled === false) continue;
    if (!Array.isArray(binding.models)) throw new Error('invalid binding models');
    if (!binding.models.length) continue;
    if (!validPrompt(binding)) throw new Error('invalid prompt binding');
    for (const model of binding.models) {
      if (typeof model !== 'string' || !model.trim()) throw new Error('invalid binding model');
      for (const id of canonicalModels(model, index)) {
        if (used.has(id) && used.get(id) !== binding) throw new Error('duplicate prompt bindings');
        used.set(id, binding);
      }
    }
  }
}

function applyBinding(body, ctx, binding, model) {
  if (!validPrompt(binding)) throw new Error('invalid prompt binding');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request body');
  const role = binding.chatRole == null ? 'auto' : binding.chatRole;
  const block = START + '\n' + binding.prompt + '\n' + END;
  if (alreadyApplied(body, ctx.protocol, block, role, model)) { outcome(ctx, 'already'); return; }
  if (ctx.protocol === 'gemini' && body.systemInstruction && body.system_instruction) throw new Error('conflicting instruction fields');
  const result = inject({...body}, ctx.protocol, block, role, model);
  outcome(ctx, 'injected');
  return result;
}

function removeManaged(body, protocol) {
  // This also cleans a block inserted by an earlier request hook or an old
  // conversation. An unbound fallback must not inherit another model's prompt.
  if (!body || typeof body !== 'object') throw new Error('invalid request body');
  const copy = {...body};
  if (protocol === 'chat') copy.messages = cleanMessages(body.messages);
  else if (protocol === 'responses') {
    if (body.instructions != null) copy.instructions = cleanText(body.instructions);
    if (Array.isArray(body.input)) copy.input = cleanMessages(body.input);
  } else if (protocol === 'anthropic') {
    if (body.system != null) copy.system = cleanContent(body.system);
  } else if (protocol === 'gemini') {
    for (const key of ['systemInstruction', 'system_instruction']) {
      if (!body[key]) continue;
      if (!Array.isArray(body[key].parts)) throw new Error('invalid system instruction');
      copy[key] = {...body[key], parts: body[key].parts.map(part => typeof part?.text === 'string' ? {...part, text: cleanText(part.text)} : part)};
    }
  } else throw new Error('unsupported protocol');
  return copy;
}

export function onProvider(body, ctx) {
  if (!ctx?.options || ctx.options.enabled !== true) return;
  try {
    const index = ctx.modelIndex || REQUEST_INDEX;
    const {binding, model} = providerBinding(ctx.options, ctx.model || body?.model, ctx.provider, index);
    if (!binding) { outcome(ctx, 'unbound'); return removeManaged(body, ctx.protocol); }
    return applyBinding(body, ctx, binding, model);
  } catch {
    outcome(ctx, 'invalid');
    // onProvider cannot reject a routed request. Invalid settings are checked
    // in onRequest first; a host failure here remains visible in its counters.
    throw new Error('KupaDesk: actual provider prompt matching failed.');
  }
}

export function onRequest(body, ctx) {
  const options = ctx && ctx.options;
  if (!options || options.enabled !== true) { outcome(ctx, 'disabled'); return; }
  const reject = message => {
    if (ctx && typeof ctx.reject === "function") return ctx.reject(400, message);
  };
  try {
    if (options.schemaVersion !== 1 || !Array.isArray(options.bindings)) return reject("KupaDesk: invalid options schema.");
    if ((ctx.modelIndex || REQUEST_INDEX).providerHook === true) {
      try { validateBindings(options, ctx.modelIndex || REQUEST_INDEX); }
      catch { outcome(ctx, 'invalid'); return reject('KupaDesk: invalid or duplicate active prompt bindings.'); }
      outcome(ctx, 'deferred');
      return;
    }
    const model = typeof ctx.model === "string" && ctx.model ? ctx.model : body && body.model;
    if (typeof model !== "string" || !model) return;
    let binding;
    try { binding = selectBinding(options, model, ctx.modelIndex || REQUEST_INDEX); }
    catch { outcome(ctx, 'invalid'); return reject('KupaDesk: model binding is ambiguous. Use a full model ID or bind the whole routing group to one prompt.'); }
    if (!binding) { outcome(ctx, 'unbound'); return; }
    return applyBinding(body, ctx, binding, model);
  } catch (_) {
    outcome(ctx, 'invalid');
    return reject("KupaDesk: unsupported or malformed instruction fields.");
  }
}
