// 红杉阅读 —— 视线回扫信号源（Gaze / Return-Sweep Signal）
//
// 产品原理：读到页末时，人眼会做一个特征性动作「回扫（return sweep）」——视线从页面右下
// 快速跳回左上，准备读下一页。我们不尝试逐行追踪读了哪个字，只识别这一个高置信度动作：
//     眼睛在「页底区域」停留足够久  ->  在短时间内大幅上移回到「页顶区域」  ->  触发翻页
// 相比「盯住底部就翻页」，这个两阶段判据把「低头沉思 / 走神 / 看图片」的误触发挡在门外。
//
// 工程原则（也是本功能好不好用的关键）：
//   1. 端侧：摄像头帧只在内存里做降采样推理，绝不上传、绝不落盘、绝不写进日志。
//   2. 可插拔：检测引擎是可替换实现细节，不是产品本身。按优先级自动探测：
//        MediaPipe FaceLandmarker（若 vendor 下放了模型，精度最高，含虹膜）
//        -> 系统 Shape Detection API / FaceDetector（零体积，部分 WebView 可用）
//        -> SimulatedSource（测试 / 演示 / 无摄像头环境，由外部注入视线 y）
//      全部不可用时会明确上报 unavailable，由上层自动降级到「定时自动翻页」，绝不静默失败。
//   3. 可校准：每个人持机角度、坐姿、眼型都不同，先看页顶、再看页底各 1.5 秒得到个人量程。
//   4. 可解释：状态机每一跳都上报，UI 显示「追踪中 / 已到页底 / 准备翻页 / 暂停 / 不支持」。
//   5. 可停：后台、面板、退出阅读器、权限被拒时立即释放摄像头（stop tracks）。
//
// 关于打包体积：MediaPipe 的 wasm（约 14MB）+ 模型（约 3.7MB）会让人把 3.8MB 的应用
// 涨到 20MB 以上，且在未经真机验证前不应进正式包。因此这里采用「放文件即启用」策略：
// 把下列文件放到 www/js/vendor/mediapipe/ 即自动升级为虹膜级检测，不放则走系统能力或模拟源：
//   vision_bundle.mjs、wasm/vision_wasm_internal.js、wasm/vision_wasm_internal.wasm、
//   face_landmarker.task
// 这样既能零成本回退，也不绑架不需要该功能的绝大多数用户。

const CLAMP = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------- 检测引擎 ----------

// ① MediaPipe FaceLandmarker：478 个关键点含虹膜，y 取「虹膜中心相对眼框」的归一化位置，
//    比整张脸的位置稳定得多（低头/抬头不会误判）。放到 www/js/vendor/mediapipe/ 即自动启用；
//    加载失败（文件缺失 / 当前 origin 不支持 / wasm 不可用）会抛错，由 pickDetector 的
//    try/catch 捕获并诚实降级，绝不静默卡死。这里不再用 HEAD 预检——部分静态服务器/WebView
//    对 HEAD 返回 405，会误判为「文件不存在」而把真·眼球翻页悄悄关掉。
async function createMediaPipeDetector() {
  const base = 'js/vendor/mediapipe/';
  const mod = await import('./vendor/mediapipe/vision_bundle.mjs');
  const { FaceLandmarker, FilesetResolver } = mod;
  const vision = await FilesetResolver.forVisionTasks(base + 'wasm');
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
  });
  let t = 0;
  return {
    name: '虹膜追踪（端侧）',
    detect(video) {
      t += 33;
      const r = landmarker.detectForVideo(video, t);
      const lm = r && r.faceLandmarks && r.faceLandmarks[0];
      if (!lm || lm.length < 468) return null;
      // 虹膜中心 468..477；眼框上/下缘用 33/133(右眼) 与 362/263(左眼) 近似
      const iris = [468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
      let iy = 0, n = 0;
      for (const i of iris) if (lm[i]) { iy += lm[i].y; n++; }
      if (!n) return null;
      const top = lm[33] && lm[362] ? (lm[33].y + lm[362].y) / 2 : 0.42;
      const bottom = lm[133] && lm[263] ? (lm[133].y + lm[263].y) / 2 : 0.50;
      const span = Math.max(0.006, bottom - top);
      return { y: CLAMP((iy / n - top) / span, 0, 1), confidence: 0.95 };
    },
    close() { try { landmarker.close(); } catch (e) {} },
  };
}

