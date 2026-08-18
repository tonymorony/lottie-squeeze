/**
 * Core Lottie optimizer. Zero dependencies, pure functions, no I/O.
 *
 * Every transform in here is defined to be a no-op for the renderer. The reasoning
 * for each is written next to it, because that reasoning is the whole product: an
 * "optimizer" that guesses is just a corrupter with a good compression ratio.
 *
 * Things deliberately NOT done, learned the hard way:
 *   - `sr` and `st` are never dropped even though 1 and 0 look like defaults.
 *     lottie-web computes each layer's local time as `frame / sr - st`; with the
 *     keys missing that is NaN and the whole animation renders blank.
 *   - Coordinates are never rounded unless you opt in with `precision`. Rounding
 *     3 decimals to 2 moves edges by 0.005px, which is invisible to a human but
 *     changes anti-aliasing on tens of thousands of pixels per frame.
 *   - Layers that anything is parented to, and layers used as track mattes, are
 *     never re-timed. Their lifetime is load-bearing for other layers.
 */

const stable = (v) => JSON.stringify(v, (k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.keys(val).sort().reduce((o, kk) => (o[kk] = val[kk], o), {})
    : val);

const eq = (a, b) => stable(a) === stable(b);

/** An animated property: {a:1, k:[{t,s,...}, ...]}. */
export function isAnimated(p) {
  return p && typeof p === 'object' && p.a === 1 && Array.isArray(p.k)
    && p.k.length > 0 && p.k[0] && typeof p.k[0] === 'object' && !Array.isArray(p.k[0]);
}

/**
 * Drop keyframe i when keyframe i-1 is a hold with the same value.
 * With h===1 the value is constant across [t(i-1), t(i)), so an identical `s`
 * at t(i) only extends that same segment — it carries no information.
 */
export function collapseHolds(kfs) {
  const out = [kfs[0]];
  for (let i = 1; i < kfs.length; i++) {
    const k = kfs[i], prev = out[out.length - 1];
    if (prev.h === 1 && 's' in k && 's' in prev && eq(k.s, prev.s)) continue;
    out.push(k);
  }
  return out;
}

/**
 * Drop keyframes that can never be sampled, given the layer is only live on
 * [ip, op). The last keyframe at/before `ip` is always kept: it defines the
 * value at ip. At the tail, the keyframe at/after `op` is kept only when the
 * segment running into op interpolates — a hold segment already knows its
 * value, so its closing keyframe is pure weight.
 */
export function trimToLife(kfs, ip, op) {
  if (kfs.length < 2) return kfs;
  let start = 0, end = kfs.length - 1;
  for (let i = 0; i < kfs.length; i++) {
    if ((kfs[i].t ?? 0) <= ip) start = i; else break;
  }
  for (let i = 0; i < kfs.length; i++) {
    if ((kfs[i].t ?? 0) >= op) {
      end = i > 0 && kfs[i - 1].h === 1 ? i - 1 : i;
      break;
    }
  }
  return kfs.slice(start, Math.max(start, end) + 1);
}

/** True when the track holds one single value for its whole length. */
function constantValue(kfs) {
  const vals = kfs.filter((k) => 's' in k).map((k) => k.s);
  if (vals.length === 0) return null;
  return vals.every((v) => eq(v, vals[0])) ? vals[0] : null;
}

/**
 * Segments of an opacity track flagged by whether opacity is identically zero.
 * A segment is all-zero when it holds 0, or when it interpolates 0 -> 0 (any
 * easing between two zeros is still zero, so no bezier evaluation is needed).
 */
function opacitySegments(kfs) {
  const segs = [];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (!('s' in a)) continue;
    const av = a.s[0];
    const bv = 's' in b ? b.s[0] : av;
    segs.push({ t0: a.t ?? 0, t1: b.t ?? 0, zero: a.h === 1 ? av === 0 : (av === 0 && bv === 0) });
  }
  const last = kfs[kfs.length - 1];
  const lastVal = 's' in last ? last.s[0] : (kfs.filter((k) => 's' in k).pop()?.s?.[0] ?? 0);
  segs.push({ t0: last.t ?? 0, t1: Infinity, zero: lastVal === 0 });
  return segs;
}

