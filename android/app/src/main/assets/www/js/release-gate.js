/*
 * 首版应用商店审核构建开关（独立文件，零污染、可回退）。
 *
 * 两组开关各自独立、互不干扰：
 *   AI_FEATURES_ENABLED    —— 隐藏 AI 助手 / 在线翻译入口，并清零历史联网设置，
 *                             规避生成式 AI 算法备案、安全评估报告等前置合规要求。
 *   CAMERA_FEATURE_ENABLED —— 隐藏「视线翻页」的全部入口、清零历史 autoMode='gaze'，
 *                             并在 pro.js 的 setMode() 加一道兜底；配合 AndroidManifest.xml
 *                             移除 CAMERA 权限，使 AGC「应用隐私权限说明」不再出现敏感权限
 *                             「相机」，因此无需提交权限说明话术与使用场景截图包（v1.4.6 起）。
 *
 * 恢复方式：把对应开关改回 true，重新打包即可完整恢复所有能力，无需改动任何其他业务脚本；
 *           相机能力还需按 docs/华为AGC提交操作手册.md §4.1 补回 manifest 的两条声明。
 *           css/release-review.css 中的规则全部以 <html> 上的 class 为前缀，开关打开后自动失效。
 *
 * 约束：本文件是普通同步脚本，必须在 index.html 的 <head> 中、所有 module 脚本之前加载，
 *       这样 documentElement 的 class 在 body 解析前就已生效，不会出现界面闪现。
 */
(function () {
  var AI_FEATURES_ENABLED = false;
  var CAMERA_FEATURE_ENABLED = false;

  window.INK_AI_ENABLED = AI_FEATURES_ENABLED;
  window.INK_CAMERA_ENABLED = CAMERA_FEATURE_ENABLED;

  // 1) 打标记：release-review.css 中所有规则都以 .ai-review-hide / .camera-review-hide 为前缀。
  if (!AI_FEATURES_ENABLED) {
    document.documentElement.classList.add('ai-review-hide');
  }
  if (!CAMERA_FEATURE_ENABLED) {
    document.documentElement.classList.add('camera-review-hide');
  }
  if (AI_FEATURES_ENABLED && CAMERA_FEATURE_ENABLED) return;

  // 2) 清除历史设置里残留的开关。
  //    老用户若曾开启「AI 大模型」或「导入后自动生成导读」，仅隐藏 UI 仍会在导入书籍时
  //    由 app.js 的自动导读逻辑触发外部 API 调用，因此必须把这两个字段归零。
  //    同理，若自动翻页模式停在「视线」，送审版入口隐藏后仍可能被恢复逻辑读到，一并归零。
  //    只改这几个字段，其余设置原样保留；隐私模式 / 数据损坏时静默跳过，不影响启动。
  try {
    var KEY = 'inkreader:settings';
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        var dirty = false;
        if (!AI_FEATURES_ENABLED) {
          saved.translateProvider = 'none';
          saved.aiAutoSummary = false;
          dirty = true;
        }
        if (!CAMERA_FEATURE_ENABLED && saved.autoMode === 'gaze') {
          saved.autoMode = 'off';
          dirty = true;
        }
        if (dirty) localStorage.setItem(KEY, JSON.stringify(saved));
      }
    }
  } catch (e) {
    /* localStorage 不可用或 JSON 损坏：忽略，入口隐藏仍然生效 */
  }

  // 3) 法律声明页补一条醒目的送审版说明。
  //    应用内三份与线上两份法律文案已统一按当前版本实际功能编写，不再描述任何未开放的
  //    AI / 联网能力；这里再补一条总纲，便于审核人员快速确认版本范围。
  //    #legal-body 由 app.js 动态重绘（切 tab 会覆盖），所以用 MutationObserver 持续补挂。
  //    这里不改 LEGAL_CONTENT 一个字符，开关改回 true 后整段逻辑自动不执行。
  function installLegalNotice() {
    var host = document.getElementById('legal-body');
    if (!host) return;
    var NOTICE_ID = 'ink-review-legal-notice';
    function prepend() {
      if (document.getElementById(NOTICE_ID)) return;
      var box = document.createElement('div');
      box.id = NOTICE_ID;
      box.className = 'legal-review-notice';
      box.innerHTML = '<b>送审版本说明</b>：本版本是纯本地离线阅读工具，未开放 AI 助手、在线翻译与' +
        '「视线翻页」功能，<b>不申请相机权限</b>，不向任何第三方服务发送书籍内容或个人数据。' +
        '应用内隐私政策、用户协议与权限说明均按本版本实际功能编写，与线上隐私政策页口径一致。';
      host.insertBefore(box, host.firstChild);
    }
    prepend();
    if (window.MutationObserver) {
      new MutationObserver(prepend).observe(host, { childList: true });
    }
  }
  document.addEventListener('DOMContentLoaded', installLegalNotice);
})();
