// 本地存储：书籍内容存 IndexedDB（容量大）；设置/进度/书签/书架元数据存 localStorage。
// 关键：在「不透明源 / 隐私模式 / 某些预览沙箱」里 IndexedDB 与 localStorage 会被拒绝，
// 此时自动降级为内存存储，保证应用仍可运行（代价是不跨刷新持久化）。

const DB_NAME = 'inkreader';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';

let dbPromise = null;
let dbAvailable = true; // 一旦 IndexedDB 被拒绝，置 false 并永久走内存
const memBooks = new Map(); // 内存兜底：id -> book

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
          dbAvailable = false;
          reject(new Error('IndexedDB 不可用'));
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_BOOKS)) {
            db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbAvailable = false;
          reject(req.error || new Error('IndexedDB 打开失败'));
        };
      } catch (e) {
        dbAvailable = false;
        reject(e);
      }
    });
  }
  return dbPromise;
}

function idbPut(db, book) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BOOKS).put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const r = tx.objectStore(STORE_BOOKS).get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const r = tx.objectStore(STORE_BOOKS).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}
function metaOf(b) {
  return {
    id: b.id,
    title: b.title,
    author: b.author || '',
    source: b.source,
    addedAt: b.addedAt,
    chaptersCount: (b.chapters || []).length,
    category: b.category || '其他',
    cover: b.cover || '', // 封面图（data URI，导入时从章节内联图片提取）
    aiTags: (b.ai && Array.isArray(b.ai.tags) && b.ai.tags) || [],
  };
}
function memMetaList() {
  return Array.from(memBooks.values())
    .map(metaOf)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function putBook(book) {
  if (!dbAvailable) {
    memBooks.set(book.id, book);
    return;
  }
  try {
    const db = await openDB();
    await idbPut(db, book);
  } catch (e) {
    dbAvailable = false;
    memBooks.set(book.id, book);
  }
}
export async function getBook(id) {
  if (!dbAvailable) return memBooks.get(id) || null;
  try {
    const db = await openDB();
    return await idbGet(db, id);
  } catch (e) {
    dbAvailable = false;
    return memBooks.get(id) || null;
  }
}
export async function deleteBook(id) {
  if (!dbAvailable) {
    memBooks.delete(id);
    return;
  }
  try {
    const db = await openDB();
    await idbDelete(db, id);
  } catch (e) {
    dbAvailable = false;
    memBooks.delete(id);
  }
}
export async function listBooksMeta() {
  if (!dbAvailable) return memMetaList();
  try {
    const db = await openDB();
    const all = await idbGetAll(db);
    return all
      .map(metaOf)
      .concat(memMetaList())
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } catch (e) {
    dbAvailable = false;
    return memMetaList();
  }
}

// 返回全部书籍完整对象（用于分类回填等需要改写的场景）
export async function getAllBooks() {
  if (!dbAvailable) return Array.from(memBooks.values());
  try {
    const db = await openDB();
    return await idbGetAll(db);
  } catch (e) {
    dbAvailable = false;
    return Array.from(memBooks.values());
  }
}

// ---------- localStorage 部分（设置 / 进度 / 书签）；不可用时降级内存 ----------
const K_SETTINGS = 'inkreader:settings';
const K_PROGRESS = 'inkreader:progress';
const K_BOOKMARKS = 'inkreader:bookmarks';
const K_HIGHLIGHTS = 'inkreader:highlights'; // 正文标注：{ bookId: [{ id, text, ci, pi, at }] }
const K_FAVORITES = 'inkreader:favorites';  // 收藏语句：{ bookId: [{ id, text, ci, pi, at }] }

// K_STATS 以前没有内存兜底：隐私模式 / localStorage 被拒时统计与打卡会 100% 静默失效。
const memoryKV = { settings: null, progress: {}, bookmarks: {}, highlights: {}, favorites: {}, stats: {} };

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    if (key === K_SETTINGS) return memoryKV.settings || fallback;
    if (key === K_PROGRESS) return memoryKV.progress || fallback;
    if (key === K_BOOKMARKS) return memoryKV.bookmarks || fallback;
    if (key === K_HIGHLIGHTS) return memoryKV.highlights || fallback;
    if (key === K_FAVORITES) return memoryKV.favorites || fallback;
    if (key === K_STATS) return memoryKV.stats || fallback;
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    if (key === K_SETTINGS) memoryKV.settings = value;
    else if (key === K_PROGRESS) memoryKV.progress = value;
    else if (key === K_BOOKMARKS) memoryKV.bookmarks = value;
    else if (key === K_HIGHLIGHTS) memoryKV.highlights = value;
    else if (key === K_FAVORITES) memoryKV.favorites = value;
    else if (key === K_STATS) memoryKV.stats = value;
  }
}

