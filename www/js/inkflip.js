// 水杉 · 水墨翻页（Ink Brush Page Turn）
//
// 设计纲领：「一笔扫过，墨留纸上，字随笔生」
//   中国画的第一原则是留白 —— 纸永远是纸，绝不用墨把整屏涂黑。
//   翻页不是「遮盖后偷换」，而是「旧字被水化开，墨迹扫过，新字自纸纤维里渗出」。
//
// 笔触不是等宽 stroke，也不是一块实心黑，而是沿中轴采样生成的**变宽封闭轮廓**，
//   再按「墨分五色」由外到内叠六层同心墨色（水痕 / 湿墨 / 笔身 / 浓墨 / 笔心 / 骨线）：
//   边缘淡、笔心浓，收笔时内层先提起来，只剩淡墨出锋。
//   起笔藏锋带一点「顿」，行笔有提按顿挫，侧锋一侧几何抖动、枯笔处以 mask 挖出丝丝飞白；
//   水痕靠更宽更淡的同心轮廓，不用 SVG filter —— WebView 对滤镜的逐帧重算没有保障。
//
// 工程约束：
//   * 全用 Web Animations API —— 项目有全局 *{animation:none!important;transition:none!important}，
//     CSS keyframes 会被吞掉；WAAPI 还能 await 精确编排、异常时统一 cancel。
//   * 不写任何 inline style 到 #page，动画 cancel 后样式自动复原，天然零残留。
//   * 旧页克隆与墨层同挂在一个 host 下，finally 一次 remove 全清，绝不留下遮屏层。
//   * 尊重 prefers-reduced-motion；夜览自动切淡墨（反白墨）；零第三方依赖、无裸 @capacitor/* 导入。
//   * App 与 flip-preview.html 共用本模块，保证所见即所得。

let flipSeq = 0;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 由外到内的六层墨：越靠内越浓、收笔时提得越早（taper 越大）。
const INK_LAYERS = [
  { cls: 'ink-bleed', scale: 1.22, taper: 0.00, rough: false, blur: true },
  { cls: 'ink-wet', scale: 1.06, taper: 0.12, rough: true },
  { cls: 'ink-body', scale: 1.00, taper: 0.28, rough: true },
  { cls: 'ink-deep', scale: 0.72, taper: 0.52, rough: false },
  { cls: 'ink-core', scale: 0.42, taper: 0.76, rough: false },
  { cls: 'ink-bone', scale: 0.16, taper: 0.94, rough: false },
];

// 沿三次贝塞尔中轴采样，逐点算「提按」半宽与法线，得到真实毛笔的变宽轮廓数据。
function strokePoints(w, h, isNext, seed) {
  const r = mulberry32((seed ^ 0x9E3779B9) >>> 0);
  // 起收笔都落在纸内：藏锋的「顿」与出锋的「尖」都要看得见，
  // 像在宣纸上认真写了一横，而不是一张从画外拖进来的色带。
  const x0 = isNext ? w * 0.015 : w * 0.985;
  const x1 = isNext ? w * 0.985 : w * 0.015;
  const baseY = h * (0.43 + (r() - 0.5) * 0.05);
  const y0 = baseY + h * 0.075;   // 起笔略低
  const y1 = baseY - h * 0.065;   // 收笔略抬，笔势斜上，留出下方大块留白
  const span = x1 - x0;
  const c1x = x0 + span * 0.28, c1y = y0 - h * (0.10 + r() * 0.05);
  const c2x = x0 + span * 0.70, c2y = y1 + h * (0.09 + r() * 0.05);
  const N = 48;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
    const dx = 3 * u * u * (c1x - x0) + 6 * u * t * (c2x - c1x) + 3 * t * t * (x1 - c2x);
    const dy = 3 * u * u * (c1y - y0) + 6 * u * t * (c2y - c1y) + 3 * t * t * (y1 - c2y);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    // 藏锋：起笔是斜切的钝头，不是针尖；行笔段粗细稳定（写字的一横），
    // 只在收笔处提笔出锋。正弦式的「梭形」会像柳叶，不像笔画。
    const entry = h * 0.048 * (1 - t) * (1 - t);
    const platform = smoothstep(0, 0.10, t) * (1 - smoothstep(0.70, 1, t));
    const press = platform * (0.88 + 0.12 * Math.sin(t * 9 + (seed % 5)));
    const tremor = 1 + 0.10 * Math.sin(t * 13 + (seed % 9)) + 0.05 * Math.sin(t * 27 + 1.7);
    const half = (1.2 + entry + h * 0.10 * press * tremor) / 2;
    // 侧锋：一侧毛糙、一侧相对齐整。边缘的「洇墨毛边」由几何抖动提供，
    // 不用 SVG filter：clip-path 逐帧动画会让滤镜每帧重算，Android WebView 上没有 GPU 加速保障。
    const rough = (r() - 0.5) * half * 0.36;
    pts.push({ x, y, nx, ny, half, rough, t });
  }
  return { pts, r, x0, y0, w, h };
}

