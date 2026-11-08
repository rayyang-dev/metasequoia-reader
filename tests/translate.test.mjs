// 红杉 — 中英互译模块自测（Node 环境，真实载入 translate.js，stub fetch 验证接线与请求构造）
import { translateText, detectLang } from '../www/js/translate.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } }

console.log('=== 红杉 中英互译自测 ===');

// 1) 语言识别
ok(detectLang('夜色像潮水') === 'zh', 'detectLang 中文 → zh');
ok(detectLang('The night is calm') === 'en', 'detectLang 英文 → en');

// 2) mock 提供方（离线演示，不发网络）
let fetchCalled = false;
const realFetch = global.fetch;
global.fetch = async () => { fetchCalled = true; throw new Error('不应被调用'); };
const m = await translateText('纸页间夹着一片干枯的枫叶', { provider: 'mock', dir: 'auto' });
ok(m.from === 'zh' && m.to === 'en', 'mock: 自动方向 zh→en');
ok(m.text.startsWith('[演示 EN]'), 'mock: 返回演示标记文本');
ok(!fetchCalled, 'mock: 不发起网络请求');
global.fetch = realFetch;

// 3) 未启用
let threw = false;
try { await translateText('hi', { provider: 'none' }); } catch (e) { threw = true; ok(/未启用/.test(e.message), 'none: 抛「未启用」提示'); }
ok(threw, 'none: 确实抛错');

// 4) 需要 Key 但没填
threw = false;
try { await translateText('hi', { provider: 'deepl', dir: 'en2zh' }); } catch (e) { threw = true; ok(/API Key/.test(e.message), 'deepl 无 Key → 提示填 Key'); }
ok(threw, 'deepl 无 Key: 确实抛错');

// 5) DeepL 请求构造
{
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ translations: [{ text: 'A dry maple leaf lies between the pages' }] }) };
  };
  const r = await translateText('纸页间夹着一片干枯的枫叶', { provider: 'deepl', apiKey: 'x', dir: 'zh2en' });
  ok(r.text === 'A dry maple leaf lies between the pages', 'deepl: 解析返回文本');
  ok(captured.url === 'https://api-free.deepl.com/v2/translate', 'deepl: 正确 URL');
  ok(captured.opts.headers.Authorization === 'DeepL-Auth-Key x', 'deepl: Auth 头');
  ok(/target_lang=EN/.test(captured.opts.body.toString()) && /source_lang=ZH/.test(captured.opts.body.toString()), 'deepl: body 含 ZH→EN');
  global.fetch = realFetch;
}

// 6) Google 请求构造
{
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ data: { translations: [{ translatedText: '纸页间夹着一片干枯的枫叶' }] } }) };
  };
  const r = await translateText('A dry maple leaf', { provider: 'google', apiKey: 'k', dir: 'en2zh' });
  ok(r.text === '纸页间夹着一片干枯的枫叶', 'google: 解析返回文本');
  ok(captured.url.includes('translation.googleapis.com') && captured.url.includes('key=k'), 'google: URL 含 key');
  ok(JSON.parse(captured.opts.body).target === 'zh' && JSON.parse(captured.opts.body).source === 'en', 'google: body 含 en→zh');
  global.fetch = realFetch;
}

// 7) AI 大模型请求构造
{
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '纸页间夹着一片干枯的枫叶' } }] }) };
  };
  const r = await translateText('A dry maple leaf', {
    provider: 'llm', apiKey: 'sk', llmBaseUrl: 'https://api.deepseek.com/v1/', llmModel: 'deepseek-chat', dir: 'en2zh',
  });
  ok(r.text === '纸页间夹着一片干枯的枫叶', 'llm: 解析返回文本');
  ok(captured.url === 'https://api.deepseek.com/v1/chat/completions', 'llm: 正确拼接 URL（去尾斜杠）');
  ok(captured.opts.headers.Authorization === 'Bearer sk', 'llm: Bearer 头');
  ok(JSON.parse(captured.opts.body).model === 'deepseek-chat', 'llm: 使用自定义模型名');
  global.fetch = realFetch;
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
