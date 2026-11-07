// 水杉阅读 —— Service Worker（离线缓存应用外壳）
// 缓存版本号：每次改动 ASSETS 列表里的任意文件（尤其 js/app.js 等自身脚本）都必须 +1，
// 否则 WebView 升级后会继续从旧缓存喂回旧文件，导致修好的 bug 在真机“看起来没修”。
const CACHE = 'inkreader-v9';
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
// 之前漏了 ai.js / llm.js / importer-worker.js，这里一并补齐。
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/pro.css',
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
  'js/importer-worker.js',
  'js/vendor/fflate.js',
  'js/vendor/pdf.min.js',
  'js/vendor/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 逐项 add：任一可选资源（如未随包分发的视线模型）404 不会让整个安装卡在 waiting。
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
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
