// 红杉阅读 —— 送审构建开关回归（puppeteer-core + 系统 Chrome）
//
// 背景：v1.4.6 起，AGC「应用隐私权限说明」会因 CAMERA 权限要求说明话术与场景截图包。
//       送审版从 AndroidManifest 移除相机权限，并用 release-gate.js 的两个开关隐藏
//       AI / 在线翻译 / 视线翻页入口。此前这套校验是一次性脚本，现固化为打包闸门。
//
// 校验 17 项：开关状态、<html> 标记、AI 与视线入口零可见、定时/跟节奏仍可用、
//             权限说明页与法律页文案一致、历史设置被清零、零外部请求、无页面错误。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: (process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892 });
  if (typeof page.setBypassServiceWorker === 'function') await page.setBypassServiceWorker(true);

  const external = [];
  const errors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/^(data|blob|about|chrome-extension):/.test(u)) return;
    if (!u.startsWith(BASE)) external.push(u);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    if (/favicon/i.test(txt) || /favicon\.ico/i.test((m.location() || {}).url || '')) return;
    errors.push('CONSOLE: ' + txt);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900));

  // ① 开关与 <html> 标记
  const flags = await page.evaluate(() => ({
    ai: window.INK_AI_ENABLED,
    camera: window.INK_CAMERA_ENABLED,
    aiHide: document.documentElement.classList.contains('ai-review-hide'),
    cameraHide: document.documentElement.classList.contains('camera-review-hide'),
    init: !!window.__INK_INIT_DONE,
  }));
  check('INK_AI_ENABLED === false', flags.ai === false, flags);
  check('INK_CAMERA_ENABLED === false', flags.camera === false, flags);
  check('<html> 同时带 ai-review-hide / camera-review-hide', flags.aiHide && flags.cameraHide, flags);
  check('应用正常初始化（隐藏元素未导致 getElementById 报错）', flags.init === true, flags);

  // ② 历史设置清零：模拟老用户从「含 gaze / 在线翻译」的版本升级。
  //    必须放在任何点击之前——一旦开启自动翻页，运行中的定时器会把内存里的 settings
  //    写回 localStorage，覆盖掉注入的升级前快照，导致这一段测不到真实效果。
  await page.evaluate(() => {
    localStorage.setItem('inkreader:settings', JSON.stringify({
      autoMode: 'gaze', translateProvider: 'openai', aiAutoSummary: true,
      gazeEngine: 'sim', theme: 'ink', fontSize: 20
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 700));
  const cleaned = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('inkreader:settings')) || {}; }
    catch (e) { return {}; }
  });
  check('历史 autoMode=gaze 被清零为 off', cleaned.autoMode === 'off', cleaned);
  check('历史 translateProvider / aiAutoSummary 被清零',
    cleaned.translateProvider === 'none' && cleaned.aiAutoSummary === false, cleaned);
  check('其余设置原样保留（theme / fontSize）',
    cleaned.theme === 'ink' && cleaned.fontSize === 20, cleaned);

  // ③ AI / 在线翻译入口零可见
  const aiVisible = await page.evaluate(() => {
    const ids = ['settings-group-ai', 'btn-ai', 'panel-ai', 'sel-translate', 'sel-ai', 'translate-pop', 'ai-explain-pop'];
    return ids.filter((id) => {
      const el = document.getElementById(id);
      return el && getComputedStyle(el).display !== 'none';
    });
  });
  check('AI / 在线翻译入口 0 可见', aiVisible.length === 0, aiVisible);

  // ④ 视线翻页（相机）入口零可见
  const camVisible = await page.evaluate(() => Array.from(document.querySelectorAll('.camera-feature-only'))
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => el.tagName + '#' + (el.id || '') + '.' + (el.className || '')));
  check('.camera-feature-only 元素全部隐藏', camVisible.length === 0, camVisible);
  const gazeBtn = await page.evaluate(() => {
    const b = document.querySelector('#pro-mode button[data-mode="gaze"]');
    return { exists: !!b, display: b ? getComputedStyle(b).display : null };
  });
  check('自动翻页「视线」按钮不可见', gazeBtn.exists && gazeBtn.display === 'none', gazeBtn);

  // ⑤ 与相机无关的能力仍可用（不能误伤）。
  //    #pro-panel 默认收起，按钮 getBoundingClientRect().width 为 0 属正常，
  //    所以这里只判断「自身未被 display:none / 未被打上 camera-feature-only」，再补一次真实点击。
  const kept = await page.evaluate(() => {
    const timed = document.querySelector('#pro-mode button[data-mode="timed"]');
    const adaptive = document.querySelector('#pro-mode button[data-mode="adaptive"]');
    const blocked = (el) => {
      if (!el) return true;
      if (el.classList.contains('camera-feature-only')) return true;
      if (getComputedStyle(el).display === 'none') return true;
      const row = el.closest('.pro-row');
      return !!row && getComputedStyle(row).display === 'none';
    };
    return { timed: !blocked(timed), adaptive: !blocked(adaptive) };
  });
  check('定时 / 跟节奏自动翻页按钮未被隐藏规则误伤', kept.timed && kept.adaptive, kept);

  await page.evaluate(() => {
    const b = document.querySelector('#pro-mode button[data-mode="timed"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const timedMode = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('inkreader:settings')) || {}).autoMode; }
    catch (e) { return null; }
  });
  check('点击「定时」仍生效（setMode 兜底未误伤非相机模式）', timedMode === 'timed', timedMode);

  // ⑥ 应用内权限说明页口径与 manifest 一致
  await page.evaluate(() => {
    const b = document.querySelector('[data-legal="permissions"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 350));
  const legal = await page.evaluate(() => {
    const body = document.getElementById('legal-body');
    const notice = document.getElementById('ink-review-legal-notice');
    const camLi = Array.from(document.querySelectorAll('#legal-body li'))
      .find((li) => /相机（CAMERA/.test(li.textContent));
    return {
      text: body ? body.innerText : '',
      notice: notice ? notice.innerText : '',
      camLiHidden: !camLi || getComputedStyle(camLi).display === 'none',
      hasNoPermClaim: body ? /不申请定位、通讯录、麦克风、电话、短信等敏感权限/.test(body.innerText) : false,
    };
  });
  check('权限说明页「相机（CAMERA）」条款已隐藏', legal.camLiHidden, legal);
  check('权限说明页仍保留「不申请定位/通讯录/…」正面声明', legal.hasNoPermClaim, legal);
  check('法律页顶部送审说明写明「不申请相机权限」', /不申请相机权限/.test(legal.notice), legal.notice);

  // ⑦ 零外发 + 无页面错误
  check('全程零外部网络请求', external.length === 0, external);
  check('无 pageerror / console error', errors.length === 0, errors);

  console.log(`\nreview-gate: ${passed} passed, ${failed} failed` + (failed ? `  [${fails.join('; ')}]` : ''));
} catch (e) {
  console.error('review-gate: 运行异常 ——', e && e.stack ? e.stack : e);
  failed++;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