/** Shape-item keys whose value equals the format default and can be omitted. */
const SHAPE_DEFAULTS = [['hd', false], ['bm', 0]];
/** Layer keys whose value equals the format default and can be omitted. */
const LAYER_DEFAULTS = [['hasMask', false], ['hd', false], ['ddd', 0], ['bm', 0], ['ao', 0]];

function stripShapeDefaults(node, dropNames) {
  if (Array.isArray(node)) { node.forEach((n) => stripShapeDefaults(n, dropNames)); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.ty === 'string') {
    if (dropNames) { delete node.nm; delete node.mn; }
    for (const [k, d] of SHAPE_DEFAULTS) if (k in node && node[k] === d) delete node[k];
  }
  for (const v of Object.values(node)) stripShapeDefaults(v, dropNames);
}

/** Keys whose numbers are timing or identity, never geometry — never rounded. */
const NEVER_ROUND = new Set(['t', 'ip', 'op', 'st', 'sr', 'fr', 'w', 'h', 'ind', 'parent', 'ty', 'bm', 'a', 'ddd', 'ao']);

function roundTree(node, digits, key = null, inEase = false) {
  if (typeof node === 'number') {
    if (!Number.isFinite(node) || Number.isInteger(node)) return node;
    if (inEase || (key && NEVER_ROUND.has(key))) return node;
    const r = Number(node.toFixed(digits));
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(node)) return node.map((n) => roundTree(n, digits, key, inEase));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      // {x,y} under `i`/`o` is a timing bezier, not a coordinate: leave it alone.
      const ease = inEase || ((k === 'i' || k === 'o') && v && typeof v === 'object'
        && !Array.isArray(v) && Object.keys(v).every((kk) => kk === 'x' || kk === 'y'));
      out[k] = roundTree(v, digits, k, ease);
    }
    return out;
  }
  return node;
}

/**
 * A mask that covers the whole layer, adds, is not inverted and is fully opaque
 * changes nothing — but every renderer still pays for it, and on iOS/Core
 * Animation a mask forces offscreen rendering. Figma's exporter emits exactly
 * this on the root precomp, which already clips to its own w/h.
 *
 * Only claimed when the layer has real bounds (precomp/solid) and the path is a
 * rectangle covering them: bbox must contain the bounds, and the shoelace area
 * must match the bbox, so an L-shape or a cut-out is never mistaken for full
 * coverage.
 */
function dropNoOpMasks(l, stats) {
  const ms = l.masksProperties;
  if (!Array.isArray(ms) || ms.length !== 1) return;
  const m = ms[0];
  if (m.mode !== 'a' || m.inv) return;
  if (!(m.o && m.o.a === 0 && m.o.k === 100)) return;
  if (!m.pt || m.pt.a !== 0) return;
  const path = m.pt.k;
  if (!path || !Array.isArray(path.v) || path.v.length > 8 || path.c === false) return;
  const { w, h } = l;
  if (!(w > 0 && h > 0)) return;
  const xs = path.v.map((p) => p[0]), ys = path.v.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  if (!(x0 <= 0 && y0 <= 0 && x1 >= w && y1 >= h)) return;
  let area = 0;
  for (let i = 0; i < path.v.length; i++) {
    const a = path.v[i], b = path.v[(i + 1) % path.v.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const bbox = (x1 - x0) * (y1 - y0);
  if (bbox <= 0 || Math.abs(area) / 2 < bbox * 0.99) return;
  delete l.masksProperties;
  delete l.hasMask;
  stats.masksDropped++;
}

const allComps = (doc) => [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))];