// ② 系统 Shape Detection：不需要任何模型文件。注意它给的是「眼睛在画面中的位置」而非瞳孔，
//    因此只作为粗信号（配合校准 + 回扫阈值仍可用），灵敏度假档默认会调低一档。
function createWebFaceDetector() {
  if (typeof window === 'undefined' || !window.FaceDetector) return null;
  const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
  let last = null;
  return {
    name: '系统人脸检测（轻量）',
    async detect(canvas) {
      const faces = await fd.detect(canvas);
      if (!faces || !faces.length) return null;
      const f = faces[0];
      let y = null;
      const marks = f.landmarks || [];
      for (const m of marks) {
        if (m.type === 'eye' && m.locations && m.locations.length) {
          let s = 0;
          for (const p of m.locations) s += p.y;
          y = s / m.locations.length / canvas.height;
          break;
        }
      }
      if (y == null) {
        const box = f.boundingBox || {};
        y = ((box.y || 0) + (box.height || canvas.height) * 0.42) / canvas.height;
      }
      // 画面坐标向下为正；镜像前置摄像头不影响垂直方向
      const v = CLAMP(y, 0, 1);
      const out = { y: last == null ? v : last * 0.5 + v * 0.5, confidence: 0.7 };
      last = out.y;
      return out;
    },
    close() {},
  };
}

// ③ 模拟源：无摄像头 / 自动化回归 / 桌面演示时使用。由 simulate(y) 注入 0..1 的视线位置，
//    让整套回扫状态机、校准、预告、撤销都能在没有真机的情况下被端到端验证。
function createSimulatedDetector() {
  let value = null;
  return {
    name: '模拟视线（演示）',
    detect() {
      if (value == null) return null;
      return { y: value, confidence: 0.9 };
    },
    simulate(y) { value = y == null ? null : CLAMP(y, 0, 1); },
    close() { value = null; },
  };
}

async function pickDetector(prefer) {
  if (prefer === 'sim') return createSimulatedDetector();
  if (prefer === 'system') {
    // system 明确要求系统能力：无则显式返回 null，由上层降级，绝不静默退回模拟源
    return createWebFaceDetector() || null;
  }
  // auto：优先端侧模型，其次系统人脸检测；两者皆无时显式返回 null（不可用）。
  // 关键修正：绝不静默退回「模拟源」——模拟源只用于显式 sim 模式（测试 / 演示），
  // 否则会出现「开了视线翻页却永远不翻页」的死开关（之前正是这个 bug：
  // 所有平台既无内置模型又无 window.FaceDetector，一律静默退回模拟源后零信号）。
  try {
    const mp = await createMediaPipeDetector();
    if (mp) return mp;
  } catch (e) { /* 模型缺失 / 版本不匹配 / WASM 不支持：静默降级 */ }
  const fd = createWebFaceDetector();
  if (fd) return fd;
  return null;
}

