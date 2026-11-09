// 红杉能力中心 · UI / 编排（v1.4.0）
import * as core from './aurora-core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let open = false;
let overlay = null;
let eyeTimer = null;
let readTick = null;

function showToast(msg) {
  let t = $('aurora-toast');
  if (!t) { t = document.createElement('div'); t.id = 'aurora-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ===== 新功能：亮度遮罩 =====
function applyBrightness() {
  const b = core.getBrightness();
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'aurora-dim'; $('reader')?.appendChild(overlay); }
  if (!overlay) return;
  const alpha = ((100 - b) / 100) * 0.7;
  overlay.style.background = alpha > 0 ? `rgba(0,0,0,${alpha.toFixed(3)})` : 'transparent';
}

// ===== 新功能：双击缩放 =====
function bindDblZoom() {
  const r = $('reader'); if (!r) return;
  r.addEventListener('dblclick', (e) => {
    if (core.getDblZoom() !== 'on') return;
    const inner = $('reader').querySelector('.reader-pages') || $('reader').querySelector('.book') || $('reader');
    inner.classList.toggle('aurora-zoom');
  });
}

// ===== 新功能：护眼提醒 =====
function restartEyeTimer() {
  clearInterval(eyeTimer);
  const m = core.getEyeRest(); if (m <= 0) return;
  eyeTimer = setInterval(() => {
    if (document.body.classList.contains('reader-active')) showToast('护眼提醒：看了 ' + m + ' 分钟，看看远处放松一下 👀');
  }, m * 60 * 1000);
}

// ===== 新功能：阅读时长累计（独立，用于目标/打卡）=====
function startReadTick() {
  clearInterval(readTick);
  readTick = setInterval(() => {
    if (document.body.classList.contains('reader-active')) core.addReadingMinutes(1);
  }, 60 * 1000);
}

// ===== 新功能：金句分享图（canvas）=====
function buildShareImage(quote, book, ctx) {
  const W = 1080, H = 1080;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  // 纸感背景
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#f6efe2'); g.addColorStop(1, '#efe6d3');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // 红杉红印章
  x.fillStyle = '#A81F1F'; x.fillRect(80, 80, 150, 150);
  x.fillStyle = '#fff'; x.font = 'bold 64px serif'; x.fillText('红杉', 108, 175);
  // 引号
  x.fillStyle = '#A81F1F'; x.font = 'bold 200px serif'; x.fillText('“', 90, 360);
  // 正文（自动换行）
  x.fillStyle = '#2b2b2b'; x.font = '46px serif';
  const maxW = W - 200; const lines = []; let line = '';
  for (const ch of quote) { if (x.measureText(line + ch).width > maxW) { lines.push(line); line = ch; } else line += ch; }
  if (line) lines.push(line);
  let y = 440; for (const l of lines.slice(0, 12)) { x.fillText(l, 120, y); y += 76; }
  // 署名
  x.fillStyle = '#8a7a5c'; x.font = '36px serif';
  x.fillText('—— 《' + (book || '红杉阅读') + '》', 120, H - 140);
  x.fillText('来自 红杉阅读 · Sequoia', 120, H - 90);
  return c;
}

// ===== 能力中心 UI =====
function render() {
  const c = core.counts();
  const pct = Math.round((c.done / c.total) * 100);
  const groups = core.byGroup();
  const ring = `<svg class="au-ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="au-ring-bg"/><circle cx="60" cy="60" r="52" class="au-ring-fg" style="stroke-dasharray:${(pct/100*326.7).toFixed(1)} 326.7"/></svg><div class="au-ring-txt">${pct}%</div>`;
  const tabs = ['all', ...core.REDWOOD_GROUPS].map((g) => `<button class="au-tab${g === 'all' ? ' active' : ''}" data-g="${esc(g)}">${g === 'all' ? '全部' : esc(g)}</button>`).join('');
  const list = (() => {
    let html = ''; let lastG = '';
    for (const r of core.REDWOOD_200) {
      if (lastG !== r.g) { html += `<div class="au-gh">${esc(r.g)}</div>`; lastG = r.g; }
      const badge = r.s === 'done' ? '<span class="au-b au-done">已落地</span>' : r.s === 'partial' ? '<span class="au-b au-par">部分</span>' : '<span class="au-b au-pla">规划</span>';
      html += `<div class="au-row"><span class="au-id">${r.id}</span><b>${esc(r.t)}</b>${badge}<span class="au-desc">${esc(r.d)}</span></div>`;
    }
    return html;
  })();

  const goal = core.getGoal(), today = core.todayMinutes(), streak = core.streakClean();
  const myPanel = `
    <div class="au-my">
      <h3>我的红杉</h3>
      <label>每日阅读目标（分钟）<input id="au-goal" type="number" min="0" value="${goal}" style="width:80px"></label>
      <div class="au-stat">今日已读 <b>${today}</b> 分钟 ｜ 连续打卡 <b>${streak}</b> 天 ${goal > 0 ? '｜ 目标 ' + Math.min(100, Math.round(today / goal * 100)) + '%' : ''}</div>
      <label>护眼提醒（分钟，0=关）<input id="au-eye" type="number" min="0" value="${core.getEyeRest()}" style="width:80px"></label>
      <label>屏幕亮度遮罩（%）<input id="au-bri" type="range" min="20" max="100" value="${core.getBrightness()}"></label>
      <label>双击缩放（阅读页）<input id="au-zoom" type="checkbox" ${core.getDblZoom() === 'on' ? 'checked' : ''}></label>
      <button id="au-celebrate" class="au-btn">🎉 预览达成庆祝</button>
      <h3>金句分享图</h3>
      <textarea id="au-quote" rows="3" placeholder="粘贴一句想分享的话……" style="width:100%"></textarea>
      <input id="au-book" type="text" placeholder="书名（可选）" style="width:100%;margin:4px 0">
      <button id="au-share" class="au-btn">生成并下载分享图</button>
    </div>`;

  $('aurora-body').innerHTML = `
    <div class="au-top">${ring}
      <div class="au-counts">✅ ${c.done} 已落地 ｜ 🟡 ${c.partial} 部分 ｜ ⬜ ${c.planned} 规划 ｜ 共 ${c.total}</div>
      <input id="au-search" class="au-search" placeholder="搜索 200 项能力……">
    </div>
    <div class="au-my-wrap">${myPanel}</div>
    <div class="au-tabs">${tabs}</div>
    <div id="au-list" class="au-list">${list}</div>`;

  $('au-goal').addEventListener('change', (e) => { core.setGoal(+e.target.value || 0); render(); });
  $('au-eye').addEventListener('change', (e) => { core.setEyeRest(+e.target.value || 0); restartEyeTimer(); });
  $('au-bri').addEventListener('input', (e) => { core.setBrightness(+e.target.value); applyBrightness(); });
  $('au-zoom').addEventListener('change', (e) => { core.setDblZoom(e.target.checked ? 'on' : 'off'); });
  $('au-celebrate').addEventListener('click', () => celebrate());
  $('au-share').addEventListener('click', () => {
    const q = $('au-quote').value.trim(); if (!q) { showToast('先写一句想分享的话'); return; }
    const c = buildShareImage(q, $('au-book').value.trim(), null);
    c.toBlob((blob) => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '红杉金句.png'; a.click();
      showToast('分享图已生成');
    });
  });
  $('au-search').addEventListener('input', (e) => filterList(e.target.value));
  $('aurora-body').querySelectorAll('.au-tab').forEach((b) => b.addEventListener('click', () => {
    $('aurora-body').querySelectorAll('.au-tab').forEach((x) => x.classList.toggle('active', x === b));
    filterList($('au-search').value, b.dataset.g);
  }));
}

