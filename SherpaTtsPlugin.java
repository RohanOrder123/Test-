package com.rohanchauhan.tradesjournal;

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Offline Piper voices through sherpa-onnx (VITS / Piper models).
 *
 * Models live inside the APK:   assets/voices/<voiceId>/<voiceId>.onnx  +  tokens.txt
 * Shared phonemizer data:       assets/voices/espeak-ng-data/   (copied once to filesDir, because espeak needs real files)
 *
 * JS API (window.Capacitor.Plugins.SherpaTts):
 *   status()                      -> what is in the APK, native library state
 *   selfTest({voice,text})        -> load + synthesize (no playback), timings, peak amplitude
 *   speak({voice,text,speed})     -> plays natively; resolves when finished OR interrupted (never hangs)
 *   stop()                        -> stops playback, resolves the pending speak() immediately
 *   preload({voice})              -> loads a voice into memory
 * Error codes: NO_ASSET, NATIVE_LIB, INIT_FAIL, GEN_FAIL, NO_AUDIO, BAD_ARGS
 */
@CapacitorPlugin(name = "SherpaTts")
public class SherpaTtsPlugin extends Plugin {

    private static final String ESPEAK_MARK = "espeak-ok-v1";
    private static final float[] END = new float[0];

    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final AtomicInteger gen = new AtomicInteger();
    private final Map<String, OfflineTts> engines = new HashMap<>();
    private final Object trackLock = new Object();
    private AudioTrack track;
    private volatile Run current;
    private String espeakDir;

