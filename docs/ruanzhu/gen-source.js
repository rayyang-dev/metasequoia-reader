// 一次性脚本：把红杉 Sequoia 自有源码整理为软著要求的「源代码」提交件。
// 规则：前 30 页 + 后 30 页，每页 ≥ 50 行（末页可不足），含页眉软件名/版本/页码。
// 运行：node docs/ruanzhu/gen-source.js  ->  生成 docs/ruanzhu/源代码整理.txt
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOFT = '红杉 Sequoia';
const VER = 'V1.0.0';

// 按顺序纳入「自有」源码（排除第三方 vendor / node_modules / 构建产物）
const FILES = [
  'www/index.html',
  'www/css/style.css',
  'www/js/app.js',
  'www/js/store.js',
  'www/js/paginate.js',
  'www/js/importers.js',
  'www/js/ai.js',
  'www/js/llm.js',
  'www/js/translate.js',
  'www/js/mobidec.js',
  'www/js/pdfview.js',
  'android/app/src/main/java/com/rayyang/metasequoia/MainActivity.java',
  'android/app/src/main/AndroidManifest.xml',
];

const PAGE_LINES = 50;
const HEAD = `${SOFT} ${VER}  源代码（前30页 + 后30页，每页≥50行）`;
const pages = []; // each = array of lines

for (const f of FILES) {
  const full = path.join(ROOT, f);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    console.warn('跳过（不存在）:', f);
    continue;
  }
  const lines = text.split(/\r?\n/);
  pages.push([`/* ===== 文件: ${f} ===== */`]);
  for (const ln of lines) pages.push([ln]);
}

// 扁平化为行数组
const all = [];
for (const p of pages) for (const ln of p) all.push(ln);

// 分页（每页 50 行）
const chunks = [];
for (let i = 0; i < all.length; i += PAGE_LINES) chunks.push(all.slice(i, i + PAGE_LINES));
const total = chunks.length;

// 取前 30 与后 30（总量不足 60 则取全部）
let selected;
if (total <= 60) selected = chunks.map((c, i) => ({ idx: i, lines: c }));
else {
  const front = chunks.slice(0, 30).map((c, i) => ({ idx: i, lines: c }));
  const back = chunks.slice(total - 30).map((c, i) => ({ idx: total - 30 + i, lines: c }));
  selected = front.concat(back);
}

const out = [];
out.push(HEAD);
out.push(`生成时间：${new Date().toISOString().slice(0, 10)}   源文件数：${FILES.length}   源码总行数：${all.length}   分页总数：${total}`);
out.push('（软著提交件：前30页+后30页，每页≥50行）');
out.push('='.repeat(60));
for (const s of selected) {
  out.push(`------ 第 ${s.idx + 1} 页 / 共 ${total} 页 ------`);
  let n = 0;
  for (const ln of s.lines) { out.push(ln); n++; }
  // 末页可不足 50 行；非末页若不足则在提交时由打印设置补足，这里原样保留
  if (n < PAGE_LINES) out.push(`（本页 ${n} 行）`);
  out.push('');
}

const dest = path.join(__dirname, '源代码整理.txt');
fs.writeFileSync(dest, out.join('\n'), 'utf8');
console.log('已生成:', dest);
console.log('源码总行数:', all.length, ' 分页总数:', total, ' 选用页:', selected.length);
