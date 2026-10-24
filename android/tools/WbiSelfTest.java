package com.bilimusic.app;

/**
 * WBI 移植自检(纯 JVM, 不需要安卓设备)。
 *
 * 用法: java -cp <classes> com.bilimusic.app.WbiSelfTest <url> <wts>
 * 输出: 第一行 = 待签名字符串, 第二行 = w_rid
 *
 * scripts/android-test/wbi-port-test.js 会拿同样的输入在 Node 里
 * 用 src/wbi.js 的算法算一遍, 两边必须完全一致。
 */
public final class WbiSelfTest {

    public static void main(String[] args) throws Exception {
        String url = args.length > 0 ? args[0] : "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=test&page=1&order=totalrank";
        long wts = args.length > 1 ? Long.parseLong(args[1]) : 1700000000L;

        String canonical = Wbi.canonicalQuery(url, wts);
        String mixKey = args.length > 2 ? args[2] : "ea1db124af3c7062474693fa704f4ff8";
        System.out.println(canonical);
        System.out.println(Wbi.md5(canonical + mixKey));
        System.out.println(Wbi.mixKeyOf("7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45"));
        Wbi.setMixKeyForTest(mixKey);
        System.out.println(Wbi.sign(url, wts));
    }
}
