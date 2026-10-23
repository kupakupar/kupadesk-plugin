'use strict';
document.title = 'KupaDesk 016 · 独立预览';
document.querySelector('header strong').textContent = 'KupaDesk 016 · 独立预览';
document.querySelector('header p').textContent = document.querySelector('meta[name="preview-data"]')?.content === 'synthetic'
  ? '示例数据 · 仅供界面验收，不是你的真实请求' : '设置副本 · 不会写入现用 015';
const frame = document.getElementById('plugin-preview');
const themeControl = document.getElementById('preview-theme');
const theme = () => ({dark: themeControl.value === 'dark', lang: 'zh-CN'});
window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.magpie !== 1) return;
  const {id, method, params} = event.data;
  if (method === 'error') { console.error('Preview page: ' + params?.message); return; }
  let result, error;
  try {
    if (method === 'hello') result = theme();
    else if (method === 'options.get') {
      const response = await fetch('/api/options');
      if (!response.ok) throw Error('无法读取预览副本');
      result = await response.json();
    } else if (method === 'options.set') {
      const response = await fetch('/api/options', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Kupa-Preview': '1'}, body: JSON.stringify(params.options)});
      if (!response.ok) throw Error('无法保存预览副本');
      result = await response.json();
    } else if (method === 'read' && params?.name === 'providers:list') result = [];
    else throw Error('预览未提供此能力');
  } catch (reason) { error = reason.message; }
  frame.contentWindow.postMessage({magpie: 1, id, result, error}, location.origin);
});
themeControl.addEventListener('change', () => {
  document.body.dataset.theme = themeControl.value;
  frame.contentWindow.postMessage({magpie: 1, event: 'theme', data: theme()}, location.origin);
});
document.getElementById('preview-width').addEventListener('change', event => {
  frame.style.width = event.target.value === 'full' ? '100%' : `min(100%, ${Number(event.target.value)}px)`;
});
