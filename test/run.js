import assert from 'node:assert/strict';
import { optimize, collapseHolds, trimToLife } from '../src/optimize.js';
import { dedupeShapes } from '../src/dedup.js';
import { analyze } from '../src/analyze.js';
import { resize } from '../src/resize.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const hold = (t, v) => ({ h: 1, i: { x: 0.833, y: 0.833 }, o: { x: 0.167, y: 0.167 }, s: [v], t });
const ease = (t, v) => ({ i: { x: 0.833, y: 0.833 }, o: { x: 0.167, y: 0.167 }, s: [v], t });

/** A layer gated on/off by hold-keyframed opacity, the shape Figma exports. */
const gatedLayer = (ind, on, off, extra = {}) => ({
  ty: 4, ind, ip: 0, op: 60, sr: 1, st: 0, bm: 0, ao: 0, ddd: 0, nm: `L${ind}`, ln: `L${ind}`,
  hasMask: false, hd: false, ef: [],
  ks: {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [50, 50] }, s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 1, k: [hold(0, 0), hold(on, 100), hold(off, 0), hold(50, 0), { s: [0], t: 60 }] },
  },
  shapes: [{ ty: 'sh', nm: 'p', hd: false, ks: { a: 0, k: { c: true, v: [[0, 0], [10, 0], [10, 10]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] } } },
           { ty: 'fl', nm: 'f', hd: false, bm: 0, c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }],
  ...extra,
});

const doc = (layers) => ({ v: '5.7.0', fr: 60, ip: 0, op: 60, w: 100, h: 100, nm: 't', assets: [], layers });

console.log('\nkeyframe primitives');
test('collapseHolds folds repeated hold values', () => {
  const k = collapseHolds([hold(0, 0), hold(1, 0), hold(2, 0), hold(3, 100)]);
  assert.equal(k.length, 2);
  assert.deepEqual(k.map((x) => x.t), [0, 3]);
});
test('collapseHolds keeps a repeat after a non-hold keyframe', () => {
  assert.equal(collapseHolds([ease(0, 0), ease(1, 0)]).length, 2);
});
test('trimToLife drops the closing keyframe of a hold segment', () => {
  const k = trimToLife([hold(0, 100), hold(10, 0)], 0, 10);
  assert.deepEqual(k.map((x) => x.t), [0]);
});
test('trimToLife keeps the closing keyframe when the segment interpolates', () => {
  const k = trimToLife([ease(0, 100), ease(10, 0)], 0, 10);
  assert.deepEqual(k.map((x) => x.t), [0, 10]);
});
test('trimToLife keeps the last keyframe at or before ip', () => {
  const k = trimToLife([hold(0, 0), hold(5, 100), hold(20, 0)], 5, 20);
  assert.equal(k[0].t, 5);
});

console.log('\nretiming');
test('opacity-gated layer becomes ip/op with static opacity', () => {
  const { doc: d, stats } = optimize(doc([gatedLayer(1, 10, 20)]));
  const l = d.layers[0];
  assert.equal(l.ip, 10);
  assert.equal(l.op, 20);
  assert.equal(l.ks.o.a, 0);
  assert.equal(l.ks.o.k, 100, 'single-element value must collapse to a scalar, not [100]');
  assert.equal(stats.layersRetimed, 1);
});
test('a layer with children is never retimed', () => {
  const { doc: d } = optimize(doc([gatedLayer(1, 10, 20), { ...gatedLayer(2, 10, 20), parent: 1 }]));
  assert.equal(d.layers[0].ip, 0, 'parent kept its lifetime');
  assert.equal(d.layers[1].ip, 10, 'child still retimed');
});
test('a track matte source is never retimed', () => {
  const { doc: d } = optimize(doc([gatedLayer(1, 10, 20, { td: 1 }), gatedLayer(2, 10, 20, { tt: 1 })]));
  assert.equal(d.layers[0].ip, 0);
});
test('a never-visible layer is dropped', () => {
  const l = gatedLayer(1, 10, 20);
  l.ks.o.k = [hold(0, 0), { s: [0], t: 60 }];
  const { doc: d, stats } = optimize(doc([l]));
  assert.equal(d.layers.length, 0);
  assert.equal(stats.layersRemoved, 1);
});
test('dropDead:false keeps the invisible layer', () => {
  const l = gatedLayer(1, 10, 20);
  l.ks.o.k = [hold(0, 0), { s: [0], t: 60 }];
  assert.equal(optimize(doc([l]), { dropDead: false }).doc.layers.length, 1);
});

