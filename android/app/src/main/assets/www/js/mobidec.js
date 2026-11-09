// MOBI / Mobipocket 解析（纯前端实现）
// 支持：compression=1(PalmDOC) / compression=2(Mobipocket 内置字节流压缩, 含 UTF-8 多字节)
// 不支持：DRM(encryption!=0)、KF8/AZW3 复杂结构（降级到 Calibre 引导）
// 算法参考 Mobipocket 内置压缩 + calibre mobi 解析思路，已对多字节 UTF-8 做逐字节处理。

function be32(buf, o) {
  return (buf[o] * 0x1000000 + buf[o + 1] * 0x10000 + buf[o + 2] * 0x100 + buf[o + 3]) >>> 0;
}
function be16(buf, o) {
  return buf[o] * 0x100 + buf[o + 1];
}

// ---- PalmDB 头解析 ----
export function parsePalmDB(buf) {
  const type = String.fromCharCode(buf[60], buf[61], buf[62], buf[63]);
  const creator = String.fromCharCode(buf[64], buf[65], buf[66], buf[67]);
  const numRec = be16(buf, 76);
  const recOff = [];
  for (let i = 0; i < numRec; i++) recOff.push(be32(buf, 78 + i * 8));
  return { type, creator, numRec, recOff };
}

// ---- Mobipocket 内置字节流解压缩（多字节安全） ----
// 直接对字节流操作：1-8=字面复制 c 字节；9-0x7F=字面字符(9=空格)；0x80-0xBF=后向引用；0xC0-0xFF=空格+字符
function mobipocketDecode(data) {
  const out = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    const c = data[i++];
    if (c === 0) break; // 0x00 结束
    if (c <= 8) {
      // 1-8：复制 c 个字面字节
      for (let k = 0; k < c && i < n; k++) out.push(data[i++]);
    } else if (c < 0x80) {
      out.push(c === 0x09 ? 0x20 : c);
    } else if (c < 0xc0) {
      // 0x80-0xBF：2 字节后向引用
      if (i >= n) break;
      const c2 = data[i++];
      const concat = (c << 8) | c2;
      const distance = (concat >> 3) & 0x7ff;
      let length = (concat & 7) + 3;
      let s = out.length - distance;
      if (s < 0) { length += s; s = 0; } // 越界则裁剪
      for (let k = 0; k < length; k++) out.push(s + k < out.length ? out[s + k] : 0x20);
    } else {
      // 0xC0-0xFF：空格 + 字符(b ^ 0x80)
      out.push(0x20);
      out.push(c ^ 0x80);
    }
  }
  return out;
}

// 把解码后的字节数组（可能含跨记录残余）按 UTF-8 安全转为字符串，去掉无效字节
function bytesToUtf8Safe(bytes) {
  // 去掉末尾不完整的多字节序列
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] >= 0x80 && bytes[end - 1] < 0xc0) end--;
  let s = '';
  let i = 0;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i++; }
    else if (b >= 0xc0) {
      // 尝试按 UTF-8 解码一个码点
      let extra = 0;
      if (b >= 0xf0) extra = 3; else if (b >= 0xe0) extra = 2; else extra = 1;
      if (i + extra < end) {
        try {
          const slice = bytes.slice(i, i + extra + 1);
          s += new TextDecoder('utf-8').decode(Uint8Array.from(slice));
          i += extra + 1;
        } catch (e) { s += '?'; i++; }
      } else { s += '?'; i++; }
    } else { s += '?'; i++; }
  }
  return s;
}

// ---- EXTH 解析（取标题/作者等元数据） ----
function parseExth(buf, exthOff) {
  const out = {};
  if (buf[exthOff] !== 0x45 || buf[exthOff + 1] !== 0x58 || buf[exthOff + 2] !== 0x54 || buf[exthOff + 3] !== 0x48) return out;
  const exthLen = be32(buf, exthOff + 4);
  let p = exthOff + 8;
  const end = exthOff + exthLen;
  while (p + 8 <= end) {
    const type = be32(buf, p);
    const len = be32(buf, p + 4);
    if (len < 8) break;
    const data = buf.slice(p + 8, p + len);
    out[type] = data;
    p += len;
  }
  return out;
}

