package com.rayyang.metasequoia;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient.FileChooserParams;
import android.net.Uri;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private static final int FILECHOOSER_REQ = 1001;
    private static final int CAMERA_PERMISSION_REQ = 1002;
    private ValueCallback<Uri[]> uploadCallback;
    private PermissionRequest pendingCameraRequest;
    // 由 web 层在进入 / 退出阅读器时同步，用于决定音量键是否作为翻页键消费。
    private volatile boolean readerActive = false;
    // Plus 层：本机 TTS（Android WebView 常缺 Web Speech API）与文件导出（WebView 不处理 blob: 下载）。
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private String pendingSpeak;
    private float pendingRate = 1f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 在 Capacitor 完成 WebView 初始化后，替换其 WebChromeClient。
        // FileChooser 之外，新增 getUserMedia 的相机权限桥接；其余回调仍继承 Capacitor 原生实现。
        installFileChooserClient();
    }

    private void installFileChooserClient() {
        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv == null) return;
        wv.setWebChromeClient(new ReaderChromeClient(bridge, this));
        // 暴露原生接口给 JS：屏幕常亮 + 阅读器激活状态（音量键翻页的判断依据）
        wv.addJavascriptInterface(new ScreenOnBridge(this), "AndroidScreenOn");
        // Plus 层：把导出/朗读交给系统能力，浏览器与 PWA 无此对象，JS 侧自动降级
        wv.addJavascriptInterface(new InkToolsBridge(this), "InkTools");
    }

    // 注：BridgeActivity 的 onDestroy() 不可覆盖。TTS 用 applicationContext 持有，
    // 随进程生命周期释放，不会因 Activity 重建而泄漏；每次停止只做 tts.stop()。

    // ---------- Plus：本机朗读 ----------
    void speakOut(String text, float rate) {
        if (text == null || text.isEmpty()) return;
        if (tts == null) {
            pendingSpeak = text;
            pendingRate = rate;
            try {
                tts = new TextToSpeech(getApplicationContext(), status -> {
                    if (status != TextToSpeech.SUCCESS) {
                        runOnUiThread(() -> Toast.makeText(this, "本机语音引擎不可用", Toast.LENGTH_LONG).show());
                        return;
                    }
                    try {
                        tts.setLanguage(Locale.CHINESE);
                        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                            @Override public void onStart(String id) {}
                            @Override public void onDone(String id) { notifyTtsEnd(); }
                            @Override public void onError(String id) { notifyTtsEnd(); }
                        });
                        ttsReady = true;
                        if (pendingSpeak != null) {
                            doSpeak(pendingSpeak, pendingRate);
                            pendingSpeak = null;
                        }
                    } catch (Throwable ignore) {}
                });
            } catch (Throwable t) {
                runOnUiThread(() -> Toast.makeText(this, "无法初始化语音引擎", Toast.LENGTH_LONG).show());
            }
        } else if (ttsReady) {
            doSpeak(text, rate);
        } else {
            pendingSpeak = text;
            pendingRate = rate;
        }
    }

    private void doSpeak(String text, float rate) {
        try {
            tts.setSpeechRate(Math.max(0.5f, Math.min(2f, rate)));
            Bundle params = new Bundle();
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, "inktts");
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "inktts");
        } catch (Throwable ignore) {}
    }

    private void notifyTtsEnd() {
        runOnUiThread(() -> {
            Bridge b = getBridge();
            WebView wv = b == null ? null : b.getWebView();
            if (wv != null) wv.evaluateJavascript("window.__inkTtsOnEnd && window.__inkTtsOnEnd()", null);
        });
    }

    void stopSpeak() {
        try { if (tts != null) tts.stop(); } catch (Throwable ignore) {}
        pendingSpeak = null;
    }

    // ---------- Plus：把导出文件写入系统「下载」目录（无需存储权限） ----------
    void saveToDownloads(String name, String base64) {
        runOnUiThread(() -> {
            String safe = (name == null ? "export.txt" : name).replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mimeOf(safe));
                    cv.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (target == null) throw new IllegalStateException("MediaStore 不可用");
                    OutputStream os = getContentResolver().openOutputStream(target);
                    if (os == null) throw new IllegalStateException("无法打开输出流");
                    os.write(bytes);
                    os.close();
                    cv.clear();
                    cv.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(target, cv, null, null);
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir != null && !dir.exists()) dir.mkdirs();
                    File f = new File(dir, safe);
                    FileOutputStream fos = new FileOutputStream(f);
                    fos.write(bytes);
                    fos.close();
                }
                Toast.makeText(this, "已保存到下载目录：" + safe, Toast.LENGTH_LONG).show();
            } catch (Throwable t) {
                Toast.makeText(this, "保存失败：" + t.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".json")) return "application/json";
        return "text/plain";
    }

    // JS 可调用的原生桥。Web / PWA 环境不存在该对象，plus.js 一律做特性检测后降级。
    private static class InkToolsBridge {
        private final MainActivity host;
        InkToolsBridge(MainActivity h) { host = h; }

        @JavascriptInterface
        public void save(String name, String base64) { host.saveToDownloads(name, base64); }

        @JavascriptInterface
        public void speak(String text, float rate) { host.runOnUiThread(() -> host.speakOut(text, rate)); }

        @JavascriptInterface
        public void stopSpeak() { host.runOnUiThread(() -> host.stopSpeak()); }
    }

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private static class ReaderChromeClient extends BridgeWebChromeClient {
        private final MainActivity host;
        ReaderChromeClient(Bridge bridge, MainActivity host) {
            super(bridge);
            this.host = host;
        }
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
            return host.showFileChooser(filePathCallback, params);
        }
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            // WebView 的 getUserMedia 不会自动授权，必须显式 grant。
            // 只接管前置摄像头视频流；音频 / 其它资源交回 Capacitor 原生实现，避免破坏桥接。
            boolean needsCamera = false;
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) { needsCamera = true; break; }
            }
            if (!needsCamera) { super.onPermissionRequest(request); return; }
            if (host.hasCameraPermission()) {
                request.grant(new String[]{ PermissionRequest.RESOURCE_VIDEO_CAPTURE });
                return;
            }
            host.pendingCameraRequest = request;
            host.requestPermissions(new String[]{ Manifest.permission.CAMERA }, CAMERA_PERMISSION_REQ);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQ || pendingCameraRequest == null) return;
        PermissionRequest req = pendingCameraRequest;
        pendingCameraRequest = null;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) req.grant(new String[]{ PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        else req.deny(); // 拒绝授权时 JS 侧会收到错误并自动降级为定时自动翻页
    }

    // 音量键翻页：墨水屏设备 / 单手握持的常见需求。仅在阅读器内消费，
    // 书架 / 设置页仍保留系统调音行为。
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (readerActive && event.getAction() == KeyEvent.ACTION_DOWN) {
            int kc = event.getKeyCode();
            if (kc == KeyEvent.KEYCODE_VOLUME_UP || kc == KeyEvent.KEYCODE_VOLUME_DOWN) {
                final String dir = (kc == KeyEvent.KEYCODE_VOLUME_UP) ? "prev" : "next";
                Bridge bridge = getBridge();
                WebView wv = (bridge == null) ? null : bridge.getWebView();
                if (wv != null) {
                    wv.evaluateJavascript(
                        "window.__inkVolumeTurn && window.__inkVolumeTurn('" + dir + "')", null);
                }
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    boolean showFileChooser(ValueCallback<Uri[]> cb, FileChooserParams params) {
        uploadCallback = cb;
        // 优先用 SAF 的 ACTION_OPEN_DOCUMENT（openable），兼容性最好；失败再退回 ACTION_GET_CONTENT。
        Intent intent = buildIntent(params, Intent.ACTION_OPEN_DOCUMENT);
        try {
            startActivityForResult(intent, FILECHOOSER_REQ);
            return true;
        } catch (ActivityNotFoundException e1) {
            Intent fallback = buildIntent(params, Intent.ACTION_GET_CONTENT);
            try {
                startActivityForResult(fallback, FILECHOOSER_REQ);
                return true;
            } catch (ActivityNotFoundException e2) {
                Toast.makeText(this, "无法打开系统文件选择器：请确认设备已安装文件管理器", Toast.LENGTH_LONG).show();
                if (uploadCallback != null) {
                    uploadCallback.onReceiveValue(null);
                    uploadCallback = null;
                }
                return false;
            }
        }
    }

    private Intent buildIntent(FileChooserParams params, String action) {
        Intent intent = new Intent(action);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimes = filterMimes(params);
        if (mimes != null) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
        }
        return intent;
    }

    // 仅保留形如 "text/plain" 的真实 MIME（过滤 ".txt" 这类扩展名与 "*/*"），避免 Intent 匹配不到任何应用。
    private String[] filterMimes(FileChooserParams params) {
        try {
            String[] raw = params.getAcceptTypes();
            if (raw == null || raw.length == 0) return null;
            ArrayList<String> list = new ArrayList<>();
            for (String t : raw) {
                if (t != null && t.contains("/") && !"*/*".equals(t)) list.add(t);
            }
            return list.isEmpty() ? null : list.toArray(new String[0]);
        } catch (Throwable ignore) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // 先交给 Capacitor 处理它自己的结果（插件 / 权限等），再处理文件选择。
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILECHOOSER_REQ) {
            if (uploadCallback == null) return;
            Uri[] results = FileChooserParams.parseResult(resultCode, data);
            uploadCallback.onReceiveValue(results);
            uploadCallback = null;
        }
    }

    // JS 可调用的原生桥：屏幕常亮 + 阅读器激活状态。
    // Web / PWA 环境不存在该对象，JS 侧一律做特性检测后降级。
    private static class ScreenOnBridge {
        private final MainActivity host;
        ScreenOnBridge(MainActivity h) { host = h; }
        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            host.runOnUiThread(() -> {
                if (on) host.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else host.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
        @JavascriptInterface
        public void setReaderActive(boolean on) {
            host.readerActive = on;
        }
    }
}