export const DEFAULTS = {
  collapse: true,      // fold redundant hold keyframes
  trim: true,          // drop keyframes outside each layer's lifetime
  retime: true,        // convert leading/trailing zero opacity into ip/op
  holdEasing: true,    // strip i/o beziers from hold keyframes
  defaults: true,      // strip keys equal to the format default
  noOpMasks: true,     // drop masks that cover the whole layer and change nothing
  dropNames: false,    // strip nm/mn (safe, but hurts debuggability)
  dropDead: true,      // remove layers whose opacity is zero for their whole life
  precision: null,     // round geometry to N decimals — opt-in, not pixel-exact
};

export function optimize(doc, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const stats = {
    keyframesBefore: 0, keyframesAfter: 0, layersRetimed: 0,
    propsMadeStatic: 0, layersRemoved: 0, layersTotal: 0, masksDropped: 0,
  };

  const walk = (node, ip, op) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, ip, op)); return; }
    if (!node || typeof node !== 'object') return;

    if (isAnimated(node)) {
      stats.keyframesBefore += node.k.length;
      let k = node.k;
      if (opt.collapse) k = collapseHolds(k);
      if (opt.trim) k = trimToLife(k, ip, op);
      if (opt.collapse) k = collapseHolds(k);

      const constant = constantValue(k);
      if (constant !== null && (k.length === 1 || opt.collapse)) {
        // One value for the whole track is a static property by definition.
        // Length-1 arrays become scalars: lottie-web picks ValueProperty vs
        // MultiDimensionalProperty on `typeof k === 'number'`, and a rotation
        // left as [0] would be applied as an array.
        node.a = 0;
        node.k = Array.isArray(constant) && constant.length === 1 ? constant[0] : constant;
        stats.propsMadeStatic++;
        return;
      }
      if (opt.holdEasing) {
        for (const kf of k) if (kf.h === 1) { delete kf.i; delete kf.o; }
      }
      node.k = k;
      stats.keyframesAfter += k.length;
      return;
    }
    for (const v of Object.values(node)) walk(v, ip, op);
  };

  for (const comp of allComps(doc)) {
    const parentInds = new Set(comp.layers.filter((l) => 'parent' in l).map((l) => l.parent));
    const kept = [];
    stats.layersTotal += comp.layers.length;

    for (const l of comp.layers) {
      let ip = l.ip ?? 0, op = l.op ?? 0;

      // Re-timing is only safe when nothing else depends on this layer being
      // alive: no children hanging off it, and it is not a track matte source
      // (`td`), whose visibility masks the layer below it.
      const loadBearing = parentInds.has(l.ind) || l.td !== undefined;

      if (opt.retime && !loadBearing && l.ks && isAnimated(l.ks.o)) {
        const segs = opacitySegments(l.ks.o.k);
        const live = segs.filter((s) => !s.zero);

        if (live.length === 0 && opt.dropDead) {
          stats.layersRemoved++;
          continue;                              // never visible for a single frame
        }
        if (live.length > 0) {
          const newIp = Math.max(ip, live[0].t0);
          const newOp = Math.min(op, live[live.length - 1].t1);
          if (newOp > newIp && (newIp > ip || newOp < op)) {
            l.ip = ip = newIp;
            l.op = op = newOp;
            stats.layersRetimed++;
          }
        }
      }

      if (l.ks) walk(l.ks, ip, op);
      for (const key of ['shapes', 'masksProperties', 'ef', 't']) {
        if (l[key]) walk(l[key], ip, op);
      }
      // after the walk: a frame-baked mask arrives as hundreds of identical hold
      // keyframes and only becomes recognisably static once those are collapsed
      if (opt.noOpMasks) dropNoOpMasks(l, stats);

      if (opt.defaults) {
        delete l.ln;                             // expression-only layer id
        if (opt.dropNames) delete l.nm;
        if (Array.isArray(l.ef) && l.ef.length === 0) delete l.ef;
        for (const [k, d] of LAYER_DEFAULTS) if (k in l && l[k] === d) delete l[k];
        if (l.shapes) stripShapeDefaults(l.shapes, opt.dropNames);
      }
      kept.push(l);
    }
    comp.layers = kept;
  }

  return { doc: opt.precision == null ? doc : roundTree(doc, opt.precision), stats };
}
