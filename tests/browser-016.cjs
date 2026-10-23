const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.argv[2] || 'playwright');
const url = process.argv[3];
const output = path.resolve(__dirname, '../evidence/browser');
const executablePath = process.argv[4];
fs.mkdirSync(output, {recursive: true});

(async () => {
  const browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  const errors = [], report = [];
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    assert.equal(await page.locator('meta[name="preview-data"]').getAttribute('content'), 'synthetic', 'never run writing browser checks against private settings');
    const reset = await (await page.request.get(url + 'api/options')).json();
    delete reset.view; delete reset.diagnostics;
    const resetResponse = await page.request.post(url + 'api/options', {headers: {Origin: new URL(url).origin, 'X-Kupa-Preview': '1'}, data: reset});
    assert.equal(resetResponse.status(), 200); await page.reload();
    const f = page.frameLocator('#plugin-preview');
    await f.locator('#connection-label[data-connected="true"]').waitFor();
    const initial = await (await page.request.get(url + 'api/options')).json();
    assert.equal(await f.locator('#prompt-pane').getAttribute('open'), null, 'prompt body starts collapsed');
    await f.locator('#prompt-pane summary').click();
    assert.notEqual(await f.locator('#prompt-pane').getAttribute('open'), null);
    await f.locator('#open-preferences').click();
    await f.locator('[data-hide-provider="deepseek"]').check();
    await f.locator('#pref-compact-models').check();
    await f.locator('#done-preferences').click();
    await f.locator('#manage-models').click();
    assert.equal(await f.locator('[data-model-id="deepseek/deepseek-flash"]').count(), 0);
    assert.match(await f.locator('#hidden-model-notice').textContent(), /1 个已绑定模型继续生效/);
    assert.equal(await f.locator('#bound-model-summary').textContent(), '已绑定 1 个模型');
    await f.locator('[data-favorite-id="codex/gpt-6.1-sol"]').click();
    assert.equal(await f.locator('#model-list [data-model-id]').first().getAttribute('data-model-id'), 'codex/gpt-6.1-sol');
    assert.equal(await f.locator('[data-model-id="codex/gpt-6.1-sol"]').isChecked(), false, 'favorite does not bind');
    await f.locator('#models-favorites-only').check();
    assert.equal(await f.locator('#model-list [data-model-id]').count(), 1);
    await f.locator('#models-favorites-only').uncheck();
    await f.locator('#models-show-hidden').check();
    assert.equal(await f.locator('[data-model-id="deepseek/deepseek-flash"]').isChecked(), true);
    await f.locator('#models-show-hidden').uncheck();
    await f.locator('#done-model-drawer').click();
    const staged = await (await page.request.get(url + 'api/options')).json();
    assert.deepEqual(staged, initial, 'view changes remain a draft until Save');
    await f.locator('#save-options').click();
    await f.locator('#save-status[data-saved="true"]').waitFor();
    const saved = await (await page.request.get(url + 'api/options')).json();
    assert.deepEqual(saved.bindings, initial.bindings, 'preferences preserve exact prompts and bindings');
    assert.deepEqual(saved.view.hiddenProviders, ['deepseek']);
    assert.deepEqual(saved.view.favoriteModels, ['codex/gpt-6.1-sol']);
    await page.reload();
    await f.locator('#connection-label[data-connected="true"]').waitFor();
    assert.equal(await f.locator('#prompt-pane').getAttribute('open'), null, 'collapsed default survives reload');
    await f.locator('#manage-models').click();
    assert.equal(await f.locator('#model-list [data-model-id]').first().getAttribute('data-model-id'), 'codex/gpt-6.1-sol');
    assert.equal(await f.locator('#model-list').getAttribute('data-compact'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await f.locator('#model-drawer').getAttribute('open'), null);
    await f.locator('#open-preferences').click();
    await f.locator('#pref-collapse-prompt').uncheck();
    await f.locator('#pref-integrity').uncheck();
    await f.locator('#pref-route-attempts').uncheck();
    await f.locator('#done-preferences').click();
    await f.locator('#discard-changes').click();
    await f.locator('#open-preferences').click();
    assert.equal(await f.locator('#pref-collapse-prompt').isChecked(), true);
    assert.equal(await f.locator('#pref-integrity').isChecked(), true);
    assert.equal(await f.locator('#pref-route-attempts').isChecked(), true);
    await page.keyboard.press('Escape');
    assert.equal(await f.locator('#preferences-dialog').getAttribute('open'), null);
    // Supply clearly synthetic diagnostic states through the real catalog path.
    const frame = page.frames().find(x => x.url().includes('/plugin/'));
    const fixtureCatalog = await frame.evaluate(() => {
      const same = {tools: {state: 'same', before: 11, after: 11}, thinking: {state: 'same', before: 1, after: 1}, history: {state: 'same', before: 6, after: 6}};
      const row = {id: '1', at: new Date().toISOString(), outcome: 'injected', requested: 'deepseek/deepseek-flash', accepted: 'present',
        completion: 'success', binding: {state: 'matched', name: '示例 · 工作助手', models: ['deepseek/deepseek-flash']},
        checks: {plugin: same, host: same}, route: {state: 'matched', provider: 'deepseek', model: 'deepseek-flash', total: 2,
          attemptState: 'recorded', attempts: [{provider: 'devin', model: 'gemini-4-argon', status: 503, handedOn: true},
            {provider: 'deepseek', model: 'deepseek-flash', status: 200, effort: 'high'}]}};
      window.KUPADESK_MODEL_CATALOG.injection = {recent: [row, {...row, id: '2', checks: {plugin: {...same, tools: {state: 'changed', before: 11, after: 0}}, host: {state: 'pending'}}, route: {state: 'no-response-id'}}]};
      return JSON.stringify(window.KUPADESK_MODEL_CATALOG);
    });
    await page.route('**/*model-catalog.js*', route => route.fulfill({contentType: 'text/javascript', body: 'window.KUPADESK_MODEL_CATALOG = ' + fixtureCatalog + ';'}));
    await f.locator('#status-details > summary').click();
    await f.locator('#refresh-catalog').click();
    await f.locator('#diagnostic-request:not([disabled])').waitFor({state: 'attached'});
    await f.locator('#status-details > summary').click();
    await f.locator('#request-diagnostics summary').first().click();
    await f.locator('#diagnostic-request').selectOption('1');
    assert.match(await f.locator('#check-plugin-tools').textContent(), /保持一致.*11 → 11/);
    await f.locator('#route-details summary').click();
    assert.equal(await f.locator('#route-attempts li').count(), 2);
    await f.locator('#diagnostic-request').selectOption('2');
    assert.match(await f.locator('#check-plugin-tools').textContent(), /发现变化.*11 → 0/);
    assert.equal(await f.locator('#check-host-tools').textContent(), '等待回调');
    await f.locator('#diagnostic-request').selectOption('1');
    for (const width of [1440, 800, 440, 320]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({width, height: 1000});
      await page.locator('#preview-width').selectOption('full');
      await page.locator('#preview-theme').selectOption(theme);
      assert.equal(await f.locator('html').getAttribute('data-theme'), theme);
      const geometry = await frame.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(geometry.scroll <= geometry.width + 1, 'no document horizontal overflow: ' + width);
      await page.screenshot({path: path.join(output, `${width}-${theme}-diagnostics.png`)});
      // Check actual settings and drawer geometry, not just the empty shell.
      await f.locator('#open-preferences').click();
      const settings = await f.locator('#preferences-dialog').boundingBox();
      assert.ok(settings.width <= width && settings.x >= 0 && settings.height <= 1000);
      const contrast = await frame.evaluate(() => {
        const box = document.getElementById('preferences-dialog'), test = document.createElement('span');
        box.append(test);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const rgb = color => {ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);};
        const lum = value => rgb(value).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0);
        const background = lum(getComputedStyle(box).backgroundColor), result = {};
        for (const key of ['text', 'secondary', 'success']) {
          test.style.color = 'var(--' + key + ')'; const color = lum(getComputedStyle(test).color);
          result[key] = (Math.max(color, background) + .05) / (Math.min(color, background) + .05);
        }
        test.remove(); return result;
      });
      assert.ok(Object.values(contrast).every(x => x >= 4.5), 'flat-surface text contrast ' + JSON.stringify(contrast));
      await page.screenshot({path: path.join(output, `${width}-${theme}-settings.png`)});
      await f.locator('#done-preferences').click();
      await f.locator('#manage-models').click();
      await page.screenshot({path: path.join(output, `${width}-${theme}-models.png`)});
      await f.locator('#done-model-drawer').click();
      report.push({width, theme, diagnostics: true, settings: true, bindings: true, horizontalOverflow: false, contrast});
    }
    await context.close();
    for (const state of ['empty', 'error', 'save-error']) {
      const ctx = await browser.newContext({viewport: {width: 800, height: 900}, reducedMotion: 'reduce'});
      const p = await ctx.newPage(); p.on('pageerror', error => errors.push(error.message));
      if (state !== 'save-error') await p.route('**/api/options', route => route.fulfill({contentType: 'application/json',
        body: JSON.stringify(state === 'empty' ? {schemaVersion: 1, enabled: false, bindings: []} : {schemaVersion: 99})}));
      else await p.route('**/api/options', route => route.request().method() === 'POST' ? route.fulfill({status: 503, body: '{}'}) : route.continue());
      await p.goto(url); const frame = p.frameLocator('#plugin-preview');
      if (state === 'error') {
        await frame.locator('#connection-notice:not([hidden])').waitFor();
        assert.equal(await frame.locator('#open-preferences').isDisabled(), true);
      } else {
        await frame.locator('#connection-label[data-connected="true"]').waitFor();
        if (state === 'empty') {
          await frame.locator('#empty-state:not([hidden])').waitFor();
          await frame.locator('#empty-add-binding').click();
          assert.notEqual(await frame.locator('#prompt-pane').getAttribute('open'), null, 'new prompts open directly for editing');
        } else {
          await frame.locator('#binding-name').fill('示例 · 未保存的草稿');
          await frame.locator('#save-options').click();
          await frame.locator('#save-error:not([hidden])').waitFor();
          assert.equal(await frame.locator('#binding-name').inputValue(), '示例 · 未保存的草稿');
        }
      }
      await p.screenshot({path: path.join(output, 'state-' + state + '.png')}); await ctx.close();
    }
    assert.deepEqual(errors, [], 'no browser errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({matrix: report, states: ['empty', 'error', 'save-error'], behaviorChecks: true, promptsAndBindingsPreserved: true, errors}, null, 2));
    console.log(JSON.stringify({matrix: report.length, hiddenProviders: true, favorites: true, collapse: true, diagnostics: true, persistence: true, promptsAndBindingsPreserved: true, browserErrors: errors.length}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
