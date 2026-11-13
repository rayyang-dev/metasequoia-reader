// 红杉阅读 —— 主控逻辑
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  putBook, getBook, deleteBook, listBooksMeta, getAllBooks,
  loadProgress, saveProgress, getProgress,
  loadBookmarks, saveBookmarks,
  loadHighlights, saveHighlights, loadFavorites, saveFavorites,
  addReadingTime, loadStats,
} from './store.js';
import { paginateChapter, chapterCharCount } from './paginate.js';
import { parseTxt, parseEpub, parsePdf, parseMobi, parseFb2, parseHtml, parseDocx } from './importers.js';
import { openPdf, renderPdfPage } from './pdfview.js';
import { translateText } from './translate.js';
import {
  aiConfigured, aiSummary, aiExplain, aiAsk, aiNotes, aiBilingual, pageParagraphs, renderMarkdown,
} from './ai.js';
// Pro 层：统一翻页编排 / 端侧视线信号 / 阅读器交互增强。全部为本地 ESM，无任何裸 @capacitor/* 导入。
import { createTurnController } from './turn.js';
import { createGazeEngine } from './gaze.js';
import { mountReaderPro } from './pro.js';
import { mountReaderPlus } from './plus.js';
import { readingTimeTick } from './plus-core.js';
import { mountStatsDashboard } from './stats.js';
import { mountReaderNexus } from './nexus.js';
import { mountAurora } from './aurora.js';
import { playInkFlip } from './inkflip.js';

// Capacitor 仅存在于原生外壳（Android WebView），由桥接层把插件挂在全局 window.Capacitor.Plugins 上。
// 本项目 www/ 未打包，浏览器 / PWA 环境没有运行时、也没有 importmap，若用裸模块导入
// '@capacitor/app' 会在模块求值阶段抛 “Failed to resolve module specifier” 导致整个 app.js
// 不执行、所有按钮失活。因此直接读取 window.Capacitor.Plugins.App：原生环境正常挂载原生能力，
// 非原生环境（纯浏览器 / 本地预览）安全置空、跳过即可，绝不影响核心阅读功能。
// Capacitor 仅存在于原生外壳（Android WebView），由桥接层把插件挂在全局 window.Capacitor.Plugins 上。
// 本项目 www/ 未打包，浏览器 / PWA 环境没有运行时、也没有 importmap，若用裸模块导入
// '@capacitor/app' 会在模块求值阶段抛 “Failed to resolve module specifier” 导致整个 app.js
// 不执行、所有按钮失活。因此直接读取 window.Capacitor.Plugins.App 并提供懒解析：原生环境正常
// 挂载原生能力、非原生环境（纯浏览器 / 本地预览）安全返回 null、跳过即可，绝不影响核心阅读功能。
function capacitorApp() {
  try {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) || null;
  } catch (e) {
    return null;
  }
}

const FONT_STACK = {
  serif: 'Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", serif',
  sans: '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  mono: '"Courier New", "Noto Sans Mono", monospace',
};

// 主题皮肤（顺序即设置页色板顺序）；THEME_PREVIEW 仅用于色板预览的 bg/fg
// 仅保留 2 套：墨水风(宣纸底·笔迹淡化翻页) / 简约(米白底·整页水平滑动)
const THEMES = [
  { id: 'ink', name: '墨水风' },
  { id: 'simple', name: '简约' },
  { id: 'night', name: '夜览' },
];
const THEME_PREVIEW = {
  ink: ['#fefdfb', '#202b31'], simple: ['#f7f6f2', '#1f1f1f'],
  night: ['#15181a', '#c8c5bc'],
};

// 法律声明文案（隐私政策 / 用户协议 / 权限说明）。iOS 与华为两平台通用，纯本地静态内容，无服务器依赖。
// 联系邮箱、生效日期等需按实际情况替换（下方以占位给出）。
const LEGAL_EFFECTIVE_DATE = '2026-11-04';
const LEGAL_CONTACT_EMAIL = '732897783@qq.com'; // 送审版：与应用外隐私政策页保持一致
const LEGAL_CONTENT = {
  privacy: {
    title: '隐私政策',
    html: `
      <p>生效日期：${LEGAL_EFFECTIVE_DATE}</p>
      <p>红杉阅读（以下简称"本应用"）是一款<b>本地优先</b>的电子书阅读器。我们极其重视你的隐私，并遵循"数据最小化"原则。本政策说明我们如何处理信息。</p>
      <h2>一、我们收集的信息</h2>
      <p>本应用默认完全在你的设备本地运行，<b>不要求注册账号</b>，不收集任何个人信息即可使用核心阅读功能。保存在你设备上的数据仅包括：导入的书籍文件、阅读进度与书签、排版与主题等设置。这些数据均保存在你的设备本地存储/应用沙盒中，<b>不会自动上传到任何服务器</b>（本应用没有后端服务器）。</p>
      <h2>二、AI 与联网功能</h2>
      <p>本版本<b>未开放</b> AI 助手、在线翻译等任何联网功能，也不提供配置第三方 API Key 的入口。本应用不会将你的书籍内容、选中文本或任何个人数据发送给第三方服务；应用内没有 AI 生成内容，也不存在与第三方模型相关的数据传输。</p>
      <h2>三、网络权限</h2>
      <p>本应用仅声明"网络"权限，由 Capacitor WebView 框架用于加载应用内本地资源；本应用没有后端服务器，不请求任何外部服务，也没有版本检查或遥测上报。书籍导入、阅读、笔记均不依赖网络，断网后全部核心功能可正常使用。</p>
      <h2>四、我们不会出售或共享你的个人信息</h2>
      <p>除法律法规要求外，我们不会向任何第三方披露、出售或交易你的数据。</p>
      <h2>五、儿童隐私</h2>
      <p>本应用不专门面向未满 14 周岁的儿童，我们不会有意收集儿童个人信息。</p>
      <h2>六、你的权利</h2>
      <p>你可以随时通过卸载应用，或在系统设置中清除应用数据，来删除全部本地数据。</p>
      <h2>七、政策变更</h2>
      <p>如本政策发生变更，我们将在应用内更新并以最新版本为准。</p>
      <h2>八、联系我们</h2>
      <p>如你对隐私事宜有疑问，可通过邮箱 ${LEGAL_CONTACT_EMAIL} 联系我们。</p>
    `,
  },
  terms: {
    title: '用户协议',
    html: `
      <p>生效日期：${LEGAL_EFFECTIVE_DATE}</p>
      <p>欢迎使用红杉阅读。使用本应用即表示你同意以下条款。</p>
      <h2>一、软件许可</h2>
      <p>在遵守本协议的前提下，我们授予你一项<b>非独占、可撤销</b>的有限许可，允许你在自有设备上为个人非商业目的安装与使用本应用。</p>
      <h2>二、使用规范</h2>
      <ul>
        <li>不得利用本应用从事任何违反法律法规的活动；</li>
        <li>你导入的书籍应保证拥有合法授权，因内容版权产生的责任由你自行承担；</li>
        <li>不得对本应用进行反向工程、反编译或试图提取源代码（法律允许的情形除外）。</li>
      </ul>
      <h2>三、知识产权</h2>
      <p>本应用软件的著作权归开发者所有；应用内所展示的书籍内容版权归原作者或出版方所有，本应用不因此获得任何内容授权。</p>
      <h2>四、内容免责</h2>
      <p>本应用不提供书籍内容，也不生成 AI 内容；导入的书籍由你自行选择，其版权、准确性与完整性由原作者或出版方负责，使用者应自行判断并自负其责。</p>
      <h2>五、免责声明</h2>
      <p>本应用"按现状"提供，不保证无中断、无错误或永久可用。因使用或无法使用本应用而产生的风险与损失，由你自行承担。</p>
      <h2>六、协议终止</h2>
      <p>如你违反本协议，开发者有权终止对你的许可；终止后你应停止使用并删除本应用。</p>
      <h2>七、适用法律</h2>
      <p>本协议的订立、效力与争议解决均适用中华人民共和国法律。</p>
    `,
  },
  permissions: {
    title: '权限说明',
    html: `
      <p>本应用以本地阅读为核心，遵循"权限最小化"原则，尽可能少地申请系统权限。</p>
      <h2>Android</h2>
      <ul>
        <li><b>网络（INTERNET）</b>：由 Capacitor WebView 框架声明，仅用于加载应用内本地资源；不用于收集个人数据，不请求任何外部服务器，也没有版本检查或遥测上报。断网后导入、阅读、排版、标注、统计等所有核心功能均可正常使用。</li>
        <li><b>文件访问</b>：书籍导入通过系统文件选择器（SAF）完成，本应用<b>不申请</b>存储读写权限，无法在未经你主动选择文件的情况下访问设备上的其他文件。</li>
        <li class="camera-feature-only"><b>相机（CAMERA，可选）</b>：仅当你主动开启「视线翻页」时申请，用于在本机端侧检测「读到页底后回看页首」的回扫动作。视频帧只在内存中处理，<b>不上传、不保存、不写入日志</b>；关闭该功能、退出阅读器或切到后台会立即释放摄像头。默认关闭，拒绝授权不影响任何其他功能。</li>
      </ul>
      <h2>iOS（如后续版本上架）</h2>
      <ul>
        <li><b>网络</b>：同上，仅用于加载应用内本地资源，不请求外部服务器。</li>
        <li><b>文件</b>：通过系统"文件 / 文档"选择器导入，不额外申请相册、通讯录、定位等敏感权限。</li>
      </ul>
      <h2>我们不申请的权限</h2>
      <p>本应用不申请定位、通讯录、麦克风、电话、短信等敏感权限；所有核心阅读与笔记功能均可在不授权任何敏感权限的情况下离线使用，本应用也没有可用于上传的后端。<span class="camera-feature-only">可选的相机能力默认关闭、需你主动开启，相机画面从不离开设备。</span></p>
    `,
  },
};

// ---------- 状态 ----------
let settings = loadSettings();
// 主题仅保留 ink / simple（竹简已移除）；旧版本残留的 theme 值统一回退到默认墨水风
if (!THEMES.some((t) => t.id === settings.theme)) {
  settings.theme = DEFAULT_SETTINGS.theme;
  saveSettings(settings);
}
let currentBook = null;
let ci = 0; // 当前章节
let pi = 0; // 当前页（章内）
let pages = []; // 当前章分页结果
let chapterChars = [];
let totalChars = 0;
let turnCounter = 0;
const pageCache = new Map(); // ci + 设置哈希 -> 分页（LRU 上限，避免大书内存膨胀）
const PAGE_CACHE_CAP = 12;
function setPageCache(key, val) {
  pageCache.set(key, val);
  // 超出上限时淘汰最早缓存的章节分页（Map 保持插入顺序，首键即最旧）
  if (pageCache.size > PAGE_CACHE_CAP) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
}
let repTimer = null;
let currentPdfDoc = null; // PDF 阅读时持有的 pdf.js doc
let readingTimer = null; // 阅读计时器
let readingLastTs = 0; // 上一次计时戳
let toastTimer = null;
let isFlipping = false; // 翻页动画进行中，用于忽略重叠点击
const pdfImageCache = new Map(); // ci -> 已渲染的图片 dataURL（LRU 上限，避免通读大 PDF 累积数十 MB）
const PDF_CACHE_CAP = 8;
let turn = null;   // 统一翻页编排层
let gaze = null;   // 视线信号源
let pro = null;    // 阅读器交互增强层
let plus = null;   // Plus 能力增强层（独立模块，删除挂载即可完整回退）
let statsDashboard = null; // v1.1.19 阅读统计仪表盘（独立模块，删除挂载即可完整回退）
let nexus = null;          // v1.2.0 Nexus 能力层（独立模块，删除挂载即可完整回退）

const $ = (id) => document.getElementById(id);

// 当前页已创建的图片 blob URL，翻页/退出阅读器时统一回收，避免内存累积
let pageBlobUrls = [];
function revokePageBlobs() {
  if (pageBlobUrls.length) {
    pageBlobUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
    pageBlobUrls = [];
  }
}
// 阅读页里 <img data-img="路径"> / <image data-img="路径"> 占位，按 currentBook.images 解析为真实地址：
// 字节条目转 blob URL（仅当页解码），data URI 条目（如 FB2）直接用。图片不再随章节 HTML 常驻内存。
function resolvePageImages() {
  const book = currentBook;
  if (!book || !book.images) return;
  const page = $('page');
  if (!page) return;
  const els = page.querySelectorAll('img[data-img], image[data-img]');
  for (const el of els) {
    const key = el.getAttribute('data-img');
    const entry = book.images[key];
    if (!entry) continue;
    let url = null;
    if (typeof entry.s === 'string') {
      url = entry.s; // 已是 data URI（如 FB2）
    } else if (entry.b) {
      try {
        const blob = new Blob([entry.b], { type: entry.m || 'image/png' });
        url = URL.createObjectURL(blob);
        pageBlobUrls.push(url);
      } catch (e) { continue; }
    }
    if (!url) continue;
    if (el.tagName.toLowerCase() === 'image') {
      el.setAttribute('href', url);
      el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
    } else {
      el.src = url;
    }
  }
}

// 复杂/加密的 Kindle 格式（AZW3/KFX 多为加密或 KF8 复杂结构），浏览器内无法可靠解析，引导 Calibre
// 注：.mobi / .azw（无加密）已由 mobidec.js 在应用内直接解析导入
const KINDLE_RE = /\.(azw3|kfx)$/i;

// ---------- 设置 -> DOM ----------
function applySettings() {
  const b = document.body;
  b.dataset.theme = settings.theme;
  b.dataset.font = settings.fontFamily;
  b.style.setProperty('--r-font-size', settings.fontSize + 'px');
  b.style.setProperty('--r-line-height', String(settings.lineHeight));
  b.style.setProperty('--r-font-family', FONT_STACK[settings.fontFamily]);
  b.style.setProperty('--r-letter-spacing', settings.letterSpacing + 'px');
  b.style.setProperty('--r-margin', settings.margin + 'px');
  b.style.setProperty('--r-para-space', settings.paragraphSpacing + 'em');
  b.style.setProperty('--r-indent', settings.firstLineIndent ? '2em' : '0');
  b.style.setProperty('--r-justify', settings.justify ? 'justify' : 'left');
  syncSettingsUI();
}

