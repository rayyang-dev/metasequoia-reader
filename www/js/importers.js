// 内容导入：TXT（自动分段 + 章节检测）与 EPUB（fflate 解压，解析 OPF/NCX/NAV，内联图片，抽取目录）
import { openPdf } from './pdfview.js';
import { parseMobi } from './mobidec.js';
import { sanitizeBookHtml } from './plus-core.js';
export { parseMobi };

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function normalizePath(p) {
  return decodeURIComponent(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------- TXT ----------------
export async function parseTxt(file) {
  const text = await file.text();
  const name = (file.name || '未命名').replace(/\.[^.]+$/, '');
  const rawLines = text.split(/\r?\n/).map((s) => s.trim());
  const chapterRe = /^(第[零一二三四五六七八九十百千0-9]+[章回卷部篇节]|chapter\s+\d+|序章|序言|前言|引言|尾声|后记|附录)/i;

  const chapters = [];
  let cur = { title: name, paras: [] };
  for (const line of rawLines) {
    if (!line) continue;
    if (chapterRe.test(line)) {
      if (cur.paras.length > 0) {
        chapters.push(cur);
        cur = { title: line, paras: [] };
      } else {
        cur.title = line; // 首个标题直接作为当前章标题
      }
    } else {
      cur.paras.push(line);
    }
  }
  if (cur.paras.length > 0) chapters.push(cur);

  if (!chapters.length) {
    chapters.push({ title: name, paras: rawLines.filter(Boolean) });
  }
  const built = chapters.map((c) => ({
    title: c.title,
    html: '<p>' + c.paras.join('</p><p>') + '</p>',
  }));
  return {
    id: 'txt-' + hash(name + Date.now()),
    title: name,
    author: '',
    source: 'txt',
    chapters: built,
  };
}

// ---------------- EPUB ----------------
export async function parseEpub(file) {
  if (!file || !file.arrayBuffer) throw new Error('传入的不是有效文件对象');
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (e) {
    throw new Error('读取文件失败：' + (e && e.message ? e.message : e));
  }
  let files;
  try {
    files = await unzipEntries(new Uint8Array(buf));
  } catch (e) {
    throw new Error('EPUB 解压失败（可能不是标准 EPUB/ZIP，或为加密书）：' + (e && e.message ? e.message : e));
  }
  if (!Object.keys(files).length) throw new Error('EPUB 为空或不是有效 ZIP 包');

  // 1. container.xml -> OPF
  const container = decode(files[normalizePath('META-INF/container.xml')]);
  if (!container) throw new Error('EPUB 结构异常：缺少 META-INF/container.xml');
  const opfPath = (container.match(/full-path="([^"]+)"/) || container.match(/full-path='([^']+)'/))[1];
  if (!opfPath) throw new Error('无法从 container.xml 定位 OPF 文件');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfText = decode(files[normalizePath(opfPath)]);
  if (!opfText) throw new Error('无法读取 OPF 文件');

  // 2. manifest + spine
  const manifest = parseManifest(opfText);
  const spine = parseSpine(opfText);

  // 3. TOC（nav / ncx）
  const tocMap = findTocMap(opfText, files, opfDir);

  // 4. 构建章节
  const chapters = [];
  const images = {}; // 抽取出的图片字节：路径 -> { b: Uint8Array, m: mime }，渲染当页时才转 blob URL
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item) continue;
    const mt = (item.mediaType || '').toLowerCase();
    if (!/html|xhtml|xml/.test(mt) && !/\.x?html?$/.test(item.href)) continue;
    const fullKey = normalizePath(joinPath(opfDir, item.href));
    const raw = files[fullKey];
    if (!raw) continue;
    let html = decode(raw);
    html = extractBody(html);
    // 图片 src 相对的是 XHTML 自身所在目录，而非 OPF 目录（否则分目录存放图片的 EPUB 会全部裂图）
    const chapterDir = fullKey.includes('/') ? fullKey.slice(0, fullKey.lastIndexOf('/') + 1) : '';
    html = inlineImages(html, chapterDir, files, images);
    html = sanitize(html);
    const title = findTitle(html, tocMap, fullKey, chapters.length);
    // src 记录该章节在 EPUB 包内的原始路径：跨文件脚注 href（如 ../Text/chapter91.xhtml#m28）
    // 必须靠它把「注释所在章节」精确定位出来，否则 m28 / w28 这类 id 在全书会重复十几次。
    chapters.push({ title, html, src: fullKey });
  }
  if (!chapters.length) throw new Error('未在 EPUB 中找到可读章节（spine 指向的内容文件可能缺失或被加密）');

  const title = (opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i) || [])[1] || (file.name || '未命名').replace(/\.[^.]+$/, '');
  const author = (opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i) || [])[1] || '';
  return {
    id: 'epub-' + hash(title + author + Date.now()),
    title: title.trim(),
    author: author.trim(),
    source: 'epub',
    chapters,
    images,
  };
}

