/**
 * Merge duplicate artwork: one layer per (shape, world position), instead of one
 * per exported frame.
 *
 * Frame-baked exports re-emit the same path once per drawing, each under its own
 * per-frame parent group. Those layers are byte-identical artwork sitting at the
 * same place on screen; only their lifetimes differ. Keeping one of them and
 * giving it the union of the lifetimes draws exactly the same pixels — as long as
 * paint order is respected, which is the whole difficulty.
 *
 * Z-ORDER IS THE CONSTRAINT. Layers paint in list order, so merging moves artwork
 * within the stack. That is only safe if some single global order still satisfies
 * every "A paints before B" pair that held between layers visible at the same
 * time. So: build that constraint graph over merge groups, find strongly connected
 * components, and un-merge any group caught in a cycle — a cycle means no valid
 * order exists. Splitting always converges, because fully split groups reproduce
 * the original layer order, which is by definition valid.
 *
 * Only layers whose whole parent chain is static are eligible; a layer whose
 * position is animated is not "the same artwork at the same place" over time.
 */

import { makeGrid, coverageMask, masksIntersect } from './raster.js';

const RAD = Math.PI / 180;
const isStatic = (p) => !p || p.a !== 1;
const kOf = (p, d) => (p && 'k' in p ? p.k : d);
const pair = (v, d) => (typeof v === 'number' ? [v, v] : (Array.isArray(v) ? v : d));

/** Local affine matrix [a,b,c,d,tx,ty], or null when any component is animated. */
function localMatrix(l) {
  const ks = l.ks ?? {};
  if (!['p', 'a', 's', 'r', 'sk', 'sa'].every((k) => isStatic(ks[k]))) return null;
  if (ks.px || ks.py) return null;                       // split position, rare; skip
  const p = pair(kOf(ks.p, [0, 0]), [0, 0]);
  const an = pair(kOf(ks.a, [0, 0]), [0, 0]);
  const s = pair(kOf(ks.s, [100, 100]), [100, 100]);
  const r = kOf(ks.r, 0), sk = kOf(ks.sk, 0), sa = kOf(ks.sa, 0);
  if ([p, an, s].some((v) => v.some((n) => typeof n !== 'number')) ||
      typeof r !== 'number' || typeof sk !== 'number' || typeof sa !== 'number') return null;

  const th = r * RAD, c = Math.cos(th), si = Math.sin(th);
  let m = [c, -si, si, c];                                // rotation
  if (sk) {                                               // skew along axis sa
    const t = Math.tan(sk * RAD), ca = Math.cos(sa * RAD), sn = Math.sin(sa * RAD);
    const sh = [1 + t * sn * ca, t * ca * ca, -t * sn * sn, 1 - t * sn * ca];
    m = [m[0] * sh[0] + m[1] * sh[2], m[0] * sh[1] + m[1] * sh[3],
         m[2] * sh[0] + m[3] * sh[2], m[2] * sh[1] + m[3] * sh[3]];
  }
  const sx = s[0] / 100, sy = s[1] / 100;
  m = [m[0] * sx, m[1] * sy, m[2] * sx, m[3] * sy];
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
  if (m && 'parent' in l && depth < 32) {
    const p = byInd.get(l.parent);
    const pw = p ? worldMatrix(p, byInd, cache, depth + 1) : null;
    m = pw ? mul(pw, m) : null;
  } else if (m && 'parent' in l) m = null;
  cache.set(l.ind, m);
  return m;
}

/**
 * Axis-aligned bounds of a layer's artwork in local space, over the control
 * polygon (which bounds the curves it defines), padded for stroke width.
 * null means "unknown", which callers must treat as overlapping everything.
 */
