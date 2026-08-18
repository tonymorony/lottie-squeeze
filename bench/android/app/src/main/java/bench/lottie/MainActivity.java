package bench.lottie;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.os.Debug;
import android.util.Log;
import android.widget.TextView;

import com.airbnb.lottie.LottieComposition;
import com.airbnb.lottie.LottieCompositionFactory;
import com.airbnb.lottie.LottieDrawable;
import com.airbnb.lottie.LottieResult;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class MainActivity extends Activity {
    static final String TAG = "LOTTIEBENCH";
    static final int SIZE = 400, PASSES = 10, RUNS = 5;
    static Object HOLD;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        TextView tv = new TextView(this); tv.setText("benchmarking…"); setContentView(tv);
        new Thread(() -> { try { run(); } catch (Throwable t) { Log.e(TAG, "fail", t); } runOnUiThread(() -> tv.setText("done")); }).start();
    }

    static long median(long[] a) { long[] c = a.clone(); Arrays.sort(c); return c[c.length / 2]; }
    static double median(double[] a) { double[] c = a.clone(); Arrays.sort(c); return c[c.length / 2]; }

    void run() throws Exception {
        String[] files = getAssets().list("");
        List<String> jsons = new ArrayList<>();
        for (String f : files) if (f.endsWith(".json")) jsons.add(f);
        java.util.Collections.sort(jsons);
        // warm-up pass so JIT/class loading does not land on the first file
        for (String f : jsons) bench(f, true);
        for (String f : jsons) bench(f, false);
        Log.i(TAG, "ALL DONE");
    }

    byte[] readAsset(String name) throws Exception {
        try (InputStream is = getAssets().open(name)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[65536]; int n; while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        }
    }

    void bench(String name, boolean warm) throws Exception {
        byte[] bytes = readAsset(name);
        long[] parseNs = new long[RUNS], buildNs = new long[RUNS];
        double[] renderMs = new double[RUNS];
        long heapDelta = 0, nativeDelta = 0;
        LottieComposition comp = null;
        for (int r = 0; r < RUNS; r++) {
            Runtime rt = Runtime.getRuntime();
            System.gc(); Thread.sleep(50);
            long h0 = rt.totalMemory() - rt.freeMemory(), n0 = Debug.getNativeHeapAllocatedSize();
            long t = System.nanoTime();
            LottieResult<LottieComposition> res = LottieCompositionFactory.fromJsonInputStreamSync(new java.io.ByteArrayInputStream(bytes), null);
            parseNs[r] = System.nanoTime() - t;
            if (res.getException() != null) throw new RuntimeException(res.getException());
            comp = res.getValue();
            t = System.nanoTime();
            LottieDrawable d = new LottieDrawable();
            d.setComposition(comp);
            d.setBounds(0, 0, SIZE, SIZE);
            Bitmap bmp = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            d.setFrame(0); c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR); d.draw(c);
            buildNs[r] = System.nanoTime() - t;
            int frames = (int) Math.ceil(comp.getDurationFrames());
            for (int f = 0; f < frames; f++) { d.setFrame(f); d.draw(c); }   // warm
            System.gc(); Thread.sleep(50);
            long h1 = rt.totalMemory() - rt.freeMemory(), n1 = Debug.getNativeHeapAllocatedSize();
            if (r == 0) { heapDelta = h1 - h0; nativeDelta = n1 - n0; }
            double[] per = new double[PASSES];
            for (int p = 0; p < PASSES; p++) {
                long t0 = System.nanoTime();
                for (int f = 0; f < frames; f++) { d.setFrame(f); c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR); d.draw(c); }
                per[p] = (System.nanoTime() - t0) / 1e6 / frames;
            }
            renderMs[r] = median(per);
            bmp.recycle();
        }
        // memory: hold a fully built drawable and measure the settled heap delta (max of 3 attempts)
        long memMax = 0;
        for (int a = 0; a < 3; a++) {
            Runtime rt = Runtime.getRuntime();
            for (int g = 0; g < 3; g++) { System.gc(); Thread.sleep(80); }
            long h0 = rt.totalMemory() - rt.freeMemory();
            LottieComposition c2 = LottieCompositionFactory.fromJsonInputStreamSync(new java.io.ByteArrayInputStream(bytes), null).getValue();
            LottieDrawable d2 = new LottieDrawable(); d2.setComposition(c2); d2.setBounds(0, 0, SIZE, SIZE);
            Bitmap bmp2 = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888); Canvas cv2 = new Canvas(bmp2);
            int fr2 = (int) Math.ceil(c2.getDurationFrames());
            for (int f = 0; f < fr2; f++) { d2.setFrame(f); d2.draw(cv2); }
            bmp2.recycle();
            for (int g = 0; g < 3; g++) { System.gc(); Thread.sleep(80); }
            long h1 = rt.totalMemory() - rt.freeMemory();
            HOLD = new Object[]{c2, d2};
            memMax = Math.max(memMax, h1 - h0);
            HOLD = null;
        }
        heapDelta = memMax;
        if (warm) return;
        Log.i(TAG, String.format("RESULT %s bytes=%d frames=%d parse_ms=%.1f build_ms=%.1f render_ms_per_frame=%.3f java_heap_mb=%.1f native_heap_mb=%.1f",
                name, bytes.length, (int) Math.ceil(comp.getDurationFrames()), median(parseNs) / 1e6, median(buildNs) / 1e6, median(renderMs), heapDelta / 1048576.0, nativeDelta / 1048576.0));
    }
}
