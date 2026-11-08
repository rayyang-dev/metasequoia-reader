// 水墨翻页回归：验证「留白 / 变宽笔锋 / 墨分五色 / 飞白洇墨 / 换页因果 / 异常清理 / 真实 App 集成」。
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
    spec: !!document.querySelector('#strokeCard .ink-body'),
  }));
  results.push({ name: '预览页加载且模块可用', pass: boot.errHidden && boot.title === '山居秋暝' && boot.bodyLen > 40, extra: boot });
  results.push({ name: '静态「一笔」分解卡与动画同源', pass: boot.spec, extra: { spec: boot.spec } });

  const logic = await page.evaluate(async () => {
    const out = [];
    const check = (name, cond, extra) => out.push({ name, pass: !!cond, extra });
    const { playInkFlip, buildBrushSvg } = await import('/www/js/inkflip.js');
    const vp = document.getElementById('viewport');
    const pg = document.getElementById('page');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // headless Chrome 首次 WAAPI 动画有约 700ms 冷启动开销（纯 div 也如此），
    // 先预热，避免把环境伪影误判成动画代码的性能问题。
    const warm = document.createElement('div');
    warm.style.cssText = 'position:fixed;left:-99px;top:0;width:8px;height:8px';
    document.body.appendChild(warm);
    await warm.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 16 }).finished;
    warm.remove();

    // 从 .ink-bleed 的 d 取起笔 x：不能用全文第一个 M（defs 里飞白线更靠前）
    const startX = (isNext) => {
      const box = document.createElement('div');
      box.innerHTML = buildBrushSvg(360, 520, isNext, 1);
      const d = box.querySelector('.ink-bleed').getAttribute('d');
      const m = d.match(/^M\s+([\d.-]+)/);
      return m ? parseFloat(m[1]) : NaN;
    };

    // ① 几何：按真实视口生成、变宽封闭轮廓、方向镜像
    const svg = buildBrushSvg(360, 520, true, 12345);
    check('viewBox 与视口一致（不变形）', svg.includes('viewBox="0 0 360 520"'));
    check('墨分五色 · 六层同心叠墨',
      ['ink-bleed', 'ink-wet', 'ink-body', 'ink-deep', 'ink-core', 'ink-bone'].every((c) => svg.includes(`class="${c}"`)));
    check('笔触是变宽封闭轮廓（多采样点 + Z 闭合）',
      (svg.match(/ L /g) || []).length > 200 && svg.includes(' Z'));
    check('宣纸洇墨：几何毛边 + 水痕同心层 + 飞白 mask',
      svg.includes('ink-bleed') && svg.includes('ink-wet') && svg.includes('<mask'));
    check('不依赖逐帧 SVG 滤镜（WebView 友好）', !svg.includes('<filter') && !svg.includes('feTurbulence'));
    check('飞白 mask 沿笔势挖出丝丝露白',
      (svg.match(/stroke="#000"/g) || []).length >= 10 && svg.includes('<mask'));
    check('甩墨为不规则墨滴而非圆点', svg.includes('class="ink-splash"') && !svg.includes('<circle'));
    check('上一页路径镜像', buildBrushSvg(360, 520, false, 1) !== buildBrushSvg(360, 520, true, 1));
    check('下一页自左侧起笔', startX(true) < 36, { x: startX(true) });
    check('上一页自右侧起笔', startX(false) > 324, { x: startX(false) });

    // ② 下一页：留白、时序、清理
    let mutated = 0, mutatedAt = 0;
    const t0 = performance.now();
    const p1 = playInkFlip({ viewport: vp, page: pg, dir: 'next', timeScale: .3,
      mutate: () => { mutated++; mutatedAt = performance.now() - t0; } });
    await sleep(25);
    const host = vp.querySelector('.ink-flip.ink-next');
    check('落笔阶段墨层挂在视口内', !!host);
    check('墨层不拦截点击', !!host && getComputedStyle(host).pointerEvents === 'none');
    check('留白：墨层自身无整屏底色', !!host &&
      (getComputedStyle(host).backgroundColor === 'rgba(0, 0, 0, 0)' || getComputedStyle(host).backgroundColor === 'transparent'),
      { bg: host && getComputedStyle(host).backgroundColor });
    check('留白：不再有旧版整屏墨带', !!host && !host.querySelector('.ink-wash'));
    const bodyPath = host && host.querySelector('.ink-body');
    const bb = bodyPath && bodyPath.getBBox();
    check('墨迹只占纸面局部（上下仍是留白）', !!bb && bb.height < vp.clientHeight * 0.45 && bb.width > vp.clientWidth * 0.8,
      { inkH: bb && Math.round(bb.height), vpH: vp.clientHeight });
    check('旧页克隆用于「墨化」过渡', !!host && !!host.querySelector('.ink-old-page'));
    check('换页前新页保持「未显」（旧字独立墨化）',
      parseFloat(getComputedStyle(pg).opacity) < 0.3, { opacity: getComputedStyle(pg).opacity });
    check('Web Animations 正在驱动笔锋生长', !!host && host.getAnimations({ subtree: true }).length > 0);
    await p1;
    const dt = performance.now() - t0;
    check('换页回调恰好一次', mutated === 1, { mutated });
    check('换页发生在笔锋生长期（非墨满遮屏后）', mutatedAt > 0 && mutatedAt < dt * 0.75,
      { mutateAt: Math.round(mutatedAt), total: Math.round(dt) });
    check('动画结束墨层被清理', !vp.querySelector('.ink-flip'));
    check('动画结束旧页克隆被清理', !vp.querySelector('.ink-old-page'));
    check('页面无残留内联动画样式', !pg.style.filter && !pg.style.opacity && !pg.style.transform);
    check('新版明显快于旧版 1950ms', dt < 1000, { ms: Math.round(dt) });

    // ③ 上一页方向镜像
    const p2 = playInkFlip({ viewport: vp, page: pg, dir: 'prev', timeScale: .3, mutate: () => {} });
    await sleep(25);
    check('上一页为 ink-prev 方向', !!vp.querySelector('.ink-flip.ink-prev'));
    await p2;

    // ④ 换页回调抛错也必须清掉墨层与克隆，不能把整屏永久遮住
    try {
      await playInkFlip({ viewport: vp, page: pg, dir: 'next', timeScale: .3,
        mutate: () => { throw new Error('render failed'); } });
    } catch (e) { /* 预期 */ }
    check('异常后墨层仍被清理', !vp.querySelector('.ink-flip'));
    check('异常后旧页克隆仍被清理', !vp.querySelector('.ink-old-page'));

    return out;
  });
  results.push(...logic);

  // ⑤ 预览页按钮接线（真实点击）
  const before = await page.$eval('#title', (e) => e.textContent);
  await page.click('#next');
  await wait(500);
  const after = await page.$eval('#title', (e) => e.textContent);
  results.push({ name: '预览页「下一页」按钮可触发换页', pass: before !== after, extra: { before, after } });

  // ⑥ 夜览下淡墨变量反相
  await page.click('#night');
  const nightVar = await page.evaluate(async () => {
    const { buildBrushSvg } = await import('/www/js/inkflip.js');
    const vp = document.getElementById('viewport');
    const host = document.createElement('div');
    host.className = 'ink-flip';
    host.innerHTML = '<div class="ink-brush-wrap">' + buildBrushSvg(360, 520, true, 7) + '</div>';
    vp.appendChild(host);
    const c = getComputedStyle(host).getPropertyValue('--ink-core').trim();
    host.remove();
    return c;
  });
  results.push({ name: '夜览下淡墨变量生效', pass: /228,\s*222/.test(nightVar), extra: { nightVar } });

  // ⑦ 真实 App 集成：预览页是独立 HTML，覆盖不到 App 的 DOM 层级、
  //    全局 *{animation:none!important}、样式相对路径与 Pro 层遮罩。
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
  // SW 首次 activate 会 postMessage 触发页面 reload，打断断言；测试环境不需要离线缓存。
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
      const cssVar = host ? getComputedStyle(host).getPropertyValue('--ink-core').trim() : '';
      check('App 中 ink-flip.css 相对路径已生效', cssVar.length > 0, { cssVar });
      const svg = host && host.querySelector('svg.ink-brush');
      const vb = svg && svg.getAttribute('viewBox');
      check('App 中 viewBox 按真实视口生成', vb === `0 0 ${vp.clientWidth} ${vp.clientHeight}`,
        { vb, size: [vp.clientWidth, vp.clientHeight] });
      check('App 中六层叠墨齐备', !!host &&
        ['ink-bleed', 'ink-wet', 'ink-body', 'ink-deep', 'ink-core', 'ink-bone'].every((c) => !!host.querySelector('.' + c)));
      check('App 中留白不被整屏墨带破坏', !!host && !host.querySelector('.ink-wash') &&
        getComputedStyle(host).backgroundColor === 'rgba(0, 0, 0, 0)');
      const anims = host && host.getAnimations ? host.getAnimations({ subtree: true }).length : -1;
      check('App 中 Web Animations 不受全局 animation:none 影响', anims > 0, { anims });
      check('App 中墨层不拦截点击', !!host && getComputedStyle(host).pointerEvents === 'none');
      await p;
      check('App 中换页回调恰好一次', mutated === 1, { mutated });
      check('App 中动画结束墨层被清理', !vp.querySelector('.ink-flip'));
      check('App 中旧页克隆被清理', !vp.querySelector('.ink-old-page'));
      check('App 中正文无残留内联动画样式', !pg.style.filter && !pg.style.opacity && !pg.style.transform);
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