// ---- 后台解压（Worker），主线程同步兜底 ----
// 大书解压放在 Worker，避免主线程冻屏；Worker 不可用或异常时回退到主线程同步解压。
let _unzipWorker = null;
function getUnzipWorker() {
  if (_unzipWorker === null) {
    try {
      _unzipWorker = new Worker('js/importer-worker.js');
    } catch (e) {
      _unzipWorker = false; // 标记不可用，不再重试
    }
  }
  return _unzipWorker || null;
}
async function unzipEntries(uint8) {
  const w = getUnzipWorker();
  if (w) {
    try {
      const raw = await new Promise((resolve, reject) => {
        const id = 'uz' + Math.random().toString(36).slice(2);
        const clean = () => {
          w.removeEventListener('message', onMsg);
          w.removeEventListener('error', onErr);
        };
        const onMsg = (e) => {
          const d = e.data;
          if (!d || d.id !== id) return;
          clean();
          if (d.error) reject(new Error('解压失败：' + d.error));
          else resolve(d.files);
        };
        const onErr = (err) => {
          clean();
          // Worker 加载/运行失败：禁用后台解压，本次回退同步解压
          _unzipWorker = false;
          reject(new Error('后台解压不可用，回退主线程'));
        };
        w.addEventListener('message', onMsg);
        w.addEventListener('error', onErr);
        // 不 transfer：保留主线程缓冲，Worker 异常时可安全回退同步解压
        w.postMessage({ type: 'unzip', id, buf: uint8 });
      });
      const map = {};
      for (const k in raw) map[normalizePath(k)] = raw[k];
      return map;
    } catch (e) {
      // Worker 失败（极少）：回退主线程同步解压
      const ff = window.fflate;
      if (!ff) throw e;
      const out = ff.unzipSync(uint8);
      const map = {};
      for (const k in out) map[normalizePath(k)] = out[k];
      return map;
    }
  }
  // 无 Worker 环境：主线程同步解压
  const ff = window.fflate;
  if (!ff) throw new Error('解压库（fflate）未加载，请刷新页面后重试');
  const out = ff.unzipSync(uint8);
  const map = {};
  for (const k in out) map[normalizePath(k)] = out[k];
  return map;
}

function decode(uint8) {
  if (!uint8) return '';
  let s = new TextDecoder('utf-8', { fatal: false }).decode(uint8);
  // 大量替换符说明编码非 UTF-8，尝试 GBK（老版中文 EPUB）
  const bad = (s.match(/\ufffd/g) || []).length;
  if (bad > s.length * 0.02 && bad > 5) {
    try {
      s = new TextDecoder('gbk', { fatal: false }).decode(uint8);
    } catch (e) {}
  }
  return s;
}

function parseManifest(opf) {
  const map = {};
  const itemRe = /<item\b([^>]*)>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[1];
    const id = (tag.match(/id="([^"]+)"/i) || [])[1];
    const href = (tag.match(/href="([^"]+)"/i) || [])[1];
    const mediaType = (tag.match(/media-type="([^"]+)"/i) || [])[1];
    if (id && href) map[id] = { href, mediaType };
  }
  return map;
}
function parseSpine(opf) {
  const m = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
  if (!m) return [];
  const refs = [];
  const re = /<itemref\b[^>]*idref="([^"]+)"/gi;
  let r;
  while ((r = re.exec(m[1]))) refs.push(r[1]);
  return refs;
}

