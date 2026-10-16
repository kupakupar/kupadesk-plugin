// Personal test plugin. Prompts/options are local plaintext, without cloud licensing.
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

export function onRequest(body, ctx) {
  const options = ctx && ctx.options;
  if (!options || options.enabled !== true) return;
  const reject = message => {
    if (ctx && typeof ctx.reject === "function") return ctx.reject(400, message);
  };
  try {
    if (options.schemaVersion !== 1 || !Array.isArray(options.bindings)) return reject("KupaDesk: invalid options schema.");
    const model = typeof ctx.model === "string" && ctx.model ? ctx.model : body && body.model;
    if (typeof model !== "string" || !model) return;
    const matches = options.bindings.filter(b => b && b.enabled !== false && Array.isArray(b.models) && b.models.includes(model));
    if (matches.length === 0) return;
    if (matches.length !== 1 || matches[0].models.indexOf(model) !== matches[0].models.lastIndexOf(model)) return reject("KupaDesk: more than one prompt is bound to this model.");
    const binding = matches[0];
    const prompt = binding.prompt;
    const role = binding.chatRole == null ? "auto" : binding.chatRole;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS || prompt.includes(START) || prompt.includes(END) || !["auto", "system", "developer"].includes(role)) return reject("KupaDesk: invalid prompt binding.");
    if (!body || typeof body !== "object" || Array.isArray(body)) return reject("KupaDesk: invalid request body.");
    // Work on a copy: errors must not leave a partially edited request behind.
    const copy = JSON.parse(JSON.stringify(body));
    return inject(copy, ctx.protocol, START + "\n" + prompt + "\n" + END, role, model);
  } catch (_) {
    return reject("KupaDesk: unsupported or malformed instruction fields.");
  }
}
