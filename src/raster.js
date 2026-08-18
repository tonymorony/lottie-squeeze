/**
 * Coverage masks, used to decide whether two layers can actually occlude each other.
 *
 * Paint order between two layers only matters where their artwork overlaps. A
 * bounding box is a hopeless proxy for that on a character illustration — every
 * limb's box intersects every other's, which makes the ordering constraint graph
 * one giant cycle and blocks every merge. So each layer's paths are flattened and
 * scanline-filled into a coarse bitmask, and overlap is a bitwise AND.
 *
 * The masks are deliberately dilated: a false "these overlap" only costs a missed
 * merge, while a false "these don't" would reorder artwork and change pixels.
 */

const SEGMENTS = 8;                                  // per cubic; plenty at mask resolution

function flatten(shapes, m, push) {
  const map = (x, y) => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const path = n.ty === 'sh' ? (n.ks?.a === 0 ? n.ks.k : null) : null;
    if (path && Array.isArray(path.v) && path.v.length) {
      const { v, i, o, c } = path;
      const poly = [];
      const n0 = v.length;
      for (let k = 0; k < (c === false ? n0 - 1 : n0); k++) {
        const k2 = (k + 1) % n0;
        const p0 = v[k], p3 = v[k2];
        const p1 = [p0[0] + (o?.[k]?.[0] ?? 0), p0[1] + (o?.[k]?.[1] ?? 0)];
        const p2 = [p3[0] + (i?.[k2]?.[0] ?? 0), p3[1] + (i?.[k2]?.[1] ?? 0)];
        for (let s = 0; s < SEGMENTS; s++) {
          const t = s / SEGMENTS, u = 1 - t;
          const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
          const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
          poly.push(map(x, y));
        }
      }
      if (poly.length > 2) push(poly);
    }
    Object.values(n).forEach(walk);
  };
  walk(shapes);
}

export function makeGrid(w, h, res = 256) {
  const scale = res / Math.max(w, h);
  return { res, scale, words: Math.ceil((res * res) / 32) };
}

/** Even-odd scanline fill of every subpath into one bitmask, then dilate by a cell. */
export function coverageMask(shapes, matrix, grid, strokePad = 0) {
  const { res, scale, words } = grid;
  const mask = new Uint32Array(words);
  const polys = [];
  flatten(shapes, matrix, (p) => polys.push(p));
  if (!polys.length) return null;

  const set = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= res || cy >= res) return;
    const bit = cy * res + cx;
    mask[bit >>> 5] |= 1 << (bit & 31);
  };

  for (const poly of polys) {
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of poly) { const cy = y * scale; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy; }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(res - 1, Math.ceil(maxY));
    for (let cy = y0; cy <= y1; cy++) {
      const sy = cy + 0.5;
      const xs = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const ay = a[1] * scale, by = b[1] * scale;
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          const t = (sy - ay) / (by - ay);
          xs.push((a[0] + t * (b[0] - a[0])) * scale);
        }
      }
      if (!xs.length) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.floor(xs[k])), x1 = Math.min(res - 1, Math.ceil(xs[k + 1]));
        for (let cx = x0; cx <= x1; cx++) set(cx, cy);
      }
      // the span edges themselves, so hairline shapes never vanish
      for (const x of xs) set(Math.round(x), cy);
    }
    // outline, so open or zero-area paths still register
    for (const [x, y] of poly) set(Math.round(x * scale), Math.round(y * scale));
  }

  const pad = Math.max(1, Math.ceil(strokePad * scale / 2) + 1);
  return dilate(mask, res, pad);
}

function dilate(mask, res, radius) {
  let cur = mask;
  for (let r = 0; r < radius; r++) {
    const next = Uint32Array.from(cur);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const bit = y * res + x;
        if (!(cur[bit >>> 5] & (1 << (bit & 31)))) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
          const nb = ny * res + nx;
          next[nb >>> 5] |= 1 << (nb & 31);
        }
      }
    }
    cur = next;
  }
  return cur;
}

export function masksIntersect(a, b) {
  if (!a || !b) return true;                         // unknown coverage must constrain
  for (let i = 0; i < a.length; i++) if (a[i] & b[i]) return true;
  return false;
}