export const DEFAULT_SETTINGS = {
  theme: 'ink', // 默认主题：墨水风（毛笔墨迹淡化翻页）
  fontFamily: 'serif',
  fontSize: 20,
  lineHeight: 1.75,
  margin: 22,
  justify: true,
  letterSpacing: 0,
  paragraphSpacing: 0.7,
  firstLineIndent: true,
  regalRefresh: 6,
  pageFlip: false, // 翻页动画（翻书效果）；默认关闭以贴合「默认翻页零动画」，手机/墨水屏可在设置开启
  // AI 引擎（翻译/摘要/问答/标签/笔记/双语 共用的 Key 与模型配置；默认关闭，不影响离线阅读）
  translateProvider: 'none',
  translateApiKey: '',
  translateLlmBase: 'https://api.openai.com/v1',
  translateLlmModel: 'gpt-4o-mini',
  translateDir: 'auto',
  aiAutoSummary: true, // 导入书籍且已配置 AI 时，自动在后台生成导读/摘要并缓存到本书
  checkinGoalMin: 10, // 阅读打卡阈值（分钟）：当日累计阅读达到该时长即自动打卡成功
  shelfGroupByCat: false, // 书架是否按分类分组展示
  keepScreenOn: true, // 阅读时保持屏幕常亮（不锁屏）；离开阅读器自动恢复
  categories: ['文学', '历史', '政治', '小说'], // 默认书籍分类（可在设置/书架顶部增删）

  // ---- Pro：自动翻页与端侧视线 ----
  autoMode: 'off',            // off | timed | adaptive | gaze；敏感能力默认关闭
  autoIntervalMs: 12000,      // 定时 / 节奏跟随的翻页间隔
  autoConfirmMs: 700,         // 自动翻页前的可取消预告窗口（0 = 直接翻）
  gazeSensitivity: 3,         // 1(保守) .. 5(灵敏)
  gazeDwellMs: 320,           // 视线在页底的最短驻留
  gazeCooldownMs: 1600,       // 两次回扫触发之间的冷却
  gazeSampleMs: 90,           // 取帧间隔（约 11fps，够用且省电）
  gazePowerSave: false,       // 视线省电模式：降低取帧率与摄像头帧率，显著减少摄像头+CPU 耗电
  gazeEngine: 'auto',         // auto | system | sim；auto 会优先探测本地端侧模型
  gazeCalibration: null,      // { top, bottom } 个人视线量程
  brightness: 100,            // 阅读内亮度（纯 CSS 遮罩，不需要系统权限）
};

