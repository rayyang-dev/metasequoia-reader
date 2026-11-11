// 红杉 Aurora 后台能力（v1.4.6）——独立层，零污染、可回退。
//
// 「红杉能力中心 · 200 项」清单面板已按需求移除：设置页入口、面板 DOM、清单样式与
// 相关回归用例一并删除。200 项能力的状态仍保留在 aurora-registry.js / docs/roadmap-200.md，
// 由代码核对后同步，不再以 App 内清单的形式展示。
//
// 本文件只保留不依赖面板、常驻生效的后台能力：
//   · 屏幕亮度遮罩（#aurora-dim）
//   · 护眼提醒 toast（定时提醒）
//   · 双击缩放（阅读页）
//   · 阅读时长累计（供每日目标 / 连续打卡统计）
// 设置与统计仍由 aurora-core.js 读写 localStorage，历史用户数据不受影响。
//
// 回退方式：从 git 历史取回旧版 aurora.js / aurora.css，并在 index.html 的
// 「我的内容」分组补回 <button data-aurora-open> 即可，其余业务代码无需改动。
import * as core from './aurora-core.js';

const $ = (id) => document.getElementById(id);

let overlay = null;
let eyeTimer = null;
let readTick = null;

function showToast(msg) {
  let t = $('aurora-toast');
  if (!t) { t = document.createElement('div'); t.id = 'aurora-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ===== 亮度遮罩 =====
function applyBrightness() {
  const b = core.getBrightness();
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'aurora-dim'; $('reader')?.appendChild(overlay); }
  if (!overlay) return;
  const alpha = ((100 - b) / 100) * 0.7;
  overlay.style.background = alpha > 0 ? `rgba(0,0,0,${alpha.toFixed(3)})` : 'transparent';
}

// ===== 双击缩放 =====
function bindDblZoom() {
  const r = $('reader'); if (!r) return;
  r.addEventListener('dblclick', (e) => {
    if (core.getDblZoom() !== 'on') return;
    const inner = $('reader').querySelector('.reader-pages') || $('reader').querySelector('.book') || $('reader');
    inner.classList.toggle('aurora-zoom');
  });
}

// ===== 护眼提醒 =====
function restartEyeTimer() {
  clearInterval(eyeTimer);
  const m = core.getEyeRest(); if (m <= 0) return;
  eyeTimer = setInterval(() => {
    if (document.body.classList.contains('reader-active')) showToast('护眼提醒：看了 ' + m + ' 分钟，看看远处放松一下 👀');
  }, m * 60 * 1000);
}

// ===== 阅读时长累计（独立，用于目标/打卡统计）=====
function startReadTick() {
  clearInterval(readTick);
  readTick = setInterval(() => {
    if (document.body.classList.contains('reader-active')) core.addReadingMinutes(1);
  }, 60 * 1000);
}

export function mountAurora() {
  applyBrightness(); bindDblZoom(); restartEyeTimer(); startReadTick();
}
