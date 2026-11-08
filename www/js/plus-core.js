// 水杉 Plus —— 纯逻辑内核
//
// 这一层不碰 DOM（模块级零副作用），只放「可判定、可单测」的能力：
//   白名单净化 / 位置锚点 / 全文搜索 / 章末停 / 自适应 Regal / 有效阅读 /
//   剩余时长估算 / 摘录导出 / 备份序列化 / 书架排序 / 双页判定。
// DOM、事件与 UI 一律在 plus.js；删除 plus.js + plus.css + app.js 里几行挂载即可完整回退。

/* =======================================================================
 * 1. DOMParser 白名单净化
 * -----------------------------------------------------------------------
 * 原实现是 6 条正则的字符串级净化，能挡脚本但有两个结构性缺口：
 *   - 黑名单挡不住没列到的元素/属性（例如 <animate>、<foreignObject>、xlink:href 变体）
 *   - 无法保证「属性名合法」这件事本身
 * 现在改成「正则预清洗 → DOMParser 白名单重建 → 结构守卫回退」三段式：
 *   - 预清洗复用原正则，先干掉成对危险容器与 javascript:/外链
 *   - 白名单重建只保留允许的标签与属性，URL 属性逐个校验
 *   - SVG 子树整体用占位符保护：HTML 解析器会把 <image> 改名成 <img>、
 *     会重排自闭合 SVG 节点，导致 EPUB 的 SVG <image xlink:href> 与脚注锚点损坏，
 *     因此 SVG 片段不参与重序列化，原样回填
 *   - 结构守卫：若重建后正文文字丢失超过 15%、或图片标签全丢，则回退预清洗结果
 * ===================================================================== */

const DANGEROUS_BLOCK = /<\s*(script|iframe|object|embed|form|style|template|noscript|frameset|frame)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DANGEROUS_VOID = /<\s*(script|iframe|object|embed|form|meta|link|base|input|button|textarea|select|style|template|noscript)\b[^>]*\/?>/gi;

export function legacySanitize(html) {
  return String(html)
    .replace(DANGEROUS_BLOCK, '')
    .replace(DANGEROUS_VOID, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:href|src|xlink:href|action|data)\s*=\s*)(["'])\s*(?:javascript|vbscript)\s*:[^"']*\2/gi, '$1"#"')
    .replace(/((?:href|src|xlink:href|action|data)\s*=\s*)(["'])data:(?!image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif)\b)[^"']*\2/gi, '$1"#"')
    .replace(/((?:href|src|xlink:href|action|data)\s*=\s*)(?:javascript|vbscript|data)\s*:[^\s>]+/gi, '$1"#"')
    .replace(/((?:href|src|xlink:href)\s*=\s*)(["'])(?:https?:)?\/\/[^"']*\2/gi, '$1"#" data-ink-blocked="1"');
}

const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'small', 'big', 'blockquote', 'pre', 'code', 'kbd', 'samp', 'var', 'q',
  'cite', 'abbr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'section', 'article', 'header',
  'footer', 'aside', 'main', 'nav', 'center', 'font', 'ruby', 'rt', 'rp',
  'bdi', 'bdo', 'wbr', 'time', 'mark', 'details', 'summary',
  'ink-svg', // 内部占位元素，序列化后会被还原成原始 <svg> 片段
]);

const DROP_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'form', 'style', 'template',
  'noscript', 'frameset', 'frame', 'meta', 'link', 'base', 'input',
  'button', 'textarea', 'select', 'option', 'video', 'audio', 'source',
  'canvas', 'applet', 'animate', 'set', 'foreignobject', 'portal',
]);

const ALLOWED_ATTRS = new Set([
  'id', 'name', 'class', 'title', 'lang', 'dir', 'alt', 'src', 'href',
  'width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'scope',
  'start', 'value', 'type', 'cite', 'datetime', 'xml:lang', 'epub:type',
  'data-plus-token', 'style',
]);

const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'poster', 'background']);

function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^(?:javascript|vbscript)\s*:/i.test(s)) return '#';
  if (/^data:/i.test(s)) return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif)/i.test(s) ? s : '#';
  if (/^(?:https?:)?\/\//i.test(s)) return '#'; // 本地优先、零追踪
  return s;
}
function safeStyle(v) {
  return String(v == null ? '' : v)
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .slice(0, 800);
}
function isSafeAttr(name, value) {
  const n = String(name || '').toLowerCase();
  if (/^on/.test(n)) return false;
  if (n === 'srcdoc' || n === 'formaction') return false;
  if (n.startsWith('data-') || n.startsWith('aria-')) return true; // data-* / aria-* 不执行
  if (n === 'xlink:href') return true;
  if (n === 'style') return true;
  return ALLOWED_ATTRS.has(n);
}
function attrValue(name, value) {
  const n = String(name || '').toLowerCase();
  if (URL_ATTRS.has(n)) return safeUrl(value);
  if (n === 'style') return safeStyle(value);
  return String(value == null ? '' : value);
}

