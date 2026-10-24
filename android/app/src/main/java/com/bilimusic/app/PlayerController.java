package com.bilimusic.app;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.Map;

/**
 * 内嵌 B 站播放器。
 *
 * 桌面端用的是 Electron 的 WebContentsView 叠在中间列上; 安卓这边等价做法是
 * 在根布局里再放一个 WebView, 由渲染进程上报坐标后设置它的大小与位置。
 */
final class PlayerController {

    /** 用桌面 UA, B 站才会给桌面版播放器页(注入的按钮选择器也才能对上) */
    private static final String DESKTOP_UA = BiliApi.UA;

    private final MainActivity activity;
    private final FrameLayout root;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final float density;

    private String currentBvid = "";
    private String currentUrl = "";
    private boolean visible = false;
    private float volume = 0.8f;
    private boolean volumeUserSet = false;

    PlayerController(MainActivity activity, FrameLayout root) {
        this.activity = activity;
        this.root = root;
        this.density = activity.getResources().getDisplayMetrics().density;
        this.web = new WebView(activity);
        setup();
    }

    View view() {
        return web;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setup() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // 允许自动播放(否则点了歌不出声)
        s.setUserAgentString(DESKTOP_UA);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        web.setBackgroundColor(Color.BLACK);
        web.setVisibility(View.GONE);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(0, 0);
        web.setLayoutParams(lp);
        root.addView(web);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl() == null ? "" : request.getUrl().toString();
                if (url.startsWith("http")) {
                    activity.openExternal(url);      // 页面内的外链走系统浏览器
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 与桌面端一致: 用户手动调过音量才在加载完成后重新应用一次
                if (volumeUserSet) main.postDelayed(PlayerController.this::applyVolume, 1500);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && !request.isForMainFrame()) return;
                String desc = error == null ? "加载失败" : String.valueOf(error.getDescription());
                activity.sendBridgeEvent("player:failed",
                        "{\"code\":" + (error == null ? -1 : error.getErrorCode())
                                + ",\"message\":" + JSONObject.quote(desc)
                                + ",\"url\":" + JSONObject.quote(currentUrl) + "}");
            }
        });
    }

    /** 组装视频地址; 不产生无意义的 ?t=0 / ?p=1 */
    static String buildVideoUrl(String bvid, double t, int p) {
        int sec = (int) Math.floor(t);
        StringBuilder q = new StringBuilder();
        if (p > 1) q.append("p=").append(p);
        if (sec > 0) {
            if (q.length() > 0) q.append('&');
            q.append("t=").append(sec);
        }
        String base = "https://www.bilibili.com/video/" + android.net.Uri.encode(bvid == null ? "" : bvid);
        return q.length() > 0 ? base + "?" + q : base;
    }

    void load(final String bvid, final double t, final int p) {
        main.post(() -> {
            currentBvid = bvid == null ? "" : bvid;
            currentUrl = buildVideoUrl(currentBvid, t, p);
            visible = true;
            web.setVisibility(View.VISIBLE);
            web.loadUrl(currentUrl);
        });
    }

    void reload(final String bvid, final double t, final int p) {
        if (bvid != null && !bvid.isEmpty()) currentBvid = bvid;
        load(currentBvid, t, p);
    }

    void setBounds(final double x, final double y, final double w, final double h) {
        main.post(() -> {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
            lp.leftMargin = (int) Math.max(0, Math.round(x * density));
            lp.topMargin = (int) Math.max(0, Math.round(y * density));
            lp.width = (int) Math.max(0, Math.round(w * density));
            lp.height = (int) Math.max(0, Math.round(h * density));
            web.setLayoutParams(lp);
            boolean show = lp.width > 0 && lp.height > 0;
            web.setVisibility(show ? View.VISIBLE : View.GONE);
            visible = show;
        });
    }

    void hide() {
        main.post(() -> {
            visible = false;
            currentBvid = "";
            currentUrl = "";
            evalJs("(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()");
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
            lp.width = 0;
            lp.height = 0;
            web.setLayoutParams(lp);
            web.setVisibility(View.GONE);
        });
    }

    void pause() {
        evalJs("(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()");
    }

    void resume() {
        evalJs("(function(){var v=document.querySelector('video');if(v&&v.paused)v.play();})()");
    }

    void seek(final double t) {
        evalJs("(function(){var v=document.querySelector('video');if(v)v.currentTime=" + ((int) Math.floor(t)) + ";})()");
    }

    void applyVolume() {
        double v = Math.max(0, Math.min(1, volume));
        evalJs("(function(){var v=document.querySelector('video');if(v)v.volume=" + v + ";})()");
    }

    void setVolume(double v) {
        volume = (float) Math.max(0, Math.min(1, v));
        volumeUserSet = true;
        applyVolume();
    }

    float volume() {
        return volume;
    }

    /** 让 B 站播放器进入网页全屏(与桌面端同一套注入) */
    void pageFullscreen() {
        main.postDelayed(() -> evalJs("var b=document.querySelector('.bpx-player-ctrl-full');"
                + "if(b){var p=b.previousElementSibling;if(p)p.click();}"), 2000);
    }

    /**
     * 读取播放状态。桌面端这里加了超时保护, 安卓侧用回调 + 超时兜底。
     */
    void readStatus(final Bridge.Callback cb) {
        evalJsWithResult("(function(){var v=document.querySelector('video');"
                + "return v?JSON.stringify({paused:v.paused,currentTime:v.currentTime,duration:v.duration}):'null';})()", cb);
    }

    void readVolume(final Bridge.Callback cb) {
        evalJsWithResult("(function(){var v=document.querySelector('video');return v?String(v.volume):'';})()", cb);
    }

    boolean hasPage() {
        String u = web.getUrl();
        return u != null && u.startsWith("http");
    }

    boolean isVisible() {
        return visible;
    }

    String currentBvid() {
        return currentBvid;
    }

    // ---------------- 注入执行 ----------------

    private void evalJs(String code) {
        main.post(() -> {
            if (!hasPage()) return;
            try {
                web.evaluateJavascript(code, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void evalJsWithResult(String code, final Bridge.Callback cb) {
        main.post(() -> {
            if (!hasPage()) {
                cb.onResult(null);
                return;
            }
            try {
                web.evaluateJavascript(code, value -> {
                    if (value == null || "null".equals(value)) cb.onResult(null);
                    else cb.onResult(unquote(value));
                });
            } catch (Exception e) {
                cb.onResult(null);
            }
        });
    }

    /** evaluateJavascript 回传的是 JSON 字面量, 字符串会带引号并转义 */
    private static String unquote(String value) {
        try {
            if (value.startsWith("\"")) return new org.json.JSONArray("[" + value + "]").optString(0);
        } catch (Exception ignored) {
        }
        return value;
    }

    /** 登录成功后把 cookie 同步给播放器 WebView, 否则内嵌页面还是未登录状态 */
    void syncCookies(Map<String, String> cookies) {
        main.post(() -> {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            for (Map.Entry<String, String> e : cookies.entrySet()) {
                String value = e.getKey() + "=" + e.getValue() + "; path=/; domain=.bilibili.com";
                cm.setCookie("https://www.bilibili.com", value);
                cm.setCookie("https://passport.bilibili.com", value);
            }
            cm.flush();
        });
    }

    WebView raw() {
        return web;
    }
}
