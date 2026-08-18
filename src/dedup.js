/**
 * Opt-in: hoist repeated shape blobs into shared precomp assets.
 *
 * Lottie has no way to reference a shape from two layers, so the only available
 * indirection is a precomp. That has two measured costs, which is why this is
 * off by default — read the README table before reaching for it:
 *   - a precomp composites through an intermediate buffer, so anti-aliasing on
 *     shape edges differs slightly from the source (visually identical, not
 *     pixel-identical), and
 *   - it was ~2x slower per frame and ~2.5x slower to build in lottie-web.
 *
 * A precomp layer clips its content to [0,w] x [0,h] in its own local space, so
 * each hoisted blob is translated by d into positive coordinates and the
 * referencing layer's anchor point is shifted by the same d. That cancels exactly:
 *     T(p)·R·S·T(-(a+d))·(x+d)  ==  T(p)·R·S·T(-a)·x
 */

const allComps = (doc) => [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))];

/** Bounding box over the control polygon, which bounds the bezier curves it defines. */
function bbox(shapes) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], stroke = 0;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.ty === 'st') {
      let w = n.w?.k;
      if (Array.isArray(w) && w[0] && typeof w[0] === 'object') {
        w = Math.max(...w.filter((k) => 's' in k).map((k) => k.s[0]));
      }
      if (typeof w === 'number') stroke = Math.max(stroke, w);
    }
    if (Array.isArray(n.v)) {
      for (const group of ['v', 'i', 'o']) {
        const pts = n[group] ?? [];
        for (let j = 0; j < pts.length; j++) {
          // i/o tangents are stored relative to their matching vertex
          const base = group === 'v' ? [0, 0] : (n.v[j] ?? [0, 0]);
          const x = pts[j][0] + base[0], y = pts[j][1] + base[1];
          lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
          hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
        }
      }
    }
    Object.values(n).forEach(walk);
  };
  walk(shapes);
  if (!Number.isFinite(lo[0])) return null;
  const m = stroke * 4 + 32;                    // generous: miter joins overshoot w/2
  return [lo[0] - m, lo[1] - m, hi[0] + m, hi[1] + m];
}

function shiftVertices(n, dx, dy) {
  if (Array.isArray(n)) return n.forEach((x) => shiftVertices(x, dx, dy));
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n.v)) n.v = n.v.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)]);
  for (const [k, v] of Object.entries(n)) if (k !== 'v') shiftVertices(v, dx, dy);
}

function shiftAnchor(a, dx, dy) {
  if (a.a === 1) {
    for (const k of a.k) if ('s' in k) k.s = [k.s[0] + dx, k.s[1] + dy, ...k.s.slice(2)];
  } else {
    a.k = [a.k[0] + dx, a.k[1] + dy, ...a.k.slice(2)];
  }
}

export function dedupeShapes(doc, { minUses = 2 } = {}) {
  const stats = { assetsCreated: 0, layersRewritten: 0 };
  doc.assets ??= [];
  const compOp = doc.op ?? 0;

  for (const comp of allComps(doc)) {
    const groups = new Map();
    for (const l of comp.layers) {
      if (l.ty !== 4 || !l.shapes?.length) continue;
      const blob = JSON.stringify(l.shapes);
      if (!groups.has(blob)) groups.set(blob, []);
      groups.get(blob).push(l);
    }
    for (const [blob, members] of groups) {
      if (members.length < minUses) continue;
      const shapes = JSON.parse(blob);
      const bb = bbox(shapes);
      if (!bb) continue;
      const [dx, dy] = [-bb[0], -bb[1]];
      shiftVertices(shapes, dx, dy);
      const id = `sq${stats.assetsCreated++}`;
      doc.assets.push({ id, layers: [{
        ty: 4, ind: 1, ip: 0, op: compOp + 1, sr: 1, st: 0, bm: 0, ao: 0, ddd: 0, shapes,
        ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      }] });
      for (const l of members) {
        delete l.shapes;
        l.ty = 0;
        l.refId = id;
        l.w = Math.ceil(bb[2] - bb[0]);
        l.h = Math.ceil(bb[3] - bb[1]);
        shiftAnchor(l.ks.a, dx, dy);
        stats.layersRewritten++;
      }
    }
  }
  return { doc, stats };
}
