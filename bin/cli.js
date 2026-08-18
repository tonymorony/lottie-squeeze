#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { optimize, DEFAULTS } from '../src/optimize.js';
import { dedupeShapes } from '../src/dedup.js';
import { analyze } from '../src/analyze.js';
import { resize } from '../src/resize.js';
import { mergeDuplicateArtwork } from '../src/merge.js';
import { verify, benchmark, findChrome } from '../src/verify.js';

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`,
      r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const HELP = `
${C.b('lottie-squeeze')} — optimize Lottie JSON, and prove the result still renders identically.

  ${C.b('Usage')}
    lottie-squeeze <input.json...> [options]
    lottie-squeeze analyze <input.json>
    lottie-squeeze bench <a.json> <b.json>

  ${C.b('Options')}
    -o, --out <path>       Output file (default: <input>.min.json). With several
                           inputs this is treated as an output directory.
        --in-place         Overwrite the input file (only after verification passes).
        --no-verify        Skip browser verification. Faster, and you are on your own.
        --size <px>        Verification render size. Default 600.
        --renderers <l>    canvas,svg (default both) — svg is lottie-web's default path.
        --tolerance <n>    Allow up to n differing pixels per frame. Default 0.
        --strip-names      Drop nm/mn. Safe, costs debuggability. Default off.
        --precision <n>    Round geometry to n decimals. ${C.y('Not pixel-exact')} — shifts
                           anti-aliasing. Verification will flag it; use --tolerance.
        --resize <WxH>     Change declared composition size, by scaling the root
                           layer transforms — geometry is left as authored. Aspect
                           ratio must be preserved. ${C.y('Does not reduce file size.')}
        --merge            Merge duplicate artwork: one layer per (shape, position)
                           instead of one per exported frame. Lossless, and gated
                           on paint order staying consistent.
        --dedup            Hoist duplicated paths into shared precomps. ${C.y('Opt-in')}:
                           big raw-size win, but ~2x slower playback. See README.
        --bench            Report parse/build/render timings for source vs output.
        --json             Machine-readable output.
    -q, --quiet            Only errors.
    -h, --help

  ${C.b('Exit codes')}   0 ok · 1 usage/IO error · 2 verification failed (nothing written)
`;

function parseArgs(argv) {
  const o = { inputs: [], out: null, inPlace: false, verify: true, size: 600,
    renderers: ['canvas', 'svg'], tolerance: 0, stripNames: false, precision: null,
    dedup: false, merge: false, bench: false, json: false, quiet: false, resize: null, cmd: 'optimize' };
  const rest = [...argv];
  if (['analyze', 'bench'].includes(rest[0])) o.cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    switch (a) {
      case '-h': case '--help': return { help: true };
      case '-o': case '--out': o.out = rest.shift(); break;
      case '--in-place': o.inPlace = true; break;
      case '--no-verify': o.verify = false; break;
      case '--size': o.size = Number(rest.shift()); break;
      case '--renderers': o.renderers = rest.shift().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--tolerance': o.tolerance = Number(rest.shift()); break;
      case '--strip-names': o.stripNames = true; break;
      case '--precision': o.precision = Number(rest.shift()); break;
      case '--dedup': o.dedup = true; break;
      case '--merge': o.merge = true; break;
      case '--no-merge': o.merge = false; break;
      case '--resize': o.resize = rest.shift(); break;
      case '--bench': o.bench = true; break;
      case '--json': o.json = true; break;
      case '-q': case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option ${a}`); process.exit(1); }
        o.inputs.push(a);
    }
  }
  return o;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (a, b) => `${(100 * (1 - b / a)).toFixed(1)}%`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ser = (d) => JSON.stringify(d);

function defaultOut(input, out) {
  if (!out) return join(dirname(input), `${basename(input, extname(input))}.min.json`);
  try { if (statSync(out).isDirectory()) return join(out, basename(input)); } catch {}
  return out;
}

