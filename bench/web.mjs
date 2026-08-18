import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const lottieSrc = readFileSync(require.resolve('lottie-web/build/player/lottie.min.js'), 'utf8');
const { findChrome } = await import(new URL('../src/verify.js', import.meta.url));
const files = process.argv.slice(2);
const SIZE = 400, PASSES = 10, RUNS = 5;
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE });
await page.setContent(`<html><body style="margin:0"><div id="c" style="width:${SIZE}px;height:${SIZE}px"></div></body></html>`);
await page.addScriptTag({ content: lottieSrc });
const timing = (text, renderer) => page.evaluate(async (s, renderer, passes) => {
  let t = performance.now(); const data = JSON.parse(s); const parseMs = performance.now() - t;
  document.getElementById('c').innerHTML = '';
  t = performance.now();
  const anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer, loop: false, autoplay: false, animationData: data, rendererSettings: { clearCanvas: true } });
  anim.goToAndStop(0, true);
  const buildMs = performance.now() - t;
  const total = Math.ceil(anim.totalFrames);
  for (let f = 0; f < total; f++) anim.goToAndStop(f, true);   // warm
  const per = [];
  for (let p = 0; p < passes; p++) { const t0 = performance.now(); for (let f = 0; f < total; f++) anim.goToAndStop(f, true); per.push((performance.now() - t0) / total); }
  per.sort((a, b) => a - b);
  const dom = renderer === 'svg' ? document.getElementById('c').querySelectorAll('*').length : 0;
  anim.destroy(); document.getElementById('c').innerHTML = '';
  return { parseMs, buildMs, renderMedian: per[Math.floor(per.length / 2)], dom, frames: total };
}, text, renderer, PASSES);
const heap = (text, renderer) => page.evaluate(async (s, renderer) => {
  document.getElementById('c').innerHTML = ''; window.gc(); await new Promise((r) => setTimeout(r, 50)); window.gc();
  const h0 = performance.memory.usedJSHeapSize;
  const data = JSON.parse(s);
  const anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer, loop: false, autoplay: false, animationData: data, rendererSettings: { clearCanvas: true } });
  const total = Math.ceil(anim.totalFrames);
  for (let f = 0; f < total; f++) anim.goToAndStop(f, true);
  window.gc(); await new Promise((r) => setTimeout(r, 50)); window.gc();
  const h1 = performance.memory.usedJSHeapSize;
  anim.destroy(); document.getElementById('c').innerHTML = '';
  return (h1 - h0) / 1048576;
}, text, renderer);
const results = {};
for (const renderer of ['canvas', 'svg']) {
  for (const f of files) await timing(readFileSync(f, 'utf8'), renderer); // JIT warm-up
  for (const f of files) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await timing(readFileSync(f, 'utf8'), renderer));
    const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(RUNS / 2)];
    results[f] ??= {}; results[f][renderer] = { parseMs: med('parseMs'), buildMs: med('buildMs'), renderMs: med('renderMedian'), dom: runs[0].dom, frames: runs[0].frames };
  }
  for (const f of files) { results[f][renderer].heapMB = await heap(readFileSync(f, 'utf8'), renderer); }
}
console.log(JSON.stringify(results));
for (const [f, r] of Object.entries(results)) {
  const kb = (readFileSync(f).length / 1024).toFixed(0);
  console.log(`${f.padEnd(24)} ${kb.padStart(5)} KB · parse ${r.canvas.parseMs.toFixed(1)} ms · canvas: build ${r.canvas.buildMs.toFixed(0)} ms, render ${r.canvas.renderMs.toFixed(2)} ms/frame, heap +${r.canvas.heapMB.toFixed(1)} MB · svg: build ${r.svg.buildMs.toFixed(0)} ms, render ${r.svg.renderMs.toFixed(2)} ms/frame, ${r.svg.dom} DOM nodes, heap +${r.svg.heapMB.toFixed(1)} MB`);
}
await browser.close();