function filterList(q, group) {
  group = group || ($('aurora-body').querySelector('.au-tab.active')?.dataset.g || 'all');
  const rows = core.filterRows(core.REDWOOD_200, { group, q });
  const map = new Map(core.REDWOOD_200.map((r) => [r.id, r]));
  let html = ''; let lastG = '';
  for (const r of rows) {
    if (lastG !== r.g) { html += `<div class="au-gh">${esc(r.g)}</div>`; lastG = r.g; }
    const badge = r.s === 'done' ? '<span class="au-b au-done">已落地</span>' : r.s === 'partial' ? '<span class="au-b au-par">部分</span>' : '<span class="au-b au-pla">规划</span>';
    html += `<div class="au-row"><span class="au-id">${r.id}</span><b>${esc(r.t)}</b>${badge}<span class="au-desc">${esc(r.d)}</span></div>`;
  }
  $('au-list').innerHTML = html || '<div class="au-empty">无匹配项</div>';
}

function celebrate() {
  const wrap = document.createElement('div'); wrap.id = 'au-confetti'; document.body.appendChild(wrap);
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw'; p.style.background = ['#A81F1F', '#2EA84F', '#FFD23F', '#E2453B'][i % 4];
    p.style.animationDelay = (Math.random() * 0.6) + 's'; wrap.appendChild(p);
  }
  showToast('🎉 恭喜达成！连续阅读 ' + core.streakClean() + ' 天');
  setTimeout(() => wrap.remove(), 2600);
}

export function mountAurora(ctx) {
  if ($('aurora-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'aurora-panel'; panel.className = 'hidden';
  panel.innerHTML = `<div id="aurora-head">红杉能力中心 · 200 项<input id="aurora-close" type="button" value="✕"></div><div id="aurora-body"></div>`;
  document.body.appendChild(panel);
  $('aurora-close').addEventListener('click', () => setOpen(false));
  panel.addEventListener('click', (e) => { if (e.target === panel) setOpen(false); });
  document.querySelectorAll('[data-aurora-open]').forEach((b) => b.addEventListener('click', () => setOpen(true)));
  render();
  applyBrightness(); bindDblZoom(); restartEyeTimer(); startReadTick();
}

export function setOpen(v) {
  open = v;
  const p = $('aurora-panel'); if (!p) return;
  p.classList.toggle('hidden', !open);
  if (open) { render(); applyBrightness(); }
}
export function toggleAurora() { setOpen(!open); }
