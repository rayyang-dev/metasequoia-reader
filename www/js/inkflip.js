// 水杉 · 水墨翻页（Ink Wash Page Turn）
//
// 设计：「一笔过纸，墨渗字显」
//   1. 落笔 —— 墨色自起笔侧洇开，笔锋沿宣纸运过，伴笔与墨点带出浓淡干湿；
//   2. 墨满 —— 在墨色完全覆纸的一瞬换页，视觉上是「墨过之处，已是新页」；
//   3. 收笔 —— 墨从对侧被纸吸去，新页文字由淡渐浓自纸纤维里渗出，一抹纸光掠过。
//
// 相比旧版的关键改进：
//   * 有方向：下一页左→右起笔，上一页右→左，笔触/墨点/纸光全部镜像；
//   * 不变形：SVG viewBox 按真实视口生成，路径按实际像素计算，不再拉伸 340x470 固定稿；
//   * 有笔意：三层浓淡笔触 + feTurbulence 位移做宣纸渗墨毛边 + 错落墨点 + 飞白；
//   * 换页与墨迹同步，不再「墨迹自己跑 1.4s、页面 600ms 才换」的两张皮；
//   * 用 Web Animations API 而非 CSS keyframes：不受全局 *{animation:none!important} 影响，
//     可 await 精确编排时序，异常时统一 cancel，绝不留下遮住整屏的墨层；
//   * 总时长约 700ms（旧版 1950ms），尊重 prefers-reduced-motion，夜览主题自动换淡墨。
//
// 本模块无第三方依赖、无裸 @capacitor/* 导入；预览页与 App 共用，保证「所见即所得」。

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

// 按真实视口生成笔触：每次翻页用不同种子，浓淡与起伏略有变化，像每次落笔都不同。
export function buildBrushSvg(w, h, isNext, seed) {
  const r = mulberry32(seed);
  const x0 = isNext ? -w * 0.08 : w * 1.08;
  const x1 = isNext ? w * 1.08 : -w * 0.08;
  const span = x1 - x0;
  const mid = h * (0.46 + (r() - 0.5) * 0.16);
  const amp = h * 0.052;
  const weight = Math.max(16, Math.round(h * 0.052));
  const fid = 'inkRough' + (seed % 100000);

  const line = (bias, wobble, width, opacity, cls) => {
    const y = mid + bias * h;
    const a = amp * wobble;
    const d = `M ${x0.toFixed(1)} ${(y + (r() - 0.5) * a).toFixed(1)} ` +
      `C ${(x0 + span * 0.30).toFixed(1)} ${(y - a * (0.7 + r())).toFixed(1)}, ` +
      `${(x0 + span * 0.70).toFixed(1)} ${(y + a * (0.7 + r())).toFixed(1)}, ` +
      `${x1.toFixed(1)} ${(y + (r() - 0.5) * a).toFixed(1)}`;
    return `<path class="${cls}" d="${d}" stroke-width="${width.toFixed(1)}" opacity="${opacity}"/>`;
  };

  let dots = '';
  for (let i = 0; i < 8; i++) {
    const t = 0.24 + r() * 0.72;
    const cx = x0 + span * t;
    const cy = mid + (r() - 0.5) * h * 0.30;
    const rad = (1.2 + r() * 3.6).toFixed(1);
    dots += `<circle class="ink-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad}" opacity="0"/>`;
  }

  return `
    <svg class="ink-brush" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <filter id="${fid}" x="-15%" y="-70%" width="130%" height="240%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.013 0.055" numOctaves="3"
                        seed="${seed % 97}" stitchTiles="stitch" result="noise"/>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="${Math.max(6, Math.round(h * 0.016))}"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
      <g filter="url(#${fid})" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        ${line(0.00, 1.00, weight, 0.92, 'ink-brush-line ink-main')}
        ${line(-0.055, 1.35, weight * 0.52, 0.46, 'ink-brush-line ink-side')}
        ${line(0.070, 1.65, weight * 0.28, 0.26, 'ink-brush-line ink-dry')}
      </g>
      <g fill="currentColor">${dots}</g>
    </svg>`;
}