function syncSettingsUI() {
  renderThemeSwatches();
  setSeg('seg-font', settings.fontFamily);
  setSeg('seg-regal', String(settings.regalRefresh));
  $('set-flip').checked = !!settings.pageFlip;
  $('set-fontsize').value = settings.fontSize;
  $('val-fontsize').textContent = settings.fontSize + 'px';
  $('set-lineheight').value = settings.lineHeight;
  $('val-lineheight').textContent = settings.lineHeight.toFixed(2);
  $('set-margin').value = settings.margin;
  $('val-margin').textContent = settings.margin + 'px';
  $('set-paraspacing').value = settings.paragraphSpacing;
  $('val-paraspacing').textContent = settings.paragraphSpacing.toFixed(1) + 'em';
  $('set-letterspacing').value = settings.letterSpacing;
  $('val-letterspacing').textContent = settings.letterSpacing + 'px';
  $('set-justify').checked = settings.justify;
  $('set-indent').checked = settings.firstLineIndent;
  setSeg('seg-translate-provider', settings.translateProvider);
  setSeg('seg-tdir', settings.translateDir);
  $('set-tkey').value = settings.translateApiKey || '';
  $('set-tbase').value = settings.translateLlmBase || 'https://api.openai.com/v1';
  $('set-tmodel').value = settings.translateLlmModel || 'gpt-4o-mini';
  $('set-ai-auto').checked = !!settings.aiAutoSummary;
  $('set-checkin').value = settings.checkinGoalMin;
  $('val-checkin').textContent = settings.checkinGoalMin + ' 分钟';
  $('set-group-cat').checked = !!settings.shelfGroupByCat;
  $('set-keep-screen').checked = !!settings.keepScreenOn;
  renderCatManager();
  updateTranslateFieldsVisibility();
}

function setSeg(id, val) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.val === String(val));
  });
}

// 主题皮肤色板：渲染为「色块 + 名称」，点击即切换并落地到设置
function renderThemeSwatches() {
  const wrap = $('theme-swatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  THEMES.forEach((t) => {
    const prev = THEME_PREVIEW[t.id] || ['#ccc', '#333'];
    const btn = document.createElement('button');
    btn.className = 'swatch' + (settings.theme === t.id ? ' active' : '');
    btn.dataset.val = t.id;
    const chip = document.createElement('span');
    chip.className = 'sw-chip';
    chip.style.background = prev[0];
    chip.style.borderColor = settings.theme === t.id ? 'var(--accent)' : prev[1];
    const name = document.createElement('span');
    name.className = 'sw-name';
    name.textContent = t.name;
    btn.appendChild(chip);
    btn.appendChild(name);
    btn.addEventListener('click', () => {
      settings.theme = t.id;
      applySettings();
      saveSettings(settings);
      renderThemeSwatches();
    });
    wrap.appendChild(btn);
  });
}

// ---------- 书架 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let activeCategory = null; // null = 全部

// 书名关键词粗分类：按优先级（政治 > 历史 > 文学 > 小说）匹配，未命中归「其他」
const CATEGORY_RULES = [
  { cat: '政治', keys: ['政治', '政府', '国家', '制度', '革命', '政策', '民主', '政党', '领袖', '外交', '马克思', '毛泽东', '邓小平', '共和国', '宪政', '资本论', '体制', '政权', '改革', '法治', '列强'] },
  { cat: '历史', keys: ['历史', '史', '朝代', '古代', '近代', '民国', '史记', '通鉴', '文明', '王朝', '帝国', '战国', '秦汉', '唐', '宋', '明', '清', '战争', '传记', '考古', '丝路', '罗马', '希腊', '欧洲', '中国史'] },
  { cat: '文学', keys: ['文学', '诗', '散文', '文集', '随笔', '诗歌', '戏剧', '诗词', '名著', '经典', '杂文', '童话', '寓言', '小说集', '散文集', '诗集'] },
  { cat: '小说', keys: ['小说', '长篇', '短篇', '言情', '武侠', '科幻', '悬疑', '推理', '玄幻', '奇幻', '都市', '穿越', '末世', '修仙', '网游', '侦探', '校园', '职场', '军事', '谍战', '宫斗', '种田', '甜宠', '网文', '灵异', '架空'] },
];
function classifyTitle(title) {
  const t = (title || '').toLowerCase();
  if (!t) return '其他';
  for (const r of CATEGORY_RULES) {
    if (r.keys.some((k) => t.includes(k.toLowerCase()))) return r.cat;
  }
  return '其他';
}

async function renderShelf() {
  const metas = await listBooksMeta();
  const list = plus ? plus.sortShelf(metas) : metas; // Plus：最近阅读置顶 / 系列分组
  const el = $('book-list');
  const empty = $('shelf-empty');
  const hint = $('drop-hint');
  const filter = $('tag-filter');
  el.innerHTML = '';
  if (!list.length) {
    el.classList.add('hidden');
    empty.classList.remove('hidden');
    hint.classList.add('hidden');
    filter.classList.add('hidden');
    filter.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  empty.classList.add('hidden');
  hint.classList.remove('hidden');

  // 顶部分类条：全部 + 用户分类 + 其他（当存在不在列表中的分类时出现）
  const cats = settings.categories || [];
  const inList = (c) => cats.includes(c);
  const hasOther = list.some((b) => !inList(b.category));
  filter.classList.remove('hidden');
  filter.innerHTML = '';
  filter.appendChild(mkTagChip('全部', activeCategory === null, () => { activeCategory = null; renderShelf(); }));
  cats.forEach((c) => {
    filter.appendChild(mkTagChip(c, activeCategory === c, () => { activeCategory = c; renderShelf(); }));
  });
  if (hasOther) {
    filter.appendChild(mkTagChip('其他', activeCategory === '其他', () => { activeCategory = '其他'; renderShelf(); }));
  }
  filter.appendChild(mkAddCatChip());

  const shown = activeCategory === null
    ? list
    : activeCategory === '其他'
      ? list.filter((b) => !inList(b.category))
      : list.filter((b) => (b.category || '其他') === activeCategory);

  const grouped = !!settings.shelfGroupByCat;
  el.classList.toggle('grouped', grouped);
  if (!grouped) {
    if (!shown.length) {
      el.innerHTML = '<p class="empty-tip">该分类下暂无书籍。</p>';
      return;
    }
    shown.forEach((b) => el.appendChild(renderBookCard(b)));
    return;
  }

  // 按分类分组书架
  const groups = new Map();
  shown.forEach((b) => {
    const c = b.category || '其他';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(b);
  });
  const order = cats.concat(['其他']);
  const ordered = Array.from(groups.keys()).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!ordered.length) {
    el.innerHTML = '<p class="empty-tip">该分类下暂无书籍。</p>';
    return;
  }
  ordered.forEach((c) => {
    el.appendChild(mkGroupHeader(c));
    el.appendChild(mkBookRow(groups.get(c)));
  });
}

// 分类条上的「+ 分类」按钮：弹窗新增分类
function mkAddCatChip() {
  const c = document.createElement('button');
  c.className = 'tag-chip add-cat';
  c.textContent = '+ 分类';
  c.addEventListener('click', () => {
    const name = prompt('新建分类名称：');
    if (!name) return;
    addCategory(name.trim());
  });
  return c;
}
function addCategory(name) {
  const v = (name || '').trim();
  if (!v) return;
  const cats = settings.categories || [];
  if (cats.includes(v)) { alert('分类「' + v + '」已存在'); return; }
  settings.categories = cats.concat(v);
  saveSettings(settings);
  renderCatManager();
  renderShelf();
}
async function removeCategory(cat) {
  if (!confirm('删除分类「' + cat + '」？该分类下的书将归入「其他」。')) return;
  settings.categories = (settings.categories || []).filter((x) => x !== cat);
  saveSettings(settings);
  if (activeCategory === cat) activeCategory = null;
  renderCatManager();
  renderShelf();
}
// 设置页「分类管理」列表渲染
function renderCatManager() {
  const wrap = $('cat-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  (settings.categories || []).forEach((c) => {
    const item = document.createElement('span');
    item.className = 'cat-item';
    item.innerHTML = '<span class="cat-name">' + escapeHtml(c) + '</span>' +
      '<button class="cat-del" type="button" data-cat="' + escapeHtml(c) + '" aria-label="删除">×</button>';
    wrap.appendChild(item);
  });
}

// 从章节 HTML 提取封面：EPUB 封面页常是 <img> 或 SVG <image xlink:href>，解析器已内联为 data URI。
// 只扫前三章（封面/扉页通常在最前），并过滤过小的图标或装饰图。
function extractCoverFromBook(book) {
  const chs = (book && book.chapters) || [];
  for (let i = 0; i < Math.min(chs.length, 3); i++) {
    const html = chs[i].html || '';
    const m = html.match(/<(?:img|image)\b[^>]*?\b(?:src|xlink:href|href)\s*=\s*["'](data:image\/[^"']+)["']/i);
    if (m && m[1].length > 1000) return m[1];
  }
  return '';
}
// 启动时回填历史书籍缺失的元数据（分类 + 封面）。cover 用「是否已定义」判断，
// 空串代表已检查过且无封面，避免每次启动重复扫描整本书的 HTML。
async function ensureBookMeta() {
  const books = await getAllBooks();
  let changed = false;
  for (const b of books) {
    let dirty = false;
    if (!b.category) { b.category = classifyTitle(b.title); dirty = true; }
    if (typeof b.cover === 'undefined') { b.cover = extractCoverFromBook(b); dirty = true; }
    if (dirty) { await putBook(b); changed = true; }
  }
  if (changed) await renderShelf();
}

