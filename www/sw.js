// 红杉阅读 —— Service Worker（离线缓存应用外壳）
// 缓存版本号：每次改动 ASSETS 列表里的任意文件（尤其 js/app.js 等自身脚本）都必须 +1，
// 否则 WebView 升级后会继续从旧缓存喂回旧文件，导致修好的 bug 在真机“看起来没修”。
// v15：书架头部布局重排（删除 .brand-mark 方图标）——index.html / css/style.css 均变更，
// 必须 +1 且把 css/style.css 从 REUSE 摘出，否则 WebView 会继续喂回旧样式。
// v16：首版送审隐藏 AI / 在线翻译入口——index.html 变更，并新增
// css/release-review.css、js/release-gate.js（新文件不能进 REUSE，必须从包内取新版）。
// v17：修复「红杉能力中心」面板与设置页文字重叠——css/aurora.css、js/aurora.js 均变更，
// 两文件都不得进 REUSE；同时把 aurora 模块图（css/aurora.css、js/aurora.js、
// js/aurora-core.js、js/aurora-registry.js）补进 ASSETS，离线首启不再漏资源。
// v18：移除「红杉能力中心 · 200 项」清单 UI（index.html / app.js / aurora.js / aurora.css
// 变更），并按代码核对同步 aurora-registry.js 里 69 项状态。变更文件一律不进 REUSE。
// v19：送审版把 App 内法律页 LEGAL_CONTACT_EMAIL 与 docs/site 隐私政策页的占位邮箱
// 统一替换为真实联系邮箱（js/app.js 变更）。app.js 本就不在 REUSE 列表里，但仍须 +1
// 触发页面 INK_SW_ACTIVATED 版本比对并重载，避免真机升级后继续显示旧邮箱。
// v20：送审版移除相机权限与「视线翻页」入口——js/release-gate.js、css/release-review.css、
// js/app.js、js/pro.js 均变更（.camera-feature-only 语义类 + setMode 兜底）。
// 其中 js/pro.js 原本在 REUSE 里，必须从 REUSE 摘出，否则 WebView 升级时仍从旧缓存
// 复制旧版 pro.js，隐藏规则会失效、「视线」按钮照旧可见，与新版 manifest 口径不符。
const CACHE = 'inkreader-v20';
const PREV_CACHE = 'inkreader-v19';
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
// v1.4.0 Aurora 能力中心：index.html 直接 link css/aurora.css，app.js → aurora.js →
// aurora-core.js → aurora-registry.js。v17 补齐这条模块图，避免离线首启缺样式/脚本。
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/pro.css',
  'css/plus.css',
  'css/stats.css',
  'css/nexus.css',
  'css/aurora.css',
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
  'js/aurora.js',
  'js/aurora-core.js',
  'js/aurora-registry.js',
  'js/importer-worker.js',
  'js/vendor/fflate.js',
  'js/vendor/pdf.min.js',
  'js/vendor/pdf.worker.min.js',
  'js/release-gate.js',
  'css/release-review.css',
];

// 相对上一版内容完全没变的文件：升级时直接从旧缓存复制，不产生任何网络/磁盘重复下载。
// 注意：v16 新增的 release-gate.js / release-review.css、变更过的 index.html，
// 以及 v17 变更过的 css/aurora.css、js/aurora.js 与新增的 aurora-core.js /
// aurora-registry.js 都不在此列，必须从 APK 包内取新版本。
// v18 变更的 index.html / app.js / aurora.js / aurora.css / aurora-registry.js 同理。
// v20 变更的 js/pro.js 已从本列表摘出（见文件头注释）；js/gaze.js 未改动，可继续复用。
// 这就是「增量缓存」的核心：版本一变就清空重建，对离线 WebView 既慢又容易留空洞。
const REUSE = [
  'manifest.webmanifest',
  // css/style.css 在 v15 已变更，升级时必须取新版本，不能从旧缓存复用
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
  // js/pro.js 在 v20 已变更（送审版隐藏视线翻页入口），必须从 APK 包内取新版本，不能复用旧缓存
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
