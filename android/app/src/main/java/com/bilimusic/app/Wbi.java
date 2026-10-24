package com.bilimusic.app;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * WBI 签名(从 src/wbi.js 等价移植)。
 *
 * 密钥来自 nav 接口的 wbi_img.img_url / sub_url, 4 小时自动刷新。
 * 打乱表与编码方式必须和桌面端完全一致, 否则签名过不了:
 *   - 打乱表 MIXIN_KEY_ENC_TAB 与 src/wbi.js 逐项相同
 *   - 值里的 !'()* 先过滤再签名(WBI 规范)
 *   - 编码用 application/x-www-form-urlencoded 规则(空格→+, ~→%7E),
 *     与 JS 的 URLSearchParams.toString() 完全一致
 *
 * 这里刻意只用 java.* 而不是 android.net.Uri, 这样脚本能在普通 JVM 上
 * 直接跑单元测试(src/wbi.js 与 Wbi.java 对同一批 URL 出同样的签名)。
 */
final class Wbi {

    /** 打乱表 —— 与 src/wbi.js 完全一致, 勿改 */
    static final int[] MIXIN_KEY_ENC_TAB = {
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
            27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
            37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
            22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    };

    private static final Object LOCK = new Object();
    private static String mixKey = "";
    private static long lastUpdate = 0L;

    private Wbi() {
    }

    /** 从密钥图片 URL 里取出最后一段并去掉扩展名 */
    static String extractKeyFromUrl(String url) {
        if (url == null) return "";
        String last = url.substring(url.lastIndexOf('/') + 1);
        int dot = last.lastIndexOf('.');
        return dot > 0 ? last.substring(0, dot) : last;
    }

    /** 由 imgKey + subKey 计算 mixKey(与 src/wbi.js getMixKey 等价) */
    static String mixKeyOf(String imgKey, String subKey) {
        String s = imgKey + subKey;
        StringBuilder sb = new StringBuilder();
        for (int idx : MIXIN_KEY_ENC_TAB) {
            if (idx < s.length()) sb.append(s.charAt(idx));
        }
        return sb.length() > 32 ? sb.substring(0, 32) : sb.toString();
    }

    static boolean setKeys(String imgUrl, String subUrl) {
        String imgKey = extractKeyFromUrl(imgUrl);
        String subKey = extractKeyFromUrl(subUrl);
        if (imgKey.isEmpty() || subKey.isEmpty()) return false;
        synchronized (LOCK) {
            mixKey = mixKeyOf(imgKey, subKey);
            lastUpdate = System.currentTimeMillis();
        }
        return true;
    }

    /** 测试用: 直接注入 mixKey */
    static void setMixKeyForTest(String key) {
        synchronized (LOCK) {
            mixKey = key == null ? "" : key;
            lastUpdate = System.currentTimeMillis();
        }
    }

    static boolean hasKey() {
        synchronized (LOCK) {
            return !mixKey.isEmpty();
        }
    }

    static long lastUpdate() {
        synchronized (LOCK) {
            return lastUpdate;
        }
    }

    /** 给 URL 追加 wts 与 w_rid(与 src/wbi.js signWbi 等价) */
    static String sign(String url) throws Exception {
        return sign(url, System.currentTimeMillis() / 1000);
    }

    /** 指定 wts 的版本(便于用固定时间戳做一致性测试) */
    static String sign(String url, long wts) throws Exception {
        String key;
        synchronized (LOCK) {
            key = mixKey;
        }
        if (key.isEmpty()) throw new IllegalStateException("WBI 密钥未就绪");

        String canonical = canonicalQuery(url, wts);
        String wRid = md5(canonical + key);

        // 与 JS 一致: 待签名串用 encodeURIComponent 规则, 而最终 URL 用
        // URLSearchParams.toString() 规则(空格变 +), 过滤后的值只出现在签名串里
        List<String[]> pairs = parsePairs(url);
        StringBuilder finalUrl = new StringBuilder(headOf(url)).append('?');
        for (int i = 0; i < pairs.size(); i++) {
            if (i > 0) finalUrl.append('&');
            finalUrl.append(encodeForUrl(pairs.get(i)[0])).append('=').append(encodeForUrl(pairs.get(i)[1]));
        }
        if (pairs.size() > 0) finalUrl.append('&');
        finalUrl.append("wts=").append(wts).append("&w_rid=").append(wRid);
        return finalUrl.toString();
    }

    /**
     * 待签名字符串: 解码后的键值对 + wts, 按 key 排序, 值过滤 !'()* 后按
     * x-www-form-urlencoded 编码拼接。JVM 上可直接调用(单元测试比对 JS)。
     */
    static String canonicalQuery(String url, long wts) throws Exception {
        List<String[]> pairs = new ArrayList<>(parsePairs(url));
        pairs.add(new String[]{"wts", String.valueOf(wts)});
        Collections.sort(pairs, new Comparator<String[]>() {
            @Override
            public int compare(String[] a, String[] b) {
                return a[0].compareTo(b[0]);
            }
        });
        StringBuilder sb = new StringBuilder();
        for (String[] p : pairs) {
            if (sb.length() > 0) sb.append('&');
            sb.append(encodeForSign(p[0])).append('=').append(encodeForSign(filterValue(p[1])));
        }
        return sb.toString();
    }

    static String headOf(String url) {
        int q = url.indexOf('?');
        return q >= 0 ? url.substring(0, q) : url;
    }

    /** 解析查询串为解码后的键值对(保持原顺序) */
    static List<String[]> parsePairs(String url) throws Exception {
        List<String[]> out = new ArrayList<>();
        int q = url.indexOf('?');
        if (q < 0 || q == url.length() - 1) return out;
        String query = url.substring(q + 1);
        for (String kv : query.split("&")) {
            if (kv.isEmpty()) continue;
            int eq = kv.indexOf('=');
            String k = eq >= 0 ? kv.substring(0, eq) : kv;
            String v = eq >= 0 ? kv.substring(eq + 1) : "";
            out.add(new String[]{URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8")});
        }
        return out;
    }

    /** 与 JS encodeURIComponent 一致的编码(空格→%20, 保留 !'()*~) */
    static String encodeForSign(String s) throws Exception {
        return encodeForUrl(s)
                .replace("+", "%20")
                .replace("%7E", "~")
                .replace("%21", "!")
                .replace("%2A", "*")
                .replace("%27", "'")
                .replace("%28", "(")
                .replace("%29", ")");
    }

    /** 与 JS URLSearchParams.toString() 一致的编码(空格→+, ~→%7E) */
    static String encodeForUrl(String s) throws Exception {
        return URLEncoder.encode(s == null ? "" : s, "UTF-8");
    }

    private static String filterValue(String v) {
        if (v == null) return "";
        StringBuilder sb = new StringBuilder(v.length());
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '!' || c == '\'' || c == '(' || c == ')' || c == '*') continue;
            sb.append(c);
        }
        return sb.toString();
    }

    static String md5(String text) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] digest = md.digest(text.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            String hex = Integer.toHexString(b & 0xff);
            if (hex.length() == 1) sb.append('0');
            sb.append(hex);
        }
        return sb.toString();
    }
}