// 由采样点生成封闭轮廓。taper 让内层在收笔段提前提起，形成「出锋」。
function outlinePath(pts, scale, useRough, taper) {
  const up = [], dn = [];
  for (const p of pts) {
    const lift = 1 - (taper || 0) * smoothstep(0.58, 1, p.t);
    const hw = p.half * scale * lift;
    up.push(`${(p.x + p.nx * hw + (useRough ? p.rough * lift : 0)).toFixed(1)} ${(p.y + p.ny * hw).toFixed(1)}`);
    dn.push(`${(p.x - p.nx * hw).toFixed(1)} ${(p.y - p.ny * hw).toFixed(1)}`);
  }
  return `M ${up.join(' L ')} L ${dn.reverse().join(' L ')} Z`;
}

// 飞白：枯笔时笔肚墨少，丝丝露白。在 mask 里沿中轴画半透明细黑线（黑=挖空），
// 越到收笔越密越细，露出的仍是宣纸本身，不是白色颜料。
function flyingWhitePaths(pts, r) {
  const out = [];
  const N = pts.length - 1;
  for (let k = 0; k < 14; k++) {
    const s = 0.22 + r() * 0.62;
    const e = Math.min(1, s + 0.05 + r() * 0.22);
    const off = (r() - 0.5) * 1.7;
    const i0 = Math.max(0, Math.floor(s * N));
    const i1 = Math.min(N, Math.floor(e * N));
    if (i1 - i0 < 2) continue;
    let d = '';
    for (let i = i0; i <= i1; i++) {
      const p = pts[i];
      const o = off * p.half * (0.3 + 0.7 * Math.sin(Math.PI * p.t));
      d += `${i === i0 ? 'M' : 'L'} ${(p.x + p.nx * o).toFixed(1)} ${(p.y + p.ny * o).toFixed(1)} `;
    }
    const sw = (0.25 + r() * 0.75).toFixed(2);
    out.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="${sw}" ` +
      `stroke-linecap="round" opacity="${(0.30 + r() * 0.50).toFixed(2)}"/>`);
  }
  return out.join('');
}

// 甩墨：不是规则圆点，是带方向的不规则小墨滴，越远越小越淡。
function splashPaths(pts, r) {
  const out = [];
  const N = pts.length - 1;
  for (let k = 0; k < 2; k++) {
    const t = 0.62 + r() * 0.30;
    const p = pts[Math.floor(t * N)];
    const side = r() > 0.5 ? 1 : -1;
    const dist = 12 + r() * 26;
    const cx = p.x + p.nx * side * dist + (r() - 0.5) * 8;
    const cy = p.y + p.ny * side * dist + (r() - 0.5) * 8;
    const rad = 1.2 + r() * 2.6;
    out.push(`<path class="ink-splash" d="M ${(cx - rad).toFixed(1)} ${cy.toFixed(1)} ` +
      `q ${(rad * 0.6).toFixed(1)} ${(-rad * 0.9).toFixed(1)} ${(rad * 1.8).toFixed(1)} ${(-rad * 0.25).toFixed(1)} ` +
      `q ${(rad * 0.5).toFixed(1)} ${(rad * 1.15).toFixed(1)} ${(-rad * 1.35).toFixed(1)} ${(rad * 0.55).toFixed(1)} Z" ` +
      `opacity="${(0.24 + r() * 0.32).toFixed(2)}"/>`);
  }
  return out.join('');
}

