package com.bilimusic.app;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS 桥: 取代桌面端的 preload + ipcMain。
 *
 * 页面里 src/renderer/bili-bridge.js 会生成 window.bili.*, 每个方法通过
 * BiliNative.request(id, method, payload) 调到这里, 处理完再用
 * window.__bridgeResolve(id, json) 回填 Promise。
 * 方法与桌面端 IPC 通道一一对应, 返回结构也保持一致({ok:true,...} / {ok:false,message})。
 */
final class Bridge {

    interface Callback {
        void onResult(String value);
    }

    private final MainActivity activity;
    private final WebView web;
    private final Store store;
    private final BiliApi api;
    private final PlayerController player;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());

    Bridge(MainActivity activity, WebView web, Store store, BiliApi api, PlayerController player) {
        this.activity = activity;
        this.web = web;
        this.store = store;
        this.api = api;
        this.player = player;
    }

    @JavascriptInterface
    public void request(final int id, final String method, final String payloadJson) {
        final JSONObject payload;
        try {
            payload = payloadJson == null || payloadJson.isEmpty() ? new JSONObject() : new JSONObject(payloadJson);
        } catch (Exception e) {
            resolve(id, error("参数解析失败: " + e.getMessage()));
            return;
        }
        executor.execute(() -> {
            try {
                dispatch(id, method == null ? "" : method, payload);
            } catch (Throwable t) {
                resolve(id, error(t.getMessage() == null ? t.toString() : t.getMessage()));
            }
        });
    }

    /** 回填 Promise(必须在主线程调用 evaluateJavascript) */
    void resolve(final int id, final JSONObject result) {
        main.post(() -> {
            try {
                web.evaluateJavascript("window.__bridgeResolve(" + id + "," + JSONObject.quote(result.toString()) + ")", null);
            } catch (Exception ignored) {
            }
        });
    }

    private static JSONObject error(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("message", message == null ? "未知错误" : message);
        } catch (Exception ignored) {
        }
        return o;
    }

    private static JSONObject ok() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
        } catch (Exception ignored) {
        }
        return o;
    }

    private void dispatch(int id, String method, JSONObject p) throws Exception {
        switch (method) {
            // ---------------- 播放器(异步读取的两条单列出来) ----------------
            case "player:status":
                player.readStatus(value -> {
                    JSONObject out = ok();
                    try {
                        if (value != null && !"null".equals(value)) {
                            out.put("data", new JSONObject(value));
                        } else {
                            out.put("ok", false);
                            JSONObject d = new JSONObject();
                            d.put("paused", true);
                            out.put("data", d);
                        }
                    } catch (Exception ignored) {
                    }
                    resolve(id, out);
                });
                return;

            case "player:getVolume":
                player.readVolume(value -> {
                    JSONObject out = ok();
                    try {
                        float v = player.volume();
                        if (value != null && !value.isEmpty()) {
                            try {
                                v = Float.parseFloat(value);
                                player.setVolume(v);
                            } catch (NumberFormatException ignored) {
                            }
                        }
                        out.put("volume", (double) v);
                        out.put("source", value != null && !value.isEmpty() ? "player" : "main");
                    } catch (Exception ignored) {
                    }
                    resolve(id, out);
                });
                return;

            default:
                resolve(id, dispatchSync(method, p));
        }
    }

    private JSONObject dispatchSync(String method, JSONObject p) throws Exception {
        switch (method) {
            // ---------------- B 站接口 ----------------
            case "bili:search": {
                JSONObject data = api.searchVideo(p.optString("keyword"), Math.max(1, p.optInt("page", 1)), p.optString("order", "totalrank"));
                JSONObject out = ok();
                out.put("data", data);
                return out;
            }
            case "bili:hot": {
                JSONObject out = ok();
                out.put("data", api.getHotMusic());
                return out;
            }
            case "bili:pages": {
                JSONObject out = ok();
                out.put("data", api.getVideoPages(p.optString("bvid")));
                return out;
            }
            case "bili:getView": {
                JSONObject out = ok();
                out.put("data", api.getView(p.optString("bvid")));
                return out;
            }
            case "bili:img": {
                JSONObject out = ok();
                out.put("dataUrl", api.imageDataUrl(p.optString("url")));
                return out;
            }

            // ---------------- 登录 ----------------
            case "login:generateQR": {
                JSONObject data = api.generateQrCode();
                JSONObject out = ok();
                out.put("url", data.optString("url"));
                out.put("qrcodeKey", data.optString("qrcodeKey"));
                return out;
            }
            case "login:poll": {
                JSONObject data = api.pollLogin(p.optString("qrcodeKey"));
                if (data.optInt("code", -1) == 0) {
                    // 登录成功: 把 cookie 同步给内嵌播放器, 让它也变成已登录
                    player.syncCookies(store.cookies());
                    store.saveCookies();
                }
                JSONObject out = ok();
                out.put("data", data);
                return out;
            }
            case "login:status": {
                JSONObject out = ok();
                out.put("data", store.isLoggedIn() ? api.getUserInfo() : new JSONObject().put("isLogin", false));
                return out;
            }
            case "login:logout": {
                store.clearCookies();
                player.syncCookies(Collections.singletonMap("SESSDATA", ""));
                return ok();
            }

            // ---------------- 应用信息 ----------------
            case "app:info": {
                JSONObject out = ok();
                out.put("version", activity.appVersion());
                out.put("packaged", true);
                out.put("userData", store.dir().getAbsolutePath());
                out.put("runtime", "Android " + android.os.Build.VERSION.RELEASE);
                out.put("electron", android.os.Build.VERSION.RELEASE);
                out.put("playerVisible", player.isVisible());
                out.put("hasTray", false);
                return out;
            }

            // ---------------- 播放器 ----------------
            case "player:load":
                player.load(p.optString("bvid"), p.optDouble("t", 0), p.optInt("p", 0));
                return ok();
            case "player:reload":
                player.reload(p.optString("bvid"), p.optDouble("t", 0), p.optInt("p", 0));
                return ok();
            case "player:hide":
                player.hide();
                return ok();
            case "player:pause":
                player.pause();
                return ok();
            case "player:resume":
                player.resume();
                return ok();
            case "player:seek": {
                String bvid = p.optString("bvid");
                double t = p.optDouble("t", 0);
                int page = p.optInt("p", 0);
                if (player.isVisible() && bvid.equals(player.currentBvid()) && player.hasPage()) {
                    player.seek(t);
                    JSONObject out = ok();
                    out.put("inPlace", true);
                    return out;
                }
                player.load(bvid, t, page);
                return ok();
            }
            case "player:setBounds":
                player.setBounds(p.optDouble("x", 0), p.optDouble("y", 0), p.optDouble("width", 0), p.optDouble("height", 0));
                return ok();
            case "player:setVolume": {
                player.setVolume(p.optDouble("volume", 0.8));
                JSONObject out = ok();
                out.put("volume", (double) player.volume());
                return out;
            }
            case "player:pageFullscreen":
                player.pageFullscreen();
                return ok();

            // ---------------- 歌单导入 / 导出 ----------------
            case "import:saveSongs": {
                JSONArray arr = p.optJSONArray("songs");
                List<String> list = new ArrayList<>();
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) list.add(arr.optString(i));
                }
                if (list.isEmpty()) {
                    JSONObject bad = ok();
                    bad.put("ok", false);
                    bad.put("message", "没有解析到歌曲名");
                    return bad;
                }
                int added = store.addSongs(list);
                JSONObject out = ok();
                out.put("added", added);
                out.put("total", store.loadSongs().size());
                return out;
            }
            case "import:getRandomSongs": {
                List<String> songs = store.loadSongs();
                Collections.shuffle(songs);
                int count = Math.min(Math.max(1, p.optInt("count", 7)), songs.size());
                JSONArray arr = new JSONArray();
                for (int i = 0; i < count; i++) arr.put(songs.get(i));
                JSONObject out = ok();
                out.put("songs", arr);
                out.put("total", songs.size());
                return out;
            }
            case "file:saveText": {
                String saved = store.saveTextToDownloads(p.optString("name"), p.optString("text"));
                JSONObject out = ok();
                if (saved == null) {
                    out.put("ok", false);
                    out.put("message", "保存失败");
                } else {
                    out.put("path", saved);
                }
                return out;
            }

            default:
                return error("未知方法: " + method);
        }
    }

    void shutdown() {
        executor.shutdownNow();
    }
}