// ---------- 回扫判定（纯函数，与运行时状态机解耦，便于确定性回归） ----------
// s = { phase, bottomSince, bottomY, lastFireAt }；rangeObj = { top, bottom, span }。
// 返回新的状态 + 是否触发翻页(fire) + 需要上报的状态文案(detail)。
// 不依赖计时器 / 帧率 / DOM，因此可在 Node 中确定性测试。
export function gazeSweepDecision(s, y, cfg, rangeObj, t) {
  const { top, bottom, span } = rangeObj;
  const k = (cfg.sensitivity - 1) / 4;
  // 灵敏度越高（k 越大），阈值越宽松：更易触发，减少「该翻不翻」。
  // 两阶段判据（页底驻留 -> 回看页首）本身已挡掉低头/走神/看图等非翻页动作，
  // 因此回看窗口可以放得比较宽，给「读完最后一行再抬眼」的自然节奏留足余量，
  // 不再因「读完停顿太久才抬眼」而悄悄复位、导致一页都不翻。
  const bottomLine = bottom - span * (0.20 - k * 0.08);
  const topLine = top + span * (0.34 - k * 0.10);
  const sweepNeeded = span * (0.46 - k * 0.14);
  const dwell = cfg.dwellMs * (1.25 - k * 0.40);
  const sweepWindow = 1500 - k * 200;
  let { phase, bottomSince, bottomY, lastFireAt } = s;
  let fire = false, detail = '';
  if (t - lastFireAt < cfg.cooldownMs) return { phase, bottomSince, bottomY, lastFireAt, fire: false, detail: '' };
  if (phase === 'bottom') {
    // 已确认在页底：只要回到页首区域即翻；时间窗只用来防止长时间不动后误触发。
    // 注意：不再要求「回看必须在 dwell 之后的极短窗口内完成」——那是此前「读到页尾却
    // 不翻页」的根因（用户读完最后一行、停顿、再抬眼，往往已超过旧窗口而静默复位）。
    if (t - bottomSince > 6000) { phase = 'tracking'; return { phase, bottomSince: 0, bottomY: 0, lastFireAt, fire: false, detail: '已重置，继续阅读' }; }
    const drop = bottomY - y;
    if (drop >= sweepNeeded && y <= topLine) {
      phase = 'sweep'; lastFireAt = t;
      return { phase, bottomSince, bottomY, lastFireAt, fire: true, detail: '检测到回扫，准备翻页' };
    }
    if (y < bottomLine && t - bottomSince > sweepWindow) { phase = 'tracking'; }
    return { phase, bottomSince, bottomY, lastFireAt, fire: false, detail: '' };
  }
  if (y >= bottomLine) {
    if (!bottomSince) bottomSince = t;
    bottomY = Math.max(bottomY, y);
    if (t - bottomSince >= dwell) { phase = 'bottom'; detail = '已读到页底，回看页首即可翻页'; }
  } else {
    bottomSince = 0; bottomY = 0;
  }
  return { phase, bottomSince, bottomY, lastFireAt, fire: false, detail };
}

// ---------- 摄像头错误分类（纯函数，便于确定性回归） ----------
// 把 getUserMedia 的原生错误名映射成可执行的排查指引，避免一句误导的「设备不支持」。
export function classifyCameraError(err) {
  const name = (err && err.name) || '';
  const message = (err && err.message) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { code: 'PERMISSION_DENIED', message: '摄像头权限被拒绝。请在系统设置中授予本应用（或卓易通）摄像头权限后，重新开启「视线」' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { code: 'NO_CAMERA', message: '未检测到可用的前置摄像头' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { code: 'CAMERA_BUSY', message: '摄像头被其他应用占用，请关闭相机类应用后重试' };
  }
  if (message === 'CAMERA_TIMEOUT') {
    return { code: 'CAMERA_TIMEOUT', message: '摄像头初始化超时（可能未被授权或设备未响应），请检查权限后重试' };
  }
  if (message === 'getUserMedia 不可用') {
    return { code: 'WEBVIEW_NO_API', message: '当前 WebView 不支持摄像头接口（常见于部分鸿蒙兼容容器），可在「视线引擎」选「演示（模拟视线）」查看效果' };
  }
  return { code: 'CAMERA_ERR', message: '摄像头初始化失败：' + (message || name || '未知错误') };
}

// 带超时的 getUserMedia：部分环境（如鸿蒙兼容容器）在权限弹窗缺失时会永久挂起，
// 用超时兜底，保证视线翻页失败也能明确报错而不是卡死。
function getUserMediaTimed(constraints, ms) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      reject(new Error('getUserMedia 不可用')); return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('CAMERA_TIMEOUT')); }
    }, ms);
    navigator.mediaDevices.getUserMedia(constraints).then((s) => {
      if (settled) { try { s.getTracks().forEach((t) => t.stop()); } catch (e) {} return; }
      settled = true; clearTimeout(timer); resolve(s);
    }).catch((err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });
  });
}

// 无可用检测器时的准确提示（不谎称「设备不支持摄像头」，并指引演示模式）。
function noDetectorMsg() {
  return '本设备暂无可用视线检测引擎（未内置端侧模型且系统不支持人脸检测）。可在「视线引擎」选「演示（模拟视线）」查看 视线→翻页 效果（明确标注为模拟，非真实检测）';
}

