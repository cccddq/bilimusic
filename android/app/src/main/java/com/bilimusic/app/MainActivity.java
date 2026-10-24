package com.bilimusic.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * BiliMusic 安卓版主界面。
 *
 * 布局: 根 FrameLayout
 *   ├─ uiWeb      : 整个界面(复用桌面端 src/renderer)
 *   └─ playerWeb  : 内嵌 B 站播放器, 由渲染进程上报坐标后覆盖在中间列上
 *                   (等价于桌面端的 WebContentsView)
 *
 * 主进程能力(HTTP + cookie + WBI + 扫码登录 + 歌单存储)在 BiliApi / Store 里,
 * 通过 Bridge 暴露给页面; 页面侧用 src/renderer/bili-bridge.js 生成 window.bili.*。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;

    private FrameLayout root;
    private WebView uiWeb;
    private PlayerController player;
    private Store store;
    private BiliApi api;
    private Bridge bridge;

    private ValueCallback<Uri[]> fileCallback;
    private View customView;                 // 播放器全屏时的自定义视图
    private WebChromeClient.CustomViewCallback customViewCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        store = new Store(this);
        store.loadCookies();
        api = new BiliApi(store);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a18"));
        setContentView(root);

        // ---- 界面 WebView ----
        uiWeb = new WebView(this);
        WebSettings s = uiWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 歌单存在 localStorage 里, 必须开
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);            // 从 assets 里加载本地页面
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        uiWeb.setBackgroundColor(Color.parseColor("#0a0a18"));
        uiWeb.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(uiWeb);

        // ---- 内嵌播放器 ----
        player = new PlayerController(this, root);

        // ---- JS 桥 ----
        bridge = new Bridge(this, uiWeb, store, api, player);
        uiWeb.addJavascriptInterface(bridge, "BiliNative");

        uiWeb.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl() == null ? "" : request.getUrl().toString();
                if (url.startsWith("http")) {
                    openExternal(url);
                    return true;
                }
                return false;
            }
        });

        uiWeb.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                android.util.Log.d("BiliMusic", msg.message() + " @" + msg.sourceId() + ":" + msg.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        // 播放器的全屏视频
        player.raw().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                view.setBackgroundColor(Color.BLACK);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                uiWeb.setVisibility(View.GONE);
                setSystemBarsHidden(true);
            }

            @Override
            public void onHideCustomView() {
                exitCustomView();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                android.util.Log.d("BiliMusicPlayer", msg.message());
                return true;
            }
        });

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);   // chrome://inspect 可调试
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(uiWeb, true);

        // 首次进入时把已保存的 cookie 同步给播放器
        player.syncCookies(store.cookies());

        uiWeb.loadUrl("file:///android_asset/www/index.html");

        // 后台预热 WBI 密钥, 首次搜索就不用等
        new Thread(() -> api.refreshWbi()).start();
    }

    // ---------------- 供 PlayerController / Bridge 使用 ----------------

    String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {
        }
    }

    /** 原生 -> 页面事件(对应桌面端 mainWindow.webContents.send) */
    void sendBridgeEvent(final String name, final String json) {
        runOnUiThread(() -> {
            try {
                uiWeb.evaluateJavascript("window.__bridgeEvent(" + JSONObject.quote(name) + "," + JSONObject.quote(json) + ")", null);
            } catch (Exception ignored) {
            }
        });
    }

    /** 退出播放器的全屏视频(返回键与 onHideCustomView 共用) */
    private void exitCustomView() {
        if (customView == null) return;
        try {
            root.removeView(customView);
        } catch (Exception ignored) {
        }
        customView = null;
        uiWeb.setVisibility(View.VISIBLE);
        setSystemBarsHidden(false);
        if (customViewCallback != null) {
            try {
                customViewCallback.onCustomViewHidden();
            } catch (Exception ignored) {
            }
            customViewCallback = null;
        }
    }

    private void setSystemBarsHidden(boolean hidden) {
        try {
            if (hidden) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().getInsetsController().hide(android.view.WindowInsets.Type.systemBars());
                } else {
                    getWindow().getDecorView().setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                }
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().getInsetsController().show(android.view.WindowInsets.Type.systemBars());
                } else {
                    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                }
            }
        } catch (Exception ignored) {
        }
    }

    // ---------------- 生命周期 / 返回键 ----------------

    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitCustomView();
            return;
        }
        // 让页面自己处理: 关浮层 / 退出歌单专注视图; 返回 false 表示"页面不需要处理"
        uiWeb.evaluateJavascript(
                "(function(){try{return (typeof window.__androidBackPressed==='function' && window.__androidBackPressed())?'1':'0';}catch(e){return '0';}})()",
                value -> {
                    if (value != null && value.contains("1")) return;   // 页面已处理
                    moveTaskToBack(true);                                // 否则退到后台, 不打断播放
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        result = new Uri[count];
                        for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (player != null && player.raw() != null) {
            player.raw().loadUrl("about:blank");
            player.raw().destroy();
        }
        if (uiWeb != null) {
            uiWeb.loadUrl("about:blank");
            uiWeb.destroy();
        }
        super.onDestroy();
    }
}
