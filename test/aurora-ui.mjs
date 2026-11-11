// 红杉能力中心（Aurora）面板布局回归 —— 独立文件，零污染、可整体回退。
// 删除本文件 + package.json 中 test 链的 `node test/aurora-ui.mjs` 即可完全撤销，
// 不触碰任何业务代码。
//
// 背景：v1.4.5 真机截图报「能力中心 200 项清单与设置页文字逐行重叠」。
// 根因：js/aurora.js 生成的 DOM 少了 #aurora-sheet 容器，而 css/aurora.css 把
// #aurora-head 当成「整张底部卡片」，于是标题栏缩成左下角小卡片、清单透明铺满全屏。
// 本用例断言：卡片不透明且贴底占满宽度、标题栏在卡片顶部且 ✕ 在右侧、
// 清单被限制在卡片内部滚动、清单所在位置点到的不是设置页控件。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
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
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const txt = m.text();
  if (/favicon/i.test(txt) || /favicon/i.test((m.location() || {}).url || '')) return;
  errors.push('CONSOLE: ' + txt);
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
  if (!ok) fail.push(label);
};

let layout = null;
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(900);

  // 用 DOM click 切页，避免底部 tab / 控制条的可见性干扰用例本身
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await wait(200);
  const hasEntry = await page.evaluate(() => !!document.querySelector('[data-aurora-open]'));
  check(hasEntry, '设置页存在「红杉能力中心」入口');
  await page.evaluate(() => document.querySelector('[data-aurora-open]').click());
  await wait(300);

  layout = await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const panel = $('aurora-panel'), sheet = $('aurora-sheet');
    const head = $('aurora-head'), body = $('aurora-body'), close = $('aurora-close');
    if (!panel || !sheet || !head || !body || !close) {
      return { missing: ['aurora-panel', 'aurora-sheet', 'aurora-head', 'aurora-body', 'aurora-close']
        .filter((id) => !$(id)) };
    }
    const bg = getComputedStyle(sheet).backgroundColor;
    const sr = sheet.getBoundingClientRect(), hr = head.getBoundingClientRect();
    const br = body.getBoundingClientRect(), cr = close.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    // 卡片中心点必须命中卡片内部，而不是透出底下的设置页
    const centerEl = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
    const hitCenter = centerEl ? (centerEl.id || centerEl.className || centerEl.tagName) : null;
    const hitCenterInsideSheet = !!centerEl && sheet.contains(centerEl);

    const row = body.querySelector('.au-row');
    let hit = null, hitInsideBody = false;
    if (row) {
      // 清单首行初始被「我的红杉 / 搜索框 / 分组 tab」顶到视口之外，先滚进可视区再取样，
      // 否则 elementFromPoint 会因坐标在视口外返回 null。
      const br0 = body.getBoundingClientRect();
      const rr0 = row.getBoundingClientRect();
      body.scrollTop += (rr0.top - br0.top) - 8;
      const rr = row.getBoundingClientRect();
      const x = rr.left + Math.min(rr.width / 2, 80);
      const y = rr.top + Math.min(rr.height / 2, 20);
      const el = document.elementFromPoint(x, y);
      hit = el ? (el.id || el.className || el.tagName) : null;
      hitInsideBody = !!el && body.contains(el);
    }
    return {
      panelHidden: panel.classList.contains('hidden'),
      sheetIsPanelChild: sheet.parentElement === panel,
      headInSheet: head.parentElement === sheet,
      bodyInSheet: body.parentElement === sheet,
      bg,
      opaque: bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(bg),
      sheetWidthRatio: +(sr.width / vw).toFixed(3),
      sheetHeightRatio: +(sr.height / vh).toFixed(3),
      sheetBottomRatio: +(sr.bottom / vh).toFixed(3),
      headWidthRatio: +(hr.width / vw).toFixed(3),
      closeAtRight: cr.left > sr.left + sr.width * 0.75,
      closeInsideHead: head.contains(close),
      bodyInsideSheet: br.top >= sr.top - 1 && br.bottom <= sr.bottom + 1,
      bodyScrollable: body.scrollHeight > body.clientHeight + 10,
      rowCount: body.querySelectorAll('.au-row').length,
      hitCenterInsideSheet, hitCenter, hitInsideBody, hit,
    };
  });

  if (layout.missing) {
    check(false, '能力中心 DOM 齐全', '缺少 ' + layout.missing.join(', '));
  } else {
    console.log('\n布局快照:', JSON.stringify(layout, null, 2), '\n');
    check(!layout.panelHidden, '点击入口后面板已打开');
    check(layout.sheetIsPanelChild, '#aurora-sheet 是遮罩的直接子卡片');
    check(layout.headInSheet && layout.bodyInSheet, '标题栏与清单都在卡片内部');
    check(layout.opaque, '卡片有不透明纸底', layout.bg);
    check(layout.sheetWidthRatio > 0.9, '卡片占满屏宽（不是左下角小浮层）', layout.sheetWidthRatio);
    check(layout.sheetHeightRatio > 0.5 && layout.sheetHeightRatio <= 0.95,
      '卡片高度在合理范围（底部弹出、受 92vh 约束）', layout.sheetHeightRatio);
    check(layout.sheetBottomRatio > 0.98, '卡片贴底', layout.sheetBottomRatio);
    check(layout.headWidthRatio > 0.9, '标题栏横向铺满卡片', layout.headWidthRatio);
    check(layout.closeInsideHead && layout.closeAtRight, '✕ 关闭按钮在标题栏右侧');
    check(layout.bodyInsideSheet, '清单被约束在卡片内部');
    check(layout.bodyScrollable, '清单在卡片内可滚动');
    check(layout.rowCount >= 190, '200 项清单完整渲染', layout.rowCount);
    check(layout.hitCenterInsideSheet, '卡片中心点命中的是卡片内容而非设置页', layout.hitCenter);
    check(layout.hitInsideBody, '清单区域点击命中的是清单本身而非设置页', layout.hit);

    const shot = process.env.INK_AURORA_SHOT;
    if (shot) { await page.screenshot({ path: shot }); console.log('截图:', shot); }

    await page.evaluate(() => document.getElementById('aurora-close').click());
    await wait(150);
    const closed = await page.evaluate(() => document.getElementById('aurora-panel').classList.contains('hidden'));
    check(closed, '✕ 可关闭面板');
  }
  check(errors.length === 0, '无致命 console / page error', errors.join(' | ') || '0');
} catch (e) {
  check(false, '用例执行未抛异常', e && e.stack ? e.stack : String(e));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n结果：${fail.length === 0 ? '全部通过' : fail.length + ' 项失败'} ${fail.join(' / ')}`);
process.exit(fail.length === 0 ? 0 : 1);
