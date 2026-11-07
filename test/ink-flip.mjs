// 水墨翻页回归：验证「按视口生成 / 方向镜像 / 换页时序 / 异常清理 / 明显更快」。
// 用真实 Chrome 的 Web Animations API 跑，和真机同一条代码路径。
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import http from 'http';

const PORT = 4187;
const BASE = `http://localhost:${PORT}/`;
const server = spawn(process.execPath, ['test/serve.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 等服务起来（最多 5 秒）
for (let i = 0; i < 50; i++) {
  const ok = await new Promise((resolve) => {
    http.get(BASE + 'flip-preview.html', (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
  if (ok) break;
  await wait(100);
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon/i.test(t)) return;
  errors.push('CONSOLE: ' + t);
});

const results = [];
try {
  await page.goto(BASE + 'flip-preview.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(500);
  const boot = await page.evaluate(() => ({
    errHidden: getComputedStyle(document.getElementById('err')).display === 'none',
    title: document.getElementById('title').textContent,
    bodyLen: document.getElementById('body').innerText.length,
  }));
  results.push({ name: '预览页加载且模块可用', pass: boot.errHidden && boot.title === '山居秋暝' && boot.bodyLen > 40, extra: boot });

  const logic = await page.evaluate(async () => {
    const out = [];
    const check = (name, cond, extra) => out.push({ name, pass: !!cond, extra });
    const { playInkFlip, buildBrushSvg } = await import('/www/js/inkflip.js');
    const vp = document.getElementById('viewport');
    const pg = document.getElementById('page');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ① 笔触按真实视口生成，不再拉伸固定稿
    const svg = buildBrushSvg(360, 520, true, 12345);
    check('viewBox 与视口一致（不变形）', svg.includes('viewBox="0 0 360 520"'));
    check('三层浓淡笔触', (svg.match(/ink-brush-line/g) || []).length === 3, { n: (svg.match(/ink-brush-line/g) || []).length });
    check('墨点飞溅', (svg.match(/ink-dot/g) || []).length === 8);
    check('宣纸渗墨滤镜', svg.includes('feDisplacementMap') && svg.includes('feTurbulence'));
    check('上一页路径镜像', buildBrushSvg(360, 520, false, 1) !== buildBrushSvg(360, 520, true, 1));

    // ② 下一页：时序、方向、清理
    let mutated = 0;
    const t0 = performance.now();
    const p1 = playInkFlip({ viewport: vp, page: pg, dir: 'next', timeScale: .3,
      mutate: () => { mutated++; } });
    await sleep(25);
    check('落笔阶段墨层挂在视口内', !!document.querySelector('.ink-flip.ink-next'));
    check('墨层不拦截点击', getComputedStyle(document.querySelector('.ink-flip')).pointerEvents === 'none');
    await p1;
    const dt = performance.now() - t0;
    check('换页回调恰好一次', mutated === 1, { mutated });
    check('动画结束墨层被清理', !document.querySelector('.ink-flip'));
    check('页面无残留内联动画样式', !pg.style.filter && !pg.style.opacity, { filter: pg.style.filter });
    check('新版明显快于旧版 1950ms', dt < 1200, { ms: Math.round(dt) });

    // ③ 上一页方向镜像
    const p2 = playInkFlip({ viewport: vp, page: pg, dir: 'prev', timeScale: .3, mutate: () => {} });
    await sleep(25);
    check('上一页为 ink-prev 方向', !!document.querySelector('.ink-flip.ink-prev'));
    const washOrigin = document.querySelector('.ink-flip.ink-prev .ink-wash');
    // transform-origin 的 computed value 是 px（"360px 260px"），不是关键字 "right"
    const ox = washOrigin ? parseFloat(getComputedStyle(washOrigin).transformOrigin) : 0;
    check('上一页墨带自右侧起笔', ox >= vp.clientWidth - 1, { originX: ox, width: vp.clientWidth });
    await p2;

    // ④ 换页回调抛错也必须清掉墨层，不能把整屏永久遮住
    try {
      await playInkFlip({ viewport: vp, page: pg, dir: 'next', timeScale: .3,
        mutate: () => { throw new Error('render failed'); } });
    } catch (e) { /* 预期 */ }
    check('异常后墨层仍被清理', !document.querySelector('.ink-flip'));

    return out;
  });
  results.push(...logic);

  // ⑤ 预览页按钮接线（真实点击）
  const before = await page.$eval('#title', (e) => e.textContent);
  await page.click('#next');
  await wait(600);
  const after = await page.$eval('#title', (e) => e.textContent);
  results.push({ name: '预览页「下一页」按钮可触发换页', pass: before !== after, extra: { before, after } });

  // ⑥ 夜览下墨色变量反相，保证淡墨可见
  await page.click('#night');
  const nightVar = await page.evaluate(async () => {
    const { buildBrushSvg } = await import('/www/js/inkflip.js');
    const vp = document.getElementById('viewport');
    const host = document.createElement('div');
    host.className = 'ink-flip';
    host.innerHTML = '<div class="ink-wash"></div>' + buildBrushSvg(360, 520, true, 7);
    vp.appendChild(host);
    const c = getComputedStyle(host).getPropertyValue('--ink-deep').trim();
    host.remove();
    return c;
  });
  results.push({ name: '夜览下淡墨变量生效', pass: /214,\s*208/.test(nightVar), extra: { nightVar } });

  // ⑦ 真实 App 集成：预览页是独立 HTML，覆盖不到 App 的 DOM 层级、
  //    全局 *{animation:none!important}、样式相对路径与 Pro 层遮罩。
  //    这里直接加载真实 www/index.html，用同一份 inkflip.js 跑一次完整翻页。
  const appPage = await browser.newPage();
  await appPage.setViewport({ width: 412, height: 892 });
  const appErrors = [];
  appPage.on('pageerror', (e) => appErrors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
  appPage.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|manifest|sw\.js|serviceworker/i.test(t)) return;
    appErrors.push('CONSOLE: ' + t);
  });
  // SW 首次 activate 会 postMessage 触发页面 reload，会打断断言；测试环境也不需要离线缓存，
  // 故替换为无害 stub（app.js 的 register(...).catch 已能兜住 rejected promise）。
  await appPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: () => Promise.reject(new Error('sw disabled in test')), addEventListener() {} },
    });
  });
  try {
    await appPage.goto(BASE + 'www/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wait(500);
    const appCheck = await appPage.evaluate(async () => {
      const out = [];
      const check = (name, cond, extra) => out.push({ name, pass: !!cond, extra });
      const vp = document.getElementById('page-viewport');
      const pg = document.getElementById('page');
      const reader = document.getElementById('reader');
      check('App 阅读器 DOM 就绪', !!vp && !!pg && !!reader);
      if (!vp || !pg || !reader) return out;

      // App 初始停在书架，.hidden 是 display:none!important，去掉才有真实尺寸
      reader.classList.remove('hidden');
      document.body.classList.add('reader-active');
      const { playInkFlip } = await import('/www/js/inkflip.js');
      const r = vp.getBoundingClientRect();
      check('App 视口建立定位上下文（墨层不跑偏）',
        getComputedStyle(vp).position === 'relative' && r.width > 100 && r.height > 100,
        { pos: getComputedStyle(vp).position, w: Math.round(r.width), h: Math.round(r.height) });

      let mutated = 0;
      const p = playInkFlip({ viewport: vp, page: pg, dir: 'next', timeScale: .35,
        mutate: () => { mutated++; } });
      await new Promise((res) => setTimeout(res, 25));
      const host = vp.querySelector('.ink-flip');
      check('App 中墨层挂在 #page-viewport 内', !!host);
      const hr = host && host.getBoundingClientRect();
      check('App 中墨层尺寸与视口一致（不拉伸）',
        !!hr && Math.abs(hr.width - r.width) < 2 && Math.abs(hr.height - r.height) < 2,
        { host: hr && [Math.round(hr.width), Math.round(hr.height)], vp: [Math.round(r.width), Math.round(r.height)] });
      const cssVar = host ? getComputedStyle(host).getPropertyValue('--ink-deep').trim() : '';
      check('App 中 ink-flip.css 相对路径已生效', cssVar.length > 0, { cssVar });
      const svg = host && host.querySelector('svg.ink-brush');
      const vb = svg && svg.getAttribute('viewBox');
      check('App 中 viewBox 按真实视口生成', vb === `0 0 ${vp.clientWidth} ${vp.clientHeight}`,
        { vb, size: [vp.clientWidth, vp.clientHeight] });
      const anims = host && host.getAnimations ? host.getAnimations({ subtree: true }).length : -1;
      check('App 中 Web Animations 不受全局 animation:none 影响', anims > 0, { anims });
      check('App 中墨层不拦截点击', !!host && getComputedStyle(host).pointerEvents === 'none');
      await p;
      check('App 中换页回调恰好一次', mutated === 1, { mutated });
      check('App 中动画结束墨层被清理', !vp.querySelector('.ink-flip'));
      check('App 中正文无残留内联动画样式', !pg.style.filter && !pg.style.opacity);
      return out;
    });
    results.push(...appCheck);
    results.push({ name: 'App 集成无致命脚本报错', pass: appErrors.length === 0, extra: appErrors.slice(0, 4) });
  } catch (e) {
    results.push({ name: 'App 集成测试执行', pass: false, extra: String(e && e.message ? e.message : e) });
  }
  await appPage.close();
} catch (e) {
  results.push({ name: '测试执行', pass: false, extra: String(e && e.message ? e.message : e) });
}

let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ' + JSON.stringify(r.extra)}`);
  if (r.pass) pass++;
}
console.log(`\n${pass}/${results.length} 通过，页面错误 ${errors.length} 条`);
if (errors.length) console.log(errors.slice(0, 6).join('\n'));
await browser.close();
server.kill();
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