function findTocMap(opf, files, opfDir) {
  const map = new Map();
  const itemRe = /<item\b([^>]*)>/gi;
  let m;
  let navItem = null;
  let ncxItem = null;
  while ((m = itemRe.exec(opf))) {
    const tag = m[1];
    if (/properties="[^"]*nav[^"]*"/i.test(tag) && !navItem) navItem = tag;
    if (/media-type="application\/x-dtbncx\+xml"/i.test(tag) && !ncxItem) ncxItem = tag;
  }
  if (navItem) {
    const href = (navItem.match(/href="([^"]+)"/i) || [])[1];
    const html = decode(files[normalizePath(opfDir + href)] || files[normalizePath(href)]);
    if (html) collectNav(html, map, opfDir);
  } else if (ncxItem) {
    const href = (ncxItem.match(/href="([^"]+)"/i) || [])[1];
    const xml = decode(files[normalizePath(opfDir + href)] || files[normalizePath(href)]);
    if (xml) collectNcx(xml, map, opfDir);
  }
  return map;
}
function collectNav(html, map, opfDir) {
  const navMatch =
    html.match(/<nav\b[^>]*epub:type="[^"]*toc[^"]*"[^>]*>([\s\S]*?)<\/nav>/i) ||
    html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  const body = navMatch ? navMatch[1] : html;
  const aRe = /<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(body))) {
    // 目录链接相对于 nav 文档所在目录（通常即 OPF 目录），解析后与章节 fullKey 对齐
    const href = normalizePath(joinPath(opfDir, m[1].split('#')[0]));
    const label = m[2].replace(/<[^>]+>/g, '').trim() || '章节';
    if (!map.has(href)) map.set(href, label);
  }
}
function collectNcx(xml, map, opfDir) {
  const npRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
  let m;
  while ((m = npRe.exec(xml))) {
    const np = m[1];
    const text = (np.match(/<text>([\s\S]*?)<\/text>/i) || [])[1] || '';
    const src = (np.match(/<content\s+src="([^"]+)"/i) || [])[1] || '';
    if (src) {
      const href = normalizePath(joinPath(opfDir, src.split('#')[0]));
      const label = text.replace(/<[^>]+>/g, '').trim() || '章节';
      if (!map.has(href)) map.set(href, label);
    }
  }
}

function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = m ? m[1] : html;
  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '');
  return body;
}
// 书籍 HTML 是不可信输入：导入后会被注入活跃 DOM（分页测量容器 + 阅读页），
// 残留事件属性 / javascript: / 外链资源就可能在 WebView 里执行脚本或静默外联。
// v1.1.18 起由 plus-core.js 的「正则预清洗 → DOMParser 白名单重建 → 结构守卫回退」统一处理：
// 白名单覆盖没列全的元素与属性（animate / foreignObject / srcdoc 变体等），
// SVG 子树用占位符原样保护，避免 HTML 解析器把 <image> 改名 <img> 而破坏 EPUB 插图与脚注。
function sanitize(html) {
  return sanitizeBookHtml(html);
}
function findTitle(html, tocMap, fullKey, idx) {
  if (tocMap.has(fullKey)) return tocMap.get(fullKey);
  const h = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (h) return h[1].replace(/<[^>]+>/g, '').trim();
  return '第 ' + (idx + 1) + ' 节';
}

