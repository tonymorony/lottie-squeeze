# bench

Playback benchmarks across three independent players. Drop the JSON files you want to
compare next to the scripts (they are not committed — bring your own artwork).

```bash
node bench/web.mjs a.json b.json …          # lottie-web in headless Chrome: parse, build, ms/frame (canvas + svg), DOM nodes, JS heap
npm i --no-save canvaskit-wasm && node bench/skottie.cjs a.json b.json …   # Skottie (Skia): load, ms/frame
```

`bench/android/` is a minimal app that runs lottie-android against every JSON in
`app/src/main/assets/` and prints one `RESULT` line per file to logcat
(`adb logcat -s LOTTIEBENCH`). Build with a local `local.properties` (`sdk.dir=…`),
Gradle 9 + AGP 9.1, JDK 17:

```bash
gradle :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n bench.lottie/.MainActivity && adb logcat -s LOTTIEBENCH
```

It parses from bytes (`fromJsonInputStreamSync`), builds a `LottieDrawable`, and draws
every frame into a 400×400 `Bitmap` through a software `Canvas` — the main-thread work,
reproducible without a screen. Medians of 5 runs × 10 passes. Emulator numbers are
only meaningful relative to each other.
