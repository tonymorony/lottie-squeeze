/**
 * Collapse a composition's layers into shape groups inside a single layer.
 *
 * A Lottie shape layer holds any number of groups, each with its own transform
 * and opacity, and groups paint in array order exactly as layers paint in list
 * order. So a frame-baked export's thousands of layers can become thousands of
 * groups in one layer with paint order preserved *by construction* — no z-order
 * analysis needed, unlike merging duplicate artwork.
 *
 * Each layer's whole parent chain is composed into one world matrix and baked
 * into the group's `tr`, so the per-frame parent groups disappear entirely. The
 * layer's lifetime moves into the group's opacity, since a group has no ip/op.
 *
 * What this buys is structural: layer count, tree depth, and per-layer JSON
 * overhead. It does NOT reduce how many paths get drawn — that is set by the
 * artwork, and only re-authoring changes it.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const isStatic = (p) => !p || p.a !== 1;
const kOf = (p, d) => (p && 'k' in p ? p.k : d);
const pair = (v, d) => (typeof v === 'number' ? [v, v] : (Array.isArray(v) ? v : d));

function localMatrix(l) {
  const ks = l.ks ?? {};
  if (!['p', 'a', 's', 'r', 'sk', 'sa'].every((k) => isStatic(ks[k]))) return null;
  if (ks.px || ks.py) return null;
  const p = pair(kOf(ks.p, [0, 0]), [0, 0]);
  const an = pair(kOf(ks.a, [0, 0]), [0, 0]);
  const s = pair(kOf(ks.s, [100, 100]), [100, 100]);
  const r = kOf(ks.r, 0), sk = kOf(ks.sk, 0);
  if (sk) return null;                                    // skew: not worth decomposing
  const th = r * RAD, c = Math.cos(th), si = Math.sin(th);
  const sx = s[0] / 100, sy = s[1] / 100;
  const m = [c * sx, -si * sy, si * sx, c * sy];
  return [m[0], m[1], m[2], m[3],
          p[0] - (m[0] * an[0] + m[1] * an[1]),
          p[1] - (m[2] * an[0] + m[3] * an[1])];
}

const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[0] * B[4] + A[1] * B[5] + A[4], A[2] * B[4] + A[3] * B[5] + A[5],
];

function worldMatrix(l, byInd, cache, depth = 0) {
  if (cache.has(l.ind)) return cache.get(l.ind);
  let m = localMatrix(l);
  if (m && 'parent' in l) {
    const p = depth < 32 ? byInd.get(l.parent) : null;
    const pw = p ? worldMatrix(p, byInd, cache, depth + 1) : null;
    m = pw ? mul(pw, m) : null;
  }
  cache.set(l.ind, m);
  return m;
}

/**
 * Recover Lottie's (rotation, scale, translation) from an affine matrix.
 * Lottie composes R(r)·S(s), so a = cos·sx, b = -sin·sy, c = sin·sx, d = cos·sy.
 * Returns null if recomposing does not reproduce the matrix, which catches any
 * skew or mirroring the simple form cannot express.
 */
function decompose(m) {
  const [a, b, c, d, tx, ty] = m;
  const th = Math.atan2(c, a);
  const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
  const cos = Math.cos(th), sin = Math.sin(th);
  const back = [cos * sx, -sin * sy, sin * sx, cos * sy];
  for (let i = 0; i < 4; i++) if (Math.abs(back[i] - m[i]) > 1e-6) return null;
  return { r: th * DEG, s: [sx * 100, sy * 100], p: [tx, ty] };
}

const num = (v) => (Number.isInteger(v) ? v : Number(v.toFixed(4)));

/** Gate a layer's opacity by its lifetime, since a group has no in/out point. */
function gatedOpacity(l, compIp, compOp) {
  const ip = l.ip ?? compIp, op = l.op ?? compOp;
  const o = l.ks?.o;
  const inside = isStatic(o) ? [{ h: 1, s: [kOf(o, 100)], t: ip }] : o.k.map((k) => ({ ...k }));
  const k = [];
  if (ip > compIp) k.push({ h: 1, s: [0], t: compIp });
  k.push(...inside);
  if (op < compOp) k.push({ h: 1, s: [0], t: op });
  if (k.length === 1 && k[0].s[0] === 100) return { a: 0, k: 100 };
  return { a: 1, k };
}

export function flattenLayers(doc, { reverse = false, chunk = Infinity } = {}) {
  const stats = { layersBefore: 0, layersAfter: 0, groups: 0, skipped: 0 };

  for (const comp of [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))]) {
    const layers = comp.layers;
    stats.layersBefore += layers.length;
    if (layers.length < 2) { stats.layersAfter += layers.length; continue; }

    const byInd = new Map(layers.map((l) => [l.ind, l]));
    const cache = new Map();
    const compIp = Math.min(...layers.map((l) => l.ip ?? 0));
    const compOp = Math.max(...layers.map((l) => l.op ?? 0));

    // Anything the simple group form cannot express keeps its own layer.
    const blocked = (l) =>
      l.ty !== 4 || l.tt !== undefined || l.td !== undefined || l.hd ||
      l.masksProperties?.length || l.ef?.length || l.bm || l.tm ||
      !worldMatrix(l, byInd, cache) || !decompose(worldMatrix(l, byInd, cache));

    if (layers.some((l) => l.shapes?.length && blocked(l))) {
      stats.skipped += layers.length;
      stats.layersAfter += layers.length;
      continue;
    }

    const groups = [];
    for (const l of layers) {
      if (!l.shapes?.length) continue;                    // pure transform node: absorbed
      const { r, s, p } = decompose(worldMatrix(l, byInd, cache));
      groups.push({
        ty: 'gr',
        it: [...l.shapes, {
          ty: 'tr',
          p: { a: 0, k: [num(p[0]), num(p[1])] },
          a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [num(s[0]), num(s[1])] },
          r: { a: 0, k: num(r) },
          o: gatedOpacity(l, compIp, compOp),
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
        }],
      });
    }
    if (reverse) groups.reverse();
    stats.groups += groups.length;

    const shell = (shapes, ind) => ({
      ty: 4, ind, ip: compIp, op: compOp, sr: 1, st: 0, bm: 0, ao: 0, ddd: 0, shapes,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
            r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    });

    const out = [];
    for (let i = 0; i < groups.length; i += chunk) {
      out.push(shell(groups.slice(i, i + chunk), out.length + 1));
    }
    comp.layers = out.length ? out : [shell([], 1)];
    stats.layersAfter += comp.layers.length;
  }
  return { doc, stats };
}
