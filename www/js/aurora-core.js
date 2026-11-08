// 红杉能力中心 · 纯逻辑内核（零 DOM 副作用，可在 Node 中直接 import 单测）
import { REDWOOD_200, REDWOOD_GROUPS } from './aurora-registry.js';

export { REDWOOD_200, REDWOOD_GROUPS };

const LS = {
  brightness: 'aurora:brightness', // 0~100，<100 为压暗遮罩
  eyeRest: 'aurora:eyeRest',       // 分钟，0=关闭护眼提醒
  dblZoom: 'aurora:dblZoom',       // 'on'/'off' 双击缩放
  goal: 'aurora:goal',             // 每日阅读目标（分钟）
  daily: 'aurora:daily',           // { 'YYYY-MM-DD': 分钟 }
};

export const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
export const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const getBrightness = () => read(LS.brightness, 100);
export const setBrightness = (n) => write(LS.brightness, Math.max(20, Math.min(100, n | 0)));
export const getEyeRest = () => read(LS.eyeRest, 0);
export const setEyeRest = (m) => write(LS.eyeRest, Math.max(0, m | 0));
export const getDblZoom = () => read(LS.dblZoom, 'off');
export const setDblZoom = (v) => write(LS.dblZoom, v === 'on' ? 'on' : 'off');
export const getGoal = () => read(LS.goal, 0);
export const setGoal = (m) => write(LS.goal, Math.max(0, m | 0));

export const todayKey = (d = new Date()) => {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const addReadingMinutes = (mins) => {
  if (!(mins > 0)) return;
  const d = read(LS.daily, {}); const k = todayKey();
  d[k] = (d[k] || 0) + mins; write(LS.daily, d);
};
export const todayMinutes = () => read(LS.daily, {})[todayKey()] || 0;
// 连续打卡：从今天往前数连续有阅读记录的天数
export const streak = () => {
  const d = read(LS.daily, {}); let n = 0; const cur = new Date();
  for (;;) { const k = todayKey(cur); if ((d[k] || 0) > 0) n++; else if (n > 0 || k !== todayKey()) break; if (k !== todayKey() && (d[k] || 0) === 0) break; cur.setDate(cur.getDate() - 1); if (n === 0 && (d[k] || 0) === 0 && k !== todayKey()) break; }
  return n;
};
// 若今天尚无记录，streak 从昨天起算更合理
export const streakClean = () => {
  const d = read(LS.daily, {}); let n = 0; const cur = new Date();
  // 今天没读则不算今天
  if (!(d[todayKey()] > 0)) cur.setDate(cur.getDate() - 1);
  while (d[todayKey(cur)] > 0) { n++; cur.setDate(cur.getDate() - 1); }
  return n;
};

export const counts = (rows = REDWOOD_200) => {
  const c = { done: 0, partial: 0, planned: 0, total: rows.length };
  for (const r of rows) c[r.s]++;
  return c;
};
export const filterRows = (rows, { group = 'all', q = '' } = {}) => {
  const g = group === 'all' ? null : group;
  const t = q.trim().toLowerCase();
  return rows.filter((r) => (!g || r.g === g) && (!t || r.t.toLowerCase().includes(t) || r.d.toLowerCase().includes(t) || r.id.toLowerCase().includes(t)));
};
export const byGroup = (rows = REDWOOD_200) => {
  const m = {}; for (const r of rows) (m[r.g] ||= []).push(r); return m;
};