function localBounds(shapes) {
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
      for (const g of ['v', 'i', 'o']) {
        const pts = n[g] ?? [];
        for (let j = 0; j < pts.length; j++) {
          const base = g === 'v' ? [0, 0] : (n.v[j] ?? [0, 0]);
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
  const m = stroke / 2 + 1;
  return [lo[0] - m, lo[1] - m, hi[0] + m, hi[1] + m];
}

/** Local bounds pushed through a world matrix, re-fitted to an axis-aligned box. */
function worldBounds(shapes, m) {
  const b = localBounds(shapes);
  if (!b || !m) return null;
  const xs = [], ys = [];
  for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
    xs.push(m[0] * x + m[1] * y + m[4]);
    ys.push(m[2] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * `false` means the layer paints nothing, so it can never occlude and imposes no
 * ordering at all. `null` means it paints something we could not measure, which
 * must be assumed to occlude everything. Conflating the two is a trap: the
 * per-frame parent groups carry `shapes: []`, and treating those 305 pure
 * transform nodes as unknown made them universal barriers that chained every
 * group into a single cycle and blocked all merging.
 */
const boxesOverlap = (a, b) => {
  if (a === false || b === false) return false;
  if (!a || !b) return true;
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
};

const paintsNothing = (l) => l.ty === 3 || (l.ty === 4 && !(l.shapes?.length));

function maxStroke(shapes) {
  let w = 0;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.ty === 'st') {
      let k = n.w?.k;
      if (Array.isArray(k) && k[0] && typeof k[0] === 'object') {
        k = Math.max(...k.filter((x) => 's' in x).map((x) => x.s[0]));
      }
      if (typeof k === 'number') w = Math.max(w, k);
    }
    Object.values(n).forEach(walk);
  };
  walk(shapes);
  return w;
}

/** Merge intervals that overlap or touch. */
function union(intervals) {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [s[0].slice()];
  for (const iv of s.slice(1)) {
    const last = out[out.length - 1];
    if (iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv.slice());
  }
  return out;
}

/** Tarjan, iterative — these graphs are wide and recursion blows the stack. */
function stronglyConnected(n, edges) {
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
  const stack = [], comps = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] === 0) { index[v] = low[v] = counter++; stack.push(v); onStack[v] = 1; }
      let recursed = false;
      const adj = edges[v];
      while (frame[1] < adj.length) {
        const w = adj[frame[1]++];
        if (index[w] === -1) { work.push([w, 0]); recursed = true; break; }
        if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (recursed) continue;
      if (low[v] === index[v]) {
        const comp = [];
        for (;;) { const w = stack.pop(); onStack[w] = 0; comp.push(w); if (w === v) break; }
        comps.push(comp);
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
    }
  }
  return comps;
}

