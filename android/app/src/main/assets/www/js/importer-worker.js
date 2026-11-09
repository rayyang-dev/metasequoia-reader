// EPUB / DOCX 后台解压 Worker
// 把 fflate.unzipSync 从主线程挪到后台线程，避免图片多的 EPUB、体积大的 DOCX
// 在主线程解压时冻屏（墨水屏设备 CPU 弱，大书尤为明显）。
// 经典 Worker：通过 importScripts 复用主线程已打包的 fflate（UMD 全局 self.fflate）。
importScripts('vendor/fflate.js');

self.onmessage = function (e) {
  var d = e.data;
  if (!d || d.type !== 'unzip') return;
  try {
    var ff = self.fflate;
    if (!ff || !ff.unzipSync) {
      self.postMessage({ id: d.id, error: '解压库未加载' });
      return;
    }
    var out = ff.unzipSync(new Uint8Array(d.buf));
    // 直接回传 fflate 的原始结果（键为 ZIP 内路径），键归一化在主线程完成，逻辑与旧版一致
    self.postMessage({ id: d.id, files: out });
  } catch (err) {
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
  }
};
