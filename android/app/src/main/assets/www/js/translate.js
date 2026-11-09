// 中英互译（可插拔后端，API Key 仅存本机 localStorage，离线阅读不受影响）
// 提供：mock（离线演示）/ DeepL / Google Translate / 兼容 OpenAI 的 AI 大模型
// 设计原则：默认不主动联网；只有用户显式选择某提供方并填入 Key 后才会发起网络请求。
// 注：AI 大模型（llm）这条路走 js/llm.js 的统一客户端，与摘要/问答/笔记共用同一套 Key/模型配置。

import { llmChat } from './llm.js';

export const TRANSLATE_PROVIDERS = [
  { val: 'none', label: '关闭' },
  { val: 'mock', label: '演示' },
  { val: 'deepl', label: 'DeepL' },
  { val: 'google', label: 'Google' },
  { val: 'llm', label: 'AI 大模型' },
];

function hasCJK(s) {
  return /[一-鿿㐀-䶿]/.test(s); // 基本汉字 + 扩展A
}
export function detectLang(text) {
  return hasCJK(text) ? 'zh' : 'en';
}

function langPair(dir, text) {
  let from, to;
  if (dir === 'zh2en') { from = 'zh'; to = 'en'; }
  else if (dir === 'en2zh') { from = 'en'; to = 'zh'; }
  else { from = detectLang(text); to = from === 'zh' ? 'en' : 'zh'; }
  return { from, to };
}

export async function translateText(text, opts = {}) {
  const provider = opts.provider || 'none';
  const dir = opts.dir || 'auto';
  const { from, to } = langPair(dir, text);
  if (provider === 'none') throw new Error('翻译未启用：请在「阅读设置 → 翻译」中选择提供方');

  // 离线演示：仅验证交互链路，不调用真实翻译
  if (provider === 'mock') {
    const tag = from === 'zh' ? '[演示 EN] ' : '[演示 中文] ';
    return { text: tag + text, from, to, provider: 'mock' };
  }

  const key = (opts.apiKey || '').trim();
  if (!key) {
    throw new Error('请先在「阅读设置 → 翻译」中填写对应提供方的 API Key');
  }

  try {
    if (provider === 'deepl') return await deeplTranslate(text, from, to, key);
    if (provider === 'google') return await googleTranslate(text, from, to, key);
    if (provider === 'llm') return await llmTranslate(text, from, to, key, opts.llmBaseUrl, opts.llmModel);
  } catch (e) {
    if (e && e.message) throw e;
    throw new Error('翻译请求失败：' + (e && e.message ? e.message : e));
  }
  throw new Error('未知翻译提供方：' + provider);
}

async function deeplTranslate(text, from, to, key) {
  const url = 'https://api-free.deepl.com/v2/translate';
  const body = new URLSearchParams();
  body.set('text', text);
  body.set('target_lang', to === 'zh' ? 'ZH' : 'EN');
  body.set('source_lang', from === 'zh' ? 'ZH' : 'EN');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error('DeepL 返回 ' + res.status);
  const data = await res.json();
  const t = data && data.translations && data.translations[0] && data.translations[0].text;
  if (!t) throw new Error('DeepL 返回格式异常');
  return { text: t, from, to, provider: 'deepl' };
}

async function googleTranslate(text, from, to, key) {
  const url = 'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: from, target: to, format: 'text' }),
  });
  if (!res.ok) throw new Error('Google 返回 ' + res.status);
  const data = await res.json();
  const t = data && data.data && data.data.translations && data.data.translations[0] && data.data.translations[0].translatedText;
  if (!t) throw new Error('Google 返回格式异常');
  return { text: t, from, to, provider: 'google' };
}

async function llmTranslate(text, from, to, key, baseUrl, model) {
  const fromName = from === 'zh' ? 'Chinese' : 'English';
  const toName = to === 'zh' ? 'Chinese' : 'English';
  const sys =
    'You are a translation engine. Translate the user text from ' + fromName + ' to ' + toName +
    '. Output ONLY the translated text, with no explanations, no quotes, no markdown.';
  const content = await llmChat({
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    apiKey: key,
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ],
    temperature: 0.2,
  });
  return { text: content.trim(), from, to, provider: 'llm' };
}