    /* short phrases are cached so repeated replies start instantly */
    private final LinkedHashMap<String, float[]> cache = new LinkedHashMap<String, float[]>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, float[]> e) {
            return size() > 24;
        }
    };

    /* ---------------------------------------------------------------- helpers */

    private static class VoiceErr extends Exception {
        final String code;
        VoiceErr(String code, String msg) {
            super(msg);
            this.code = code;
        }
    }

    /** One pending speak() call. Resolved exactly once, from whichever thread gets there first. */
    private static class Run {
        final PluginCall call;
        final AtomicBoolean done = new AtomicBoolean(false);
        Run(PluginCall c) {
            call = c;
        }
        void ok(JSObject o) {
            if (done.compareAndSet(false, true)) call.resolve(o);
        }
        void fail(String msg, String code) {
            if (done.compareAndSet(false, true)) call.reject(msg, code);
        }
    }

    private static long since(long t0) {
        return SystemClock.elapsedRealtime() - t0;
    }

    private boolean assetExists(AssetManager am, String path) {
        try (InputStream in = am.open(path)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private long assetSize(AssetManager am, String path) {
        try (AssetFileDescriptor fd = am.openFd(path)) {
            return fd.getLength();
        } catch (Throwable e) {
            try (InputStream in = am.open(path)) {
                return in.available();
            } catch (Throwable e2) {
                return -1;
            }
        }
    }

    private int copyAssetDir(AssetManager am, String src, File dst) throws IOException {
        String[] list = am.list(src);
        if (list == null || list.length == 0) {
            try (InputStream in = am.open(src)) {
                File parent = dst.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream out = new FileOutputStream(dst)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) out.write(b, 0, n);
                }
                return 1;
            } catch (FileNotFoundException e) {
                dst.mkdirs(); /* an empty directory */
                return 0;
            }
        }
        dst.mkdirs();
        int count = 0;
        for (String n : list) count += copyAssetDir(am, src + "/" + n, new File(dst, n));
        return count;
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    /** espeak-ng-data is copied once; a marker file proves the copy finished (survives app restarts). */
    private synchronized String ensureEspeak() throws VoiceErr {
        if (espeakDir != null) return espeakDir;
        File root = getContext().getFilesDir();
        File dst = new File(root, "espeak-ng-data");
        File mark = new File(root, ESPEAK_MARK);
        try {
            if (!(mark.exists() && dst.isDirectory())) {
                deleteTree(dst);
                int n = copyAssetDir(getContext().getAssets(), "voices/espeak-ng-data", dst);
                if (n < 20) throw new IOException("only " + n + " espeak files found in APK assets");
                if (!mark.exists() && !mark.createNewFile()) throw new IOException("cannot write marker");
            }
        } catch (IOException e) {
            throw new VoiceErr("NO_ASSET", "espeak-ng-data: " + e.getMessage());
        }
        espeakDir = dst.getAbsolutePath();
        return espeakDir;
    }

    private synchronized OfflineTts load(String id) throws VoiceErr {
        OfflineTts t = engines.get(id);
        if (t != null) return t;
        if (id == null || !id.matches("[A-Za-z0-9_\\-]+")) throw new VoiceErr("BAD_ARGS", "bad voice id");
        AssetManager am = getContext().getAssets();
        String dir = "voices/" + id;
        String model = dir + "/" + id + ".onnx";
        String tokens = dir + "/tokens.txt";
        for (String p : new String[]{model, tokens}) {
            if (!assetExists(am, p)) throw new VoiceErr("NO_ASSET", p);
        }
        String espeak = ensureEspeak();
        try {
            OfflineTtsVitsModelConfig v = new OfflineTtsVitsModelConfig();
            v.setModel(model);
            v.setTokens(tokens);
            v.setDataDir(espeak);
            v.setLexicon("");
            v.setDictDir("");
            v.setNoiseScale(0.667f);
            v.setNoiseScaleW(0.8f);
            v.setLengthScale(1.0f);
            OfflineTtsModelConfig m = new OfflineTtsModelConfig();
            m.setVits(v);
            m.setNumThreads(2);
            m.setDebug(false);
            m.setProvider("cpu");
            OfflineTtsConfig c = new OfflineTtsConfig();
            c.setModel(m);
            c.setMaxNumSentences(1);
            t = new OfflineTts(am, c);
        } catch (Throwable e) {
            String why = e.getClass().getSimpleName() + ": " + e.getMessage();
            throw new VoiceErr(e instanceof LinkageError ? "NATIVE_LIB" : "INIT_FAIL", why);
        }
        engines.put(id, t);
        return t;
    }

    private float[] synth(OfflineTts t, String voice, String chunk, float speed) {
        boolean cacheable = chunk.length() <= 80;
        String key = voice + "|" + speed + "|" + chunk;
        if (cacheable) {
            synchronized (cache) {
                float[] hit = cache.get(key);
                if (hit != null) return hit;
            }
        }
        GeneratedAudio a = t.generate(chunk, 0, speed);
        float[] s = a.getSamples();
        if (cacheable && s != null && s.length > 0) {
            synchronized (cache) {
                cache.put(key, s);
            }
        }
        return s;
    }

    /** Sentence / clause splitting so the next chunk can be synthesized while the current one plays. */
    static List<String> split(String s) {
        List<String> out = new ArrayList<>();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            b.append(ch);
            boolean decimal = ch == '.' && i > 0 && i + 1 < s.length()
                    && Character.isDigit(s.charAt(i - 1)) && Character.isDigit(s.charAt(i + 1));
            boolean hard = !decimal && (ch == '\u0964' || ch == '.' || ch == '!' || ch == '?' || ch == ';' || ch == '\n');
            boolean soft = (ch == ',' || ch == ':') && b.length() > 140;
            if (hard || soft || b.length() >= 220) flush(out, b);
        }
        flush(out, b);
        return out;
    }

    private static void flush(List<String> out, StringBuilder b) {
        String t = b.toString().trim();
        b.setLength(0);
        for (int i = 0; i < t.length(); i++) {
            if (Character.isLetterOrDigit(t.charAt(i))) {
                out.add(t);
                return;
            }
        }
    }

    private AudioTrack openTrack(int sr) {
        int min = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack at = new AudioTrack(AudioManager.STREAM_MUSIC, sr, AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 2, sr / 2), AudioTrack.MODE_STREAM);
        at.play();
        synchronized (trackLock) {
            track = at;
        }
        return at;
    }

    /** Releasing the track also unblocks a write() that is waiting on the player. */
    private void killTrack() {
        AudioTrack t;
        synchronized (trackLock) {
            t = track;
            track = null;
        }
        if (t == null) return;
        try { t.pause(); } catch (Throwable e) { /* ignore */ }
        try { t.flush(); } catch (Throwable e) { /* ignore */ }
        try { t.release(); } catch (Throwable e) { /* ignore */ }
    }

    /** returns false when the write failed or the speech was interrupted */
    private boolean writeSamples(AudioTrack at, float[] s, int my) {
        short[] buf = new short[Math.min(s.length, 2048)];
        int pos = 0;
        while (pos < s.length) {
            if (gen.get() != my) return false;
            int n = Math.min(buf.length, s.length - pos);
            for (int i = 0; i < n; i++) {
                float v = s[pos + i] * 32767f;
                buf[i] = (short) (v > 32767f ? 32767 : (v < -32768f ? -32768 : v));
            }
            int w = at.write(buf, 0, n);
            if (w < 0) return false;
            pos += n;
        }
        return true;
    }

    private JSObject interrupted() {
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("interrupted", true);
        return o;
    }

    /* ------------------------------------------------------------ plugin API */

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        AssetManager am = getContext().getAssets();
        StringBuilder abis = new StringBuilder();
        for (String a : Build.SUPPORTED_ABIS) abis.append(abis.length() > 0 ? "," : "").append(a);
        o.put("abis", abis.toString());
        try {
            Class.forName("com.k2fsa.sherpa.onnx.OfflineTts"); /* runs the static initializer = loads the native library */
            o.put("nativeOk", true);
        } catch (Throwable e) {
            o.put("nativeOk", false);
            o.put("nativeError", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        JSObject files = new JSObject();
        try {
            String[] voices = am.list("voices");
            if (voices != null) {
                for (String v : voices) {
                    if (v.equals("espeak-ng-data")) continue;
                    JSObject f = new JSObject();
                    f.put("onnx", assetSize(am, "voices/" + v + "/" + v + ".onnx"));
                    f.put("tokens", assetSize(am, "voices/" + v + "/tokens.txt"));
                    f.put("loaded", engines.containsKey(v));
                    files.put(v, f);
                }
            }
        } catch (IOException e) {
            o.put("assetError", e.getMessage());
        }
        o.put("voices", files);
        o.put("espeakInApk", assetExists(am, "voices/espeak-ng-data/phondata"));
        File root = getContext().getFilesDir();
        o.put("espeakCopied", new File(root, ESPEAK_MARK).exists() && new File(root, "espeak-ng-data").isDirectory());
        o.put("storage", "APK assets (read-only) + filesDir/espeak-ng-data (app files dir)");
        call.resolve(o);
    }

    @PluginMethod
    public void preload(final PluginCall call) {
        final String voice = call.getString("voice");
        exec.execute(() -> {
            try {
                long t0 = SystemClock.elapsedRealtime();
                load(voice);
                JSObject o = new JSObject();
                o.put("ok", true);
                o.put("initMs", since(t0));
                call.resolve(o);
            } catch (VoiceErr e) {
                call.reject(e.getMessage(), e.code);
            } catch (Throwable e) {
                call.reject(String.valueOf(e), "INIT_FAIL");
            }
        });
    }

    @PluginMethod
    public void selfTest(final PluginCall call) {
        final String voice = call.getString("voice");
        final String text = call.getString("text", "test");
        exec.execute(() -> {
            try {
                long t0 = SystemClock.elapsedRealtime();
                OfflineTts t = load(voice);
                long initMs = since(t0);
                long t1 = SystemClock.elapsedRealtime();
                GeneratedAudio a = t.generate(text, 0, 1.0f);
                long genMs = since(t1);
                float[] s = a.getSamples();
                float peak = 0f;
                if (s != null) for (float v : s) peak = Math.max(peak, Math.abs(v));
                double secs = (s == null ? 0 : s.length) / (double) Math.max(1, a.getSampleRate());
                JSObject o = new JSObject();
                o.put("ok", s != null && s.length > 0 && peak > 0.01f);
                o.put("initMs", initMs);
                o.put("synthMs", genMs);
                o.put("audioSec", Math.round(secs * 100) / 100.0);
                o.put("sampleRate", a.getSampleRate());
                o.put("peak", Math.round(peak * 1000) / 1000.0);
                o.put("rtf", secs > 0 ? Math.round(genMs / 1000.0 / secs * 100) / 100.0 : -1);
                call.resolve(o);
            } catch (VoiceErr e) {
                call.reject(e.getMessage(), e.code);
            } catch (Throwable e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "GEN_FAIL");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        gen.incrementAndGet();
        killTrack();
        Run r = current;
        if (r != null) r.ok(interrupted());
        call.resolve();
    }

    @PluginMethod
    public void speak(final PluginCall call) {
        final String text = call.getString("text", "");
        final String voice = call.getString("voice");
        final float speed = Math.max(0.5f, Math.min(1.6f, call.getFloat("speed", 1.0f)));
        if (text.trim().isEmpty() || voice == null) {
            call.reject("text and voice are required", "BAD_ARGS");
            return;
        }
        final int my = gen.incrementAndGet();
        killTrack();
        Run old = current;
        if (old != null) old.ok(interrupted());
        final Run run = new Run(call);
        current = run;
        exec.execute(() -> {
            try {
                runSpeak(run, my, voice, text, speed);
            } catch (Throwable e) {
                run.fail(e.getClass().getSimpleName() + ": " + e.getMessage(), "GEN_FAIL");
            } finally {
                if (current == run) current = null;
            }
        });
    }

    private void runSpeak(Run run, final int my, final String voice, String text, final float speed) {
        long t0 = SystemClock.elapsedRealtime();
        final OfflineTts t;
        try {
            t = load(voice);
        } catch (VoiceErr e) {
            run.fail(e.getMessage(), e.code);
            return;
        }
        final long initMs = since(t0);
        final List<String> chunks = split(text);
        if (chunks.isEmpty() || gen.get() != my) {
            run.ok(interrupted());
            return;
        }
        final BlockingQueue<float[]> q = new ArrayBlockingQueue<>(2);
        final AtomicBoolean abort = new AtomicBoolean(false);
        final AtomicReference<Throwable> perr = new AtomicReference<>();

        /* producer: synthesizes chunk N+1 while chunk N is playing */
        Thread prod = new Thread(() -> {
            try {
                for (String c : chunks) {
                    if (abort.get() || gen.get() != my) break;
                    float[] s = synth(t, voice, c, speed);
                    if (s == null || s.length == 0) continue;
                    while (!q.offer(s, 200, TimeUnit.MILLISECONDS)) {
                        if (abort.get() || gen.get() != my) return;
                    }
                }
            } catch (Throwable e) {
                perr.set(e);
            } finally {
                try {
                    while (!q.offer(END, 200, TimeUnit.MILLISECONDS)) {
                        if (abort.get() || gen.get() != my) break;
                    }
                } catch (InterruptedException ie) { /* ignore */ }
            }
        }, "sherpa-synth");
        prod.start();

        AudioTrack at = null;
        long firstMs = -1;
        long frames = 0;
        boolean interrupted = false;
        try {
            while (true) {
                if (gen.get() != my) {
                    interrupted = true;
                    break;
                }
                float[] s = q.poll(200, TimeUnit.MILLISECONDS);
                if (s == null) continue;
                if (s == END) break;
                if (at == null) {
                    at = openTrack(t.sampleRate());
                    firstMs = since(t0);
                }
                if (!writeSamples(at, s, my)) {
                    interrupted = true;
                    break;
                }
                frames += s.length;
            }
            if (!interrupted && at != null) {
                at.stop(); /* MODE_STREAM: plays out everything already written */
                long limit = SystemClock.elapsedRealtime() + (frames * 1000L / Math.max(1, t.sampleRate())) + 1500;
                while (gen.get() == my && at.getPlaybackHeadPosition() < frames && SystemClock.elapsedRealtime() < limit) {
                    Thread.sleep(30);
                }
                if (gen.get() != my) interrupted = true;
            }
        } catch (Throwable e) {
            perr.compareAndSet(null, e);
        } finally {
            abort.set(true);
            try { prod.join(); } catch (InterruptedException ie) { /* ignore */ }
            synchronized (trackLock) {
                if (track == at) track = null;
            }
            if (at != null) {
                try { at.release(); } catch (Throwable e) { /* ignore */ }
            }
        }

        Throwable err = perr.get();
        if (err != null && !interrupted) {
            run.fail(err.getClass().getSimpleName() + ": " + err.getMessage(), "GEN_FAIL");
            return;
        }
        if (at == null && !interrupted) {
            run.fail("the engine produced no audio", "NO_AUDIO");
            return;
        }
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("interrupted", interrupted);
        o.put("initMs", initMs);
        o.put("firstAudioMs", firstMs);
        o.put("totalMs", since(t0));
        o.put("chunks", chunks.size());
        o.put("sampleRate", t.sampleRate());
        run.ok(o);
    }
}
