/*
 * 首次启动隐私政策弹窗（合规要求：华为《应用审核指南》7.5、《个人信息保护法》）。
 *
 * 设计约束：
 *  1) 普通同步脚本，必须在 index.html 的 <head> 中、所有 module 脚本之前加载。
 *     不依赖 app.js 是否加载成功，即使业务模块报错，弹窗依然会显示。
 *  2) 独立文件、独立样式，不修改任何业务模块；全文直接复用 app.js 暴露的
 *     window.__INK_LEGAL__.content（LEGAL_CONTENT），不新增第六份法律文案。
 *  3) 同意状态按「隐私政策版本」存 localStorage；政策正文变更时把 POLICY_VERSION +1，
 *     老用户升级后会重新征求同意。纯本地存储，不产生任何网络请求。
 *  4) 「同意」与「不同意」必须用户主动点击，无默认勾选、无倒计时自动同意；
 *     不同意经二次确认后退出应用（无 Capacitor App 插件时降级为保留弹窗）。
 *
 * 自动化回归：Puppeteer 下 navigator.webdriver === true，或 URL 带 ?skipPrivacy=1，
 * 或显式 window.__INK_SKIP_PRIVACY__ === true 时，遮罩不插入，避免挡住既有 UI 测试。
 * 真机 / 审核环境不具备这些标志，弹窗照常显示。
 */
