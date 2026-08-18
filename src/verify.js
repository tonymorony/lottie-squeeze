/**
 * The part that makes this trustworthy: render the source and the optimized file
 * frame by frame in a real browser with real lottie-web, and compare pixels.
 *
 * Reasoning about the Lottie spec is not enough. Two optimizations that looked
 * obviously safe on paper — dropping `sr`/`st` as defaults, and rounding
 * coordinates to 2 decimals — were caught here and only here.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

const CHROME_CANDIDATES = [
  process.env.LOTTIE_SQUEEZE_CHROME,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function lottieSource() {
  return readFileSync(require.resolve('lottie-web/build/player/lottie.min.js'), 'utf8');
}

async function launch(executablePath) {
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; }
  catch { throw new Error('Verification needs puppeteer-core. Install it, or pass --no-verify.'); }
  const exe = executablePath ?? findChrome();
  if (!exe) {
    throw new Error('No Chrome/Chromium found. Set LOTTIE_SQUEEZE_CHROME=/path/to/chrome, or pass --no-verify.');
  }
  return puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });
}

/**
 * Compare two animations pixel by pixel with the canvas renderer, then confirm
 * with the svg renderer (lottie-web's default, and a different code path).
 *
 * Returns { identical, frames, worst: {frame, maxChannelDiff, diffPixels, totalPixels}, svg }
 */
