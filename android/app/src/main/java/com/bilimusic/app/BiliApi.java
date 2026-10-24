package com.bilimusic.app;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * B 站接口层(从 src/bili-api.js / src/login.js 等价移植)。
 *
 * 与桌面端一致: 使用固定的桌面 UA + Referer, 自己维护 cookie 字符串,
 * 手动跟随重定向(这样才能在 30x 响应里抓到 Set-Cookie, 登录流程依赖这一点)。
 */
final class BiliApi {

    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private final Store store;
    private final Random random = new Random();

    BiliApi(Store store) {
        this.store = store;
    }

    // ---------------- 基础请求 ----------------

    static final class Resp {
        int status;
        Map<String, String> headers = new LinkedHashMap<>();
        byte[] body = new byte[0];

        String text() {
            return new String(body, java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    /**
     * 发一个请求, 手动跟随重定向(最多 5 跳), 每一跳的 Set-Cookie 都会吸收。
     */
    Resp request(String url, String method, Map<String, String> extraHeaders, byte[] body, int timeoutSec) throws Exception {
        String current = url;
        for (int hop = 0; hop <= 5; hop++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setRequestMethod(method == null ? "GET" : method);
            conn.setConnectTimeout(timeoutSec * 1000);
            conn.setReadTimeout(timeoutSec * 1000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Referer", "https://www.bilibili.com");
            conn.setRequestProperty("Origin", "https://www.bilibili.com");
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
            String cookie = store.cookieHeader();
            if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            if (extraHeaders != null) {
                for (Map.Entry<String, String> e : extraHeaders.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
            }
            if (body != null && body.length > 0) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
            }

            int status = conn.getResponseCode();
            Resp resp = new Resp();
            resp.status = status;

            // 吸收 Set-Cookie(必须在读流之前)
            int cookieCount = 0;
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                String key = e.getKey();
                if (key == null) continue;
                if ("Set-Cookie".equalsIgnoreCase(key)) {
                    for (String raw : e.getValue()) {
                        cookieCount += absorbSetCookie(raw);
                    }
                } else {
                    resp.headers.put(key.toLowerCase(), e.getValue().isEmpty() ? "" : e.getValue().get(0));
                }
            }
            if (cookieCount > 0) store.saveCookies();

            InputStream in = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
            resp.body = in == null ? new byte[0] : Store.readAll(in);
            if (in != null) in.close();

            if (status >= 300 && status < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.isEmpty()) return resp;
                if (location.startsWith("/")) {
                    URL base = new URL(current);
                    location = base.getProtocol() + "://" + base.getHost() + location;
                }
                current = location;
                continue;
            }
            conn.disconnect();
            return resp;
        }
        throw new IllegalStateException("重定向次数过多");
    }

    /** 从 Set-Cookie 头解析出 name=value 并写入 cookie 罐, 返回吸收数量 */
    private int absorbSetCookie(String raw) {
        if (raw == null) return 0;
        String first = raw.split(";", 2)[0];
        int eq = first.indexOf('=');
        if (eq <= 0) return 0;
        String name = first.substring(0, eq).trim();
        String value = first.substring(eq + 1).trim();
        if (name.isEmpty()) return 0;
        store.putCookie(name, value);
        return 1;
    }

    JSONObject getJson(String url, boolean sign) throws Exception {
        String target = url;
        if (sign) {
            ensureWbi();
            target = Wbi.sign(url);
        }
        Resp resp = request(target, "GET", null, null, 15);
        return new JSONObject(resp.text());
    }

    // ---------------- WBI ----------------

    private void ensureWbi() throws Exception {
        long now = System.currentTimeMillis();
        if (Wbi.hasKey() && now - Wbi.lastUpdate() < 4L * 60 * 60 * 1000) return;
        refreshWbi();
    }

    boolean refreshWbi() {
        try {
            // 未登录时 code=-101, 但 wbi_img 仍然返回, 所以不看 code
            JSONObject data = getJson("https://api.bilibili.com/x/web-interface/nav", false);
            JSONObject wbi = data.optJSONObject("data") == null ? null : data.optJSONObject("data").optJSONObject("wbi_img");
            if (wbi == null) return false;
            return Wbi.setKeys(wbi.optString("img_url"), wbi.optString("sub_url"));
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------- 业务接口 ----------------

    /** 搜索视频(走 WBI 签名) */
    JSONObject searchVideo(String keyword, int page, String order) throws Exception {
        String url = "https://api.bilibili.com/x/web-interface/wbi/search/type"
                + "?search_type=video"
                + "&keyword=" + URLEncoder.encode(keyword == null ? "" : keyword, "UTF-8")
                + "&page=" + page
                + "&order=" + URLEncoder.encode(order == null ? "totalrank" : order, "UTF-8");
        JSONObject data = getJson(url, true);
        int code = data.optInt("code", -1);
        if (code != 0) throw new IllegalStateException("[" + code + "] " + data.optString("message"));

        JSONObject d = data.optJSONObject("data");
        JSONArray result = d == null ? new JSONArray() : d.optJSONArray("result");
        JSONArray out = new JSONArray();
        if (result != null) {
            for (int i = 0; i < result.length(); i++) {
                JSONObject r = result.optJSONObject(i);
                if (r == null) continue;
                JSONObject item = new JSONObject();
                item.put("bvid", r.optString("bvid"));
                item.put("aid", r.optLong("aid"));
                item.put("title", stripEm(r.optString("title")));
                item.put("author", r.optString("author"));
                item.put("duration", parseDuration(r.opt("duration")));
                item.put("cover", r.optString("pic"));
                item.put("play", r.optLong("play"));
                out.put(item);
            }
        }
        int numPages = d == null ? 1 : d.optInt("numPages", 1);
        JSONObject resp = new JSONObject();
        resp.put("results", out);
        resp.put("hasMore", page < Math.max(1, numPages));
        return resp;
    }

    private static String stripEm(String title) {
        if (title == null) return "";
        return title.replace("<em class=\"keyword\">", "").replace("</em>", "");
    }

    static int parseDuration(Object d) {
        if (d == null || d == JSONObject.NULL) return 0;
        if (d instanceof Number) return ((Number) d).intValue();
        String s = String.valueOf(d);
        int colon = s.indexOf(':');
        if (colon > 0) {
            try {
                int m = Integer.parseInt(s.substring(0, colon).trim());
                int sec = Integer.parseInt(s.substring(colon + 1).trim());
                return m * 60 + sec;
            } catch (NumberFormatException ignored) {
            }
        }
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static final String[] HOT_KEYWORDS = {
            "热门歌曲", "新歌榜", "华语金曲", "抖音热门", "BGM",
            "治愈系音乐", "纯音乐", "电音", "日语歌", "经典老歌",
            "网络热歌", "翻唱", "流行歌曲", "伤感歌曲", "说唱",
    };

    /** 热门推荐: 随机关键词搜索后打乱取 10 条(与桌面端一致) */
    JSONArray getHotMusic() throws Exception {
        String kw = HOT_KEYWORDS[random.nextInt(HOT_KEYWORDS.length)];
        int page = 1 + random.nextInt(3);
        try {
            return shuffledTop10(searchVideo(kw, page, "click").optJSONArray("results"));
        } catch (Exception e) {
            String kw2 = HOT_KEYWORDS[random.nextInt(HOT_KEYWORDS.length)];
            int page2 = 1 + random.nextInt(3);
            return shuffledTop10(searchVideo(kw2, page2, "click").optJSONArray("results"));
        }
    }

    private JSONArray shuffledTop10(JSONArray results) {
        List<JSONObject> list = new ArrayList<>();
        if (results != null) {
            for (int i = 0; i < results.length(); i++) {
                JSONObject o = results.optJSONObject(i);
                if (o != null) list.add(o);
            }
        }
        Collections.shuffle(list, random);
        JSONArray out = new JSONArray();
        for (int i = 0; i < Math.min(10, list.size()); i++) out.put(list.get(i));
        return out;
    }

    /** 视频分集信息(多 P) */
    JSONArray getVideoPages(String bvid) throws Exception {
        JSONObject data = getJson("https://api.bilibili.com/x/web-interface/view?bvid=" + URLEncoder.encode(bvid == null ? "" : bvid, "UTF-8"), false);
        int code = data.optInt("code", -1);
        if (code != 0) throw new IllegalStateException(data.optString("message", "获取失败"));
        JSONObject d = data.optJSONObject("data");
        JSONArray pages = d == null ? null : d.optJSONArray("pages");
        JSONArray out = new JSONArray();
        if (pages == null) return out;
        int cumulative = 0;
        for (int i = 0; i < pages.length(); i++) {
            JSONObject p = pages.optJSONObject(i);
            if (p == null) continue;
            JSONObject item = new JSONObject();
            item.put("cid", p.optLong("cid"));
            item.put("page", p.optInt("page", i + 1));
            item.put("part", p.optString("part"));
            item.put("duration", p.optInt("duration"));
            item.put("startTime", cumulative);
            out.put(item);
            cumulative += p.optInt("duration");
        }
        return out;
    }

    /** 视频详情 */
    JSONObject getView(String bvid) throws Exception {
        JSONObject data = getJson("https://api.bilibili.com/x/web-interface/view?bvid=" + URLEncoder.encode(bvid == null ? "" : bvid, "UTF-8"), false);
        int code = data.optInt("code", -1);
        if (code != 0) throw new IllegalStateException(data.optString("message", "获取失败"));
        JSONObject v = data.optJSONObject("data");
        JSONObject out = new JSONObject();
        out.put("bvid", bvid);
        if (v != null) {
            out.put("title", v.optString("title"));
            JSONObject owner = v.optJSONObject("owner");
            out.put("author", owner == null ? "" : owner.optString("name"));
            out.put("duration", v.optInt("duration"));
            out.put("cover", v.optString("pic"));
        }
        return out;
    }

    /** 用户信息 */
    JSONObject getNav() throws Exception {
        return getJson("https://api.bilibili.com/x/web-interface/nav", false);
    }

    /** 图片代理: 返回 data URL(避免页面里 file:// 直连图床被拦) */
    String imageDataUrl(String url) throws Exception {
        String u = url;
        if (u.startsWith("//")) u = "https:" + u;
        Resp resp = request(u, "GET", null, null, 15);
        String type = resp.headers.get("content-type");
        if (type == null || type.isEmpty()) type = "image/jpeg";
        int semi = type.indexOf(';');
        if (semi > 0) type = type.substring(0, semi);
        return "data:" + type + ";base64," + Base64.encodeToString(resp.body, Base64.NO_WRAP);
    }

    // ---------------- 扫码登录 ----------------

    /** 生成登录二维码 */
    JSONObject generateQrCode() throws Exception {
        Resp resp = request("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", "GET", null, null, 15);
        store.saveCookies();
        JSONObject data = new JSONObject(resp.text());
        if (data.optInt("code", -1) != 0) throw new IllegalStateException(data.optString("message", "生成二维码失败"));
        JSONObject d = data.optJSONObject("data");
        JSONObject out = new JSONObject();
        out.put("url", d == null ? "" : d.optString("url"));
        out.put("qrcodeKey", d == null ? "" : d.optString("qrcode_key"));
        return out;
    }

    /**
     * 轮询扫码状态。
     * 外层 code 表示接口是否成功, 内层 data.code 才是扫码状态:
     * 86101 未扫码 / 86090 已扫码待确认 / 86038 已过期 / 0 成功。
     */
    JSONObject pollLogin(String qrcodeKey) throws Exception {
        String url = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key="
                + URLEncoder.encode(qrcodeKey == null ? "" : qrcodeKey, "UTF-8");
        Resp resp = request(url, "GET", null, null, 15);
        JSONObject data = new JSONObject(resp.text());
        JSONObject inner = data.optJSONObject("data");
        int scanCode = inner != null && inner.has("code") ? inner.optInt("code") : data.optInt("code", -1);
        JSONObject out = new JSONObject();
        out.put("code", scanCode);
        out.put("message", inner != null ? inner.optString("message") : data.optString("message"));

        if (scanCode == 0 && inner != null) {
            String redirect = inner.optString("url");
            out.put("url", redirect);
            // 兜底: 从响应体里直接补 cookie
            putIfPresent(inner, "sessdata", "SESSDATA");
            putIfPresent(inner, "SESSDATA", "SESSDATA");
            putIfPresent(inner, "DedeUserID", "DedeUserID");
            putIfPresent(inner, "dedeuserid", "DedeUserID");
            putIfPresent(inner, "bili_jct", "bili_jct");
            if (!redirect.isEmpty()) {
                try {
                    request(redirect, "GET", null, null, 10);   // 跟随重定向以拿到 SESSDATA
                } catch (Exception ignored) {
                }
            }
            store.saveCookies();
        }
        return out;
    }

    private void putIfPresent(JSONObject src, String field, String cookieName) {
        String v = src.optString(field, "");
        if (!v.isEmpty()) store.putCookie(cookieName, v);
    }

    /** 已登录时的用户信息 */
    JSONObject getUserInfo() {
        try {
            JSONObject data = getNav();
            JSONObject d = data.optJSONObject("data");
            if (data.optInt("code", -1) == 0 && d != null && d.optBoolean("isLogin")) {
                JSONObject out = new JSONObject();
                out.put("isLogin", true);
                out.put("uid", String.valueOf(d.optLong("mid")));
                out.put("uname", d.optString("uname"));
                out.put("face", d.optString("face"));
                return out;
            }
        } catch (Exception ignored) {
        }
        try {
            JSONObject out = new JSONObject();
            out.put("isLogin", false);
            return out;
        } catch (Exception e) {
            return new JSONObject();
        }
    }

}
