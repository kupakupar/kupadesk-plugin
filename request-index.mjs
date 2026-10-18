import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

export function buildRequestIndex(catalog, metadata = {}) {
  const models = new Set(catalog.models.map(row => row.id));
  const aliases = Object.create(null);
  const add = (alias, id, replace = false) => {
    if (!alias || alias === id) return;
    if (replace && !groupAliases.has(alias)) { aliases[alias] = id; groupAliases.add(alias); return; }
    const previous = aliases[alias];
    const values = new Set(Array.isArray(previous) ? previous : previous ? [previous] : []);
    values.add(id);
    aliases[alias] = values.size === 1 ? id : [...values].sort();
  };
  for (const id of models) {
    const slash = id.indexOf('/');
    if (slash >= 0 && !id.startsWith('group/')) add(id.slice(slash + 1), id);
  }
  for (const provider of metadata.providerRows || []) {
    if (provider.off === true || typeof provider.id !== 'string') continue;
    for (const old of provider.was || []) {
      for (const id of models) if (id.startsWith(provider.id + '/')) add(old + id.slice(provider.id.length), id);
    }
  }
  const groupAliases = new Set();
  const groups = Object.create(null);
  for (const group of metadata.groupRows || []) {
    if (group.off === true || typeof group.id !== 'string') continue;
    const id = 'group/' + group.id;
    models.add(id);
    add(group.id, id, true);
    add(group.id.toLowerCase(), id, true);
    if (typeof group.name === 'string' && group.name) add(group.name, id, true);
    if (typeof group.name === 'string' && group.name) add(group.name.toLowerCase(), id, true);
    groups[id] = (group.members || []).filter(member => typeof member === 'string');
  }
  // A bare model shared by vendors is an implicit group. The matcher only
  // injects when every possible target has the same prompt binding.
  return {schemaVersion: 1, ready: true, models: [...models].sort(), aliases, groups};
}

export async function initializeRequestIndex(directory, packageDir) {
  const read = async (name, fallback) => {
    try {
      const file = path.join(directory, name);
      if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('request_index_too_large');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  const data = await read('providers.json', {providers: [], groups: []});
  const plugins = await read('plugin-providers.json', []);
  if (!Array.isArray(data.providers) || !Array.isArray(plugins)) throw new Error('request_index_invalid');
  const models = [];
  for (const provider of [...data.providers, ...plugins]) {
    if (provider.off === true || typeof provider.id !== 'string') continue;
    for (const value of provider.models || []) {
      const id = typeof value === 'string' ? value : value?.id;
      if (typeof id === 'string' && id) models.push({id: provider.id + '/' + id});
    }
  }
  await writeRequestIndex(packageDir, buildRequestIndex({models}, {providerRows: data.providers, groupRows: data.groups || []}));
}

export async function writeRequestIndex(packageDir, index) {
  const file = path.join(packageDir, 'request-index.js');
  const data = '// Local model aliases only. No prompts or credentials.\nexport const REQUEST_INDEX = ' + JSON.stringify(index) + ';\n';
  try { if (await fs.readFile(file, 'utf8') === data) return false; } catch {}
  const temporary = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, data, {flag: 'wx', mode: 0o600});
    await fs.rename(temporary, file);
    // Magpie's middleware stamp watches its entry file, not relative imports.
    const now = new Date();
    await fs.utimes(path.join(packageDir, 'kupadesk.middleware.js'), now, now);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return true;
}
