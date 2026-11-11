// 红杉 Pro —— 阅读器交互增强层
//
// 这一层回答的是「为什么同类功能不好用」：自动翻页本身不难，难在它必须是
// 可预期（状态灯 + 翻页前预告）、可取消（点一下就停）、可撤销（误翻一键回退）、
// 可暂停（面板 / 选字 / 后台统一停摆）、可降级（设备不支持时给替代方案）的闭环。
// 同时也补齐阅读器最基础的几块：常驻进度、阅读内快捷设置、首次引导、滑动/音量键翻页、
// 跳转后返回原位置。
//
// 设计约束：本模块只通过 ctx 注入的回调与主控通信，不直接改 ci/pi，不引入任何裸
// @capacitor/* 导入；删除本文件与 css/pro.css、以及 app.js 里几行挂载即可完整回退。

const $ = (id) => document.getElementById(id);
const LS_GUIDE = 'inkreader:pro-guide-v1';
const AUTO_MODES = ['off', 'timed', 'adaptive', 'gaze'];
const AUTO_SOURCES = ['timed', 'adaptive', 'gaze'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function mountReaderPro(ctx) {
  const {
    turn, gaze,
    getSettings, setSetting, setLayoutSetting,
    seekByPct, restorePosition, getProgress, showToast,
  } = ctx;

  const root = document.createElement('div');
  root.id = 'pro-root';
  root.innerHTML = `
    <div id="pro-dim"></div>
    <div id="pro-bar" title="点击或拖动跳转进度"><div id="pro-fill"></div></div>
    <div id="pro-chip">
      <span id="pro-pct">0%</span>
      <button id="pro-back" class="pro-hidden" title="返回跳转前位置" aria-label="返回跳转前位置">↩</button>
      <button id="pro-aa" title="显示与排版" aria-label="显示与排版">Aa</button>
      <button id="pro-auto" title="自动翻页" aria-label="自动翻页">◎</button>
    </div>
    <div id="pro-status" data-phase="off"><i id="pro-dot"></i><span id="pro-status-text"></span></div>
    <div id="pro-predict" role="button" tabindex="0" aria-label="取消本次自动翻页">
      <span>即将自动翻页 · 点此取消</span>
      <div id="pro-predict-track"><div id="pro-predict-fill"></div></div>
    </div>
    <div id="pro-undo"><span>已自动翻页</span><button id="pro-undo-btn">撤销</button></div>

    <div id="pro-panel" role="dialog" aria-label="阅读设置">
      <div id="pro-tabs">
        <button data-tab="aa" class="active">显示 Aa</button>
        <button data-tab="auto">自动翻页</button>
      </div>

      <div id="pro-pane-aa">
        <h3>显示与排版</h3>
        <div class="pro-row"><span>字号</span><div class="pro-ctl">
          <button id="pro-font-minus" aria-label="减小字号">－</button>
          <span class="pro-val" id="pro-font-val">20px</span>
          <button id="pro-font-plus" aria-label="增大字号">＋</button></div></div>
        <div class="pro-row"><span>行距</span><div class="pro-ctl">
          <button id="pro-lh-minus" aria-label="减小行距">－</button>
          <span class="pro-val" id="pro-lh-val">1.75</span>
          <button id="pro-lh-plus" aria-label="增大行距">＋</button></div></div>
        <div class="pro-row"><span>主题</span><div class="pro-ctl" id="pro-theme-btns">
          <button data-theme="ink">墨水</button><button data-theme="simple">简约</button><button data-theme="night">夜览</button>
        </div></div>
        <div class="pro-row"><span>亮度</span><div class="pro-ctl">
          <input id="pro-bright" type="range" min="35" max="100" step="5" value="100" aria-label="阅读亮度" />
          <span class="pro-val" id="pro-bright-val">100%</span></div></div>
        <div class="pro-row"><span>翻页动画</span><div class="pro-ctl" id="pro-flip">
          <button data-val="off">关闭</button><button data-val="on">开启</button>
        </div></div>
        <p class="pro-note">设置即时生效并保存在本机。改字号 / 行距 / 主题后，<b>会按当前阅读位置重新分页</b>，不会跳回章首。</p>
      </div>

      <div id="pro-pane-auto" class="hidden">
        <h3>自动翻页</h3>
        <div class="pro-row"><span>方式</span><div class="pro-ctl" id="pro-mode">
          <button data-mode="off">关闭</button><button data-mode="timed">定时</button>
          <button data-mode="adaptive">跟节奏</button><button data-mode="gaze" class="camera-feature-only">视线</button>
        </div></div>
        <div class="pro-row"><span>翻页间隔</span><div class="pro-ctl">
          <input id="pro-interval" type="range" min="4" max="60" step="1" value="12" aria-label="自动翻页间隔" />
          <span class="pro-val" id="pro-interval-val">12s</span></div></div>
        <div class="pro-row"><span>翻页前预告</span><div class="pro-ctl">
          <input id="pro-confirm" type="range" min="0" max="2000" step="100" value="700" aria-label="翻页前预告时长" />
          <span class="pro-val" id="pro-confirm-val">700ms</span></div></div>
        <div class="pro-row camera-feature-only"><span>视线灵敏度</span><div class="pro-ctl">
          <input id="pro-sens" type="range" min="1" max="5" step="1" value="4" aria-label="视线灵敏度" />
          <span class="pro-val" id="pro-sens-val">4</span></div></div>
        <div class="pro-row camera-feature-only"><span>视线引擎</span><div class="pro-ctl">
          <select id="pro-gaze-engine" aria-label="视线检测引擎">
            <option value="auto">自动（真实·端侧）</option>
            <option value="sim">演示（模拟视线）</option>
          </select>
        </div></div>
        <div class="pro-row camera-feature-only"><span>视线省电</span><div class="pro-ctl" id="pro-gaze-power">
          <button data-val="off">关闭</button><button data-val="on">开启</button>
        </div></div>
        <div class="pro-row"><span>状态</span><div class="pro-ctl">
          <span id="pro-engine">引擎：未启动</span>
          <button id="pro-calibrate" class="camera-feature-only" disabled>校准</button>
        </div></div>
        <p class="pro-note">
          <span class="camera-feature-only">
            <b>视线翻页</b>：读到页底后，视线回到页首（回扫）即翻下一页；翻页前有预告，点一下可取消，误翻可撤销。<br />
            <b>隐私</b>：开启后仅调用前置摄像头做<b>本机端侧</b>检测，视频帧不上传、不保存、不写入日志；关闭 / 退出阅读器 / 切到后台立即释放摄像头。<br />
            <b>降级</b>：设备不支持或拒绝授权时，自动切换为「定时」，并在状态栏说明原因。<b>演示</b>：若设备无真实检测能力，可在「视线引擎」选「演示（模拟视线）」，它会自动注入回扫动作，让你在无摄像头时也能端到端看到 视线→翻页 链路真实生效（明确标注为模拟，非真实检测）。<br />
          </span>
          <b>跟随节奏</b>会学习你最近几次手动翻页的间隔。
        </p>
      </div>

      <div class="pro-actions"><button id="pro-close" class="primary">完成</button></div>
    </div>

    <div id="pro-guide" role="dialog" aria-label="阅读器使用提示">
      <div>
        <h2>开始阅读</h2>
        <div class="pro-gz">
          <span>点左侧<br />上一页</span><span>点中间<br />唤出菜单</span><span>点右侧<br />下一页</span>
        </div>
        <div>也可以左右滑动、用音量键翻页。底部 <b>Aa</b> 调排版，<b>◎</b> 开自动翻页<span class="camera-feature-only">（含视线回扫）</span>。</div>
        <button id="pro-guide-ok">知道了</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const s = () => getSettings() || {};
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  let runtimeMode = 'off';
  let pausedByUs = false;
  let predict = null;
  let undoTimer = null;
  let positionStack = [];
  let suppressClickUntil = 0;
  let activeTab = 'aa';

  // ---------- 进度与亮度 ----------
  function applyDim() {
    const b = clamp(num(s().brightness, 100), 35, 100);
    $('pro-dim').style.opacity = String(((100 - b) / 100) * 0.72);
  }
  function refresh() {
    const p = getProgress ? getProgress() : null;
    if (!p) return;
    const pct = clamp(num(p.pct, 0), 0, 100);
    $('pro-fill').style.width = pct.toFixed(2) + '%';
    $('pro-pct').textContent = pct.toFixed(0) + '%';
    $('pro-back').classList.toggle('pro-hidden', positionStack.length === 0);
    applyDim();
  }

  // ---------- 状态灯 ----------
  function setStatus(phase, text) {
    const box = $('pro-status');
    if (box) box.dataset.phase = phase;
    // 稳态不显示常驻文字条：tracking（视线追踪中/每 N 秒一页）与 off 都属于「背景态」，
    // 常驻提示会遮挡正文（用户反馈「视线追踪中」一直挡住文章内容）。只在 bottom（已读页底）、
    // sweep（准备翻页）、unavailable（不可用已降级）、lost（未检测到面部）、paused（已暂停）、
    // starting（初始化中）等有意义的瞬态/异常态才显示，既保留「可解释」，又不再挡正文。
    if (phase === 'off' || phase === 'tracking') { box.classList.remove('pro-on'); return; }
    if (runtimeMode === 'off' && phase !== 'unavailable') { box.classList.remove('pro-on'); return; }
    box.classList.add('pro-on');
    $('pro-status-text').textContent = text || '';
  }
  function setGazeStatus(st) {
    const phase = (st && st.phase) || 'off';
    const box = $('pro-status');
    if (box) box.dataset.phase = phase;
    if (runtimeMode === 'gaze') setStatus(phase, (st && st.detail) || phase);
    const eng = (st && st.engine) || gaze.getEngine() || '未启动';
    $('pro-engine').textContent = '引擎：' + eng + ((st && st.simulated) ? '（模拟）' : '');
    const cal = $('pro-calibrate');
    if (cal) cal.disabled = !gaze.isRunning();
  }

  // ---------- 暂停：所有「用户正在做别的事」的场景统一停摆 ----------
  function pauseReason() {
    const reader = $('reader');
    if (!reader || reader.classList.contains('hidden')) return '阅读器未打开';
    if (document.hidden) return '应用已切到后台';
    if (document.querySelector('.panel.open')) return '面板已打开';
    if ($('pro-panel').classList.contains('pro-on')) return '设置面板已打开';
    if ($('pro-guide').classList.contains('pro-on')) return '首次引导中';
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return '正在选字';
    for (const id of ['footnote-pop', 'hl-pop', 'translate-pop', 'ai-explain-pop']) {
      const n = $(id);
      if (n && !n.classList.contains('hidden')) return '弹层已打开';
    }
    return '';
  }
  function syncPause() {
    // 把阅读器控制条显隐同步到 #pro-root：两者是兄弟节点，CSS 无法用后代选择器关联。
    const readerEl = $('reader');
    if (readerEl && root) root.classList.toggle('pro-chrome', !readerEl.classList.contains('hide-chrome'));
    const reason = pauseReason();
    if (reason) {
      if (!pausedByUs) {
        pausedByUs = true;
        turn.pause(reason);
        if (gaze.isRunning()) gaze.pause(reason, document.hidden);
        if (predict) predict.cancel();
      }
      setStatus('paused', reason);
    } else {
      if (pausedByUs) {
        pausedByUs = false;
        turn.resume();
        if (runtimeMode === 'gaze' && gaze.isRunning()) gaze.resume();
      }
      if (runtimeMode !== 'off') setStatus('tracking', modeLabel(runtimeMode));
    }
  }
  function modeLabel(mode) {
    if (mode === 'gaze') return '视线回扫 · ' + (gaze.getEngine() || '检测中');
    if (mode === 'adaptive') return '跟随你的翻页节奏';
    return '每 ' + Math.round(num(s().autoIntervalMs, 12000) / 1000) + ' 秒一页';
  }

  // ---------- 预告 / 撤销 ----------
  turn.setBeforeTurn((dir, source) => {
    const ms = num(s().autoConfirmMs, 700);
    if (ms <= 0 || !AUTO_SOURCES.includes(source)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const box = $('pro-predict');
      const fill = $('pro-predict-fill');
      box.classList.add('pro-on');
      const t0 = Date.now();
      const tick = setInterval(() => {
        const left = Math.max(0, ms - (Date.now() - t0));
        fill.style.width = (left / ms * 100) + '%';
        if (left <= 0) finish(true);
      }, 40);
      function finish(ok) {
        clearInterval(tick);
        box.classList.remove('pro-on');
        predict = null;
        resolve(ok);
      }
      predict = { cancel: () => finish(false) };
      box.onclick = () => finish(false);
      box.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(false); } };
    });
  });

  function showUndo() {
    clearTimeout(undoTimer);
    $('pro-undo').classList.add('pro-on');
    undoTimer = setTimeout(() => $('pro-undo').classList.remove('pro-on'), 5000);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    $('pro-undo').classList.remove('pro-on');
  }
  $('pro-undo-btn').addEventListener('click', async () => {
    hideUndo();
    await turn.undo();
    refresh();
  });

  // ---------- 面板 ----------
  function openPanel(tab) {
    activeTab = tab || activeTab;
    document.querySelectorAll('#pro-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    $('pro-pane-aa').classList.toggle('hidden', activeTab !== 'aa');
    $('pro-pane-auto').classList.toggle('hidden', activeTab !== 'auto');
    $('pro-panel').classList.add('pro-on');
    renderAa(); renderAuto(); syncPause();
  }
  function closePanel() {
    $('pro-panel').classList.remove('pro-on');
    syncPause();
  }
  $('pro-aa').addEventListener('click', (e) => { e.stopPropagation(); openPanel('aa'); });
  $('pro-auto').addEventListener('click', (e) => { e.stopPropagation(); openPanel('auto'); });
  $('pro-close').addEventListener('click', closePanel);
  document.querySelectorAll('#pro-tabs button').forEach((b) =>
    b.addEventListener('click', () => openPanel(b.dataset.tab))
  );
  // 面板内的点击不应冒泡到阅读区触发翻页
  $('pro-panel').addEventListener('click', (e) => e.stopPropagation());

  function renderAa() {
    const st = s();
    $('pro-font-val').textContent = num(st.fontSize, 20) + 'px';
    $('pro-lh-val').textContent = num(st.lineHeight, 1.75).toFixed(2);
    $('pro-bright').value = String(clamp(num(st.brightness, 100), 35, 100));
    $('pro-bright-val').textContent = $('pro-bright').value + '%';
    document.querySelectorAll('#pro-theme-btns button').forEach((b) => b.classList.toggle('active', b.dataset.theme === st.theme));
    document.querySelectorAll('#pro-flip button').forEach((b) => b.classList.toggle('active', (b.dataset.val === 'on') === !!st.pageFlip));
    applyDim();
  }
  function renderAuto() {
    const st = s();
    document.querySelectorAll('#pro-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === (st.autoMode || 'off')));
    $('pro-interval').value = String(Math.round(clamp(num(st.autoIntervalMs, 12000), 4000, 60000) / 1000));
    $('pro-interval-val').textContent = $('pro-interval').value + 's';
    $('pro-confirm').value = String(clamp(num(st.autoConfirmMs, 700), 0, 2000));
    $('pro-confirm-val').textContent = $('pro-confirm').value + 'ms';
    $('pro-sens').value = String(clamp(num(st.gazeSensitivity, 4), 1, 5));
    $('pro-sens-val').textContent = $('pro-sens').value;
    const ge = $('pro-gaze-engine');
    if (ge) ge.value = (st.gazeEngine === 'sim' ? 'sim' : 'auto');
    const gp = $('pro-gaze-power');
    if (gp) gp.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.val === 'on') === !!st.gazePowerSave));
    setGazeStatus({ phase: gaze.getPhase(), engine: gaze.getEngine(), simulated: gaze.isSimulated() });
  }

  $('pro-font-minus').addEventListener('click', () => { setLayoutSetting('fontSize', clamp(num(s().fontSize, 20) - 2, 16, 32)); renderAa(); });
  $('pro-font-plus').addEventListener('click', () => { setLayoutSetting('fontSize', clamp(num(s().fontSize, 20) + 2, 16, 32)); renderAa(); });
  $('pro-lh-minus').addEventListener('click', () => { setLayoutSetting('lineHeight', clamp(+(num(s().lineHeight, 1.75) - 0.1).toFixed(2), 1.2, 2.4)); renderAa(); });
  $('pro-lh-plus').addEventListener('click', () => { setLayoutSetting('lineHeight', clamp(+(num(s().lineHeight, 1.75) + 0.1).toFixed(2), 1.2, 2.4)); renderAa(); });
  document.querySelectorAll('#pro-theme-btns button').forEach((b) =>
    b.addEventListener('click', () => { setLayoutSetting('theme', b.dataset.theme); renderAa(); })
  );
  $('pro-bright').addEventListener('input', (e) => { setSetting('brightness', Number(e.target.value)); renderAa(); });
  document.querySelectorAll('#pro-flip button').forEach((b) =>
    b.addEventListener('click', () => { setSetting('pageFlip', b.dataset.val === 'on'); renderAa(); })
  );

  // ---------- 自动翻页模式切换 ----------
  async function setMode(mode) {
    mode = AUTO_MODES.includes(mode) ? mode : 'off';
    // 送审版兜底：相机权限与「视线」入口已移除，任何残留设置 / 自动化路径都不允许走到
    // gaze 分支（否则会尝试 getUserMedia，留下「功能点了没反应」的死开关）。
    // 普通 PWA / 测试环境未定义该开关，开发版开关为 true，两种情况下行为完全不变。
    if (mode === 'gaze' && window.INK_CAMERA_ENABLED === false) mode = 'off';
    closePanel();
    if (mode === 'off') {
      gaze.stop();
      turn.stopAuto();
      runtimeMode = 'off';
      setSetting('autoMode', 'off');
      setStatus('off', '');
      renderAuto();
      return;
    }
    if (mode === 'gaze') {
      const res = await gaze.start();
      if (!res.ok) {
        // 明确的降级路径：绝不留下一个「开了却没反应」的开关。
        // 关键修正：用 gaze 返回的精确 reason / message，不再一句误导的「设备不支持」。
        runtimeMode = 'timed';
        setSetting('autoMode', 'timed');
        gaze.stop();
        turn.startAuto('timed', num(s().autoIntervalMs, 12000), num(s().autoConfirmMs, 700));
        setStatus('unavailable', '视线不可用 · ' + (res.message || '已降级为定时翻页'));
        if (showToast) {
          const tip = (res.reason === 'NO_DETECTOR' || res.reason === 'WEBVIEW_NO_API')
            ? '视线翻页暂不可用：' + (res.message || '') + '（可在「视线引擎」选「演示」预览）'
            : (res.message || '当前设备不支持端侧视线检测，已切换为「定时自动翻页」');
          showToast(tip);
        }
        renderAuto();
        syncPause();
        return;
      }
      runtimeMode = 'gaze';
      setSetting('autoMode', 'gaze');
      turn.startAuto('gaze', 12000, num(s().autoConfirmMs, 700));
      setStatus('tracking', '视线追踪已开启 · ' + (res.engine || ''));
    } else {
      gaze.stop();
      runtimeMode = mode;
      setSetting('autoMode', mode);
      turn.startAuto(mode, num(s().autoIntervalMs, 12000), num(s().autoConfirmMs, 700));
      setStatus('tracking', modeLabel(mode));
    }
    renderAuto();
    syncPause();
  }
  document.querySelectorAll('#pro-mode button').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode))
  );
  $('pro-interval').addEventListener('input', (e) => {
    const ms = Number(e.target.value) * 1000;
    setSetting('autoIntervalMs', ms);
    turn.updateAuto({ intervalMs: ms });
    renderAuto();
  });
  $('pro-confirm').addEventListener('input', (e) => {
    const ms = Number(e.target.value);
    setSetting('autoConfirmMs', ms);
    turn.updateAuto({ confirmMs: ms });
    renderAuto();
  });
  $('pro-sens').addEventListener('input', (e) => { setSetting('gazeSensitivity', Number(e.target.value)); renderAuto(); });
  document.querySelectorAll('#pro-gaze-power button').forEach((b) =>
    b.addEventListener('click', () => {
      setSetting('gazePowerSave', b.dataset.val === 'on');
      renderAuto();
      // 若正在视线模式，立即以新省电档位重新进入；否则仅记住设置，下次开启生效。
      if (runtimeMode === 'gaze') { gaze.stop(); setMode('gaze'); }
    })
  );
  $('pro-gaze-engine').addEventListener('change', (e) => {
    setSetting('gazeEngine', e.target.value === 'sim' ? 'sim' : 'auto');
    // 若正在视线模式，立即以新引擎重新进入；否则仅记住设置，下次开启生效。
    if (runtimeMode === 'gaze') { gaze.stop(); setMode('gaze'); }
    renderAuto();
  });
  $('pro-calibrate').addEventListener('click', () => {
    closePanel();
    if (gaze.calibrate()) {
      if (showToast) showToast('请平视页面顶部保持 1.5 秒，再看页面底部');
    }
  });

  // ---------- 进度条：点击 / 拖动跳转 ----------
  const bar = $('pro-bar');
  let seeking = false;
  let barRect = null; // 拖动期间缓存 rect，避免每次 pointermove 都触发布局读取
  const pctAt = (e) => {
    const r = barRect || bar.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / Math.max(1, r.width)) * 100, 0, 100);
  };
  bar.addEventListener('pointerdown', (e) => {
    seeking = true;
    barRect = bar.getBoundingClientRect();
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    $('pro-fill').style.width = pctAt(e) + '%';
    e.stopPropagation();
  });
  bar.addEventListener('pointermove', (e) => {
    if (seeking) $('pro-fill').style.width = pctAt(e) + '%';
  });
  bar.addEventListener('pointerup', async (e) => {
    if (!seeking) return;
    seeking = false;
    barRect = null;
    const pct = pctAt(e);
    suppressClickUntil = Date.now() + 380;
    try { await seekByPct(pct); } catch (err) {}
    refresh();
  });
  bar.addEventListener('click', (e) => e.stopPropagation());
  $('pro-chip').addEventListener('click', (e) => e.stopPropagation());

  // ---------- 返回跳转前的位置 ----------
  function remember() {
    const p = getProgress ? getProgress() : null;
    if (!p) return;
    positionStack.push({ ci: p.ci, pi: p.pi });
    if (positionStack.length > 30) positionStack.shift();
    refresh();
  }
  $('pro-back').addEventListener('click', async (e) => {
    e.stopPropagation();
    const pos = positionStack.pop();
    if (!pos) return;
    try {
      await restorePosition(pos);
      refresh();
      if (showToast) showToast('已返回跳转前的位置');
    } catch (err) {}
  });

  // ---------- 滑动翻页 + 点击预告取消 ----------
  const vp = $('page-viewport');
  let sx = 0, sy = 0, st = 0, tracking = false;
  vp.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY; st = Date.now(); tracking = true;
  });
  vp.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy, dt = Date.now() - st;
    if (dt > 650 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    suppressClickUntil = Date.now() + 380;
    turn.request(dx < 0 ? 'next' : 'prev', 'swipe');
  });
  vp.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil || predict) {
      if (predict) predict.cancel();
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Android 音量键由原生 dispatchKeyEvent 转发到这里（Web 端收不到音量键）
  window.__inkVolumeTurn = (dir) => {
    const reader = $('reader');
    if (!reader || reader.classList.contains('hidden')) return;
    turn.request(dir === 'prev' ? 'prev' : 'next', 'volume');
  };

  // ---------- 首次引导 ----------
  function maybeGuide() {
    let seen = false;
    try { seen = localStorage.getItem(LS_GUIDE) === '1'; } catch (e) {}
    if (seen) { $('pro-guide').classList.remove('pro-on'); return; }
    $('pro-guide').classList.add('pro-on');
  }
  $('pro-guide-ok').addEventListener('click', () => {
    $('pro-guide').classList.remove('pro-on');
    try { localStorage.setItem(LS_GUIDE, '1'); } catch (e) {}
    syncPause();
  });
  $('pro-guide').addEventListener('click', (e) => e.stopPropagation());

  // ---------- 暂停条件监听 ----------
  document.addEventListener('visibilitychange', syncPause);
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(syncPause, 160);
  });
  try {
    const obs = new MutationObserver(() => syncPause());
    obs.observe($('reader'), { attributes: true, attributeFilter: ['class'], subtree: true });
  } catch (e) {}

  // ---------- 生命周期 ----------
  function setReaderActive(on) {
    try {
      const bridge = window.AndroidScreenOn;
      if (bridge && bridge.setReaderActive) bridge.setReaderActive(on);
    } catch (e) { /* 纯浏览器 / PWA 无此桥，忽略 */ }
  }
  function onOpenBook() {
    positionStack = [];
    turn.reset();
    gaze.stop();
    setReaderActive(true);
    hideUndo();
    closePanel();
    // 摄像头属于敏感能力：不随设置自动恢复，每次进入阅读器都需要用户重新开启。
    const saved = s().autoMode || 'off';
    runtimeMode = saved === 'gaze' ? 'off' : saved;
    setSetting('autoMode', runtimeMode);
    if (runtimeMode !== 'off') {
      turn.startAuto(runtimeMode, num(s().autoIntervalMs, 12000), num(s().autoConfirmMs, 700));
      setStatus('tracking', modeLabel(runtimeMode));
    } else {
      turn.stopAuto();
      setStatus('off', '');
    }
    renderAa(); renderAuto(); refresh();
    maybeGuide();
    syncPause();
  }
  function onExit() {
    setReaderActive(false);
    gaze.stop();
    turn.stopAuto();
    turn.reset();
    hideUndo();
    closePanel();
    if (predict) predict.cancel();
    runtimeMode = 'off';
    setStatus('off', '');
  }
  function onTurn(source) {
    refresh();
    if (AUTO_SOURCES.includes(source)) showUndo();
  }

  renderAa(); renderAuto(); applyDim();

  return { onOpenBook, onExit, onTurn, refresh, remember, syncPause, setGazeStatus, setMode };
}
