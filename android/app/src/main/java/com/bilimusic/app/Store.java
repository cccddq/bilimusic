package com.bilimusic.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 本地存储: cookie、导入的歌单、应用信息。
 *
 * 对应桌面端的 %APPDATA%\BiliMusic, 安卓侧落到应用私有目录 filesDir,
 * 文件名与桌面端保持一致(cookies.json / imported_songs.json), 方便互相拷贝。
 */
final class Store {

    private final Context ctx;
    private final File dir;
    private final Map<String, String> cookies = new LinkedHashMap<>();

    Store(Context ctx) {
        this.ctx = ctx;
        this.dir = ctx.getFilesDir();
    }

    File dir() {
        return dir;
    }

    // ---------------- cookies ----------------

    private File cookieFile() {
        return new File(dir, "cookies.json");
    }

    synchronized void loadCookies() {
        try {
            File f = cookieFile();
            if (!f.exists()) return;
            JSONObject json = new JSONObject(readText(f));
            cookies.clear();
            java.util.Iterator<String> it = json.keys();
            while (it.hasNext()) {
                String k = it.next();
                cookies.put(k, json.optString(k, ""));
            }
        } catch (Exception ignored) {
        }
    }

    synchronized void saveCookies() {
        try {
            JSONObject json = new JSONObject();
            for (Map.Entry<String, String> e : cookies.entrySet()) json.put(e.getKey(), e.getValue());
            writeText(cookieFile(), json.toString(2));
        } catch (Exception ignored) {
        }
    }

    synchronized void putCookie(String name, String value) {
        if (name == null || name.isEmpty()) return;
        cookies.put(name, value == null ? "" : value);
    }

    synchronized void putCookies(Map<String, String> more) {
        if (more == null) return;
        for (Map.Entry<String, String> e : more.entrySet()) putCookie(e.getKey(), e.getValue());
    }

    synchronized String cookieHeader() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : cookies.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    synchronized Map<String, String> cookies() {
        return new LinkedHashMap<>(cookies);
    }

    synchronized void clearCookies() {
        cookies.clear();
        saveCookies();
    }

    synchronized boolean isLoggedIn() {
        return cookies.containsKey("SESSDATA") && !cookies.get("SESSDATA").isEmpty();
    }

    // ---------------- 导入的歌单 ----------------

    private File songsFile() {
        return new File(dir, "imported_songs.json");
    }

    synchronized List<String> loadSongs() {
        List<String> out = new ArrayList<>();
        try {
            File f = songsFile();
            if (!f.exists()) return out;
            JSONArray arr = new JSONArray(readText(f));
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "").trim();
                if (!s.isEmpty()) out.add(s);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    synchronized void saveSongs(List<String> songs) {
        try {
            JSONArray arr = new JSONArray();
            for (String s : songs) arr.put(s);
            writeText(songsFile(), arr.toString(2));
        } catch (Exception ignored) {
        }
    }

    /** 合并新歌名, 返回新增数量 */
    synchronized int addSongs(List<String> incoming) {
        List<String> existing = loadSongs();
        int added = 0;
        for (String name : incoming) {
            String n = name == null ? "" : name.trim();
            if (n.isEmpty() || existing.contains(n)) continue;
            existing.add(n);
            added++;
        }
        if (added > 0) saveSongs(existing);
        return added;
    }

    // ---------------- 通用文本读写 ----------------

    static String readText(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        }
    }

    static void writeText(File f, String text) throws Exception {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /** 把文本导出到系统的「下载」目录(导出歌单用, 不需要存储权限) */
    String saveTextToDownloads(String name, String text) {
        String safe = (name == null || name.trim().isEmpty()) ? "bilimusic-export.json" : name.trim();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (OutputStream out = ctx.getContentResolver().openOutputStream(uri)) {
                    if (out == null) return null;
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                return safe;
            }
            File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!downloads.exists()) downloads.mkdirs();
            File target = new File(downloads, safe);
            writeText(target, text);
            return target.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }
}
