// 红杉能力中心 Aurora v1.4.0 —— 纯逻辑内核回归（Node 环境）
import * as core from '../www/js/aurora-core.js';

// Node 环境提供 localStorage 桩，使读写函数可测
const _ls = new Map();
global.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};

let pass = 0, fail = 0;
const t = (n, f) => { try { if (f()) { pass++; } else { fail++; console.log('  ✗', n); } } catch (e) { fail++; console.log('  ✗', n, e.message); } };

t('注册表共 200 项', () => core.REDWOOD_200.length === 200);
t('共 12 个能力维度', () => core.REDWOOD_GROUPS.length === 12);
t('每项含 id/g/t/d/s', () => core.REDWOOD_200.every((r) => r.id && r.g && r.t && r.d && ['done', 'partial', 'planned'].includes(r.s)));
t('counts.total=200', () => core.counts().total === 200);
t('counts 三段非负', () => { const c = core.counts(); return c.done + c.partial + c.planned === 200; });
t('byGroup 分组数=12', () => Object.keys(core.byGroup()).length === 12);
t('filterRows 按分组过滤', () => core.filterRows(core.REDWOOD_200, { group: '阅读排版' }).every((r) => r.g === '阅读排版'));
t('filterRows 搜索命中标题', () => core.filterRows(core.REDWOOD_200, { q: '护眼' }).length > 0);
t('filterRows 搜索命中 id', () => { const r = core.filterRows(core.REDWOOD_200, { q: 'R-111' }); return r.length === 1 && r[0].id === 'R-111'; });
t('todayKey 格式 YYYY-MM-DD', () => /^\d{4}-\d{2}-\d{2}$/.test(core.todayKey(new Date(2026, 10, 8))));
t('默认亮度=100', () => core.getBrightness() === 100);
t('设置亮度区间夹取', () => { core.setBrightness(150); return core.getBrightness() === 100; });
t('护眼提醒默认=0', () => core.getEyeRest() === 0);
t('双击缩放默认 off', () => core.getDblZoom() === 'off');
t('目标默认=0', () => core.getGoal() === 0);

// 阅读时长累计 + 连续打卡
_ls.clear();
core.addReadingMinutes(0); t('0 分钟不累计', () => core.todayMinutes() === 0);
core.addReadingMinutes(10); core.addReadingMinutes(5); t('累计今日 15 分钟', () => core.todayMinutes() === 15);
t('今天有记录则 streak>=1', () => core.streakClean() >= 1);
_ls.clear();
t('无记录则 streak=0', () => core.streakClean() === 0);

console.log(`Aurora 纯逻辑回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
