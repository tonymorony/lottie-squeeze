# lottie-squeeze

Optimizes Lottie JSON, then **proves the result**: it renders the source and the
output frame by frame in real Chrome with real lottie-web and compares pixels. If
a single pixel moved, nothing is written and the exit code is `2`.

That gate is the point. Reasoning about the Lottie spec is not enough — two
optimizations that look obviously correct on paper are wrong, and only the pixel
diff caught them (see [Rejected optimizations](#rejected-optimizations)).

## Install

```bash
npm install                 # or: npm i -g .
```

Verification drives a Chrome you already have (via `puppeteer-core`, no 150 MB
Chromium download). Set `LOTTIE_SQUEEZE_CHROME` if it lives somewhere unusual.

## Use

```bash
lottie-squeeze animation.json                  # -> animation.min.json, verified
lottie-squeeze analyze animation.json          # where the bytes are, and why
lottie-squeeze src/*.json -o dist/ --bench     # batch, with playback timings
lottie-squeeze animation.json --in-place       # overwrite, only if verification passes
```

| flag | meaning |
| --- | --- |
| `-o, --out <path>` | output file, or directory when given several inputs |
| `--in-place` | overwrite the input — still gated on verification |
| `--no-verify` | skip the browser check; you are on your own |
| `--size <px>` | verification render size, default `600` |
| `--renderers canvas,svg` | which lottie-web renderers to check, default both |
| `--tolerance <n>` | permit up to n differing pixels per frame, default `0` |
| `--strip-names` | drop `nm`/`mn`; safe, costs debuggability |
| `--precision <n>` | round geometry to n decimals — **not pixel-exact** |
| `--merge` | merge duplicate artwork into one layer per (shape, position) |
| `--resize <WxH>` | change declared composition size — **does not reduce file size** |
| `--dedup` | hoist duplicated paths into shared precomps — **opt-in, see below** |
| `--bench` | parse / build / per-frame render timings, before vs after |
| `--json` | machine-readable output |

Exit codes: `0` ok · `1` usage or IO error · `2` verification failed, nothing written.

## Measured on a real file

A 300×300 loading animation exported by the LottieFiles Figma plugin:

| | before | after |
| --- | --- | --- |
| raw JSON | 4,998,383 B | **2,088,533 B** (−57%) |
| brotli -q11 | 92.4 KB | 71.3 KB |
| keyframes | 35,761 | 1,251 |
| `JSON.parse` | ~67 ms | ~17 ms |
| render / frame | ~5.3 ms | **~1.4 ms** (3.9×) |

Verified identical: 39/39 frames, 0 of 360,000 pixels differing per frame on the
canvas renderer, and every SVG-renderer screenshot hash-identical.

The speedup is the part people miss. Figma-style exporters bake a frame-by-frame
timeline: every shape layer exists for the whole animation and is toggled with
hold-keyframed opacity. The player therefore evaluates thousands of layers per
frame just to draw them at opacity 0. Turning that gate into `ip`/`op` lets the
player skip them outright.

## What it does

Each transform is a no-op for the renderer, by construction:

1. **Hold-keyframe collapse.** With `h:1` the value is constant across
   `[t(i-1), t(i))`, so an identical `s` at `t(i)` only extends the same segment.
2. **Lifetime trim.** Keyframes outside `[ip, op)` are never sampled. The last one
   at/before `ip` is kept because it defines the value at `ip`; the one at/after
   `op` is kept only when the segment running into `op` interpolates — a hold
   segment already knows its value.
3. **Opacity → in/out point.** A layer held at opacity 0 is exactly a layer that
   is not live. Leading and trailing zero-opacity regions become `ip`/`op`, and a
   layer that is invisible for its whole life is removed.
4. **Hold easing strip.** `i`/`o` bezier handles are ignored when `h:1`.
5. **Default strip.** Keys equal to the format default (`hasMask:false`, `hd:false`,
   `bm:0`, `ao:0`, `ddd:0`, empty `ef`) and `ln`, which only exists for expressions.

Single-element value arrays collapse to scalars, because lottie-web picks
`ValueProperty` vs `MultiDimensionalProperty` on `typeof k === 'number'` — a
rotation left as `[0]` gets applied as an array.

## Duplicated paths, and why they usually cannot be merged

Frame-baked exports re-emit the same path once per drawing. On the test file that
was 1 MB of byte-identical artwork: 2,858 shape layers holding only 698 distinct
(shape, world position) pairs. Collapsing each pair to one layer with the union of
its lifetimes would cut the file to ~700 KB, losslessly and with no precomps.

`--merge` does exactly that, and it is gated on paint order. Layers paint in list
order, so merging moves artwork within the stack; that is only sound if some
single global order still satisfies every "A paints before B" pair that held
between layers visible at the same time and whose artwork can overlap. The tool
builds that constraint graph and accepts merges greedily, keeping each only if the
order still resolves.

**On character animation it usually finds nothing, and that is the correct
answer.** On the test file only **10 of 4,967** candidate merges were order-safe.
A walk cycle legitimately swaps the depth of overlapping parts between drawings,
so the same artwork at the same position really does sit at different depths at
different times. Merging anyway renders visibly wrong — 121,000 differing pixels,
confirmed by rendering it.

Two refinements were needed to get even that far, both worth knowing if you extend
this:

- Layers that paint nothing (`shapes: []` — the per-frame parent groups) must
  impose *no* ordering constraint. Treating them as "extent unknown, assume it
  overlaps" made 305 pure transform nodes into universal barriers that chained
  every group into one cycle.
- Bounding boxes are a hopeless overlap proxy on a character: every limb's box
  intersects every other's. `src/raster.js` scanline-fills each layer's flattened
  paths into a dilated coverage bitmask, which cut the constraint edges by 24%.

Frame decimation was measured too, and does not help: layers already span several
drawings, so dropping sample times removed 11 KB of 2.09 MB.

## Resizing does not compress

`--resize 100x100` is there because some pipelines read `w`/`h` as the real size,
not because it saves anything. Lottie is vector: `w`/`h` are a viewBox, every
player already scales to whatever box you hand it, and a file's weight is vertex
count, not canvas size.

Resizing by rewriting coordinates actively costs bytes. Measured on the 300x300
test file, dividing every number by 3:

| | vs original |
| --- | --- |
| coordinates /3, rounded to 2dp | **+34.7 KB** |
| coordinates /3, rounded to 3dp | **+182.4 KB** |

`127.15` becomes `42.38` — no shorter — while exact values like `300` turn into
repeating decimals. So `--resize` leaves geometry exactly as authored and pushes
the factor onto the root layer transforms instead. On the test file that changed
the output by **+26 bytes** (0.001%) and stayed pixel-identical across all 39
frames on both renderers.

To simply *display* an animation smaller, change nothing — size the container.

## Safety rules

Wired into the code, not left to the caller:

- **`sr` and `st` are never dropped.** They look like defaults (`1` and `0`), but
  lottie-web computes each layer's local time as `frame / sr - st`. With the keys
  missing that is `NaN` and the whole animation renders blank. This cost an hour.
- **Layers that anything is parented to are never retimed.** Their lifetime is
  load-bearing for their children.
- **Track matte sources (`td`) are never retimed.** Their visibility masks the
  layer below.
- **Geometry precision is preserved** unless you explicitly ask otherwise.
- **Non-uniform resizes are refused** rather than silently distorting the artwork.
- **Parented layers are skipped when resizing**, since they already inherit the
  factor through the hierarchy; scaling them too would apply it twice.

## Rejected optimizations

Both of these shrink the file and both are wrong by default. The tool can still do
them; it just refuses to pretend they are free.

**`--precision 2`** — saves ~15 KB. Rounding 3 decimals to 2 moves edges by
0.005px, invisible to a human but it changes anti-aliasing on ~105,000 pixels per
frame. Verification fails with a max channel delta of 42.

**`--dedup`** — Lottie cannot reference a shape from two layers, so the only
indirection is a precomp. On the test file that hoisted 1 MB of duplicated paths:

| | default | `--dedup` |
| --- | --- | --- |
| raw JSON | 2.09 MB | **1.24 MB** |
| gzip -9 | 360.4 KB | **152.5 KB** |
| brotli -q11 | **71.3 KB** | 82.4 KB |
| parse | 27.8 ms | **11.2 ms** |
| build | **477 ms** | 1040 ms |
| render / frame | **1.7 ms** | 3.2 ms |
| pixel-identical | yes | no — 2,733 px of 360,000, on shape edges |

The tradeoff is genuinely two-sided, so pick by how you ship. A precomp composites
through an intermediate buffer: that costs runtime and perturbs edge
anti-aliasing. Brotli's window already captures the long-range duplication, so
dedup is *worse* over the wire under brotli — but far better under gzip, whose
32 KB window cannot see repeats that far apart. Reach for it when you serve gzip,
or when raw parsed size is what you are paying for, and pass `--tolerance`
knowingly.

## API

```js
import { optimize, analyze, verify, benchmark, dedupeShapes } from 'lottie-squeeze';

const { doc, stats } = optimize(structuredClone(source));
const result = await verify(source, doc, { size: 600, renderers: ['canvas', 'svg'] });
if (!result.identical) throw new Error(`differs on ${result.framesDiffering} frames`);
```

`optimize(doc, options)` mutates and returns `doc`; clone first if you need the
original. Options match the flags above (`dropNames`, `precision`, `dropDead`,
`retime`, `collapse`, `trim`, `holdEasing`, `defaults`).

## Limits

- Verification needs a local Chrome; without one the run continues **unverified**
  and says so.
- Pixel-equality is checked against lottie-web. Other players (lottie-ios,
  lottie-android, Skottie, Rive) share the format but not the renderer. The default
  transforms are spec-level, not renderer-level, so they should hold — but if you
  ship to native, spot-check there too.
- Image assets are passed through untouched. If your file is mostly embedded
  base64 PNGs, this tool has little to work with.

```bash
npm test        # 18 tests, no browser needed
```

## License

MIT © Anton Lysakov — see [LICENSE](LICENSE).
