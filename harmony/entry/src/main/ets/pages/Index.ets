import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { BridgeHolder } from '../capacitor/bridgeInstance';
import { CapacitorBridge } from '../capacitor/CapacitorBridge';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: CapacitorBridge | null = null;
  @State serverUrl: string = 'http://localhost/';

  aboutToAppear(): void {
    const ctx: common.UIAbilityContext = BridgeHolder.context!;
    this.bridge = new CapacitorBridge(ctx, this.controller);
    BridgeHolder.bridge = this.bridge;
    this.bridge.init();
    this.serverUrl = this.bridge.getServerUrl();
  }

  onBackPress(): boolean {
    // Capacitor contract first: if JS registered an `App.backButton`
    // listener, let the web layer decide (usually App.exitApp()).
    // Otherwise drive the in-app browser history (React) instead of the
    // outer WebView, matching the demo app's address-bar navigation.
    if (this.bridge?.onBackPressed()) {
      return true;
    }
    this.controller.runJavaScript('window.__browserBack ? window.__browserBack() : false');
    return true;
  }

  build() {
    Column() {
      Web({ src: this.serverUrl, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .mixedMode(MixedMode.All)
        .databaseAccess(true)
        .geolocationAccess(true)
        .cacheMode(CacheMode.Default)
        .javaScriptProxy({
          object: this.bridge!.getProxyObject(),
          name: 'harmonyBridge',
          methodList: ['postMessage'],
          controller: this.controller,
        })
        .onInterceptRequest((event: OnInterceptRequestEvent) => {
          if (!this.bridge) {
            return null;
          }
          return this.bridge.handleInterceptRequest(event.request);
        })
        .onPageEnd(() => {
          this.bridge?.onPageReady();
        })
        // 文件选择（导入书籍）：ArkWeb 默认弹窗在部分环境不可用，这里自定义拉起系统文档选择器
        .onShowFileSelector((event) => {
          try {
            const dp = new picker.DocumentViewPicker();
            dp.select(new picker.DocumentSelectOptions()).then((uris: Array<string>) => {
              if (event && event.result) {
                event.result.handleFileList(uris);
              }
            }).catch((err: BusinessError) => {
              console.error(`[sequoia] 文件选择失败 code=${err.code} msg=${err.message}`);
              if (event && event.result) { event.result.handleFileList([]); }
            });
            return true;
          } catch (e) {
            return false;
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
