// AI 引擎：让本地阅读器具备「摘要/导读、选中即问、书中问答、阅读笔记、智能标签、段落双语」
// 设计原则（与全应用一致）：
//   1. 本地优先 + 隐私：仅使用读者自己在「AI 引擎」里配置的 Key/模型；Key 只在本机，本应用无服务器。
//   2. 默认不主动联网：所有能力只有在 provider='llm' 且填入 Key 后才会联网。
//   3. 结果缓存：书籍级结果（摘要/标签/笔记）由调用方持久化到 book.ai（IndexedDB），避免重复消耗。
// 底层统一走 js/llm.js 的 OpenAI 兼容客户端。

import { loadSettings } from './store.js';
import { llmChat, llmChatJson } from './llm.js';
import { translateText } from './translate.js';

// ---------- 配置 ----------
export function aiConfigured() {
  const s = loadSettings();
  return s.translateProvider === 'llm' && !!s.translateApiKey;
}
export function aiModel() {
  return (loadSettings().translateLlmModel || 'gpt-4o-mini');
}
function cfg() {
  const s = loadSettings();
  return {
    base: s.translateLlmBase || 'https://api.openai.com/v1',
    apiKey: s.translateApiKey || '',
    model: s.translateLlmModel || 'gpt-4o-mini',
  };
}
function assertCfg() {
  if (!aiConfigured()) {
    throw new Error('请先在「阅读设置 → AI 引擎」选择「AI 大模型」并填写 API Key，本应用才会联网调用 AI。');
  }
  return cfg();
}

// ---------- 文本抽取 ----------
function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

// 把整本书压成一段「摘要用」文本：保留全部章节标题，正文每章截取上限，整体受 budget 约束。
function buildDigest(book, budget = 8000) {
  const out = [];
  let total = 0;
  for (const ch of book.chapters) {
    const remaining = budget - total;
    if (remaining <= 40) break;
    const titleLine = ch.title ? '【' + ch.title + '】' : '';
    const body = htmlToText(ch.html);
    const cap = Math.max(0, Math.min(600, remaining - titleLine.length - 2));
    const slice = body.slice(0, cap);
    const piece = titleLine + (titleLine ? '\n' : '') + slice;
    out.push(piece);
    total += piece.length;
  }
  return {
    title: book.title || '未知书名',
    author: book.author || '',
    chapterCount: book.chapters.length,
    titles: book.chapters.map((c) => c.title || '').filter(Boolean),
    text: out.join('\n\n'),
  };
}

// ---------- 轻量 RAG（书中问答用） ----------
function tokenizeQuery(q) {
  const tokens = [];
  const cjk = q.match(/[一-鿿]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) { if (!STOP1.has(run)) tokens.push(run); }
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  const latin = q.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const w of latin) if (w.length > 1) tokens.push(w);
  return tokens;
}
const STOP1 = new Set(['的','了','是','在','我','你','他','她','它','们','这','那','有','和','与','及','也','都','就','而','把','被','让','给','个','之','其','为','以','于','上','下','不','没','又','还','很','到','会','能','要','可','但','却','若','如','因','果','们']);

