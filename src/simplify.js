/**
 * Bezier path simplification — the only genuinely lossy transform here.
 *
 * Removes a vertex when the two cubics meeting at it can be replaced by one cubic
 * that stays within `tolerance` composition units of the original. The
 * replacement is a least-squares refit (Graphics Gems' generateBezier) that keeps
 * the neighbours' tangent directions and solves for their magnitudes, rather than
 * just dropping the point and hoping — a naive drop rounds off corners badly at
 * the same vertex count.
 *
 * Error is measured as the largest distance from densely sampled points on the
 * original pair of curves to the refitted one, so `tolerance` is a real geometric
 * bound in the composition's own units, not a knob.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a); return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l]; };

const bezier = (P0, P1, P2, P3, t) => {
  const u = 1 - t;
  return [
    u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0],
    u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1],
  ];
};

/** Least-squares tangent magnitudes for a cubic through `pts` at parameters `u`. */
function refit(pts, u, P0, P3, t1, t2) {
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], v = 1 - t;
    const b0 = v * v * v, b1 = 3 * v * v * t, b2 = 3 * v * t * t, b3 = t * t * t;
    const a0 = mul(t1, b1), a1 = mul(t2, b2);
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    const tmp = sub(pts[i], add(mul(P0, b0 + b1), mul(P3, b2 + b3)));
    x0 += dot(a0, tmp); x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1, alpha2;
  if (Math.abs(det) < 1e-12) {
    const d = len(sub(P3, P0)) / 3;
    alpha1 = alpha2 = d;
  } else {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
    const d = len(sub(P3, P0)) / 3;
    if (!(alpha1 > 1e-6) || !(alpha2 > 1e-6)) { alpha1 = alpha2 = d; }
  }
  return [add(P0, mul(t1, alpha1)), add(P3, mul(t2, alpha2))];
}

const SAMPLES = 12;

/** Try dropping vertex k; returns {i, o, err} for the merged segment, or null. */
function trial(v, iT, oT, prev, k, next) {
  const P0 = v[prev], P3 = v[next];
  const seg = (a, b) => [v[a], add(v[a], oT[a]), add(v[b], iT[b]), v[b]];
  const [a0, a1, a2, a3] = seg(prev, k);
  const [b0, b1, b2, b3] = seg(k, next);
  const pts = [], u = [];
  for (let s = 1; s < SAMPLES; s++) pts.push(bezier(a0, a1, a2, a3, s / SAMPLES));
  pts.push(v[k]);
  for (let s = 1; s < SAMPLES; s++) pts.push(bezier(b0, b1, b2, b3, s / SAMPLES));
  // chord-length parameterisation
  let total = 0;
  const dists = [0];
  const all = [P0, ...pts, P3];
  for (let i = 1; i < all.length; i++) { total += len(sub(all[i], all[i - 1])); dists.push(total); }
  if (total < 1e-9) return null;
  for (let i = 1; i < all.length - 1; i++) u.push(dists[i] / total);

  const t1 = norm(oT[prev].some(Boolean) ? oT[prev] : sub(P3, P0));
  const t2 = norm(iT[next].some(Boolean) ? iT[next] : sub(P0, P3));
  const [C1, C2] = refit(pts, u, P0, P3, t1, t2);

  let err = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = bezier(P0, C1, C2, P3, u[i]);
    err = Math.max(err, len(sub(pts[i], q)));
  }
  return { o: sub(C1, P0), i: sub(C2, P3), err };
}

/** Simplify one Lottie path in place. Returns vertices removed. */
export function simplifyPath(path, tolerance) {
  const { c } = path;
  let v = path.v, iT = path.i, oT = path.o;
  if (!Array.isArray(v) || v.length < (c ? 4 : 3)) return 0;
  let removed = 0;

  for (;;) {
    const n = v.length;
    if (n <= (c ? 3 : 3)) break;
    let best = null;
    const lo = c ? 0 : 1, hi = c ? n : n - 1;
    for (let k = lo; k < hi; k++) {
      const prev = (k - 1 + n) % n, next = (k + 1) % n;
      const r = trial(v, iT, oT, prev, k, next);
      if (r && r.err <= tolerance && (!best || r.err < best.err)) best = { k, prev, next, ...r };
    }
    if (!best) break;
    oT[best.prev] = best.o;
    iT[best.next] = best.i;
    v = v.filter((_, idx) => idx !== best.k);
    iT = iT.filter((_, idx) => idx !== best.k);
    oT = oT.filter((_, idx) => idx !== best.k);
    removed++;
  }
  path.v = v; path.i = iT; path.o = oT;
  return removed;
}

const round = (pt, dp) => pt.map((n) => {
  const r = Number(n.toFixed(dp));
  return Object.is(r, -0) ? 0 : r;
});

export function simplifyShapes(doc, { tolerance = 0.5, precision = 2 } = {}) {
  const stats = { paths: 0, verticesBefore: 0, verticesAfter: 0 };
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.ty === 'sh' && n.ks) {
      const apply = (p) => {
        if (!p || !Array.isArray(p.v)) return;
        stats.paths++;
        stats.verticesBefore += p.v.length;
        if (tolerance > 0) simplifyPath(p, tolerance);
        if (precision != null) {
          p.v = p.v.map((x) => round(x, precision));
          p.i = p.i.map((x) => round(x, precision));
          p.o = p.o.map((x) => round(x, precision));
        }
        stats.verticesAfter += p.v.length;
      };
      if (n.ks.a === 0) apply(n.ks.k);
      else if (Array.isArray(n.ks.k)) for (const kf of n.ks.k) if (Array.isArray(kf.s)) kf.s.forEach(apply);
      return;
    }
    Object.values(n).forEach(walk);
  };
  for (const comp of [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))]) walk(comp.layers);
  return { doc, stats };
}
