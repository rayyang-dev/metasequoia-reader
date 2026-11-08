// 红杉阅读 —— 视线回扫（Gaze）回归测试
//
// 历史教训：视线翻页功能此前没有任何断言，导致一个「死开关」bug 悄悄上线——
// pickDetector('auto') 在无端侧模型且无 window.FaceDetector 时静默退回模拟源，
// 而模拟源在生产环境永远不产生信号，于是「开了视线翻页却一页都不翻」。
// 本测试锁定行为契约：
//   1) auto 无真实检测引擎 -> start() 必须诚实返回 ok:false（触发上层降级，不再死开关）
//   2) sim 模式可启动且明确标记为模拟
//   3) 回扫判定（纯函数 gazeSweepDecision）确定性：页底驻留 -> 回看页首 必须触发翻页
//   4) 回扫判定：冷却期内不会重复触发（防连翻）
//   3/4 用纯函数测试，不依赖计时器/帧率，稳定无抖动。

import { createGazeEngine, gazeSweepDecision, classifyCameraError, requestNativeCameraPermission } from '../www/js/gaze.js';

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name); }
}

const RANGE = { top: 0.30, bottom: 0.70, span: 0.40 };
const CFG = { sensitivity: 3, dwellMs: 320, cooldownMs: 1600 };

