// 红杉阅读 —— Service Worker（离线缓存应用外壳）
// 缓存版本号：每次改动 ASSETS 列表里的任意文件（尤其 js/app.js 等自身脚本）都必须 +1，
// 否则 WebView 升级后会继续从旧缓存喂回旧文件，导致修好的 bug 在真机“看起来没修”。
const CACHE = 'inkreader-v14';
const PREV_CACHE = 'inkreader-v13';
// 巨大的、永不改变的第三方库走 cache-first（首次拉取后固化）；
// 应用自身脚本/css 走 network-first，永远取 APK 内最新，杜绝旧缓存覆盖新代码。
const VENDOR = [
  'js/vendor/pdf.min.js',
  'js/vendor/pdf.worker.min.js',
  'js/vendor/mediapipe/vision_wasm_internal.js',
  'js/vendor/mediapipe/vision_wasm_internal.wasm',
  'js/vendor/mediapipe/face_landmarker.task',
];
// 完整模块图：漏掉任何一个静态 import 的目标，PWA 离线首启都会因模块图加载失败而白屏。
// v1.1.18 新增 Plus 层：css/plus.css、js/plus.js、js/plus-core.js（后者被 importers.js 静态 import）。
// v1.1.19 新增统计仪表盘层：css/stats.css、js/stats.js（由 app.js 静态 import）。
// v1.2.0 新增 Nexus 能力层：css/nexus.css、js/nexus.js、js/nexus-core.js（后者被前者静态 import）。
// v1.3.0 扩展 Nexus 至 200 项能力（簇 11–20），书架待读队列/今日一句、护眼与节律（20-20-20、夜间定时、暗室）。
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/pro.css',
  'css/plus.css',
  'css/stats.css',
  'css/nexus.css',
  'css/ink-flip.css',
  'js/app.js',
  'js/inkflip.js',
  'js/store.js',
  'js/paginate.js',
  'js/importers.js',
  'js/pdfview.js',
  'js/translate.js',
  'js/mobidec.js',
  'js/llm.js',
  'js/ai.js',
  'js/turn.js',
  'js/gaze.js',
  'js/pro.js',
  'js/plus.js',
  'js/plus-core.js',
  'js/stats.js',
  'js/nexus.js',
  'js/nexus-core.js',
  'js/importer-worker.js',
  'js/vendor/fflate.js',
  'js/vendor/pdf.min.js',
  'js/vendor/pdf.worker.min.js',
];

// 相对上一版内容完全没变的文件：升级时直接从旧缓存复制，不产生任何网络/磁盘重复下载。
// 这就是「增量缓存」的核心：版本一变就清空重建，对离线 WebView 既慢又容易留空洞。
const REUSE = [
  'manifest.webmanifest',
  'css/style.css',
  'css/pro.css',
  'css/ink-flip.css',
  'js/inkflip.js',
  'js/store.js',
  'js/paginate.js',
  'js/pdfview.js',
  'js/translate.js',
  'js/mobidec.js',
  'js/llm.js',
  'js/ai.js',
  'js/gaze.js',
  'js/pro.js',
  'js/importer-worker.js',
  'js/vendor/fflate.js',
  'js/vendor/pdf.min.js',
  'js/vendor/pdf.worker.min.js',
].concat(VENDOR);

function reqOf(asset) {
  return new Request(new URL(asset, self.registration.scope), { cache: 'reload' });
}
async function copyFromPrev(cache, asset) {
  try {
    // 直接 caches.open 会在「跨版本升级 / 首次安装」时凭空建一个空缓存，先判断存在性
    if (!await caches.has(PREV_CACHE)) return false;
    const old = await caches.open(PREV_CACHE);
    const url = new URL(asset, self.registration.scope);
    const hit = await old.match(url.href) || await old.match(asset);
    if (!hit) return false;
    await cache.put(new Request(url), hit.clone());
    return true;
  } catch (e) { return false; }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (a) => {
      // 1) 未变更文件：直接复用旧缓存，零网络请求
      if (REUSE.includes(a) && await copyFromPrev(cache, a)) return;
      // 2) 变更文件：取新版本
      try {
        const req = reqOf(a);
        const res = await fetch(req);
        if (res && res.ok) { await cache.put(req, res.clone()); return; }
      } catch (err) {}
      // 3) 离线 / 单个资源 404：回填旧版本，绝不让新缓存留下空洞
      await copyFromPrev(cache, a);
    }));
    await self.skipWaiting();
  })().catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // 只清旧版本；install 已经把需要的内容搬进新缓存，删除不会再造成缺资源。
      Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('inkreader-v')).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() =>
      // 通知页面「缓存版本变了」，由页面决定是否 reload：比 controllerchange +
      // sessionStorage 一次性标志可靠（APK 升级 / WebView 进程保留时不会被吞掉）。
      self.clients.matchAll({ type: 'window' }).then((cs) => {
        cs.forEach((c) => c.postMessage({ type: 'INK_SW_ACTIVATED', cache: CACHE }));
      })
    )
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只接管同源：跨源图片 / 未来可能引入的模型文件不进应用缓存，
  // 避免 206 / Vary:* / opaque 响应让 cache.put reject 产生 unhandledrejection。
  if (url.origin !== self.location.origin) return;
  const isVendor = VENDOR.some((v) => url.pathname.endsWith(v));
  if (isVendor) {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