async function runAnalyze(opts, log) {
  const doc = read(opts.inputs[0]);
  const a = analyze(doc);
  if (opts.json) return console.log(JSON.stringify(a, null, 2));
  log(`${C.b(basename(opts.inputs[0]))}  ${kb(a.total)}`);
  log(`  layers ${a.layers}  ·  animated props ${a.animatedProps}  ·  keyframes ${a.keyframes} (${a.holdKeyframes} hold)`);
  log(`  redundant hold keyframes: ${a.redundantHolds}`);
  log(`  layers retimable via ip/op: ${a.retimable}   never-visible layers: ${a.zeroOpacityLayers}`);
  log(`  shape layers ${a.shapeLayers} → ${a.distinctShapes} distinct  (${kb(a.duplicateShapeBytes)} duplicated)`);
  const top = (o, n = 6) => Object.entries(o).slice(0, n).map(([k, v]) => `${k} ${kb(v)}`).join('  ');
  log(`  ${C.dim('bytes by layer key:')} ${top(a.byLayerKey)}`);
  log(`  ${C.dim('bytes by transform:')} ${top(a.byTransform)}`);
  if (Object.keys(a.byShapeType).length) log(`  ${C.dim('bytes by shape type:')} ${top(a.byShapeType)}`);
  log('');
  for (const h of a.hints) log(`  ${C.y('→')} ${h}`);
}

async function runBench(opts, log) {
  const docs = opts.inputs.map(read);
  const rows = await benchmark(docs);
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  log(`${'file'.padEnd(30)} ${'bytes'.padStart(10)} ${'parse'.padStart(9)} ${'build'.padStart(9)} ${'render/frame'.padStart(13)}`);
  rows.forEach((r, i) => log(
    `${basename(opts.inputs[i]).slice(0, 30).padEnd(30)} ${r.bytes.toLocaleString().padStart(10)} ` +
    `${(r.parseMs.toFixed(1) + 'ms').padStart(9)} ${(r.buildMs.toFixed(0) + 'ms').padStart(9)} ` +
    `${(r.renderMsPerFrame.toFixed(2) + 'ms').padStart(13)}`));
}