console.log('\nsafety invariants');
test('sr and st survive (dropping them makes lottie-web compute NaN)', () => {
  const l = optimize(doc([gatedLayer(1, 10, 20)])).doc.layers[0];
  assert.equal(l.sr, 1);
  assert.equal(l.st, 0);
});
test('format defaults are stripped but names are kept by default', () => {
  const l = optimize(doc([gatedLayer(1, 10, 20)])).doc.layers[0];
  assert.equal('hasMask' in l, false);
  assert.equal('hd' in l, false);
  assert.equal('ef' in l, false);
  assert.equal('ln' in l, false, 'ln is expression-only');
  assert.equal(l.nm, 'L1', 'nm kept unless --strip-names');
});
test('--strip-names reaches shape items too', () => {
  const l = optimize(doc([gatedLayer(1, 10, 20)]), { dropNames: true }).doc.layers[0];
  assert.equal('nm' in l, false);
  assert.equal('nm' in l.shapes[0], false);
});
test('precision leaves keyframe times and easing beziers alone', () => {
  const l = gatedLayer(1, 10, 20);
  l.ks.p = { a: 1, k: [{ ...ease(0.333, 0), s: [1.23456, 2.34567] }, { s: [3.5, 4.5], t: 33.333 }] };
  const p = optimize(doc([l]), { precision: 2 }).doc.layers[0].ks.p;
  assert.equal(p.k[0].t, 0.333, 'keyframe time must not move');
  assert.equal(p.k[0].i.x, 0.833, 'easing handle must not move');
  assert.deepEqual(p.k[0].s, [1.23, 2.35]);
});
test('optimize is idempotent', () => {
  const once = optimize(doc([gatedLayer(1, 10, 20)])).doc;
  const twice = optimize(JSON.parse(JSON.stringify(once))).doc;
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

console.log('\ndedup + analyze');
test('dedup hoists a repeated blob and compensates the anchor', () => {
  const a = gatedLayer(1, 10, 20), b = gatedLayer(2, 30, 40);
  const { doc: d, stats } = dedupeShapes(doc([a, b]));
  assert.equal(stats.assetsCreated, 1);
  assert.equal(stats.layersRewritten, 2);
  assert.equal(d.layers[0].ty, 0);
  assert.equal(d.layers[0].refId, d.layers[1].refId);
  const asset = d.assets.find((x) => x.id === d.layers[0].refId);
  const dx = asset.layers[0].shapes[0].ks.k.v[0][0] - 0;      // vertex was shifted by dx
  assert.equal(d.layers[0].ks.a.k[0], dx, 'anchor shift must equal the vertex shift');
});
test('dedup leaves a shape used only once alone', () => {
  const { stats } = dedupeShapes(doc([gatedLayer(1, 10, 20)]));
  assert.equal(stats.assetsCreated, 0);
});
test('analyze counts redundant holds and retimable layers', () => {
  const a = analyze(doc([gatedLayer(1, 10, 20), gatedLayer(2, 30, 40)]));
  assert.ok(a.redundantHolds > 0);
  assert.equal(a.retimable, 2);
  assert.equal(a.distinctShapes, 1);
  assert.ok(a.duplicateShapeBytes > 0);
});

console.log('\nresize');
test('resize pushes the factor onto root layer transforms, not geometry', () => {
  const before = JSON.stringify(gatedLayer(1, 10, 20).shapes);
  const { doc: d, stats } = resize(doc([gatedLayer(1, 10, 20)]), 100, 100);
  assert.equal(d.w, 100);
  assert.equal(d.h, 100);
  assert.equal(stats.factor, 1);
  const { doc: d3 } = resize(doc([gatedLayer(1, 10, 20)]), 50, 50);
  const l = d3.layers[0];
  assert.deepEqual(l.ks.p.k, [25, 25], 'position scaled');
  assert.deepEqual(l.ks.s.k, [50, 50], 'scale percentage halved');
  assert.deepEqual(l.ks.a.k, [0, 0], 'anchor left alone');
  assert.equal(JSON.stringify(l.shapes), before, 'path coordinates untouched');
});
test('resize skips parented layers so the factor is not applied twice', () => {
  const { doc: d } = resize(doc([gatedLayer(1, 10, 20), { ...gatedLayer(2, 10, 20), parent: 1 }]), 50, 50);
  assert.deepEqual(d.layers[1].ks.s.k, [100, 100], 'child inherits from its parent');
});
test('resize scales spatial tangents on animated position', () => {
  const l = gatedLayer(1, 10, 20);
  l.ks.p = { a: 1, k: [{ t: 0, s: [10, 10], ti: [2, 2], to: [4, 4] }, { t: 30, s: [20, 20] }] };
  const { doc: d } = resize(doc([l]), 50, 50);
  assert.deepEqual(d.layers[0].ks.p.k[0].s, [5, 5]);
  assert.deepEqual(d.layers[0].ks.p.k[0].ti, [1, 1]);
  assert.deepEqual(d.layers[0].ks.p.k[0].to, [2, 2]);
});
test('non-uniform resize is refused rather than silently distorting', () => {
  assert.throws(() => resize(doc([gatedLayer(1, 10, 20)]), 100, 50), /non-uniform/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
