import {REQUEST_INDEX} from './guard-index.js';
// private/binding-policy.js
function validAgents(value) {
  return value == null || Array.isArray(value) && value.length <= 128 && value.every((id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(id));
}
function agentAllowed(binding, agent) {
  if (!validAgents(binding?.agents))
    throw new Error("invalid_agent_scope");
  if (binding?.agents == null)
    return true;
  return typeof agent === "string" && agent !== "" && binding.agents.includes(agent);
}

// private/model-match.js
function choices(value) {
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}
function selectForRequest(options, model, index, agent) {
  try {
    const binding = selectBinding(options, model, index);
    return { binding, excluded: Boolean(binding && !agentAllowed(binding, agent)) };
  } catch (error) {
    if (!error?.conflict)
      throw error;
    const active = options.bindings.filter((b) => b && b.enabled !== false && Array.isArray(b.models));
    const bindings = active.filter((b) => agentAllowed(b, agent));
    if (bindings.length === active.length)
      throw error;
    if (!bindings.length)
      return { binding: null, excluded: true };
    const binding = selectBinding({ ...options, bindings }, model, index);
    return { binding, excluded: !binding };
  }
}
function desktopTargets(id, index) {
  const plain = id.endsWith("[1m]") ? id.slice(0, -4) : id;
  const match = plain.match(/^(?:anthropic\/magpie-|mythos-magpie-|claude-magpie-)(\d{10})$/) || plain.match(/^magpie-(\d{10})\.anthropic\..*$/);
  if (!match || !Object.prototype.hasOwnProperty.call(index?.desktopAliases || {}, match[1]))
    return [];
  return choices(index.desktopAliases[match[1]]);
}
function canonicalModels(raw, index, explicit = false) {
  if (typeof raw !== "string" || !raw.trim())
    return [];
  const model = raw.trim();
  const groupRef = index?.groupRefs?.[model];
  if (typeof groupRef === "string" && groupRef.startsWith("group/"))
    return [groupRef];
  const known = index && Array.isArray(index.models) ? index.models : [];
  const aliasTable = explicit ? index?.bindingAliases : index?.aliases;
  const aliases = aliasTable && typeof aliasTable === "object" ? aliasTable : {};
  if (known.includes(model))
    return [model];
  if (Object.prototype.hasOwnProperty.call(aliases, model))
    return choices(aliases[model]);
  const desktop = desktopTargets(model, index);
  if (desktop.length)
    return desktop;
  if (Object.prototype.hasOwnProperty.call(aliases, model.toLowerCase()) && choices(aliases[model.toLowerCase()]).every((id) => id.startsWith("group/")))
    return choices(aliases[model.toLowerCase()]);
  if (model.startsWith("anthropic/")) {
    const nested = canonicalModels(model.slice(10), index, explicit);
    if (nested.some((id) => known.includes(id) && (!explicit || id.includes("/"))))
      return nested;
  }
  const marked = model.endsWith("[1m]");
  const plain = marked ? model.slice(0, -4) : model;
  const suffix = plain.match(/:(none|off|minimal|low|medium|high|xhigh|max)$/i);
  if (suffix) {
    const base = plain.slice(0, -suffix[0].length) + (marked ? "[1m]" : "");
    if (known.includes(base))
      return [base];
    if (Object.prototype.hasOwnProperty.call(aliases, base))
      return choices(aliases[base]);
    const desktop = desktopTargets(base, index);
    if (desktop.length)
      return desktop;
    return [base];
  }
  return [model];
}
function bindingModels(raw, index) {
  if (typeof raw === "string" && raw.endsWith("[1m]")) {
    const plain = raw.slice(0, -4);
    if (plain.startsWith("group/") || index?.groupRefs?.[plain] || index?.autoRefs === true && plain.startsWith("auto/"))
      raw = plain;
  }
  return [...new Set(canonicalModels(raw, index, true).map((id) => {
    const ref = index?.groupRefs?.[id];
    if (typeof ref === "string" && ref.startsWith("group/"))
      return ref;
    if (index?.autoRefs === true && id.startsWith("auto/")) {
      const slug = id.slice(5).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-");
      if (slug)
        return "group/auto-" + slug;
    }
    return id;
  }))];
}
function selectBinding(options, model, index) {
  const targets = bindingModels(model, index);
  if (targets.length !== 1)
    return null;
  const target = targets[0];
  const active = options.bindings.filter((binding) => binding && binding.enabled !== false && Array.isArray(binding.models));
  const hits = active.filter((binding) => binding.models.some((selected) => {
    const ids = bindingModels(selected, index);
    return ids.length === 1 && ids[0] === target;
  }));
  if (hits.length > 1) {
    throw Object.assign(new Error("model_binding_ambiguous"), { conflict: {
      reason: "bindings",
      targets: [{ model: target, bindings: hits.map((binding) => binding.id) }]
    } });
  }
  return hits[0] || null;
}

// tools/startup-guard.mjs
function pendingRequest(body, ctx, index) {
  const options = ctx?.options;
  if (options?.enabled !== true || !Array.isArray(options.bindings))
    return body;
  const model = ctx.model || body?.model;
  if (typeof model !== "string" || !model)
    return body;
  try {
    const decision = selectForRequest(options, model, index, ctx.agent);
    if (!decision.binding || decision.excluded)
      return body;
  } catch {
    if (typeof ctx.reject === "function")
      return ctx.reject(400, "KupaDesk：绑定配置冲突，请检查该模型的核心和 Agent 范围。");
    throw Error("kupadesk_binding_conflict");
  }
  if (typeof ctx.reject === "function")
    return ctx.reject(503, "KupaDesk：所选模型的核心正在准备，请稍后重试。");
  throw Error("kupadesk_core_preparing");
}
export {
  pendingRequest
};

export function onRequest(body,ctx){return pendingRequest(body,ctx,ctx?.modelIndex || REQUEST_INDEX);}
