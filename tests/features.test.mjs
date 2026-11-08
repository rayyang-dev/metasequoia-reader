// 红杉 Sequoia — 全功能自测（核心数据层：设置 / 阅读统计打卡 / 日周月聚合 / 书架元数据）
// 运行：node tests/features.test.mjs
//
// 覆盖本次新增功能的纯逻辑层：
//   1) 设置默认值（含「打卡阈值」「书架按类型分组」、AI 引擎默认关闭可选）
//   2) 设置读写往返
//   3) 阅读计时 + 打卡阈值（跨阈值自动打卡、仅触发一次、按书分别累计）
//   4) 日 / 周 / 月 聚合（用固定参考日期，确定性、不随时间漂移）
//   5) 书架元数据（含 AI 标签，供按类型分组 / 标签筛选）
//
// 说明：store.js 在浏览器用 localStorage + IndexedDB；Node 下无这些全局，
// 这里注入一个最小 localStorage 垫片走真实 JSON 存取路径，IndexedDB 缺失则自动降级内存存储。

const path = await import('node:path');
const { pathToFileURL } = await import('node:url');

// 在 import store.js 之前注入最小 localStorage 垫片
globalThis.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
  clear() { this._s = {}; },
};

const store = await import(pathToFileURL(path.resolve('www/js/store.js')).href);
const {
  DEFAULT_SETTINGS, loadSettings, saveSettings,
  putBook, getBook, listBooksMeta,
  addReadingTime, aggregateStats, loadStats, saveStats, todayKey,
} = store;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } }
function dk(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

console.log('=== 红杉 全功能自测（设置 / 统计打卡 / 聚合 / 书架元数据）===');

// ---------- 1. 设置默认值 ----------
ok(DEFAULT_SETTINGS.checkinGoalMin === 10, '默认打卡阈值 = 10 分钟');
ok(DEFAULT_SETTINGS.shelfGroupByTag === false, '默认书架不按类型分组');
ok(DEFAULT_SETTINGS.translateProvider === 'none', 'AI 引擎默认关闭（可选、非强制）');
ok('translateLlmBase' in DEFAULT_SETTINGS && 'translateLlmModel' in DEFAULT_SETTINGS, 'AI 引擎含接口地址 / 模型默认项');

// ---------- 2. 设置读写往返 ----------
const s = loadSettings();
s.checkinGoalMin = 15;
s.shelfGroupByTag = true;
saveSettings(s);
const s2 = loadSettings();
ok(s2.checkinGoalMin === 15, '设置写入后读回 checkinGoalMin = 15');
ok(s2.shelfGroupByTag === true, '设置写入后读回 shelfGroupByTag = true');
ok(s2.fontSize === DEFAULT_SETTINGS.fontSize, '其它默认项未被破坏（fontSize 保持默认 ' + DEFAULT_SETTINGS.fontSize + '）');

// ---------- 3. 阅读计时 / 打卡阈值（用“今天”自洽，不依赖具体星期）----------
saveStats({});
const goalMs = loadSettings().checkinGoalMin * 60000; // 15 分钟
ok(goalMs === 900000, '打卡阈值换算毫秒 = 900000（15×60000）');

let r1 = addReadingTime('bookA', 14 * 60000);
ok(r1.dayStat && r1.dayStat.checkin === false && r1.justCheckedIn === false, '14 分钟（<阈值）未打卡');
let r2 = addReadingTime('bookA', 2 * 60000);
ok(r2.dayStat.checkin === true && r2.justCheckedIn === true, '累计达 16 分钟 ≥ 阈值 → 自动打卡，justCheckedIn=true');
let r3 = addReadingTime('bookA', 60000);
ok(r3.dayStat.checkin === true && r3.justCheckedIn === false, '已打卡后继续阅读不再重复触发 justCheckedIn');

// 按书分别累计
addReadingTime('bookB', 5 * 60000);
const today = loadStats()[todayKey()];
ok(today.byBook.bookA === 17 * 60000 && today.byBook.bookB === 5 * 60000, '按书分别累计（A=17m, B=5m）');
ok(today.checkin === true, '打卡状态按当日总量判定（仍为已打卡）');

// 负向 / 边界
const rNeg = addReadingTime('bookC', 0);
ok(rNeg.justCheckedIn === false && !rNeg.dayStat, '0 毫秒不计入');
const rBad = addReadingTime('', 1000);
ok(rBad.justCheckedIn === false && !rBad.dayStat, '空 bookId 不计入');

// ---------- 4. 日 / 周 / 月 聚合（固定参考日期 2026-06-17，确定性）----------
const REF = new Date(2026, 5, 17); // 2026-06-17
const synth = {};
// 6 月每天 10 分钟；指定日 22 分钟；5 月 31 日 999 分钟（应被排除在 6 月之外）
for (let d = 1; d <= 30; d++) synth[dk(2026, 6, d)] = { byBook: { x: 10 * 60000 }, checkin: true, checkinAt: 1 };
synth[dk(2026, 6, 17)] = { byBook: { x: 22 * 60000 }, checkin: true, checkinAt: 1 };
synth[dk(2026, 5, 31)] = { byBook: { x: 999 * 60000 }, checkin: true, checkinAt: 1 };

const dayAgg = aggregateStats(synth, 'day', REF);
ok(Math.round(dayAgg.totalMs / 60000) === 22, '日聚合：指定日 22 分钟');
ok(dayAgg.checkinDays === 1, '日聚合：打卡 1 天');

// 周窗口（周一为起点）—— 在测试内按相同规则重算期望，校验边界逻辑一致
function weekKeys(ref) {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const dow = (d.getDay() + 6) % 7;
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const ks = [];
  for (let i = 0; i < 7; i++) { const x = new Date(mon); x.setDate(mon.getDate() + i); ks.push(dk(x.getFullYear(), x.getMonth() + 1, x.getDate())); }
  return ks;
}
function monthKeys(ref) { const y = ref.getFullYear(), m = ref.getMonth(); const n = new Date(y, m + 1, 0).getDate(); const ks = []; for (let i = 1; i <= n; i++) ks.push(dk(y, m + 1, i)); return ks; }
function sumKeys(stats, keys) { let t = 0, c = 0; for (const k of keys) { if (!stats[k]) continue; c += stats[k].checkin ? 1 : 0; for (const id in stats[k].byBook) t += stats[k].byBook[id]; } return { t: Math.round(t / 60000), c }; }

const wk = weekKeys(REF);
const expWeek = sumKeys(synth, wk);
const weekAgg = aggregateStats(synth, 'week', REF);
ok(Math.round(weekAgg.totalMs / 60000) === expWeek.t, '周聚合：周一为起点的 7 天合计 = ' + expWeek.t + ' 分钟');
ok(weekAgg.checkinDays === expWeek.c, '周聚合：打卡天数计数一致 = ' + expWeek.c);

const mk = monthKeys(REF);
const expMonth = sumKeys(synth, mk);
const monthAgg = aggregateStats(synth, 'month', REF);
ok(Math.round(monthAgg.totalMs / 60000) === expMonth.t, '月聚合：6 月全月合计 = ' + expMonth.t + ' 分钟（不含 5 月 31 日）');
ok(monthAgg.checkinDays === expMonth.c, '月聚合：打卡天数计数一致 = ' + expMonth.c);
ok(!wk.includes(dk(2026, 5, 31)), '周窗口不含 5 月 31 日（跨月已排除）');
ok(!mk.includes(dk(2026, 5, 31)), '月窗口不含 5 月 31 日（跨月已排除）');

// 空数据
const emptyAgg = aggregateStats({}, 'month', REF);
ok(emptyAgg.totalMs === 0 && emptyAgg.checkinDays === 0 && Object.keys(emptyAgg.byBook).length === 0, '空统计：聚合结果全为 0');

// ---------- 5. 书架元数据（含 AI 标签，供分组 / 筛选）----------
await putBook({ id: 'b1', title: '测试书一', author: '甲', source: 'txt', chapters: [{ title: 'c1', html: '<p>x</p>' }, { title: 'c2', html: '<p>y</p>' }], addedAt: 1000, ai: { tags: ['小说', '经典'] } });
await putBook({ id: 'b2', title: '测试书二', author: '乙', source: 'txt', chapters: [{ title: 'c1', html: '<p>x</p>' }], addedAt: 2000, ai: { tags: ['技术'] } });
const metas = await listBooksMeta();
ok(metas.length === 2, '导入 2 本书，元数据列表长度 = 2');
const b1 = metas.find((m) => m.id === 'b1');
ok(b1.chaptersCount === 2, 'meta 含章节数（b1 = 2 章）');
ok(Array.isArray(b1.aiTags) && b1.aiTags.includes('小说') && b1.aiTags.includes('经典'), 'meta 含 AI 标签（供按类型分组 / 筛选）');
ok(metas[0].id === 'b2' && metas[1].id === 'b1', '按 addedAt 倒序（新导入在前）');
const got = await getBook('b1');
ok(got && got.title === '测试书一', 'getBook 按 id 取回完整内容');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
