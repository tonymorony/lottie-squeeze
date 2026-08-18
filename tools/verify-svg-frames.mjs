#!/usr/bin/env node
/**
 * Render the source SVG frames and the generated Lottie in the same headless Chrome
 * (same rasterizer, same anti-aliasing) and compare pixels frame by frame.
 *
 *   node tools/verify-svg-frames.mjs out.json [--size 400] [--renderer canvas|svg] [--dump DIR]
 *
 * Reads out.json.meta.json (written by svg-frames-to-lottie.py) for the frame list and the
 * per-frame re-alignment shifts, and applies the same shift to the SVG viewBox so the two
 * are compared in the same coordinate space.
 *
 * Exit 0 when no frame has more than --max-perceptible pixels with a channel Δ > 32
 * (default 0.5% of inked pixels); AA edge differences between an SVG <circle> and a
 * bezier circle are expected and stay well below that.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { findChrome } = await import(path.join(here, '..', 'src', 'verify.js'));

const args = process.argv.slice(2);
const lottiePath = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
if (!lottiePath) { console.error('usage: verify-svg-frames.mjs out.json [--size 400] [--renderer canvas|svg] [--dump DIR] [--max-perceptible 0.005]'); process.exit(2); }
const SIZE = Number(opt('size', 400));
const RENDERER = opt('renderer', 'canvas');
const DUMP = opt('dump', null);
const MAX_PERCEPTIBLE = Number(opt('max-perceptible', 0.005));

const doc = JSON.parse(readFileSync(lottiePath, 'utf8'));
const meta = JSON.parse(readFileSync(lottiePath + '.meta.json', 'utf8'));
if (DUMP) mkdirSync(DUMP, { recursive: true });

const puppeteer = require('puppeteer-core');
const lottieSrc = readFileSync(require.resolve('lottie-web/build/player/lottie.min.js'), 'utf8');
const exe = findChrome();
if (!exe) { console.error('No Chrome found; set LOTTIE_SQUEEZE_CHROME'); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'] });
const clip = { x: 0, y: 0, width: SIZE, height: SIZE };

const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent"><div id=holder style="width:${SIZE}px;height:${SIZE}px"><canvas id=c width=${SIZE} height=${SIZE}></canvas></div></body></html>`);
await page.addScriptTag({ content: lottieSrc });
await page.evaluate((doc, renderer) => {
  if (renderer === 'canvas') {
    window.anim = lottie.loadAnimation({ renderer: 'canvas', loop: false, autoplay: false, animationData: doc,
      rendererSettings: { context: document.getElementById('c').getContext('2d'), clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' } });
  } else {
    document.getElementById('c').remove();
    window.anim = lottie.loadAnimation({ container: document.getElementById('holder'), renderer: 'svg', loop: false, autoplay: false, animationData: doc,
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet' } });
  }
}, doc, RENDERER);
async function lottiePNG(f) {
  await page.evaluate((f) => { anim.goToAndStop(f, true); }, f);
  return page.screenshot({ omitBackground: true, encoding: 'binary', clip });
}

const svgPage = await browser.newPage();
await svgPage.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
async function svgPNG(i) {
  let svg = readFileSync(meta.files[i], 'utf8');
  const [dx, dy] = meta.shifts[i];
  svg = svg.replace(/viewBox="([^"]*)"/, (m, vb) => {
    let [x, y, w, h] = vb.split(/[\s,]+/).map(Number);
    x -= dx; y -= dy;
    if (meta.crop && meta.crop.length === 4) { [x, y, w, h] = [x + meta.crop[0], y + meta.crop[1], meta.crop[2], meta.crop[3]]; }
    return `viewBox="${x} ${y} ${w} ${h}"`;
  });
  svg = svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid meet" `);
  await svgPage.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  return svgPage.screenshot({ omitBackground: true, encoding: 'binary', clip });
}

const cmpPage = await browser.newPage();
await cmpPage.setContent('<html><body></body></html>');
async function diff(pngA, pngB) {
  return cmpPage.evaluate(async (a, b, wantImage) => {
    async function load(b64) { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height); }
    const A = await load(a), B = await load(b);
    let diffPx = 0, vis = 0, maxd = 0, sum = 0, inked = 0;
    const out = wantImage ? new Uint8ClampedArray(A.data.length) : null;
    for (let p = 0; p < A.data.length; p += 4) {
      const aa = A.data[p + 3] / 255, ba = B.data[p + 3] / 255;   // composite both over white
      let d = 0;
      for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs((A.data[p + ch] * aa + 255 * (1 - aa)) - (B.data[p + ch] * ba + 255 * (1 - ba))));
      if (aa > 0 || ba > 0) inked++;
      if (d > 0) { diffPx++; sum += d; if (d > maxd) maxd = d; if (d > 32) vis++; }
      if (out) { const v = Math.min(255, d * 4); out[p] = 255; out[p + 1] = 255 - v; out[p + 2] = 255 - v; out[p + 3] = 255; }
    }
    let png = null;
    if (out) { const c = document.createElement('canvas'); c.width = A.width; c.height = A.height; c.getContext('2d').putImageData(new ImageData(out, A.width, A.height), 0, 0); png = c.toDataURL().split(',')[1]; }
    return { diffPx, vis, maxd: Math.round(maxd), mean: diffPx ? sum / diffPx : 0, inked, total: A.data.length / 4, png };
  }, pngA.toString('base64'), pngB.toString('base64'), !!DUMP);
}

const nf = doc.op - doc.ip;
let worst = null, failed = false;
for (let f = 0; f < nf; f++) {
  const a = await svgPNG(f); const b = await lottiePNG(f);
  const r = await diff(a, b);
  const tag = String(f + 1).padStart(2, '0');
  if (DUMP) { writeFileSync(`${DUMP}/svg_${tag}.png`, a); writeFileSync(`${DUMP}/lottie_${tag}.png`, b); writeFileSync(`${DUMP}/diff_${tag}.png`, Buffer.from(r.png, 'base64')); }
  const ratio = r.inked ? r.vis / r.inked : 0;
  const bad = ratio > MAX_PERCEPTIBLE;
  failed ||= bad;
  console.log(`frame ${String(f + 1).padStart(2)}: ${r.diffPx} px differ, ${r.vis} perceptibly (${(ratio * 100).toFixed(2)}% of ${r.inked} inked), max Δ ${r.maxd}${bad ? '  ✗' : ''}`);
  if (!worst || r.vis > worst.vis) worst = { frame: f + 1, ...r, png: undefined };
}
console.log(`${RENDERER} @ ${SIZE}px · worst frame ${worst.frame}: ${worst.vis} perceptible px (${(100 * worst.vis / worst.inked).toFixed(2)}%), max Δ ${worst.maxd} · ${failed ? 'FAIL' : 'OK'}`);
await browser.close();
process.exit(failed ? 1 : 0);
