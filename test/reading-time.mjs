// 红杉阅读 v1.4.9 —— 每日阅读时长统计口径专项回归
//
// 背景：v1.4.8 及更早把 plus.countThisTick() 的返回值直接当 inkreader:stats 的计时闸门，
//       effectiveTick() 要求「30 秒内有交互」，安静读一页不触屏即被判成亮屏放置。
//       实测 60 秒翻一页少算 48%、90 秒翻一页少算 66%、180 秒翻一页少算 83%。
//       v1.4.9 把「有效阅读」从累计时长解耦：countThisTick 仍调用（保住 effectiveMs /
//       剩余时长估算），readingTimeTick 决定写入多少毫秒。
//
// 三段：① readingTimeTick 纯函数行为 ② 源码级接线与版本 ③ 真实节奏数值模拟
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PLUS = await import(new URL('../www/js/plus-core.js', import.meta.url));

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else {
    failed++;
    fails.push(name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
    console.log('  ✗ ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  }
}

// ---------------- ① 纯函数：结算口径 ----------------
console.log('\n① readingTimeTick 纯函数');
const tick = PLUS.readingTimeTick;
check('visible + effective=false 仍全量计时（本次修复的核心）', tick({ mode: 'visible', dt: 1000, effective: false }) === 1000);
check('visible + effective=true 计时 1000ms', tick({ mode: 'visible', dt: 1000, effective: true }) === 1000);
check('visible 缺 effective 字段也照常计时', tick({ mode: 'visible', dt: 1000 }) === 1000);
check('visible 未知 mode 默认全量计时', tick({ mode: 'unknown', dt: 1000, effective: false }) === 1000);
check('effective 模式 + effective=true 计 1000ms（可回退）', tick({ mode: 'effective', dt: 1000, effective: true }) === 1000);
check('effective 模式 + effective=false 计 0ms（复现旧行为）', tick({ mode: 'effective', dt: 1000, effective: false }) === 0);
check('dt=0 返回 0', tick({ mode: 'visible', dt: 0 }) === 0);
check('dt<0 返回 0', tick({ mode: 'visible', dt: -1000 }) === 0);
check('dt 为 undefined / NaN 返回 0', tick({ mode: 'visible' }) === 0 && tick({ mode: 'visible', dt: 'x' }) === 0);
check('字符串数字 dt 可容错', tick({ mode: 'visible', dt: '1000' }) === 1000);
check('dt=61000 clamp 到 60000（不再整段丢弃）', tick({ mode: 'visible', dt: 61000 }) === 60000);
check('dt=3600000 clamp 到 60000', tick({ mode: 'visible', dt: 3600000 }) === 60000);
check('effective 模式下超长 dt 同样 clamp', tick({ mode: 'effective', dt: 90000, effective: true }) === 60000);
check('非法入参（undefined / null）不抛异常', tick() === 0 && tick(null) === 0);

// ---------------- ② 源码级接线与版本 ----------------
console.log('\n② 源码接线 / 缓存 / 版本号');
const app = read('js/app.js');
const plus = read('js/plus.js');
const core = read('js/plus-core.js');
const sw = read('sw.js');
const gradle = fs.readFileSync(path.join('android', 'app', 'build.gradle'), 'utf8');

check('app.js 静态 import readingTimeTick', /import \{ readingTimeTick \} from '\.\/plus-core\.js'/.test(app));
check('READING_TIME_MODE 固定为 visible', /const READING_TIME_MODE = 'visible';/.test(app));
check('旧短路闸门已移除', !/if \(plus && !plus\.countThisTick\(dt\)\) return;/.test(app));
check('plus.countThisTick(dt) 仍每 tick 调用（effectiveMs 不归零）', /plus\.countThisTick\(dt\)/.test(app));
check('用 readingTimeTick 结算写入时长', /readingTimeTick\(\{ mode: READING_TIME_MODE, dt, effective \}\)/.test(app));
check('面板判定同时覆盖工具箱与 Pro 设置面板', /#plus-panel:not\(\.hidden\)/.test(app) && /#pro-panel\.pro-on/.test(app));
check('异常间隔改为 clamp 而非丢弃', /Math\.min\(Math\.max\(0, now - readingLastTs\), 60000\)/.test(app) && !/dt > 60000/.test(app));
check('plus.js 开关文案已按新口径同步', /有效阅读估算/.test(plus) && /每日阅读时长统计不受影响/.test(plus) && !/亮屏放着不动不计时/.test(plus));
check('effectiveTick 仍保留 30 秒门槛（未被误改，供会话估算用）', /export function effectiveTick\(/.test(core) && /idleFor <= 30000/.test(core));
check('plus-core.js 导出 readingTimeTick', /export function readingTimeTick\(/.test(core));
check('sw.js 已升 inkreader-v23 / PREV_CACHE=v22', /const CACHE = 'inkreader-v23';/.test(sw) && /const PREV_CACHE = 'inkreader-v22';/.test(sw));
check('sw.js ASSETS 含 plus-core.js', /'js\/plus-core\.js'/.test(sw));
const reuseBody = (sw.match(/const REUSE = \[([\s\S]*?)\]\.concat\(VENDOR\)/) || [])[1] || '';
check('变更的 app.js / plus.js / plus-core.js 均不在 REUSE', !/js\/app\.js/.test(reuseBody) && !/js\/plus\.js/.test(reuseBody) && !/js\/plus-core\.js/.test(reuseBody));
check('build.gradle 已升 34 / 1.4.9', /versionCode 34\b/.test(gradle) && /versionName "1\.4\.9"/.test(gradle));

// ---------------- ③ 真实节奏数值模拟 ----------------
console.log('\n③ 30 分钟阅读节奏模拟');
// 每秒一个 tick；翻页刷新 lastActivityAt；effectiveTick 按 plus 默认开启的 30 秒门槛判定。
function simulate(mode, pageSec, totalSec = 1800) {
  let countedMs = 0;
  let lastActivityAt = 0;
  for (let t = 1; t <= totalSec; t++) {
    if (t % pageSec === 0) lastActivityAt = t * 1000;
    const effective = PLUS.effectiveTick({
      enabled: true,
      now: t * 1000,
      lastActivityAt,
      lastTurnAt: 0,
      autoActive: false,
    });
    countedMs += tick({ mode, dt: 1000, effective });
  }
  return countedMs / 1000;
}
const REAL = 1800;
const visible90 = simulate('visible', 90);
const legacy90 = simulate('effective', 90);
check('visible 模式 90 秒翻页：30 分钟全量记入', visible90 === REAL, { visible90 });
check('effective 模式复现旧行为：90 秒翻页仅记约 10 分钟', legacy90 > 500 && legacy90 < 700, { legacy90 });
check('visible 模式对 30/45/60/120/180 秒翻页均无丢失', [30, 45, 60, 120, 180].every((p) => simulate('visible', p) === REAL));
check('visible 模式不随 effectiveReading 开关变化而少算', simulate('visible', 180) === simulate('visible', 30));
check('定时器节流：单个 90 秒 tick 计 60 秒而非丢弃', tick({ mode: 'visible', dt: 90000, effective: false }) === 60000);
check('连续 3 个 1 秒 tick 累加为 3000ms 无重复', [1, 2, 3].reduce((s) => s + tick({ mode: 'visible', dt: 1000, effective: false }), 0) === 3000);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