async function main() {
  // 1. auto 模式无真实检测引擎 -> 诚实降级（核心契约：不再死开关）
  {
    const eng = createGazeEngine({ onSignal() {}, onStatus() {}, getConfig: () => ({ gazeEngine: 'auto' }) });
    const res = await eng.start();
    check('auto 无探测器时 start() 返回 ok:false（诚实降级，不死开关）', res && res.ok === false);
    eng.stop();
  }

  // 2. sim 模式可启动且标记为模拟
  {
    const eng = createGazeEngine({ onSignal() {}, onStatus() {}, getConfig: () => ({ gazeEngine: 'sim' }) });
    const res = await eng.start();
    check('sim 模式 start() 返回 ok:true', res && res.ok === true);
    check('sim 模式 isSimulated() 为 true', eng.isSimulated() === true);
    eng.stop();
  }

  // 3. 纯函数回扫判定：页底驻留 -> 回看页首 必须触发翻页（确定性，无计时器）
  {
    let s = { phase: 'tracking', bottomSince: 0, bottomY: 0, lastFireAt: -Infinity };
    // 在页底（y=0.82）驻留足够久，越过 dwell(352ms)。时间从 100 起（避免 0 与「未设置」哨兵混淆）
    for (let t = 100; t <= 500; t += 80) s = gazeSweepDecision(s, 0.82, CFG, RANGE, t);
    check('页底驻留越过 dwell 后进入 bottom 相位', s.phase === 'bottom');
    // 紧接着回看页首（y=0.14，已越过 topLine），应识别为回扫并触发翻页
    const r = gazeSweepDecision(s, 0.14, CFG, RANGE, 680);
    check('bottom 后回看页首触发翻页（onSignal 应被调用）', r.fire === true);
  }

  // 4. 回扫判定：冷却期内不会重复触发（防连翻）
  {
    let s = { phase: 'tracking', bottomSince: 0, bottomY: 0, lastFireAt: -Infinity };
    for (let t = 100; t <= 500; t += 80) s = gazeSweepDecision(s, 0.82, CFG, RANGE, t);
    const fired = gazeSweepDecision(s, 0.14, CFG, RANGE, 680); // 第一次回扫，触发
    check('首次回扫触发', fired.fire === true);
    // 紧接下一次（仍在冷却 1600ms 内）即便再次回看也不应再次触发
    const again = gazeSweepDecision(
      { phase: 'tracking', bottomSince: 580, bottomY: 0.82, lastFireAt: 580 },
      0.14, CFG, RANGE, 700
    );
    check('冷却期内不重复触发（防连翻）', again.fire === false);
  }

  // 4b. 回归：读到页底后「停顿再抬眼」也应翻页（旧逻辑要求回看在 ~1.1s 内完成，
  //      读完最后一行停顿后再抬眼会静默复位、一页都不翻——正是用户遇到的「不灵敏」）。
  {
    let s = { phase: 'tracking', bottomSince: 0, bottomY: 0, lastFireAt: -Infinity };
    for (let t = 100; t <= 500; t += 80) s = gazeSweepDecision(s, 0.82, CFG, RANGE, t);
    check('页底驻留进入 bottom 相位（前置）', s.phase === 'bottom');
    // 停顿到 t=1200（距首次触底 1100ms，已超出旧窗口 1092ms）再回看页首
    const r = gazeSweepDecision(s, 0.14, CFG, RANGE, 1200);
    check('页底后停顿再回看页首仍触发翻页（修「不灵敏」）', r.fire === true);
    // 远超窗口且已离开页底区域：应复位回 tracking，不再卡在 bottom 误判
    const stuck = gazeSweepDecision(
      { phase: 'bottom', bottomSince: 100, bottomY: 0.82, lastFireAt: -Infinity },
      0.45, CFG, RANGE, 100 + 6000 + 10
    );
    check('远超窗口且离开页底 -> 复位 tracking（防卡死）', stuck.phase === 'tracking');
  }

  // 5. 摄像头错误分类（纯函数，覆盖权限/无设备/被占用/超时/WebView不支持/其他）
  {
    const perm = classifyCameraError({ name: 'NotAllowedError' });
    check('权限被拒 -> PERMISSION_DENIED', perm.code === 'PERMISSION_DENIED');
    const perm2 = classifyCameraError({ name: 'SecurityError' });
    check('SecurityError -> PERMISSION_DENIED', perm2.code === 'PERMISSION_DENIED');
    const nocam = classifyCameraError({ name: 'NotFoundError' });
    check('无摄像头 -> NO_CAMERA', nocam.code === 'NO_CAMERA');
    const busy = classifyCameraError({ name: 'NotReadableError' });
    check('被占用 -> CAMERA_BUSY', busy.code === 'CAMERA_BUSY');
    const to = classifyCameraError({ message: 'CAMERA_TIMEOUT' });
    check('超时 -> CAMERA_TIMEOUT', to.code === 'CAMERA_TIMEOUT');
    const noapi = classifyCameraError({ message: 'getUserMedia 不可用' });
    check('WebView不支持 -> WEBVIEW_NO_API', noapi.code === 'WEBVIEW_NO_API');
    const other = classifyCameraError({ name: 'UnknownError', message: 'boom' });
    check('其他 -> CAMERA_ERR 且含原文', other.code === 'CAMERA_ERR' && /boom/.test(other.message));
  }

  // 6. 原生摄像头权限预申请桥（requestNativeCameraPermission）：无桥 / 授权 / 超时 / 抛错
  {
    check('无桥时返回 null', (await requestNativeCameraPermission()) === null);
    globalThis.window = {
      AndroidGazeBridge: { requestCamera() { setTimeout(() => { if (window.__onGazeCameraResult) window.__onGazeCameraResult(true); }, 10); } },
    };
    const r1 = await requestNativeCameraPermission({ timeoutMs: 300 });
    check('桥存在且授权回调 -> true', r1 === true);
    globalThis.window = { AndroidGazeBridge: { requestCamera() { /* 不回调，应超时 */ } } };
    const r2 = await requestNativeCameraPermission({ timeoutMs: 120 });
    check('桥存在但超时未回调 -> false', r2 === false);
    globalThis.window = { AndroidGazeBridge: { requestCamera() { throw new Error('x'); } } };
    const r3 = await requestNativeCameraPermission({ timeoutMs: 120 });
    check('桥 requestCamera 抛错 -> false', r3 === false);
    delete globalThis.window;
  }

  console.log(`\ngaze: ${pass} passed, ${fail} failed` + (fail ? `  [${fails.join('; ')}]` : ''));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