function retrieveRelevant(book, query, k = 5, budget = 3500) {
  const toks = tokenizeQuery(query);
  if (!toks.length) return { context: '', chapters: [] };
  const chunks = [];
  book.chapters.forEach((ch) => {
    const body = htmlToText(ch.html);
    const paras = body.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter((s) => s.length > 4);
    paras.forEach((p) => chunks.push({ ch: ch.title || '', text: p }));
  });
  const scored = chunks
    .map((c) => {
      let s = 0;
      for (const t of toks) {
        if (t.length < 2) continue;
        let n = 0;
        if (/[a-z0-9]/.test(t)) {
          const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          const m = c.text.toLowerCase().match(re);
          n = m ? m.length : 0;
        } else {
          let idx = 0;
          while ((idx = c.text.indexOf(t, idx)) !== -1) { n++; idx += t.length; }
        }
        s += n;
      }
      return { c, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);

  let ctx = '';
  for (const { c } of scored) {
    if (ctx.length >= budget) break;
    const marker = c.ch ? '（' + c.ch + '）' : '';
    const piece = marker + c.text;
    if (ctx.length + piece.length > budget) ctx += piece.slice(0, Math.max(0, budget - ctx.length));
    else ctx += piece + '\n';
  }
  return { context: ctx.trim(), chapters: scored.map((x) => x.c.ch).filter(Boolean) };
}

// ---------- ① 摘要 / 导读 ----------
// scope: { type:'book' } 或 { type:'chapter', index } 或 { type:'chapter', title, text }
export async function aiSummary(book, scope) {
  const c = assertCfg();
  let digestTitle = book.title;
  let digestAuthor = book.author || '';
  let digestText;
  let scopeLabel;

  if (scope && scope.type === 'chapter') {
    if (scope.text != null) {
      digestTitle = book.title + ' · ' + (scope.title || '章节');
      digestText = (scope.title ? '【' + scope.title + '】\n' : '') + htmlToText(scope.text);
    } else {
      const ch = book.chapters[scope.index];
      if (!ch) throw new Error('章节索引越界');
      digestTitle = book.title + ' · ' + (ch.title || '章节');
      digestText = '【' + (ch.title || '') + '】\n' + htmlToText(ch.html);
    }
    scopeLabel = '本章导读';
  } else {
    const d = buildDigest(book);
    digestTitle = d.title;
    digestAuthor = d.author;
    digestText = d.text;
    scopeLabel = '全书导读';
  }

  const sys =
    '你是一位专业的图书导读编辑。请基于用户提供的书目信息，用简体中文输出两部分内容：\n' +
    '## 内容概要\n概括本书/本章的主题、核心内容与结构脉络。\n' +
    '## 阅读导读\n给出阅读背景、应重点关注的线索或概念、以及阅读节奏建议。\n' +
    '要点用 - 列表，关键概念用 **加粗**。不要编造材料中不存在的信息；材料不足时基于已有内容合理推断并注明“推断”。';
  const user =
    '书名：' + digestTitle + (digestAuthor ? '\n作者：' + digestAuthor : '') +
    '\n类型：' + scopeLabel + '\n\n书目信息（含目录与正文摘录）：\n' + digestText;

  const raw = await llmChat({
    baseUrl: c.base, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });
  // 拆分为 summary / guide
  let summary = raw, guide = '';
  const m = raw.split(/##\s*阅读导读/i);
  if (m.length >= 2) {
    summary = (m[0].replace(/##\s*内容概要/i, '').trim());
    guide = ('## 阅读导读\n' + m[1].trim());
  }
  return { summary: summary.trim(), guide: guide.trim() || raw.trim(), raw };
}

// ---------- ② 选中即问 / 概念解释 ----------
const explainCache = new Map();
export async function aiExplain(text, book, contextText) {
  const cacheKey = text;
  if (explainCache.has(cacheKey)) return explainCache.get(cacheKey);
  const c = assertCfg();
  const ctx = contextText || buildDigest(book, 2500).text;
  const sys =
    '你是一位博学的伴读助手。用户正在阅读一本书，选中了一段文字（可能是术语、典故、难句或概念）。' +
    '请结合整本书的上下文，用简体中文简明扼要地解释这段话的含义、背景或所指，帮助读者理解。' +
    '控制在 220 字以内；除非所选内容已包含，否则避免剧透后续情节。若无法判断，如实说明。';
  const user = '本书上下文摘录：\n' + ctx + '\n\n用户选中的内容：\n' + text;
  const raw = await llmChat({
    baseUrl: c.base, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });
  const out = raw.trim();
  explainCache.set(cacheKey, out);
  return out;
}

// ---------- ③ 书中问答（轻量 RAG） ----------
export async function aiAsk(question, book) {
  const c = assertCfg();
  const { context, chapters } = retrieveRelevant(book, question, 6, 4000);
  const sys =
    '你是一位严谨的伴读助手。请只根据用户提供的「本书节选」内容回答问题，不要引入节选之外的虚构情节或结局。' +
    '若节选不足以回答，请明确说明「书中节选未提供足够信息」。用简体中文，必要时用 **加粗** 标出关键人物/概念。';
  const user = '本书节选（来自：' + (chapters.join('、') || '全书') + '）：\n' +
    (context || '（无可用节选）') + '\n\n读者的问题：\n' + question;
  const raw = await llmChat({
    baseUrl: c.base, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });
  return raw.trim();
}

// ---------- ④ 阅读笔记 / 脉络（结构化） ----------
export async function aiNotes(book) {
  const c = assertCfg();
  const d = buildDigest(book);
  const sys =
    '你是文学/知识梳理助手。基于提供的书目信息，抽取结构化阅读笔记，仅输出 JSON（不要任何解释或 Markdown 代码块包裹），' +
    '格式严格为：\n' +
    '{ "characters":[{"name":"","role":"","relation":""}], "timeline":[{"point":"","desc":""}], "points":["关键论点或要点"] }\n' +
    '要求：characters 抽取 3-8 个核心人物/实体并说明其角色与彼此关系；timeline 抽取 3-6 个关键节点；' +
    'points 抽取 3-8 条核心论点、主题或方法论。全部基于文本，不要虚构。';
  const user = '书名：' + d.title + (d.author ? '\n作者：' + d.author : '') +
    '\n目录：' + d.titles.join(' / ') + '\n\n正文摘录：\n' + d.text;
  const data = await llmChatJson({
    baseUrl: c.base, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });
  return {
    characters: Array.isArray(data.characters) ? data.characters : [],
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    points: Array.isArray(data.points) ? data.points : [],
  };
}

// ---------- ⑤ 智能标签 ----------
export async function aiTags(book) {
  const c = assertCfg();
  const d = buildDigest(book, 4000);
  const sys =
    '你是图书分类助手。基于提供的书目信息，给出 3-6 个适合作为书架标签的短词（每个 2-4 字，' +
    '涵盖主题/题材/难度/情绪等维度，例如：科幻、悬疑、哲学、入门、硬核、治愈、长篇）。' +
    '仅输出 JSON：{ "tags":["...","..."] }，不要解释或代码块包裹。';
  const user = '书名：' + d.title + (d.author ? '\n作者：' + d.author : '') +
    '\n目录：' + d.titles.join(' / ') + '\n\n正文摘录：\n' + d.text;
  const data = await llmChatJson({
    baseUrl: c.base, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).slice(0, 8)).slice(0, 8) : [];
  return tags;
}

// ---------- ⑥ 段落级双语（升级现有翻译） ----------
// 接收一组段落原文，逐段翻译，返回 [{orig, trans}]；复用 translate.js 的 provider/Key 配置。
export async function aiBilingual(paragraphs, dir) {
  const out = [];
  for (const p of paragraphs) {
    if (!p.trim()) { out.push({ orig: p, trans: '' }); continue; }
    try {
      const r = await translateText(p, {
        provider: loadSettings().translateProvider,
        apiKey: loadSettings().translateApiKey,
        llmBaseUrl: loadSettings().translateLlmBase,
        llmModel: loadSettings().translateLlmModel,
        dir: dir || 'auto',
      });
      out.push({ orig: p, trans: r.text });
    } catch (e) {
      out.push({ orig: p, trans: '⚠ ' + e.message });
    }
  }
  return out;
}

// 把当前页 HTML 拆成段落文本（供双语对照使用）。无 <p> 时按句切分兜底。
export function pageParagraphs(pageHtml) {
  const d = document.createElement('div');
  d.innerHTML = pageHtml || '';
  const ps = Array.from(d.querySelectorAll('p')).map((p) => (p.textContent || '').trim()).filter(Boolean);
  if (ps.length) return ps;
  const txt = (d.textContent || '').replace(/\s+/g, ' ').trim();
  return txt ? txt.split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter(Boolean) : [];
}

// ---------- Markdown 渲染（极简、安全：先转义再处理） ----------
export function renderMarkdown(md) {
  const esc = String(md || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc.split(/\n/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const line of lines) {
    const t = line.replace(/\s+$/, '');
    if (/^###\s+/.test(t)) { closeList(); html += '<h4>' + inline(t.replace(/^###\s+/, '')) + '</h4>'; }
    else if (/^##\s+/.test(t)) { closeList(); html += '<h3>' + inline(t.replace(/^##\s+/, '')) + '</h3>'; }
    else if (/^#\s+/.test(t)) { closeList(); html += '<h2>' + inline(t.replace(/^#\s+/, '')) + '</h2>'; }
    else if (/^[-*]\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>';
    } else if (t === '') { closeList(); }
    else { closeList(); html += '<p>' + inline(t) + '</p>'; }
  }
  closeList();
  return html;
}
function inline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
}