/**
 * 播放一次水墨翻页。
 * @param {Object}   o
 * @param {Element}  o.viewport  #page-viewport（覆盖层挂在这里）
 * @param {Element}  o.page      #page（新页渗显动画作用于此）
 * @param {string}   o.dir       'next' | 'prev'
 * @param {Function} o.mutate    换页回调，可返回 Promise；在墨色覆满时调用
 * @param {number}  [o.timeScale=1] 时间缩放，预览页可用 2.2 慢放
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
  host.innerHTML =
    '<div class="ink-wash"></div>' +
    buildBrushSvg(w, h, isNext, seed) +
    '<div class="ink-sheen"></div>';
  viewport.appendChild(host);

  const wash = host.querySelector('.ink-wash');
  const svg = host.querySelector('.ink-brush');
  const lines = Array.from(svg.querySelectorAll('.ink-brush-line'));
  const dots = Array.from(svg.querySelectorAll('.ink-dot'));
  const sheen = host.querySelector('.ink-sheen');
  const anims = [];
  const run = (el, frames, opts) => {
    const a = el.animate(frames, Object.assign({ fill: 'forwards' }, opts));
    anims.push(a);
    return a.finished.catch(() => {});
  };

  // 描边动画预置：把每条笔锋卷到起点，再随运笔逐步放出。
  const lengths = lines.map((ln) => {
    let len = 0;
    try { len = ln.getTotalLength(); } catch (e) { len = w * 1.2; }
    ln.style.strokeDasharray = String(len);
    ln.style.strokeDashoffset = String(len);
    return len;
  });

  try {
    // ---- ① 落笔：墨带推进 + 三层笔锋运笔 + 墨点溅落 ----
    // 只等「墨带覆满」，不等笔锋/墨点跑完：否则换页会被最慢的墨点拖到 660ms，
    // 墨早已盖住整屏却迟迟不换页，因果感就断了。笔触与墨点并行播放、稍后随收笔淡出。
    const cover = run(wash, [
      { transform: 'scaleX(0)', opacity: 1 },
      { transform: 'scaleX(1)', opacity: 1 },
    ], { duration: D(300), easing: 'cubic-bezier(.24,.68,.26,1)' });

    lines.forEach((ln, i) => {
      const len = lengths[i];
      run(ln, [
        { strokeDashoffset: len, opacity: 0 },
        { strokeDashoffset: len * 0.58, opacity: [0.92, 0.48, 0.28][i], offset: .32 },
        { strokeDashoffset: 0, opacity: [0.92, 0.46, 0.26][i] },
      ], { duration: D(330), delay: D(i * 30), easing: 'cubic-bezier(.3,.7,.3,1)' });
    });
    dots.forEach((dot, i) => run(dot, [
      { opacity: 0, transform: 'scale(.2)' },
      { opacity: [0.62, 0.5, 0.38, 0.55][i % 4], transform: 'scale(1)', offset: .36 },
      { opacity: 0, transform: 'scale(1.4)' },
    ], { duration: D(400), delay: D(80 + i * 26), easing: 'ease-out' }));

    await cover;

    // ---- ② 墨满换页：此刻整屏被墨覆住，换内容不会被看见 ----
    await mutate();

    // ---- ③ 收笔：墨从对侧退去，文字自纸中渗出，纸光掠过 ----
    wash.style.transformOrigin = isNext ? 'right center' : 'left center';
    const reveal = run(wash, [
      { transform: 'scaleX(1)', opacity: 1 },
      { transform: 'scaleX(0)', opacity: .12 },
    ], { duration: D(400), easing: 'cubic-bezier(.36,0,.22,1)' });

    run(page, [
      { opacity: .28, filter: 'blur(2.5px)', transform: `translateY(${isNext ? 7 : -7}px) scale(.996)` },
      { opacity: 1, filter: 'blur(0px)', transform: 'none' },
    ], { duration: D(430), easing: 'cubic-bezier(.22,.68,.24,1)' });
    run(svg, [{ opacity: 1 }, { opacity: 0 }], { duration: D(320), easing: 'ease-in' });
    const s0 = isNext ? '-140%' : '140%';
    const s1 = isNext ? '20%' : '-20%';
    const s2 = isNext ? '170%' : '-170%';
    run(sheen, [
      { transform: `translateX(${s0})`, opacity: 0 },
      { transform: `translateX(${s1})`, opacity: 1, offset: .45 },
      { transform: `translateX(${s2})`, opacity: 0 },
    ], { duration: D(500), easing: 'cubic-bezier(.3,.1,.3,1)' });

    await reveal;
  } finally {
    // 无论渲染是否抛错，都必须撤掉动画与墨层，否则整屏会被永久遮住。
    anims.forEach((a) => { try { a.cancel(); } catch (e) {} });
    host.remove();
  }
}