export function mergeDuplicateArtwork(doc, { precision = 4, enforceOrder = true, maskRes = 256 } = {}) {
  const stats = { groupsMerged: 0, layersRemoved: 0, cyclesBroken: 0 };

  for (const comp of [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))]) {
    const layers = comp.layers;
    if (layers.length < 2) continue;
    const byInd = new Map(layers.map((l) => [l.ind, l]));
    const parentInds = new Set(layers.filter((l) => 'parent' in l).map((l) => l.parent));
    const cache = new Map();

    // Group key: everything that decides what gets painted. Opacity is included
    // because parenting carries transform only, never opacity, so a layer's own
    // opacity fully determines it. Layers involved in track mattes are excluded:
    // their meaning depends on their neighbour in the stack.
    const keyOf = (l) => {
      if (l.ty !== 4 || !l.shapes?.length) return null;
      if (l.tt !== undefined || l.td !== undefined || l.hd) return null;
      if (parentInds.has(l.ind)) return null;             // children need it in place
      if (!isStatic(l.ks?.o)) return null;
      const m = worldMatrix(l, byInd, cache);
      if (!m) return null;
      return JSON.stringify([
        l.shapes, m.map((x) => Number(x.toFixed(precision))), kOf(l.ks.o, 100),
        l.bm ?? 0, l.sr ?? 1, l.st ?? 0, l.ef ?? null, l.masksProperties ?? null,
      ]);
    };

    // Candidate groups. Ineligible layers stay singletons so they still constrain
    // ordering even though they can never be merged into anything.
    const candidates = new Map();
    layers.forEach((l, i) => {
      const k = keyOf(l);
      if (k === null) return;
      if (!candidates.has(k)) candidates.set(k, []);
      candidates.get(k).push(i);
    });

    const win = layers.map((l) => [l.ip ?? 0, l.op ?? 0]);
    // Paint order only matters between shapes that can actually touch.
    const bounds = layers.map((l) => {
      if (paintsNothing(l)) return false;
      if (l.ty !== 4 || l.masksProperties?.length || l.ef?.length) return null;
      return worldBounds(l.shapes, worldMatrix(l, byInd, cache));
    });

    // Coverage masks, cached per (artwork, placement) since frame-baked exports
    // repeat the same pair thousands of times.
    const grid = makeGrid(doc.w ?? 512, doc.h ?? 512, maskRes);
    const maskCache = new Map();
    const maskOf = (i) => {
      const l = layers[i];
      if (bounds[i] === false) return false;
      if (bounds[i] === null) return null;
      const m = worldMatrix(l, byInd, cache);
      if (!m) return null;
      const key = JSON.stringify([l.shapes, m.map((x) => Number(x.toFixed(3)))]);
      if (!maskCache.has(key)) maskCache.set(key, coverageMask(l.shapes, m, grid, maxStroke(l.shapes)));
      return maskCache.get(key);
    };
    const covers = layers.map((_, i) => maskOf(i));

    // "i paints before j", for every pair alive at the same time whose artwork
    // can overlap. Computed once over layers, then mapped through whatever node
    // assignment we are currently testing.
    const ea = [], eb = [];
    for (let i = 0; i < layers.length; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        if (Math.max(win[i][0], win[j][0]) >= Math.min(win[i][1], win[j][1])) continue;
        if (!boxesOverlap(bounds[i], bounds[j])) continue;      // cheap reject
        if (covers[i] === false || covers[j] === false) continue; // paints nothing
        if (!masksIntersect(covers[i], covers[j])) continue;      // artwork cannot touch
        ea.push(i); eb.push(j);
      }
    }

    // Greedy, most valuable first. All-or-nothing does not work here: a walk
    // cycle legitimately swaps the depth of overlapping parts between drawings,
    // so every group ends up in one huge strongly-connected component and
    // splitting all of them merges nothing. Accepting groups one at a time keeps
    // every merge that does not actually conflict.
    const node = new Int32Array(layers.length);
    layers.forEach((_, i) => { node[i] = i; });
    const bytesOf = (i) => JSON.stringify(layers[i].shapes ?? '').length;
    const ranked = [...candidates.values()].filter((m) => m.length > 1)
      .sort((x, y) => (y.length - 1) * bytesOf(y[0]) - (x.length - 1) * bytesOf(x[0]));

    // Kahn over the mapped multigraph; duplicate edges are harmless because each
    // one is counted into indegree and decremented exactly once.
    const resolves = (assignment) => {
      const heads = new Map();
      const indeg = new Map();
      for (let i = 0; i < layers.length; i++) { heads.set(assignment[i], []); indeg.set(assignment[i], 0); }
      for (let e = 0; e < ea.length; e++) {
        const u = assignment[ea[e]], v = assignment[eb[e]];
        if (u === v) continue;
        heads.get(u).push(v);
        indeg.set(v, indeg.get(v) + 1);
      }
      const ready = [];
      for (const [n, d] of indeg) if (d === 0) ready.push(n);
      let seen = 0;
      while (ready.length) {
        const u = ready.pop();
        seen++;
        for (const v of heads.get(u)) if (indeg.set(v, indeg.get(v) - 1).get(v) === 0) ready.push(v);
      }
      return seen === heads.size;
    };

    const accepted = [];
    for (const group of ranked) {
      const trial = Int32Array.from(node);
      for (const i of group) trial[i] = group[0];
      if (enforceOrder && !resolves(trial)) { stats.cyclesBroken++; continue; }
      node.set(trial);
      accepted.push(group);
    }

    // final order: topological, tie-broken by first appearance
    const groupOf = node;
    const heads = new Map(), indeg = new Map(), firstIdx = new Map();
    for (let i = 0; i < layers.length; i++) {
      if (!heads.has(groupOf[i])) { heads.set(groupOf[i], []); indeg.set(groupOf[i], 0); firstIdx.set(groupOf[i], i); }
    }
    for (let e = 0; e < ea.length; e++) {
      const u = groupOf[ea[e]], v = groupOf[eb[e]];
      if (u === v) continue;
      heads.get(u).push(v);
      indeg.set(v, indeg.get(v) + 1);
    }
    const ready = [...indeg].filter(([, d]) => d === 0).map(([n]) => n)
      .sort((a, b) => firstIdx.get(a) - firstIdx.get(b));
    const order = [];
    while (ready.length) {
      const u = ready.shift();
      order.push(u);
      for (const v of heads.get(u)) {
        if (indeg.set(v, indeg.get(v) - 1).get(v) === 0) {
          let lo = 0, hi = ready.length;
          const f = firstIdx.get(v);
          while (lo < hi) { const mid = (lo + hi) >> 1; if (firstIdx.get(ready[mid]) < f) lo = mid + 1; else hi = mid; }
          ready.splice(lo, 0, v);
        }
      }
    }
    if (order.length !== heads.size) continue;     // no valid order; leave comp untouched

    const members = new Map();
    groupOf.forEach((g, i) => {
      if (!members.has(g)) members.set(g, []);
      members.get(g).push(i);
    });

    const out = [];
    for (const g of order) {
      const idx = members.get(g);
      const rep = layers[idx[0]];
      if (idx.length > 1) {
        const iv = union(idx.map((i) => win[i]));
        const opacity = kOf(rep.ks.o, 100);
        rep.ip = iv[0][0];
        rep.op = iv[iv.length - 1][1];
        if (iv.length === 1) {
          rep.ks.o = { a: 0, k: opacity };
        } else {
          const k = [];
          iv.forEach((seg, n) => {
            k.push({ h: 1, s: [opacity], t: seg[0] });
            if (n < iv.length - 1) k.push({ h: 1, s: [0], t: seg[1] });
          });
          rep.ks.o = { a: 1, k };
        }
        stats.groupsMerged++;
        stats.layersRemoved += idx.length - 1;
      }
      out.push(rep);
    }
    comp.layers = out;
  }

  // per-frame parent groups with no artwork and no children left are dead weight
  for (const comp of [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))]) {
    let changed = true;
    while (changed) {
      changed = false;
      const used = new Set(comp.layers.filter((l) => 'parent' in l).map((l) => l.parent));
      const kept = comp.layers.filter((l) => {
        const empty = (l.ty === 4 && (!l.shapes || l.shapes.length === 0)) || l.ty === 3;
        if (empty && !used.has(l.ind)) { stats.layersRemoved++; changed = true; return false; }
        return true;
      });
      comp.layers = kept;
    }
  }

  return { doc, stats };
}
