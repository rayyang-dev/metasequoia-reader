// 红杉阅读 —— 首次启动隐私政策弹窗回归（puppeteer-core + 系统 Chrome）
//
// 背景：华为审核按《应用审核指南》7.5 驳回「应用首次启动未以显著方式提示用户阅读
//       隐私政策」。v1.4.8 起新增 js/privacy-consent.js 弹窗，本测试固化为打包闸门。
//
// 两组场景：
//   A) 自动化环境（navigator.webdriver=true）应跳过弹窗，保证既有 UI 回归不被遮罩挡住；
//   B) 模拟真机（覆盖 webdriver）验证弹窗显著可见、双按钮无默认勾选、全文复用
//      LEGAL_CONTENT、同意后版本化落盘、reload 不再弹、政策版本变更后重新弹、
//      零外部请求、无页面错误。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
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
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---------- A) 自动化环境不插遮罩 ----------
  const autoPage = await browser.newPage();
  await autoPage.setViewport({ width: 412, height: 892 });
  if (typeof autoPage.setBypassServiceWorker === 'function') await autoPage.setBypassServiceWorker(true);
  await autoPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(400);
  const wd = await autoPage.evaluate(() => navigator.webdriver);
  check('Puppeteer 的 navigator.webdriver 标志可用', wd === true, { wd });
  const autoMask = await autoPage.$('#privacy-mask');
  check('自动化环境跳过弹窗（既有 UI 回归不被遮挡）', autoMask === null);
  check('自动化环境未写入同意状态（不污染测试）',
    await autoPage.evaluate(() => localStorage.getItem('inkreader:privacy-consent')) === null);
  await autoPage.close();

  // ---------- B) 模拟真机 ----------
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892 });
  if (typeof page.setBypassServiceWorker === 'function') await page.setBypassServiceWorker(true);
  // 覆盖 webdriver 让弹窗按真机逻辑显示；不动 localStorage，保持「首次启动」状态
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  });

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
    const t = m.text();
    if (/favicon/i.test(t)) return;
    errors.push('CONSOLE: ' + t);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#privacy-mask', { timeout: 6000 });

  const first = await page.evaluate(() => {
    const mask = document.getElementById('privacy-mask');
    const dlg = document.getElementById('privacy-dialog');
    const cs = mask ? getComputedStyle(mask) : null;
    const r = dlg ? dlg.getBoundingClientRect() : null;
    const atCenter = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      maskDisplay: cs && cs.display,
      maskPosition: cs && cs.position,
      zIndex: cs && cs.zIndex,
      dlgVisible: !!r && r.width > 200 && r.height > 200,
      centerInDialog: !!(atCenter && dlg && (dlg === atCenter || dlg.contains(atCenter))),
      title: document.getElementById('pc-title') && document.getElementById('pc-title').textContent,
      agreeText: document.getElementById('pc-agree') && document.getElementById('pc-agree').textContent.trim(),
      disagreeText: document.getElementById('pc-disagree') && document.getElementById('pc-disagree').textContent.trim(),
      checkboxes: document.querySelectorAll('#privacy-dialog input[type="checkbox"]').length,
      radios: document.querySelectorAll('#privacy-dialog input[type="radio"]').length,
      summary: document.querySelector('.pc-scroll') && document.querySelector('.pc-scroll').innerText,
      pending: window.__INK_PRIVACY_PENDING__,
    };
  });

  check('首次启动弹窗已显示', first.maskDisplay === 'flex' && first.dlgVisible, first);
  check('遮罩固定全屏且层级最高', first.maskPosition === 'fixed' && Number(first.zIndex) >= 100000, first);
  check('屏幕中心命中弹窗（遮罩挡住底层 UI）', first.centerInDialog, first);
  check('标题显著含「隐私政策」', /隐私政策/.test(first.title || ''), first.title);
  check('有「同意并继续」与「不同意」两个按钮',
    first.agreeText === '同意并继续' && first.disagreeText === '不同意', first);
  check('无默认勾选的复选框 / 单选框', first.checkboxes === 0 && first.radios === 0, first);
  check('弹窗口径与当前法律文案一致',
    /未开放/.test(first.summary || '') && /不申请相机权限/.test(first.summary || '') &&
    /不向任何第三方服务/.test(first.summary || '') && /无后端服务器/.test(first.summary || ''), first.summary);
  check('标记了「等待用户同意」状态', first.pending === true, first);

  // 点《隐私政策》→ 全文层，内容必须来自 LEGAL_CONTENT（不是新写的第六份文案）
  await page.click('[data-pc-doc="privacy"]');
  await wait(300);
  const full = await page.evaluate(() => ({
    docVisible: !document.getElementById('pc-doc').classList.contains('pc-hidden'),
    title: document.getElementById('pc-doc-title').textContent,
    text: document.getElementById('pc-doc-body').innerText,
  }));
  check('《隐私政策》全文层可打开', full.docVisible && full.title === '隐私政策', full.title);
  check('全文含「六、你的权利」与生效日期',
    /六、你的权利/.test(full.text) && /生效日期/.test(full.text), full.text.slice(0, 120));
  check('全文无「未开放功能却发数据给第三方」的旧描述',
    !/你主动启用 AI 功能时|将选中文本发送给|AI 内容免责|DeepL \/ OpenAI/.test(full.text), full.text.slice(0, 120));
  await page.click('#pc-doc-back');
  const backOk = await page.evaluate(() => !document.getElementById('pc-main').classList.contains('pc-hidden'));
  check('全文层可返回主弹窗', backOk);

  // 不同意 → 二次确认 → 返回
  await page.click('#pc-disagree');
  const exitConfirm = await page.evaluate(() => !document.getElementById('pc-exit').classList.contains('pc-hidden'));
  check('「不同意」进入二次确认，不直接退出', exitConfirm);
  await page.click('#pc-exit-back');
  const backMain = await page.evaluate(() => !document.getElementById('pc-main').classList.contains('pc-hidden'));
  check('二次确认可返回重新阅读', backMain);

  // 同意 → 落盘 → 弹窗移除
  await page.click('#pc-agree');
  await wait(150);
  const agreed = await page.evaluate(() => {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem('inkreader:privacy-consent') || 'null'); } catch (e) {}
    return {
      maskGone: document.getElementById('privacy-mask') === null,
      rec,
      pending: window.__INK_PRIVACY_PENDING__,
    };
  });
  check('同意后弹窗移除', agreed.maskGone, agreed);
  check('同意状态按版本写入 localStorage',
    !!(agreed.rec && agreed.rec.version === '1' && agreed.rec.agreed === true), agreed.rec);
  check('同意后清除等待标记', agreed.pending === false, agreed);

  // reload 不再弹
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(350);
  check('已同意用户 reload 后不再弹窗', await page.$('#privacy-mask') === null);

  // 政策版本变更后重新征求同意
  await page.evaluate(() => {
    localStorage.setItem('inkreader:privacy-consent', JSON.stringify({ version: '0', agreed: true }));
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(350);
  check('政策版本变更后老用户重新看到弹窗', await page.$('#privacy-mask') !== null);

  check('零外部网络请求', external.length === 0, external);
  check('无页面错误', errors.length === 0, errors);

  await page.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n隐私弹窗回归：${passed} passed, ${failed} failed`);
if (fails.length) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