function mkTagChip(text, active, onClick) {
  const c = document.createElement('button');
  c.className = 'tag-chip' + (active ? ' active' : '');
  c.textContent = text;
  c.addEventListener('click', onClick);
  return c;
}
function mkGroupHeader(text) {
  const h = document.createElement('div');
  h.className = 'group-header';
  h.textContent = text;
  return h;
}
function mkBookRow(books) {
  const wrap = document.createElement('div');
  wrap.className = 'book-list';
  books.forEach((b) => wrap.appendChild(renderBookCard(b)));
  return wrap;
}
// 书架进度百分比：优先用阅读器保存的精确 pct；旧进度数据无 pct 时按已读章节数估算
function shelfProgressPct(b) {
  const prog = getProgress(b.id);
  if (!prog) return 0;
  let pct = (typeof prog.pct === 'number' && isFinite(prog.pct))
    ? prog.pct
    : Math.round((((prog.ci || 0) + 1) / Math.max(1, b.chaptersCount || 1)) * 100);
  return Math.max(0, Math.min(100, Math.round(pct)));
}
function renderBookCard(b) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.dataset.bookId = b.id; // Plus：书架进度环 / 最近阅读角标按 id 挂载
  const coverChar = (b.title || '?').trim().charAt(0) || '?';
  const cat = b.category || '其他';
  const cover = (typeof b.cover === 'string' && /^data:image\//i.test(b.cover)) ? b.cover : '';
  const coverHtml = cover
    ? `<div class="bc-cover has-cover"><img src="${escapeHtml(cover)}" alt="" /></div>`
    : `<div class="bc-cover">${escapeHtml(coverChar)}</div>`;
  const opts = (settings.categories || []).concat(['其他'])
    .map((c) => `<option value="${escapeHtml(c)}"${c === cat ? ' selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');
  card.innerHTML =
    coverHtml +
    `<div class="bc-body">` +
      `<div class="bc-title">${escapeHtml(b.title)}</div>` +
      `<div class="bc-meta">${escapeHtml(b.author || '佚名')} · ${b.chaptersCount} 章</div>` +
      `<select class="bc-cat" data-cat="${b.id}">${opts}</select>` +
    `</div>` +
    `<div class="bc-progress">${shelfProgressPct(b)}%</div>` +
    `<div class="bc-del" data-del="${b.id}">删除</div>`;
  card.addEventListener('click', () => openBook(b.id));
  const del = card.querySelector('.bc-del');
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Nexus 回收站：删前留一份 30 天可恢复的副本，文案也不再宣称「不可恢复」
    if (confirm(`将《${b.title}》移入回收站？30 天内可在「能力中心 → 书架」恢复。`)) {
      if (nexus) { const full = await getBook(b.id); if (full) nexus.onBookDelete(full); }
      await deleteBook(b.id);
      if (activeCategory === cat && !(settings.categories || []).includes(cat)) activeCategory = null;
      renderShelf();
    }
  });
  const sel = card.querySelector('.bc-cat');
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', async (e) => {
    e.stopPropagation();
    const book = await getBook(b.id);
    if (!book) return;
    book.category = sel.value;
    await putBook(book);
    renderShelf();
  });
  return card;
}

async function importBook(book) {
  try {
    if (!book.category) book.category = classifyTitle(book.title);
    if (typeof book.cover === 'undefined') book.cover = extractCoverFromBook(book);
    await putBook(book);
    await renderShelf();
    maybeAutoSummary(book);
    return true;
  } catch (e) {
    // Nexus：按「存储 / 权限 / 文件损坏 / 格式不支持」给出不同动作，不再统一一句「导入失败」
    const c = nexus ? nexus.onImportError(e) : null;
    const msg = c ? ({
      storage: '存储空间不足，请先导出备份再清理回收站',
      permission: '读取被拒绝，请重试或换一个文件',
      corrupt: '文件可能已损坏，请重新选择',
      format: '该格式暂不支持，建议先用 Calibre 转为 EPUB',
      unknown: '导入失败：' + e.message,
    }[c.kind] || '导入失败：' + e.message) : '导入失败：' + e.message;
    alert(msg);
    return false;
  }
}

// 导入后若已配置 AI 且开启自动导读，则在后台静默生成全书导读并缓存到本书（失败不影响阅读）。
function maybeAutoSummary(book) {
  if (!settings.aiAutoSummary || !aiConfigured()) return;
  (async () => {
    try {
      const { summary, guide } = await aiSummary(book, { type: 'book' });
      book.ai = Object.assign({}, book.ai, { summary, guide });
      await putBook(book);
    } catch (e) { /* 自动生成失败静默忽略 */ }
  })();
}

// ---------- 阅读 ----------
function computeMetrics() {
  const vp = $('page-viewport');
  // Plus：横屏双页时按「半栏宽度」分页，而不是先按整屏分页再 CSS 挤压。
  return plus ? plus.pageMetrics(vp.clientWidth, vp.clientHeight)
    : { pageWidth: vp.clientWidth, pageHeight: vp.clientHeight };
}
function settingsHash() {
  // 视口尺寸与主题也进 key：旋转 / 分屏 / 切主题后若沿用旧分页，会出现文字截断或大片留白。
  const vp = $('page-viewport');
  return [
    settings.fontSize, settings.lineHeight, settings.margin, settings.justify,
    settings.letterSpacing, settings.paragraphSpacing, settings.firstLineIndent, settings.fontFamily,
    settings.theme, vp ? vp.clientWidth : 0, vp ? vp.clientHeight : 0,
    plus ? plus.layoutKey() : '1up',
  ].join('|');
}
// 排版变化（字号 / 旋转 / 主题）后按「章内相对位置」保位，而不是生硬 clamp 旧页号。
// 这是 Kindle / Apple Books 位置锚点的轻量等价实现，避免改个字号就跳到别处。
function repaginateKeepAnchor() {
  if (!currentBook || currentBook.source === 'pdf') return;
  const oldN = Math.max(1, pages.length);
  const ratio = oldN > 1 ? pi / (oldN - 1) : 0;
  pageCache.clear();
  paginateCurrentChapter();
  pi = Math.max(0, Math.min(pages.length - 1, Math.round(ratio * (pages.length - 1))));
  renderPage();
  if (pro) pro.refresh();
}
// 进度条拖动：按全书字数百分比定位章与章内页（跨设备、跨字号都稳定）
async function seekByPct(pct) {
  if (!currentBook) return;
  const target = (totalChars || 0) * Math.max(0, Math.min(100, pct)) / 100;
  if (currentBook.source === 'pdf') {
    ci = Math.max(0, Math.min(currentBook.chapters.length - 1,
      Math.round(pct / 100 * (currentBook.chapters.length - 1))));
    pi = 0;
  } else {
    let acc = 0, tci = chapterChars.length - 1;
    for (let i = 0; i < chapterChars.length; i++) {
      if (acc + chapterChars[i] > target || i === chapterChars.length - 1) { tci = i; break; }
      acc += chapterChars[i];
    }
    ci = tci;
    pi = 0;
    paginateCurrentChapter();
    const inCh = chapterChars[ci] ? (target - acc) / chapterChars[ci] : 0;
    pi = Math.max(0, Math.min(pages.length - 1, Math.round(inCh * (pages.length - 1))));
  }
  await renderPage();
  saveProgress(currentBook.id, ci, pi, computeProgressPct());
  buildToc();
}
// 撤销 / 返回跳转前位置：统一走这里，避免各处直接改 ci/pi 造成状态不一致
async function restorePosition(pos) {
  if (!currentBook || !pos) return;
  ci = Math.max(0, Math.min(pos.ci || 0, currentBook.chapters.length - 1));
  pi = Math.max(0, pos.pi || 0);
  paginateCurrentChapter();
  await renderPage();
  saveProgress(currentBook.id, ci, pi, computeProgressPct());
  buildToc();
}

// ---------- Plus 层回调：ci/pi 的改动全部收口在这里，独立模块不直接碰阅读状态 ----------
async function jumpToChapterOrQuote(ciTarget, quote) {
  if (!currentBook) return;
  if (pro) pro.remember(); // 跳转前留一个「返回原位置」
  ci = Math.max(0, Math.min(ciTarget || 0, currentBook.chapters.length - 1));
  pi = 0;
  paginateCurrentChapter();
  if (quote && plus) {
    const found = plus.findPageByQuote(pages, quote);
    if (found >= 0) pi = found;
  }
  await renderPage();
  saveProgress(currentBook.id, ci, pi, computeProgressPct());
  buildToc();
}
async function setBookCover(bookId, dataUrl) {
  const b = await getBook(bookId);
  if (!b) return;
  b.cover = dataUrl;
  await putBook(b);
  if (currentBook && currentBook.id === bookId) currentBook.cover = dataUrl;
  renderShelf();
}
function restoreBooksFromBackup(books) {
  (books || []).forEach((b) => { if (b && b.id) putBook(b); });
  settings = loadSettings();
  applySettings();
  renderShelf();
}
function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  } catch (e) {}
  showToast('已复制');
}
function addExcerptFromText(text) {
  lastSelText = text;   // 复用既有去重 / 落盘 / toast 逻辑，不另写一份
  addFavoriteFromSelection();
}
function paginateCurrentChapter() {
  if (currentBook.source === 'pdf') {
    pages = [''];
    if (pi >= pages.length) pi = pages.length - 1;
    if (pi < 0) pi = 0;
    return;
  }
  const key = ci + ':' + settingsHash();
  if (pageCache.has(key)) {
    pages = pageCache.get(key);
  } else {
    const m = computeMetrics();
    pages = paginateChapter(currentBook.chapters[ci].html, m);
    setPageCache(key, pages);
  }
  if (pi >= pages.length) pi = pages.length - 1;
  if (pi < 0) pi = 0;
}
function computeChapterChars() {
  chapterChars = currentBook.chapters.map((c) => chapterCharCount(c.html));
  totalChars = chapterChars.reduce((a, b) => a + b, 0);
}
function computeProgressPct() {
  let before = 0;
  for (let i = 0; i < ci; i++) before += chapterChars[i];
  const inCh = pages.length ? (pi / Math.max(pages.length, 1)) * (chapterChars[ci] || 0) : 0;
  return totalChars ? ((before + inCh) / totalChars) * 100 : 0;
}
async function renderPage() {
  if (currentBook.source === 'pdf') {
    const targetW = Math.min(
      Math.ceil($('page-viewport').clientWidth * (window.devicePixelRatio || 1) * 1.5),
      1600
    );
    let url = pdfImageCache.get(ci);
    if (!url) {
      try {
        const r = await renderPdfPage(currentPdfDoc, ci, targetW);
        url = r.url;
        pdfImageCache.set(ci, url);
        if (pdfImageCache.size > PDF_CACHE_CAP) {
          const oldest = pdfImageCache.keys().next().value;
          if (oldest !== undefined && oldest !== ci) pdfImageCache.delete(oldest);
        }
      } catch (e) {
        $('page').innerHTML = '<p style="padding:24px">本页渲染失败：' + e.message + '</p>';
        $('chapter-title').textContent = chapterLabel(ci);
        updateProgress();
        return;
      }
    }
    $('page').innerHTML = '<div class="pdfpage"><img src="' + url + '" alt=""></div>';
    $('chapter-title').textContent = chapterLabel(ci);
    document.body.classList.remove('plus-two-up');
    updateProgress();
    if (plus) plus.onPageRendered($('page'));
    return;
  }
  revokePageBlobs(); // 回收上一页创建的图片 blob URL
  const two = !!(plus && plus.isTwoPage());
  document.body.classList.toggle('plus-two-up', two);
  // Plus 横屏双页：pages 本身已按半栏宽度分页，这里并排放相邻两页，不是把整页 CSS 压扁
  $('page').innerHTML = two
    ? '<div class="plus-spread"><div class="plus-col">' + (pages[pi] || '') + '</div>' +
      '<div class="plus-col">' + (pages[pi + 1] || '') + '</div></div>'
    : (pages[pi] || '');
  resolvePageImages();       // 把当页 <img data-img> 占位解析为真实图片（仅当页解码）
  enhanceFootnoteMarkers(); // 分页若丢了 <a>，把裸 [n] 补成可点击脚注标记
  applyHighlights();        // 还原本章已保存的正文标注（跨页/重进都在）
  $('chapter-title').textContent = chapterLabel(ci);
  updateProgress();
  if (plus) plus.onPageRendered($('page')); // Plus：记录文字锚点
}
function updateProgress() {
  const total = pages.length;
  const pct = computeProgressPct();
  $('progress').textContent = `第${ci + 1}/${currentBook.chapters.length}章 · 第${pi + 1}/${total}页 · ${pct.toFixed(0)}%`;
  if (pro) pro.refresh(); // 常驻进度条（控制条隐藏时也看得见）
  if (plus) plus.onProgress({ pct, ci, pi, pages: total, chapterCount: currentBook.chapters.length });
}
function regalFlash() {
  const r = $('reader');
  r.classList.add('regal');
  setTimeout(() => r.classList.remove('regal'), 90);
}
async function afterPageTurn(chapterChanged) {
  await renderPage();
  saveProgress(currentBook.id, ci, pi, computeProgressPct());
  turnCounter++;
  const src = (turn && turn.getState ? turn.getState().lastSource : '') || 'manual';
  if (plus) plus.onTurn({ chapterChanged, source: src });
  // 跨章翻页必须同步目录高亮：以前只在打开书/主动跳转时 buildToc()，
  // 用「下一页」翻进新章节后目录仍高亮旧章，看起来就是「章节和目录对不上」。
  syncTocActive(false);
  const N = settings.regalRefresh;
  const doFlash = plus
    ? plus.shouldRegal(chapterChanged, turnCounter, N, settings.theme, settings.pageFlip)
    : (N > 0 && ((N === 999 && chapterChanged) || (N !== 999 && turnCounter % N === 0)));
  if (doFlash) regalFlash();
}
// 翻书页动画总入口：按当前主题分发到专属翻页效果。
// 全局 *{transition/animation:none!important}（墨水屏零动画原则）下，动画一律靠内联 !important 放行。
async function flipPage(dir, mutate) {
  const page = $('page');
  // 默认零动画分支必须 await：否则 PDF 的异步渲染会并发写 #page.innerHTML，快速连点直接串页。
  if (!settings.pageFlip || !page) { return await mutate(); }
  if (isFlipping) return;
  isFlipping = true;
  try {
    if (settings.theme === 'ink') return await flipInk(dir, mutate);
    return await flipBook(dir, mutate);
  } finally {
    // 动画中任何异常都必须解锁，否则翻页会永久卡死直到重载。
    if (isFlipping) endFlip();
  }
}

// 收尾：清掉翻页期间注入的内联样式，交还零动画原则
function endFlip() {
  const page = $('page');
  page.style.transition = '';
  page.style.transform = '';
  page.style.transformOrigin = '';
  page.style.opacity = '';
  page.style.filter = '';
  page.classList.remove('flipping');
  page.style.removeProperty('--flip-shade');
  isFlipping = false;
}

// ① 墨水风：「一笔过纸 · 墨渗字显」由独立模块 inkflip.js 实现。
// flip-preview.html 直接复用同一份 playInkFlip，保证预览与真机效果完全一致；
// 动画用 Web Animations API 编排（约 700ms，旧版 1950ms），异常时由模块自行清理墨层。
async function flipInk(dir, mutate) {
  await playInkFlip({ viewport: $('page-viewport'), page: $('page'), dir, mutate });
}

// ② 简约：整页水平滑动翻页（参考夸克在线阅读——当前页水平滑出，下一页从对侧滑入）
async function flipBook(dir, mutate) {
  const page = $('page');
  const vp = $('page-viewport');
  if (!page) { mutate(); return; }
  const isNext = dir === 'next';
  const exitTo = isNext ? '-100%' : '100%';    // 当前页滑出方向
  const enterFrom = isNext ? '100%' : '-100%';  // 新页进入方向
  // 克隆当前页（旧内容）作为覆盖层
  const leaf = document.createElement('div');
  leaf.className = 'page flip-leaf slide-leaf';
  leaf.innerHTML = page.innerHTML;
  leaf.style.transition = 'none';
  leaf.style.transform = 'translateX(0)';
  vp.appendChild(leaf);
  // 真实页先置于对侧起始位（藏于 leaf 之下）
  page.style.setProperty('transition', 'none', 'important');
  page.style.transform = `translateX(${enterFrom})`;
  void page.offsetWidth;
  // 换页：真实页渲染新内容
  await mutate();
  // 同步滑动：旧页滑出 + 新页滑入
  const ease = 'transform .36s cubic-bezier(.4,0,.2,1)';
  leaf.style.setProperty('transition', ease, 'important');
  page.style.setProperty('transition', ease, 'important');
  leaf.style.transform = `translateX(${exitTo})`;
  page.style.transform = 'translateX(0)';
  await wait(380);
  leaf.remove();
  endFlip();
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function nextPage() {
  hideTranslate();
  const step = plus ? plus.pageStep() : 1; // Plus 横屏双页：一次推进两栏
  if (pi + step < pages.length) {
    await flipPage('next', async () => { pi += step; await afterPageTurn(false); });
  } else if (ci < currentBook.chapters.length - 1) {
    await flipPage('next', async () => { ci++; pi = 0; paginateCurrentChapter(); await afterPageTurn(true); });
  }
}
async function prevPage() {
  hideTranslate();
  const step = plus ? plus.pageStep() : 1;
  if (pi - step >= 0) {
    await flipPage('prev', async () => { pi -= step; await afterPageTurn(false); });
  } else if (ci > 0) {
    await flipPage('prev', async () => { ci--; paginateCurrentChapter(); pi = Math.max(0, pages.length - step); await afterPageTurn(true); });
  }
}

// jump 形如 { ci, pi }：从「我的」汇总页跳回标注/收藏所在的原文位置
async function openBook(id, jump) {
  if (jump && currentBook && pro) pro.remember(); // 从「我的」跳回原文时保留返回位置
  const book = await getBook(id);
  if (!book) { alert('书籍数据缺失，可能已被删除。'); return; }
  currentBook = book;
  ci = 0; pi = 0; pageCache.clear(); turnCounter = 0; pdfImageCache.clear();
  const prog = getProgress(id);
  if (prog) {
    ci = Math.min(prog.ci || 0, book.chapters.length - 1);
    pi = prog.pi || 0;
  }
  // Plus：按书恢复排版 + 取回上次阅读的文字锚点（跨设备/改字号比 ci/pi 稳）
  const anchorCi = plus ? plus.onOpenBook(book, prog) : null;
  if (anchorCi != null && !jump) ci = Math.max(0, Math.min(anchorCi, book.chapters.length - 1));
  if (jump) {
    ci = Math.max(0, Math.min(jump.ci || 0, book.chapters.length - 1));
    pi = Math.max(0, jump.pi || 0);
  }
  if (book.source === 'pdf') {
    try {
      currentPdfDoc = await openPdf(book.pdfBytes);
    } catch (e) {
      alert('PDF 打开失败：' + e.message);
      return;
    }
    chapterChars = book.chapters.map(() => 1);
    totalChars = chapterChars.length;
    pages = [''];
  } else {
    currentPdfDoc = null;
    computeChapterChars();
  }
  // 从书架/统计/我的/设置任一视图进入都要把其他视图全部收起
  Object.values(VIEW_ID).forEach((vid) => $(vid).classList.add('hidden'));
  $('reader').classList.remove('hidden');
  $('reader').classList.add('hide-chrome');
  document.body.classList.add('reader-active'); // 阅读时隐藏底部导航栏
  closePanels();
  applyKeepScreenOn(); // 进入阅读器：按设置保持屏幕常亮
  // 必须在阅读器可见后再分页：hidden 状态下 #page-viewport 高度为 0，会触发“每页 1 字”极端分支
  if (!currentPdfDoc) {
    paginateCurrentChapter();
    if (plus && !jump) pi = plus.anchorPi(pages, pi); // 文字锚点重定位（找不到则沿用 ci/pi）
    pi = Math.max(0, Math.min(pi, pages.length - 1)); // 排版变化后页号可能越界
  }
  await renderPage();
  if (jump) saveProgress(currentBook.id, ci, pi, computeProgressPct()); // 跳回原文后把位置记下来
  buildToc();
  buildBookmarks();
  startReadingTimer();
  // 进入阅读器：把来源视图压入返回栈（通常为书架）
  if (currentView !== 'reader') navStack.push(currentView);
  currentView = 'reader';
  if (pro) pro.onOpenBook();
}
function exitReader() {
  if (pro) pro.onExit(); // 立即停自动翻页并释放摄像头
  if (plus) plus.onExit(); // Plus：存会话、停 TTS、收起浮层
  revokePageBlobs(); // 退出阅读器：回收当前页图片 blob URL
  hideTranslate();
  stopReadingTimer();
  if (currentPdfDoc) {
    try { currentPdfDoc.destroy(); } catch (e) {}
    currentPdfDoc = null;
    pdfImageCache.clear();
  }
  $('reader').classList.add('hidden');
  document.body.classList.remove('reader-active');
  applyKeepScreenOn(); // 离开阅读器：恢复系统锁屏
  currentBook = null;
  renderShelf();
}

// ---------- 导航与返回栈：书架/统计/设置/法律 为子视图，阅读器为独立层 ----------
const VIEW_ID = { shelf: 'shelf', stats: 'view-stats', mine: 'view-mine', settings: 'view-settings', legal: 'view-legal' };
let navStack = [];        // 视图历史（不含当前）
let currentView = 'shelf'; // 当前视图
let lastBackTs = 0;       // 根视图"双击退出"计时

// 仅显示某个子视图（书架/统计/设置/法律），隐藏阅读器
function showSubView(v) {
  const target = VIEW_ID[v];
  ['shelf', 'view-stats', 'view-mine', 'view-settings', 'view-legal'].forEach((id) => $(id).classList.toggle('hidden', id !== target));
  document.querySelectorAll('#tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  $('reader').classList.add('hidden'); // 从阅读器切回任意子视图时都要收起阅读层
  document.body.classList.remove('reader-active');
  applyKeepScreenOn(); // 从阅读器切到子视图：恢复系统锁屏
}
// 导航到子视图：forward 时压栈；fromBack 不压栈；reset 清空历史（底部 Tab 切换用）
function showView(v, opts = {}) {
  if (opts.reset) navStack = [];
  if (!opts.fromBack && v !== currentView) navStack.push(currentView);
  currentView = v;
  showSubView(v);
  if (v === 'stats') {
    // 每次从 Tab 进入统计页都回到「日」，按钮高亮必须与真实 mode 一致，
    // 否则上次看的「月」内容会被重置、按钮却还亮着，属于明显的状态谎言。
    document.querySelectorAll('.stats-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.statsTab === 'day'));
    renderStats('day');
  }
  if (v === 'mine') renderMine();
}
// 返回上一视图：阅读器单独处理（含清理）；根视图双击退出（主流 App 做法）
function goBack() {
  if (currentView === 'reader') {
    exitReader();
    const prev = navStack.length ? navStack.pop() : 'shelf';
    currentView = prev; showSubView(prev);
    return;
  }
  if (navStack.length) {
    const prev = navStack.pop();
    currentView = prev; showSubView(prev);
  } else {
    handleRootBack();
  }
}
function handleRootBack() {
  const now = Date.now();
  if (now - lastBackTs < 2000) {
    const app = capacitorApp();
    if (app) { try { app.exitApp(); } catch (e) {} }
  } else {
    lastBackTs = now;
    showToast('再按一次退出');
  }
}

// ---------- 法律声明：隐私政策 / 用户协议 / 权限说明 ----------
function openLegal(which) {
  const doc = LEGAL_CONTENT[which] || LEGAL_CONTENT.privacy;
  showView('legal');
  $('legal-title').textContent = doc.title;
  $('legal-body').innerHTML = doc.html;
  document.querySelectorAll('.legal-tab').forEach((t) => t.classList.toggle('active', t.dataset.legal === which));
}

// 首次启动隐私政策弹窗（js/privacy-consent.js，普通同步脚本）复用这里的全文。
// 只暴露只读引用，不新增文案副本，保证五份法律文案仍是唯一真源。
window.__INK_LEGAL__ = { content: LEGAL_CONTENT, open: openLegal };

// ---------- 面板 ----------
function openPanel(id) {
  hideTranslate();
  closePanels();
  $(id).classList.add('open');
  $('panel-mask').classList.add('open');
  // 长书打开目录时把当前章滚到可视区，否则高亮项在屏幕外，用户会以为「对不上」
  if (id === 'panel-toc') syncTocActive(true);
}
function closePanels() {
  document.querySelectorAll('.panel.open').forEach((p) => p.classList.remove('open'));
  $('panel-mask').classList.remove('open');
}
// 屏幕常亮联动：仅在「阅读器激活 + 设置开启」时对原生 Android 接口请求保持屏幕常亮；
// 其余页面（书架/统计/设置/我的/法律）或关闭开关时恢复系统锁屏。
// window.AndroidScreenOn 仅由 Android 原生 WebView 注入，桌面/PWA/iOS 下为 undefined，自动跳过。
function applyKeepScreenOn() {
  if (!window.AndroidScreenOn) return;
  const on = document.body.classList.contains('reader-active') && loadSettings().keepScreenOn !== false;
  window.AndroidScreenOn.setKeepScreenOn(on);
}

// ---------- 选中文字翻译 ----------
let lastSelText = '';
let lastSelRange = null; // 选中时的 Range 快照：点工具条按钮时选区可能已被收起
function hideTranslate() {
  $('sel-bar').classList.add('hidden');
  $('translate-pop').classList.add('hidden');
  $('ai-explain-pop').classList.add('hidden');
  $('footnote-pop').classList.add('hidden');
  $('hl-pop').classList.add('hidden');
}
// ---------- 脚注 ----------
// 实测 5 本真实 EPUB 后归纳出的三种脚注形态：
//  A 同文件： 正文 <a href="#m1" id="w1">[1]</a>
//             注释 <p class="footnote"><a href="#w1" id="m1">[1]</a> 注释文本……</p>
//  B 跨文件： 正文 <a id="w28" href="../Text/chapter91.xhtml#m28"><span class="note">[28]</span></a>
//             注释 <p class="footnote"><a id="m28" href="../Text/chapter87.xhtml#w28">[28]</a> 注释文本……</p>
//             m28 / w28 这类 id 在全书重复十几次，必须按 href 里的目标文件名定位章节。
//  C 图片标记：<a class="duokan-footnote" href="#ref_footnotebookmark_end_10_1"><img alt="注释"></a>
//             注释 <li class="duokan-footnote-item" id="ref_footnotebookmark_end_10_1"><p>…</p></li>
// 两个坑：
//  1) 目标 id 只落在「编号 <a>」上，注释文本在父容器里，只取该 <a> 会得到 "[1]" 看似空白。
//  2) 站内相对链接若不 preventDefault，WebView 会去加载 ../Text/chapter91.xhtml 这个
//     包内并不存在的本地文件，整页直接变白 —— 这正是「点击数字后空白」的真正原因。
//  另：分页器 splitBlock 对超长段落按纯文本重建会丢掉 <a>，故对裸 [n] 做 .fn-marker 兜底包装。

// 在任意 DOM 子树内按 id 精确查找（避免 querySelector 对特殊字符 id 的转义问题）
function findByIdIn(root, id) {
  if (!root || !id) return null;
  const nodes = root.querySelectorAll('[id]');
  for (const n of nodes) if (n.id === id) return n;
  return null;
}
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}
function basenameOf(p) {
  const s = String(p || '').replace(/\\/g, '/').split('#')[0];
  const parts = s.split('/');
  return safeDecode(parts[parts.length - 1] || '').toLowerCase();
}
function chapterBase(ch) {
  return basenameOf((ch && (ch.src || ch.href)) || '');
}
// 拆站内 href -> { path, file, id }；外链（http/mailto/javascript）返回 null
function parseFootnoteHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  const hash = raw.indexOf('#');
  const path = hash >= 0 ? raw.slice(0, hash) : '';
  const id = hash >= 0 ? safeDecode(raw.slice(hash + 1)).trim() : '';
  return { raw, path, file: path ? basenameOf(path) : '', id };
}
// 全书 id -> [章节下标] 索引；只建一次，用正则扫原始 HTML，避免逐章 DOM 解析拖慢首点
const fnIndexCache = { bookId: null, ids: null, chs: null, bases: null };
function footnoteIndex() {
  const bookId = (currentBook && currentBook.id) || '';
  if (fnIndexCache.bookId === bookId && fnIndexCache.ids) return fnIndexCache;
  const chs = (currentBook && currentBook.chapters) || [];
  const ids = new Map();
  const bases = [];
  chs.forEach((ch, i) => {
    bases[i] = chapterBase(ch);
    const html = ch.html || '';
    const seen = new Set();
    // 只认真正的 id 属性，避免把 xml:id / data-id 之类误收入索引
    const re = /(?:^|\s)id\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!ids.has(id)) ids.set(id, []);
      ids.get(id).push(i);
    }
  });
  fnIndexCache.bookId = bookId;
  fnIndexCache.ids = ids;
  fnIndexCache.chs = chs;
  fnIndexCache.bases = bases;
  return fnIndexCache;
}
let fnChapterCache = { bookId: null, map: new Map() };
function parseChapterEl(i) {
  const idx = footnoteIndex();
  if (fnChapterCache.bookId !== idx.bookId) {
    fnChapterCache = { bookId: idx.bookId, map: new Map() };
  }
  let el = fnChapterCache.map.get(i);
  if (!el) {
    el = document.createElement('div');
    el.innerHTML = (idx.chs[i] && idx.chs[i].html) || '';
    if (fnChapterCache.map.size >= 8) {
      const oldest = fnChapterCache.map.keys().next().value;
      fnChapterCache.map.delete(oldest);
    }
    fnChapterCache.map.set(i, el);
  }
  return el;
}
// 选目标章节：新导入的书按 src 文件名精确匹配；旧书（无 src）用「同编号注释里
// 第一个不早于当前章的」——对 5 本真实书 2124 个脚注样本验证 100% 命中。
function pickTargetChapter(id, fileHint) {
  const idx = footnoteIndex();
  const list = (idx.ids && idx.ids.get(id)) || [];
  if (!list.length) return -1;
  if (fileHint) {
    const hit = list.filter((i) => idx.bases[i] === fileHint);
    if (hit.length) return hit[0];
  }
  const ge = list.filter((i) => i >= ci);
  return ge.length ? Math.min.apply(null, ge) : list[list.length - 1];
}
function classOf(el) {
  const c = el && el.className;
  return String((c && c.baseVal) || c || '').toLowerCase();
}
function isFootnoteBlock(el) {
  if (!el) return false;
  const et = el.getAttribute ? (el.getAttribute('epub:type') || '') : '';
  return /(foot|note|endnote|annotation)/.test(classOf(el)) || /footnote|endnote|rearnote/.test(et);
}
// 从「编号 <a>」找脚注容器：目标元素本身可能就是 <li class="...footnote-item">（如多看 EPUB）
function findFootnoteContainer(el) {
  if (!el) return null;
  if (isFootnoteBlock(el) && (el.textContent || '').trim().length > 6) return el;
  const own = ((el && el.textContent) || '').trim();
  let cur = el && el.parentElement;
  for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
    if (isFootnoteBlock(cur)) return cur;
    const raw = (cur.textContent || '').trim();
    if (/^(p|li|div|aside|section|td)$/i.test(cur.tagName || '') &&
        raw.length > own.length + 6 && raw.length < 1200) return cur;
  }
  return el;
}
// 取容器全文：剔除「返回正文」回链与开头编号，避免把 "[1]" 当成注释内容
function cleanFootnoteText(el) {
  if (!el) return null;
  const clone = el.cloneNode(true);
  clone.querySelectorAll('a').forEach((a) => {
    const t = (a.textContent || '').trim();
    const symbolic = /^[\u2190\u21a9\u21e7\u2191\u21e0\u2934\u21b5*\u2020\u2021]+$/.test(t);
    const backCls = /back|return/i.test(classOf(a));
    const leadingNum = /^\[?\d{1,3}\]?$/.test(t) && a === clone.firstElementChild;
    if (symbolic || backCls || leadingNum) a.remove();
  });
  let text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^\[\d{1,3}\]\s*/, '').replace(/^\d{1,3}[.、]\s*/, '').trim();
  return text || null;
}
function isJustMarker(text, marker) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 6 && /^\[?\d{1,3}\]?[.、]?$/.test(t)) return true;
  if (marker && t === marker.trim()) return true;
  return false;
}
// 兜底：按标记编号在章节 HTML 的脚注容器里找注释（应对分页丢 <a> / 目标只有编号）
// 优先目标文件对应章节，再按「当前章及之后」顺序找，避免取到别的章的同号注释
function resolveFootnoteByNumber(num, fileHint) {
  if (!num || !currentBook || !currentBook.chapters) return null;
  const idx = footnoteIndex();
  const order = [];
  if (fileHint) idx.chs.forEach((ch, i) => { if (idx.bases[i] === fileHint) order.push(i); });
  for (let i = ci; i < idx.chs.length; i++) if (order.indexOf(i) < 0) order.push(i);
  for (let i = 0; i < ci; i++) if (order.indexOf(i) < 0) order.push(i);
  const re = new RegExp('^\\[?' + num + '\\]?(?:[.、\\s]|$)');
  for (const j of order) {
    const tmp = parseChapterEl(j);
    const cands = Array.from(tmp.querySelectorAll('p, li, div, aside, section')).filter(isFootnoteBlock);
    for (const el of cands) {
      if (cands.some((o) => o !== el && el.contains(o))) continue; // 只取叶子脚注块
      if (!re.test((el.textContent || '').trim())) continue;
      const text = cleanFootnoteText(el);
      if (text && !isJustMarker(text)) return text;
    }
  }
  return null;
}
// 裸 [n] 标记：从本章原始 HTML 里找回被分页丢掉的 href（含目标文件名，跨文件也能定位）
function findHrefForMarker(num) {
  const idx = footnoteIndex();
  const ch = idx.chs[ci];
  if (!ch) return '';
  const tmp = parseChapterEl(ci);
  const want = '[' + num + ']';
  const links = Array.from(tmp.querySelectorAll('a[href]')).filter((a) => {
    const t = (a.textContent || '').trim();
    return t === want || t === String(num);
  });
  for (const a of links) {
    const info = parseFootnoteHref(a.getAttribute('href'));
    if (info && info.id) return a.getAttribute('href');
  }
  return links.length ? (links[0].getAttribute('href') || '') : '';
}
// 主解析：先按 href 的文件名+id 锁定章节，再上溯脚注容器取全文；最后按编号兜底
function resolveFootnote(href, markerText) {
  const info = parseFootnoteHref(href);
  const label = (markerText || '').trim();
  const num = (label.match(/^\[?(\d{1,3})\]?$/) || [])[1] || null;
  const id = info && info.id;
  const file = (info && info.file) || '';
  if (id) {
    const targetCi = pickTargetChapter(id, file);
    if (targetCi >= 0) {
      const el = findByIdIn(parseChapterEl(targetCi), id);
      if (el) {
        const text = cleanFootnoteText(findFootnoteContainer(el));
        if (!isJustMarker(text, label)) return text;
      }
    }
    const live = findByIdIn(document, id);
    if (live) {
      const text = cleanFootnoteText(findFootnoteContainer(live));
      if (!isJustMarker(text, label)) return text;
    }
  }
  if (num) return resolveFootnoteByNumber(num, file);
  return null;
}
function showFootnote(text, ref) {
  $('footnote-ref').textContent = ref ? '· ' + ref : '';
  $('footnote-text').textContent = text;
  $('footnote-pop').classList.remove('hidden');
}
// 把分页后残留的裸 [n] 标记包成可点击元素（splitBlock 会丢 <a>）
function enhanceFootnoteMarkers() {
  const page = $('page');
  if (!page) return;
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !/\[\d{1,3}\]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== page) {
        if (/^(A|BUTTON|SELECT|TEXTAREA)$/.test(p.tagName) || p.classList.contains('fn-marker')) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((n) => {
    const frag = document.createDocumentFragment();
    const src = n.nodeValue;
    let last = 0, m;
    const re = /\[(\d{1,3})\]/g;
    while ((m = re.exec(src))) {
      frag.appendChild(document.createTextNode(src.slice(last, m.index)));
      const s = document.createElement('span');
      s.className = 'fn-marker';
      s.dataset.fn = m[1];
      s.textContent = m[0];
      frag.appendChild(s);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(src.slice(last)));
    n.parentNode.replaceChild(frag, n);
  });
}
// 非脚注的站内链接（目录 part0007.html#a008 等）：同样必须 preventDefault，
// 否则 WebView 会去加载包内不存在的本地文件导致白屏；顺手把它变成真正的跳章。
async function jumpToInternalTarget(info) {
  if (!info || !currentBook || currentBook.source === 'pdf') return;
  const idx = footnoteIndex();
  let target = info.file ? idx.bases.indexOf(info.file) : -1;
  if (target < 0 && info.id) {
    const list = (idx.ids && idx.ids.get(info.id)) || [];
    if (list.length) target = list[0];
  }
  if (target < 0) { showToast('无法定位该链接对应的章节'); return; }
  ci = target; pi = 0;
  paginateCurrentChapter();
  await afterPageTurn(true);
  closePanels();
}
function initFootnoteLinks() {
  const page = $('page');
  if (!page) return;
  // 事件委托：#page 元素本身常驻，内部 html 每页替换，委托可一直生效
  page.addEventListener('click', async (e) => {
    const t = e.target;
    // 点已标注的高亮 -> 打开「删除 / 收藏这句」小弹层，优先于脚注与翻页
    const hl = t.closest && t.closest('mark.ink-hl');
    if (hl) {
      e.preventDefault();
      e.stopPropagation();
      openHighlightPop(hl.dataset.hid);
      return;
    }
    const marker = t.closest && t.closest('.fn-marker');
    const a = t.closest && t.closest('a[href]');
    if (!marker && !a) return;
    const href = a ? (a.getAttribute('href') || '') : '';
    const info = a ? parseFootnoteHref(href) : null;
    if (a && !info) {
      // 书内外部链接：既不导航离开应用（WebView 会丢失阅读状态），也不冒泡误触发翻页。
      // 同时兑现「本地优先、零追踪」承诺——不主动向外发起任何请求。
      e.preventDefault();
      e.stopPropagation();
      showToast('已拦截书内外部链接（本地阅读不联网）');
      return;
    }
    const imgAlt = a && a.querySelector('img[alt]') ? a.querySelector('img[alt]').getAttribute('alt') : '';
    const label = ((marker || a).textContent || '').trim() || (imgAlt || '');
    const looksLikeMarker = /^\[?\d{1,3}\]?$/.test(label) ||
      /^[\*\u2020\u2021\u2022]+$/.test(label) || /\[\d{1,3}\]/.test(label);
    const semantic = a && (
      /(foot|note|ref|endnote|annotation)/.test(classOf(a)) ||
      /noteref|footnote/i.test(a.getAttribute('epub:type') || '') ||
      !!a.querySelector('img[alt*="注"]')
    );
    const noteish = info && /^(?:m|fn|n)\d|footnote|noteref|footnotebookmark/i.test(info.id);
    const isFootnote = !!marker || looksLikeMarker || semantic || noteish;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到 page-viewport 触发翻页/收起栏
    if (!isFootnote) {
      await jumpToInternalTarget(info);
      return;
    }
    hideTranslate();
    let targetHref = href;
    if (marker) {
      const n = marker.dataset.fn || (label.match(/\d{1,3}/) || [])[0] || '';
      targetHref = findHrefForMarker(n);
    }
    const text = resolveFootnote(targetHref, label);
    // 即使没找到也给出明确提示，绝不「点击后空白」
    showFootnote(text || '本书未找到该脚注的注释内容。', label || '注释');
  });
  $('footnote-close').addEventListener('click', hideTranslate);
}

function translateProviderLabel(p) {
  return ({ none: '关闭', mock: '演示', deepl: 'DeepL', google: 'Google', llm: 'AI' })[p] || p;
}
function updateTranslateFieldsVisibility() {
  const p = settings.translateProvider;
  const showKey = p === 'deepl' || p === 'google' || p === 'llm';
  const showBase = p === 'llm';
  $('field-tkey').style.display = showKey ? '' : 'none';
  $('field-tbase').style.display = showBase ? '' : 'none';
}
function selectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}
function showSelBar(rect) {
  const bar = $('sel-bar');
  const r = $('reader').getBoundingClientRect();
  // 固定在底部居中、刚好在底栏之上，避免压住选中文字（墨水屏上压字尤其碍眼）
  bar.style.top = '';
  bar.style.bottom = '52px';
  // 必须先显示再量宽度：隐藏时 offsetWidth=0，4 个按钮会被偏到右侧
  bar.classList.remove('hidden');
  const w = bar.offsetWidth || 0;
  bar.style.left = Math.max(8, Math.min(r.width - w - 8, r.width / 2 - w / 2)) + 'px';
}
function onSelectEnd(e) {
  // 点工具条/标注弹层按钮的那次 mouseup 也会冒泡到 document；跳过它，
  // 否则刚收起的工具条会因为选区还在而被立刻重新弹出来。
  const tgt = e && e.target;
  if (tgt && tgt.closest && (tgt.closest('#sel-bar') || tgt.closest('#hl-pop'))) return;
  const pop = $('translate-pop');
  const epop = $('ai-explain-pop');
  const fpop = $('footnote-pop');
  const hpop = $('hl-pop');
  if (!pop.classList.contains('hidden') || !epop.classList.contains('hidden') ||
      !fpop.classList.contains('hidden') || !hpop.classList.contains('hidden')) return; // 弹层开着时不抢焦点
  if ($('reader').classList.contains('hidden')) { hideTranslate(); lastSelText = ''; lastSelRange = null; return; }
  const sel = window.getSelection();
  const t = (sel && sel.toString().trim()) || '';
  if (!t) { hideTranslate(); lastSelText = ''; lastSelRange = null; return; }
  lastSelText = t;
  try { lastSelRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null; } catch (e) { lastSelRange = null; }
  const rect = selectionRect();
  if (!rect) { hideTranslate(); return; }
  // 选中的一段若已标注，工具条直接变成「取消标注」
  const marked = currentBook && hasEntry(loadHighlights(), currentBook.id, normText(t));
  $('sel-highlight').textContent = marked ? '取消标注' : '标注';
  showSelBar(rect);
}
async function doTranslate(text) {
  const pop = $('translate-pop');
  $('sel-bar').classList.add('hidden');
  pop.classList.remove('hidden');
  $('translate-dir').textContent = '翻译中…';
  $('translate-result').textContent = '';
  $('translate-swap').classList.add('hidden');
  $('translate-copy').classList.add('hidden');
  const opts = {
    provider: settings.translateProvider,
    apiKey: settings.translateApiKey,
    llmBaseUrl: settings.translateLlmBase,
    llmModel: settings.translateLlmModel,
    dir: settings.translateDir,
  };
  try {
    const res = await translateText(text, opts);
    $('translate-dir').textContent =
      (res.from === 'zh' ? '中' : '英') + ' → ' + (res.to === 'zh' ? '中' : '英') + ' · ' + translateProviderLabel(res.provider);
    $('translate-result').textContent = res.text;
    $('translate-swap').classList.remove('hidden');
    $('translate-copy').classList.remove('hidden');
  } catch (e) {
    $('translate-dir').textContent = '翻译失败';
    $('translate-result').textContent = e.message;
  }
}
function initTranslateSelection() {
  document.addEventListener('mouseup', (e) => setTimeout(() => onSelectEnd(e), 0));
  document.addEventListener('touchend', (e) => setTimeout(() => onSelectEnd(e), 0));
  $('sel-translate').addEventListener('click', () => { if (lastSelText) doTranslate(lastSelText); });
  $('sel-ai').addEventListener('click', () => { if (lastSelText) doExplain(lastSelText); });
  $('sel-highlight').addEventListener('click', addHighlightFromSelection);
  $('sel-favorite').addEventListener('click', addFavoriteFromSelection);
  $('hl-close').addEventListener('click', hideTranslate);
  $('hl-del').addEventListener('click', deleteActiveHighlight);
  $('hl-fav').addEventListener('click', favoriteActiveHighlight);
  $('translate-close').addEventListener('click', hideTranslate);
  $('ai-explain-close').addEventListener('click', hideTranslate);
  $('translate-copy').addEventListener('click', () => {
    const t = $('translate-result').textContent;
    if (t && navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
  });
  $('translate-swap').addEventListener('click', () => {
    const t = $('translate-result').textContent;
    if (t) doTranslate(t); // 对译文再译一次（自动识别语言即反向）
  });
}

// 选中即问：调用 AI 解释选中内容，结果展示在独立弹层
async function doExplain(text) {
  const pop = $('ai-explain-pop');
  $('sel-bar').classList.add('hidden');
  if (!aiConfigured()) {
    pop.classList.remove('hidden');
    $('ai-explain-text').innerHTML =
      '<p class="empty-tip">尚未配置 AI 引擎。请到「阅读设置 → AI 引擎」选择「AI 大模型」并填写 API Key。</p>';
    return;
  }
  pop.classList.remove('hidden');
  $('ai-explain-text').textContent = 'AI 思考中…';
  try {
    const ctx = currentBook ? await buildBookContext(currentBook, 2500) : '';
    const out = await aiExplain(text, currentBook, ctx);
    $('ai-explain-text').textContent = out;
  } catch (e) {
    $('ai-explain-text').textContent = e.message;
  }
}

// 取书籍摘要文本作为解释/问答的上下文（复用 ai.js 的 buildDigest 思路，这里轻量实现避免循环依赖）
async function buildBookContext(book, budget) {
  const titles = book.chapters.map((c) => c.title || '').filter(Boolean).join(' / ');
  let text = '';
  for (const ch of book.chapters) {
    if (text.length >= budget) break;
    const d = document.createElement('div');
    d.innerHTML = ch.html || '';
    const t = (d.textContent || '').replace(/\s+/g, ' ').trim();
    text += (text ? '\n' : '') + (ch.title ? '【' + ch.title + '】' : '') + t.slice(0, Math.max(0, budget - text.length - 40));
  }
  return '目录：' + titles + '\n\n正文摘录：\n' + text;
}
// 目录项与阅读页顶部共用同一个「序号 · 标题」，避免章节重名/标题为空时对不上
function chapterLabel(i) {
  const c = currentBook && currentBook.chapters[i];
  return String(i + 1).padStart(2, '0') + ' · ' + ((c && c.title) || `第 ${i + 1} 节`);
}
// 只同步高亮与滚动，不整表重建：跨章翻页时不会丢失目录滚动位置
function syncTocActive(scroll) {
  const list = $('toc-list');
  if (!list || !currentBook) return;
  let active = null;
  list.querySelectorAll('.toc-item').forEach((el) => {
    const on = Number(el.dataset.ci) === ci;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    if (on) active = el;
  });
  if (scroll && active && $('panel-toc').classList.contains('open')) {
    try { active.scrollIntoView({ block: 'center' }); } catch (e) {}
  }
}
function buildToc() {
  const list = $('toc-list');
  list.innerHTML = '';
  currentBook.chapters.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'toc-item' + (i === ci ? ' active' : '');
    d.dataset.ci = String(i);
    d.textContent = chapterLabel(i);
    if (i === ci) d.setAttribute('aria-current', 'true');
    d.addEventListener('click', () => {
      if (pro) pro.remember(); // 记下跳转前位置，可一键返回
      ci = i; pi = 0;
      paginateCurrentChapter();
      closePanels();
      afterPageTurn(true); // 内部会同步目录高亮，不要再手动改 ci
    });
    list.appendChild(d);
  });
  syncTocActive(false);
}
function buildBookmarks() {
  const map = loadBookmarks();
  const list = map[currentBook.id] || [];
  const el = $('bookmark-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<p class="empty-tip">暂无书签。点上方「标记当前页」记录此处。</p>';
    return;
  }
  list.forEach((bm, idx) => {
    const d = document.createElement('div');
    d.className = 'bm-item';
    d.innerHTML = `<span>${escapeHtml(bm.label)}</span><span class="bm-del" data-i="${idx}">删</span>`;
    d.addEventListener('click', (e) => {
      if (e.target.dataset.i !== undefined) return;
      if (pro) pro.remember();
      ci = bm.ci; pi = bm.pi;
      paginateCurrentChapter();
      closePanels();
      afterPageTurn(true);
    });
    d.querySelector('.bm-del').addEventListener('click', (e) => {
      e.stopPropagation();
      const m = loadBookmarks();
      (m[currentBook.id] || []).splice(idx, 1);
      saveBookmarks(m);
      buildBookmarks();
    });
    el.appendChild(d);
  });
}
function addBookmark() {
  const m = loadBookmarks();
  if (!m[currentBook.id]) m[currentBook.id] = [];
  const label = `第${ci + 1}章 · 第${pi + 1}页`;
  m[currentBook.id].push({ ci, pi, label, at: Date.now() });
  saveBookmarks(m);
  buildBookmarks();
}

// ---------- 正文标注 / 收藏语句 ----------
// 标注 = 选中文字在正文里持久高亮；收藏 = 把选中句子存进书单，不改动正文。
// 两者都按 bookId 存 localStorage，记录 ci/pi 用于「我的」页跳回原文；
// 还原高亮时不依赖页号（改字号后分页会变），只按章节 + 文本在当前页里找匹配。
function normText(s) {
  return String(s || '').replace(/[\s\u200b\ufeff]+/g, ' ').trim();
}
function newEntryId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}
function entriesOf(map, bookId) {
  return (map && map[bookId]) || [];
}
function hasEntry(map, bookId, text) {
  return entriesOf(map, bookId).some((it) => it.text === text);
}
function pushEntry(map, bookId, entry) {
  if (!map[bookId]) map[bookId] = [];
  map[bookId].push(entry);
  return map;
}
function removeEntry(map, bookId, id) {
  map[bookId] = entriesOf(map, bookId).filter((x) => x.id !== id);
  if (!map[bookId].length) delete map[bookId];
  return map;
}

// 把当前选区按文本节点切段包进 <mark>，避免跨元素选区 surroundContents 抛错
function markSelection(range, id) {
  const root = $('page');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let n;
  while ((n = walker.nextNode())) {
    try { if (!range.intersectsNode(n)) continue; } catch (e) { continue; }
    let start = 0, end = n.nodeValue.length;
    if (n === range.startContainer) start = range.startOffset;
    if (n === range.endContainer) end = range.endOffset;
    if (end > start) parts.push({ n, start, end });
  }
  let ok = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    try {
      const r = document.createRange();
      r.setStart(p.n, p.start);
      r.setEnd(p.n, p.end);
      const m = document.createElement('mark');
      m.className = 'ink-hl';
      m.dataset.hid = id;
      r.surroundContents(m);
      ok = true;
    } catch (e) {}
  }
  return ok;
}
// 建立「归一化页面文本 -> 原始 (文本节点, 偏移)」映射，用来在任意分页结果里定位一段文字
function buildPageTextIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== root) {
        if (/^(MARK|SCRIPT|STYLE|SELECT|TEXTAREA)$/.test(p.tagName || '')) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let norm = '', pendingSpace = false;
  const chars = [];
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/[\s\u200b\ufeff]/.test(c)) {
        if (norm && !pendingSpace) { norm += ' '; chars.push({ node: n, offset: i }); }
        pendingSpace = true;
      } else {
        norm += c;
        chars.push({ node: n, offset: i });
        pendingSpace = false;
      }
    }
  }
  return { norm, chars };
}
// 在当前页里找到 text 并高亮（已有的 <mark> 会被跳过，故同页重复文本可逐条叠加）
function wrapMatch(id, text) {
  const q = normText(text);
  if (!q) return false;
  const { norm, chars } = buildPageTextIndex($('page'));
  const idx = norm.indexOf(q);
  if (idx < 0) return false;
  const slice = chars.slice(idx, idx + q.length);
  if (slice.length !== q.length) return false;
  const groups = [];
  slice.forEach((c) => {
    const last = groups[groups.length - 1];
    if (last && last.node === c.node) {
      last.start = Math.min(last.start, c.offset);
      last.end = Math.max(last.end, c.offset + 1);
    } else {
      groups.push({ node: c.node, start: c.offset, end: c.offset + 1 });
    }
  });
  let ok = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    try {
      const r = document.createRange();
      r.setStart(g.node, g.start);
      r.setEnd(g.node, g.end);
      const m = document.createElement('mark');
      m.className = 'ink-hl';
      m.dataset.hid = id;
      r.surroundContents(m);
      ok = true;
    } catch (e) {}
  }
  return ok;
}
function applyHighlights() {
  if (!currentBook || currentBook.source === 'pdf') return;
  const list = entriesOf(loadHighlights(), currentBook.id).filter((h) => h.ci === ci);
  // 同一页的优先还原，其次同章其它页（改字号导致页号漂移时仍能命中）
  list.sort((a, b) => (a.pi === pi ? 0 : 1) - (b.pi === pi ? 0 : 1));
  list.forEach((h) => wrapMatch(h.id, h.text));
}
function addHighlightFromSelection() {
  if (!currentBook || !lastSelText) return;
  const text = normText(lastSelText);
  if (!text) return;
  const map = loadHighlights();
  // 再选同一段文字 = 取消标注（切换语义，避免唯一入口只能加不能删）
  const exist = entriesOf(map, currentBook.id).find((h) => h.text === text);
  if (exist) {
    saveHighlights(removeEntry(map, currentBook.id, exist.id));
    hideTranslate();
    renderPage();
    showToast('已取消标注');
    return;
  }
  const id = newEntryId('hl');
  saveHighlights(pushEntry(map, currentBook.id, { id, text, ci, pi, at: Date.now() }));
  const marked = lastSelRange ? markSelection(lastSelRange, id) : false;
  if (!marked) wrapMatch(id, text);
  hideTranslate();
  showToast('已标注');
}
function addFavoriteFromSelection() {
  if (!currentBook || !lastSelText) return;
  const text = normText(lastSelText);
  if (!text) return;
  const map = loadFavorites();
  if (hasEntry(map, currentBook.id, text)) { hideTranslate(); showToast('这句已收藏过'); return; }
  saveFavorites(pushEntry(map, currentBook.id, {
    id: newEntryId('fv'), text, ci, pi, at: Date.now(),
  }));
  hideTranslate();
  showToast('已收藏');
}
let activeHlId = null;
function openHighlightPop(hid) {
  if (!currentBook) return;
  const h = entriesOf(loadHighlights(), currentBook.id).find((x) => x.id === hid);
  if (!h) return;
  activeHlId = hid;
  $('hl-text').textContent = h.text;
  hideTranslate();
  $('hl-pop').classList.remove('hidden');
}
function deleteActiveHighlight() {
  if (!currentBook || !activeHlId) return;
  saveHighlights(removeEntry(loadHighlights(), currentBook.id, activeHlId));
  activeHlId = null;
  hideTranslate();
  renderPage();
  showToast('已删除标注');
}
function favoriteActiveHighlight() {
  if (!currentBook || !activeHlId) return;
  const h = entriesOf(loadHighlights(), currentBook.id).find((x) => x.id === activeHlId);
  if (!h) return;
  const map = loadFavorites();
  if (!hasEntry(map, currentBook.id, h.text)) {
    saveFavorites(pushEntry(map, currentBook.id, {
      id: newEntryId('fv'), text: h.text, ci: h.ci, pi: h.pi, at: Date.now(),
    }));
  }
  hideTranslate();
  showToast('已收藏这句');
}

// ---------- 「我的」：按书汇总标注与收藏 ----------
let mineFilter = 'all';
async function renderMine() {
  const metas = await listBooksMeta();
  const titleOf = {};
  metas.forEach((m) => { titleOf[m.id] = m.title; });
  const groups = new Map();
  const collect = (type, map) => {
    Object.keys(map || {}).forEach((bid) => entriesOf(map, bid).forEach((it) => {
      if (!groups.has(bid)) groups.set(bid, []);
      groups.get(bid).push({ ...it, type, bookId: bid, title: titleOf[bid] || '（已删除的书）' });
    }));
  };
  collect('highlight', loadHighlights());
  collect('favorite', loadFavorites());
  let books = Array.from(groups.entries()).map(([bid, items]) => [bid,
    mineFilter === 'all' ? items : items.filter((i) => i.type === mineFilter)]);
  books = books.filter(([, items]) => items.length);
  const latest = (items) => items.reduce((m, i) => Math.max(m, i.at || 0), 0);
  books.sort((a, b) => latest(b[1]) - latest(a[1]));
  const el = $('mine-list');
  el.innerHTML = '';
  const total = books.reduce((s, [, items]) => s + items.length, 0);
  $('mine-summary').textContent = total ? `共 ${books.length} 本书 · ${total} 条记录` : '';
  if (!books.length) {
    el.innerHTML = '<p class="empty-tip">还没有标注或收藏。<br/>阅读时选中一段文字，点「标注」或「收藏」就能记下来。</p>';
    return;
  }
  books.forEach(([bid, items]) => {
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    const box = document.createElement('div');
    box.className = 'mine-book';
    const hn = items.filter((i) => i.type === 'highlight').length;
    const fn = items.length - hn;
    const head = document.createElement('div');
    head.className = 'mine-book-head';
    head.innerHTML = `<span class="mine-book-title">${escapeHtml(items[0].title)}</span>` +
      `<span class="mine-book-count">${hn ? hn + ' 条标注' : ''}${hn && fn ? ' · ' : ''}${fn ? fn + ' 条收藏' : ''}</span>`;
    box.appendChild(head);
    items.forEach((it) => {
      const d = document.createElement('div');
      d.className = 'mine-item ' + (it.type === 'highlight' ? 'mine-hl' : 'mine-fav');
      const date = new Date(it.at || Date.now()).toLocaleDateString('zh-CN');
      d.innerHTML = `<div class="mine-text"><span class="mine-badge">${it.type === 'highlight' ? '标注' : '收藏'}</span>${escapeHtml(it.text)}</div>` +
        `<div class="mine-meta">第${(it.ci || 0) + 1}章 · 第${(it.pi || 0) + 1}页 · ${date}</div>` +
        `<div class="mine-actions"><button data-act="jump">跳到原文</button><button data-act="del">删除</button></div>`;
      d.querySelector('[data-act="jump"]').addEventListener('click', () => {
        openBook(bid, { ci: it.ci || 0, pi: it.pi || 0 });
      });
      d.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (it.type === 'highlight') saveHighlights(removeEntry(loadHighlights(), bid, it.id));
        else saveFavorites(removeEntry(loadFavorites(), bid, it.id));
        renderMine();
      });
      box.appendChild(d);
    });
    el.appendChild(box);
  });
}

// ---------- 阅读计时 / 打卡 ----------
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
// 导入中遮罩：解析/写入在后台进行时给出明确反馈（非阻塞，Worker 已保证主线程不冻屏）
function showBusy(msg) {
  const b = $('busy');
  if (!b) return;
  const txt = $('busy-text');
  if (txt && msg) txt.textContent = msg;
  b.classList.remove('hidden');
}
function hideBusy() {
  const b = $('busy');
  if (b) b.classList.add('hidden');
}
// 阅读时长结算口径：'visible' = 阅读器可见即计时（v1.4.9 起，与真实阅读时长一致）。
// 回退到 v1.4.8 及更早的「30 秒有效阅读门槛」只需把下面这一个常量改回 'effective'。
const READING_TIME_MODE = 'visible';

// 阅读时累计时长：仅在阅读器可见、未在后台、未打开任何面板时计时；跨过打卡阈值自动打卡。
// v1.4.9：把「有效阅读」门槛从累计时长里解耦。plus.countThisTick() 仍然每 tick 调用
// （它负责累加本次会话有效阅读 effectiveMs 与剩余时长估算），但不再决定 inkreader:stats
// 是否 +dt —— 否则安静读一页不触屏超过 30 秒就会被误判成「亮屏放置」，时长大幅少算。
function startReadingTimer() {
  stopReadingTimer();
  readingLastTs = Date.now();
  readingTimer = setInterval(() => {
    const now = Date.now();
    // 异常间隔 clamp 到 60s（原来直接丢弃整段），避免 WebView 定时器节流时蒸发时长
    const dt = Math.min(Math.max(0, now - readingLastTs), 60000);
    readingLastTs = now;
    if (dt <= 0) return;
    if (document.hidden) return; // 后台不计时，避免回到前台时跳变
    if ($('reader').classList.contains('hidden')) return;
    // 与 plus.js 的面板判定保持同一口径：目录/书签/AI 面板、阅读工具箱、Pro 设置面板
    if (document.querySelector('.panel.open, #plus-panel:not(.hidden), #pro-panel.pro-on')) return;
    const effective = plus ? plus.countThisTick(dt) : true;
    const countedMs = readingTimeTick({ mode: READING_TIME_MODE, dt, effective });
    if (countedMs <= 0) return;
    const { justCheckedIn } = addReadingTime(currentBook.id, countedMs);
    if (justCheckedIn) showToast(`今日阅读已打卡 ✓（≥${settings.checkinGoalMin} 分钟）`);
  }, 1000);
}
function stopReadingTimer() {
  if (readingTimer) { clearInterval(readingTimer); readingTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  readingLastTs = Date.now(); // 回到前台重置，避免补偿式跳增
});

// ---------- 阅读统计面板 ----------
// v1.1.19：主控只保留一个委托点，全部计算 / 图表 / 交互在独立的 js/stats.js 里。
// 想回退旧版三行数字：删掉 createStatsLayer() 调用与 stats.js/css 挂载，恢复本函数旧实现即可。
function renderStats(mode) {
  if (statsDashboard) statsDashboard.render(mode || 'day');
}

// ---------- AI 面板逻辑 ----------
function loadCachedGuide() {
  if (!currentBook) return;
  const ai = currentBook.ai || {};
  const out = $('ai-guide-out');
  if (ai.summary || ai.guide) {
    out.innerHTML = renderMarkdown(
      (ai.summary ? '## 内容概要\n' + ai.summary + '\n\n' : '') + (ai.guide || '')
    );
  } else {
    out.innerHTML = '<p class="empty-tip">本书暂无导读。点上方按钮生成（需配置 AI 引擎）。</p>';
  }
}

async function genGuide(scopeType) {
  if (!currentBook) return;
  if (!aiConfigured()) { alert('请先在「阅读设置 → AI 引擎」选择「AI 大模型」并填写 API Key。'); return; }
  const out = $('ai-guide-out');
  const btn = scopeType === 'chapter' ? $('ai-gen-guide-ch') : $('ai-gen-guide');
  const prev = btn.textContent;
  btn.textContent = '生成中…'; btn.disabled = true;
  out.innerHTML = '<p class="empty-tip">AI 生成中…</p>';
  try {
    const scope = scopeType === 'chapter' ? { type: 'chapter', index: ci } : { type: 'book' };
    const r = await aiSummary(currentBook, scope);
    if (scopeType === 'book') {
      currentBook.ai = Object.assign({}, currentBook.ai, { summary: r.summary, guide: r.guide });
      await putBook(currentBook);
    }
    const body = (scopeType === 'book' && r.summary ? '## 内容概要\n' + r.summary + '\n\n' : '') + r.guide;
    out.innerHTML = renderMarkdown(body);
  } catch (e) {
    out.innerHTML = '<p class="empty-tip">生成失败：' + e.message + '</p>';
  } finally {
    btn.textContent = prev; btn.disabled = false;
  }
}

async function askQuestion() {
  if (!currentBook) return;
  const q = $('ai-qa-question').value.trim();
  if (!q) { alert('请输入你的问题'); return; }
  if (!aiConfigured()) { alert('请先在「阅读设置 → AI 引擎」选择「AI 大模型」并填写 API Key。'); return; }
  const out = $('ai-qa-out');
  const item = document.createElement('div');
  item.className = 'qa-item';
  item.innerHTML = '<div class="qa-q">' + escapeHtml(q) + '</div><div class="qa-a">AI 思考中…</div>';
  out.prepend(item);
  const aEl = item.querySelector('.qa-a');
  try {
    const ans = await aiAsk(q, currentBook);
    aEl.innerHTML = renderMarkdown(ans);
    currentBook.ai = Object.assign({}, currentBook.ai, {
      qa: (currentBook.ai && currentBook.ai.qa ? currentBook.ai.qa : []).concat([{ q, a: ans }]),
    });
    await putBook(currentBook);
  } catch (e) {
    aEl.textContent = '失败：' + e.message;
  }
}

async function genNotes() {
  if (!currentBook) return;
  if (!aiConfigured()) { alert('请先在「阅读设置 → AI 引擎」选择「AI 大模型」并填写 API Key。'); return; }
  const out = $('ai-notes-out');
  out.innerHTML = '<p class="empty-tip">AI 生成中…</p>';
  try {
    const n = await aiNotes(currentBook);
    currentBook.ai = Object.assign({}, currentBook.ai, { notes: n });
    await putBook(currentBook);
    out.innerHTML = renderNotes(n);
  } catch (e) {
    out.innerHTML = '<p class="empty-tip">生成失败：' + e.message + '</p>';
  }
}
function renderNotes(n) {
  let h = '';
  if (n.characters && n.characters.length) {
    h += '<h4>人物 / 实体</h4><div class="note-cards">';
    n.characters.forEach((c) => {
      h += '<div class="note-card"><div class="nc-title">' + escapeHtml(c.name || '') + '</div>' +
        (c.role ? '<div class="nc-role">' + escapeHtml(c.role) + '</div>' : '') +
        (c.relation ? '<div class="nc-rel">' + escapeHtml(c.relation) + '</div>' : '') + '</div>';
    });
    h += '</div>';
  }
  if (n.timeline && n.timeline.length) {
    h += '<h4>关键脉络</h4><ul class="note-list">';
    n.timeline.forEach((t) => { h += '<li><b>' + escapeHtml(t.point || '') + '</b> ' + escapeHtml(t.desc || '') + '</li>'; });
    h += '</ul>';
  }
  if (n.points && n.points.length) {
    h += '<h4>核心要点</h4><ul class="note-list">';
    n.points.forEach((p) => { h += '<li>' + escapeHtml(p) + '</li>'; });
    h += '</ul>';
  }
  return h || '<p class="empty-tip">未能生成笔记。</p>';
}

async function genBilingual() {
  if (!currentBook) return;
  if (settings.translateProvider === 'none') {
    alert('请先在「AI 引擎」选择翻译引擎（演示 / DeepL / Google / AI 大模型）。');
    return;
  }
  const out = $('ai-bilingual-out');
  out.innerHTML = '<p class="empty-tip">逐段翻译中…</p>';
  try {
    const paras = pageParagraphs(pages[pi] || '');
    const rows = await aiBilingual(paras, settings.translateDir);
    let h = '';
    rows.forEach((r) => {
      h += '<div class="bi-row"><div class="bi-orig">' + escapeHtml(r.orig) + '</div>' +
        (r.trans ? '<div class="bi-trans">' + escapeHtml(r.trans) + '</div>' : '') + '</div>';
    });
    out.innerHTML = h || '<p class="empty-tip">本页无可翻译内容。</p>';
  } catch (e) {
    out.innerHTML = '<p class="empty-tip">双语生成失败：' + e.message + '</p>';
  }
}

// ---------- 设置变更 ----------
// 注意：阅读器隐藏时 #page-viewport 高度为 0，此时分页会得到「每页 1 字」并毒化缓存，
// 因此带可见性守卫；同时按相对位置保位，改字号不再跳到别处。
function scheduleRepaginate() {
  clearTimeout(repTimer);
  repTimer = setTimeout(() => {
    if (!currentBook || currentBook.source === 'pdf') return;
    if ($('reader').classList.contains('hidden')) return;
    repaginateKeepAnchor();
  }, 120);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 导入
  $('import-txt').addEventListener('click', () => $('file-txt').click());
  $('import-epub').addEventListener('click', () => $('file-epub').click());
  $('import-pdf').addEventListener('click', () => $('file-pdf').click());
  // 导入区“更多格式”折叠：默认只展示常见格式，点开才显示 FB2/HTML/DOCX
  $('import-more').addEventListener('click', () => {
    const extra = $('import-extra');
    const hidden = extra.classList.toggle('hidden');
    $('import-more').textContent = hidden ? '更多格式 ▾' : '收起 ▴';
  });
  // 导入区整体折叠（点标题栏收起/展开，真正的“收起”语义）
  const importHead = $('import-head');
  if (importHead) {
    const toggleImport = () => {
      const sa = $('shelf-actions');
      const collapsed = sa.classList.toggle('collapsed');
      const chevron = $('import-chevron');
      if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
    };
    importHead.addEventListener('click', toggleImport);
    importHead.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleImport(); }
    });
  }
  $('file-txt').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      await importBook(await parseTxt(f));
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('file-epub').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parseEpub(f);
      await importBook(book);
    } catch (err) {
      alert('EPUB 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('file-pdf').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parsePdf(f);
      await importBook(book);
    } catch (err) {
      alert('PDF 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('import-mobi').addEventListener('click', () => $('file-mobi').click());
  $('file-mobi').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parseMobi(f);
      await importBook(book);
    } catch (err) {
      alert('MOBI 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('import-fb2').addEventListener('click', () => $('file-fb2').click());
  $('file-fb2').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parseFb2(f);
      await importBook(book);
    } catch (err) {
      alert('FB2 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('import-html').addEventListener('click', () => $('file-html').click());
  $('file-html').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parseHtml(f);
      await importBook(book);
    } catch (err) {
      alert('HTML 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });
  $('import-docx').addEventListener('click', () => $('file-docx').click());
  $('file-docx').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showBusy('正在导入…');
    try {
      const book = await parseDocx(f);
      await importBook(book);
    } catch (err) {
      alert('DOCX 导入失败：' + err.message);
    } finally {
      hideBusy();
      e.target.value = '';
    }
  });

  // 拖拽导入
  const shelf = $('shelf');
  const hint = $('drop-hint');
  ['dragenter', 'dragover'].forEach((ev) =>
    shelf.addEventListener(ev, (e) => { e.preventDefault(); hint.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    shelf.addEventListener(ev, (e) => { e.preventDefault(); hint.classList.remove('over'); })
  );
  shelf.addEventListener('drop', async (e) => {
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    showBusy('正在导入…');
    try {
      for (const f of files) {
        if (KINDLE_RE.test(f.name)) {
          alert(
            '暂不支持该 Kindle 格式：' + f.name + '\n\n' +
            'Kindle 的 .azw3 / .kfx 多为加密或 KF8 复杂结构，浏览器内无法可靠解析。\n\n' +
            '最简单：用免费软件 Calibre 一键转成 EPUB 再导入本阅读器——\n' +
            '  1) 打开 Calibre，把这本书拖进去；\n' +
            '  2) 选中它 → 顶部「转换书籍」→ 右上角输出格式选 EPUB → 确定；\n' +
            '  3) 右键该书 → 打开所在目录，取出 .epub 拖进本阅读器即可。\n\n' +
            '（普通 .mobi / .azw 已支持应用内直接导入，无需转换。）'
          );
          continue;
        }
        if (/\.mobi$/i.test(f.name) || /\.azw$/i.test(f.name)) {
          try { await importBook(await parseMobi(f)); } catch (err) { alert('MOBI 导入失败：' + err.message); }
        } else if (/\.txt$/i.test(f.name)) await importBook(await parseTxt(f));
        else if (/\.epub$/i.test(f.name)) {
          try { await importBook(await parseEpub(f)); } catch (err) { alert('EPUB 导入失败：' + err.message); }
        } else if (/\.pdf$/i.test(f.name)) {
          try { await importBook(await parsePdf(f)); } catch (err) { alert('PDF 导入失败：' + err.message); }
        } else if (/\.fb2$/i.test(f.name)) {
          try { await importBook(await parseFb2(f)); } catch (err) { alert('FB2 导入失败：' + err.message); }
        } else if (/\.html?$/i.test(f.name)) {
          try { await importBook(await parseHtml(f)); } catch (err) { alert('HTML 导入失败：' + err.message); }
        } else if (/\.docx$/i.test(f.name)) {
          try { await importBook(await parseDocx(f)); } catch (err) { alert('DOCX 导入失败：' + err.message); }
        } else {
          alert('不支持的格式：' + f.name + '\n目前支持 .txt / .epub / .pdf / .mobi / .azw / .fb2 / .html / .docx（AZW3/KFX 请用 Calibre 转 EPUB）。');
        }
      }
    } finally {
      hideBusy();
    }
  });

  // 阅读器导航
  $('btn-back').addEventListener('click', goBack);
  $('btn-prev').addEventListener('click', () => turn ? turn.request('prev', 'tap') : prevPage());
  $('btn-next').addEventListener('click', () => turn ? turn.request('next', 'tap') : nextPage());
  $('btn-toc').addEventListener('click', () => openPanel('panel-toc'));
  $('btn-toc-top').addEventListener('click', () => openPanel('panel-toc'));
  $('btn-bookmark').addEventListener('click', () => { buildBookmarks(); openPanel('panel-bookmark'); });
  $('btn-ai').addEventListener('click', () => { openPanel('panel-ai'); loadCachedGuide(); });
  document.querySelectorAll('.stats-tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.stats-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderStats(b.dataset.statsTab);
    });
  });
  $('bm-add').addEventListener('click', addBookmark);

  // AI 面板：tab 切换
  document.querySelectorAll('.ai-tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.ai-tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.ai-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.aiTab));
    });
  });
  $('ai-gen-guide').addEventListener('click', () => genGuide('book'));
  $('ai-gen-guide-ch').addEventListener('click', () => genGuide('chapter'));
  $('ai-qa-ask').addEventListener('click', askQuestion);
  $('ai-gen-notes').addEventListener('click', genNotes);
  $('ai-bilingual-gen').addEventListener('click', genBilingual);
  $('panel-mask').addEventListener('click', closePanels);
  document.querySelectorAll('.panel-close').forEach((b) =>
    b.addEventListener('click', closePanels)
  );

  // 点击翻页区：左/右/中（所有输入统一走编排层，带串行化与撤销）
  $('page-viewport').addEventListener('click', (e) => {
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // 选中文字时不翻页
    // 脚注/标注弹层开启时，点击翻页区先关闭它（链接与高亮自身已 stopPropagation，不会走到这里）
    if (!$('footnote-pop').classList.contains('hidden') || !$('hl-pop').classList.contains('hidden')) {
      hideTranslate(); return;
    }
    if (document.querySelector('.panel.open')) { closePanels(); return; }
    // 修复状态机陷阱：以前「控制条显示时点任意处只收起」，点左右热区白点一次不翻页。
    // 现在收起与翻页可以同时发生，中间区仍负责唤出/收起。
    const chromeVisible = !$('reader').classList.contains('hide-chrome');
    if (chromeVisible) $('reader').classList.add('hide-chrome');
    const rect = e.currentTarget.getBoundingClientRect();
    const go = (dir) => (turn ? turn.request(dir, 'tap') : (dir === 'prev' ? prevPage() : nextPage()));
    // 热区交给 Nexus 能力层判定（可配边缘宽度 / 三区五区 / 左右手互换）；
    // 未挂载时保持原来的 0.3 / 0.7 行为，保证整层删除可回退。
    const zone = nexus
      ? nexus.hitZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
      : ((e.clientX - rect.left) / rect.width < 0.3 ? 'prev'
        : (e.clientX - rect.left) / rect.width > 0.7 ? 'next' : 'menu');
    if (zone === 'prev') go('prev');
    else if (zone === 'next') go('next');
    else if (!chromeVisible) $('reader').classList.remove('hide-chrome');
  });

  // 设置控件
  $('seg-font').addEventListener('click', (e) => {
    const v = e.target.dataset.val; if (!v) return;
    settings.fontFamily = v; applySettings(); saveSettings(settings); scheduleRepaginate();
  });
  $('seg-regal').addEventListener('click', (e) => {
    const v = e.target.dataset.val; if (!v) return;
    settings.regalRefresh = parseInt(v, 10); applySettings(); saveSettings(settings);
  });
  const bindRange = (id, key, parse, label) => {
    $(id).addEventListener('input', (e) => {
      settings[key] = parse(e.target.value);
      if (label) label(settings[key]);
      applySettings();
      saveSettings(settings);
      scheduleRepaginate();
    });
  };
  bindRange('set-fontsize', 'fontSize', (v) => parseInt(v, 10), (v) => ($('val-fontsize').textContent = v + 'px'));
  bindRange('set-lineheight', 'lineHeight', (v) => parseFloat(v), (v) => ($('val-lineheight').textContent = v.toFixed(2)));
  bindRange('set-margin', 'margin', (v) => parseInt(v, 10), (v) => ($('val-margin').textContent = v + 'px'));
  bindRange('set-paraspacing', 'paragraphSpacing', (v) => parseFloat(v), (v) => ($('val-paraspacing').textContent = v.toFixed(1) + 'em'));
  bindRange('set-letterspacing', 'letterSpacing', (v) => parseFloat(v), (v) => ($('val-letterspacing').textContent = v + 'px'));
  $('set-justify').addEventListener('change', (e) => { settings.justify = e.target.checked; applySettings(); saveSettings(settings); scheduleRepaginate(); });
  $('set-indent').addEventListener('change', (e) => { settings.firstLineIndent = e.target.checked; applySettings(); saveSettings(settings); scheduleRepaginate(); });

  // 翻译设置
  $('seg-translate-provider').addEventListener('click', (e) => {
    const v = e.target.dataset.val; if (!v) return;
    settings.translateProvider = v; saveSettings(settings);
    setSeg('seg-translate-provider', v); updateTranslateFieldsVisibility();
  });
  $('set-tkey').addEventListener('input', (e) => { settings.translateApiKey = e.target.value; saveSettings(settings); });
  $('set-tbase').addEventListener('input', (e) => { settings.translateLlmBase = e.target.value; saveSettings(settings); });
  $('set-tmodel').addEventListener('input', (e) => { settings.translateLlmModel = e.target.value; saveSettings(settings); });
  $('seg-tdir').addEventListener('click', (e) => {
    const v = e.target.dataset.val; if (!v) return;
    settings.translateDir = v; saveSettings(settings); setSeg('seg-tdir', v);
  });
  $('set-ai-auto').addEventListener('change', (e) => {
    settings.aiAutoSummary = e.target.checked; saveSettings(settings);
  });
  // 打卡阈值 + 书架分组
  bindRange('set-checkin', 'checkinGoalMin', (v) => parseInt(v, 10), (v) => ($('val-checkin').textContent = v + ' 分钟'));
  $('set-group-cat').addEventListener('change', (e) => {
    settings.shelfGroupByCat = e.target.checked;
    applySettings(); saveSettings(settings);
    renderShelf();
  });
  $('set-keep-screen').addEventListener('change', (e) => {
    settings.keepScreenOn = e.target.checked; saveSettings(settings);
    applyKeepScreenOn();
  });
  // 分类管理：新增 / 删除分类
  $('cat-add').addEventListener('click', () => {
    const inp = $('cat-input');
    addCategory(inp.value);
    inp.value = '';
  });
  $('cat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { addCategory(e.target.value); e.target.value = ''; }
  });
  $('cat-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-del');
    if (btn) removeCategory(btn.dataset.cat);
  });
  initTranslateSelection();
  initFootnoteLinks();

  // 底部导航栏：切换主 Tab 时清空返回历史（主流 App 行为）
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    t.addEventListener('click', () => showView(t.dataset.view, { reset: true }));
  });
  // 独立页面的导航：带 data-back 的"返回"按钮走返回栈；其余为前进导航
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.back) { goBack(); return; }
      if (b.dataset.reset) { showView(b.dataset.nav, { reset: true }); return; }
      showView(b.dataset.nav);
      if (b.dataset.legal) openLegal(b.dataset.legal);
    });
  });
  // 法律声明页内的三个标签切换
  document.querySelectorAll('.legal-tab').forEach((b) => {
    b.addEventListener('click', () => openLegal(b.dataset.legal));
  });
  // 「我的」页：全部 / 标注 / 收藏 筛选
  document.querySelectorAll('.mine-tab').forEach((b) => {
    b.addEventListener('click', () => {
      mineFilter = b.dataset.mineTab || 'all';
      document.querySelectorAll('.mine-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderMine();
    });
  });

  // Android 硬件返回键：交给返回栈处理（不直退应用）。仅在原生外壳生效，Web 端无效（不影响）。
  const app = capacitorApp();
  if (app) {
    try {
      app.addListener('backButton', () => goBack());
    } catch (e) {}
  }
  // 翻页动画开关
  $('set-flip').addEventListener('change', (e) => {
    settings.pageFlip = e.target.checked;
    saveSettings(settings);
  });

  // 键盘（桌面）
  document.addEventListener('keydown', (e) => {
    if ($('reader').classList.contains('hidden')) return;
    // Nexus 键位映射（外接键盘 / 翻页笔）：用户配置过的键优先，未配置保持原行为
    const mapped = nexus ? nexus.keyAction(e.key) : null;
    if (mapped) {
      e.preventDefault();
      if (mapped === 'next' || mapped === 'prev') { turn ? turn.request(mapped, 'key') : (mapped === 'next' ? nextPage() : prevPage()); }
      else if (mapped === 'toc') openPanel('panel-toc');
      else if (mapped === 'close') closePanels();
      else if (mapped === 'menu') $('reader').classList.toggle('hide-chrome');
      return;
    }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); turn ? turn.request('next', 'key') : nextPage(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); turn ? turn.request('prev', 'key') : prevPage(); }
    else if (e.key === 'Escape') closePanels();
  });

  // 窗口尺寸变化 -> 清分页缓存并按相对位置保位重新分页
  let rz = null;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (currentBook && !$('reader').classList.contains('hidden')) {
        if (currentBook.source === 'pdf') { pdfImageCache.clear(); renderPage(); }
        else repaginateKeepAnchor();
      }
    }, 200);
  });
}

// ---------- Pro 层装配 ----------
// 所有输入源（点击 / 滑动 / 键盘 / 音量键 / 定时 / 视线）都只通过 turn.request 进入，
// 翻页出口仍是既有的 nextPage/prevPage，保证 afterPageTurn 的进度保存、Regal、分页缓存全部复用。
function createProLayer() {
  turn = createTurnController({
    perform: (dir) => (dir === 'prev' ? prevPage() : nextPage()),
    getPosition: () => (currentBook ? { ci, pi } : null),
    restore: restorePosition,
    canTurn: () => !!currentBook && !$('reader').classList.contains('hidden'),
    onTurn: ({ source }) => { if (pro) pro.onTurn(source); },
  });
  gaze = createGazeEngine({
    onSignal: () => {
      if (plus && !plus.acceptGazeSignal()) return; // Plus：视线意图判定，挡住误触
      if (turn) turn.request('next', 'gaze');
    },
    onStatus: (st) => {
      if (plus) plus.onGazeStatus(st);
      if (pro) pro.setGazeStatus(st);
    },
    getConfig: () => settings,
    onCalibration: (cal) => { settings.gazeCalibration = cal; saveSettings(settings); },
  });
  pro = mountReaderPro({
    turn, gaze,
    getSettings: () => settings,
    setSetting: (k, v) => { settings[k] = v; applySettings(); saveSettings(settings); if (plus) plus.saveBookLayout(k, v); },
    setLayoutSetting: (k, v) => { settings[k] = v; applySettings(); saveSettings(settings); scheduleRepaginate(); if (plus) plus.saveBookLayout(k, v); },
    seekByPct,
    restorePosition,
    getProgress: () => (currentBook ? { pct: computeProgressPct(), ci, pi } : null),
    showToast,
  });
  // 只读诊断 / 自动化回归入口：不参与业务逻辑，便于在无真机环境验证编排层与视线状态机。
  window.__INK_PRO = {
    turn, gaze, pro,
    getSettings: () => settings,
    getPosition: () => (currentBook ? { ci, pi } : null),
  };

  // ---------- 低电量自动省电守卫 ----------
  // 视线翻页（前置摄像头 + 端侧 wasm 推理）是应用最大的可控耗电源。电量低于 15% 且未充电时，
  // 自动关闭视线翻页并提示，避免用户在没察觉的情况下电量快速下降。特性探测，不支持则无副作用。
  function setupBatteryGuard() {
    if (typeof navigator === 'undefined' || !navigator.getBattery) return;
    let warned = false;
    let battery = null;
    const check = () => {
      if (!battery) return;
      const low = !battery.charging && battery.level <= 0.15;
      if (low && !warned) {
        warned = true;
        if (pro && typeof pro.setMode === 'function') { try { pro.setMode('off'); } catch (e) {} }
        if (showToast) showToast('电量低于 15%：已自动关闭视线翻页以省电');
      } else if (!low) {
        warned = false;
      }
    };
    try {
      navigator.getBattery().then((b) => {
        battery = b;
        b.addEventListener('levelchange', check);
        b.addEventListener('chargingchange', check);
        check();
      }).catch(() => {});
    } catch (e) {}
  }
  setupBatteryGuard();
}

// ---------- Plus 层装配 ----------
// 与 Pro 层同样的「独立模块 + ctx 注入」范式：plus.js 不感知 ci/pi，只通过下面这组回调与主控通信。
// 必须在 createProLayer 之后装配：turn.setBeforeTurn 需要把 Pro 的「翻页前预告」与
// Plus 的「章末/书末自动停」组合起来，而不是互相覆盖。
function createPlusLayer() {
  plus = mountReaderPlus({
    turn, gaze,
    getBook: () => currentBook,
    getPosition: () => (currentBook ? {
      ci, pi, pages: pages.length, chapterCount: currentBook.chapters.length,
      pct: computeProgressPct(), totalChars,
    } : null),
    getPages: () => pages,
    getProgress,
    getStats: () => loadStats(),
    getMarks: () => {
      const id = currentBook ? currentBook.id : '';
      const h = loadHighlights(), f = loadFavorites(), bm = loadBookmarks();
      return { highlights: h[id] || [], favorites: f[id] || [], bookmarks: bm[id] || [] };
    },
    getSettings: () => settings,
    applyLayout: (ov) => { Object.assign(settings, ov || {}); applySettings(); saveSettings(settings); },
    jumpToResult: (ciTarget, quote) => jumpToChapterOrQuote(ciTarget, quote),
    jumpToChapter: (ciTarget) => jumpToChapterOrQuote(ciTarget, ''),
    openBook: (id) => openBook(id),
    requestTurn: (dir, source) => turn.request(dir, source),
    stopAuto: () => { if (pro) pro.setMode('off'); else turn.stopAuto(); },
    resumeAuto: () => {
      if (pro) pro.setMode(settings.autoMode === 'off' ? 'timed' : settings.autoMode);
      else turn.startAuto('timed', settings.autoIntervalMs, settings.autoConfirmMs);
    },
    syncPro: () => { if (pro) pro.syncPause(); },
    onLayoutModeChange: () => {
      if (currentBook && currentBook.source !== 'pdf' && !$('reader').classList.contains('hidden')) repaginateKeepAnchor();
    },
    renderShelf: () => renderShelf(),
    showToast,
    explainText: (t) => { lastSelText = t; doExplain(t); },
    copyText: copyToClipboard,
    addExcerpt: addExcerptFromText,
    setCover: setBookCover,
    getAllBooks,
    restoreBooks: restoreBooksFromBackup,
    swCacheName: 'inkreader-v11', // 与 sw.js CACHE 保持一致
  });

  const proBefore = turn.getBeforeTurn();
  turn.setBeforeTurn(async (dir, source) => {
    if (!plus.beforeAutoTurn(dir, source)) return false; // 章末/书末：停自动翻页并给出出口
    return proBefore ? await proBefore(dir, source) : true; // 保留 Pro 的可取消预告
  });

  window.__INK_PLUS = plus; // 只读诊断 / 自动化回归入口
}

// ---------- 阅读统计仪表盘挂载（v1.1.19，独立层） ----------
// 只向仪表盘暴露 5 个只读回调 + 2 个导航动作，仪表盘不反向修改主控状态，
// 因此整个 stats.js / stats.css 可以整层删除而不影响阅读器。
function createStatsLayer() {
  statsDashboard = mountStatsDashboard({
    getStats: () => loadStats(),          // 直接读本地快照，不做任何数据迁移
    getProgress,                         // (bookId) -> { ci, pi, pct } | null
    listBooksMeta,                       // () -> Promise<[{ id, title }]>
    goShelf: () => showView('shelf', { reset: true }),
    openBook: (id) => { openBook(id); },
    now: () => new Date(),
  });
  window.__INK_STATS = statsDashboard; // 只读诊断 / 自动化回归入口
}

// ---------- Nexus 能力层挂载（v1.2.0，独立层） ----------
// 与 Plus / Stats 同构：只注入只读数据回调与导航动作，能力层不反向修改主控状态。
// 删掉本函数 + import + index.html 的 css/nexus.css 即可整体回退。
function createNexusLayer() {
  nexus = mountReaderNexus({
    getMetas: () => listBooksMeta(),
    getBooks: () => getAllBooks(),
    putBook: (b) => putBook(b),
    deleteBook: (id) => deleteBook(id),
    getProgress: (id) => getProgress(id),
    getStats: () => loadStats(),
    openBook: (id, jump) => openBook(id, jump),
    showToast: (m) => showToast(m),
    refreshShelf: () => renderShelf(),
    closePanels: () => closePanels(),
    jumpTo: (j) => {
      if (!currentBook) { showToast('请先打开一本书，再使用快捷跳转'); return; }
      if (j.kind === 'pct') seekByPct(j.value);
      else if (j.kind === 'chapter') {
        ci = Math.max(0, Math.min(currentBook.chapters.length - 1, j.value));
        pi = 0; paginateCurrentChapter(); afterPageTurn(true);
      } else if (j.kind === 'page') { pi = j.value; renderPage(); afterPageTurn(false); }
    },
    now: () => new Date(),
  });
  window.__INK_NEXUS = nexus; // 只读诊断 / 自动化回归入口
}

// ---------- Aurora 后台能力（v1.4.6，独立层） ----------
// 「红杉能力中心 · 200 项」清单面板已移除，这里只挂载不依赖 UI 的常驻能力：
// 亮度遮罩 / 护眼提醒 / 双击缩放 / 阅读时长累计。状态见 docs/roadmap-200.md。
function createAuroraLayer() {
  mountAurora();
}

// ---------- 启动 ----------
function init() {
  applySettings();
  createProLayer();
  createPlusLayer();
  createStatsLayer();
  createNexusLayer();
  createAuroraLayer();
  bindEvents();
  renderShelf();
  ensureBookMeta();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // 按 SW 缓存版本判断是否需要刷新：旧写法「一个会话只 reload 一次」会在 APK 升级、
    // WebView 进程被保留时吞掉第二次更新，导致用户一直跑着旧 app.js。
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'INK_SW_ACTIVATED') return;
      const key = 'inkreader:sw-cache';
      let prev = null;
      try { prev = localStorage.getItem(key); localStorage.setItem(key, e.data.cache); } catch (err) {}
      if (prev && prev !== e.data.cache) location.reload();
    });
  }
  window.__INK_INIT_DONE = true; // 诊断标记：init 已完成
}
init();