/**
 * 生成一笔完整的毛笔 SVG（按真实视口像素，不拉伸固定稿）。
 * 导出供回归测试与预览页「笔触分解」使用。
 */
export function buildBrushSvg(w, h, isNext, seed) {
  const { pts, r } = strokePoints(w, h, isNext, seed);
  const uid = 'ink' + (seed % 100000);
  const p0 = pts[0];
  // mask 只覆盖笔锋所在的横带，不生成整屏遮罩位图（笔迹之外本就无需遮罩）
  const maskY = Math.round(h * 0.18), maskH = Math.round(h * 0.66);

  const layerPath = (L) => `<path class="${L.cls}" d="${outlinePath(pts, L.scale, L.rough, L.taper)}"/>`;
  // 外层水痕 / 湿墨直接铺在纸上；内层浓墨受飞白 mask 约束。
  // 刻意不使用任何 SVG filter：所有质感来自变宽轮廓、侧锋抖动、六层同心墨色与飞白挖空，
  // 这样动画期间只需重绘普通 path，WebView 不会掉帧。
  const outerPaths = INK_LAYERS.slice(0, 2).map(layerPath).join('\n        ');
  const innerPaths = INK_LAYERS.slice(2).map(layerPath).join('\n          ');

  return `
    <svg class="ink-brush" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <mask id="${uid}-fb" maskUnits="userSpaceOnUse" x="0" y="${maskY}" width="${w}" height="${maskH}">
          <rect x="0" y="${maskY}" width="${w}" height="${maskH}" fill="#fff"/>
          ${flyingWhitePaths(pts, r)}
        </mask>
      </defs>
      <g class="ink-layers">
        ${outerPaths}
        <g class="ink-inked" mask="url(#${uid}-fb)">
          ${innerPaths}
        </g>
        <g class="ink-splashes">${splashPaths(pts, r)}</g>
        <g class="ink-seed">
          <ellipse class="ink-seed-halo" cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" rx="12" ry="8"/>
          <ellipse class="ink-seed-core" cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" rx="4.5" ry="3"/>
        </g>
      </g>
    </svg>`;
}

/**
 * 播放一次水墨翻页。
 * @param {Object}   o
 * @param {Element}  o.viewport  #page-viewport（覆盖层挂在这里）
 * @param {Element}  o.page      #page（新页渗显动画作用于此）
 * @param {string}   o.dir       'next' | 'prev'
 * @param {Function} o.mutate    换页回调，可返回 Promise；在笔锋过半、旧字已化时调用
 * @param {number}  [o.timeScale=1] 时间缩放，预览页可慢放
 * @returns {Promise<void>}
 */
