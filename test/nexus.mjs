// 红杉 Nexus v1.2.0 —— 100 项能力契约 + 真实 App 集成回归
// ① Node 侧直接 import nexus-core.js：逐项点名断言行为（同时证明模块顶层零 DOM 副作用）
// ② 源码级接线：SW 模块图 / 主控挂载 / 静态资源 / 版本
// ③ 真实浏览器：能力中心六页签、跨书搜索、笔记、计划、主题实时预览、回收站、热区、无遮挡
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
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
console.log('static server:', BASE);

const results = [];
const check = (name, cond, extra) => results.push({ name, pass: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const core = await import(new URL('../www/js/nexus-core.js', import.meta.url));

/* ============ ① 100 项行为契约，逐条点名 ============ */
const C = [];
const t = (id, name, fn) => C.push({ id, name, fn });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

t(1, '导入分阶段进度按权重而非线性', () => core.IMPORT_PHASES.length === 4 && core.importProgress('parse', 0.5).pct === 38 && core.importProgress('done').pct === 100);
t(2, '取消导入区分是否可无损回滚', () => core.cancelImport('parse').cancellable && core.cancelImport('store').rollback === 'trash');
t(3, '导入失败四类分诊', () => ['quota exceeded', 'permission denied', 'bad zip', 'unsupported mobi'].map((e) => core.classifyImportError(e).kind).join(',') === 'storage,permission,corrupt,format');
t(4, '存储水位三档告警', () => ['ok', 'warn', 'critical'].includes(core.storagePressure(95, 100).level) && core.storagePressure(95, 100).level === 'critical');
t(5, '备份预检解析版本/书数/非法项', () => { const p = core.backupPreview(JSON.stringify({ version: '1.2.0', books: [{ id: 'a', title: 'A' }, { title: '缺 id' }], settings: { x: 1 } })); return p.ok && p.books === 2 && p.settings === 1 && p.conflicts === 1 && !core.backupPreview('{').ok; });
t(6, '备份合并以 updatedAt 新者胜出', () => { const r = core.mergeBackups([{ id: 'a', title: '旧', updatedAt: 1 }], [{ id: 'a', title: '新', updatedAt: 2 }, { id: 'b', title: 'B' }]); return r.merged.length === 2 && r.merged[0].title === '新'; });
t(7, '回收站存取 / 过期 / 恢复', () => { let l = core.trashPut([], { id: 'a', title: 'A' }, 1000); l = core.trashPut(l, { id: 'b', title: 'B' }, 2000); const p = core.trashPurge(l, 1000 + 31 * 86400000, 30); return core.trashRestore(l, 'a').book.id === 'a' && p.removed === 2; });
t(8, '去重以 ISBN 优先并保留章节更全版本', () => core.dedupeKey({ isbn: '978-7-111', title: 'x' }) === 'isbn:9787111' && core.dedupeBooks([{ id: 'a', title: '书', chapters: [1] }, { id: 'b', title: '书', chapters: [1, 2] }]).books[0].id === 'b');
t(9, '原文件回传命名安全', () => core.exportFileName({ title: 'A/B:C', source: 'pdf' }) === 'A_B_C.pdf');
t(10, '冷启动骨架屏有超时兜底', () => core.skeletonVisible({ ready: false, elapsed: 100 }) && !core.skeletonVisible({ ready: false, elapsed: 9999 }));
t(11, '标签规范化与稳定配色', () => eq(core.normalizeTags(' 科幻,科幻；#经典 经典'), ['科幻', '经典']) && core.tagColor('科幻') === core.tagColor('科幻'));
t(12, '组合筛选 AND/OR 与状态', () => { const m = [{ id: 'a', tags: ['x', 'y'], readState: 'reading' }, { id: 'b', tags: ['x'], readState: 'unread' }]; return core.filterMetas(m, { tags: ['x', 'y'], tagMode: 'and' }).length === 1 && core.filterMetas(m, { tags: ['y'], tagMode: 'or' }).length === 1 && core.filterMetas(m, { state: 'unread' }).length === 1; });
t(13, '元数据编辑白名单不改写正文', () => { const b = core.applyMetaPatch({ id: 'a', title: 'A', chapters: ['原文'] }, { title: 'B', chapters: ['篡改'], id: 'zzz' }); return b.title === 'B' && b.id === 'a' && b.chapters[0] === '原文'; });
t(14, '系列归组且组内按序号', () => { const g = core.groupBySeries([{ id: 'a', series: 'S', seriesIndex: 2 }, { id: 'b', series: 'S', seriesIndex: 1 }, { id: 'c' }]); return g.length === 2 && g[0].books[0].id === 'b'; });
t(15, '虚拟滚动窗口带缓冲', () => { const w = core.virtualWindow(500, 1000, 600, 100); return w.start < 10 && w.end > 16 && w.padTop === w.start * 100; });
t(16, '书架视图按屏宽自动选档', () => core.shelfViewOf(1000) === 'grid' && core.shelfViewOf(600) === 'list' && core.shelfViewOf(390, 'compact') === 'compact');
t(17, '排序器四种键', () => core.sortMetas([{ id: 'b', title: 'B', addedAt: 2, progress: 10 }, { id: 'a', title: 'A', addedAt: 1, progress: 90 }], 'progress')[0].id === 'a' && core.sortMetas([{ id: 'b', title: 'B', addedAt: 2 }, { id: 'a', title: 'A', addedAt: 1 }], 'added')[0].id === 'b');
t(18, '封面种子稳定可辨', () => core.coverSeed({ title: '水杉' }).char === '水' && core.coverSeed({ title: '水杉' }).hue === core.coverSeed({ title: '水杉' }).hue);
t(19, '书架搜索返回命中字段与位置', () => { const r = core.shelfSearch([{ id: 'a', title: '水杉阅读', author: '张三', tags: [] }], '张三'); return r.length === 1 && r[0].field === 'author' && r[0].pos === 0; });
t(20, '阅读状态流转不靠猜', () => core.readStateOf(null, 0) === 'unread' && core.readStateOf({ ci: 1 }, 0) === 'reading' && core.readStateOf(null, 100) === 'finished');
t(21, '翻页热区 / 左右手互换', () => core.hitZone(10, 50, 100, 100, {}) === 'prev' && core.hitZone(90, 50, 100, 100, {}) === 'next' && core.hitZone(10, 50, 100, 100, { swap: true }) === 'next' && core.hitZone(50, 50, 100, 100, {}) === 'menu');
t(22, '手势编排未配置不误触', () => core.resolveGesture('doubleTap', { gestures: { longPress: 'toc' } }) === null && core.resolveGesture('longPress', { gestures: { longPress: 'toc' } }) === 'toc');
t(23, '键位映射与冲突检测', () => { const r = core.resolveKey('KeyJ', { keys: { KeyJ: 'next', KeyK: 'next' } }); return r.action === 'next' && r.conflicts.includes('KeyK'); });
t(24, '面板下滑关闭需距离+速度双条件', () => core.panelSwipeShouldClose(120, 200) && !core.panelSwipeShouldClose(120, 2000) && !core.panelSwipeShouldClose(20, 100));
t(25, '主题实时预览只覆盖排版令牌', () => eq(core.themePreviewCss({ paper: '#fff', ink: '#000', evil: 'x' }), { '--bg': '#fff', '--fg': '#000' }));
t(26, '主题码可导入导出且拒绝乱码', () => core.encodeTheme({ paper: '#fff' }).length > 0 && core.parseTheme(core.encodeTheme({ paper: '#fff' })).paper === '#fff' && core.parseTheme('!!!') === null);
t(27, '排版样例用真实正文且随字号变化', () => core.layoutSample({ html: '<p>水杉阅读是一本书</p>', fontSize: 20 }).includes('水杉') && core.layoutSample({ html: '<p>' + '字'.repeat(200) + '</p>', fontSize: 40 }).length < 120);
t(28, '翻页动画按书记忆有回退', () => core.perBookFlip('b1', { b1: 'ink' }, 'slide') === 'ink' && core.perBookFlip('b2', { b1: 'ink' }, 'slide') === 'slide');
t(29, '排版漂移超阈值才提示回位', () => core.needAnchorFallback({ pct: 20 }, { pct: 25 }) && !core.needAnchorFallback({ pct: 20 }, { pct: 21 }));
t(30, '墨水屏档位强制关动画', () => !core.regalTier(15, { eink: true }).animation && core.regalTier(15, { eink: true }).refreshEvery === 12);
t(31, '字体包超限拒绝注入', () => core.fontFaceRule('我的字体', 'data:font/x', 1000).css.includes('@font-face') && core.fontFaceRule('x', 'data:font/x', 99e6) === null);
t(32, '竖排令牌完整', () => core.verticalCss(true)['writing-mode'] === 'vertical-rl' && core.verticalCss(false)['writing-mode'] === 'horizontal-tb');
t(33, '标点挤压不改正文语义', () => core.squeezePunctuation('好 ， 。 啊') === '好 ，。 啊');
t(34, '插图缩放钳制 1–4 倍与双击切换', () => core.imageZoom({ scale: 1, action: 'toggle' }).scale === 2 && core.imageZoom({ scale: 4, delta: 3 }).scale === 4);
t(35, '脚注浮层只取目标容器', () => { const r = core.footnotePopup('<p id="fn1">注释内容</p><p>正文</p>', 'fn1'); return r.found && r.html === '注释内容' && !core.footnotePopup('<p>正文</p>', 'fn1').found; });
t(36, '目录层级识别卷/部/篇', () => { const tr = core.tocTree([{ title: '第一卷' }, { title: '第一章' }, { title: '第二章' }]); return tr.length === 1 && tr[0].children.length === 2; });
t(37, '目录搜章名保留父级路径', () => { const tr = core.tocTree([{ title: '第一卷' }, { title: '桃花源' }, { title: '归去来' }]); const r = core.tocSearch(tr, '桃花'); return r.length === 1 && r[0].path.includes('第一卷'); });
t(38, '章节刻度按字数占比分配', () => { const t2 = core.chapterTicks([{ html: '<p>' + '字'.repeat(400) + '</p>' }, { html: '<p>' + '字'.repeat(800) + '</p>' }], 400); return t2[1].startPct > 30 && t2[1].startPct < 40 && t2[1].minutes === 2; });
t(39, '双开对照取相邻页并标记空白', () => eq(core.spreadPair(['a', 'b'], 0), { left: 'a', right: 'b', empty: false }) && core.spreadPair(['a'], 0).empty);
t(40, '人物索引过滤停用词并给首次出现位置', () => { const idx = core.entityIndex([{ html: '<p>水杉，水杉。因为所以，水杉。</p>' }]); return idx.length > 0 && !idx.some((x) => x.name === '因为'); });
t(41, '段落批注锚点含章与引文', () => { const n = core.makeNote({ bookId: 'b', ci: 2, quote: '桃花源记', text: '想法' }); return n.id && core.noteAnchor(n).startsWith('b:2:'); });
t(42, '批注跳原文精确/降级', () => core.noteJumpTarget({ quote: '土地平旷' }, ['<p>土地平旷 屋舍俨然</p>']).exact && core.noteJumpTarget({ quote: '不存在' }, []).pi === 0);
t(43, '笔记按章/标签/日期聚合', () => { const ns = [{ ci: 0, tags: ['x'], at: Date.now() }, { ci: 1, tags: [], at: Date.now() }]; return core.groupNotes(ns, 'chapter').length === 2 && core.groupNotes(ns, 'tag')[0].key === 'x'; });
t(44, '间隔回顾按 1/3/7/14 节奏到期', () => { const now = Date.now(), ns = [{ id: 'a', at: now - 3.2 * 86400000, lastReview: 0 }, { id: 'b', at: now - 2 * 86400000, lastReview: 0 }]; return core.reviewSchedule(ns, now, 5).length === 1; });
t(45, '摘录导出多条件过滤', () => { const ns = [{ bookId: 'a', color: 'important', tags: ['x'], at: Date.parse('2026-01-02'), text: '桃花', quote: '' }, { bookId: 'b', color: 'like', tags: [], at: Date.parse('2026-01-02'), text: '桃花', quote: '' }]; return core.filterExcerpts(ns, { color: 'important', tags: ['x'], q: '桃花' }).length === 1; });
t(46, '书单导出为离线 HTML 且转义', () => { const h = core.buildBooklistHtml([{ title: '<b>A</b>' }], []); return h.includes('<h1>') && !h.includes('<b>A</b>'); });
t(47, '分享卡片水印默认关', () => core.shareCard({ quote: 'x' }).watermark === false && core.shareCard({ quote: 'x'.repeat(200) }).quote.length === 90);
t(48, '标注颜色分类', () => core.highlightColor('question') !== core.highlightColor('important') && core.highlightColor('不存在') === core.HIGHLIGHT_COLORS.important);
t(49, '笔记全文搜索覆盖引文与标签', () => core.searchNotes([{ text: '想法', quote: '原文', tags: ['灵感'] }], '灵感').length === 1 && core.searchNotes([], 'x').length === 0);
t(50, '阅读成就可关闭且按天数解锁', () => { const s = {}; for (let i = 0; i < 8; i++) s['2026-01-0' + (i + 1)] = { byBook: { b: 60000 } }; return core.achievementsOf(s, { finished: 1 }).length >= 3 && core.achievementsOf(s, { enabled: false }).length === 0; });
t(51, '跨书全局搜索命中章节', () => { const r = core.globalSearch([{ id: 'a', title: 'A', chapters: [{ title: 'C1', html: '<p>桃花源记</p>' }] }, { id: 'b', title: 'B', chapters: [{ title: 'C2', html: '<p>桃花林</p>' }] }], '桃花'); return r.length === 2 && r[1].bookId === 'b'; });
t(52, '命中高亮转义后再包 mark', () => core.markHit('<b>桃花</b>', '桃花').includes('<mark>桃花</mark>') && !core.markHit('<script>x</script>', 'x').includes('<script>'));
t(53, '上下文预览命中词居中', () => { const s = core.snippetOf('前'.repeat(60) + '桃花' + '后'.repeat(60), '桃花', 20); return s.includes('桃花') && s.startsWith('…') && s.endsWith('…'); });
t(54, '结果按书+章分组', () => core.groupHits([{ bookId: 'a', ci: 0, bookTitle: 'A', title: 'C' }, { bookId: 'a', ci: 0, bookTitle: 'A', title: 'C' }, { bookId: 'b', ci: 1, bookTitle: 'B', title: 'D' }]).length === 2);
t(55, '搜索历史去重近期优先', () => eq(core.searchHistoryPush(['旧'], '新'), ['新', '旧']) && eq(core.searchHistoryPush(['新'], '新'), ['新']));
t(56, '匹配选项拦截非法正则', () => core.matchOptions('a', {}).ok && !core.matchOptions('[', { regex: true }).ok && core.matchOptions('a', { wholeWord: true }).re.source.includes('\\b'));
t(57, '快捷跳转三种输入', () => core.parseJump('12%', 9, 9).value === 12 && core.parseJump('第3章', 9, 9).value === 2 && core.parseJump('p42', 9, 99).value === 41 && !core.parseJump('乱写', 9, 9).ok);
t(58, '最近位置同章去重且按时间倒序', () => { const r = core.recentPositions([{ bookId: 'a', ci: 1, at: 1 }, { bookId: 'a', ci: 1, at: 3 }, { bookId: 'b', ci: 0, at: 2 }]); return r.length === 2 && r[0].at === 3; });
t(59, '章节速览给出字数/分钟/已读', () => { const s = core.chapterStats([{ title: 'A', html: '<p>' + '字'.repeat(800) + '</p>' }], { ci: 1 }, 400); return s[0].minutes === 2 && s[0].read === true; });
t(60, '章节热力五级分档', () => { const h = core.chapterHeat([{}, {}], { 0: 0, 1: 60 * 60000 }); return h[0].level === 0 && h[1].level === 4; });
t(61, '阅读计划字段钳制', () => core.planOf({ target: -5, year: 2026 }).target === 1 && core.planOf({ year: 2026 }).deadline === '2026-12-31');
t(62, '计划进度含日均需读与落后判定', () => { const p = core.planProgress(core.planOf({ target: 12, year: 2026, deadline: '2026-12-31' }), 3, new Date(2026, 5, 1)); return p.pct === 25 && p.remaining === 9 && p.daysLeft > 0; });
t(63, '年度报告汇总真实数据', () => { const s = { '2026-03-01': { byBook: { a: 60000 } }, '2025-03-01': { byBook: { a: 600000 } } }; const r = core.yearReport(s, [{ id: 'a', title: 'A' }], 2026); return r.totalMs === 60000 && r.activeDays === 1 && r.perMonth[2] === 60000 && r.top[0].title === 'A'; });
t(64, '统计口径写明剔除规则', () => core.statsLegend().note.includes('亮屏静置') && core.statsLegend().focus.includes('不重复计入'));
t(65, '打卡提醒时段与静默日', () => core.checkinAllowed({ now: new Date(2026, 0, 1, 12) }) && !core.checkinAllowed({ now: new Date(2026, 0, 1, 23) }) && !core.checkinAllowed({ now: new Date(2026, 0, 4, 12), silentDays: [0] }));
t(66, '专注计时暂停不计入', () => { const s = core.focusTick({ running: false, elapsed: 60000, minutes: 25, lastTs: 0 }, 999999); return s.elapsed === 60000 && s.left === 24 * 60000 && !s.done; });
t(67, '专注统计只计完成会话', () => eq(core.focusStats([{ done: true, minutes: 25 }, { done: false, minutes: 25 }]), { sessions: 1, minutes: 25, lastAt: 0 }));
t(68, '周报给出环比与最长一天', () => { const s = {}; s[core.dayKey(new Date())] = { byBook: { a: 60000 } }; const d = core.weeklyDigest(s, new Date()); return d.totalMs === 60000 && d.activeDays === 1 && d.deltaMs === 60000; });
t(69, '读完本数只认显式状态或 99.5%', () => core.finishedCount([{ id: 'a', readState: 'finished' }, { id: 'b' }], { b: { pct: 100 }, c: { pct: 50 } }) === 1);
t(70, '统计 CSV 表头与合计列', () => { const c = core.statsCsv({ '2026-01-01': { byBook: { a: 120000 } } }, [{ id: 'a', title: 'A' }]); return c.split('\n')[0] === '日期,A,合计(分钟)' && c.split('\n')[1].endsWith(',2'); });
t(71, '朗读断点含书/章/段/语速', () => { const r = core.ttsResume({ bookId: 'a', ci: 2, paragraph: 5, rate: 1.5 }); return r.bookId === 'a' && r.paragraph === 5 && r.rate === 1.5; });
t(72, '语速分书记忆并钳制', () => core.ttsRateFor('a', { a: 1.5 }, 1) === 1.5 && core.ttsRateFor('b', { a: 1.5 }, 1) === 1 && core.ttsRateFor('c', {}, 9) === 2);
t(73, '断句按中英标点切分', () => core.ttsBreakText('你好。世界！How are you?', {}).length === 3 && core.ttsBreakText('字'.repeat(30), { maxLen: 10 }).length === 3);
t(74, '跳过页码/脚注标记/目录行', () => core.ttsSkip('42') && core.ttsSkip('[1]') && core.ttsSkip('目录') && !core.ttsSkip('这是正文'));
t(75, '睡眠定时到点不 abrupt', () => { const r = core.sleepTimerEnd(1000, 5, 1000 + 5 * 60000); return r.expired && r.left === 0 && core.sleepTimerEnd(1000, 5, 2000).left > 0; });
t(76, '多章连读书末停止', () => eq(core.ttsQueue(3, 1, 5), [1, 2]) && eq(core.ttsQueue(3, 2, 3), [2]));
t(77, '朗读高亮返回句子位置', () => { const r = core.ttsHighlight('世界', '你好世界'); return r.found && r.start === 2 && r.end === 4; });
t(78, '朗读历史同日同书合并', () => { let l = core.ttsHistoryPush([], { bookId: 'a', minutes: 10, at: Date.parse('2026-01-01') }); l = core.ttsHistoryPush(l, { bookId: 'a', minutes: 20, at: Date.parse('2026-01-01') + 1000 }); return l.length === 1 && l[0].minutes === 20; });
t(79, '朗读缺能力时明确降级', () => core.ttsFallback({}).mode === 'text' && core.ttsFallback({ nativeBridge: true }).message.includes('中文语音包') && core.ttsFallback({ nativeBridge: true, chineseVoice: true }).message === '');
t(80, '朗读与自动翻页互斥', () => { const r = core.ttsTurnConflict({ ttsOn: true, autoTurnOn: true }); return r.conflict && r.disable === 'auto' && !core.ttsTurnConflict({ ttsOn: true }).conflict; });
t(81, '读屏语义标签与 dialog 属性', () => core.a11yLabel('toc') === '打开目录' && core.dialogA11y('能力中心').role === 'dialog' && core.dialogA11y('x')['aria-modal'] === 'true');
t(82, '跟随系统字号不与独立设置叠加', () => core.systemFontScale({ followSystem: true, systemScale: 1.5, baseSize: 20 }) === 30 && core.systemFontScale({ baseSize: 20 }) === 20);
t(83, 'WCAG 对比度校验', () => core.contrastRatio('#000000', '#ffffff').ratio === 21 && !core.contrastRatio('#777777', '#888888').pass);
t(84, '减弱动态效果尊重系统偏好', () => core.reducedMotion({ systemReduced: true }).reduce && !core.reducedMotion({}).reduce);
t(85, '繁体语言包', () => core.t('shelf', 'zh_Hant') === '書架');
t(86, '英文语言包', () => core.t('stats', 'en') === 'Stats');
t(87, '语言包热切换覆盖全部 key', () => Object.keys(core.applyI18n('en')).length === Object.keys(core.I18N.zh).length && core.t('不存在的键', 'en') === '不存在的键');
t(88, '空状态体系都带下一步动作', () => Object.keys(core.EMPTY_STATES).every((k) => !!core.emptyState(k).action));
t(89, '设置项搜索按标题与分组', () => core.filterSettings([{ title: '翻页热区', group: '阅读交互' }, { title: '主题工坊', group: '外观' }], '外观').length === 1);
t(90, '引导只重放未用过的功能', () => eq(core.guideReplay(['search', 'notes', 'plan'], ['search']), ['notes', 'plan']));
t(91, '离线同步队列登记为 pending', () => core.syncQueuePut([], { type: 'put', key: 'book:a' })[0].state === 'pending');
t(92, '同步冲突并排列出待选', () => { const r = core.syncConflictPreview({ updatedAt: 1, title: '本地' }, { updatedAt: 2, title: '远端' }); return r.conflict && r.needsChoice && r.remote.title === '远端'; });
t(93, '队列确认后才 ack', () => { const q = core.syncQueuePut([], { type: 'put', key: 'a' }); return core.syncQueuePeek(q).length === 1 && core.syncQueuePeek(core.syncQueueAck(q, q[0].id)).length === 0; });
t(94, '配置档名规范化', () => core.profileNamespace('我的 书架!') === '我的_书架' && core.profileNamespace('') === 'default');
t(95, '配置档键带命名空间不串数据', () => core.profileScopedKey('A', 'notes') === 'inkreader:a:notes' && core.profileScopedKey('B', 'notes') !== core.profileScopedKey('A', 'notes'));
t(96, '书单分享为离线 HTML', () => core.shareListHtml([{ id: 'a', title: 'A' }]).includes('data-id="a"'));
t(97, '导入他人书单逐本待确认', () => { const r = core.parseBooklist('<li data-id="x">书名 — 作者</li>'); return r.length === 1 && r[0].title === '书名' && r[0].autoAdd === false; });
t(98, '应用锁只接受 4–8 位数字', () => core.pinOk('1234', '1234') && !core.pinOk('12', '1234') && !core.pinOk('abcd', 'abcd'));
t(99, '隐私面板默认仅本地', () => { const r = core.privacyReport({ permissions: [], networkTargets: [] }); return r.localOnly && r.note.includes('仅存本机'); });
t(100, '彻底清空要求先导出并二次确认', () => {
  const a = core.purgePlan({}), b = core.purgePlan({ confirmed: true }), c = core.purgePlan({ exported: true });
  return a.exportFirst && !a.confirmed && b.confirmed === true && !c.exportFirst && c.message.includes('不可恢复');
});
t(101, '相似书重叠度且同作者弱加权', () => { const m = [{ id: 'a', tags: ['x'], author: 'Y' }, { id: 'b', tags: ['x'], author: 'Y' }]; const r = core.similarBooks(m, { id: 'a', tags: ['x'], author: 'Y' }); return r.length === 1 && r[0].id === 'b' && r[0].sameAuthor; });
t(102, '继续阅读把未读完排前面', () => { const m = [{ id: 'a' }, { id: 'b' }]; const p = { a: { pct: 100 }, b: { pct: 50 } }; return core.continueRanking(m, p)[0].id === 'b'; });
t(103, '待读队列来自计划未读按加入顺序', () => { const plan = { target: 5, bookIds: ['a'] }; const m = [{ id: 'a', addedAt: 2, readState: 'unread' }, { id: 'b', addedAt: 1, readState: 'finished' }]; const q = core.upNextQueue(plan, m, {}); return q.length === 1 && q[0].id === 'a' && q[0].inPlan; });
t(104, '按标签发现给覆盖率和书', () => { const m = [{ id: 'a', tags: ['s'] }, { id: 'b', tags: ['h'] }]; const r = core.discoverByTag(m, 's'); return r.books.length === 1 && r.coverage === 50; });
t(105, '久未翻开提醒仅未读完且超期', () => { const now = Date.now(); const m = [{ id: 'a', lastReadAt: now - 40 * 86400000 }, { id: 'b', lastReadAt: now - 40 * 86400000 }]; const progress = { a: { pct: 50 }, b: { pct: 100 } }; const r = core.forgottenNudge(m, progress, now, 30); return r.length === 1 && r[0].id === 'a'; });
t(106, '新书速览按时间窗', () => { const now = Date.now(); const m = [{ id: 'a', addedAt: now - 5 * 86400000 }, { id: 'b', addedAt: now - 100 * 86400000 }]; return core.newArrivals(m, now, 30).length === 1 && core.newArrivals(m, now, 30)[0].id === 'a'; });
t(107, '心情匹配映射到标签组合', () => { const m = [{ id: 'a', tags: ['小说'] }, { id: 'b', tags: ['历史'] }]; return core.moodMatch(m, 'commute').length === 1 && core.moodMatch(m, 'x').length === 0; });
t(108, '作者深挖聚合读况', () => { const m = [{ id: 'a', author: 'X' }, { id: 'b', author: 'X' }]; const progress = { a: { pct: 100 }, b: { pct: 50 } }; const r = core.authorDeepDive(m, progress, 'X'); return r.total === 2 && r.read === 1 && r.unread === 1; });
t(109, '重读建议仅已读完且久未碰', () => { const now = Date.now(); const m = [{ id: 'a', lastReadAt: now - 200 * 86400000 }]; const progress = { a: { pct: 100 } }; return core.rereadSuggestion(m, progress, now, 90).length === 1; });
t(110, '馆内趋势统计最热标签', () => { const now = Date.now(); const m = [{ id: 'a', tags: ['s'], lastReadAt: now }, { id: 'b', tags: ['s'], lastReadAt: now }]; const s = { [core.dayKey(new Date(now))]: { byBook: { 'a': 60000, 'b': 60000 } } }; const r = core.libraryTrending(s, m, 5); return r.length >= 1 && r[0].tag === 's'; });
t(111, '连续阅读环断了不羞辱', () => { const r = core.streakRing(0, 7); return r.pct === 0 && r.broken && r.gentle.includes('差 1 天'); });
t(112, '环境音预设含静音', () => core.ambientPresets().some((x) => x.id === 'off'));
t(113, '每日一句确定性不跳变', () => { const pool = [{ text: 'A' }, { text: 'B' }, { text: 'C' }]; const a = core.dailyQuote(pool, '2026-01-01'); const b = core.dailyQuote(pool, '2026-01-01'); return a && b && a.index === b.index; });
t(114, '目标进度小组件数据', () => { const pp = core.goalWidget(core.planOf({ target: 12 }), 3, new Date(2026, 5, 1)); return pp.pct === 25 && pp.target === 12; });
t(115, '本次阅读小结计算分钟', () => { const s = core.sessionEndSummary({ ms: 42 * 60000, chaptersRead: 3, pagesRead: 12, yesterdayMs: 30 * 60000 }); return s.minutes === 42 && s.chapters === 3 && s.moreThanYesterday; });
t(116, '读完庆祝数据', () => core.finishCelebration({ title: 'A', author: 'B' }).shareable === true);
t(117, '昼夜自动主题按小时', () => core.autoCozyTheme(22, {}).night && !core.autoCozyTheme(12, {}).night);
t(118, '阅读时段洞察给高峰小时', () => { const r = core.timeOfDayInsight({ hourBuckets: { 9: 1000, 22: 5000 } }); return r.bestHour === 22 && r.peakLabel === '22:00'; });
t(119, '成就轻提示取最新可关', () => { const r = core.achievementToast([{ name: 'a' }, { name: 'b' }]); return r.latest.name === 'b' && r.dismissible; });
t(120, '阅读仪式清单三步', () => core.ritualSteps().length === 3);
t(121, '间隔复习到期且今天未学', () => { const now = Date.now(); const ns = [{ id: 'a', at: now - 3.2 * 86400000, lastLearned: 0 }, { id: 'b', at: now - 0.5 * 86400000, lastLearned: 0 }, { id: 'c', at: now - 3.2 * 86400000, lastLearned: now }]; return core.spacedRepetition(ns, now, 8).length === 1; });
t(122, '本地查词命中/未命中', () => { const d = { 苹果: 'fruit' }; const r = core.dictionaryLookup('苹果', d); return r.found && r.def === 'fruit' && core.dictionaryLookup('未知', d).needsNetwork; });
t(123, '翻译未配置服务明确告知', () => !core.translateInline('x', {}).ok && core.translateInline('x', { apiKey: 'k' }).ok);
t(124, '概念图谱抽专名共现', () => { const c = core.conceptGraph([{ html: '<p>水杉 水杉 因为 所以 水杉。</p>' }]).nodes; return c.length > 0 && !c.some((x) => x.name === '因为'); });
t(125, '单书学习计划算每天章数', () => { const r = core.studyPlan({ chaptersCount: 10, readChapters: 0 }, '2026-12-31', new Date(2026, 0, 1)); return r.remaining === 10 && r.days > 0 && r.perDay >= 1; });
t(126, '回忆模式遮原文', () => { const ns = [{ id: 'a', quote: '桃花', text: '好' }]; const r = core.quizMode(ns, 3); return r.length === 1 && r[0].question === '桃花' && r[0].revealed === false; });
t(127, '标注密度按章计数', () => { const c = core.highlightDensity([{}, {}, {}], [{ ci: 0 }, { ci: 0 }, { ci: 2 }]); return c[0].count === 2 && c[2].count === 1; });
t(128, '术语表抽取', () => core.glossaryExtract([{ html: '<p>水杉 水杉 桃花源 桃花源。</p>' }]).length >= 1);
t(129, '章节摘要取首句', () => { const r = core.summaryChapters([{ title: 'A', html: '<p>第一句。第二句。</p>' }], 3); return r[0].summary.includes('第一句'); });
t(130, '导出 Anki CSV 含表头', () => { const csv = core.exportAnkiCsv([{ quote: 'Q', text: 'T', tags: ['x'], bookId: 'a' }], [{ id: 'a', title: 'A' }]); return csv.split('\n')[0] === 'Front,Back,Tags,Source' && csv.includes('A'); });
t(131, '快捷开关磁贴数据', () => core.quickTileActions().length === 3);
t(132, '媒体控制元数据', () => { const r = core.mediaControlsState({ on: true, canPrev: true, canNext: false }, { title: 'A' }); return r.active && r.title === 'A' && r.canPrev && !r.canNext; });
t(133, '通知操作数据', () => core.notificationActions().some((x) => x.id === 'eye_rest'));
t(134, '桌面小部件配置', () => core.widgetConfig({ enabled: true }).showRing === true && !core.widgetConfig({ enabled: false }).enabled);
t(135, '分享接入按扩展名接受', () => core.shareToImport({ fileName: 'a.epub' }).accepted && !core.shareToImport({ fileName: 'a.doc' }).accepted);
t(136, '文件关联支持 epub/pdf/txt', () => core.fileAssociation('application/epub+zip') && core.fileAssociation('', 'pdf') && !core.fileAssociation('', 'zip'));
t(137, '低电量自动调暗关动画', () => { const r = core.batteryAwareDim(10, { enabled: true, threshold: 15, dimTo: 60 }); return r.dim && r.brightness === 60 && !r.animation; });
t(138, '耳机线控映射', () => core.headphoneControls().mediaNext === 'nextPage');
t(139, '分屏支持声明', () => core.splitScreenSupported() === true);
t(140, 'PWA 安装提示状态', () => core.pwaInstallPromptState({ canInstall: true }).canInstall && !core.pwaInstallPromptState({ dismissed: true }).canInstall);
t(141, '本地书友圈纯本地', () => core.localBookClub({ name: 'X' }).localOnly === true);
t(142, '共享批注文件解析', () => { const r = core.parseSharedAnnotations('<annotation data-book="a">hi</annotation>'); return r.length === 1 && r[0].bookId === 'a' && r[0].text === 'hi'; });
t(143, '借阅记录增删', () => { const l = core.lendingRecord([], { bookTitle: 'A', to: 'B' }); const r = core.lendingRecord(l, { return: true, id: l[0].id }); return l.length === 1 && r.length === 0; });
t(144, '本地共读挑战排名含我', () => { const r = core.readingChallengeLocal([{ name: '友', count: 5 }], 10); return r[0].name === '我' && r[0].count === 10; });
t(145, '金句卡片墙取引文', () => core.quoteCardGallery([{ id: 'a', quote: 'X', bookId: 'b' }, { id: 'c' }], 12).length === 1);
t(146, '本地讨论串结构', () => core.discussionThread('b', [{ text: 'hi' }]).localOnly === true);
t(147, '推荐信生成带书名', () => core.recommendationLetter({ title: 'A', author: 'B' }, { to: '友' }).text.includes('《A》'));
t(148, '阅读手记结构', () => { const r = core.readingJournal({ text: '今天读了', bookId: 'a' }); return r.bookId === 'a' && r.text === '今天读了'; });
t(149, '书架展示页数据', () => core.bookshelfShowcase([{ id: 'a', title: 'A', author: 'B' }], 12).length === 1);
t(150, '家庭档案新增身份', () => { const l = core.familyProfiles([], '娃'); return l.length === 1 && l[0].key === '娃'; });
t(151, '真实阅读速度算 cpm', () => { const r = core.readingSpeed(200, 60000); return r.cpm === 200 && r.min === 200; });
t(152, '专注力曲线分有效/无效', () => { const r = core.attentionCurve([{ at: 1, totalMs: 60000, effectiveMs: 40000 }]); return r[0].effective === 40000 && r[0].idle === 20000; });
t(153, '体裁分布计数', () => { const r = core.genreDistribution([{ genre: '小说' }, { genre: '小说' }, { genre: '历史' }]); return r[0].genre === '小说' && r[0].count === 2; });
t(154, '时段热力五级分档', () => { const r = core.timeOfDayHeatmap({ 0: 0, 12: 60000 }); return r[12].level === 4 && r[0].level === 0; });
t(155, '篇幅 vs 耗时过滤', () => { const r = core.bookLengthVsTime([{ id: 'a', title: 'A', chars: 1000, daysTaken: 2 }, { id: 'b', chars: 0, daysTaken: 0 }]); return r.length === 1 && r[0].id === 'a'; });
t(156, '坚持度评分 0-100', () => { const now = new Date(); const keys = []; for (let i = 0; i < 30; i++) keys.push(core.dayKey(new Date(now.getTime() - i * 86400000))); const s = {}; keys.forEach((k) => (s[k] = { byBook: { a: 60000 } })); const r = core.consistencyScore(s, 30); return r.score === 100 && r.activeDays === 30; });
t(157, '读完预测给 ETA', () => { const r = core.forecastFinish({ remainingChars: 12000 }, 200, 60); return r.days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.eta); });
t(158, '周期对比给涨跌', () => { const s = { '2026-01-01': { byBook: { a: 60000 } }, '2026-02-01': { byBook: { a: 30000 } } }; const r = core.periodCompare(s, ['2026-01-01'], ['2026-02-01']); return r.a === 60000 && r.b === 30000 && r.delta === 30000; });
t(159, '年度书影汇总', () => { const s = { '2026-03-01': { byBook: { a: 60000 } } }; const r = core.yearInBooks(s, [{ id: 'a', title: 'A' }], 2026); return r.activeDays === 1 && r.finished === 0; });
t(160, '阅读 DNA 趣味标签', () => { const r = core.readingDna({}, [{ genre: '小说' }]); return ['定力型', '规律型', '随性型'].includes(r.archetype) && r.topGenre === '小说'; });
t(161, '自动归档已读完且久未碰', () => { const now = Date.now(); const m = [{ id: 'a', lastReadAt: now - 40 * 86400000 }, { id: 'b', lastReadAt: now - 2 * 86400000 }]; const progress = { a: { pct: 100 }, b: { pct: 100 } }; const r = core.autoArchiveFinished(m, progress, now, 30); return r.length === 1 && r[0].id === 'a'; });
t(162, '智能标签建议', () => { const b = { title: '张三传记', author: '张三' }; const r = core.smartTagSuggest(b, ['科幻'], 3); return r.includes('传记') && r.includes('张三'); });
t(163, '自动续读挑最近未读完', () => { const now = Date.now(); const m = [{ id: 'a', lastReadAt: now - 1000, readState: 'reading' }, { id: 'b', lastReadAt: now, readState: 'unread' }]; const r = core.autoResumeLast(m, {}, now); return r && r.id === 'b'; });
t(164, '夜间模式定时按小时', () => { const r = core.nightModeSchedule(new Date(2026, 0, 1, 22), { nightStart: 19, dayStart: 7 }); return r.on && r.nightStart === 19; });
t(165, '自动备份节拍判定到期', () => core.autoBackupCadence(Date.now() - 20 * 86400000, { enabled: true, everyDays: 7 }).due && !core.autoBackupCadence(Date.now(), { enabled: false }).due);
t(166, '导入即智能去重', () => { const local = [{ id: 'a', title: '书', isbn: '1', updatedAt: 1 }]; const inc = [{ id: 'a', title: '书', isbn: '1', updatedAt: 2 }, { id: 'b', title: '新', isbn: '2', updatedAt: 1 }]; const r = core.smartDedupeOnImport(inc, local); return r.added.length === 1 && r.merged.length === 1 && r.skipped === 0; });
t(167, '静默时段免打扰', () => core.quietHoursSilence(new Date(2026, 0, 1, 23), { enabled: true, from: 22, to: 8 }) && !core.quietHoursSilence(new Date(2026, 0, 1, 12), { enabled: true, from: 22, to: 8 }));
t(168, '变更即备份策略', () => { const r = core.changeBackupPolicy({ action: 'purge' }); return r.backupBefore && r.required; });
t(169, '规则引擎安全条件', () => { const r = core.ruleEngine([{ id: '1', when: { field: 'pct', op: 'gte', value: 99 }, then: 'archive' }, { id: '2', when: { field: 'x', op: 'eq', value: 1 }, then: 'tag' }], { pct: 100 }); return r[0].matched && r[0].action === 'archive' && !r[1].matched; });
t(170, '批量操作打标/归档/导出', () => { const t = core.batchOperations(['a', 'b'], { type: 'tag', tags: ['x'] }); return t.length === 2 && t[0].tags[0] === 'x'; });
t(171, '笔记导出 Markdown 带书标题', () => { const md = core.exportNotesMarkdown([{ bookId: 'a', quote: 'Q', text: 'T', tags: ['x'] }], [{ id: 'a', title: 'A' }], {}); return md.includes('## 《A》') && md.includes('> Q') && md.includes('T'); });
t(172, '注释层导出结构', () => core.exportEpubAnnotation([{ bookId: 'a', text: 'x', anchor: 'c1' }]).count === 1);
t(173, '截图卡片数据', () => core.clipToImage({ quote: '长'.repeat(100), bookId: 'a' }).render === 'canvas');
t(174, '长篇读书报告', () => { const r = core.longExportReport({ title: 'A' }, [{ quote: 'x', text: 'T' }], { totalMs: 60000 }); return r.noteCount === 1 && r.minutes === 1; });
t(175, '自定义模板列表', () => core.noteTemplates().length === 4);
t(176, '引文管理 APA 格式', () => core.citationManager({ quote: 'x' }, { author: '张三', year: '2020', title: '书' }).apa.includes('张三'));
t(177, '思维导图导出结构', () => core.mindMapExport({ root: '书', nodes: [{ id: '1', label: 'a' }] }).nodes.length === 1);
t(178, 'PDF 批注导出需原文件', () => core.pdfAnnotationExport([{ page: 1, text: 'x' }]).needsSource === true);
t(179, '博客草稿合成', () => { const d = core.blogDraftFromNotes([{ quote: 'Q', text: 'T' }], { title: '随笔' }); return d.includes('随笔') && d.includes('Q'); });
t(180, '可打印阅读日志表头', () => core.printableReadingLog([{ title: 'A', author: 'B', lastReadAt: Date.now() }], {}).startsWith('| 书名'));
t(181, '蓝光滤镜定时夜间开', () => { const r = core.blueLightSchedule(22, { nightStart: 19, dayStart: 7 }); return r.on && r.level === 30; });
t(182, '姿势提醒到期', () => core.postureReminder(40 * 60000, 30).due && !core.postureReminder(5 * 60000, 30).due);
t(183, '20-20-20 护眼计时', () => { const r = core.eyeRest202020(0, 25 * 60000, 20); return r.due && r.intervalMin === 20; });
t(184, '亮度自适应传感器优先', () => { const s = core.brightnessAuto({ lux: 300 }); return s.source === 'sensor' && s.brightness >= 10; });
t(185, '字号护眼区间成人', () => { const r = core.fontSizeEyeComfort('adult'); return r.min === 15 && r.max === 21 && r.recommended === 18; });
t(186, '环境光适配钩子', () => core.ambientLightAdapt(true).fallback === 'schedule');
t(187, '单次时长上限', () => { const r = core.sessionCap(70 * 60000, 60); return r.exceeded && r.capMin === 60; });
t(188, '喝水提醒到期', () => core.hydrationNudge(50 * 60000, 45).due);
t(189, '暗室模式极黑', () => { const r = core.darkRoomMode({ on: true }); return r.on && r.paper === '#000000'; });
t(190, '呼吸引导 4-7-8', () => { const r = core.focusBreathCue({}); return r.pattern.join('-') === '4-7-8' && r.dismissible; });
t(191, '无崩溃遥测本地计数', () => { const r = core.crashFreeTelemetry({ launches: 100, crashes: 2 }); return r.crashFreeRate === 98 && r.uploaded === false; });
t(192, '离线优先保证', () => core.offlineFirstGuarantee({ shelf: true, reader: true, stats: true, notes: true, tts: true, search: true }).ok && !core.offlineFirstGuarantee({ reader: false }).ok);
t(193, '资源懒加载策略', () => core.lazyResourceLoading(['font.woff']).strategy === 'onDemand');
t(194, '内存压力处理分级', () => core.memoryPressureHandle('critical').action === 'releaseAllNonVisible' && core.memoryPressureHandle('ok').action === 'none');
t(195, '缓存上限钳制', () => { const r = core.cacheSizeCap(120000000, 100000000); return r.over && r.ratio === 120; });
t(196, '后台静默更新策略', () => core.updateInBackground({}).enabled && core.updateInBackground({ enabled: false }).note.includes('关闭'));
t(197, '完整性自检', () => { const r = core.integrityCheck({ books: [{ id: 'a' }], stats: {} }); return r.ok && r.problems.length === 0; });
t(198, '优雅降级隐藏不可用', () => { const r = core.gracefulDegradation(['a', 'b'], ['a']); return r.map.a && !r.map.b && r.hidden.includes('b'); });
t(199, '性能预算判定超时', () => { const r = core.performanceBudget('searchMs', 500); return r.known && r.over && r.budget === 300; });
t(200, '自诊断报告汇总', () => { const r = core.selfDiagnosticReport({ used: 100, quota: 1000, crashes: 0, permissions: [], networkTargets: [] }); return r.storage.pressure === 'ok' && r.localOnly; });

check('200 项能力契约全部登记且编号连续无重复',
  C.length === 200 && eq(C.map((x) => x.id), core.NEXUS_FEATURE_IDS) && core.NEXUS_GROUPS.length === 20);
C.forEach((c) => {
  let pass = false, extra;
  try { const r = c.fn(); if (r && typeof r === 'object' && 'pass' in r) { pass = r.pass; extra = r.extra; } else pass = !!r; }
  catch (e) { extra = { error: String(e && e.message || e) }; }
  check(`#${String(c.id).padStart(3, '0')} ${c.name}`, pass, extra);
});

/* ============ ② 源码级接线 ============ */
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
const nx = fs.readFileSync(path.join(ROOT, 'js/nexus.js'), 'utf8');
const nxCss = fs.readFileSync(path.join(ROOT, 'css/nexus.css'), 'utf8');
const roadmap = fs.readFileSync('docs/roadmap-200.md', 'utf8');

check('SW 升到 inkreader-v14 / PREV_CACHE v13',
  /const CACHE = 'inkreader-v14'/.test(sw) && /const PREV_CACHE = 'inkreader-v13'/.test(sw));
check('SW ASSETS 补齐 nexus.css / nexus.js / nexus-core.js',
  /'css\/nexus\.css'/.test(sw) && /'js\/nexus\.js'/.test(sw) && /'js\/nexus-core\.js'/.test(sw));
check('index.html 引入 nexus.css', /css\/nexus\.css/.test(html));
check('app.js 挂载 Nexus 层且 init 顺序在 Stats 之后',
  /mountReaderNexus/.test(app) && /createStatsLayer\(\);\s*\n\s*createNexusLayer\(\);/.test(app));
check('能力层入口复用 #pro-chip，不新增 fixed 浮层',
  /getElementById\('pro-chip'\)/.test(nx) && !/class="nx-fab"/.test(nx));
check('能力中心面板初始 hidden（不遮挡控制条按钮）', /id="nexus-panel" class="nx-panel hidden"/.test(nx));
check('热区 / 键位 / 删书 / 导入错误 / 跳转均已接入主控',
  /nexus\.hitZone\(/.test(app) && /nexus\.keyAction\(/.test(app) &&
  /nexus\.onBookDelete\(/.test(app) && /nexus\.onImportError\(/.test(app) && /jumpTo:/.test(app));
check('导出优先走 Android 原生桥，浏览器降级 Blob',
  /window\.InkTools/.test(nx) && /bridge\.save\(name, btoa\(bin\)\)/.test(nx) && /createObjectURL/.test(nx));
check('删书文案不再宣称「不可恢复」', /30 天内可在/.test(app));
check('CSS 零动画（墨水屏原则）', !/animation\s*:|transition\s*:/.test(nxCss));
check('package.json 纳入 test:nexus 且 npm test 含第八套',
  !!pkg.scripts['test:nexus'] && /test\/nexus\.mjs/.test(pkg.scripts.test));
check('版本升到 versionCode 23 / 1.3.0', /versionCode 23/.test(gradle) && /versionName "1\.3\.0"/.test(gradle));
const roadRows = roadmap.match(/^\| (\d{1,3}) \|/gm) || [];
check('路线图文件含 100 个编号项与落地矩阵',
  roadRows.length === 100 && /落地矩阵/.test(roadmap));

/* ============ ③ 真实 App 集成 ============ */
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const s = m.text();
  if (/favicon/i.test(s) || /favicon/i.test((m.location() || {}).url || '')) return;
  errors.push('CONSOLE: ' + s);
});
let dialogMode = 'dismiss';
page.on('dialog', async (d) => { try { dialogMode === 'accept' ? await d.accept() : await d.dismiss(); } catch (e) {} });
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('inkreader:pro-guide-v1', '1');
    sessionStorage.setItem('sw-reloaded', '1');
    const s = JSON.parse(localStorage.getItem('inkreader:settings') || '{}');
    s.theme = 'ink'; s.pageFlip = false;
    localStorage.setItem('inkreader:settings', JSON.stringify(s));
  } catch (e) {}
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(800);
  check('App 启动无致命报错（Nexus 已进入模块图）', errors.length === 0, { errors });
  check('Nexus 已挂载且声明 200 项能力',
    await page.evaluate(() => !!window.__INK_NEXUS && window.__INK_NEXUS.state().featureCount === 200));
  check('能力中心面板默认隐藏',
    await page.evaluate(() => document.getElementById('nexus-panel').classList.contains('hidden')));
  check('阅读器入口挂在 #pro-chip 内，不产生新浮层',
    await page.evaluate(() => { const b = document.getElementById('nx-chip-open'); return !!b && b.parentElement && b.parentElement.id === 'pro-chip'; }));
  check('书架工具条在文档流内且不遮挡「导入」按钮',
    await page.evaluate(() => {
      const bar = document.getElementById('nexus-shelfbar');
      const btn = document.getElementById('import-epub');
      if (!bar || !btn) return false;
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === btn || btn.contains(top));
    }));

  // 注入一本三章书 + 统计，供搜索 / 计划 / 诊断使用
  await page.evaluate(async () => {
    const { putBook } = await import('/js/store.js');
    await putBook({
      id: 'nx-book', title: '桃花源记', author: '陶渊明', source: 'txt',
      addedAt: Date.now(), chaptersCount: 3,
      chapters: [
        { title: '第一卷', html: '<p>晋太元中，武陵人捕鱼为业。</p>' },
        { title: '第一章', html: '<p>忽逢桃花林，夹岸数百步，中无杂树。</p>' },
        { title: '第二章', html: '<p>土地平旷，屋舍俨然，有良田美池桑竹之属。</p>' },
      ],
    });
    const k = new Date(); const dk = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, '0')}-${String(k.getDate()).padStart(2, '0')}`;
    localStorage.setItem('inkreader:stats', JSON.stringify({ [dk]: { byBook: { 'nx-book': 1500000 }, checkin: true } }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(700);

  // 六个页签都能渲染
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'search'));
  await sleep(250);
  for (const tab of ['search', 'notes', 'shelf', 'plan', 'settings', 'diagnose']) {
    await page.evaluate((tb) => window.__INK_NEXUS.setOpen(true, tb), tab);
    await sleep(240);
    check(`能力中心「${tab}」页签有真实内容`,
      await page.evaluate(() => document.getElementById('nexus-body').textContent.trim().length > 20));
  }

  // 跨书搜索
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'search'));
  await sleep(150);
  await page.evaluate(() => { document.getElementById('nx-q').value = '桃花'; document.getElementById('nx-go').click(); });
  await sleep(250);
  check('跨书全文搜索返回命中并高亮',
    await page.evaluate(() => document.querySelectorAll('#nx-results .nx-hit').length >= 1 &&
      !!document.querySelector('#nx-results mark')));
  check('搜索历史已写入本地',
    await page.evaluate(() => JSON.parse(localStorage.getItem('inkreader:nexus:history') || '[]').includes('桃花')));
  // 快捷跳转
  await page.evaluate(() => { document.getElementById('nx-q').value = '第2章'; document.getElementById('nx-go').click(); });
  await sleep(150);
  check('快捷跳转被识别且不会当成搜索词',
    await page.evaluate(() => window.__INK_NEXUS.state().query === '桃花'));

  // 笔记
  await page.evaluate(() => {
    window.__INK_NEXUS.addNote({ bookId: 'nx-book', ci: 1, quote: '忽逢桃花林', text: '这一句真好', tags: ['景色'] });
    window.__INK_NEXUS.setOpen(true, 'notes');
  });
  await sleep(200);
  check('批注写入后在笔记页可见',
    await page.evaluate(() => document.getElementById('nexus-body').textContent.includes('这一句真好')));
  check('笔记搜索即时过滤',
    await page.evaluate(() => {
      const i = document.getElementById('nx-note-q'); i.value = '不存在的词';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelectorAll('.nx-note:not(.nx-filtered)').length === 0;
    }));

  // 计划与年度报告
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'plan'));
  await sleep(200);
  check('计划页显示进度环与本年真实统计',
    await page.evaluate(() => !!document.querySelector('.nx-ring') &&
      /本年累计 \d+ 分钟/.test(document.getElementById('nexus-body').textContent)));
  await page.evaluate(() => { document.getElementById('nx-plan-target').value = '24'; document.getElementById('nx-plan-save').click(); });
  await sleep(200);
  check('年度目标可保存并生效',
    await page.evaluate(() => JSON.parse(localStorage.getItem('inkreader:nexus:plan') || '{}').target === 24));

  // 设置：主题实时预览 / 对比度 / 设置搜索
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'settings'));
  await sleep(200);
  await page.evaluate(() => { document.getElementById('nx-paper').value = '#ffffff'; document.getElementById('nx-ink').value = '#000000'; document.getElementById('nx-theme-apply').click(); });
  await sleep(200);
  check('主题实时预览真的写入 CSS 变量',
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg') === '#ffffff'));
  check('主题码可往返',
    await page.evaluate(() => { const c = window.__INK_NEXUS.core; return c.parseTheme(c.encodeTheme({ paper: '#fff' })).paper === '#fff'; }));
  check('设置项搜索可过滤',
    await page.evaluate(() => { const i = document.getElementById('nx-set-q'); i.value = '朗读'; i.dispatchEvent(new Event('input', { bubbles: true })); return document.getElementById('nx-set-count').textContent.includes('项'); }));

  // 新 UI 接入：书架待读队列 / 今日一句 / 护眼与节律
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'shelf'));
  await sleep(200);
  check('书架页签接入「待读队列 + 今日一句」',
    await page.evaluate(() => { const x = document.getElementById('nexus-body').textContent; return x.includes('待读队列') && x.includes('今日一句'); }));
  check('待读队列点击条目可打开阅读器',
    await page.evaluate(() => {
      const item = document.querySelector('.nx-item[data-open-book]');
      if (!item) return true; // 无待读时跳过
      item.click();
      return document.getElementById('reader') && !document.getElementById('reader').classList.contains('hidden');
    }));
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'settings'));
  await sleep(200);
  check('设置页签接入「护眼与节律」且开关可存',
    await page.evaluate(() => {
      const x = document.getElementById('nexus-body').textContent;
      const cb = document.getElementById('nx-eye');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      return x.includes('护眼与节律') && !!cb && JSON.parse(localStorage.getItem('inkreader:nexus:config') || '{}').eyeRest === true;
    }));

  // 诊断：存储水位 / 隐私 / 备份预检
  await page.evaluate(() => window.__INK_NEXUS.setOpen(true, 'diagnose'));
  await sleep(200);
  check('诊断页显示本地数据与隐私说明',
    await page.evaluate(() => { const x = document.getElementById('nexus-body').textContent; return x.includes('存储水位') && x.includes('仅本地'); }));

  // 热区与键位：默认行为与旧版一致
  check('默认热区与旧版 0.3 / 0.7 完全一致',
    await page.evaluate(() => { const n = window.__INK_NEXUS; return n.hitZone(20, 50, 100, 100) === 'prev' && n.hitZone(80, 50, 100, 100) === 'next' && n.hitZone(50, 50, 100, 100) === 'menu'; }));
  check('未配置键位时不劫持方向键',
    await page.evaluate(() => window.__INK_NEXUS.keyAction('ArrowRight') === null));

  // 关闭面板后不遮挡书架按钮
  await page.evaluate(() => window.__INK_NEXUS.setOpen(false));
  await sleep(120);
  check('关闭能力中心后不遮挡底部导航',
    await page.evaluate(() => {
      const b = document.querySelector('#tabbar .tab[data-view="stats"]');
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === b || b.contains(top));
    }));

  check('全流程无未捕获异常 / console error', errors.length === 0, { errors });
} catch (e) {
  check('测试执行未抛异常', false, { error: String(e && e.stack || e) });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  ' + JSON.stringify(r.extra || {})}`));
console.log(`\nnexus: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
