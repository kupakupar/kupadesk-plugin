import { REQUEST_INDEX } from './request-index.js';
import { selectBinding } from './model-match.js';
import {appendManagedText, cleanManagedText, readManagedText} from './managed-prompt.js';

// Prompts/options remain local. No license lease or remote prompt service.
const START = "<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->";
const END = "<!-- KUPADESK-NATIVE-PAGE-TEST:END -->";

function cleanContent(value) {
  if (value == null) return value;
  if (typeof value === "string") return cleanManagedText(value);
  if (!Array.isArray(value)) throw new Error("invalid instruction content");
  const result = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("invalid content part");
    if (part.type === "text" || part.type === "input_text") {
      const managed = readManagedText(part.text);
      if (managed?.kind === 'part' && !managed.original &&
          Object.keys(part).every(key => key === 'type' || key === 'text')) continue;
      const text = cleanManagedText(part.text);
      result.push(text === part.text ? part : { ...part, text });
    } else result.push(part);
  }
  return result;
}

function isInstructionMessage(message) {
  // Responses Lite also uses role: developer on additional_tools items.
  // Only actual messages have instruction content that we may rewrite.
  return message != null && (message.type == null || message.type === "message") &&
    (message.role === "system" || message.role === "developer");
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("invalid messages");
  const result = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid message");
    if (!isInstructionMessage(message)) {
      result.push(message);
      continue;
    }
    const managed = readManagedText(message.content);
    if (managed?.kind === 'message' && !managed.original &&
        Object.keys(message).every(key => key === 'role' || key === 'content')) continue;
    const content = cleanContent(message.content);
    result.push(content === message.content ? message : { ...message, content });
  }
  return result;
}

function append(content, prompt) {
  if (typeof content === "string") return appendManagedText(content, prompt);
  if (Array.isArray(content)) return [...content, { type: "text", text: appendManagedText('', prompt, 'part') }];
  throw new Error("invalid content");
}

function inject(body, protocol, prompt, roleChoice, model) {
  if (protocol === "responses") {
    body.instructions = append(cleanManagedText(body.instructions == null ? "" : body.instructions), prompt);
    if (Array.isArray(body.input)) body.input = cleanMessages(body.input);
  } else if (protocol === "anthropic") {
    body.system = append(cleanContent(body.system == null ? '' : body.system), prompt);
  } else if (protocol === "chat") {
    body.messages = cleanMessages(body.messages);
    const developer = body.messages.some(m => m.role === "developer") || /(^|\/)(o1|o3|o4|gpt-5|gpt-6)/i.test(model);
    const role = roleChoice === "auto" ? (developer ? "developer" : "system") : roleChoice;
    let last = -1;
    for (let i = 0; i < body.messages.length; i++) if (body.messages[i].role === role && body.messages[i].content != null) last = i;
    if (last < 0) body.messages.unshift({ role, content: appendManagedText('', prompt, 'message') });
    else body.messages[last] = {...body.messages[last], content: append(body.messages[last].content, prompt)};
  } else if (protocol === "gemini") {
    const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction";
    const instruction = body[key] == null ? { parts: [] } : body[key];
    if (!instruction || typeof instruction !== "object" || Array.isArray(instruction) || !Array.isArray(instruction.parts)) throw new Error("invalid system instruction");
    const parts = [];
    for (const part of instruction.parts) {
      if (part && typeof part.text === "string") {
        const managed = readManagedText(part.text);
        if (managed?.kind === 'part' && !managed.original && Object.keys(part).every(key => key === 'text')) continue;
        const text = cleanManagedText(part.text);
        parts.push(text === part.text ? part : { ...part, text });
      } else parts.push(part);
    }
    parts.push({ text: appendManagedText('', prompt, 'part') });
    body[key] = { ...instruction, parts };
  } else throw new Error("unsupported protocol");
  return body;
}

function alreadyApplied(body, protocol, prompt, roleChoice, model) {
  let fields = [];
  if (protocol === 'chat' && Array.isArray(body?.messages)) {
    const developer = body.messages.some(m => m?.role === 'developer') || /(^|\/)(o1|o3|o4|gpt-5|gpt-6)/i.test(model);
    const role = roleChoice === 'auto' ? (developer ? 'developer' : 'system') : roleChoice;
    fields = body.messages.filter(isInstructionMessage)
      .map(m => ({content: m.content, eligible: m.role === role}));
  } else if (protocol === 'responses') {
    fields = [{content: body?.instructions, eligible: true}];
    if (Array.isArray(body?.input)) fields = fields.concat(body.input
      .filter(isInstructionMessage).map(m => ({content: m.content, eligible: false})));
  } else if (protocol === 'anthropic') fields = [{content: body?.system, eligible: true}];
  else if (protocol === 'gemini') {
    if (body?.systemInstruction && body?.system_instruction) return false;
    fields = [{content: (body?.systemInstruction || body?.system_instruction)?.parts, eligible: true}];
  }
  let count = 0, exact = false;
  for (const field of fields) {
    const parts = typeof field.content === 'string' ? [field.content] : Array.isArray(field.content)
      ? field.content.filter(p => typeof p?.text === 'string').map(p => p.text) : [];
    for (const text of parts) {
      const managed = readManagedText(text);
      if (!managed) continue;
      count++;
      if (field.eligible && managed.prompt === prompt) exact = true;
    }
  }
  return count === 1 && exact;
}

function outcome(ctx, value) { if (ctx?.state) ctx.state.kupadeskOutcome = value; }

export function onRequest(body, ctx) {
  const options = ctx && ctx.options;
  if (!options || options.enabled !== true) { outcome(ctx, 'disabled'); return; }
  const reject = message => {
    if (ctx && typeof ctx.reject === "function") return ctx.reject(400, message);
  };
  try {
    if (options.schemaVersion !== 1 || !Array.isArray(options.bindings)) return reject("KupaDesk: invalid options schema.");
    const model = typeof ctx.model === "string" && ctx.model ? ctx.model : body && body.model;
    if (typeof model !== "string" || !model) return;
    let binding;
    try { binding = selectBinding(options, model, ctx.modelIndex || REQUEST_INDEX); }
    catch { outcome(ctx, 'invalid'); return reject('KupaDesk: model binding is ambiguous. Use a full model ID or bind the whole routing group to one prompt.'); }
    if (!binding) { outcome(ctx, 'unbound'); return; }
    const prompt = binding.prompt;
    const role = binding.chatRole == null ? "auto" : binding.chatRole;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes(START) || prompt.includes(END) || !["auto", "system", "developer"].includes(role)) return reject("KupaDesk: invalid prompt binding.");
    if (!body || typeof body !== "object" || Array.isArray(body)) return reject("KupaDesk: invalid request body.");
    if (alreadyApplied(body, ctx.protocol, prompt, role, model)) { outcome(ctx, 'already'); return; }
    if (ctx.protocol === 'gemini' && body.systemInstruction && body.system_instruction) return reject('KupaDesk: request contains two conflicting system instruction fields.');
    // Only instruction containers are copied by inject/cleanMessages. Avoid
    // cloning megabytes of conversation history inside the Go JS time budget.
    const result = inject({...body}, ctx.protocol, prompt, role, model);
    outcome(ctx, 'injected');
    return result;
  } catch (_) {
    outcome(ctx, 'invalid');
    return reject("KupaDesk: unsupported or malformed instruction fields.");
  }
}