async function runOptimize(opts, log) {
  let failed = false;
  for (const input of opts.inputs) {
    const srcText = readFileSync(input, 'utf8');
    const source = JSON.parse(srcText);
    const working = JSON.parse(srcText);

    const { doc: optimized, stats } = optimize(working, {
      ...DEFAULTS, dropNames: opts.stripNames, precision: opts.precision,
    });
    let resizeStats = null;
    if (opts.resize) {
      const m = /^(\d+(?:\.\d+)?)\s*[x*×]\s*(\d+(?:\.\d+)?)$/.exec(opts.resize);
      if (!m) throw new Error(`--resize expects WxH, got "${opts.resize}"`);
      ({ stats: resizeStats } = resize(optimized, Number(m[1]), Number(m[2])));
    }
    let mergeStats = null;
    if (opts.merge) ({ stats: mergeStats } = mergeDuplicateArtwork(optimized));
    let dedupStats = null;
    if (opts.dedup) ({ stats: dedupStats } = dedupeShapes(optimized));

    const outText = ser(optimized);
    const before = Buffer.byteLength(srcText), after = Buffer.byteLength(outText);

    let ver = null;
    if (opts.verify) {
      if (!findChrome()) {
        log(C.y('  ! no Chrome found — skipping verification (set LOTTIE_SQUEEZE_CHROME)'));
      } else {
        ver = await verify(source, JSON.parse(outText), {
          size: opts.size, renderers: opts.renderers, tolerance: opts.tolerance,
          onProgress: (m) => log(C.dim(`  … ${m}`)),
        });
      }
    }

    const target = opts.inPlace ? input : defaultOut(input, opts.inputs.length > 1 ? opts.out : opts.out);
    const ok = !ver || ver.identical;
    if (ok) writeFileSync(target, outText);
    else failed = true;

    if (opts.json) {
      console.log(JSON.stringify({ input, output: ok ? target : null, before, after, stats, resizeStats, mergeStats, dedupStats, verification: ver }, null, 2));
      continue;
    }

    log(`${C.b(basename(input))}  ${kb(before)} → ${kb(after)}  ${C.g(pct(before, after) + ' smaller')}`);
    log(`  gzip ${kb(gzipSync(srcText, { level: 9 }).length)} → ${kb(gzipSync(outText, { level: 9 }).length)}` +
        `   brotli ${kb(brotliCompressSync(srcText, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length)}` +
        ` → ${kb(brotliCompressSync(outText, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length)}`);
    log(`  ${stats.keyframesBefore.toLocaleString()} keyframes → ${stats.keyframesAfter.toLocaleString()}` +
        `  ·  ${stats.layersRetimed} layers retimed  ·  ${stats.propsMadeStatic} props made static` +
        (stats.layersRemoved ? `  ·  ${stats.layersRemoved} dead layers removed` : ''));
    if (resizeStats) log(`  resized to ${optimized.w}x${optimized.h} (x${resizeStats.factor.toFixed(4)}) via ${resizeStats.rootLayersScaled} root layer transform(s); geometry untouched`);
    if (mergeStats) log(`  merged ${mergeStats.groupsMerged} duplicate-artwork groups, removing ${mergeStats.layersRemoved} layers` + (mergeStats.cyclesBroken ? `  (${mergeStats.cyclesBroken} kept apart to preserve paint order)` : ''));
    if (dedupStats) log(`  ${dedupStats.layersRewritten} layers → ${dedupStats.assetsCreated} shared precomps`);

    if (ver) {
      const w = ver.worst;
      if (ver.identical) {
        log(`  ${C.g('✓ verified identical')} — ${ver.frames} frames, canvas @${opts.size}px, 0/${w?.totalPixels.toLocaleString()} px differ` +
            (ver.svg ? `; svg renderer ${ver.svg.frames} frames hash-identical` : ''));
      } else {
        log(`  ${C.r('✗ VERIFICATION FAILED — nothing written')}`);
        if (ver.frameCountMismatch) log(`    frame count changed: ${ver.totalFrames?.join(' vs ')}`);
        if (ver.framesDiffering) log(`    ${ver.framesDiffering}/${ver.frames} frames differ; worst frame ${w.frame}: ${w.diffPixels} px, max channel delta ${w.maxChannelDiff}`);
        if (ver.svg?.differing?.length) log(`    svg renderer differs on frames ${ver.svg.differing.slice(0, 10).join(',')}`);
        log(`    ${C.dim('Re-run with --no-verify to write anyway, or --tolerance N if this is expected (e.g. --precision).')}`);
      }
    } else if (opts.verify === false) {
      log(`  ${C.y('unverified')} (--no-verify)`);
    }

    if (opts.bench && ok) {
      const [a, b] = await benchmark([source, JSON.parse(outText)]);
      log(`  playback: parse ${a.parseMs.toFixed(1)}→${b.parseMs.toFixed(1)}ms · build ${a.buildMs.toFixed(0)}→${b.buildMs.toFixed(0)}ms` +
          ` · render ${a.renderMsPerFrame.toFixed(2)}→${b.renderMsPerFrame.toFixed(2)}ms/frame` +
          ` ${C.g(`(${(a.renderMsPerFrame / b.renderMsPerFrame).toFixed(1)}x)`)}`);
    }
    log(ok ? `  ${C.dim('written to')} ${target}` : '');
  }
  return failed ? 2 : 0;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.inputs?.length) { console.log(HELP); process.exit(opts.help ? 0 : 1); }
const log = opts.quiet ? () => {} : (s) => console.log(s);
try {
  if (opts.cmd === 'analyze') { await runAnalyze(opts, log); process.exit(0); }
  if (opts.cmd === 'bench') { await runBench(opts, log); process.exit(0); }
  process.exit(await runOptimize(opts, log));
} catch (e) {
  console.error(C.r(`error: ${e.message}`));
  process.exit(1);
}
