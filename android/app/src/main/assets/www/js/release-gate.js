/*
 * 首版应用商店审核构建开关（独立文件，零污染、可回退）。
 *
 * 目的：审核期间隐藏 AI 助手 / 在线翻译的全部入口，并阻断历史设置导致的后台外发，
 *       使送审包在功能上等同于「纯本地离线阅读工具」，规避生成式 AI 算法备案、
 *       安全评估报告、个人信息出境等前置合规要求。
 *
 * 恢复方式：把下方 AI_FEATURES_ENABLED 改为 true，重新打包即可完整恢复所有能力，
 *           无需改动任何其他文件。css/release-review.css 会随 <html> 上的 class 自动失效。
 *
 * 约束：本文件是普通同步脚本，必须在 index.html 的 <head> 中、所有 module 脚本之前加载，
 *       这样 documentElement 的 class 在 body 解析前就已生效，不会出现界面闪现。
 */
(function () {
  var AI_FEATURES_ENABLED = false;

  window.INK_AI_ENABLED = AI_FEATURES_ENABLED;
  if (AI_FEATURES_ENABLED) return;

  // 1) 打标记：release-review.css 中所有规则都以 .ai-review-hide 为前缀。
  document.documentElement.classList.add('ai-review-hide');

  // 2) 清除历史设置里残留的自动联网开关。
  //    老用户若曾开启「AI 大模型」或「导入后自动生成导读」，仅隐藏 UI 仍会在导入书籍时
  //    由 app.js 的自动导读逻辑触发外部 API 调用，因此必须把这两个字段归零。
  //    只改这两个字段，其余设置原样保留；隐私模式 / 数据损坏时静默跳过，不影响启动。
  try {
    var KEY = 'inkreader:settings';
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        saved.translateProvider = 'none';
        saved.aiAutoSummary = false;
        localStorage.setItem(KEY, JSON.stringify(saved));
      }
    }
  } catch (e) {
    /* localStorage 不可用或 JSON 损坏：忽略，入口隐藏仍然生效 */
  }

  // 3) 法律声明页补一条送审版说明。
  //    app.js 里的隐私政策 / 用户协议 / 权限说明仍有「AI 与联网功能」「AI 内容免责」条款，
  //    入口隐藏后若不加说明，会构成审核常见的「应用描述与实际功能不符」。
  //    #legal-body 由 app.js 动态重绘（切 tab 会覆盖），所以用 MutationObserver 持续补挂。
  //    这里不改 app.js 一个字符，开关改回 true 后整段逻辑自动不执行。
  function installLegalNotice() {
    var host = document.getElementById('legal-body');
    if (!host) return;
    var NOTICE_ID = 'ink-review-legal-notice';
    function prepend() {
      if (document.getElementById(NOTICE_ID)) return;
      var box = document.createElement('div');
      box.id = NOTICE_ID;
      box.className = 'legal-review-notice';
      box.innerHTML = '<b>送审版本说明</b>：本版本是纯本地离线阅读工具，未开放 AI 助手与在线翻译功能，' +
        '不向任何第三方服务发送书籍内容或个人数据。下方条款中涉及 AI / 翻译的描述，' +
        '仅适用于后续开放该能力的版本。';
      host.insertBefore(box, host.firstChild);
    }
    prepend();
    if (window.MutationObserver) {
      new MutationObserver(prepend).observe(host, { childList: true });
    }
  }
  document.addEventListener('DOMContentLoaded', installLegalNotice);
})();