// 通过原生桥预申请摄像头权限（仅 Android/Capacitor 包内有 window.AndroidGazeBridge）。
// 在某些鸿蒙兼容容器里，系统级 requestPermissions 弹窗比 WebView 内部的 onPermissionRequest
// 更可靠地出现；先走完系统授权，再发起 getUserMedia，可提升「视线翻页」在这些设备上的可用性。
// 返回 Promise<boolean|null>：true=已授权；false=被拒；null=无桥（调用方走原 getUserMedia 路径）。
export function requestNativeCameraPermission(opts) {
  const bridge = (typeof window !== 'undefined') && window.AndroidGazeBridge;
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  if (!bridge || typeof bridge.requestCamera !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (granted) => { if (!settled) { settled = true; resolve(granted); } };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (typeof window !== 'undefined') {
      // 原生 onRequestPermissionsResult 会通过此回调把结果送回 web 层
      window.__onGazeCameraResult = (g) => { clearTimeout(timer); done(!!g); };
    }
    try { bridge.requestCamera(); } catch (e) { clearTimeout(timer); done(false); }
  });
}

// ---------- 视线引擎 ----------

export function createGazeEngine(opts) {
  const {
    onSignal = () => {},       // (reason) => void，识别到一次回扫
    onStatus = () => {},       // ({ phase, engine, detail }) => void
    getConfig = () => ({}),
    onCalibration = () => {},  // ({ top, bottom }) => void，校准完成
  } = opts;

  let detector = null;
  let engineName = '';
  let stream = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let rafId = null;
  let frameHandle = null;
  let lastFrameAt = 0;          // 最近一次 onFrame 执行时刻；看门狗据此判断帧回调是否停摆
  let useRafFallback = false;   // requestVideoFrameCallback 不可靠时切到 RAF 兜底
  let watchdogId = null;        // 帧循环保活看门狗（兼容层翻页后 rvfc 静默停摆的兜底）
  const FRAME_STALL_MS = 600;   // 超过此间隔无任何帧 = 视为停摆（兼容层翻页后常见）
  let running = false;
  let paused = false;
  let phase = 'off';           // off | starting | tracking | lost | bottom | sweep | paused | unavailable
  let lastSampleAt = 0;
  let smoothed = null;
  let lostSince = 0;
  let bottomSince = 0;
  let bottomY = 0;
  // 必须用 -Infinity 而不是 0：now() 是页面启动后的毫秒数，初始 0 会把
  // 「从未触发过」误判成「刚触发过」，导致启动后 cooldownMs 内所有回扫被吞。
  let lastFireAt = -Infinity;
  let cal = null;              // { top, bottom }
  let calib = null;            // 校准采集中：{ phase, samples, startedAt }
  let simInjected = false;
  let demoTimer = null;        // 显式 sim（演示）模式下的自驱动回扫定时器

  let lastEmitKey = '';
  function emit(detail) {
    // 逐帧采样时状态通常不变：只在「状态或说明真的变了」时上报，避免每秒十几次无效 UI 刷新。
    const key = phase + '|' + (detail || '');
    if (key === lastEmitKey) return;
    lastEmitKey = key;
    try { onStatus({ phase, engine: engineName, detail: detail || '', simulated: simInjected }); } catch (e) {}
  }

  function config() {
    const c = getConfig() || {};
    const powerSave = !!c.gazePowerSave;
    return {
      sensitivity: CLAMP(Number(c.gazeSensitivity) || 4, 1, 5),
      dwellMs: Number(c.gazeDwellMs) || 320,
      // 演示（sim）模式用更短的冷却，让翻页节奏清晰可见；真实检测仍走配置值。
      cooldownMs: simInjected ? 1000 : (Number(c.gazeCooldownMs) || 1600),
      // 省电模式：把取帧间隔从约 11fps 降到约 7fps，摄像头+CPU 推理耗电明显下降，
      // 对「页末驻留→回看页首」这种低频动作的识别几乎无影响。
      sampleMs: powerSave ? 140 : (Number(c.gazeSampleMs) || 90),
      calibration: c.gazeCalibration || null,
      prefer: c.gazeEngine || 'auto',
      powerSave,
    };
  }

  function range() {
    const c = cal || config().calibration;
    const top = c && typeof c.top === 'number' ? c.top : 0.30;
    const bottom = c && typeof c.bottom === 'number' ? c.bottom : 0.70;
    return { top, bottom, span: Math.max(0.12, bottom - top) };
  }

  function makeVideo() {
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.autoplay = true;
    // 1px 透明节点：video 必须在文档里才能播放，但绝不能占用布局或吃掉点击
    v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
    v.setAttribute('aria-hidden', 'true');
    document.body.appendChild(v);
    return v;
  }

  async function start() {
    if (running) return { ok: true, engine: engineName };
    lastEmitKey = '';
    lastFireAt = -Infinity;
    bottomSince = 0; bottomY = 0; lostSince = 0; smoothed = null;
    useRafFallback = false; lastFrameAt = 0;
    phase = 'starting';
    emit('正在初始化端侧视线检测');
    const cfg = config();
    try {
      detector = await pickDetector(cfg.prefer);
      if (!detector) {
        // 没有可用检测器（未内置端侧模型且无系统人脸检测）：
        // 关键修正——绝不说谎「设备不支持摄像头」，而是明确「无检测引擎」，
        // 并指引用户用「演示（模拟视线）」预览 视线→翻页 链路（无需摄像头）。
        throw new Error('NO_DETECTOR::' + noDetectorMsg());
      }
      engineName = detector.name;
      simInjected = !!detector.simulate;
      cal = cfg.calibration || null;

      if (!simInjected) {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          // 当前 WebView 不提供摄像头接口（部分鸿蒙兼容容器 / 旧 WebView），
          // 真实视线检测无法进行；诚实告知，并指引演示模式。
          throw new Error('WEBVIEW_NO_API::当前 WebView 不支持摄像头接口（常见于部分鸿蒙兼容容器）。视线翻页依赖前置摄像头，可在「视线引擎」选「演示（模拟视线）」查看 视线→翻页 效果（非真实检测）');
        }
        // 原生预授权（仅 Android 包）：让系统权限弹窗优先出现，再 getUserMedia。
        // 返回 null 表示无桥（Web/PWA/旧包），走原路径；false 表示被拒。
        const nativeGranted = await requestNativeCameraPermission({ timeoutMs: 10000 });
        if (nativeGranted === false) {
          throw new Error('PERMISSION_DENIED::摄像头权限被拒绝。请在系统设置中授予本应用（或卓易通）摄像头权限后，重新开启「视线」');
        }
        // 真实检测：带超时地申请摄像头，避免部分环境下权限弹窗缺失导致永久挂起；
        // 失败按错误类型精确分类，给出可执行的排查指引，而不是一句误导的「设备不支持」。
        // 省电模式降低摄像头目标帧率（12→8fps），与更低的取帧间隔叠加进一步省电。
        const fr = cfg.powerSave ? { ideal: 8, max: 10 } : { ideal: 12, max: 15 };
        stream = await getUserMediaTimed({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: fr },
          audio: false,
        }, 8000);
        video = makeVideo();
        video.srcObject = stream;
        await video.play();
        canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        // willReadFrequently=true：系统人脸检测路径会回读 canvas 像素，CPU 位图比 GPU 回读更快更省；
        // 对 MediaPipe 路径（直接从 video 纹理推理）无副作用。
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      } else {
        // 显式 sim（演示）模式：自驱动注入「页底驻留 -> 回看页首」的合成回扫，
        // 让用户在任何无摄像头环境也能端到端看到 视线 -> 翻页 链路真实生效。
        startDemo();
      }
      running = true;
      paused = false;
      phase = 'tracking';
      emit(simInjected ? '演示模式 · 模拟视线（非真实检测）' : '视线追踪中 · 视频帧仅在本机内存处理');
      loop();
      startWatchdog();
      return { ok: true, engine: engineName };
    } catch (e) {
      phase = 'unavailable';
      engineName = engineName || '不可用';
      cleanup();
      const raw = (e && e.message) || '';
      const idx = raw.indexOf('::');
      let code, message;
      if (idx > 0) {
        code = raw.slice(0, idx);
        message = raw.slice(idx + 2);
      } else {
        // 来自 getUserMedia 的原生错误（被 getUserMediaTimed 透传）
        const c = classifyCameraError(e);
        code = c.code; message = c.message;
      }
      emit(message);
      return { ok: false, engine: engineName, reason: code, message };
    }
  }

  function cancelFrame() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (frameHandle && video && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(frameHandle); } catch (e) {}
    }
    frameHandle = null;
  }
  // 采样循环驱动：优先用 requestVideoFrameCallback（仅在有新视频帧时回调，更省电）；
  // 但在部分兼容容器（如鸿蒙/卓易通运行 Android 包）中，翻页引发大面积 DOM 重排后，
  // requestVideoFrameCallback 会静默停止派发——表现为「首次翻页正常、之后彻底失效」。
  // 因此增加看门狗：若超过 FRAME_STALL_MS 没有收到任何一帧，立即切到 requestAnimationFrame
  // 兜底，保证采样循环不会被单次掉帧永久杀死。
  function loop() {
    if (!running || paused) return;
    if (!useRafFallback && video && video.requestVideoFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      rafId = requestAnimationFrame(onFrame);
    }
  }
  function startWatchdog() {
    stopWatchdog();
    watchdogId = setInterval(() => {
      if (!running || paused) return;
      const t = now();
      if (t - lastFrameAt > FRAME_STALL_MS && !useRafFallback) {
        // 帧回调疑似在兼容层停摆：切到 RAF 兜底，避免「首翻成功、后续失效」。
        useRafFallback = true;
        try { console.warn('[gaze] requestVideoFrameCallback 停摆，已切换到 RAF 兜底（常见于鸿蒙/卓易通兼容容器）'); } catch (e) {}
        cancelFrame();
        loop();
      }
    }, 250);
  }
  function stopWatchdog() {
    if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
  }

  function onFrame() {
    if (!running || paused) return;
    lastFrameAt = now(); // 看门狗依据：本帧确实执行过，说明帧泵仍活着
    const cfg = config();
    const t = now();
    if (!paused && t - lastSampleAt >= cfg.sampleMs) {
      lastSampleAt = t;
      sample(cfg, t);
    }
    loop();
  }

  async function sample(cfg, t) {
    let r = null;
    try {
      if (ctx && video && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        r = await detector.detect(video, canvas);
      } else if (detector.simulate) {
        r = detector.detect();
      }
    } catch (e) { r = null; }

    if (!r || typeof r.y !== 'number') {
      lostSince = lostSince || t;
      if (t - lostSince > 1500) { phase = 'lost'; emit('未检测到面部，自动翻页已暂缓'); }
      return;
    }
    lostSince = 0;
    // 平滑系数：偏小（0.30）让视线从页底跳回页首时更快越过 topLine，
    // 给回扫判定留出时间余量，避免「该翻不翻」。过小会放大抖动，0.30 是灵敏度与稳
    // 定性的折中。
    const alpha = 0.30;
    smoothed = smoothed == null ? r.y : smoothed * (1 - alpha) + r.y * alpha;

    // 校准采集：先看页顶、再看页底，各取该阶段的中位值
    if (calib) {
      calib.samples.push(smoothed);
      if (t - calib.startedAt >= 1500) {
        const sorted = calib.samples.slice().sort((a, b) => a - b);
        const value = sorted[Math.floor(sorted.length / 2)];
        if (calib.phase === 'top') {
          calib.top = value;
          calib.phase = 'bottom';
          calib.samples = [];
          calib.startedAt = t;
          emit('很好，现在请看页面底部');
        } else {
          const top = Math.min(calib.top, value - 0.08);
          const bottom = Math.max(value, calib.top + 0.12);
          cal = { top: CLAMP(top, 0, 1), bottom: CLAMP(bottom, 0, 1) };
          calib = null;
          try { onCalibration(cal); } catch (e) {}
          emit('校准完成，可以开始阅读');
        }
      }
      return;
    }

    if (phase === 'lost' || phase === 'tracking') { phase = 'tracking'; emit('视线追踪中'); }
    evaluate(smoothed, cfg, t);
  }

  function evaluate(y, cfg, t) {
    const r = gazeSweepDecision({ phase, bottomSince, bottomY, lastFireAt }, y, cfg, range(), t);
    phase = r.phase; bottomSince = r.bottomSince; bottomY = r.bottomY; lastFireAt = r.lastFireAt;
    if (r.detail) emit(r.detail);
    if (r.fire) {
      try { onSignal('return-sweep'); } catch (e) {}
      // 仅留短暂宽限期避免同一次回扫重复识别；冷却由 lastFireAt 把关，不冻结状态机。
      setTimeout(() => { if (running && phase === 'sweep') { phase = 'tracking'; emit('视线追踪中'); } }, Math.min(cfg.cooldownMs, 350));
    }
  }

  // 演示（sim）模式的自驱动回扫：周期性注入「页底驻留 -> 跳回页首」，让无摄像头环境
  // 也能验证 视线 -> 翻页 全链路。仅用于演示，不冒充真实检测。
  function startDemo() {
    stopDemo();
    let step = 0; // 0=在页底驻留；1=已跳回页首
    const tick = () => {
      if (!running || paused || !simInjected) return;
      const { top, bottom } = range();
      // 注入足够极端的页首值：引擎对视线值做移动平均，若回看值不够低，
      // 平滑后的数值会晚于回扫窗口才越过 topLine，导致「该翻不翻」。
      if (step === 0) detector.simulate(Math.min(0.98, bottom + 0.12));
      else detector.simulate(Math.max(0.02, top - 0.20));
      step = step ? 0 : 1;
      // 页底驻留需 > dwell(352ms) 且足够长以便被采样观测到（~200ms+），
      // 同时又要在回扫窗口内回到页首。650ms 兼顾可观测性与窗口余量。
      demoTimer = setTimeout(tick, step === 0 ? 650 : 450);
    };
    demoTimer = setTimeout(tick, 380);
  }
  function stopDemo() {
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  // pause 默认只停止取帧（面板/选字这类秒级暂停，避免反复申请权限造成闪烁）；
  // release=true 用于切后台，彻底释放摄像头，回到前台再重新申请。
  function pause(reason, release = false) {
    if (!running || paused) return;
    paused = true;
    phase = 'paused';
    cancelFrame();
    if (simInjected) stopDemo();
    if (release) releaseStream();
    emit(reason || '已暂停');
  }
  async function resume() {
    if (!running || !paused) return;
    if (simInjected) { paused = false; phase = 'tracking'; emit('演示模式 · 模拟视线（非真实检测）'); startDemo(); loop(); return; }
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } }, audio: false,
        });
        if (!video) video = makeVideo();
        video.srcObject = stream;
        await video.play();
      }
      paused = false;
      phase = 'tracking';
      emit('视线追踪中');
      loop();
    } catch (e) { phase = 'unavailable'; emit('摄像头恢复失败'); }
  }

  function releaseStream() {
    if (stream) {
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch (e) {}
      stream = null;
    }
    if (video) { try { video.srcObject = null; } catch (e) {} }
  }
  function cleanup() {
    stopDemo();
    running = false;
    stopWatchdog();
    useRafFallback = false; lastFrameAt = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (frameHandle && video && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(frameHandle); } catch (e) {}
    }
    frameHandle = null;
    releaseStream();
    if (video && video.parentNode) video.parentNode.removeChild(video);
    video = null;
    if (detector) { try { detector.close(); } catch (e) {} }
    detector = null;
    canvas = null; ctx = null;
    smoothed = null; bottomSince = 0; bottomY = 0; lostSince = 0; calib = null;
  }
  function stop() {
    cleanup();
    phase = 'off';
    engineName = '';
    emit('已关闭，摄像头已释放');
  }

  function calibrate() {
    if (!running) return false;
    cal = null;
    calib = { phase: 'top', samples: [], startedAt: now() };
    phase = 'tracking';
    emit('请平视页面顶部并保持 1.5 秒');
    return true;
  }

  return {
    start, stop, pause, resume, calibrate,
    simulate: (y) => { if (detector && detector.simulate) detector.simulate(y); },
    setCalibration: (c) => { cal = c || null; },
    getEngine: () => engineName,
    getPhase: () => phase,
    isRunning: () => running,
    isSimulated: () => simInjected,
  };
}