// 设置热路径优化：原 loadSettings() 每次都 JSON.parse 整份设置字符串（addReadingTime 每秒、
// 亮度滑块每次 input 都会触发），saveSettings() 每次都同步 JSON.stringify + setItem。
// 改为「内存缓存 + 写防抖」：读取走内存对象（零解析），写入延迟 300ms 合并，并在页面卸载/
// 切后台时强制落盘，既不丢最近一次改动，又消除拖动滑块期间的反复序列化卡顿。
let settingsCache = null;
let settingsPersistTimer = null;
export function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = Object.assign({}, DEFAULT_SETTINGS, lsGet(K_SETTINGS, {}));
  return settingsCache;
}
export function saveSettings(s) {
  settingsCache = s;
  if (settingsPersistTimer) return; // 已排程，缓存已是最新值，无需重复建定时器
  settingsPersistTimer = setTimeout(() => {
    settingsPersistTimer = null;
    try { localStorage.setItem(K_SETTINGS, JSON.stringify(settingsCache)); }
    catch (e) { memoryKV.settings = settingsCache; }
  }, 300);
}
// 立即落盘：页面卸载 / 切后台时调用，兜住 300ms 防抖窗口内可能丢失的最近一次设置改动。
export function flushSettings() {
  if (settingsPersistTimer) { clearTimeout(settingsPersistTimer); settingsPersistTimer = null; }
  if (settingsCache) {
    try { localStorage.setItem(K_SETTINGS, JSON.stringify(settingsCache)); }
    catch (e) { memoryKV.settings = settingsCache; }
  }
}
if (typeof window !== 'undefined') {
  const flush = () => { try { flushSettings(); } catch (e) {} };
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

// 进度热路径优化：原 saveProgress() 每次都 loadProgress()（解析整份进度 JSON）再整体写回，
// 翻页越频繁序列化成本越高。改为内存缓存：读取走内存对象（零解析），写入仍即时落盘（不丢阅读位置）。
let progressCache = null;
export function loadProgress() {
  if (progressCache) return progressCache;
  progressCache = lsGet(K_PROGRESS, {});
  return progressCache;
}
// pct 为阅读器算出的精确进度百分比，供书架角标直接展示；旧数据无此字段时由书架按章节估算
export function saveProgress(bookId, ci, pi, pct) {
  const all = loadProgress();
  all[bookId] = { ci, pi, pct: typeof pct === 'number' && isFinite(pct) ? pct : null };
  progressCache = all;
  lsSet(K_PROGRESS, all);
}
export function getProgress(bookId) {
  return loadProgress()[bookId] || null;
}

export function loadBookmarks() {
  return lsGet(K_BOOKMARKS, {});
}
export function saveBookmarks(map) {
  lsSet(K_BOOKMARKS, map);
}

// ---------- 正文标注 / 收藏语句 ----------
// 两者结构一致：{ [bookId]: [{ id, text, ci, pi, at }] }
// text 存归一化后的选中文字（空白折叠），ci/pi 用于跳回原文与在本页还原高亮。
export function loadHighlights() {
  return lsGet(K_HIGHLIGHTS, {});
}
export function saveHighlights(map) {
  lsSet(K_HIGHLIGHTS, map);
}
export function loadFavorites() {
  return lsGet(K_FAVORITES, {});
}
export function saveFavorites(map) {
  lsSet(K_FAVORITES, map);
}

// ---------- 阅读统计 / 打卡 ----------
const K_STATS = 'inkreader:stats';

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayKey(d) {
  return dateKey(d || new Date());
}
function dayTotal(day) {
  let t = 0;
  for (const id in day.byBook) t += day.byBook[id];
  return t;
}
// 统计常驻内存累加器：原实现每秒都重新 loadStats() 读「上次落盘快照」，
// 5 秒节流窗口里只有 1 次的 +1000ms 被写回，其余 4 次算完即弃 —— 计时少算近 5 倍，
// 打卡几乎永远触发不了。现在只在内存对象上累加，定期 flush 整份数据。
let statsMemory = null;
let lastStatsPersist = 0;
export function loadStats() {
  return statsMemory || lsGet(K_STATS, {});
}
export function saveStats(stats) {
  statsMemory = stats;
  lsSet(K_STATS, stats);
  lastStatsPersist = Date.now();
}
// 累计某本书当日的阅读毫秒数；跨过打卡阈值时标记当日打卡并返回 justCheckedIn
export function addReadingTime(bookId, ms) {
  if (!bookId || !ms || ms <= 0) return { dayStat: null, justCheckedIn: false };
  const stats = statsMemory || loadStats();
  const k = todayKey();
  // 跨天时重置内存快照中的日期键由调用方自然产生，无需额外处理
  if (!stats[k]) stats[k] = { byBook: {}, checkin: false, checkinAt: null };
  const day = stats[k];
  day.byBook[bookId] = (day.byBook[bookId] || 0) + ms;
  statsMemory = stats;
  const goal = (loadSettings().checkinGoalMin || 10) * 60000;
  let justCheckedIn = false;
  if (!day.checkin && dayTotal(day) >= goal) {
    day.checkin = true;
    day.checkinAt = Date.now();
    justCheckedIn = true;
  }
  // 打卡达成时强制写盘；其余最多每 5 秒写一次（写的是完整累加结果，不丢增量）
  if (justCheckedIn || Date.now() - lastStatsPersist > 5000) saveStats(stats);
  return { dayStat: day, justCheckedIn };
}
// 按 日 / 周 / 月 聚合统计；返回 { totalMs, byBook, checkinDays, days }
export function aggregateStats(stats, mode, ref) {
  const r = ref || new Date();
  let keys;
  if (mode === 'day') {
    keys = [todayKey(r)];
  } else if (mode === 'week') {
    const d = new Date(r.getFullYear(), r.getMonth(), r.getDate());
    const dow = (d.getDay() + 6) % 7; // 周一为一周起点
    const mon = new Date(d);
    mon.setDate(d.getDate() - dow);
    keys = [];
    for (let i = 0; i < 7; i++) {
      const x = new Date(mon);
      x.setDate(mon.getDate() + i);
      keys.push(dateKey(x));
    }
  } else {
    const y = r.getFullYear();
    const m = r.getMonth();
    const dayCount = new Date(y, m + 1, 0).getDate();
    keys = [];
    for (let i = 1; i <= dayCount; i++) keys.push(dateKey(new Date(y, m, i)));
  }
  let totalMs = 0;
  const byBook = {};
  let checkinDays = 0;
  for (const k of keys) {
    const s = stats[k];
    if (!s) continue;
    if (s.checkin) checkinDays++;
    for (const id in s.byBook) {
      byBook[id] = (byBook[id] || 0) + s.byBook[id];
      totalMs += s.byBook[id];
    }
  }
  return { totalMs, byBook, checkinDays, days: keys.length };
}
