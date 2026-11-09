// 统一的 OpenAI 兼容 Chat Completions 客户端
// 摘要 / 问答 / 解释 / 笔记 / 标签 / 翻译 全部共用这一个联网出口。
// 关键：默认不主动联网；只有在「AI 引擎」里显式选择 AI 大模型并填入 Key 后才会发起请求。

/**
 * 单次对话补全。
 * @param {Object} opts
 * @param {string} opts.baseUrl  OpenAI 兼容 base（如 https://api.openai.com/v1）
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages [{role, content}]
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>} 模型输出的纯文本
 */
export async function llmChat(opts) {
  const {
    baseUrl = 'https://api.openai.com/v1',
    apiKey = '',
    model = 'gpt-4o-mini',
    messages,
    temperature = 0.3,
    maxTokens,
  } = opts || {};
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new Error('缺少 API Key：请先在「阅读设置 → AI 引擎」填写');
  if (!Array.isArray(messages) || !messages.length) throw new Error('空的对话内容');

  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;

  // 超时控制：用户常接自建/本地模型（如 Ollama），卡住时若无超时 UI 会永远卡在「AI 思考中…」
  const timeoutMs = opts && opts.timeoutMs != null ? opts.timeoutMs : 90000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      throw new Error('AI 接口请求超时（' + Math.round(timeoutMs / 1000) + 's），请检查网络或模型服务是否可用');
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    let msg = 'AI 接口返回 ' + res.status;
    try {
      const err = await res.json();
      if (err && err.error && err.error.message) msg = err.error.message;
    } catch (e) { /* 忽略解析失败，使用状态码提示 */ }
    throw new Error(msg);
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('AI 接口返回格式异常（未含 content）');
  return content;
}

/**
 * 要求模型输出 JSON，并做容错解析（去掉 ```json 代码块、截取首个 { 或 [ 匹配闭合）。
 * @returns {Promise<any>}
 */
export async function llmChatJson(opts) {
  const raw = await llmChat(Object.assign({ temperature: 0.2 }, opts));
  return parseJson(raw);
}

function parseJson(s) {
  if (typeof s !== 'string') return s;
  let t = s.trim();
  // 去掉 ```json ... ``` 或 ``` ... ``` 包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 截取首个 { 或 [ 到匹配闭合处
  const iBrace = t.indexOf('{');
  const iBrack = t.indexOf('[');
  let start = -1;
  let open = null;
  if (iBrace === -1 && iBrack === -1) {
    throw new Error('AI 未返回可解析的 JSON');
  } else if (iBrace === -1) {
    start = iBrack; open = '[';
  } else if (iBrack === -1) {
    start = iBrace; open = '{';
  } else {
    start = Math.min(iBrace, iBrack);
    open = t[start] === '{' ? '{' : '[';
  }
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('AI 返回的 JSON 括号不匹配');
  return JSON.parse(t.slice(start, end + 1));
}
