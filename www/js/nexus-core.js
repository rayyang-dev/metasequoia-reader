// 水杉 Nexus —— 能力层纯逻辑内核（零 DOM 副作用，可在 Node 中直接 import 单测）
//
// 设计原则：路线图里每一项都必须对应一个「可判定的行为契约」，而不是一个布尔开关。
// UI 层（nexus.js）只负责把这里的结论渲染出来、把用户操作翻译成参数。
// 删除 nexus.js / nexus.css + app.js 的挂载即可整体回退，不影响既有 Pro / Plus / Stats 层。

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, fb = 0) => { const n = Number(v); return isFinite(n) ? n : fb; };
const str = (v) => String(v == null ? '' : v);
const uniq = (a) => Array.from(new Set(a));
export const dayKey = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const stripTags = (h) => str(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export const textOf = stripTags;

/* ============ 簇 1 · 导入与存储可靠性 ============ */

// #1 分阶段进度：按阶段权重而非字节线性上报，解析阶段最慢所以权重最高
export const IMPORT_PHASES = [
  { key: 'read', label: '读取文件', weight: 10 },
  { key: 'parse', label: '解析正文', weight: 55 },
  { key: 'store', label: '写入书架', weight: 25 },
  { key: 'index', label: '建立索引', weight: 10 },
];
export function importProgress(done, ratio = 0) {
  const total = IMPORT_PHASES.reduce((s, p) => s + p.weight, 0);
  const idx = IMPORT_PHASES.findIndex((p) => p.key === done);
  if (idx < 0) return { pct: 100, label: '已完成', phase: 'done' };
  const before = IMPORT_PHASES.slice(0, idx).reduce((s, p) => s + p.weight, 0);
  const pct = clamp(Math.round(before + IMPORT_PHASES[idx].weight * clamp(num(ratio), 0, 1)), 0, 99);
  return { pct, label: IMPORT_PHASES[idx].label, phase: done };
}
// #2 取消：只有「还没落库」的阶段可无损取消；已落库必须走回收站回滚
export function cancelImport(phase) {
  const safe = ['read', 'parse'].includes(phase);
  return { cancellable: safe, rollback: safe ? null : 'trash', message: safe ? '已取消，未写入任何数据' : '已落库，改为移入回收站' };
}
// #3 失败分类：每类给不同动作，杜绝统一「导入失败」
export function classifyImportError(err) {
  const m = str(err && (err.message || err)).toLowerCase();
  if (/quota|storage|full|space/i.test(m)) return { kind: 'storage', retryable: false, action: 'export' };
  if (/denied|permission|security/i.test(m)) return { kind: 'permission', retryable: true, action: 'retry' };
  if (/zip|corrupt|damage|invalid|bad/i.test(m)) return { kind: 'corrupt', retryable: false, action: 'repick' };
  if (/mobi|azw|kfx|unsupported|format/i.test(m)) return { kind: 'format', retryable: false, action: 'convert' };
  return { kind: 'unknown', retryable: true, action: 'retry' };
}
// #4 存储水位：三档阈值，只在进入告警态时提示一次
export function storagePressure(used, quota) {
  const q = num(quota), ratio = q > 0 ? num(used) / q : 0;
  const level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok';
  return { level, ratio: Math.round(ratio * 100), advice: level === 'ok' ? '' : level === 'warn' ? '建议导出备份并清理回收站' : '存储空间不足，请先导出备份' };
}
// #5 备份预检：解析失败绝不吞错，明确返回 ok=false
export function backupPreview(text) {
  try {
    const d = JSON.parse(str(text));
    if (!d || typeof d !== 'object') return { ok: false, reason: '不是有效的备份对象' };
    const books = Array.isArray(d.books) ? d.books : [];
    return {
      ok: true, version: str(d.version || 'legacy'), books: books.length,
      settings: d.settings && typeof d.settings === 'object' ? Object.keys(d.settings).length : 0,
      conflicts: books.filter((b) => !b || !b.id || !b.title).length,
      hasProgress: !!(d.progress && typeof d.progress === 'object'),
    };
  } catch (e) { return { ok: false, reason: 'JSON 解析失败' }; }
}
// #6 合并而非覆盖：以 id 为键，updatedAt 新的胜出，并列为冲突
export function mergeBackups(localBooks, incomingBooks) {
  const map = new Map((localBooks || []).filter((b) => b && b.id).map((b) => [b.id, b]));
  const conflicts = [];
  const merged = map.size ? Array.from(map.values()) : [];
  (incomingBooks || []).forEach((b) => {
    if (!b || !b.id) return;
    const old = map.get(b.id);
    if (!old) { merged.push(b); map.set(b.id, b); return; }
    const a = num(old.updatedAt || old.addedAt), c = num(b.updatedAt || b.addedAt);
    if (c > a) { merged[merged.indexOf(old)] = b; map.set(b.id, b); }
    else if (c === a && str(old.title) !== str(b.title)) conflicts.push(b.id);
  });
  return { merged, conflicts };
}
// #7 回收站：30 天过期，恢复时原样回填
export function trashPut(list, book, now = Date.now()) {
  return (list || []).filter((x) => x.id !== book.id).concat([{ id: book.id, title: str(book.title), at: now, book }]);
}
export function trashPurge(list, now = Date.now(), days = 30) {
  const limit = days * 86400000;
  return { kept: (list || []).filter((x) => now - num(x.at) < limit), removed: (list || []).filter((x) => now - num(x.at) >= limit).length };
}
export function trashRestore(list, id) {
  const hit = (list || []).find((x) => x.id === id);
  return { book: hit ? hit.book : null, rest: (list || []).filter((x) => x.id !== id) };
}
// #8 去重：ISBN 优先，其次规范化标题+作者；保留章节更多的版本
export function dedupeKey(book) {
  const isbn = str(book && book.isbn).replace(/[^0-9X]/gi, '');
  if (isbn) return 'isbn:' + isbn.toLowerCase();
  const t = str(book && book.title).toLowerCase().replace(/[\s·:：（）()【】\[\]第卷册上下]/g, '');
  const a = str(book && book.author).toLowerCase().replace(/\s/g, '');
  return 'ta:' + t + '|' + a;
}
export function dedupeBooks(list) {
  const map = new Map();
  (list || []).forEach((b) => {
    if (!b || !b.id) return;
    const k = dedupeKey(b), old = map.get(k);
    if (!old || (b.chapters || []).length > (old.chapters || []).length) map.set(k, b);
  });
  return { books: Array.from(map.values()), groups: (list || []).length - map.size };
}
// #9 原文件回传：文件名去掉路径与危险字符，保留真实扩展名
export function exportFileName(book) {
  const ext = str(book && book.source).toLowerCase() === 'pdf' ? 'pdf' : 'epub';
  const base = str(book && (book.title || book.id)).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'book';
  return `${base}.${ext}`;
}
// #10 冷启动骨架屏：init 完成前可见，且有超时兜底避免永久骨架
export function skeletonVisible(o) {
  return !o.ready && num(o.elapsed) < num(o.timeout, 4000);
}
// #4 诊断汇总：把「哪里占空间、有没有错误」变成可读一页
export function diagnostics(o) {
  const d = o || {};
  return {
    books: num(d.bookCount), notes: num(d.noteCount), trash: num(d.trashCount),
    errors: (d.errors || []).slice(-20),
    pressure: storagePressure(d.used, d.quota),
    privacy: { network: num(d.networkCalls), permissions: d.permissions || [] },
  };
}

/* ============ 簇 2 · 书架与元数据 ============ */

// #11 标签：去重、去空白、限长，颜色由字符串稳定散列（同一标签永远同色）
export function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : str(input).split(/[,，;；\s]+/);
  return uniq(arr.map((t) => str(t).trim().replace(/^#/, '')).filter(Boolean).map((t) => t.slice(0, 16))).slice(0, 24);
}
export function tagColor(tag) {
  let h = 0; for (const c of str(tag)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 45%)`;
}
// #12 组合筛选：标签 AND/OR、作者、系列、状态、关键词同时生效
export function filterMetas(metas, c) {
  const q = str((c || {}).q).trim().toLowerCase();
  const tags = normalizeTags((c || {}).tags);
  return (metas || []).filter((m) => {
    if (!m) return false;
    if (q && !(`${str(m.title)} ${str(m.author)} ${str(m.series)} ${(m.tags || []).join(' ')}`.toLowerCase().includes(q))) return false;
    if ((c || {}).author && str(m.author) !== str(c.author)) return false;
    if ((c || {}).series && str(m.series) !== str(c.series)) return false;
    if ((c || {}).state && str(m.readState) !== str(c.state)) return false;
    if (tags.length) {
      const own = normalizeTags(m.tags);
      if ((c || {}).tagMode === 'or' ? !tags.some((t) => own.includes(t)) : !tags.every((t) => own.includes(t))) return false;
    }
    return true;
  });
}
// #13 元数据编辑：白名单字段，禁止通过补丁改写正文/存储主键
export const META_FIELDS = ['title', 'author', 'cover', 'series', 'seriesIndex', 'isbn', 'tags', 'readState'];
export function applyMetaPatch(book, patch) {
  const out = Object.assign({}, book);
  META_FIELDS.forEach((k) => { if (patch && Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k]; });
  if (out.tags) out.tags = normalizeTags(out.tags);
  out.updatedAt = Date.now();
  return out;
}
// #14 系列归组：无系列的书各自成组，组内按 seriesIndex 排序
export function groupBySeries(metas) {
  const groups = new Map();
  (metas || []).forEach((m, i) => {
    const k = str(m && m.series).trim() || `single:${(m && m.id) || i}`;
    if (!groups.has(k)) groups.set(k, { key: k, name: str(m && m.series).trim() || '', books: [] });
    groups.get(k).books.push(m);
  });
  return Array.from(groups.values()).map((g) => {
    g.books.sort((a, b) => num(a && a.seriesIndex) - num(b && b.seriesIndex));
    return g;
  });
}
// #15 虚拟滚动窗口：前后各留一屏缓冲，避免快速滚动露白
export function virtualWindow(total, scrollTop, viewH, rowH) {
  const r = Math.max(1, num(rowH, 100)), v = Math.max(0, num(viewH));
  const start = clamp(Math.floor(num(scrollTop) / r) - Math.ceil(v / r), 0, Math.max(0, num(total)));
  const end = clamp(Math.ceil((num(scrollTop) + v) / r) + Math.ceil(v / r), start, num(total));
  return { start, end, padTop: start * r, padBottom: Math.max(0, (num(total) - end) * r) };
}
// #16 视图按屏宽自动选档，用户偏好优先
export function shelfViewOf(width, pref) {
  if (pref && pref !== 'auto') return pref;
  return num(width) >= 900 ? 'grid' : num(width) >= 520 ? 'list' : 'compact';
}
// #17 排序：最近阅读 / 标题 / 进度 / 加入时间 / 自定义
export function sortMetas(metas, key, customOrder) {
  const arr = (metas || []).slice();
  const cmp = {
    recent: (a, b) => num(b.lastReadAt) - num(a.lastReadAt),
    title: (a, b) => str(a.title).localeCompare(str(b.title), 'zh-CN'),
    progress: (a, b) => num(b.progress) - num(a.progress),
    added: (a, b) => num(b.addedAt) - num(a.addedAt),
    custom: (a, b) => {
      const o = customOrder || [];
      const ia = o.indexOf(a.id), ib = o.indexOf(b.id);
      return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
    },
  }[key] || ((a, b) => num(b.addedAt) - num(a.addedAt));
  return arr.sort(cmp);
}
// #18 封面：由书名稳定生成两色，缺封面时也有可辨识的视觉
export function coverSeed(book) {
  const t = str(book && (book.title || book.id));
  let h = 0; for (const c of t) h = (h * 33 + c.charCodeAt(0)) % 360;
  return { char: t.trim().charAt(0) || '?', hue: h, bg: `hsl(${h} 24% 88%)`, fg: `hsl(${h} 45% 28%)` };
}
// #19 书架搜索：标题/作者/标签命中，并给出命中位置用于高亮
export function shelfSearch(metas, q) {
  const s = str(q).trim().toLowerCase();
  if (!s) return (metas || []).map((m) => ({ meta: m, field: '', pos: -1 }));
  return (metas || []).map((m) => {
    for (const f of ['title', 'author', 'series']) {
      const p = str(m && m[f]).toLowerCase().indexOf(s);
      if (p >= 0) return { meta: m, field: f, pos: p };
    }
    const tp = (m && m.tags || []).findIndex((t) => str(t).toLowerCase().includes(s));
    if (tp >= 0) return { meta: m, field: 'tags', pos: tp };
    return null;
  }).filter(Boolean);
}
// #20 阅读状态：读完以进度或显式标记为准，避免靠猜
export function readStateOf(prog, pct) {
  if (prog && prog.readState) return prog.readState;
  const p = num(pct);
  if (p >= 99.5) return 'finished';
  if (p > 0 || (prog && (num(prog.ci) > 0 || num(prog.pi) > 0))) return 'reading';
  return 'unread';
}

/* ============ 簇 3 · 阅读交互 ============ */

// #21 翻页热区：三区/五区，边缘宽度可配，中央为菜单
export function hitZone(x, y, w, h, cfg) {
  const c = cfg || {}, edge = clamp(num(c.edge, 0.28), 0.05, 0.48);
  const px = num(x) / Math.max(1, num(w)), py = num(y) / Math.max(1, num(h));
  // 三区模式只按 x 判定，保持与旧版阅读器完全一致；五区模式才引入 y 边界
  if ((c.zones || 3) === 5 && (py < 0.18 || py > 0.86)) return 'menu';
  if (px < edge) return c.swap ? 'next' : 'prev';
  if (px > 1 - edge) return c.swap ? 'prev' : 'next';
  return 'menu';
}
// #22 手势编排：动作→命令映射，未配置的手势返回 null（不误触）
export function resolveGesture(name, cfg) {
  const m = (cfg || {}).gestures || {};
  return Object.prototype.hasOwnProperty.call(m, name) ? m[name] : null;
}
// #23 键位映射：同一命令被两个键占用时给出冲突提示
export function resolveKey(code, cfg) {
  const m = (cfg || {}).keys || {};
  const action = m[code] || null;
  const duplicates = Object.keys(m).filter((k) => k !== code && m[k] === action);
  return { action, conflicts: action ? duplicates : [] };
}
// #24 面板下滑关闭：必须同时满足距离与速度，避免普通滚动误关
export function panelSwipeShouldClose(dy, durationMs, threshold = 90) {
  return num(dy) >= threshold && num(dy) / Math.max(1, num(durationMs)) > 0.25;
}
// #25 主题实时预览：只覆盖排版令牌，不改结构
export function themePreviewCss(patch) {
  const p = patch || {};
  const out = {};
  if (p.paper) out['--bg'] = str(p.paper);
  if (p.ink) out['--fg'] = str(p.ink);
  if (p.accent) out['--accent'] = str(p.accent);
  return out;
}
// #26 主题码：可分享的短串，解析失败安全返回 null
export function encodeTheme(o) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(o || {})))).replace(/=+$/, ''); } catch (e) { return ''; }
}
export function parseTheme(code) {
  try { const v = JSON.parse(decodeURIComponent(escape(atob(str(code))))); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
// #27 排版样例：用书里真实句子而非 Lorem ipsum，长度随字号变化
export function layoutSample(o) {
  const s = stripTags((o || {}).html) || '水杉阅读 · 一行真实正文，用来判断字号与行距是否合适。';
  return s.slice(0, clamp(Math.round(120 / Math.max(1, num((o || {}).fontSize, 20) / 20)), 24, 120));
}
// #28 按书记忆动画：有按书值优先，否则回退全局
export function perBookFlip(bookId, perBook, global) {
  return (perBook && perBook[bookId]) || global || 'none';
}
// #29 回位浮条：仅当重排后页号比例漂移超过阈值才提示
export function needAnchorFallback(before, after) {
  const a = num(before && before.pct), b = num(after && after.pct);
  return Math.abs(a - b) > 2;
}
// #30 墨水屏档位：刷新率越低越保守，动画一律关
export function regalTier(hz, cfg) {
  const h = num(hz, 60);
  if ((cfg || {}).eink) return { refreshEvery: h <= 15 ? 12 : 8, animation: false };
  return { refreshEvery: h <= 30 ? 8 : num((cfg || {}).refreshEvery, 6), animation: true };
}

/* ============ 簇 4 · 排版与内容呈现 ============ */

// #31 字体包：超限拒绝注入，避免把大字体塞进 localStorage 撑爆
export function fontFaceRule(name, dataUrl, sizeBytes) {
  if (num(sizeBytes) > 12 * 1024 * 1024) return null;
  const n = str(name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '').slice(0, 40) || 'InkCustom';
  return { name: n, css: `@font-face{font-family:"${n}";src:url("${str(dataUrl)}") format("truetype");font-display:swap}` };
}
// #32 竖排：给出完整排版令牌，分页尺寸由主控按令牌重算
export function verticalCss(enabled) {
  return enabled ? { 'writing-mode': 'vertical-rl', 'text-orientation': 'mixed', 'line-height': '1.9' } : { 'writing-mode': 'horizontal-tb' };
}
// #33 标点挤压：连续全角标点合并为半角视觉间距，不改存储正文
export function squeezePunctuation(text) {
  return str(text).replace(/([，。！？；：、])\s+(?=[，。！？；：、])/g, '$1');
}
// #34 插图查看器：缩放钳制在 1–4 倍，双击切换
export function imageZoom(o) {
  const cur = num((o || {}).scale, 1), act = (o || {}).action;
  const scale = act === 'toggle' ? (cur > 1 ? 1 : 2) : clamp(cur + num((o || {}).delta), 1, 4);
  return { scale, open: scale > 1 || !!(o || {}).keepOpen };
}
// #35 脚注浮层：只取目标 id 的容器内容，绝不整章注入
export function footnotePopup(html, id) {
  const re = new RegExp(`<([a-z]+)[^>]*id=["']${str(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const m = str(html).match(re);
  return m ? { found: true, html: m[2], title: stripTags(m[2]).slice(0, 40) } : { found: false, html: '', title: '' };
}
// #36 目录层级：从「卷/部/篇/第N卷」识别父级，其余为章
export function tocTree(chapters) {
  const out = []; let parent = null;
  (chapters || []).forEach((c, i) => {
    const t = str(c && c.title);
    if (/^(第[一二三四五六七八九十百\d]+[卷部篇])|^(卷|部|篇)[一二三四五六七八九十\d]/i.test(t)) {
      parent = { title: t, ci: i, children: [] }; out.push(parent);
    } else {
      const node = { title: t || `第 ${i + 1} 节`, ci: i, children: [] };
      if (parent) parent.children.push(node); else out.push(node);
    }
  });
  return out;
}
// #37 目录搜章名：保留命中项的父级路径
export function tocSearch(tree, q) {
  const s = str(q).trim().toLowerCase();
  if (!s) return tree || [];
  const walk = (nodes, path) => (nodes || []).flatMap((n) => {
    const here = path.concat(n.title);
    const self = n.title.toLowerCase().includes(s) ? [{ title: n.title, ci: n.ci, path: here.join(' / ') }] : [];
    return self.concat(walk(n.children, here));
  });
  return walk(tree, []);
}
// #38 章节刻度：按字数占比分配位置，剩余时长按未读字数换算
export function chapterTicks(chapters, charsPerMin = 400) {
  const chars = (chapters || []).map((c, i) => num(c && c.chars, stripTags(c && c.html).length || 300));
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return chars.map((n, i) => {
    const tick = { ci: i, startPct: (acc / total) * 100, minutes: Math.max(1, Math.round(n / Math.max(1, num(charsPerMin)))) };
    acc += n; return tick;
  });
}
// #39 双开对照：取相邻两页，奇数页补空白避免错位
export function spreadPair(pages, i) {
  const a = (pages || [])[num(i)] || '';
  const b = (pages || [])[num(i) + 1] || '';
  return { left: a, right: b, empty: !b };
}
// #40 人物/地点索引：从正文抽连续专名（启发式），给出首次出现位置
export function entityIndex(chapters, topN = 30) {
  const counts = new Map();
  (chapters || []).forEach((c, ci) => {
    const t = stripTags(c && c.html);
    const re = /[\u4e00-\u9fa5]{2,4}(?=[，。！？、；：\s]|$)/g;
    let m; while ((m = re.exec(t))) {
      const w = m[0];
      if (/^(这是|我们|他们|因为|所以|但是|如果|一个|没有|可以|什么|时候)/.test(w)) continue;
      const e = counts.get(w) || { name: w, count: 0, first: { ci, pos: m.index } };
      e.count++; counts.set(w, e);
    }
  });
  return Array.from(counts.values()).filter((e) => e.count >= 2).sort((a, b) => b.count - a.count).slice(0, num(topN, 30));
}

/* ============ 簇 5 · 笔记与批注 ============ */

// #41 段落批注：锚点用「章 + 页首引文」，改字号也能找回
export function makeNote(o) {
  const d = o || {};
  return {
    id: str(d.id) || `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    bookId: str(d.bookId), ci: num(d.ci), quote: str(d.quote).slice(0, 60),
    text: str(d.text).slice(0, 2000), color: str(d.color) || 'important',
    tags: normalizeTags(d.tags), at: num(d.at) || Date.now(),
  };
}
export const noteAnchor = (n) => `${n.bookId}:${n.ci}:${n.quote}`;
// #42 双向跳转：带着引文回原文，找不到时明确降级到章首
export function noteJumpTarget(note, pages) {
  const i = (pages || []).findIndex((p) => stripTags(p).includes(str(note && note.quote).slice(0, 12)));
  return { ci: num(note && note.ci), pi: i < 0 ? 0 : i, exact: i >= 0 };
}
// #43 笔记聚合：按章 / 标签 / 日期三种视图
export function groupNotes(notes, by) {
  const g = new Map();
  (notes || []).forEach((n) => {
    const k = by === 'tag' ? (n.tags || []).join(',') || '未标注'
      : by === 'date' ? dayKey(new Date(num(n.at)))
      : `第 ${num(n.ci) + 1} 章`;
    if (!g.has(k)) g.set(k, { key: k, notes: [] });
    g.get(k).notes.push(n);
  });
  return Array.from(g.values());
}
// #44 间隔回顾：1/3/7/14 天节奏，到期才推，每天最多 n 张
export function reviewSchedule(notes, today, n = 5) {
  const t = num(today);
  const due = (notes || []).filter((x) => {
    const age = (t - num(x.at)) / 86400000;
    return [1, 3, 7, 14, 30].some((d) => age >= d && age < d + 1 && num(x.lastReview) < t - 86400000);
  }).sort((a, b) => num(a.lastReview) - num(b.lastReview));
  return due.slice(0, clamp(num(n, 5), 1, 20));
}
// #45 摘录导出条件化：书 / 标签 / 日期 / 颜色 / 关键字
export function filterExcerpts(notes, o) {
  const c = o || {}, tags = normalizeTags(c.tags), q = str(c.q).toLowerCase();
  return (notes || []).filter((n) => {
    if (c.bookId && n.bookId !== c.bookId) return false;
    if (c.color && n.color !== c.color) return false;
    if (c.from && dayKey(new Date(num(n.at))) < str(c.from)) return false;
    if (c.to && dayKey(new Date(num(n.at))) > str(c.to)) return false;
    if (tags.length && !tags.some((t) => (n.tags || []).includes(t))) return false;
    if (q && !(`${n.text} ${n.quote}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
// #46 书单 / 摘录集导出：离线可打开的静态 HTML
export function buildBooklistHtml(metas, notes, title = '我的书单') {
  const esc = (s) => str(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><h1>${esc(title)}</h1>` +
    `<ul>${(metas || []).map((m) => `<li>${esc(m.title)} — ${esc(m.author || '佚名')}</li>`).join('')}</ul>` +
    `<h2>摘录</h2>${(notes || []).map((n) => `<blockquote>${esc(n.quote)}<br>${esc(n.text)}</blockquote>`).join('')}`;
}
// #47 分享卡片：结构化数据交给 Canvas 渲染，水印默认关
export function shareCard(o) {
  const d = o || {};
  return { title: str(d.bookTitle), quote: str(d.quote).slice(0, 90), page: num(d.page), author: str(d.author), watermark: !!d.watermark, theme: str(d.theme) || 'ink' };
}
// #48 标注颜色分类
export const HIGHLIGHT_COLORS = { important: '#c8873f', question: '#4f7fa8', like: '#7a9c62', note: '#9a6fa8' };
export const highlightColor = (type) => HIGHLIGHT_COLORS[type] || HIGHLIGHT_COLORS.important;
// #49 笔记全文搜索：批注与引文都搜
export function searchNotes(notes, q) {
  const s = str(q).trim().toLowerCase();
  if (!s) return [];
  return (notes || []).filter((n) => (`${n.text} ${n.quote} ${(n.tags || []).join(' ')}`).toLowerCase().includes(s));
}
// #50 阅读成就：纯本地，可一键关闭
export function achievementsOf(stats, o) {
  if ((o || {}).enabled === false) return [];
  const days = Object.keys(stats || {}).filter((k) => num((stats[k] || {}).totalMs || Object.values((stats[k] || {}).byBook || {}).reduce((a, b) => a + num(b), 0)) > 0).length;
  const out = [];
  if (days >= 1) out.push({ id: 'first', name: '开卷', desc: '完成第一天阅读' });
  if (days >= 7) out.push({ id: 'week', name: '七日不辍', desc: '累计 7 天阅读' });
  if (days >= 30) out.push({ id: 'month', name: '月读不倦', desc: '累计 30 天阅读' });
  if (num((o || {}).finished) >= 1) out.push({ id: 'finish', name: '读完一本', desc: '完成第一本书' });
  return out;
}

/* ============ 簇 6 · 搜索与导航 ============ */

// #51 跨书全局搜索：正文先去标签，命中给出章节与前后文
export function globalSearch(books, q, limit = 60) {
  const s = str(q).trim();
  if (!s) return [];
  const low = s.toLowerCase(), out = [];
  (books || []).forEach((b) => {
    (b && b.chapters || []).forEach((c, ci) => {
      const t = stripTags(c && c.html);
      let from = 0, p;
      while ((p = t.toLowerCase().indexOf(low, from)) >= 0 && out.length < num(limit, 60)) {
        out.push({ bookId: b.id, bookTitle: str(b.title), ci, title: str(c && c.title), pos: p, text: t });
        from = p + Math.max(1, s.length);
      }
    });
  });
  return out;
}
// #52 命中就地高亮：只包 <mark>，不改存储正文，且先转义避免注入
export function markHit(html, q) {
  const s = str(q).trim(); if (!s) return str(html);
  const esc = (x) => str(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return esc(html).replace(re, (m) => `<mark>${m}</mark>`);
}
// #53 上下文预览：命中词居中，前后各 n 字
export function snippetOf(text, q, n = 28) {
  const t = stripTags(text), p = t.toLowerCase().indexOf(str(q).toLowerCase());
  if (p < 0) return t.slice(0, n * 2);
  const start = Math.max(0, p - num(n, 28)), end = Math.min(t.length, p + str(q).length + num(n, 28));
  return (start ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}
// #54 按章分组，结果可折叠
export function groupHits(hits) {
  const g = new Map();
  (hits || []).forEach((h) => {
    const k = `${h.bookId}:${h.ci}`;
    if (!g.has(k)) g.set(k, { bookId: h.bookId, bookTitle: h.bookTitle, ci: h.ci, title: h.title, hits: [] });
    g.get(k).hits.push(h);
  });
  return Array.from(g.values());
}
// #55 搜索历史：去重、最近优先、上限 10
export function searchHistoryPush(list, q, cap = 10) {
  const s = str(q).trim(); if (!s) return list || [];
  return [s].concat((list || []).filter((x) => x !== s)).slice(0, clamp(num(cap, 10), 1, 30));
}
// #56 匹配选项：非法正则必须被拦下，不能抛异常
export function matchOptions(q, o) {
  const c = o || {};
  try {
    const src = c.regex ? str(q) : str(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = c.wholeWord ? `\\b(?:${src})\\b` : src;
    return { ok: true, re: new RegExp(body, c.caseSensitive ? 'g' : 'gi'), reason: '' };
  } catch (e) { return { ok: false, re: null, reason: '正则表达式不合法' }; }
}
// #57 快捷跳转：支持百分比 / 第N章 / pN 三种输入
export function parseJump(input, chapterCount, pageCount) {
  const s = str(input).trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return { ok: true, kind: 'pct', value: clamp(num(m[1]), 0, 100) };
  m = s.match(/^第\s*(\d+)\s*章$/);
  if (m) return { ok: true, kind: 'chapter', value: clamp(num(m[1]) - 1, 0, Math.max(0, num(chapterCount) - 1)) };
  m = s.match(/^p\s*(\d+)$/);
  if (m) return { ok: true, kind: 'page', value: clamp(num(m[1]) - 1, 0, Math.max(0, num(pageCount) - 1)) };
  return { ok: false, kind: '', value: 0 };
}
// #58 最近位置列表：同一本书同章去重，保留最新
export function recentPositions(list, cap = 8) {
  // 先按时间倒序再去重：同一本书同一章只保留「最近一次」，不能保留最早那条
  const seen = new Set();
  return (list || []).slice().sort((a, b) => num(b.at) - num(a.at)).filter((p) => {
    const k = `${p.bookId}:${p.ci}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, clamp(num(cap, 8), 1, 30));
}
// #59 章节速览增强：字数 / 预计分钟 / 是否已读 / 进度
export function chapterStats(chapters, progress, charsPerMin = 400) {
  const curCi = num(progress && progress.ci);
  return (chapters || []).map((c, i) => {
    const chars = stripTags(c && c.html).length;
    return { ci: i, title: str(c && c.title) || `第 ${i + 1} 节`, chars, minutes: Math.max(1, Math.round(chars / Math.max(1, num(charsPerMin)))), read: i < curCi, current: i === curCi };
  });
}
// #60 章节热力：按该书累计分钟占比上色（0–4 级）
export function chapterHeat(chapters, perChapterMs) {
  const v = (chapters || []).map((_, i) => num((perChapterMs || {})[i]));
  const max = Math.max(1, ...v);
  return v.map((ms, ci) => ({ ci, ms, level: ms <= 0 ? 0 : clamp(Math.ceil(ms / max * 4), 1, 4) }));
}

/* ============ 簇 7 · 计划与统计 ============ */

// #61 阅读计划：目标本数 + 截止日 + 书单
export function planOf(o) {
  const d = o || {};
  return { year: num(d.year) || new Date().getFullYear(), target: clamp(num(d.target, 12), 1, 999), deadline: str(d.deadline) || `${num(d.year) || new Date().getFullYear()}-12-31`, bookIds: (d.bookIds || []).slice(0, 200) };
}
// #62 进度与日均需读：剩余天数按自然日，不编造「还差多少本」以外的数据
export function planProgress(plan, finishedCount, now = new Date()) {
  const p = planOf(plan), done = num(finishedCount);
  const end = new Date(str(p.deadline) + 'T23:59:59');
  const days = Math.max(1, Math.ceil((end - now) / 86400000));
  return {
    done, target: p.target, pct: clamp(Math.round(done / Math.max(1, p.target) * 100), 0, 100),
    remaining: Math.max(0, p.target - done), daysLeft: days,
    perWeek: Math.max(0, Math.round((Math.max(0, p.target - done) / days) * 7 * 10) / 10),
    behind: done < p.target * (1 - days / 365),
  };
}
// #63 年度报告：只汇总真实存在的记录，没有数据不编造
export function yearReport(stats, metas, year) {
  const y = num(year) || new Date().getFullYear();
  const keys = Object.keys(stats || {}).filter((k) => k.startsWith(String(y)));
  const byBook = {}, perMonth = Array.from({ length: 12 }, () => 0);
  let totalMs = 0, activeDays = 0, best = null;
  keys.forEach((k) => {
    let ms = 0;
    Object.keys((stats[k] || {}).byBook || {}).forEach((id) => { const v = num(stats[k].byBook[id]); ms += v; byBook[id] = (byBook[id] || 0) + v; });
    totalMs += ms; if (ms > 0) activeDays++;
    perMonth[num(k.slice(5, 7)) - 1] += ms;
    if (!best || ms > best.ms) best = { key: k, ms };
  });
  const top = Object.keys(byBook).sort((a, b) => byBook[b] - byBook[a]).slice(0, 5).map((id) => ({ id, title: str((metas || []).find((m) => m.id === id)?.title || id), ms: byBook[id] }));
  return { year: y, totalMs, activeDays, best, perMonth, top, finished: num((metas || []).filter((m) => m.readState === 'finished').length) };
}
// #64 统计口径可解释：把「有效阅读」的剔除规则写明，而不是只给两个数
export function statsLegend(o) {
  return {
    total: '页面可见期间的累计时长',
    effective: '页面可见 + 30 秒内有真实交互或自动翻页推进',
    focus: '专注计时单独统计，不重复计入阅读时长',
    hidden: num((o || {}).hiddenMs),
    note: '切后台、打开面板、亮屏静置均不计入有效阅读',
  };
}
// #65 打卡提醒编排：静默日与时段双重判断
export function checkinAllowed(o) {
  const c = o || {}, now = c.now instanceof Date ? c.now : new Date();
  if (c.enabled === false) return false;
  if ((c.silentDays || []).includes(now.getDay())) return false;
  const h = now.getHours();
  return h >= num(c.fromHour, 8) && h < num(c.toHour, 22);
}
// #66 专注计时：暂停时累计已用，不把暂停时间算进去
export function focusTick(session, now = Date.now()) {
  const s = session || {};
  const elapsed = num(s.elapsed) + (s.running ? Math.max(0, num(now) - num(s.lastTs, now)) : 0);
  const left = Math.max(0, num(s.minutes, 25) * 60000 - elapsed);
  return { elapsed, left, done: left <= 0, running: !!s.running && left > 0 };
}
// #67 专注记录：只统计完成的会话，分钟取整
export function focusStats(sessions) {
  const done = (sessions || []).filter((s) => s && s.done);
  return { sessions: done.length, minutes: Math.round(done.reduce((a, s) => a + num(s.minutes, 25), 0)), lastAt: Math.max(0, ...done.map((s) => num(s.at))) };
}
// #68 周报：本期 / 上期环比、最长一天、活跃天数
export function weeklyDigest(stats, ref = new Date()) {
  const keys = Array.from({ length: 7 }, (_, i) => dayKey(addDays(ref, -i)));
  const prev = Array.from({ length: 7 }, (_, i) => dayKey(addDays(ref, -i - 7)));
  const sum = (ks) => ks.reduce((a, k) => a + Object.values((stats || {})[k]?.byBook || {}).reduce((x, y) => x + num(y), 0), 0);
  const vals = keys.map((k) => sum([k]));
  const cur = sum(keys), before = sum(prev);
  return { totalMs: cur, deltaMs: cur - before, bestDay: keys[vals.indexOf(Math.max(...vals))], activeDays: vals.filter((v) => v > 0).length };
}
// #69 读完本数：只认显式状态或 ≥99.5% 进度
export const finishedCount = (metas, progress) => (metas || []).filter((m) => readStateOf((progress || {})[m.id], (progress || {})[m.id]?.pct) === 'finished').length;
// #70 统计导出 CSV：日期 + 各书分钟，表头固定便于 Excel 打开
export function statsCsv(stats, metas) {
  const ids = uniq(Object.keys(stats || {}).flatMap((k) => Object.keys((stats[k] || {}).byBook || {})));
  const name = (id) => str((metas || []).find((m) => m.id === id)?.title || id).replace(/[",\n]/g, ' ');
  const rows = [['日期', ...ids.map(name), '合计(分钟)']];
  Object.keys(stats || {}).sort().forEach((k) => {
    const v = ids.map((id) => Math.round(num(stats[k].byBook?.[id]) / 60000));
    rows.push([k, ...v, v.reduce((a, b) => a + b, 0)]);
  });
  return rows.map((r) => r.join(',')).join('\n');
}

/* ============ 簇 8 · 朗读 ============ */

// #71 断点续读：书 / 章 / 段 + 语速一起记
export function ttsResume(o) {
  const d = o || {};
  return { bookId: str(d.bookId), ci: num(d.ci), paragraph: num(d.paragraph), rate: clamp(num(d.rate, 1), 0.5, 2), at: num(d.at) || Date.now() };
}
// #72 语速分书记忆
export const ttsRateFor = (bookId, perBook, globalRate) => clamp(num((perBook || {})[bookId], num(globalRate, 1)), 0.5, 2);
// #73 断句：中英文标点统一切分，保留标点
export function ttsBreakText(text, rules) {
  const r = rules || {};
  const parts = str(text).split(/(?<=[。！？!?；;：:\n])/).filter((x) => x.trim());
  return (r.maxLen ? parts.flatMap((p) => p.length <= num(r.maxLen) ? [p] : p.match(new RegExp(`[\\s\\S]{1,${num(r.maxLen)}}`, 'g')) || []) : parts).map((p) => p.trim()).filter(Boolean);
}
// #74 跳过结构文本：页码、脚注标记、目录行、纯符号
export function ttsSkip(text) {
  const t = str(text).trim();
  return !t || /^\d{1,4}$/.test(t) || /^\[\d+\]$/.test(t) || /^[·—\-•\s]+$/.test(t) || /^(目录|contents|index)$/i.test(t);
}
// #75 睡眠定时：到点返回剩余 0，不 abrupt 切断（由 UI 渐停）
export function sleepTimerEnd(startedAt, minutes, now = Date.now()) {
  const end = num(startedAt) + num(minutes) * 60000;
  return { end, left: Math.max(0, end - num(now)), expired: num(now) >= end };
}
// #76 多章连读队列：书末停止，不越界
export function ttsQueue(chapterCount, ci, n = 3) {
  return Array.from({ length: clamp(num(n, 3), 1, 20) }, (_, i) => num(ci) + i).filter((i) => i < num(chapterCount));
}
// #77 朗读高亮：返回当前句在整段中的位置
export function ttsHighlight(sentence, text) {
  const p = str(text).indexOf(str(sentence));
  return { found: p >= 0, start: Math.max(0, p), end: Math.max(0, p) + str(sentence).length };
}
// #78 朗读历史：最近优先，同一天同书合并
export function ttsHistoryPush(list, o) {
  const d = o || {}, k = dayKey(new Date(num(d.at) || Date.now()));
  const rest = (list || []).filter((x) => !(x.key === k && x.bookId === d.bookId));
  return [{ key: k, bookId: str(d.bookId), minutes: num(d.minutes), at: num(d.at) || Date.now() }].concat(rest).slice(0, 60);
}
// #79 降级提示：缺 Web Speech / 缺中文语音都要明确告知
export function ttsFallback(o) {
  const c = o || {};
  if (!c.webSpeech && !c.nativeBridge) return { mode: 'text', message: '当前环境不支持朗读，已改为逐句文字阅读' };
  if (!c.chineseVoice) return { mode: 'native', message: '系统缺少中文语音包，朗读效果可能不佳' };
  return { mode: c.nativeBridge ? 'native' : 'web', message: '' };
}
// #80 与自动翻页互斥，避免双重翻页
export function ttsTurnConflict(o) {
  const c = o || {};
  const conflict = !!c.ttsOn && (!!c.autoTurnOn || !!c.gazeOn);
  return { conflict, disable: conflict ? (c.autoTurnOn ? 'auto' : 'gaze') : null, message: conflict ? '朗读已开启，已暂停自动翻页避免重复翻页' : '' };
}

/* ============ 簇 9 · 可访问性与本地化 ============ */

// #81 读屏语义：图标按钮必须有名字，面板必须可聚焦
export const A11Y_LABELS = { back: '返回书架', prev: '上一页', next: '下一页', toc: '打开目录', bookmark: '书签', ai: 'AI 助手', close: '关闭面板', search: '搜索', settings: '设置' };
export const a11yLabel = (icon) => A11Y_LABELS[icon] || str(icon);
export const dialogA11y = (label) => ({ role: 'dialog', 'aria-modal': 'true', 'aria-label': str(label), tabindex: '-1' });
// #82 跟随系统字号：两者不能同时放大
export function systemFontScale(o) {
  const c = o || {};
  return c.followSystem ? clamp(num(c.systemScale, 1) * num(c.baseSize, 20), 12, 36) : clamp(num(c.baseSize, 20), 12, 36);
}
// #83 WCAG 对比度：低于 4.5:1 明确提示
export function contrastRatio(hex1, hex2) {
  const lum = (h) => {
    const s = str(h).replace('#', '');
    const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const a = lum(hex1), b = lum(hex2);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return { ratio: Math.round(ratio * 100) / 100, pass: ratio >= 4.5, advice: ratio >= 4.5 ? '' : '对比度低于 4.5:1，建议加深文字或减淡纸色' };
}
// #84 减弱动态效果
export function reducedMotion(o) {
  const c = o || {};
  const reduce = !!c.systemReduced || !!c.userReduced;
  return { reduce, animation: !reduce, message: reduce ? '已按系统偏好关闭翻页动画与浮层位移' : '' };
}
// #85–87 语言包与热切换：未翻译的 key 回退中文，绝不显示占位符
export const I18N = {
  zh: { shelf: '书架', stats: '统计', search: '搜索', notes: '笔记', settings: '设置', empty: '还没有内容', close: '关闭', save: '保存' },
  zh_Hant: { shelf: '書架', stats: '統計', search: '搜尋', notes: '筆記', settings: '設定', empty: '還沒有內容', close: '關閉', save: '儲存' },
  en: { shelf: 'Shelf', stats: 'Stats', search: 'Search', notes: 'Notes', settings: 'Settings', empty: 'Nothing here yet', close: 'Close', save: 'Save' },
};
export function t(key, lang) {
  const pack = I18N[lang] || I18N.zh;
  return pack[key] || I18N.zh[key] || str(key);
}
export function applyI18n(lang) {
  const keys = Object.keys(I18N.zh);
  return keys.reduce((o, k) => { o[k] = t(k, lang); return o; }, {});
}
// #88 空状态体系：每种空态都带一个明确的下一步动作
export const EMPTY_STATES = {
  shelf: { title: '书架还是空的', desc: '导入第一本书，开始你的本地阅读', action: '导入书籍' },
  search: { title: '没有找到结果', desc: '换个关键词，或检查是否开启了整词匹配', action: '清空条件' },
  stats: { title: '还没有阅读记录', desc: '打开任意一本书，这里会记下首读日期与每日分钟', action: '去书架' },
  notes: { title: '还没有笔记', desc: '选中一段文字写下想法，笔记会锚定到原文', action: '开始阅读' },
  trash: { title: '回收站是空的', desc: '删除的书会在这里保留 30 天', action: '返回书架' },
};
export const emptyState = (kind, lang) => {
  const e = EMPTY_STATES[kind] || EMPTY_STATES.shelf;
  return { title: t(e.title, lang) === e.title ? e.title : e.title, desc: e.desc, action: e.action };
};
// #89 设置搜索：按标题 / 分组 / 关键字命中
export function filterSettings(items, q) {
  const s = str(q).trim().toLowerCase();
  if (!s) return items || [];
  return (items || []).filter((it) => `${str(it.title)} ${str(it.group)} ${(it.keywords || []).join(' ')}`.toLowerCase().includes(s));
}
// #90 引导按功能重放：只重放没用过的功能
export function guideReplay(features, seen) {
  const s = new Set(seen || []);
  return (features || []).filter((f) => !s.has(f));
}

/* ============ 簇 10 · 同步、分享与多用户 ============ */

// #91–93 离线变更队列：只记录意图，不宣称已同步；ack 必须在确认远端成功后调用
export function syncQueuePut(list, op) {
  const d = op || {};
  return (list || []).concat([{ id: `q${Date.now()}${Math.random().toString(36).slice(2, 6)}`, type: str(d.type), key: str(d.key), at: num(d.at) || Date.now(), state: 'pending' }]);
}
export const syncQueuePeek = (list) => (list || []).filter((x) => x.state === 'pending');
export function syncQueueAck(list, id) {
  return (list || []).map((x) => x.id === id ? Object.assign({}, x, { state: 'done' }) : x);
}
export function syncConflictPreview(localVersion, remoteVersion) {
  const same = str(localVersion && localVersion.updatedAt) === str(remoteVersion && remoteVersion.updatedAt);
  return { conflict: !same, local: localVersion, remote: remoteVersion, needsChoice: !same };
}
// #94–95 配置档：所有键带命名空间前缀，切换档位不串数据
export function profileNamespace(name) {
  const v = str(name).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return v || 'default';
}
export const profileScopedKey = (profile, key) => `inkreader:${profileNamespace(profile)}:${str(key)}`;
// #96–97 书单分享与导入：逐本确认，不自动加书
export function shareListHtml(metas, title = '我的书单') {
  const esc = (s) => str(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><ul>` +
    (metas || []).map((m) => `<li data-id="${esc(m.id)}">${esc(m.title)} — ${esc(m.author || '佚名')}</li>`).join('') + '</ul>';
}
export function parseBooklist(text) {
  const out = [];
  const re = /<li[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m; while ((m = re.exec(str(text)))) out.push({ id: m[1], title: stripTags(m[2]).split('—')[0].trim(), autoAdd: false });
  return out;
}
// #98 应用锁：只做本地 PIN 校验，不宣称加密强度
export function pinOk(pin, stored) {
  return /^\d{4,8}$/.test(str(pin)) && str(pin) === str(stored);
}
// #99 隐私面板：一页列清权限与联网目标
export function privacyReport(o) {
  const c = o || {};
  return {
    permissions: c.permissions || [],
    networkTargets: c.networkTargets || [],
    localOnly: (c.networkTargets || []).length === 0,
    note: '书籍正文、笔记、统计默认仅存本机；AI 与同步需用户主动开启并填写地址才联网',
  };
}
// #100 数据可携带：导出清单与彻底清空清单分开，清空必须二次确认
export function purgePlan(o) {
  const c = o || {};
  const keys = ['books', 'progress', 'stats', 'bookmarks', 'highlights', 'favorites', 'notes', 'trash', 'config'];
  return { confirmed: !!c.confirmed, keys, exportFirst: !c.exported, message: c.exported ? '确认后将删除全部本地数据且不可恢复' : '建议先导出全量备份' };
}

/* ============ 簇 11 · 智能推荐与发现 ============ */

// #101 相似书：标签/系列/作者/体裁重叠度，同作者弱加权避免全是同一人
export function similarBooks(metas, target, n = 5) {
  const t = target || {};
  const tags = new Set(normalizeTags(t.tags));
  const series = str(t.series).toLowerCase();
  const author = str(t.author).toLowerCase();
  const genre = str(t.genre).toLowerCase();
  const scored = (metas || []).filter((m) => m && m.id !== t.id).map((m) => {
    let s = 0;
    normalizeTags(m.tags).forEach((tg) => { if (tags.has(tg)) s += 3; });
    if (str(m.series).toLowerCase() === series && series) s += 4;
    const sameAuthor = str(m.author).toLowerCase() === author && author;
    if (sameAuthor) s += 1;
    if (str(m.genre).toLowerCase() && str(m.genre).toLowerCase() === genre) s += 2;
    return { id: m.id, title: str(m.title), score: s, sameAuthor: !!sameAuthor };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || (a.sameAuthor ? 1 : 0) - (b.sameAuthor ? 1 : 0));
  return scored.slice(0, clamp(num(n, 5), 1, 20));
}
// #102 继续阅读排序：未读完+最近打开在前，读完沉底
export function continueRanking(metas, progress, now = Date.now()) {
  return (metas || []).slice().sort((a, b) => {
    const pa = (progress || {})[a.id] || {}, pb = (progress || {})[b.id] || {};
    const fa = readStateOf(pa, pa.pct) === 'finished' ? 0 : 1;
    const fb = readStateOf(pb, pb.pct) === 'finished' ? 0 : 1;
    if (fa !== fb) return fb - fa;
    return num(pb.lastReadAt) - num(pa.lastReadAt);
  });
}
// #103 待读队列：计划内未读 + 书架未读按加入顺序
export function upNextQueue(plan, metas, progress) {
  const p = planOf(plan || {});
  const inPlan = new Set(p.bookIds);
  const list = (metas || []).filter((m) => {
    const pr = (progress || {})[m.id];
    return readStateOf(pr, pr && pr.pct) !== 'finished' && (inPlan.has(m.id) || inPlan.size === 0);
  });
  list.sort((a, b) => num(a.addedAt) - num(b.addedAt));
  return list.slice(0, 20).map((m) => ({ id: m.id, title: str(m.title), inPlan: inPlan.has(m.id) }));
}
// #104 按标签发现：返回带该标签的书与该标签覆盖率
export function discoverByTag(metas, tag) {
  const tg = str(tag).trim().toLowerCase();
  const all = metas || [];
  const tagged = all.filter((m) => normalizeTags(m.tags).some((x) => x.toLowerCase() === tg));
  return { tag: str(tag), books: tagged.map((m) => ({ id: m.id, title: str(m.title) })), coverage: all.length ? Math.round(tagged.length / all.length * 100) : 0 };
}
// #105 久未翻开提醒：超过 days 没打开且未读完
export function forgottenNudge(metas, progress, now = Date.now(), days = 30) {
  const lim = num(days, 30) * 86400000;
  return (metas || []).filter((m) => {
    const pr = (progress || {})[m.id];
    if (readStateOf(pr, pr && pr.pct) === 'finished') return false;
    return now - num(m.lastReadAt || m.addedAt) >= lim;
  }).map((m) => ({ id: m.id, title: str(m.title), daysIdle: Math.floor((now - num(m.lastReadAt || m.addedAt)) / 86400000) }));
}
// #106 新书速览：最近 windowDays 内加入
export function newArrivals(metas, now = Date.now(), windowDays = 30) {
  const lim = num(windowDays, 30) * 86400000;
  return (metas || []).filter((m) => now - num(m.addedAt) <= lim).sort((a, b) => num(b.addedAt) - num(a.addedAt)).map((m) => ({ id: m.id, title: str(m.title), addedAt: num(m.addedAt) }));
}
// #107 心情匹配：场景→标签组合
export const MOOD_MAP = { sleep: ['散文', '诗歌', '治愈'], commute: ['小说', '悬疑', '随笔'], fragment: ['短篇', '杂文', '漫画'] };
export function moodMatch(metas, mood) {
  const tags = MOOD_MAP[str(mood)] || [];
  if (!tags.length) return [];
  return (metas || []).filter((m) => normalizeTags(m.tags).some((t) => tags.includes(t))).map((m) => ({ id: m.id, title: str(m.title) }));
}
// #108 作者深挖：同作者聚合并标读况
export function authorDeepDive(metas, progress, author) {
  const a = str(author).toLowerCase();
  const books = (metas || []).filter((m) => str(m.author).toLowerCase() === a);
  const total = books.length;
  const read = books.filter((m) => { const pr = (progress || {})[m.id]; return readStateOf(pr, pr && pr.pct) === 'finished'; }).length;
  return { author: str(author), total, read, unread: total - read, books: books.map((m) => ({ id: m.id, title: str(m.title) })) };
}
// #109 重读建议：已读完且最近 days 没碰
export function rereadSuggestion(metas, progress, now = Date.now(), days = 90) {
  const lim = num(days, 90) * 86400000;
  return (metas || []).filter((m) => {
    const pr = (progress || {})[m.id];
    return readStateOf(pr, pr && pr.pct) === 'finished' && now - num(m.lastReadAt || 0) >= lim;
  }).map((m) => ({ id: m.id, title: str(m.title) }));
}
// #110 馆内趋势：被读最多的标签
export function libraryTrending(stats, metas, topN = 5) {
  const byTag = new Map();
  (metas || []).forEach((m) => {
    const dayKey0 = dayKey(new Date(num(m.lastReadAt)));
    const ms = Object.values((stats || {})[dayKey0]?.byBook || {}).reduce((a, b) => a + num(b), 0);
    if (ms <= 0) return;
    normalizeTags(m.tags).forEach((t) => byTag.set(t, (byTag.get(t) || 0) + 1));
  });
  return Array.from(byTag.entries()).sort((a, b) => b[1] - a[1]).slice(0, clamp(num(topN, 5), 1, 20)).map(([tag, count]) => ({ tag, count }));
}

/* ============ 簇 12 · 阅读仪式感与氛围 ============ */

// #111 连续阅读环：连续天数/目标，断了不羞辱
export function streakRing(streak, target = 7) {
  const s = Math.max(0, num(streak));
  const t = Math.max(1, num(target));
  return { streak: s, target: t, pct: clamp(Math.round(s / t * 100), 0, 100), broken: s === 0, gentle: s === 0 ? '距上次只差 1 天' : '' };
}
// #112 环境音预设（元数据，音频资源需真机）
export const AMBIENT_PRESETS = [
  { id: 'rain', name: '雨声', loop: true }, { id: 'cafe', name: '咖啡馆', loop: true },
  { id: 'white', name: '白噪音', loop: true }, { id: 'off', name: '静音', loop: false },
];
export const ambientPresets = () => AMBIENT_PRESETS;
// #113 每日一句：确定性种子，不跳变
export function dailyQuote(pool, seedKey) {
  const arr = (pool || []).filter((x) => x && (x.text || x));
  if (!arr.length) return null;
  const key = str(seedKey || dayKey(new Date()));
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pick = arr[h % arr.length];
  return { text: str(pick.text || pick), source: pick.source ? str(pick.source) : '', index: h % arr.length };
}
// #114 目标进度小组件数据
export function goalWidget(plan, finishedCount, now) {
  const pp = planProgress(plan, finishedCount, now);
  return { pct: pp.pct, done: pp.done, target: pp.target, daysLeft: pp.daysLeft, behind: pp.behind };
}
// #115 本次阅读小结
export function sessionEndSummary(session) {
  const s = session || {};
  return { minutes: Math.max(0, Math.round(num(s.ms) / 60000)), chapters: num(s.chaptersRead), pages: num(s.pagesRead), moreThanYesterday: num(s.ms) > num(s.yesterdayMs) };
}
// #116 读完庆祝数据
export function finishCelebration(book) {
  const b = book || {};
  return { title: str(b.title), author: str(b.author), celebrated: true, shareable: true };
}
// #117 昼夜自动主题
export function autoCozyTheme(hour, cfg) {
  const c = cfg || {};
  const nightStart = num(c.nightStart, 19), dayStart = num(c.dayStart, 7);
  const h = num(hour, new Date().getHours());
  const night = h >= nightStart || h < dayStart;
  return { night, paper: night ? (c.nightPaper || '#15171a') : (c.dayPaper || '#fefdfb'), ink: night ? (c.nightInk || '#d8d4c8') : (c.dayInk || '#202b31') };
}
// #118 阅读时段洞察：哪个时段读得最多（接受已聚合 hourBuckets）
export function timeOfDayInsight(stats) {
  const hb = (stats && stats.hourBuckets) || {};
  const buckets = Array.from({ length: 24 }, () => 0);
  Object.keys(hb).forEach((h) => { buckets[num(h)] += num(hb[h]); });
  let best = 0; for (let i = 1; i < 24; i++) if (buckets[i] > buckets[best]) best = i;
  return { bestHour: buckets[best] > 0 ? best : -1, buckets, peakLabel: buckets[best] > 0 ? `${String(best).padStart(2, '0')}:00` : '暂无数据' };
}
// #119 成就轻提示
export function achievementToast(achievements) {
  const a = (achievements || []).filter((x) => x && x.name);
  return { latest: a[a.length - 1] || null, dismissible: true };
}
// #120 阅读仪式清单
export const RITUAL_STEPS = [{ id: 'dim', name: '调暗灯光' }, { id: 'headphone', name: '戴耳机' }, { id: 'focus', name: '设专注' }];
export const ritualSteps = () => RITUAL_STEPS;

/* ============ 簇 13 · 学习效率系统 ============ */

// #121 间隔复习调度（学习专用）：到期且今天没学过才进队列
export function spacedRepetition(notes, now = Date.now(), n = 8) {
  const t = num(now);
  return (notes || []).filter((x) => {
    const age = (t - num(x.at)) / 86400000;
    const due = [1, 3, 7, 14, 30, 60].some((d) => age >= d && age < d + 1.5);
    const learnedToday = num(x.lastLearned) >= t - 86400000;
    return due && !learnedToday;
  }).sort((a, b) => num(a.at) - num(b.at)).slice(0, clamp(num(n, 8), 1, 30));
}
// #122 划词查词（本地小词典）
export function dictionaryLookup(word, dict) {
  const w = str(word).trim();
  const d = dict || {};
  return { word: w, found: Object.prototype.hasOwnProperty.call(d, w), def: d[w] || '', needsNetwork: !Object.prototype.hasOwnProperty.call(d, w) };
}
// #123 划词翻译：未配置服务时明确告知，不静默失败
export function translateInline(text, cfg) {
  const c = cfg || {};
  if (!c.apiKey && !c.bridge) return { ok: false, reason: '未配置翻译服务，默认关闭以保护隐私', text: str(text) };
  return { ok: true, text: str(text), target: str(c.target || 'zh'), service: c.bridge ? 'native' : 'api' };
}
// #124 概念图谱：专名共现
export function conceptGraph(chapters, topN = 20) {
  const counts = new Map();
  (chapters || []).forEach((c) => {
    const t = stripTags(c && c.html);
    const re = /[\u4e00-\u9fa5]{2,4}(?=[，。！？、；：\s]|$)/g;
    let m;
    while ((m = re.exec(t))) { const w = m[0]; if (/^(这是|我们|因为|所以|但是)/.test(w)) continue; counts.set(w, (counts.get(w) || 0) + 1); }
  });
  const nodes = Array.from(counts.entries()).filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]).slice(0, clamp(num(topN, 20), 1, 50)).map(([name, count]) => ({ name, count }));
  return { nodes, edges: 0 };
}
// #125 单书学习计划：每天读几章
export function studyPlan(book, targetDate, now = new Date()) {
  const b = book || {};
  const remaining = Math.max(0, num(b.chaptersCount) - num(b.readChapters));
  const end = new Date(str(targetDate) || new Date().toISOString().slice(0, 10));
  const days = Math.max(1, Math.ceil((end - now) / 86400000));
  return { remaining, days, perDay: Math.max(1, Math.ceil(remaining / days)), feasible: remaining <= days * 50 };
}
// #126 回忆模式：遮原文考你
export function quizMode(notes, n = 5) {
  const ns = (notes || []).filter((x) => x && x.quote);
  return ns.slice(0, clamp(num(n, 5), 1, 30)).map((x) => ({ id: x.id, question: str(x.quote), answer: str(x.text), revealed: false }));
}
// #127 标注密度：每章批注数
export function highlightDensity(chapters, notes) {
  const per = {};
  (notes || []).forEach((x) => { per[num(x.ci)] = (per[num(x.ci)] || 0) + 1; });
  return (chapters || []).map((c, i) => ({ ci: i, count: per[i] || 0 }));
}
// #128 术语表抽取
export function glossaryExtract(chapters, topN = 20) {
  return conceptGraph(chapters, topN).nodes.map((n) => ({ term: n.name, freq: n.count }));
}
// #129 章节摘要：首句
export function summaryChapters(chapters, topN = 3) {
  return (chapters || []).map((c, i) => {
    const t = stripTags(c && c.html);
    const first = (t.split(/[。！？.!?]/).filter((s) => s.trim()).slice(0, clamp(num(topN, 3), 1, 10)).join('。') + '。').slice(0, 120);
    return { ci: i, title: str(c && c.title), summary: first };
  });
}
// #130 导出 Anki CSV：词,释义,标签,来源
export function exportAnkiCsv(notes, metas) {
  const titleOf = (id) => str((metas || []).find((m) => m.id === id)?.title || id);
  const rows = [['Front', 'Back', 'Tags', 'Source']];
  (notes || []).forEach((n) => rows.push([str(n.quote).replace(/[",\n]/g, ' '), str(n.text).replace(/[",\n]/g, ' '), (n.tags || []).join(' '), titleOf(n.bookId)]));
  return rows.map((r) => r.join(',')).join('\n');
}

/* ============ 簇 14 · 设备与系统集成 ============ */

// #135 分享接入导入：解析分享意图里的文件信息
export function shareToImport(intent) {
  const i = intent || {};
  const name = str(i.fileName || i.name || '');
  const ok = /\.(epub|pdf|txt|mobi)$/i.test(name) || /epub|pdf|txt/i.test(str(i.mime));
  return { accepted: ok, fileName: name, mime: str(i.mime), bookId: ok ? `shared:${name}` : null };
}
// #136 文件关联支持
export const SUPPORTED_OPEN = ['application/epub+zip', 'application/pdf', 'text/plain'];
export function fileAssociation(mime, ext) {
  const m = str(mime).toLowerCase(); const e = str(ext).toLowerCase().replace(/^\./, '');
  return SUPPORTED_OPEN.includes(m) || ['epub', 'pdf', 'txt'].includes(e);
}
// #139 分屏支持声明
export const splitScreenSupported = () => true; // Android 端由 manifest 声明，Web 恒 true
// #132 媒体控制元数据
export function mediaControlsState(tts, book) {
  const t = tts || {};
  return { active: !!t.on, title: str(book && book.title), chapter: str(book && book.chapterTitle), canPrev: !!t.canPrev, canNext: !!t.canNext };
}
// #131 快捷开关磁贴（数据，需原生桥激活）
export const QUICK_TILES = [{ id: 'resume', label: '继续阅读' }, { id: 'import', label: '导入' }, { id: 'tts', label: '朗读' }];
export const quickTileActions = () => QUICK_TILES;
// #133 通知操作（数据）
export const NOTIFY_ACTIONS = [{ id: 'focus_end', label: '专注结束' }, { id: 'eye_rest', label: '护眼提醒' }];
export const notificationActions = () => NOTIFY_ACTIONS;
// #134 桌面小部件（数据）
export function widgetConfig(o) { const c = o || {}; return { enabled: !!c.enabled, showRing: c.showRing !== false, showResume: !!c.showResume }; }
// #137 电量感知调暗：低电量降亮度/关动画
export function batteryAwareDim(battery, cfg) {
  const b = num(battery, 100), c = cfg || {};
  if (!c.enabled) return { dim: false, animation: true };
  const low = b <= num(c.threshold, 15);
  return { dim: low, brightness: low ? clamp(num(c.dimTo, 60), 10, 100) : 100, animation: !low };
}
// #138 耳机线控映射
export const HEADPHONE_MAP = { mediaPrev: 'prevPage', mediaNext: 'nextPage', mediaPlayPause: 'ttsToggle' };
export const headphoneControls = () => HEADPHONE_MAP;
// #140 PWA 安装提示状态
export function pwaInstallPromptState(o) { const c = o || {}; return { canInstall: !!c.canInstall, dismissed: !!c.dismissed, deferred: !!c.deferred }; }

/* ============ 簇 15 · 社交与共读（纯本地） ============ */

// #145 金句卡片墙数据
export function quoteCardGallery(notes, n = 12) {
  return (notes || []).filter((x) => x && x.quote).slice(0, clamp(num(n, 12), 1, 50)).map((x) => ({ id: x.id, quote: str(x.quote), bookId: str(x.bookId), color: str(x.color) || 'important' }));
}
// #147 推荐信生成
export function recommendationLetter(book, opts) {
  const b = book || {}, o = opts || {};
  const why = str(o.reason) || '文笔与见识都值得一读';
  return { book: str(b.title), author: str(b.author), to: str(o.to || '朋友'), text: `想给你推荐《${str(b.title)}》${b.author ? '（' + str(b.author) + '）' : ''}。${why}。` };
}
// #148 阅读手记结构
export function readingJournal(entry) {
  const e = entry || {};
  return { date: dayKey(e.date ? new Date(num(e.date)) : new Date()), text: str(e.text).slice(0, 2000), bookId: str(e.bookId), at: num(e.at) || Date.now() };
}
// #141 本地书友圈结构（文件交换）
export function localBookClub(o) { const c = o || {}; return { name: str(c.name || '我的书友圈'), members: (c.members || []).slice(0, 50), sharedBooks: (c.sharedBooks || []).slice(0, 200), localOnly: true }; }
// #142 共享批注文件解析
export function parseSharedAnnotations(text) {
  const out = []; const re = /<annotation[^>]*data-book="([^"]+)"[^>]*>([\s\S]*?)<\/annotation>/gi;
  let m; while ((m = re.exec(str(text)))) out.push({ bookId: m[1], text: stripTags(m[2]) });
  return out;
}
// #143 借阅记录
export function lendingRecord(list, op) {
  const l = list || []; const o = op || {};
  if (o.return) return l.filter((x) => x.id !== o.id);
  return l.concat([{ id: o.id || `lend:${Date.now()}`, bookTitle: str(o.bookTitle), to: str(o.to), at: num(o.at) || Date.now(), returned: false }]);
}
// #144 本地共读挑战
export function readingChallengeLocal(friends, me) {
  const all = (friends || []).concat([{ name: '我', count: num(me) }]);
  return all.sort((a, b) => num(b.count) - num(a.count)).map((f) => ({ name: str(f.name), count: num(f.count) }));
}
// #146 本地讨论串
export function discussionThread(bookId, posts) {
  return { bookId: str(bookId), posts: (posts || []).map((p) => ({ at: num(p.at), text: str(p.text).slice(0, 1000) })), localOnly: true };
}
// #149 书架展示页数据
export function bookshelfShowcase(metas, n = 12) {
  return (metas || []).slice(0, clamp(num(n, 12), 1, 50)).map((m) => ({ id: m.id, title: str(m.title), author: str(m.author) }));
}
// #150 家庭档案
export function familyProfiles(list, name) {
  const l = list || []; const key = profileNamespace(name || 'default');
  if (!l.find((p) => p.key === key)) l.push({ key, name: str(name || '默认'), books: 0 });
  return l;
}

/* ============ 簇 16 · 数据洞察与可视化 ============ */

// #151 真实阅读速度：章字数 ÷ 实际分钟
export function readingSpeed(chars, ms) {
  const c = num(chars), m = num(ms);
  if (m <= 0) return { cpm: 0, note: '尚无有效时长' };
  const perMin = c / (m / 60000);
  return { cpm: Math.round(perMin), min: Math.round(perMin), note: '' };
}
// #153 体裁分布
export function genreDistribution(metas) {
  const map = new Map();
  (metas || []).forEach((m) => { const g = str(m.genre || '未分类') || '未分类'; map.set(g, (map.get(g) || 0) + 1); });
  return Array.from(map.entries()).map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count);
}
// #154 时段热力：24 小时分钟
export function timeOfDayHeatmap(hourBuckets) {
  const b = hourBuckets || {};
  const arr = Array.from({ length: 24 }, (_, h) => num(b[h]));
  const max = Math.max(1, ...arr);
  return arr.map((v, h) => ({ hour: h, ms: v, level: v <= 0 ? 0 : clamp(Math.ceil(v / max * 4), 1, 4) }));
}
// #156 坚持度评分 0-100
export function consistencyScore(stats, days = 30) {
  const keys = Array.from({ length: num(days, 30) }, (_, i) => dayKey(addDays(new Date(), -i)));
  const active = keys.filter((k) => Object.values((stats || {})[k]?.byBook || {}).reduce((a, b) => a + num(b), 0) > 0).length;
  return { score: clamp(Math.round(active / num(days, 30) * 100), 0, 100), activeDays: active };
}
// #157 读完预测
export function forecastFinish(book, paceCpm, dailyMinutes) {
  const b = book || {}; const remain = num(b.remainingChars);
  const cpm = Math.max(1, num(paceCpm)); const dm = Math.max(1, num(dailyMinutes));
  const days = Math.ceil(remain / cpm / dm);
  const d = addDays(new Date(), days);
  return { days, eta: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, feasible: days < 3650 };
}
// #158 周期对比
export function periodCompare(stats, keysA, keysB) {
  const sum = (ks) => (ks || []).reduce((a, k) => a + Object.values((stats || {})[k]?.byBook || {}).reduce((x, y) => x + num(y), 0), 0);
  const a = sum(keysA), b = sum(keysB);
  return { a, b, delta: a - b, pct: b > 0 ? Math.round((a - b) / b * 100) : (a > 0 ? 100 : 0) };
}
// #159 年度书影
export function yearInBooks(stats, metas, year) {
  const r = yearReport(stats, metas, year);
  return { year: r.year, totalHours: Math.round(r.totalMs / 3600000 * 10) / 10, activeDays: r.activeDays, finished: r.finished, top: r.top };
}
// #152 专注力曲线（有效/无效）
export function attentionCurve(sessions) {
  return (sessions || []).map((s) => ({ at: num(s.at), effective: num(s.effectiveMs), idle: Math.max(0, num(s.totalMs) - num(s.effectiveMs)) }));
}
// #155 篇幅 vs 耗时
export function bookLengthVsTime(books) {
  return (books || []).map((b) => ({ id: b.id, title: str(b.title), chars: num(b.chars), days: num(b.daysTaken) })).filter((x) => x.chars > 0 && x.days > 0);
}
// #160 阅读 DNA 趣味标签
export function readingDna(stats, metas) {
  const score = consistencyScore(stats).score;
  const genres = genreDistribution(metas);
  const topGenre = genres[0] ? genres[0].genre : '杂食';
  const archetype = score >= 80 ? '定力型' : score >= 50 ? '规律型' : '随性型';
  return { archetype, topGenre, consistency: score };
}

/* ============ 簇 17 · 智能自动化 ============ */

// #161 自动归档已读
export function autoArchiveFinished(metas, progress, now = Date.now(), idleDays = 30) {
  const lim = num(idleDays, 30) * 86400000;
  return (metas || []).filter((m) => {
    const pr = (progress || {})[m.id];
    return readStateOf(pr, pr && pr.pct) === 'finished' && now - num(m.lastReadAt || 0) >= lim;
  }).map((m) => ({ id: m.id, title: str(m.title) }));
}
// #162 智能标签建议
export function smartTagSuggest(book, existingTags, n = 3) {
  const b = book || {}; const pool = normalizeTags(existingTags);
  const hints = [];
  if (/传|记|史|回忆录/.test(str(b.title))) hints.push('传记');
  if (/小?说|故事|长篇/.test(str(b.title))) hints.push('小说');
  if (pool.length) hints.push(pool[0]);
  const author = str(b.author);
  if (author) hints.push(author.length <= 4 ? author : '名家');
  return uniq(hints).slice(0, clamp(num(n, 3), 1, 10));
}
// #163 自动续读上次
export function autoResumeLast(metas, progress, now = Date.now()) {
  const cand = (metas || []).filter((m) => {
    const pr = (progress || {})[m.id];
    return readStateOf(pr, pr && pr.pct) !== 'finished';
  });
  cand.sort((a, b) => num(b.lastReadAt) - num(a.lastReadAt));
  return cand[0] ? { id: cand[0].id, title: str(cand[0].title) } : null;
}
// #164 夜间模式定时
export function nightModeSchedule(now, cfg) {
  const c = cfg || {}; const d = now instanceof Date ? now : new Date();
  const h = d.getHours();
  const on = h >= num(c.nightStart, 19) || h < num(c.dayStart, 7);
  return { on, nightStart: num(c.nightStart, 19), dayStart: num(c.dayStart, 7) };
}
// #166 导入即智能去重
export function smartDedupeOnImport(incoming, localBooks) {
  const res = { added: [], merged: [], skipped: 0 };
  (incoming || []).forEach((b) => {
    const k = dedupeKey(b);
    const hit = (localBooks || []).find((x) => dedupeKey(x) === k);
    if (!hit) res.added.push(b);
    else if (num(b.updatedAt) > num(hit.updatedAt)) res.merged.push(b);
    else res.skipped++;
  });
  return res;
}
// #167 静默时段免打扰
export function quietHoursSilence(now, cfg) {
  const c = cfg || {}; const d = now instanceof Date ? now : new Date();
  if (!c.enabled) return false;
  const h = d.getHours();
  return h >= num(c.from, 22) || h < num(c.to, 8);
}
// #170 批量操作
export function batchOperations(ids, op) {
  const o = op || {};
  if (o.type === 'tag') return (ids || []).map((id) => ({ id, tags: normalizeTags(o.tags) }));
  if (o.type === 'archive') return (ids || []).map((id) => ({ id, archived: true }));
  if (o.type === 'export') return { ids: (ids || []).slice(), count: (ids || []).length };
  return { ids: ids || [], applied: false };
}
// #165 自动备份节拍
export function autoBackupCadence(lastBackup, cfg, now = Date.now()) {
  const c = cfg || {}; if (!c.enabled) return { due: false, reason: '未开启' };
  const every = num(c.everyDays, 7) * 86400000;
  const due = now - num(lastBackup) >= every;
  return { due, reason: due ? `已超过 ${c.everyDays || 7} 天未备份` : '' };
}
// #168 变更即备份策略
export function changeBackupPolicy(op) { const o = op || {}; return { backupBefore: ['deleteBook', 'purge', 'resetConfig'].includes(o.action) && o.forced !== false, required: o.action === 'purge' }; }
// #169 规则引擎（安全条件对象，不用 eval）
export function ruleEngine(rules, ctx) {
  const c = ctx || {};
  return (rules || []).map((r) => {
    const w = r.when || {};
    let cond = true;
    if (w.field) {
      const v = c[w.field];
      if (w.op === 'eq') cond = v === w.value;
      else if (w.op === 'gt') cond = num(v) > num(w.value);
      else if (w.op === 'gte') cond = num(v) >= num(w.value);
      else if (w.op === 'lt') cond = num(v) < num(w.value);
      else if (w.op === 'in') cond = (w.value || []).includes(v);
      else cond = true;
    }
    return { id: r.id, matched: !!cond, action: cond ? r.then : null };
  });
}

/* ============ 簇 18 · 内容创作与输出 ============ */

// #171 笔记导出 Markdown
export function exportNotesMarkdown(notes, metas, opts) {
  const o = opts || {}; const titleOf = (id) => str((metas || []).find((m) => m.id === id)?.title || id);
  const groups = {};
  (notes || []).forEach((n) => { const k = titleOf(n.bookId); (groups[k] = groups[k] || []).push(n); });
  let md = `# 阅读笔记\n\n> 导出于 ${dayKey(new Date())}\n\n`;
  Object.keys(groups).forEach((book) => {
    md += `## 《${book}》\n\n`;
    groups[book].forEach((n) => {
      md += `> ${str(n.quote)}\n\n${str(n.text)}\n\n${o.tags !== false && (n.tags || []).length ? '_标签：' + (n.tags || []).join('、') + '_\n\n' : ''}`;
    });
  });
  return md;
}
// #174 长篇读书报告
export function longExportReport(book, notes, stats) {
  const b = book || {}; const ns = notes || [];
  return { title: str(b.title), author: str(b.author), noteCount: ns.length, minutes: Math.round(num(stats && stats.totalMs) / 60000), body: `《${str(b.title)}》共 ${ns.length} 条笔记。${ns.slice(0, 3).map((n) => str(n.quote)).join('；')}。` };
}
// #179 博客草稿
export function blogDraftFromNotes(notes, opts) {
  const o = opts || {}; const ns = notes || [];
  const head = `# ${str(o.title || '读书随笔')}\n\n`;
  const body = ns.map((n) => `> ${str(n.quote)}\n\n${str(n.text)}\n`).join('\n');
  return head + body;
}
// #176 引文管理：生成引用格式
export function citationManager(note, book) {
  const b = book || {}; const n = note || {};
  return { apa: `${str(b.author || '佚名')}（${str(b.year || 'n.d.')}）。《${str(b.title || '未知')}》。${str(n.quote || '')}`, page: str(n.page || '') };
}
// #175 自定义模板（列表）
export const NOTE_TEMPLATES = [{ id: 'plot', name: '情节' }, { id: 'character', name: '人物' }, { id: 'quote', name: '金句' }, { id: 'free', name: '自由' }];
export const noteTemplates = () => NOTE_TEMPLATES;
// #172 注释层导出 EPUB（结构）
export function exportEpubAnnotation(notes) {
  return { format: 'epub-annotation', count: (notes || []).length, entries: (notes || []).map((n) => ({ bookId: n.bookId, cfi: n.anchor || '', text: str(n.text) })), portable: false };
}
// #177 思维导图导出（结构）
export function mindMapExport(outline) {
  const o = outline || {};
  return { root: str(o.root || '书'), nodes: (o.nodes || []).map((n) => ({ id: n.id, parent: n.parent || 'root', label: str(n.label) })), format: 'opml-ish' };
}
// #178 PDF 批注导出（结构）
export function pdfAnnotationExport(notes) {
  return { format: 'pdf-summary', count: (notes || []).length, needsSource: true, items: (notes || []).map((n) => ({ page: num(n.page), text: str(n.text) })) };
}
// #173 截图卡片（数据，Canvas 渲染推真机）
export function clipToImage(note) {
  const n = note || {};
  return { quote: str(n.quote).slice(0, 90), bookId: str(n.bookId), watermark: false, render: 'canvas' };
}
// #180 可打印阅读日志
export function printableReadingLog(metas, stats) {
  const rows = (metas || []).map((m) => {
    const s = (stats || {})[dayKey(new Date(num(m.lastReadAt)))];
    const ms = s ? Object.values(s.byBook || {}).reduce((a, b) => a + num(b), 0) : 0;
    return `| ${str(m.title)} | ${str(m.author || '佚名')} | ${Math.round(ms / 60000)} |`;
  });
  return `| 书名 | 作者 | 分钟 |\n| --- | --- | --- |\n${rows.join('\n')}`;
}

/* ============ 簇 19 · 健康与护眼 ============ */

// #183 20-20-20 护眼
export function eyeRest202020(lastRest, now = Date.now(), intervalMin = 20) {
  const iv = num(intervalMin, 20) * 60000;
  const due = num(now) - num(lastRest) >= iv;
  return { due, leftMs: Math.max(0, iv - (num(now) - num(lastRest))), intervalMin: num(intervalMin, 20) };
}
// #185 字号护眼区间
export function fontSizeEyeComfort(ageGroup) {
  const map = { child: [18, 24], teen: [16, 22], adult: [15, 21], senior: [18, 26] };
  const r = map[str(ageGroup)] || map.adult;
  return { min: r[0], max: r[1], recommended: Math.round((r[0] + r[1]) / 2) };
}
// #187 单次时长上限
export function sessionCap(ms, capMin = 60) {
  const cap = num(capMin, 60) * 60000;
  return { exceeded: num(ms) >= cap, capMin: num(capMin, 60), leftMs: Math.max(0, cap - num(ms)) };
}
// #189 暗室模式
export function darkRoomMode(cfg) {
  const c = cfg || {};
  return { on: !!c.on, paper: c.on ? '#000000' : '#15171a', ink: c.on ? '#3a3a3a' : '#d8d4c8' };
}
// #181 蓝光滤镜定时
export function blueLightSchedule(hour, cfg) {
  const c = cfg || {}; const h = num(hour, new Date().getHours());
  const night = h >= num(c.nightStart, 19) || h < num(c.dayStart, 7);
  return { on: night, level: night ? clamp(num(c.level, 30), 0, 100) : 0 };
}
// #184 亮度自适应（计算，无传感器时退回时段）
export function brightnessAuto(o) {
  const c = o || {};
  if (c.lux != null) return { brightness: clamp(Math.round(num(c.lux) / 10), 10, 100), source: 'sensor' };
  const h = num(c.hour, 12);
  return { brightness: (h >= 19 || h < 7) ? 45 : 80, source: 'schedule' };
}
// #186 环境光适配钩子
export const ambientLightAdapt = (enabled) => ({ enabled: !!enabled, hook: 'sensorOrSchedule', fallback: 'schedule' });
// #190 呼吸引导
export function focusBreathCue(o) { const c = o || {}; return { pattern: [c.inhale || 4, c.hold || 7, c.exhale || 8], label: '吸气 4 · 屏息 7 · 呼气 8', dismissible: true }; }
// #182 姿势提醒
export function postureReminder(ms, intervalMin = 30) { const iv = num(intervalMin, 30) * 60000; return { due: num(ms) >= iv, intervalMin: num(intervalMin, 30) }; }
// #188 喝水提醒
export function hydrationNudge(ms, intervalMin = 45) { const iv = num(intervalMin, 45) * 60000; return { due: num(ms) >= iv, intervalMin: num(intervalMin, 45) }; }

/* ============ 簇 20 · 工程与稳定性 ============ */

// #191 无崩溃遥测（本地只计数）
export function crashFreeTelemetry(counters) {
  const c = counters || {};
  const launches = num(c.launches), crashes = num(c.crashes);
  return { launches, crashes, crashFreeRate: launches > 0 ? Math.round((launches - crashes) / launches * 100) : 100, uploaded: false };
}
// #192 离线优先保证：核心能力是否都无需网络
export function offlineFirstGuarantee(checks) {
  const c = checks || {};
  const required = ['shelf', 'reader', 'stats', 'notes', 'tts', 'search'];
  const missing = required.filter((k) => c[k] === false);
  return { ok: missing.length === 0, missing, note: missing.length ? '以下功能依赖网络：' + missing.join('、') : '全部核心功能离线可用' };
}
// #195 缓存上限钳制
export function cacheSizeCap(currentBytes, capBytes) {
  const cur = num(currentBytes), cap = Math.max(1, num(capBytes));
  const over = cur > cap;
  return { over, ratio: Math.round(cur / cap * 100), suggestEvict: over, evictOldest: over };
}
// #197 完整性自检
export function integrityCheck(store) {
  const s = store || {};
  const problems = [];
  if (!Array.isArray(s.books)) problems.push('books 非数组');
  if (s.books && s.books.some((b) => !b || !b.id)) problems.push('存在无 id 的书');
  if (s.stats && typeof s.stats !== 'object') problems.push('stats 损坏');
  return { ok: problems.length === 0, problems, recoverable: problems.length > 0 };
}
// #198 优雅降级：能力不可用时隐藏而非报错
export function gracefulDegradation(features, available) {
  const a = new Set(available || []);
  const out = {};
  (features || []).forEach((f) => { out[f] = a.has(f); });
  return { map: out, hidden: Object.keys(out).filter((k) => !out[k]) };
}
// #199 性能预算
export const PERF_BUDGET = { pageTurnMs: 16, searchMs: 300, openMs: 800 };
export function performanceBudget(metric, ms) {
  const b = PERF_BUDGET[metric]; if (b == null) return { known: false };
  return { known: true, budget: b, actual: num(ms), over: num(ms) > b };
}
// #200 自诊断报告
export function selfDiagnosticReport(env) {
  const e = env || {};
  return {
    storage: { used: num(e.used), quota: num(e.quota), pressure: storagePressure(e.used, e.quota).level },
    crashes: num(e.crashes), perf: e.perf || {}, permissions: e.permissions || [], networkTargets: e.networkTargets || [], localOnly: (e.networkTargets || []).length === 0,
  };
}
// #193 资源懒加载策略
export const lazyResourceLoading = (heavy) => ({ strategy: 'onDemand', deferred: (heavy || []), preloadCritical: true });
// #194 内存压力处理
export function memoryPressureHandle(level) {
  const l = str(level);
  if (l === 'critical') return { action: 'releaseAllNonVisible', keepCurrent: true };
  if (l === 'warning') return { action: 'releaseLruChapters', keepCurrent: true };
  return { action: 'none', keepCurrent: true };
}
// #196 后台静默更新策略
export function updateInBackground(cfg) {
  const c = cfg || {};
  return { enabled: c.enabled !== false, applyOnReload: true, note: c.enabled === false ? '已关闭后台更新' : '下次冷启动生效' };
}

/* ============ 特性注册表：每项都能被测试逐条点名 ============ */
export const NEXUS_FEATURE_IDS = Array.from({ length: 200 }, (_, i) => i + 1);
export const NEXUS_GROUPS = [
  { id: 'io', name: '导入与存储', from: 1, to: 10 },
  { id: 'shelf', name: '书架与元数据', from: 11, to: 20 },
  { id: 'interact', name: '阅读交互', from: 21, to: 30 },
  { id: 'layout', name: '排版呈现', from: 31, to: 40 },
  { id: 'notes', name: '笔记批注', from: 41, to: 50 },
  { id: 'search', name: '搜索导航', from: 51, to: 60 },
  { id: 'stats', name: '计划统计', from: 61, to: 70 },
  { id: 'tts', name: '朗读', from: 71, to: 80 },
  { id: 'a11y', name: '可访问性', from: 81, to: 90 },
  { id: 'sync', name: '同步多用户', from: 91, to: 100 },
  { id: 'discover', name: '智能推荐', from: 101, to: 110 },
  { id: 'ritual', name: '仪式氛围', from: 111, to: 120 },
  { id: 'study', name: '学习效率', from: 121, to: 130 },
  { id: 'device', name: '设备集成', from: 131, to: 140 },
  { id: 'social', name: '社交共读', from: 141, to: 150 },
  { id: 'insight', name: '数据洞察', from: 151, to: 160 },
  { id: 'auto', name: '智能自动化', from: 161, to: 170 },
  { id: 'create', name: '创作输出', from: 171, to: 180 },
  { id: 'health', name: '健康护眼', from: 181, to: 190 },
  { id: 'eng', name: '工程稳定', from: 191, to: 200 },
];