(function () {
  // 隐私政策版本：政策正文（LEGAL_CONTENT / docs/legal.html / site/legal.html）变更时 +1，
  // 用于让老用户重新确认。仅新增弹窗、正文未变时保持 '1'。
  var POLICY_VERSION = '1';
  var STORAGE_KEY = 'inkreader:privacy-consent';
  var CONTACT = '732897783@qq.com';

  function shouldSkip() {
    try {
      if (window.__INK_SKIP_PRIVACY__ === true) return true;
      if (new URLSearchParams(location.search).get('skipPrivacy') === '1') return true;
      if (navigator.webdriver === true) return true;
    } catch (e) {}
    return false;
  }

  function hasAgreed() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      return !!(saved && saved.version === POLICY_VERSION && saved.agreed === true);
    } catch (e) {
      return false; // 隐私模式 / 数据损坏：一律视为未同意，重新弹窗
    }
  }

  function saveAgreed() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: POLICY_VERSION,
        agreed: true,
        agreedAt: new Date().toISOString(),
      }));
    } catch (e) {}
  }

  // 全文层内容来自 app.js 的 LEGAL_CONTENT；module 脚本偶发晚于点击，做有限重试。
  function fillDoc(which, body, titleEl) {
    var legal = window.__INK_LEGAL__;
    var doc = legal && legal.content && legal.content[which];
    if (!doc) return false;
    titleEl.textContent = doc.title;
    body.innerHTML = doc.html;
    return true;
  }

  function exitApp() {
    try {
      var plugins = window.Capacitor && window.Capacitor.Plugins;
      var app = plugins && plugins.App;
      if (app && typeof app.exitApp === 'function') {
        app.exitApp();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function build() {
    if (document.getElementById('privacy-mask')) return;

    var mask = document.createElement('div');
    mask.id = 'privacy-mask';
    mask.innerHTML =
      '<div id="privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-title">' +
        '<div id="pc-main" class="pc-pane">' +
          '<h2 class="pc-head" id="pc-title">隐私政策与用户协议</h2>' +
          '<div class="pc-scroll">' +
            '<p class="pc-lead">欢迎使用红杉阅读。在使用前，请你阅读并同意《隐私政策》与《用户协议》。</p>' +
            '<p>本应用是一款<b>纯本地离线</b>电子书阅读器：</p>' +
            '<ul>' +
              '<li>不要求注册账号，不收集个人信息；书籍、阅读进度、书签与设置仅保存在你的设备本地；</li>' +
              '<li>本版本<b>未开放</b> AI 助手、在线翻译与「视线翻页」，<b>不申请相机权限</b>；</li>' +
              '<li>不向任何第三方服务发送书籍内容、选中文本或个人数据；</li>' +
              '<li>「网络」权限仅由应用框架用于加载应用内本地资源，无后端服务器、无版本检查、无遥测上报。</li>' +
            '</ul>' +
            '<p>完整内容请查看 ' +
              '<span class="pc-link" data-pc-doc="privacy" role="link" tabindex="0">《隐私政策》</span>、' +
              '<span class="pc-link" data-pc-doc="terms" role="link" tabindex="0">《用户协议》</span>与' +
              '<span class="pc-link" data-pc-doc="permissions" role="link" tabindex="0">《权限说明》</span>。' +
              '你可以随时在「设置 → 关于与法律」再次查看，也可通过卸载应用或清除应用数据删除全部本地数据。</p>' +
            '<p class="pc-contact">联系邮箱：' + CONTACT + '</p>' +
          '</div>' +
          '<div class="pc-actions">' +
            '<button type="button" id="pc-disagree" class="pc-btn pc-btn-ghost">不同意</button>' +
            '<button type="button" id="pc-agree" class="pc-btn pc-btn-primary">同意并继续</button>' +
          '</div>' +
        '</div>' +
        '<div id="pc-doc" class="pc-pane pc-hidden">' +
          '<div class="pc-doc-head">' +
            '<button type="button" id="pc-doc-back" class="pc-back">‹ 返回</button>' +
            '<span id="pc-doc-title">隐私政策</span>' +
          '</div>' +
          '<div id="pc-doc-body" class="pc-doc-body"></div>' +
        '</div>' +
        '<div id="pc-exit" class="pc-pane pc-hidden">' +
          '<h2 class="pc-head">无法继续使用</h2>' +
          '<div class="pc-scroll">' +
            '<p>根据相关法律法规，需同意《隐私政策》后才能使用本应用。你可以退出应用，或返回重新阅读并同意。</p>' +
          '</div>' +
          '<div class="pc-actions">' +
            '<button type="button" id="pc-exit-back" class="pc-btn pc-btn-ghost">返回</button>' +
            '<button type="button" id="pc-exit-confirm" class="pc-btn pc-btn-primary">退出应用</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);

    var main = document.getElementById('pc-main');
    var docPane = document.getElementById('pc-doc');
    var exitPane = document.getElementById('pc-exit');
    var docBody = document.getElementById('pc-doc-body');
    var docTitle = document.getElementById('pc-doc-title');
    var panes = [main, docPane, exitPane];

    function show(pane) {
      panes.forEach(function (p) { p.classList.toggle('pc-hidden', p !== pane); });
    }

    function closeDialog() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      window.__INK_PRIVACY_PENDING__ = false;
      try {
        document.dispatchEvent(new CustomEvent('ink:privacy-agreed', { detail: { version: POLICY_VERSION } }));
      } catch (e) {}
    }

    // 全文入口：点击 / 键盘回车都可用；内容加载有 10 次 × 200ms 重试兜底。
    function openDoc(which) {
      show(docPane);
      docBody.innerHTML = '<div class="pc-loading">正在加载…</div>';
      var tries = 0;
      (function attempt() {
        if (fillDoc(which, docBody, docTitle)) return;
        if (++tries < 10) { setTimeout(attempt, 200); return; }
        docTitle.textContent = '隐私政策';
        docBody.innerHTML = '<p>内容暂时无法加载，请在「设置 → 关于与法律」中查看，或稍后重启应用。</p>';
      })();
    }

    Array.prototype.forEach.call(mask.querySelectorAll('[data-pc-doc]'), function (el) {
      el.addEventListener('click', function () { openDoc(el.getAttribute('data-pc-doc')); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDoc(el.getAttribute('data-pc-doc')); }
      });
    });

    document.getElementById('pc-doc-back').addEventListener('click', function () { show(main); });
    document.getElementById('pc-agree').addEventListener('click', function () {
      saveAgreed();
      closeDialog();
    });
    document.getElementById('pc-disagree').addEventListener('click', function () { show(exitPane); });
    document.getElementById('pc-exit-back').addEventListener('click', function () { show(main); });
    document.getElementById('pc-exit-confirm').addEventListener('click', function () {
      if (exitApp()) return;
      // H5 / 无原生插件环境：无法退出，保留弹窗并明确告知，绝不自动视为同意
      var scroll = exitPane.querySelector('.pc-scroll');
      if (scroll) scroll.innerHTML = '<p>当前环境无法直接退出应用。若不同意《隐私政策》，请通过系统返回键或最近任务关闭本应用。</p>';
      show(exitPane);
    });

    // 遮罩本身不可点击关闭，也不允许 ESC 绕过同意
    mask.addEventListener('click', function (e) { if (e.target === mask) e.preventDefault(); });
  }

  function start() {
    window.__INK_PRIVACY_PENDING__ = false;
    if (shouldSkip() || hasAgreed()) return;
    window.__INK_PRIVACY_PENDING__ = true;
    build();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