function rebuild(node, doc) {
  const kids = Array.from(node.childNodes);
  for (const child of kids) {
    if (child.nodeType === 8) { child.remove(); continue; } // 注释（含 XML 声明残片）
    if (child.nodeType !== 1) continue;
    const tag = String(child.tagName || '').toLowerCase();
    if (DROP_TAGS.has(tag)) { child.remove(); continue; }
    if (!ALLOWED_TAGS.has(tag)) {
      // 未知元素一律「脱壳保留内容」：EPUB 常见自定义命名空间标签不能被整段丢掉
      rebuild(child, doc);
      const frag = doc.createDocumentFragment();
      while (child.firstChild) frag.appendChild(child.firstChild);
      child.replaceWith(frag);
      continue;
    }
    for (const a of Array.from(child.attributes || [])) {
      const name = a.name;
      if (!isSafeAttr(name, a.value)) { child.removeAttribute(name); continue; }
      child.setAttribute(name, attrValue(name, a.value));
    }
    rebuild(child, doc);
  }
}

/** 供 importers.js 与 plus.js 共用；DOMParser 不可用时安全退化为正则净化。 */
export function sanitizeBookHtml(html) {
  const raw = String(html == null ? '' : html);
  if (!raw) return '';
  const cleaned = legacySanitize(raw);
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') return cleaned;

  // SVG 子树与独立 <image> 用占位文本保护，避开 HTML 解析器的 <image>→<img> 改名与自闭合重排
  const vault = [];
  const stash = (s) => { vault.push(s); return `PLUSINKTOKEN${vault.length - 1}ENDPLUSINK`; };
  let work = cleaned.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, stash);
  work = work.replace(/<image\b[^>]*\/?>/gi, stash);

  let doc;
  try { doc = new DOMParser().parseFromString(work, 'text/html'); } catch (e) { return cleaned; }
  const body = doc && doc.body;
  if (!body) return cleaned;
  try { rebuild(body, doc); } catch (e) { return cleaned; }
  let out = body.innerHTML;
  out = out.replace(/PLUSINKTOKEN(\d+)ENDPLUSINK/g, (_, i) => vault[Number(i)] || '');

  // 结构守卫：解析器若吃掉大量正文或图片，宁可退回已验证过的正则净化结果
  const beforeText = textOf(cleaned).length;
  const afterText = textOf(out).length;
  const beforeImg = (cleaned.match(/<(?:img|image)\b/gi) || []).length;
  const afterImg = (out.match(/<(?:img|image)\b/gi) || []).length;
  if (beforeText > 40 && afterText < beforeText * 0.85) return cleaned;
  if (beforeImg > 0 && afterImg === 0) return cleaned;
  return out;
}

/* =======================================================================
 * 2. 文本 / 位置锚点
 * ===================================================================== */