export async function playInkFlip(o) {
  const { viewport, page, dir = 'next', mutate, timeScale = 1 } = o || {};
  if (typeof mutate !== 'function') return;
  if (!viewport || !page || reducedMotion()) { await mutate(); return; }

  const isNext = dir !== 'prev';
  const w = Math.max(280, Math.round(viewport.clientWidth || 360));
  const h = Math.max(360, Math.round(viewport.clientHeight || 640));
  const seed = (Date.now() ^ ((++flipSeq) * 2654435761)) >>> 0;
  const D = (ms) => Math.max(1, ms * timeScale);

  const host = document.createElement('div');
  host.className = 'ink-flip ' + (isNext ? 'ink-next' : 'ink-prev');
  host.innerHTML = '<div class="ink-brush-wrap">' + buildBrushSvg(w, h, isNext, seed) + '</div>';

  // 旧页「墨化」层：克隆一份当前页，随笔锋推进由浓到淡、由清到化地退去。
  const clone = page.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.classList.add('ink-old-page');
  host.insertBefore(clone, host.firstChild);
  viewport.appendChild(host);

  const wrap = host.querySelector('.ink-brush-wrap');
  const layers = Array.from(host.querySelectorAll('.ink-layers > path, .ink-inked > path'));
  const seedEl = host.querySelector('.ink-seed');
  const splashes = host.querySelector('.ink-splashes');

  const anims = [];
  const done = [];
  const run = (el, frames, opts) => {
    if (!el) return Promise.resolve();
    const a = el.animate(frames, Object.assign({ fill: 'forwards' }, opts));
    anims.push(a);
    const p = a.finished.catch(() => {});
    done.push(p);
    return p;
  };

  const insetFull = 'inset(0 0% 0 0%)';
  const insetHidden = isNext ? 'inset(0 100% 0 0%)' : 'inset(0 0% 0 100%)';

  try {
    // ① 藏锋：笔尖轻点，墨先在纸上洇开
    run(seedEl, [
      { opacity: 0, transform: 'scale(.25)' },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration: D(90), easing: 'cubic-bezier(.2,.8,.3,1)' });

    // ② 行笔：笔锋沿中轴生长（clip-path 揭示，前端细如笔尖，不用整屏色块）
    run(wrap, [
      { clipPath: insetHidden },
      { clipPath: insetFull },
    ], { duration: D(340), delay: D(50), easing: 'cubic-bezier(.36,.06,.2,1)' });

    // 旧字墨化：靠不透明度 + 极轻的缩放退去。不用 filter:blur 逐帧动画 ——
    // 对整页文字层做 blur 插值同样会拖垮 WebView 主线程。
    run(clone, [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(.994)' },
    ], { duration: D(290), delay: D(40), easing: 'cubic-bezier(.4,0,.6,1)' });

    // 甩墨点随行笔中段溅落
    run(splashes, [
      { opacity: 0 }, { opacity: 1, offset: .35 }, { opacity: .75 },
    ], { duration: D(260), delay: D(140), easing: 'ease-out' });

    // 新页从起笔起就「未显」（fill:both 让 delay 期间保持首帧）：
    // 前 330ms 只由旧页克隆显示旧字并逐步墨化，换页后新字才由淡到浓渗出。
    // 若等 mutate 之后才建这条动画，新页会在旧字淡出时就已经不透明地叠在底下，字会显得脏。
    run(page, [
      { opacity: .08, transform: `translateY(${isNext ? 5 : -5}px)` },
      { opacity: 1, transform: 'none' },
    ], { duration: D(430), delay: D(330), fill: 'both', easing: 'cubic-bezier(.16,.72,.3,1)' });

    // ③ 笔锋过半 → 换页：此刻旧字已化尽、新字尚未显，纸仍是纸
    const cue = run(host, [{ opacity: 1 }, { opacity: 1 }], { duration: D(330) });
    await cue;
    await mutate();

    // ⑤ 收笔：墨被纸吸去，淡墨先退、焦墨后退，笔意渐干，最后只剩留白
    layers.forEach((el, i) => run(el, [
      { opacity: 1 }, { opacity: 0 },
    ], { duration: D(320), delay: D(340 + i * 28), easing: 'cubic-bezier(.4,0,.7,1)' }));
    run(seedEl, [{ opacity: 1 }, { opacity: 0 }], { duration: D(280), delay: D(420) });
    run(splashes, [{ opacity: .75 }, { opacity: 0 }], { duration: D(280), delay: D(430) });

    await Promise.all(done);
  } finally {
    // 无论渲染是否抛错，撤掉全部动画并一次移除 host（含旧页克隆），
    // 纸面上不会留下任何遮罩、克隆或内联样式。
    anims.forEach((a) => { try { a.cancel(); } catch (e) {} });
    host.remove();
  }
}