export async function verify(docA, docB, {
  size = 600, renderers = ['canvas', 'svg'], tolerance = 0, executablePath = null, onProgress = null,
} = {}) {
  const browser = await launch(executablePath);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2 * size + 60, height: size + 40, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:#fff">
      <div id="a" style="width:${size}px;height:${size}px;position:absolute;left:0;top:0"></div>
      <div id="b" style="width:${size}px;height:${size}px;position:absolute;left:${size + 20}px;top:0"></div>
    </body></html>`);
    await page.addScriptTag({ content: lottieSource() });

    const result = { identical: true, frames: 0, worst: null, svg: null };

    if (renderers.includes('canvas')) {
      onProgress?.('rendering canvas frames');
      const r = await page.evaluate(async (dA, dB) => {
        const mk = (id, data) => lottie.loadAnimation({
          container: document.getElementById(id), renderer: 'canvas',
          loop: false, autoplay: false, animationData: data,
          rendererSettings: { clearCanvas: true },
        });
        document.getElementById('a').innerHTML = ''; document.getElementById('b').innerHTML = '';
        const a = mk('a', dA), b = mk('b', dB);
        await Promise.all([a, b].map((x) => new Promise((res) => x.addEventListener('DOMLoaded', res))));
        const ca = document.querySelector('#a canvas'), cb = document.querySelector('#b canvas');
        const xa = ca.getContext('2d'), xb = cb.getContext('2d');
        const total = Math.max(Math.ceil(a.totalFrames), Math.ceil(b.totalFrames));
        const frames = [];
        for (let f = 0; f < total; f++) {
          a.goToAndStop(f, true); b.goToAndStop(f, true);
          await new Promise((res) => requestAnimationFrame(res));
          const pa = xa.getImageData(0, 0, ca.width, ca.height).data;
          const pb = xb.getImageData(0, 0, cb.width, cb.height).data;
          let maxd = 0, ndiff = 0, visible = 0, sum = 0, inked = 0;
          for (let i = 0; i < pa.length; i += 4) {
            let d = 0;
            for (let c = 0; c < 4; c++) { const x = Math.abs(pa[i + c] - pb[i + c]); if (x > d) d = x; }
            if (pa[i + 3] > 0) inked++;
            if (d) { ndiff++; sum += d; if (d > maxd) maxd = d; if (d > 32) visible++; }
          }
          frames.push({ frame: f, maxChannelDiff: maxd, diffPixels: ndiff, visiblePixels: visible,
                        meanDiff: ndiff ? sum / ndiff : 0, inkedPixels: inked, totalPixels: pa.length / 4 });
        }
        a.destroy(); b.destroy();
        return { frames, totalA: a.totalFrames, totalB: b.totalFrames };
      }, docA, docB);

      result.frames = r.frames.length;
      result.totalFrames = [r.totalA, r.totalB];
      result.worst = r.frames.reduce((w, f) =>
        (!w || f.maxChannelDiff > w.maxChannelDiff || (f.maxChannelDiff === w.maxChannelDiff && f.diffPixels > w.diffPixels)) ? f : w, null);
      result.framesDiffering = r.frames.filter((f) => f.diffPixels > tolerance).length;
      if (result.framesDiffering > 0) result.identical = false;
      if (r.totalA !== r.totalB) { result.identical = false; result.frameCountMismatch = true; }
    }

    if (renderers.includes('svg')) {
      onProgress?.('cross-checking svg renderer');
      const shots = async (data) => {
        await page.setContent(`<html><body style="margin:0;background:#fff">
          <div id="c" style="width:${Math.min(size, 400)}px;height:${Math.min(size, 400)}px"></div></body></html>`);
        await page.addScriptTag({ content: lottieSource() });
        const total = await page.evaluate(async (d) => {
          window.__anim = lottie.loadAnimation({
            container: document.getElementById('c'), renderer: 'svg',
            loop: false, autoplay: false, animationData: d,
          });
          await new Promise((res) => window.__anim.addEventListener('DOMLoaded', res));
          return Math.ceil(window.__anim.totalFrames);
        }, data);
        const el = await page.$('#c');
        const out = [];
        for (let f = 0; f < total; f++) {
          await page.evaluate((n) => window.__anim.goToAndStop(n, true), f);
          out.push(createHash('sha256').update(await el.screenshot({ type: 'png' })).digest('hex'));
        }
        return out;
      };
      await page.setViewport({ width: 440, height: 440, deviceScaleFactor: 2 });
      const A = await shots(docA), B = await shots(docB);
      const differing = A.map((h, i) => (h === B[i] ? null : i)).filter((x) => x !== null);
      result.svg = { frames: A.length, differing };
      if (differing.length) result.identical = false;
    }

    return result;
  } finally {
    await browser.close();
  }
}

/** Parse / build / per-frame render timings, warmed up so the numbers mean something. */
export async function benchmark(docs, { passes = 5, warmups = 1, executablePath = null } = {}) {
  const browser = await launch(executablePath);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 400 });
    await page.setContent('<html><body style="margin:0"><div id="c" style="width:300px;height:300px"></div></body></html>');
    await page.addScriptTag({ content: lottieSource() });

    const measure = (doc) => page.evaluate(async (data, passes) => {
      const s = JSON.stringify(data);
      let t = performance.now(); JSON.parse(s);
      const parseMs = performance.now() - t;
      document.getElementById('c').innerHTML = '';
      t = performance.now();
      const anim = lottie.loadAnimation({
        container: document.getElementById('c'), renderer: 'canvas',
        loop: false, autoplay: false, animationData: data, rendererSettings: { clearCanvas: true },
      });
      await new Promise((r) => anim.addEventListener('DOMLoaded', r));
      const buildMs = performance.now() - t;
      const total = Math.ceil(anim.totalFrames);
      anim.goToAndStop(0, true);
      await new Promise((r) => requestAnimationFrame(r));
      t = performance.now();
      for (let p = 0; p < passes; p++) for (let f = 0; f < total; f++) anim.goToAndStop(f, true);
      const renderMsPerFrame = (performance.now() - t) / (passes * total);
      anim.destroy();
      return { bytes: s.length, parseMs, buildMs, renderMsPerFrame };
    }, doc, passes);

    for (let w = 0; w < warmups; w++) for (const d of docs) await measure(d);   // let the JIT settle
    const out = [];
    for (const d of docs) out.push(await measure(d));
    return out;
  } finally {
    await browser.close();
  }
}