export function textOf(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从已渲染页取「开头一段可复现的文字」做锚点，比 ci/pi 更耐改字号/换设备。 */
export function makeAnchor(pageEl, ci) {
  if (!pageEl) return null;
  const t = String(pageEl.innerText || pageEl.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return { ci: Number(ci) || 0, quote: t.slice(0, 30), at: Date.now() };
}

/** 在分页结果里找回锚点所在页；找不到时逐级缩短引文，再找不到返回 -1。 */
export function findPageByQuote(pages, quote) {
  if (!quote || !Array.isArray(pages) || !pages.length) return -1;
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  for (let shrink = 0; shrink < 3; shrink++) {
    const q = norm(quote).slice(0, 24 - shrink * 8);
    if (!q) break;
    for (let i = 0; i < pages.length; i++) {
      if (norm(textOf(pages[i])).includes(q)) return i;
    }
  }
  return -1;
}

/* =======================================================================
 * 3. 全文搜索 / 章节速览
 * ===================================================================== */
export function searchBook(book, query, limit = 80) {
  const needle = String(query == null ? '' : query).trim().toLowerCase();
  if (!needle || !book || !Array.isArray(book.chapters)) return [];
  const out = [];
  for (let ci = 0; ci < book.chapters.length && out.length < limit; ci++) {
    const ch = book.chapters[ci] || {};
    const text = textOf(ch.html || '');
    const lower = text.toLowerCase();
    let from = 0;
    let hit;
    while ((hit = lower.indexOf(needle, from)) !== -1 && out.length < limit) {
      const s = Math.max(0, hit - 18);
      out.push({
        ci,
        title: ch.title || `第 ${ci + 1} 节`,
        snippet: (s > 0 ? '…' : '') + text.slice(s, hit + needle.length + 36) + '…',
        quote: text.slice(Math.max(0, hit - 6), Math.max(0, hit - 6) + 30),
        pos: hit,
      });
      from = hit + Math.max(1, needle.length);
    }
  }
  return out;
}

export function chapterOverview(book, charsPerMin = 400) {
  if (!book || !Array.isArray(book.chapters)) return [];
  return book.chapters.map((ch, ci) => {
    const chars = textOf(ch.html || '').length;
    return { ci, title: ch.title || `第 ${ci + 1} 节`, chars, minutes: Math.max(1, Math.round(chars / Math.max(80, charsPerMin))) };
  });
}

/* =======================================================================
 * 4. 自动翻页章末停 / 视线意图 / 自适应 Regal / 有效阅读
 * ===================================================================== */
export function chapterEndDecision(pos, dir, step) {
  const p = pos || {};
  const pages = Math.max(1, Number(p.pages) || 1);
  const chapterCount = Math.max(1, Number(p.chapterCount) || 1);
  const pi = Math.max(0, Number(p.pi) || 0);
  const ci = Math.max(0, Number(p.ci) || 0);
  if (dir !== 'next') return { stop: false, reason: '' };
  if (pi + Math.max(1, step) >= pages) {
    return ci >= chapterCount - 1
      ? { stop: true, reason: '已到全书末页' }
      : { stop: true, reason: '已到本章末页' };
  }
  return { stop: false, reason: '' };
}

export function shouldRegalFlash(o) {
  const n = Number(o && o.N) || 0;
  if (n <= 0) return false;
  const s = o || {};
  if (s.adaptive === false) {
    if (n === 999) return !!s.chapterChanged;
    return (Number(s.turnCounter) || 0) % n === 0;
  }
  if (s.pageFlip) return false;                 // 已有水墨/翻书动画，不再叠一次闪屏
  if ((Number(s.rapidTurns) || 0) >= 3) return false; // 连续快翻时延后，避免频闪
  let N = n;
  if (s.theme === 'night') N = Math.max(N, 12); // 夜览下闪白刺眼，拉长周期
  if (N === 999) return !!s.chapterChanged;
  return (Number(s.turnCounter) || 0) % N === 0;
}

/** 有效阅读：只有「近期有真实交互」或「自动翻页刚发生」才计时长，避免亮屏放着不动刷时长。 */
export function effectiveTick(o) {
  const s = o || {};
  if (s.enabled === false) return true;
  const now = Number(s.now) || Date.now();
  const idleFor = now - (Number(s.lastActivityAt) || 0);
  const turnFor = now - (Number(s.lastTurnAt) || 0);
  if (idleFor <= 30000) return true;
  if (s.autoActive && turnFor <= 30000) return true;
  return false;
}

/** 剩余阅读时长：用本次会话的有效阅读速度估算，冷启动回退到中文常见 400 字/分。 */
export function estimateRemainingMinutes(o) {
  const s = o || {};
  const pct = Math.max(0, Math.min(100, Number(s.pct) || 0));
  const totalChars = Math.max(0, Number(s.totalChars) || 0);
  if (!totalChars || pct >= 100) return 0;
  const readChars = Math.max(0, Number(s.readChars) || 0);
  const effectiveMs = Math.max(0, Number(s.effectiveMs) || 0);
  let cpm = 400;
  if (readChars > 120 && effectiveMs > 15000) {
    cpm = Math.max(120, Math.min(1800, readChars / (effectiveMs / 60000)));
  }
  const remain = totalChars * (1 - pct / 100);
  return Math.max(1, Math.round(remain / cpm));
}

export function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/* =======================================================================
 * 5. 摘录导出 / 本地备份
 * ===================================================================== */
function mdEscape(s) { return String(s == null ? '' : s).replace(/([*_`[\]#])/g, '\\$1'); }

export function buildExcerptMarkdown(o) {
  const s = o || {};
  const lines = [`# 《${mdEscape(s.title || '未命名')}》阅读摘录`, ''];
  if (s.author) lines.push(`> 作者：${mdEscape(s.author)}`, '');
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`, '');
  const sections = [
    ['标注', s.highlights],
    ['收藏', s.favorites],
    ['书签', s.bookmarks],
  ];
  let any = false;
  for (const [label, arr] of sections) {
    const list = Array.isArray(arr) ? arr : [];
    if (!list.length) continue;
    any = true;
    lines.push(`## ${label}（${list.length}）`, '');
    list.forEach((e, i) => {
      const at = e && e.at ? new Date(e.at).toLocaleString('zh-CN') : '';
      const loc = e && (e.ci != null) ? `第 ${Number(e.ci) + 1} 章` : '';
      lines.push(`${i + 1}. ${mdEscape(e && (e.text || e.note) || '')}`);
      if (loc || at) lines.push(`   - ${[loc, at].filter(Boolean).join(' · ')}`);
    });
    lines.push('');
  }
  if (!any) lines.push('_本书还没有标注、收藏或书签。在阅读器里选中文字即可添加。_', '');
  return lines.join('\n');
}

export function serializeBackup(data) {
  return JSON.stringify({
    app: 'ink-reader',
    schema: 1,
    exportedAt: new Date().toISOString(),
    data: data || {},
  }, null, 2);
}
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(String(text)); } catch (e) { throw new Error('备份文件不是合法 JSON'); }
  if (!obj || obj.app !== 'ink-reader' || !obj.data || typeof obj.data !== 'object') {
    throw new Error('不是水杉阅读的备份文件');
  }
  return obj.data;
}

/* =======================================================================
 * 6. 书架增强 / 双页判定
 * ===================================================================== */
export function seriesKeyOf(title) {
  const raw = String(title == null ? '' : title).trim();
  let t = raw
    .replace(/[（(\[【]\s*(?:第?\s*[\d一二三四五六七八九十百]+\s*[卷册部集篇]|Vol\.?\s*\d+|全\s*\d+\s*册|上|中|下)\s*[）)\]】]\s*$/i, '')
    .replace(/\s+第[\d一二三四五六七八九十百]+[卷册部集篇].*$/i, '')
    .trim();
  return t && t !== raw ? t : '';
}

export function sortShelfList(list, o) {
  const s = o || {};
  const arr = Array.isArray(list) ? list.slice() : [];
  if (s.recentFirst && s.recentId) {
    arr.sort((a, b) => (String(b.id) === String(s.recentId) ? 1 : 0) - (String(a.id) === String(s.recentId) ? 1 : 0));
  }
  if (s.seriesGroup) {
    arr.sort((a, b) => {
      const ka = seriesKeyOf(a.title) || a.title;
      const kb = seriesKeyOf(b.title) || b.title;
      if (ka === kb) return String(a.title).localeCompare(String(b.title), 'zh-CN');
      return ka.localeCompare(kb, 'zh-CN');
    });
  }
  return arr;
}

export function isLandscape(w, h) { return Number(w) > Number(h) * 1.15; }
export function twoPageActive(o) {
  const s = o || {};
  return !!(s.enabled && s.landscape && !s.isPdf && Number(s.width) >= 640);
}
export function pageMetrics(o) {
  const s = o || {};
  const w = Math.max(1, Number(s.width) || 1);
  const h = Math.max(1, Number(s.height) || 1);
  const two = twoPageActive(s);
  return { pageWidth: two ? Math.floor((w - 28) / 2) : w, pageHeight: h, twoPage: two };
}

/* =======================================================================
 * 7. 视线意图：把「能检测到回扫」升级为「这次回扫确实想翻页」
 * ===================================================================== */
export function acceptGazeSignal(o) {
  const s = o || {};
  if (s.enabled === false) return true;
  const phase = String(s.phase || '');
  if (['lost', 'unavailable', 'paused', 'off', 'starting'].includes(phase)) return false;
  if (s.panelOpen || s.selection || s.hidden) return false;
  const now = Number(s.now) || Date.now();
  if (now - (Number(s.lastManualTurnAt) || 0) < 700) return false; // 手动刚翻过，别连翻
  if (now - (Number(s.lastAcceptedAt) || 0) < 900) return false;   // 一次回扫只翻一页
  return true;
}