function inlineImages(html, baseDir, files, images) {
  // 不内联 base64：避免章节 HTML 在内存/IndexedDB 随图膨胀、且整章图一次性解码。
  // 改为抽取图片字节存入 images 映射，章节 HTML 仅留 <img data-img="路径"> 占位，
  // 真正解码延迟到阅读器渲染当页时才做（见 app.js resolvePageImages）。
  // 同时处理 <img> 与 SVG <image>，兼容双/单引号，支持 src / href / xlink:href
  const tagRe = /<(img|image)\b([^>]*?)\/?>/gi;
  let result = '';
  let last = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    const inner = m[2];
    const attrRe = /\b(src|xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/i;
    const am = inner.match(attrRe);
    let replacement = full;
    if (am) {
      const val = am[3] !== undefined ? am[3] : am[4]; // 双引号组3 / 单引号组4
      if (val && !/^(https?:|data:)/i.test(val)) {
        const rel = val.split('#')[0]; // 去掉可能的 fragment
        const abs = normalizePath(joinPath(baseDir, rel));
        const data = files[abs];
        if (data) {
          const mime = mimeFromName(val);
          images[abs] = { b: data, m: mime }; // 原始字节 + MIME，渲染时再转 blob URL
          replacement = full.replace(am[0], 'data-img="' + abs + '"');
        }
      }
    }
    result += html.slice(last, m.index) + replacement;
    last = m.index + full.length;
  }
  result += html.slice(last);
  return result;
}
function joinPath(base, rel) {
  if (/^(https?:|data:)/i.test(rel)) return rel;
  const b = base.replace(/\/$/, '');
  let parts = (b ? b.split('/') : []).concat(rel.split('/'));
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}
function mimeFromName(name) {
  const ext = name.split('.').pop().toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext] || 'image/png'
  );
}
function bytesToBase64(bytes) {
  let binary = '';
  // 分块上限设为 0x4000(16384)：String.fromCharCode.apply 的参数个数接近引擎上限时会抛栈溢出，
  // 大封面图（base64 后常 > 数百 KB）分块更小更稳。
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------- PDF ----------------
export async function parsePdf(file) {
  const data = await file.arrayBuffer();
  const uint8 = new Uint8Array(data);
  const doc = await openPdf(uint8);
  const numPages = doc.numPages;
  const chapters = [];
  for (let i = 0; i < numPages; i++) chapters.push({ title: `第 ${i + 1} 页`, isPdfPage: true, pageIndex: i });

  // 目录：把 outline 条目的真实页码映射成章节标题（best-effort）
  try {
    const outline = (await doc.getOutline()) || [];
    for (const n of outline) {
      if (!n || !n.title) continue;
      let pageIdx = null;
      try {
        if (n.dest) {
          const d = await doc.getDestination(n.dest);
          if (d && d[0]) pageIdx = await doc.getPageIndex(d[0]);
        }
      } catch (e) {}
      if (pageIdx != null && pageIdx >= 0 && pageIdx < chapters.length) {
        chapters[pageIdx].title = String(n.title).trim();
      }
    }
  } catch (e) {}

  let info = {};
  try { info = (await doc.getMetadata()).info || {}; } catch (e) {}
  const title = (info.Title && String(info.Title).trim()) || file.name.replace(/\.pdf$/i, '');
  const author = info.Author ? String(info.Author).trim() : '';
  await doc.destroy();

  return {
    id: 'pdf-' + hash(title + Date.now()),
    title,
    author,
    source: 'pdf',
    numPages,
    pdfBytes: uint8, // 原始字节存本地，阅读时再按需渲染
    chapters,
  };
}

// ================= 通用小工具（FB2 / HTML / DOCX 共用） =================
function esc(s) {
  // 必须转义引号：FB2 会把 href 拼进双引号属性，不转义即可属性逃逸注入。
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function localNameOf(node) { return node.localName || node.nodeName || ''; }
function byLocal(root, name) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 1 && localNameOf(n) === name) out.push(n);
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(root);
  return out;
}
function getAttr(node, n) {
  for (const cand of [n, 'w:' + n, 'xlink:' + n, 'l:' + n]) {
    const v = node.getAttribute(cand);
    if (v != null) return v;
  }
  return '';
}
function sanitizeHtml(html) {
  return sanitize(html); // FB2 / HTML / DOCX 与 EPUB 共用同一套净化规则
}

