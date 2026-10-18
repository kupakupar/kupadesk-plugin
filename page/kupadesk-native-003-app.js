(() => {
  'use strict';

  // The Windows native asset bridge authenticates requests with the nonce
  // supplied by this script's URL. Keep it local and out of logs/settings.
  const assetNonce = new URL(document.currentScript?.src || location.href).searchParams.get('kupaAsset');

  const LIMIT_BYTES = 48 * 1024;
  const PROMPT_LIMIT = 32768;
  const MODEL_RENDER_LIMIT = 200;
  const ROLES = new Set(['auto', 'system', 'developer']);
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = { options: null, saved: null, selected: null, deleted: [], connected: false, saving: false, lastSave: 0, cooldown: null, catalog: [], catalogById: new Map(), catalogProviders: new Map(), visibleModels: [], catalogSignature: '', catalogStatus: 'waiting', catalogLastSuccess: '', catalogCheckedAt: '', catalogReloadFailed: false, catalogLoading: false, catalogTimer: null, catalogRequestTimer: null, catalogScript: null, disposed: false };
  const controls = ['injection-enabled', 'add-binding', 'empty-add-binding', 'binding-search', 'copy-binding', 'manage-models', 'focus-editor'];
  const fieldIds = ['binding-name', 'binding-models', 'binding-prompt', 'binding-role', 'binding-enabled'];
  const pickerControls = ['model-search', 'model-provider', 'models-selected-only', 'select-visible-models', 'clear-selected-models'];
  let diagnosticRows = [], selectedDiagnostic = '', diagnosticOptionSignature = '';
  let refreshing = false, refreshTimer = null;

  function diagnosticModelName(raw) {
    let model = state.catalogById.get(raw);
    if (!model && typeof raw === 'string') {
      const base = raw.replace(/:(none|off|minimal|low|medium|high|xhigh|max)$/, '');
      model = state.catalogById.get(base);
      if (!model) {
        const matches = state.catalog.filter(item => item.name === raw || item.id.split('/').slice(1).join('/') === raw);
        if (matches.length === 1) model = matches[0];
      }
    }
    return model ? model.name + (model.providerName ? ' · ' + model.providerName : '') : '模型名称暂不可用';
  }

  function diagnosticResult(row) {
    if (row.outcome === 'disabled') return '提示词注入已关闭';
    if (row.outcome === 'unbound') return '这个模型没有绑定提示词';
    if (row.outcome === 'invalid') return '绑定或提示词检查未通过';
    if (row.accepted === 'present') return '已确认加入本次请求';
    if (row.accepted === 'missing') return '未确认到完整提示词';
    if (row.accepted === 'unknown') return '暂时无法核对';
    return '已生成提示词，等待核对';
  }

  function showRequestDiagnostics(check) {
    diagnosticRows = Array.isArray(check?.recent) ? check.recent.filter(row => row && typeof row.id === 'string').slice(0, 12) : [];
    const select = $('diagnostic-request');
    const previous = selectedDiagnostic;
    const signature = JSON.stringify(diagnosticRows.map(row => [row.id, row.at, diagnosticModelName(row.requested)]));
    if (signature !== diagnosticOptionSignature) {
      select.replaceChildren();
      for (const row of diagnosticRows) {
        const option = document.createElement('option');
        option.value = row.id;
        option.textContent = (catalogTime(row.at) || '时间未知') + ' · ' + diagnosticModelName(row.requested) + ' · 第 ' + row.id + ' 次';
        select.append(option);
      }
      diagnosticOptionSignature = signature;
    }
    if (previous && diagnosticRows.some(row => row.id === previous)) select.value = previous;
    select.disabled = !diagnosticRows.length;
    drawRequestDiagnostic();
  }

  function drawRequestDiagnostic() {
    const row = diagnosticRows.find(item => item.id === $('diagnostic-request').value);
    $('diagnostic-empty').hidden = !!row;
    $('diagnostic-fields').hidden = !row;
    $('diagnostic-picker').hidden = !row;
    if (!row) { $('diagnostic-summary').textContent = '等待请求'; return; }
    const outcomes = {injected: '入口已生成注入', already: '入口已确认提示词存在',
      unbound: '未绑定提示词', invalid: '入口检查失败', disabled: '注入已关闭'};
    const accepted = {present: '宿主接受的请求含绑定提示词', missing: '宿主请求未确认到完整提示词',
      unknown: '宿主请求格式无法核对', pending: '等待完成回调，尚未核对', 'not-bound': '无启用的绑定需要核对'};
    const routes = {pending: '等待回复完成后核对', waiting: '等待本机用量记录',
      missing: '本机暂无用量记录', unavailable: '本机用量记录暂不可读',
      unconfirmed: '未找到对应记录，无法确认', 'no-response-id': '回复缺少 ID，无法确认',
      ambiguous: '回复 ID 重复，无法唯一确认', mismatch: '记录信息不一致，无法确认'};
    const binding = row.binding || {}, route = row.route || {};
    $('diagnostic-summary').textContent = diagnosticResult(row) + ' · ' + diagnosticModelName(row.requested);
    $('diagnostic-model').textContent = diagnosticModelName(row.requested);
    $('diagnostic-result').textContent = diagnosticResult(row);
    $('diagnostic-requested-id').textContent = row.requested || '未提供模型 ID';
    $('diagnostic-binding').textContent = binding.state === 'matched' ? (binding.name || '未命名提示词') :
      binding.state === 'ambiguous' ? '绑定有歧义，无法确认' : '无启用的匹配绑定';
    $('diagnostic-bound-model').textContent = Array.isArray(binding.models) && binding.models.length ? binding.models.join('、') : '—';
    const providerName = state.catalogProviders.get(route.provider);
    $('diagnostic-provider').textContent = route.state === 'matched' ? providerName || '供应商名称暂不可用（可展开技术详情）' : routes[route.state] || '未知';
    $('diagnostic-provider-id').textContent = route.state === 'matched' ? route.provider || '未提供供应商 ID' : '—';
    $('diagnostic-served-model').textContent = route.state === 'matched' ? route.model || '模型 ID 未提供' : '—';
    $('diagnostic-injection').textContent = outcomes[row.outcome] || '结果未知';
    $('diagnostic-accepted').textContent = accepted[row.accepted] || '未核对';
    $('diagnostic-completion').textContent = row.completion === 'success' ? '回复完成' :
      row.completion === 'failed' ? '回复失败或不完整' : '尚未收到完成回调';
    $('diagnostic-evidence').textContent = route.state === 'matched' ?
      '已按回复 ID 对应同一次请求的本机用量记录' + (route.status ? ' · HTTP ' + route.status : '') :
      '供应商只在回复 ID 唯一对应时显示；不根据模型名称猜测。';
  }

  function showError(message) {
    $('save-error').textContent = message;
    $('save-error').hidden = !message;
  }

  function safely(fn) {
    return event => {
      try { fn(event); }
      catch (_) { showError('页面操作未完成，请重新打开插件页面后再试。'); }
    };
  }

  function currentBinding() {
    return state.options?.bindings.find(binding => binding.id === state.selected) || null;
  }

  function isDirty() {
    return state.options !== null && JSON.stringify(state.options) !== JSON.stringify(state.saved);
  }

  function sizeOf(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  function newId() {
    return 'binding-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function normalizeOptions(raw) {
    const original = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (original.schemaVersion !== undefined && original.schemaVersion !== 1) {
      throw new Error('设置版本与此版本插件不兼容，请保留原设置并使用对应版本的插件。');
    }
    const ids = new Set();
    const bindings = Array.isArray(original.bindings) ? original.bindings.map(rawBinding => {
      const item = rawBinding && typeof rawBinding === 'object' && !Array.isArray(rawBinding) ? rawBinding : {};
      let id = typeof item.id === 'string' && item.id ? item.id : newId();
      if (ids.has(id)) id = newId();
      ids.add(id);
      return {
        ...item, id, name: typeof item.name === 'string' ? item.name : '',
        enabled: item.enabled !== false,
        models: Array.isArray(item.models) ? item.models.filter(model => typeof model === 'string') : [],
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        chatRole: ROLES.has(item.chatRole) ? item.chatRole : 'auto',
      };
    }) : [];
    return { ...original, schemaVersion: 1, enabled: original.enabled === true, bindings,
      gatewayTimeoutMs: Number.isInteger(original.gatewayTimeoutMs) ? original.gatewayTimeoutMs : 5000 };
  }

  function parseModels(text) {
    return [...new Set(text.split(/[\n,，\r]+/).map(model => model.trim()).filter(Boolean))];
  }

  function catalogTime(value) {
    const date = typeof value === 'string' && value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  }

  function showCatalogStatus() {
    const last = catalogTime(state.catalogLastSuccess);
    const retained = state.catalog.length ? '已保留上次目录（' + state.catalog.length + ' 个模型）' : '已有提示词仍然保留';
    let message;
    let status = state.catalogStatus;
    if (state.catalogReloadFailed || status === 'stale') {
      status = 'stale';
      message = '自动同步暂不可用，' + retained + '。';
    } else if (status === 'waiting') {
      message = '自动同步已开启，正在等待插件后台读取模型…';
      if (state.catalog.length) message += ' 已保留上次目录。';
    } else message = '自动同步 · ' + state.catalog.length + ' 个模型';
    if (last) message += (message.endsWith('。') ? '' : ' · ') + '上次成功：' + last;
    $('catalog-info').textContent = message;
    $('catalog-info').dataset.status = status;
    $('catalog-compact').textContent = status === 'ready' ? state.catalog.length + ' 个模型' : status === 'stale' ? '暂不可用' : '同步中';
    $('catalog-compact').dataset.status = status;
    $('refresh-catalog').disabled = !state.connected || state.catalogLoading || state.disposed;
    $('refresh-catalog').textContent = state.catalogLoading ? '刷新中…' : '刷新目录';
    $('refresh-catalog').setAttribute('aria-busy', String(state.catalogLoading));
  }

  function replaceProviderOptions(providers) {
    const select = $('model-provider');
    const previousId = select.value;
    const previousName = state.catalogProviders.get(previousId) || previousId;
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '所有供应商';
    select.replaceChildren(all);
    for (const [id, name] of [...providers.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name === id ? name : name + ' · ' + id;
      select.append(option);
    }
    if (previousId && !providers.has(previousId)) {
      const previous = document.createElement('option');
      previous.value = previousId;
      previous.textContent = previousName + '（当前不可用）';
      select.append(previous);
    }
    select.value = previousId;
  }

  function loadCatalog() {
    const raw = window.KUPADESK_MODEL_CATALOG;
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.models)) throw new Error('CATALOG_UNAVAILABLE');
    const check = raw.injection;
    const outcomes = {injected: '已生成提示词注入', already: '已确认提示词存在', unbound: '此请求未绑定提示词', invalid: '注入检查失败，请检查模型绑定和插件错误'};
    if (check?.last && outcomes[check.last.outcome]) {
      const at = catalogTime(check.last.at);
      $('injection-info').textContent = '最近请求检查：' + outcomes[check.last.outcome] + (at ? ' · ' + at : '') + '。此处显示插件处理结果。';
    } else $('injection-info').textContent = '等待请求检查；可在「插件」页查看网关中间件的调用和错误。';
    const status = ['ready', 'waiting', 'stale'].includes(raw.status) ? raw.status : 'waiting';
    state.catalogStatus = status;
    state.catalogCheckedAt = typeof raw.checkedAt === 'string' ? raw.checkedAt : '';
    if (status === 'ready') state.catalogLastSuccess = typeof raw.importedAt === 'string' && raw.importedAt ? raw.importedAt : state.catalogCheckedAt;
    else if (!state.catalogLastSuccess && typeof raw.importedAt === 'string') state.catalogLastSuccess = raw.importedAt;
    state.catalogReloadFailed = false;
    // An unavailable backend must not erase the last readable directory.
    if (status !== 'ready' && state.catalog.length && raw.models.length === 0) {
      showCatalogStatus();
      showRequestDiagnostics(check);
      return;
    }
    const providers = new Map();
    for (const item of Array.isArray(raw.providers) ? raw.providers : []) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      providers.set(item.id, typeof item.name === 'string' && item.name ? item.name : item.id);
    }
    const catalog = [];
    const catalogById = new Map();
    for (const item of raw.models) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || catalogById.has(item.id)) continue;
      const provider = typeof item.provider === 'string' && item.provider ? item.provider : item.id.split('/')[0];
      const model = {
        id: item.id,
        name: typeof item.name === 'string' && item.name ? item.name : item.id,
        provider,
        providerName: typeof item.providerName === 'string' && item.providerName ? item.providerName : providers.get(provider) || provider,
      };
      model.search = [model.id, model.name, model.provider, model.providerName].join('\n').toLowerCase();
      catalog.push(model);
      catalogById.set(model.id, model);
      if (!providers.has(model.provider)) providers.set(model.provider, model.providerName);
    }
    const signature = JSON.stringify([raw.revision || '', [...providers], catalog.map(model => [model.id, model.name, model.provider, model.providerName])]);
    if (signature !== state.catalogSignature) {
      replaceProviderOptions(providers);
      state.catalog = catalog;
      state.catalogById = catalogById;
      state.catalogProviders = providers;
      state.catalogSignature = signature;
      // Repaint only the directory. Options, text inputs and their drafts stay intact.
      if (currentBinding()) drawModelPicker();
    }
    showCatalogStatus();
    showRequestDiagnostics(check);
  }

  function refreshCatalog() {
    if (!state.connected || state.catalogLoading || state.disposed) return;
    state.catalogLoading = true;
    const previousScript = state.catalogScript;
    if (previousScript) previousScript.remove();
    const script = document.createElement('script');
    state.catalogScript = script;
    const catalogURL = new URL('kupadesk-native-003-model-catalog.js', document.baseURI);
    catalogURL.searchParams.set('fresh', String(Date.now()));
    if (assetNonce) catalogURL.searchParams.set('kupaAsset', assetNonce);
    script.src = catalogURL.href;
    let done = false;
    const finish = success => {
      if (done) return;
      done = true;
      clearTimeout(state.catalogRequestTimer);
      state.catalogRequestTimer = null;
      script.onload = null;
      script.onerror = null;
      script.remove();
      if (state.catalogScript === script) state.catalogScript = null;
      state.catalogLoading = false;
      if (state.disposed) return;
      if (success) {
        try { loadCatalog(); }
        catch (_) { state.catalogReloadFailed = true; }
      } else state.catalogReloadFailed = true;
      showCatalogStatus();
    };
    script.onload = () => finish(true);
    script.onerror = event => {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    state.catalogRequestTimer = setTimeout(() => finish(false), 4000);
    showCatalogStatus();
    try { document.head.append(script); }
    catch (_) { finish(false); }
  }

  function startCatalogUpdates() {
    refreshCatalog();
    state.catalogTimer = setInterval(() => {
      if (!document.hidden) refreshCatalog();
    }, 5000);
  }

  function disposeCatalogUpdates() {
    state.disposed = true;
    clearInterval(state.catalogTimer);
    clearTimeout(state.catalogRequestTimer);
    clearTimeout(state.cooldown);
    clearTimeout(refreshTimer);
    if (state.catalogScript) {
      state.catalogScript.onload = null;
      state.catalogScript.onerror = null;
      state.catalogScript.remove();
      state.catalogScript = null;
    }
  }

  function occupiedModels() {
    const occupied = new Map();
    for (const binding of state.options?.bindings || []) {
      if (binding.id === state.selected) continue;
      for (const id of binding.models) occupied.set(id, binding.name.trim() || '未命名提示词');
    }
    return occupied;
  }

  function updateSelectedModels(models) {
    const binding = currentBinding();
    if (!binding || state.saving || !state.connected) return;
    binding.models = [...new Set(models)];
    $('binding-models').value = binding.models.join('\n');
    clearValidation();
    showError('');
    drawModelPicker();
    drawList();
    updateSaveState();
  }

  function modelRow(model, selected, occupied) {
    const row = document.createElement('label');
    row.className = 'model-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.modelId = model.id;
    checkbox.checked = selected.has(model.id);
    checkbox.disabled = state.saving || !state.connected || (occupied.has(model.id) && !checkbox.checked);
    const content = document.createElement('span');
    content.className = 'model-option-content';
    const top = document.createElement('span');
    top.className = 'model-option-top';
    const name = document.createElement('span');
    name.className = 'model-option-name';
    name.textContent = model.name;
    const meta = document.createElement('span');
    meta.className = 'model-option-provider';
    meta.textContent = occupied.has(model.id) ? '已用于「' + occupied.get(model.id) + '」' : model.providerName;
    const id = document.createElement('span');
    id.className = 'model-option-id';
    id.textContent = model.id;
    top.append(name, meta);
    content.append(top, id);
    row.append(checkbox, content);
    row.dataset.occupied = String(occupied.has(model.id) && !checkbox.checked);
    row.title = model.id + (occupied.has(model.id) ? '\n已用于「' + occupied.get(model.id) + '」，请先从该提示词移除模型。' : '');
    checkbox.addEventListener('change', safely(() => {
      const binding = currentBinding();
      if (!binding) return;
      const hadFocus = document.activeElement === checkbox;
      if (checkbox.checked) {
        if (occupiedModels().has(model.id)) return;
        updateSelectedModels(binding.models.concat(model.id));
      } else updateSelectedModels(binding.models.filter(id => id !== model.id));
      if (hadFocus) {
        const replacement = [...document.querySelectorAll('[data-model-id]')].find(input => input.dataset.modelId === model.id);
        (replacement || $('model-search')).focus();
      }
    }));
    return row;
  }

  function drawModelPicker() {
    const binding = currentBinding();
    const selected = new Set(binding?.models || []);
    const occupied = occupiedModels();
    const terms = $('model-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const provider = $('model-provider').value;
    const selectedOnly = $('models-selected-only').checked;
    const filtered = state.catalog.filter(model => (!provider || model.provider === provider) && (!selectedOnly || selected.has(model.id)) && terms.every(term => model.search.includes(term)));
    state.visibleModels = filtered.slice(0, MODEL_RENDER_LIMIT);
    const list = $('model-list');
    list.replaceChildren();
    for (const model of state.visibleModels) list.append(modelRow(model, selected, occupied));
    $('selected-model-count').textContent = '已选 ' + selected.size + ' 个';
    $('model-list-empty').hidden = filtered.length > 0;
    $('model-list-empty').textContent = state.catalog.length ? '没有匹配的模型，可调整搜索或供应商筛选。' : (state.catalogStatus === 'waiting' ? '正在等待插件后台读取模型，也可以手动填写模型 ID。' : '当前目录中没有模型，可以使用下方手动填写。');
    $('model-list-summary').textContent = filtered.length > MODEL_RENDER_LIMIT ? '共匹配 ' + filtered.length + ' 个，仅显示前 ' + MODEL_RENDER_LIMIT + ' 个。请搜索缩小范围；批量选择仅选择当前显示项。' : '显示 ' + filtered.length + ' 个模型。已用于其他提示词的模型不可重复选择。';
    const available = state.visibleModels.filter(model => !selected.has(model.id) && !occupied.has(model.id)).length;
    $('select-visible-models').textContent = '选择当前显示' + (available ? '（' + available + '）' : '');
    $('select-visible-models').disabled = !binding || !available || state.saving || !state.connected;
    $('clear-selected-models').disabled = !binding || !selected.size || state.saving || !state.connected;
    for (const id of ['model-search', 'models-selected-only']) $(id).disabled = !binding || state.saving || !state.connected || !state.catalog.length;
    $('model-provider').disabled = !binding || state.saving || !state.connected || !state.catalogProviders.size;
    const extraIds = [...selected].filter(id => !state.catalogById.has(id));
    $('extra-selected-models').hidden = extraIds.length === 0;
    const extras = $('extra-model-list');
    extras.replaceChildren();
    for (const id of extraIds.slice(0, MODEL_RENDER_LIMIT)) extras.append(modelRow({ id, name: id, providerName: '当前不可用 · 保留绑定' }, selected, occupied));
    $('extra-model-summary').hidden = extraIds.length <= MODEL_RENDER_LIMIT;
    $('extra-model-summary').textContent = '另有 ' + Math.max(0, extraIds.length - MODEL_RENDER_LIMIT) + ' 个已选模型保留在手动 ID 列表中。';
    drawBindingSummary();
  }

  // View state only: selections still use the 008 draft and save flow.
  function drawBindingSummary() {
    const binding = currentBinding();
    const ids = binding?.models || [];
    $('bound-model-summary').textContent = ids.length ? '已绑定 ' + ids.length + ' 个模型' : '尚未绑定模型';
    const names = ids.map(id => state.catalogById.get(id)?.name || id);
    $('bound-model-names').textContent = names.length ? names.join('、') : '可先保存提示词，稍后再选择模型';
    $('bound-model-names').title = names.join('\n');
    $('drawer-binding-name').textContent = binding?.name.trim() || '新提示词';
    $('manage-models').disabled = !binding || state.saving || !state.connected;
    $('focus-editor').disabled = !binding || state.saving || !state.connected;
  }

  let drawerOpener = null;
  function openModelDrawer() {
    if (!currentBinding() || !state.connected || state.saving) return;
    const drawer = $('model-drawer');
    if (drawer.open) return;
    drawerOpener = document.activeElement;
    $('prompt-actions').open = false;
    $('status-details').open = false;
    drawModelPicker();
    drawer.showModal();
    ($('model-search').disabled ? $('close-model-drawer') : $('model-search')).focus();
  }

  function closeModelDrawer() {
    const drawer = $('model-drawer');
    if (!drawer.open) return;
    drawer.close();
    if (drawerOpener?.isConnected && !drawerOpener.disabled) drawerOpener.focus();
    drawerOpener = null;
  }

  function setFocusEditor(enabled) {
    $('app-shell').dataset.focus = String(enabled);
    $('focus-editor').setAttribute('aria-pressed', String(enabled));
    $('focus-editor').textContent = enabled ? '退出专注' : '专注编辑';
    $('prompt-actions').open = false;
    $('status-details').open = false;
    if (enabled) $('binding-prompt').focus();
  }

  function updateSaveState(label) {
    const dirty = isDirty();
    const bytes = state.options ? sizeOf(state.options) : 0;
    $('storage-meter').textContent = (bytes / 1024).toFixed(1) + ' / 48 KB';
    $('storage-meter').style.color = bytes > LIMIT_BYTES ? 'var(--danger)' : '';
    $('save-status').dataset.dirty = String(dirty);
    $('save-status').dataset.saved = String(state.connected && !dirty);
    $('save-status').textContent = label || (dirty ? '有未保存的修改' : (state.connected ? '设置已保存' : '尚未连接 Magpie'));
    $('save-options').disabled = !state.connected || !dirty || state.saving || Date.now() - state.lastSave < 1100;
    $('discard-changes').disabled = !state.connected || !dirty || state.saving;
    $('undo-delete').hidden = state.deleted.length === 0 || state.saving;
    $('injection-state').textContent = state.options?.enabled ? '已开启' : '已关闭';
    $('save-options').firstChild.textContent = state.saving ? '保存中… ' : '保存设置 ';
    $('save-options').setAttribute('aria-busy', String(state.saving));
  }

  function clearValidation() {
    for (const name of ['name', 'models', 'prompt']) {
      $('binding-' + name).removeAttribute('aria-invalid');
      $(name + '-error').textContent = '';
      $(name + '-error').hidden = true;
    }
  }

  function fieldError(name, message) {
    if (name === 'models') { openModelDrawer(); $('manual-models').open = true; }
    if (name === 'prompt') $('prompt-count').dataset.overLimit = String(currentBinding()?.prompt.length > PROMPT_LIMIT);
    $('binding-' + name).setAttribute('aria-invalid', 'true');
    $(name + '-error').textContent = message;
    $(name + '-error').hidden = false;
  }

  function drawList() {
    const list = $('binding-list');
    list.replaceChildren();
    const bindings = state.options?.bindings || [];
    const term = $('binding-search').value.trim().toLowerCase();
    const filtered = bindings.filter(binding => (binding.name + '\n' + binding.prompt + '\n' + binding.models.join('\n')).toLowerCase().includes(term));
    $('binding-count').textContent = String(bindings.length);
    $('list-empty').hidden = filtered.length > 0;
    $('list-empty').textContent = bindings.length && term ? '没有找到匹配的提示词' : '还没有本地提示词';
    for (const binding of filtered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'binding-card';
      button.dataset.bindingId = binding.id;
      button.setAttribute('aria-current', String(binding.id === state.selected));
      const row = document.createElement('span');
      row.className = 'binding-card-top';
      const name = document.createElement('span');
      name.className = 'binding-card-name';
      name.textContent = binding.name.trim() || '未命名提示词';
      const enabled = document.createElement('span');
      enabled.className = 'binding-card-state';
      enabled.textContent = binding.enabled ? '启用' : '停用';
      const models = document.createElement('span');
      models.className = 'binding-card-model';
      models.textContent = binding.models.length ? '已绑定 ' + binding.models.length + ' 个模型' : '尚未绑定模型';
      // Search can match the body without exposing it in cards or tooltips.
      button.title = binding.name.trim() || '未命名提示词';
      row.append(name, enabled);
      button.append(row, models);
      button.addEventListener('click', safely(() => {
        state.selected = binding.id;
        drawList();
        drawEditor();
      }));
      list.append(button);
    }
  }

  function drawEditor() {
    const binding = currentBinding();
    clearValidation();
    $('empty-state').hidden = Boolean(binding);
    $('binding-form').hidden = !binding;
    $('copy-binding').disabled = !binding || state.saving || !state.connected;
    if (!binding) { closeModelDrawer(); setFocusEditor(false); return; }
    $('binding-name').value = binding.name;
    $('binding-models').value = binding.models.join('\n');
    $('binding-prompt').value = binding.prompt;
    $('binding-role').value = binding.chatRole;
    $('binding-enabled').checked = binding.enabled;
    $('editor-title').textContent = binding.name.trim() || '新提示词';
    $('prompt-count').textContent = binding.prompt.length + ' / ' + PROMPT_LIMIT;
    $('prompt-count').dataset.overLimit = String(binding.prompt.length > PROMPT_LIMIT);
    drawModelPicker();
  }

  function drawAll() {
    $('injection-enabled').checked = Boolean(state.options?.enabled);
    drawList();
    drawEditor();
    updateSaveState();
  }

  function onEdit(event) {
    const binding = currentBinding();
    if (!binding || state.saving) return;
    binding.name = $('binding-name').value;
    if (event?.target.id === 'binding-models') binding.models = parseModels($('binding-models').value);
    binding.prompt = $('binding-prompt').value;
    binding.chatRole = ROLES.has($('binding-role').value) ? $('binding-role').value : 'auto';
    binding.enabled = $('binding-enabled').checked;
    $('editor-title').textContent = binding.name.trim() || '新提示词';
    $('prompt-count').textContent = binding.prompt.length + ' / ' + PROMPT_LIMIT;
    $('prompt-count').dataset.overLimit = String(binding.prompt.length > PROMPT_LIMIT);
    drawBindingSummary();
    clearValidation();
    showError('');
    drawList();
    if (event?.target.id === 'binding-models') drawModelPicker();
    updateSaveState();
  }

  function addBinding() {
    if (!state.connected || state.saving) return;
    const item = { id: newId(), name: '', enabled: true, models: [], prompt: '', chatRole: 'auto' };
    state.options.bindings.push(item);
    state.selected = item.id;
    $('binding-search').value = '';
    showError('');
    drawAll();
    $('binding-name').focus();
  }

  function copyBinding() {
    $('prompt-actions').open = false;
    const source = currentBinding();
    if (!source || !state.connected || state.saving) return;
    const suffix = '（副本）';
    let name = (source.name.trim() || '未命名提示词').slice(0, 80 - suffix.length);
    // Do not split a UTF-16 surrogate pair at the name limit.
    if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
    const item = { id: newId(), name: name + suffix, enabled: false,
      models: [], prompt: source.prompt, chatRole: source.chatRole };
    state.options.bindings.push(item);
    state.selected = item.id;
    $('binding-search').value = '';
    showError('');
    drawAll();
    updateSaveState('已复制为未保存草稿，尚未绑定模型');
    $('binding-name').focus();
  }

  function validate() {
    clearValidation();
    const seen = new Map();
    for (const binding of state.options.bindings) {
      const errors = {};
      if (!binding.name.trim()) errors.name = '请填写提示词名称。';
      else if (binding.name.length > 80) errors.name = '提示词名称最多 80 个字符。';
      for (const model of binding.models) {
        if (!model || /\s/.test(model) || model.length > 2048) errors.models = '请使用 Magpie 中显示的入口模型 ID，不要包含空格。';
        if (seen.has(model) && seen.get(model) !== binding.id) errors.models = '模型 ' + model + ' 已用于其他提示词，请保留一份关联。';
        seen.set(model, binding.id);
      }
      if (!binding.prompt.trim()) errors.prompt = '请填写提示词正文。';
      else if (binding.prompt.length > PROMPT_LIMIT) errors.prompt = '每份提示词最多 ' + PROMPT_LIMIT + ' 个字符。';
      else if (binding.prompt.includes('<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->') || binding.prompt.includes('<!-- KUPADESK-NATIVE-PAGE-TEST:END -->')) errors.prompt = '提示词不能包含此插件的内部管理标记。';
      if (Object.keys(errors).length) {
        state.selected = binding.id;
        $('binding-search').value = '';
        drawList();
        drawEditor();
        for (const [name, message] of Object.entries(errors)) fieldError(name, message);
        $('binding-' + Object.keys(errors)[0]).focus();
        showError('请先完成当前提示词，再保存到本地。');
        return false;
      }
    }
    if (sizeOf(state.options) > LIMIT_BYTES) {
      showError('本地设置超过 48 KB，请缩短提示词或减少保存的内容。');
      return false;
    }
    return true;
  }

  function setSaving(saving) {
    state.saving = saving;
    $('refresh-page').disabled = saving || refreshing;
    for (const id of controls.concat(fieldIds, pickerControls, ['delete-binding'])) $(id).disabled = saving || !state.connected;
    for (const button of $('binding-list').querySelectorAll('button')) button.disabled = saving;
    if (currentBinding()) drawModelPicker();
    updateSaveState(saving ? '正在保存到本地…' : undefined);
  }

  async function saveOptions() {
    if (!state.connected || state.saving || !isDirty() || Date.now() - state.lastSave < 1100) return;
    try {
      if (!validate()) return;
      showError('');
      setSaving(true);
      state.lastSave = Date.now();
      const payload = clone(state.options);
      const latest = normalizeOptions(await window.magpie.options.get());
      if (JSON.stringify(latest) !== JSON.stringify(state.saved)) {
        throw new Error('其他页面或设备更新了设置。当前草稿仍保留，请先复制需要的修改，再还原修改以读取最新设置。');
      }
      const result = await window.magpie.options.set(payload);
      // The host returns the full settings object; keep any fields it adds.
      state.options = normalizeOptions(result);
      state.saved = clone(state.options);
      state.deleted = [];
      if (!currentBinding()) state.selected = state.options.bindings[0]?.id || null;
      drawAll();
    } catch (error) {
      const reason = String(error?.message || '未知错误');
      showError('保存失败，修改仍保留在页面中。' + (reason.length < 180 ? ' ' + reason : ' 请稍后重试。'));
    } finally {
      setSaving(false);
      clearTimeout(state.cooldown);
      state.cooldown = setTimeout(() => updateSaveState(), Math.max(0, 1150 - (Date.now() - state.lastSave)));
    }
  }

  function themeChanged(theme) {
    document.documentElement.dataset.theme = theme?.dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = theme?.dark ? 'dark' : 'light';
  }

  function refreshPage() {
    if (state.saving || refreshing) return;
    if (isDirty()) {
      showError('有未保存的修改，请先保存设置或还原修改，再刷新页面。');
      $('save-options').focus();
      return;
    }
    try {
      const next = new URL(window.location.href);
      if (next.protocol === 'http:' && next.hostname === 'wails.localhost') {
        const script = [...document.scripts].find(node => node.src.includes('/kupadesk-native-003-app.js?'));
        const key = script && new URL(script.src).searchParams.get('kupaAsset');
        if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('refresh unavailable');
        next.pathname = next.pathname.replace(/[^/]*$/, 'kupadesk-native-003-page.html');
        next.search = '';
        next.searchParams.set('kupaAsset', key);
      }
      next.hash = '';
      next.searchParams.set('fresh', String(Date.now()));
      refreshing = true;
      $('refresh-page').disabled = true;
      $('refresh-page').textContent = '正在刷新…';
      // A document that actually navigates is destroyed with its timers. If
      // navigation is blocked, release the button without queuing more loads.
      refreshTimer = setTimeout(() => {
        if (state.disposed) return;
        resetRefresh();
        showError('页面刷新未完成，请稍后重试。');
      }, 8000);
      window.location.replace(next.href);
    }
    catch { resetRefresh(); showError('页面暂时无法刷新，请稍后再试。'); }
  }

  function resetRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshing = false;
    $('refresh-page').disabled = state.saving;
    $('refresh-page').textContent = '刷新页面';
  }

  async function boot() {
    try {
      if (!window.magpie || window.parent === window) throw new Error('请从 Magpie 的「插件」页面打开 KupaDesk。此页面不能在普通浏览器中保存设置。');
      window.magpie.onTheme(themeChanged);
      let timeout;
      const ready = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('连接 Magpie 超时，请关闭后重新打开插件页面。')), 10000); });
      let theme;
      try { theme = await Promise.race([window.magpie.ready, ready]); }
      finally { clearTimeout(timeout); }
      themeChanged(theme);
      const raw = await window.magpie.options.get();
      state.options = normalizeOptions(raw);
      state.saved = clone(state.options);
      state.selected = state.options.bindings[0]?.id || null;
      state.connected = true;
      $('connection-label').textContent = '已连接 Magpie';
      $('connection-label').dataset.connected = 'true';
      for (const id of controls) $(id).disabled = false;
      try { loadCatalog(); }
      catch (_) { state.catalogReloadFailed = true; showCatalogStatus(); }
      drawAll();
      startCatalogUpdates();
      // Remote settings may be applied by the plugin's private sync helper.
      // Never replace a draft the user is currently editing.
      const settingsTimer=setInterval(async()=>{
        if(state.disposed||state.saving||!state.connected||isDirty())return;
        try{
          const latest=normalizeOptions(await window.magpie.options.get());
          if(state.saving||isDirty()||JSON.stringify(latest)===JSON.stringify(state.saved))return;
          state.options=latest;state.saved=clone(latest);
          if(!currentBinding())state.selected=latest.bindings[0]?.id||null;
          drawAll();
        }catch{/* Keep the last loaded options on a temporary host reload. */}
      },5000);
      window.addEventListener('pagehide',()=>clearInterval(settingsTimer),{once:true});
      try {
        const providers = await window.magpie.read('providers:list');
        if (Array.isArray(providers) && providers.length) {
          const names = providers.slice(0, 12).map(provider => {
            if (!provider || typeof provider !== 'object') return '';
            return (typeof provider.name === 'string' && provider.name ? provider.name : provider.id) || '';
          }).filter(Boolean);
          $('providers-reference').textContent = '当前供应商：' + names.join('、') + '。模型 ID 请以 Magpie 中显示的内容为准。';
          $('providers-reference').hidden = names.length === 0;
        }
      } catch (_) { /* Provider names are optional; local editing remains available. */ }
    } catch (error) {
      $('connection-notice').textContent = String(error?.message || '无法读取本地设置，请重新打开插件页面。');
      $('connection-notice').hidden = false;
      $('connection-label').textContent = '未连接';
      updateSaveState('尚未读取本地设置');
    }
  }

  $('add-binding').addEventListener('click', safely(addBinding));
  $('refresh-page').addEventListener('click', safely(refreshPage));
  $('empty-add-binding').addEventListener('click', safely(addBinding));
  $('copy-binding').addEventListener('click', safely(copyBinding));
  $('manage-models').addEventListener('click', safely(openModelDrawer));
  $('close-model-drawer').addEventListener('click', safely(closeModelDrawer));
  $('done-model-drawer').addEventListener('click', safely(closeModelDrawer));
  $('model-drawer').addEventListener('cancel', safely(event => { event.preventDefault(); closeModelDrawer(); }));
  $('model-drawer').addEventListener('click', safely(event => {
    if (event.target !== $('model-drawer')) return;
    const rect = $('model-drawer').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModelDrawer();
  }));
  $('focus-editor').addEventListener('click', safely(() => setFocusEditor($('app-shell').dataset.focus !== 'true')));
  document.addEventListener('click', event => {
    for (const id of ['prompt-actions', 'status-details']) if (!$(id).contains(event.target)) $(id).open = false;
  });
  $('binding-search').addEventListener('input', safely(drawList));
  $('refresh-catalog').addEventListener('click', safely(refreshCatalog));
  $('diagnostic-request').addEventListener('change', safely(() => {
    selectedDiagnostic = $('diagnostic-request').value;
    drawRequestDiagnostic();
  }));
  $('model-search').addEventListener('input', safely(drawModelPicker));
  $('model-provider').addEventListener('change', safely(() => {
    replaceProviderOptions(state.catalogProviders);
    drawModelPicker();
  }));
  $('models-selected-only').addEventListener('change', safely(drawModelPicker));
  $('select-visible-models').addEventListener('click', safely(() => {
    const binding = currentBinding();
    if (!binding || state.saving) return;
    const occupied = occupiedModels();
    updateSelectedModels(binding.models.concat(state.visibleModels.filter(model => !occupied.has(model.id)).map(model => model.id)));
  }));
  $('clear-selected-models').addEventListener('click', safely(() => updateSelectedModels([])));
  $('injection-enabled').addEventListener('change', safely(() => {
    if (!state.options || state.saving) return;
    state.options.enabled = $('injection-enabled').checked;
    showError('');
    updateSaveState();
  }));
  for (const id of fieldIds) $(id).addEventListener('input', safely(onEdit));
  $('binding-form').addEventListener('submit', safely(event => { event.preventDefault(); void saveOptions(); }));
  $('save-options').addEventListener('click', () => { void saveOptions(); });
  $('delete-binding').addEventListener('click', safely(() => {
    $('prompt-actions').open = false;
    const binding = currentBinding();
    if (!binding || state.saving) return;
    const index = state.options.bindings.findIndex(item => item.id === binding.id);
    state.deleted.push({ binding: clone(binding), index });
    state.options.bindings.splice(index, 1);
    state.selected = state.options.bindings[Math.min(index, state.options.bindings.length - 1)]?.id || null;
    showError('');
    drawAll();
    updateSaveState('已从草稿移除提示词，保存前可撤销');
  }));
  $('undo-delete').addEventListener('click', safely(() => {
    if (state.saving) return;
    const deleted = state.deleted.pop();
    if (!deleted) return;
    state.options.bindings.splice(Math.min(deleted.index, state.options.bindings.length), 0, deleted.binding);
    state.selected = deleted.binding.id;
    $('binding-search').value = '';
    showError('');
    drawAll();
  }));
  $('discard-changes').addEventListener('click', safely(() => {
    if (!state.saved || state.saving) return;
    state.options = clone(state.saved);
    state.deleted = [];
    if (!currentBinding()) state.selected = state.options.bindings[0]?.id || null;
    showError('');
    drawAll();
  }));
  document.addEventListener('keydown', safely(event => {
    if ($('model-drawer').open) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModelDrawer();
        return;
      }
      if (event.key === 'Tab') {
        const targets = [...$('model-drawer').querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')]
          .filter(element => element.getClientRects().length > 0);
        const first = targets[0], last = targets[targets.length - 1];
        if (first && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (last && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    if (event.key === 'Escape' && !$('model-drawer').open) {
      const hadMenu = $('prompt-actions').open || $('status-details').open;
      $('prompt-actions').open = false;
      $('status-details').open = false;
      if (!hadMenu && $('app-shell').dataset.focus === 'true') { setFocusEditor(false); $('focus-editor').focus(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveOptions();
    }
  }));
  document.addEventListener('visibilitychange', safely(() => {
    if (!document.hidden) refreshCatalog();
  }));
  window.addEventListener('pagehide', disposeCatalogUpdates);
  void boot();
})();