// ---- 主入口：解析 MOBI 文件（ArrayBuffer）为章节对象 ----
export async function parseMobi(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const db = parsePalmDB(buf);
  if (db.type !== 'BOOK' && db.creator !== 'MOBI') {
    // 宽松校验：仍尝试继续
  }
  const r0 = db.recOff[0];
  const compression = be16(buf, r0 + 0);
  const encryption = be16(buf, r0 + 12);
  const textRecordCount = be16(buf, r0 + 8);
  if (encryption !== 0) {
    throw new Error('MOBI 文件已加密(DRM)，无法在应用内解密，请先用 Calibre 去除 DRM 后导入');
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error('不支持的 MOBI 压缩方式(compression=' + compression + ')，请改用 Calibre 转为 EPUB');
  }

  // 定位 MOBI 头
  let mobiOff = -1;
  for (let i = r0; i < r0 + 64 && i + 4 <= buf.length; i++) {
    if (buf[i] === 0x4d && buf[i + 1] === 0x4f && buf[i + 2] === 0x42 && buf[i + 3] === 0x49) { mobiOff = i; break; }
  }
  if (mobiOff < 0) throw new Error('无法定位 MOBI 头');
  const mobiHeaderLen = be32(buf, mobiOff + 4);
  const encoding = be32(buf, mobiOff + 12);
  const fullNameOffset = be32(buf, mobiOff + 68);
  const fullNameLength = be32(buf, mobiOff + 72);

  // 标题：优先 EXTH 503/504，否则用 MOBI fullName
  let title = '';
  let author = '';
  const exthOff = r0 + mobiHeaderLen;
  if (buf[exthOff] === 0x45 && buf[exthOff + 1] === 0x58 && buf[exthOff + 2] === 0x54 && buf[exthOff + 3] === 0x48) {
    const exth = parseExth(buf, exthOff);
    if (exth[503] || exth[504]) title = new TextDecoder('utf-8').decode(exth[503] || exth[504]).replace(/\0/g, '').trim();
    if (exth[100]) author = new TextDecoder('utf-8').decode(exth[100]).replace(/\0/g, '').trim();
  }
  if (!title && fullNameLength > 0) {
    title = new TextDecoder('utf-8').decode(buf.slice(r0 + fullNameOffset, r0 + fullNameOffset + fullNameLength)).replace(/\0/g, '').trim();
  }
  if (!title) title = (file.name || '未命名').replace(/\.[^.]+$/, '');

  // 找文本记录范围：记录 1 .. 首个非文本记录(INDX/FLIS/FCIS/图像/HUFF) 之前
  const isImage = (i) => buf[db.recOff[i]] === 0xff && buf[db.recOff[i] + 1] === 0xd8;
  let textEnd = db.numRec;
  for (let i = 1; i < db.numRec; i++) {
    const o = db.recOff[i];
    const m = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (['INDX', 'FLIS', 'FCIS', 'HUFF', 'CDIC', 'BOUN', 'SRCS', 'CRES'].includes(m) || isImage(i)) { textEnd = i; break; }
  }
  const lastText = textRecordCount > 0 ? Math.min(textRecordCount, textEnd - 1) : textEnd - 1;

  // 解码所有文本记录
  const decoded = [];
  for (let i = 1; i <= lastText; i++) {
    const o = db.recOff[i];
    const next = i + 1 < db.recOff.length ? db.recOff[i + 1] : buf.length;
    const rec = buf.subarray(o, next);
    const bytes = mobipocketDecode(rec);
    decoded.push(bytes);
  }
  // 拼接为 HTML 字节流后统一 UTF-8 解码
  const totalLen = decoded.reduce((a, b) => a + b.length, 0);
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const d of decoded) { merged.set(d, off); off += d.length; }
  let html = bytesToUtf8Safe(merged);

  // ---- HTML 清洗 ----
  html = cleanMobiHtml(html);

  // ---- 章节切分 ----
  const chapters = splitChapters(html);

  if (!chapters.length) {
    chapters.push({ title: title, html: '<p>（无正文内容）</p>' });
  }

  return {
    id: 'mobi-' + hashStr(title + author + Date.now()),
    title,
    author,
    source: 'mobi',
    chapters,
  };
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 清洗 MOBI 专有标签
function cleanMobiHtml(html) {
  let h = html;
  // 去掉 guide / reference
  h = h.replace(/<guide\b[^>]*>[\s\S]*?<\/guide>/gi, '');
  h = h.replace(/<reference\b[^>]*>/gi, '');
  h = h.replace(/<\/reference>/gi, '');
  // 去掉 filepos 属性（死锚点）
  h = h.replace(/\s+filepos="[^"]*"/gi, '');
  h = h.replace(/\s+recindex="[^"]*"/gi, '');
  // 去掉图片标签（无图像数据）
  h = h.replace(/<img\b[^>]*>/gi, '');
  // 去掉 mbp:pagebreak 之外的 mbp: 标签，但保留分页作为切分标记
  h = h.replace(/<mbp:pagebreak\s*\/?>/gi, '\n<!--PAGEBREAK-->\n');
  h = h.replace(/<\/?mbp:[^>]*>/gi, '');
  // 去掉无用的 head/meta
  h = h.replace(/<\/?head[^>]*>/gi, '');
  h = h.replace(/<meta\b[^>]*>/gi, '');
  // 清理 html/body 外壳（保留内部）
  h = h.replace(/<\/?html[^>]*>/gi, '');
  h = h.replace(/<\/?body[^>]*>/gi, '');
  // 普通化危险属性
  h = h.replace(/\son\w+="[^"]*"/gi, '');
  h = h.replace(/(href|src)="javascript:[^"]*"/gi, '$1="#"');
  return h;
}

// 基于分页标记切分章节，并按目标大小合并，避免章节过碎
function splitChapters(html) {
  const TARGET = 22000; // 每章目标字符数
  const parts = html.split(/<!--PAGEBREAK-->/i);
  const chapters = [];
  let cur = { title: '', html: '' };
  let curLen = 0;
  let idx = 0;
  const flush = () => {
    const text = stripTags(cur.html).replace(/\s+/g, '');
    if (text.length > 30) {
      const title = deriveTitle(cur.html) || ('第 ' + (chapters.length + 1) + ' 部分');
      chapters.push({ title, html: '<div>' + cur.html + '</div>' });
    }
    cur = { title: '', html: '' };
    curLen = 0;
  };
  for (let p of parts) {
    const tlen = p.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
    if (curLen > 0 && curLen + tlen > TARGET) flush();
    cur.html += p;
    curLen += tlen;
    idx++;
  }
  if (curLen > 0) flush();
  return chapters;
}

function deriveTitle(html) {
  // 取首个加粗/大号文本作为章节标题
  const m = html.match(/<b[^>]*>([\s\S]{2,40}?)<\/b>/i) || html.match(/<font[^>]*>([\s\S]{2,40}?)<\/font>/i);
  if (m) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 2 && t.length <= 40) return t;
  }
  const firstText = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return firstText || '';
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}
