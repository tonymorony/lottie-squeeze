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
| `--flatten` | collapse every layer into shape groups inside one layer |
| `--chunk <n>` | with `--flatten`, cap groups per layer |
| `--simplify <tol>` | simplify bezier paths within `tol` units — **lossy, reports the cost** |
| `--strict` | refuse anything not pixel-exact, even with lossy options |
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

## Cutting layer count

A Lottie shape layer holds any number of groups, each with its own transform and
opacity, and groups paint in array order exactly as layers paint in list order.
So `--flatten` turns a frame-baked export's thousands of layers into thousands of
groups inside **one** layer, composing each layer's whole parent chain into the
group's transform. Paint order is preserved *by construction*, which is why this
works where merging duplicate artwork does not.

On the test file: **2,859 layers → 2**, and it takes brotli from 55 KB to 43 KB,
because ~600 KB of per-layer `ks`/`ind`/`parent`/`ip`/`op` overhead collapses into
much smaller group transforms.

**It does not reduce how many paths get drawn.** 2,553 groups still produce 2,553
draw operations, and renderers that build a node per shape group (lottie-ios's
Core Animation engine among them) will not see their object count fall. What
flattening buys is JSON size, tree depth, and parse cost. Genuinely fewer draws
requires re-authoring the animation with fewer baked frames.

Flattening is skipped for any composition containing a mask, matte, effect, blend
mode, time remap, or a transform the group form cannot express, and those
compositions are reported as left alone. It is not pixel-exact: nesting the
transform one level deeper changes edge anti-aliasing slightly — 273 px of
360,000 on the test file, versus 2,787 for the simplification it is usually
paired with.

## Building a Lottie from SVG frames

When you have the source frames rather than a Figma/After Effects export — one SVG
per frame, as Illustrator writes them from artboards — `tools/svg-frames-to-lottie.py`
builds the animation directly, and it comes out an order of magnitude smaller and
faster than a plugin export of the same artwork.

```bash
python3 tools/svg-frames-to-lottie.py "frames/JB WALK *.svg" -o jb-walk.json --fps 30
node tools/verify-svg-frames.mjs jb-walk.json --size 400            # pixels vs the SVGs
```

It flattens each SVG to a paint-ordered list of shapes, then **deduplicates across
time**: the same shape (geometry and style, up to translation) at the same position
in several frames becomes one shape group whose opacity is a hold-keyframe track.
The global paint order is a topological sort of every frame's order, so z-order is
right by construction; groups that are paint-adjacent with the same style and the
same visibility are merged into one fill. Along the way it drops what a frame
export leaves behind — artwork from neighbouring artboards, copies hidden under an
opaque background — resolves circle clip-paths geometrically so the output has no
masks, and corrects sub-pixel artboard drift so the container does not jitter.

The output is one shape layer with fills, strokes and hold keyframes only: no
masks, mattes, precomps, effects or expressions — the subset every player renders
on its fast path, including lottie-ios's Core Animation engine.

Measured on an 18-frame walk cycle (2,553 SVG shapes, 670 KB of path data):

|  | raw | gzip | brotli | groups | paths drawn per frame |
| --- | --- | --- | --- | --- | --- |
| SVG frames | 838 KB | — | — | — | 117–174 |
| Lottie from SVG frames | 368 KB | 76 KB | 55 KB | 387 | 83–123 |

Every frame is compared against its SVG rendered in the same Chrome: on that file
the difference is the anti-aliasing of the outer circle edge (≈240 px of 91,000
inked at 400 px, nothing perceptible in the artwork).

Stdlib Python, no dependencies. Flags: `--fps`, `--precision`, `--crop` (tight
composition around the visible content), `--no-merge`, `--no-realign`. It handles
what Illustrator emits — `path` (M/L/H/V/C/S/Z), `circle`, `ellipse`, `rect`,
`line`, `polygon`, `polyline`, CSS classes, `transform`, per-element `opacity`, and
circle `clip-path`s — and stops with a clear message on anything else (gradients,
arbitrary clip shapes, `use`, text, images).

## Going lossy on purpose

When smallest-possible matters more than exactness, `--simplify <tol>` drops path
vertices whose removal moves the curve less than `tol` composition units. The
replacement is a least-squares refit that keeps the neighbours' tangent
directions and solves for their magnitudes, so `tol` is a real geometric bound,
not a knob — a naive vertex drop rounds off corners badly at the same count.

A lossy run is not held to pixel-identity; it is held to *reporting what it cost*.
The verifier still runs and prints how many pixels moved and how many did so
perceptibly (Δ>32). `--strict` puts the hard gate back.

Measured on the test file, `--simplify N --dedup` against the 300x300 source:

| tol | raw | gzip | brotli | px differing | perceptibly |
| --- | --- | --- | --- | --- | --- |
| — (lossless) | 2.09 MB | 360 KB | 71 KB | 0 | 0 |
| 0 (dedup only) | 1.24 MB | 153 KB | 82 KB | 1.3% | 21 |
| 0.5 | 1.14 MB | 126 KB | 67 KB | 5.0% | 1,268 |
| **1.0** | **1.11 MB** | **120 KB** | **63 KB** | 6.2% | 2,805 |
| 2.0 | 1.09 MB | 113 KB | 59 KB | 8.1% | 5,888 |

Past ~1.0 the curve flattens: tol 2.0 buys 22 KB more and visibly deforms eye
highlights and other small features under magnification. Percentages are of inked
pixels at 600x600, i.e. 4x the artwork's native scale, so they overstate what a
viewer at normal size sees — but compare levels honestly.

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
npm test        # 43 tests, no browser needed
npm run test:tools   # svg-frames-to-lottie self-test (python3)
```

## License

MIT © Anton Lysakov — see [LICENSE](LICENSE).
