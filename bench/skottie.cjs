// Requires: npm i --no-save canvaskit-wasm   (Skia's Skottie player, wasm build)
const path = require('path'); const fs = require('fs');
const CanvasKitInit = require('canvaskit-wasm/bin/full/canvaskit.js');
const SIZE = 400, PASSES = 10, RUNS = 5;
(async () => {
  const CK = await CanvasKitInit({ locateFile: (f) => path.join(path.dirname(require.resolve('canvaskit-wasm/package.json')), 'bin/full', f) });
  const files = process.argv.slice(2);
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const measure = (json) => {
    let t = performance.now();
    const anim = CK.MakeManagedAnimation(json);
    const loadMs = performance.now() - t;
    const surface = CK.MakeSurface(SIZE, SIZE); const canvas = surface.getCanvas();
    const rect = CK.LTRBRect(0, 0, SIZE, SIZE);
    const dur = anim.duration(), fps = anim.fps(); const frames = Math.round(dur * fps);
    const frame = (f) => { canvas.clear(CK.TRANSPARENT); anim.seekFrame(f); anim.render(canvas, rect); surface.flush(); };
    for (let f = 0; f < frames; f++) frame(f);
    const per = [];
    for (let p = 0; p < PASSES; p++) { const t0 = performance.now(); for (let f = 0; f < frames; f++) frame(f); per.push((performance.now() - t0) / frames); }
    anim.delete(); surface.delete();
    return { loadMs, renderMs: med(per), frames };
  };
  for (const f of files) { const json = fs.readFileSync(f, 'utf8'); measure(json); }   // warm
  for (const f of files) {
    const json = fs.readFileSync(f, 'utf8'); const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(measure(json));
    console.log(`${path.basename(f).padEnd(24)} ${(json.length / 1024).toFixed(0).padStart(5)} KB · skottie load (parse+build) ${med(runs.map(r => r.loadMs)).toFixed(1)} ms · render ${med(runs.map(r => r.renderMs)).toFixed(2)} ms/frame (${runs[0].frames} frames)`);
  }
})();
