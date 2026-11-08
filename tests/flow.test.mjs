// 红杉 — 端到端流程自测：真实「导入 MOBI → 取章节文本 → 调用翻译」整链路（Node 环境）
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const mobidec = await import(pathToFileURL(path.resolve('www/js/mobidec.js')).href);
const { translateText } = await import(pathToFileURL(path.resolve('www/js/translate.js')).href);

function makeFile(name, buf) {
  return { name, async arrayBuffer() { const ab = new ArrayBuffer(buf.length); new Uint8Array(ab).set(buf); return ab; } };
}
function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } }

console.log('=== 红杉 端到端流程：导入 MOBI → 翻译 ===');

const buf = await readFile('tests/samples/test.mobi');
const book = await mobidec.parseMobi(makeFile('test.mobi', buf));
ok(book && book.chapters.length > 0, 'MOBI 导入成功，章节数 = ' + book.chapters.length);

// 取一个正文章节的纯文本片段
let snippet = '';
for (const c of book.chapters) {
  const t = stripTags(c.html);
  if (t.length > 60) { snippet = t.slice(0, 160); break; }
}
ok(snippet.length > 0, '抽出可读文本片段（' + snippet.length + ' 字）：' + snippet.slice(0, 40) + '…');

// 链路：选中文字 → 翻译（演示提供方，离线）
const zh = await translateText(snippet, { provider: 'mock', dir: 'auto' });
ok(zh.from === 'en' && zh.to === 'zh', '自动识别方向 en→zh');
ok(zh.text.startsWith('[演示 中文]'), '返回译文（演示标记）');

// 反向：中文 → 英文
const en = await translateText('夜色像潮水一样漫过窗台，他合上那本读了三遍的书。', { provider: 'mock', dir: 'zh2en' });
ok(en.from === 'zh' && en.to === 'en' && en.text.startsWith('[演示 EN]'), '中文→英文 方向正确');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
