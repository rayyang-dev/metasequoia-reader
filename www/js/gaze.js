// 水杉阅读 —— 视线回扫信号源（Gaze / Return-Sweep Signal）
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
  const bottomLine = bottom - span * (0.24 - k * 0.10);
  const topLine = top + span * (0.38 - k * 0.10);
  const sweepNeeded = span * (0.60 - k * 0.22);
  const dwell = cfg.dwellMs * (1.35 - k * 0.5);
  const sweepWindow = 820 - k * 160;
  let { phase, bottomSince, bottomY, lastFireAt } = s;
  let fire = false, detail = '';
  if (t - lastFireAt < cfg.cooldownMs) return { phase, bottomSince, bottomY, lastFireAt, fire: false, detail: '' };
  if (phase === 'bottom') {
    if (t - bottomSince > 9000) { phase = 'tracking'; return { phase, bottomSince: 0, bottomY: 0, lastFireAt, fire: false, detail: '已重置，继续阅读' }; }
    const drop = bottomY - y;
    if (drop >= sweepNeeded && y <= topLine && t - bottomSince <= sweepWindow + dwell) {
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
    return {
      sensitivity: CLAMP(Number(c.gazeSensitivity) || 3, 1, 5),
      dwellMs: Number(c.gazeDwellMs) || 320,
      // 演示（sim）模式用更短的冷却，让翻页节奏清晰可见；真实检测仍走配置值。
      cooldownMs: simInjected ? 1000 : (Number(c.gazeCooldownMs) || 1600),
      sampleMs: Number(c.gazeSampleMs) || 90,
      calibration: c.gazeCalibration || null,
      prefer: c.gazeEngine || 'auto',
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
    phase = 'starting';
    emit('正在初始化端侧视线检测');
    const cfg = config();
    try {
    detector = await pickDetector(cfg.prefer);
    if (!detector) {
      // 诚实降级：无端侧模型且无系统人脸检测时，明确上报不可用，
      // 由上层（pro.setMode）降级为「定时自动翻页」并弹出说明，绝不留下死开关。
      throw new Error('本设备暂无可用视线检测引擎（未内置端侧模型且系统不支持人脸检测），已降级');
    }
    engineName = detector.name;
    simInjected = !!detector.simulate;
    cal = cfg.calibration || null;

    if (!simInjected) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('当前环境不支持摄像头');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 12, max: 15 } },
        audio: false,
      });
      video = makeVideo();
      video.srcObject = stream;
      await video.play();
      canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 120;
      ctx = canvas.getContext('2d', { willReadFrequently: false });
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
    return { ok: true, engine: engineName };
    } catch (e) {
      phase = 'unavailable';
      engineName = engineName || '不可用';
      cleanup();
      emit((e && e.message) || '摄像头不可用，已自动降级');
      return { ok: false, engine: engineName, reason: (e && e.message) || 'unavailable' };
    }
  }

  function cancelFrame() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (frameHandle && video && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(frameHandle); } catch (e) {}
    }
    frameHandle = null;
  }
  function loop() {
    if (!running || paused) return;
    if (video && video.requestVideoFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      rafId = requestAnimationFrame(onFrame);
    }
  }

  function onFrame() {
    if (!running || paused) return;
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
    const alpha = 0.38;
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
