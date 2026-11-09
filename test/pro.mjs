// 水杉 Pro —— 翻页编排层 + 视线回扫状态机 端到端回归（真实 Chrome + 纯逻辑注入）
// 不依赖真机摄像头：用 SimulatedSource 注入视线 y，把「闭环」跑完整：
// 串行化 / 冷却 / 撤销 / 预告取消 / 暂停门控 / 回扫识别 / 防连翻 / 校准 / 释放。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream',
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
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon/i.test(t) || /favicon\.ico/i.test((m.location() || {}).url || '')) return;
  errors.push('CONSOLE: ' + t);
});
page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) {} });
// 跳过首次引导与 SW 接管刷新，避免干扰逻辑断言
await page.evaluateOnNewDocument(() => {
  try {
    sessionStorage.setItem('sw-reloaded', '1');
    localStorage.setItem('inkreader:pro-guide-v1', '1');
  } catch (e) {}
});

const results = [];
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 700));

  const ui = await page.evaluate(() => ({
    init: !!window.__INK_INIT_DONE,
    proReady: !!window.__INK_PRO,
    bar: !!document.getElementById('pro-bar'),
    chip: !!document.getElementById('pro-chip'),
    panel: !!document.getElementById('pro-panel'),
    css: Array.from(document.styleSheets).some((s) => (s.href || '').includes('pro.css')),
  }));
  results.push({ name: 'Pro 层挂载（进度条 / chip / 面板 / CSS / 无阻断）', pass: ui.init && ui.proReady && ui.bar && ui.chip && ui.panel && ui.css, extra: ui });

  const logic = await page.evaluate(async () => {
    const out = [];
    const check = (name, cond, extra) => out.push({ name, pass: !!cond, extra });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { createTurnController } = await import('/js/turn.js');
    const { createGazeEngine } = await import('/js/gaze.js');

    // ---- 1. 翻页编排层：串行化 / 冷却 / 撤销 ----
    let pos = { ci: 0, pi: 0 }, running = 0, maxConcurrent = 0, performed = 0;
    const turn = createTurnController({
      perform: async (dir) => {
        running++; maxConcurrent = Math.max(maxConcurrent, running);
        await sleep(14); // 模拟 PDF 异步渲染，若未串行就会并发写 DOM
        pos = { ci: 0, pi: pos.pi + (dir === 'next' ? 1 : -1) };
        performed++; running--;
      },
      getPosition: () => ({ ...pos }),
      restore: async (p) => { pos = { ...p }; },
      canTurn: () => true,
      cooldownMs: 0,
    });
    await Promise.all([
      turn.request('next', 'manual'), turn.request('next', 'manual'),
      turn.request('next', 'gaze'), turn.request('next', 'timed'),
    ]);
    check('串行化：任何时刻只有一个翻页在跑', maxConcurrent === 1, { maxConcurrent });
    check('四次请求全部执行且无丢失', performed === 4, { performed, pi: pos.pi });
    await turn.undo();
    check('撤销回到刚才那一页', pos.pi === 3, { pi: pos.pi });

    // ---- 2. 预告可取消 ----
    turn.setBeforeTurn(async () => false);
    await turn.request('next', 'timed');
    check('预告被取消时不翻页', pos.pi === 3, { pi: pos.pi });
    turn.setBeforeTurn(null);

    // ---- 3. 暂停只挡自动来源，手动永远可用 ----
    turn.pause('面板已打开');
    await turn.request('next', 'timed');
    check('暂停时自动翻页被挡下', pos.pi === 3, { pi: pos.pi });
    await turn.request('next', 'manual');
    check('暂停时手动翻页仍可响应', pos.pi === 4, { pi: pos.pi });
    turn.resume();

    // ---- 4. 视线回扫状态机（模拟源，无需摄像头） ----
    let signals = 0;
    const phases = [];
    const cfg = {
      gazeEngine: 'sim', gazeSensitivity: 3, gazeDwellMs: 60,
      gazeCooldownMs: 1500, gazeSampleMs: 10, autoConfirmMs: 0,
    };
    const gaze = createGazeEngine({
      onSignal: () => { signals++; },
      onStatus: (s) => { phases.push(s.phase); },
      getConfig: () => cfg,
    });
    const started = await gaze.start();
    check('模拟视线引擎启动成功', started.ok && gaze.isSimulated(), started);

    gaze.simulate(0.95); // 视线在页底
    await sleep(320);
    check('仅「看到页底」不翻页（挡住低头/看图片误触）', signals === 0, { signals, phases });

    gaze.simulate(0.08); // 回扫到页首
    await sleep(300);
    check('回扫动作触发恰好一次翻页', signals === 1, { signals, phases });

    gaze.simulate(0.95); await sleep(120);
    gaze.simulate(0.08); await sleep(160);
    check('冷却期内重复回扫不连翻', signals === 1, { signals });

    check('校准流程可启动', gaze.calibrate() === true);
    gaze.pause('测试暂停');
    check('暂停后状态可查询', gaze.getPhase() === 'paused', { phase: gaze.getPhase() });
    await gaze.resume();
    check('恢复后回到追踪', gaze.getPhase() === 'tracking', { phase: gaze.getPhase() });
    gaze.stop();
    check('停止后不再运行（摄像头/帧循环已释放）', !gaze.isRunning());

    return out;
  });
  results.push(...logic);
} catch (e) {
  results.push({ name: '测试执行', pass: false, extra: String(e && e.message ? e.message : e) });
}

let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ' + JSON.stringify(r.extra)}`);
  if (r.pass) pass++;
}
console.log(`\n${pass}/${results.length} 通过，页面错误 ${errors.length} 条`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
await browser.close();
server.close();
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