// ================= FB2（FictionBook，纯 XML，DOMParser 直解） =================
export async function parseFb2(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('FB2 解析失败：不是有效的 XML 文件');
  const fb = doc.documentElement;

  let title = (file.name || '未命名').replace(/\.[^.]+$/, '');
  let author = '';
  const titleInfo = byLocal(fb, 'title-info')[0];
  if (titleInfo) {
    const bt = byLocal(titleInfo, 'book-title')[0];
    if (bt && bt.textContent.trim()) title = bt.textContent.trim();
    const a = byLocal(titleInfo, 'author')[0];
    if (a) {
      const fn = byLocal(a, 'first-name')[0];
      const ln = byLocal(a, 'last-name')[0];
      author = [ln && ln.textContent, fn && fn.textContent].filter(Boolean).join(' ').trim();
    }
  }

  // 内嵌二进制图片 -> 抽取为 data URI 条目（不内联进章节 HTML，渲染当页再解析）
  const images = {};
  for (const b of byLocal(doc, 'binary')) {
    const id = b.getAttribute('id');
    const ct = b.getAttribute('content-type') || 'image/jpeg';
    const data = (b.textContent || '').replace(/\s+/g, '').trim();
    if (id && data) images['#' + id] = { s: 'data:' + ct + ';base64,' + data };
  }

  const body = byLocal(fb, 'body')[0];
  const sections = body ? Array.from(body.children).filter((c) => localNameOf(c) === 'section') : [];
  const chapters = [];
  if (sections.length) {
    for (const sec of sections) {
      const t = Array.from(sec.children).find((c) => localNameOf(c) === 'title');
      const title2 = t ? t.textContent.trim() : '章节';
      const clone = sec.cloneNode(true);
      const firstTitle = Array.from(clone.children).find((c) => localNameOf(c) === 'title');
      if (firstTitle) firstTitle.remove();
      chapters.push({ title: title2 || '章节', html: fb2NodeToHtml(clone, images) });
    }
  } else {
    chapters.push({ title, html: fb2NodeToHtml(body || fb, images) });
  }
  if (!chapters.some((c) => c.html.replace(/<[^>]+>/g, '').trim())) {
    chapters.length = 0;
    chapters.push({ title, html: '<p></p>' });
  }
  return { id: 'fb2-' + hash(title + author + Date.now()), title, author, source: 'fb2', chapters, images };
}
function fb2NodeToHtml(node, images) {
  if (node.nodeType === 3) return esc(node.nodeValue);
  if (node.nodeType !== 1) return '';
  const tag = localNameOf(node);
  if (tag === 'image') {
    const ref = getAttr(node, 'href');
    const entry = images[ref];
    return entry ? '<img data-img="' + ref + '" alt="" />' : '';
  }
  const kids = Array.from(node.childNodes).map((c) => fb2NodeToHtml(c, images)).join('');
  switch (tag) {
    case 'p': return '<p>' + kids + '</p>';
    case 'title': return '<h2>' + kids + '</h2>';
    case 'subtitle': return '<h3>' + kids + '</h3>';
    case 'epigraph': return '<blockquote class="epigraph">' + kids + '</blockquote>';
    case 'text-author': return '<p class="text-author">' + kids + '</p>';
    case 'poem': return '<div class="poem">' + kids + '</div>';
    case 'stanza': return '<div class="stanza">' + kids + '</div>';
    case 'v': return '<p class="verse">' + kids + '</p>';
    case 'cite': return '<blockquote>' + kids + '</blockquote>';
    case 'code': return '<pre>' + kids + '</pre>';
    case 'strong': return '<strong>' + kids + '</strong>';
    case 'emphasis': return '<em>' + kids + '</em>';
    case 'a': case 'link': return '<a href="' + esc(getAttr(node, 'href') || '#') + '">' + kids + '</a>';
    case 'empty-line': return '<br />';
    case 'section': return kids;
    case 'body': return kids;
    default: return kids;
  }
}

// ================= HTML / HTM（提取正文，按标题分章） =================
export async function parseHtml(file) {
  const text = await file.text();
  const name = (file.name || '未命名').replace(/\.[^.]+$/, '');
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script,style,link,meta').forEach((e) => e.remove());
  const body = doc.body || doc.documentElement;
  const headingRe = /^h[1-3]$/i;
  const chapters = [];
  let cur = null;
  const close = () => {
    if (cur) {
      const inner = cur.parts.join('');
      if (inner.replace(/<[^>]+>/g, '').trim()) chapters.push({ title: cur.title, html: inner });
      cur = null;
    }
  };
  for (const el of Array.from(body.children)) {
    const tn = (el.tagName || '').toLowerCase();
    if (headingRe.test(tn)) {
      close();
      const htext = (el.textContent || '').trim();
      cur = { title: htext || '第 ' + (chapters.length + 1) + ' 节', parts: [] };
      cur.parts.push('<' + tn + '>' + esc(el.textContent || '') + '</' + tn + '>');
    } else {
      if (!cur) cur = { title: name, parts: [] };
      cur.parts.push(sanitizeHtml(el.outerHTML));
    }
  }
  close();
  if (!chapters.length) chapters.push({ title: name, html: sanitizeHtml(body.innerHTML) });
  const metaTitle = doc.querySelector('title');
  const title = (metaTitle && metaTitle.textContent.trim()) || name;
  return { id: 'html-' + hash(name + Date.now()), title, author: '', source: 'html', chapters };
}

