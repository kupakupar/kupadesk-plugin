const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.argv[2]);
const url = process.argv[3], executablePath = process.argv[4];
const size = options => Buffer.byteLength(JSON.stringify({spec: 'github:kupakupar/kupadesk-plugin', options}));

(async () => {
  const browser = await chromium.launch({headless: true, executablePath});
  const results = [], errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1000, height: 900}});
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    let writes = 0;
    page.on('request', r => {if (r.method() === 'POST' && r.url().endsWith('/api/options')) writes++;});
    await page.goto(url);
    assert.equal(await page.locator('meta[name="preview-data"]').getAttribute('content'), 'synthetic');
    const initial = await (await page.request.get(url + 'api/options')).json();
    const frame = page.frameLocator('#plugin-preview');
    const ready = () => frame.locator('#connection-label[data-connected="true"]').waitFor();
    const edit = async prompt => {
      await frame.locator('#prompt-pane').evaluate(el => {el.open = true;});
      await frame.locator('#binding-prompt').evaluate((el, text) => {
        el.value = text; el.dispatchEvent(new Event('input', {bubbles: true}));
      }, prompt);
    };
    const saved = async prompt => {
      await frame.locator('#save-options').click();
      await frame.locator('#save-status[data-saved="true"]').waitFor();
      const actual = await (await page.request.get(url + 'api/options')).json();
      assert.equal(actual.bindings[0].prompt === prompt, true);
      assert.deepEqual(actual.bindings.map(b => b.models), initial.bindings.map(b => b.models));
      assert.ok(size(actual) <= 64 * 1024);
      await page.reload(); await ready();
      assert.equal((await frame.locator('#binding-prompt').inputValue()) === prompt, true);
      return actual;
    };
    await ready();
    for (const theme of ['dark', 'light']) {
      await page.selectOption('#preview-theme', theme);
      for (const prompt of ['字'.repeat(19300), 'x'.repeat(32769)]) {
        await edit(prompt);
        const actual = await saved(prompt);
        assert.match(await frame.locator('#storage-meter').textContent(), /\/ 64 KB/);
        results.push({theme, chars: prompt.length, requestBytes: size(actual), saveAndReload: true});
      }
      for (const delta of [-1, 0, 1]) {
        const draft = await (await page.request.get(url + 'api/options')).json();
        draft.bindings[0].prompt = '中文😀\n"\\';
        draft.bindings[0].prompt += 'x'.repeat(64 * 1024 + delta - size(draft));
        const prompt = draft.bindings[0].prompt;
        await edit(prompt);
        if (delta <= 0) {
          const actual = await saved(prompt);
          assert.equal(size(actual), 64 * 1024 + delta);
          results.push({theme, requestBytes: size(actual), saveAndReload: true});
        } else {
          const before = writes;
          const original = await (await page.request.get(url + 'api/options')).text();
          await frame.locator('#save-options').click();
          await frame.locator('#save-error').filter({hasText: '超过 64 KB'}).waitFor();
          assert.equal(writes, before, 'oversized draft never sent to the host');
          assert.equal((await frame.locator('#binding-prompt').inputValue()) === prompt, true);
          assert.equal(await (await page.request.get(url + 'api/options')).text(), original);
          results.push({theme, requestBytes: 64 * 1024 + delta, blockedBeforeSave: true, completeDraftPreserved: true});
        }
      }
      await page.reload(); await ready();
    }
    const contentFrame = await page.locator('#plugin-preview').elementHandle().then(h => h.contentFrame());
    await contentFrame.evaluate(() => {window.magpie.options.set = async () => {throw Error('http: request body too large');};});
    const draft = 'UNSAVED_DRAFT\n' + '字'.repeat(1000);
    await edit(draft); await frame.locator('#save-options').click();
    await frame.locator('#save-error').filter({hasText: '64 KB'}).waitFor();
    assert.equal((await frame.locator('#binding-prompt').inputValue()) === draft, true);
    assert.equal(errors.length, 0);
    const output = path.resolve(__dirname, '../evidence/browser-64');
    fs.mkdirSync(output, {recursive: true});
    await page.screenshot({path: path.join(output, 'budget.png'), fullPage: true});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({results, hostFailureKeepsDraft: true, browserErrors: errors}, null, 2));
    console.log(JSON.stringify({cases: results.length, hostFailureKeepsDraft: true, browserErrors: errors}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
