function choices(value) { return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []; }

export function canonicalModels(raw, index) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const model = raw.trim();
  const known = index && Array.isArray(index.models) ? index.models : [];
  const aliases = index && index.aliases && typeof index.aliases === 'object' ? index.aliases : {};
  // A real model called e.g. "vendor/model:high" wins over effort syntax.
  if (known.includes(model)) return [model];
  if (Object.prototype.hasOwnProperty.call(aliases, model)) return choices(aliases[model]);
  if (Object.prototype.hasOwnProperty.call(aliases, model.toLowerCase()) &&
      choices(aliases[model.toLowerCase()]).every(id => id.startsWith('group/'))) return choices(aliases[model.toLowerCase()]);
  if (model.startsWith('anthropic/')) {
    const nested = canonicalModels(model.slice(10), index);
    if (nested.some(id => known.includes(id))) return nested;
  }
  const marked = model.endsWith('[1m]');
  const plain = marked ? model.slice(0, -4) : model;
  const suffix = plain.match(/:(none|off|minimal|low|medium|high|xhigh|max)$/);
  if (suffix) {
    const base = plain.slice(0, -suffix[0].length) + (marked ? '[1m]' : '');
    if (known.includes(base)) return [base];
    if (Object.prototype.hasOwnProperty.call(aliases, base)) return choices(aliases[base]);
    return [base];
  }
  return [model];
}

export function selectBinding(options, model, index) {
  const active = options.bindings.filter(binding => binding && binding.enabled !== false && Array.isArray(binding.models));
  const byModel = new Map();
  for (const binding of active) {
    for (const selected of binding.models) {
      for (const canonical of canonicalModels(selected, index)) {
        if (!byModel.has(canonical)) byModel.set(canonical, []);
        if (!byModel.get(canonical).includes(binding)) byModel.get(canonical).push(binding);
      }
    }
  }
  let targets = canonicalModels(model, index);
  if (targets.length === 1 && !byModel.has(targets[0]) && index?.groups?.[targets[0]]) {
    const expand = (id, seen) => {
      if (seen.includes(id)) throw new Error('model_binding_ambiguous');
      if (!index.groups[id]) return [id];
      let result = [];
      for (const member of index.groups[id]) {
        const candidates = canonicalModels(member, index);
        for (const candidate of candidates) {
          if (candidate.includes('*') || candidate.includes('?')) {
            const expression = '^' + candidate.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
            const pattern = new RegExp(expression);
            result = result.concat((index.models || []).filter(value => !value.startsWith('group/') && pattern.test(value)));
          } else result = result.concat(expand(candidate, seen.concat(id)));
        }
      }
      return [...new Set(result)];
    };
    targets = expand(targets[0], []);
  }
  const hits = targets.map(target => byModel.get(target) || []);
  if (!hits.some(rows => rows.length)) return null;
  if (hits.some(rows => rows.length !== 1)) throw new Error('model_binding_ambiguous');
  const binding = hits[0][0];
  if (hits.some(rows => rows[0] !== binding)) throw new Error('model_binding_ambiguous');
  return binding;
}
