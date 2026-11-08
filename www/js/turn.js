// 水杉阅读 —— 统一翻页编排层（Page Turn Orchestrator）
//
// 为什么需要这一层：翻页是阅读器里唯一「高频 + 必须确定」的操作。把点击、滑动、键盘、
// 音量键、定时自动翻页、视线回扫各自直接调 nextPage()，必然出现竞态（PDF 异步渲染写 DOM）、
// 误触连翻、自动翻页与手动翻页打架、误翻无法回退。行业成熟做法是把所有输入收敛成一个
// 「输入源 -> 编排层 -> 单一翻页出口」的结构：
//   * 串行化：任一时刻只有一个翻页在跑
//   * 冷却/去重：一次凝视手势、一次长按只翻一页
//   * 可预告：自动翻页前给出倒计时，用户可一键取消
//   * 可撤销：任何来源的翻页都能一键回到刚才那一页
//   * 可暂停：面板打开 / 后台 / 划词 / 低电量时统一停摆
// 本模块不感知 DOM 与书籍，只依赖注入的 perform / getPosition / restore，便于独立测试。

const HISTORY_CAP = 24;

export function createTurnController(opts) {
  const {
    perform,                    // async (dir) => void，唯一真实翻页出口
    getPosition,                // () => { ci, pi } | null
    restore,                    // async (pos) => void，跳回某个位置
    canTurn = () => true,       // () => boolean，阅读器是否可翻页
    onTurn = () => {},          // ({ dir, source }) => void
    onState = () => {},         // (state) => void
    cooldownMs = 170,
  } = opts;

  let chain = Promise.resolve();
  let paused = false;
  let pauseReason = '';
  let cooldown = cooldownMs;
  let lastAt = 0;
  let lastSource = '';       // 最近一次受理的翻页来源（供 Plus 的意图/统计判定读取）
  let beforeTurn = null;        // async (dir, source) => boolean，false = 用户取消
  const history = [];           // 撤销栈：翻页前的位置快照
  const manualGaps = [];        // 最近手动翻页间隔，用于「跟随阅读节奏」自适应
  let lastManualAt = 0;

  const auto = {
    active: false,
    mode: 'off',                // off | timed | adaptive | gaze
    intervalMs: 12000,
    confirmMs: 700,
    timer: null,
    busy: false,
  };

  function state(extra) {
    return Object.assign({
      paused, pauseReason, cooldown, lastSource,
      auto: { active: auto.active, mode: auto.mode, intervalMs: auto.intervalMs, confirmMs: auto.confirmMs },
      canUndo: history.length > 0,
    }, extra || {});
  }
  function broadcast(extra) { try { onState(state(extra)); } catch (e) {} }

  // 自动来源（定时 / 节奏 / 视线）受暂停门控；手动来源任何时候都必须可用，
  // 否则「打开目录面板时不能手动翻页」会变成新的状态机陷阱。
  const AUTO_SOURCES = { timed: 1, adaptive: 1, gaze: 1 };

  // 所有翻页的唯一入口。返回 boolean 表示「是否被受理」，不表示翻页是否真的发生。
  function request(dir, source = 'manual') {
    if (!canTurn()) return Promise.resolve(false);
    if (paused && AUTO_SOURCES[source] && source !== 'undo') return Promise.resolve(false);
    const now = Date.now();
    if (now - lastAt < cooldown) return Promise.resolve(false);
    lastAt = now;
    lastSource = source;

    if (source === 'manual' || source === 'swipe' || source === 'volume' || source === 'key') {
      if (lastManualAt) {
        manualGaps.push(now - lastManualAt);
        if (manualGaps.length > 6) manualGaps.shift();
      }
      lastManualAt = now;
    }

    chain = chain.then(async () => {
      if (!canTurn()) return;
      let allowed = true;
      // 预告/取消只针对自动翻页：手动点击必须瞬时响应，不能等倒计时。
      if (beforeTurn && AUTO_SOURCES[source]) {
        try { allowed = await beforeTurn(dir, source); } catch (e) { allowed = true; }
      }
      if (!allowed || !canTurn()) return;

      const before = getPosition();
      await perform(dir);
      const after = getPosition();
      if (before && after && (before.ci !== after.ci || before.pi !== after.pi)) {
        history.push(before);
        if (history.length > HISTORY_CAP) history.shift();
      }
      try { onTurn({ dir, source }); } catch (e) {}
      broadcast();
    }).catch(() => { /* 单页渲染失败不能锁死整条队列 */ });
    return chain.then(() => true);
  }

  async function undo() {
    if (!history.length || !canTurn()) return false;
    const pos = history.pop();
    try {
      await restore(pos);
      try { onTurn({ dir: 'undo', source: 'undo' }); } catch (e) {}
      broadcast();
      return true;
    } catch (e) {
      history.push(pos);
      return false;
    }
  }

  function pause(reason) {
    if (paused && pauseReason === reason) return;
    paused = true;
    pauseReason = reason || '';
    clearTimeout(auto.timer);
    broadcast();
  }
  function resume() {
    if (!paused) return;
    paused = false;
    pauseReason = '';
    if (auto.active && auto.mode !== 'gaze') scheduleAuto();
    broadcast();
  }

  // 定时 / 节奏跟随：由编排层自己驱动，视线模式则完全由外部信号源驱动。
  function scheduleAuto() {
    clearTimeout(auto.timer);
    if (!auto.active || paused || auto.mode === 'gaze' || auto.busy) return;
    const delay = auto.mode === 'adaptive' ? adaptiveInterval() : auto.intervalMs;
    auto.timer = setTimeout(async () => {
      if (!auto.active || paused || auto.busy) { scheduleAuto(); return; }
      auto.busy = true;
      try { await request('next', auto.mode); } finally { auto.busy = false; }
      scheduleAuto();
    }, delay);
  }

  function adaptiveInterval() {
    if (manualGaps.length < 3) return auto.intervalMs;
    const sorted = manualGaps.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.max(4000, Math.min(60000, Math.round(median * 1.15)));
  }

  function startAuto(mode, intervalMs, confirmMs) {
    stopAuto();
    auto.active = true;
    auto.mode = mode || 'timed';
    auto.intervalMs = Math.max(2000, Number(intervalMs) || 12000);
    auto.confirmMs = Math.max(0, Number(confirmMs) || 0);
    if (auto.mode !== 'gaze') scheduleAuto();
    broadcast();
  }
  function stopAuto() {
    clearTimeout(auto.timer);
    auto.timer = null;
    auto.active = false;
    auto.mode = 'off';
    auto.busy = false;
    broadcast();
  }
  function updateAuto(patch) {
    if (typeof patch.intervalMs === 'number') auto.intervalMs = Math.max(2000, patch.intervalMs);
    if (typeof patch.confirmMs === 'number') auto.confirmMs = Math.max(0, patch.confirmMs);
    if (auto.active && auto.mode !== 'gaze') scheduleAuto();
    broadcast();
  }

  function reset() {
    history.length = 0;
    manualGaps.length = 0;
    lastManualAt = 0;
    lastAt = 0;
    broadcast();
  }
  function destroy() {
    stopAuto();
    chain = Promise.resolve();
    history.length = 0;
  }

  return {
    request, undo, pause, resume, reset, destroy,
    startAuto, stopAuto, updateAuto,
    setBeforeTurn: (fn) => { beforeTurn = fn; },
    getBeforeTurn: () => beforeTurn, // Plus：组合章末停与 Pro 的预告，避免互相覆盖
    setCooldown: (ms) => { cooldown = Math.max(0, Number(ms) || 0); broadcast(); },
    getState: () => state(),
    isPaused: () => paused,
  };
}
