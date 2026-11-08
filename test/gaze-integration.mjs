// 确定性端到端：sim 引擎 -> 回扫判定 -> onSignal -> turn.request('next','gaze') -> perform 翻页
// 用虚拟时钟 + 受控 rAF 驱动，不依赖真实定时器/帧率：
//   1) 串联 npm test 时前面的 puppeteer 用例可能让真实定时器被饥饿，导致基于墙钟的演示偶发失败；
//   2) 这里把 setTimeout/clearTimeout 置为 no-op，关掉「演示自驱动定时器」与「翻页后相位复位定时器」，
//      改由测试手动喂视线值 + 推进虚拟时钟，确保可复现、零等待。
import { createGazeEngine } from '../www/js/gaze.js';
import { createTurnController } from '../www/js/turn.js';

// ---- 虚拟时钟 + 受控 rAF，使测试完全确定性 ----
let vclock = 1000; // 从非 0 起，避免与 lastFireAt=-Infinity 等哨兵冲突
globalThis.performance = globalThis.performance || {};
globalThis.performance.now = () => vclock;
globalThis.Date.now = () => vclock;

let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
// 关键：关掉真实定时器，避免演示自驱动与相位复位干扰手动驱动
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

let pagesTurned = 0;
let gazeSignalCalls = 0;

const turn = createTurnController({
  perform: async () => { pagesTurned++; },
  getPosition: () => ({ ci: 0, pi: pagesTurned }),
  canTurn: () => true,
  onTurn: () => {},
});

const gaze = createGazeEngine({
  onSignal: () => { gazeSignalCalls++; if (turn) turn.request('next', 'gaze'); },
  onStatus: () => {},
  getConfig: () => ({ gazeEngine: 'sim' }), // 显式演示引擎，无需摄像头
  onCalibration: () => {},
});

const res = await gaze.start();
check('sim 引擎 start() ok', res.ok === true, JSON.stringify(res));
check('isSimulated() === true', gaze.isSimulated() === true);

// 手动驱动一帧：推进虚拟时钟并消费一个 rAF 回调（onFrame 会再排队下一帧）
function pumpFrame(stepMs = 16) {
  vclock += stepMs;
  const cb = rafQueue.shift();
  if (cb) cb(vclock);
}
// 在某视线值上停留 ms（按帧驱动），用于累积「页底驻留」
function dwellAt(value, ms) {
  gaze.simulate(value);
  const frames = Math.ceil(ms / 16);
  for (let i = 0; i < frames; i++) pumpFrame();
}

// 回扫：先页底驻留越过 dwell（约 432ms），再跳回页首触发翻页。
// 注意：页底停留不能过长——引擎要求「回看页首」发生在 bottomSince 之后 sweepWindow(820ms) 内，
// 否则会判定为「走神/长时间凝视」而重置而非翻页（这正是真实使用与演示都遵循的时序）。
dwellAt(0.82, 600); // 页底驻留（> dwell 432ms，且 < sweepWindow 上限）
dwellAt(0.10, 400); // 跳回页首（足以让平滑值越过 topLine）
pumpFrame(); pumpFrame(); pumpFrame();

// turn.request 的 perform 在微任务/宏任务中异步执行，等其落地
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

check('onSignal 至少触发 1 次（回扫被识别）', gazeSignalCalls >= 1, 'calls=' + gazeSignalCalls);
check('turn.request 至少受理 1 次翻页（perform 被执行）', pagesTurned >= 1, 'pages=' + pagesTurned);

gaze.stop();
console.log(`\ngaze-integration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
