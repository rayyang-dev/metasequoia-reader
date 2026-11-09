// PDF 阅读支持：用 pdf.js 按需动态加载，把每一页渲染为图片（适配扫描/图片型 PDF）
// 文字层缺失的 PDF 无法重排，整页图片渲染是墨水屏上最稳的阅读方式。
let pdfjsMod = null;

async function getPdfjs() {
  if (!pdfjsMod) {
    pdfjsMod = await import('./vendor/pdf.min.js');
    pdfjsMod.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;
  }
  return pdfjsMod;
}

// 打开 PDF，返回 doc 句柄（持有 pdfBytes）
// 注意：pdf.js 在 worker 模式下会“转移(detach)”传入的 ArrayBuffer，
// 因此这里传入副本，保护调用方的原始字节（存库/二次打开不会被破坏）。
export async function openPdf(uint8) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: uint8.slice() }).promise;
}

// 把第 pageIndex 页渲染为 JPEG dataURL；targetW 控制清晰度上限，避免吃内存
export async function renderPdfPage(doc, pageIndex, targetW) {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = targetW / base.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.82);
  if (page.cleanup) page.cleanup();
  return { url, w: canvas.width, h: canvas.height };
}