// ================= DOCX（OOXML Word，复用 fflate 解压） =================
export async function parseDocx(file) {
  let files;
  try {
    files = await unzipEntries(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    throw new Error('DOCX 解压失败（可能不是有效的 .docx / ZIP 包）：' + (e && e.message ? e.message : e));
  }
  const xml = decode(files['word/document.xml'] || files['word/document2.xml']);
  if (!xml) throw new Error('DOCX 结构异常：缺少 word/document.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('DOCX 正文解析失败');

  const styleMap = parseDocxStyleMap(decode(files['word/styles.xml']));
  const body = byLocal(doc.documentElement, 'body')[0] || doc.documentElement;
  const paras = byLocal(body, 'p');

  const chapters = [];
  let cur = null;
  const newChap = (t) => ({ title: t || '未命名', parts: [], has: false });
  for (const p of paras) {
    const pPr = byLocal(p, 'pPr')[0];
    let styleId = '';
    let numId = null;
    if (pPr) {
      const ps = byLocal(pPr, 'pStyle')[0];
      if (ps) styleId = getAttr(ps, 'val') || '';
      const numPr = byLocal(pPr, 'numPr')[0];
      if (numPr) { const n = byLocal(numPr, 'numId')[0]; if (n) numId = getAttr(n, 'val'); }
    }
    const headingLevel = styleMap.heading[styleId];
    const html = docxRunsToHtml(p);
    const txt = docxStripText(p);
    if (headingLevel && txt) {
      if (cur && cur.has) chapters.push(cur);
      cur = newChap(txt);
      cur.parts.push('<h' + headingLevel + '>' + esc(txt) + '</h' + headingLevel + '>');
      cur.has = true;
    } else if (numId != null && numId !== '0') {
      if (!cur) cur = newChap('正文');
      if (html.trim()) { cur.parts.push('<li>' + html + '</li>'); cur.has = true; }
    } else {
      if (!cur) cur = newChap('正文');
      if (html.trim()) { cur.parts.push('<p>' + html + '</p>'); cur.has = true; }
    }
  }
  if (cur && cur.has) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: file.name.replace(/\.[^.]+$/, ''), html: '<p></p>' });

  const core = decode(files['docProps/core.xml']);
  const mt = (core.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i) || [])[1];
  const ma = (core.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i) || [])[1];
  const title = (mt && mt.trim()) || file.name.replace(/\.[^.]+$/, '');
  const author = (ma && ma.trim()) || '';
  return {
    id: 'docx-' + hash(title + author + Date.now()),
    title, author, source: 'docx',
    chapters: chapters.map((c) => ({ title: c.title, html: c.parts.join('') })),
  };
}
function parseDocxStyleMap(stylesXml) {
  const map = { heading: {} };
  if (!stylesXml) return map;
  const re = /<w:style\b([^>]*?w:styleId="([^"]+)"[^>]*?)>([\s\S]*?)<\/w:style>/gi;
  let m;
  while ((m = re.exec(stylesXml))) {
    const sid = m[2];
    const inner = m[3];
    const name = (inner.match(/w:name\b[^>]*?w:val="([^"]+)"/i) || inner.match(/w:val="([^"]+)"/i) || [])[1] || '';
    const hm = name.match(/heading\s*(\d)/i);
    if (hm) map.heading[sid] = Math.min(6, parseInt(hm[1], 10));
    else if (/title/i.test(name)) map.heading[sid] = 1;
  }
  return map;
}
function docxRunsToHtml(p) {
  const runs = byLocal(p, 'r');
  if (!runs.length) return esc(p.textContent || '');
  return runs.map(docxRunToHtml).join('');
}
function docxRunToHtml(r) {
  const rPr = byLocal(r, 'rPr')[0];
  let b = false, i = false;
  if (rPr) { b = byLocal(rPr, 'b').length > 0; i = byLocal(rPr, 'i').length > 0; }
  let out = '';
  for (const n of Array.from(r.childNodes)) {
    const ln = localNameOf(n);
    if (n.nodeType === 3) out += esc(n.nodeValue || '');
    else if (ln === 't') out += esc(n.textContent || '');
    else if (ln === 'br') out += '<br/>';
    else if (ln === 'tab') out += '&nbsp;&nbsp;';
    else if (ln === 'noBreakHyphen') out += '-';
  }
  if (b) out = '<b>' + out + '</b>';
  if (i) out = '<i>' + out + '</i>';
  return out;
}
function docxStripText(el) {
  return byLocal(el, 't').map((t) => t.textContent).join('').trim();
}
