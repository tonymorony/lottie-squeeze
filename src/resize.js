/**
 * Change a composition's declared width/height.
 *
 * Note this is almost never needed: Lottie is vector, `w`/`h` are just a viewBox,
 * and every player scales the animation to whatever box you give it. Resizing the
 * file only matters when some downstream tool reads `w`/`h` as the true size.
 *
 * It is also NOT a way to save bytes. The naive approach — dividing every
 * coordinate — costs size rather than saving it, because 300-space values like
 * 127.15 become 42.38 (no shorter) while exact values like 300 turn into
 * repeating decimals. Measured on a real 300x300 file: +34 KB at 2dp,
 * +182 KB at 3dp.
 *
 * So the geometry is left exactly as authored and the scale is pushed onto the
 * root layers instead. For a root layer, screen position is p + M(x - a) with
 * M = R·S. Scaling the whole comp by f wants f·p + f·M(x - a), which is reached
 * by multiplying `p` by f and `s` by f while leaving the anchor alone — f·M = R·(f·S)
 * holds because a uniform scale commutes with rotation. Layers that have a parent
 * are skipped: they already inherit that factor through the hierarchy.
 */

const scaleValue = (v, f) => (Array.isArray(v) ? v.map((n) => (typeof n === 'number' ? n * f : n)) : v * f);

function scaleProp(prop, f, spatial) {
  if (!prop) return;
  if (prop.a === 1 && Array.isArray(prop.k)) {
    for (const kf of prop.k) {
      if ('s' in kf) kf.s = scaleValue(kf.s, f);
      if ('e' in kf) kf.e = scaleValue(kf.e, f);
      // ti/to are spatial tangents, in the same units as the value they steer
      if (spatial) {
        if (Array.isArray(kf.ti)) kf.ti = scaleValue(kf.ti, f);
        if (Array.isArray(kf.to)) kf.to = scaleValue(kf.to, f);
      }
    }
  } else if ('k' in prop) {
    prop.k = scaleValue(prop.k, f);
  }
}

export function resize(doc, width, height) {
  const fx = width / doc.w, fy = height / doc.h;
  if (Math.abs(fx - fy) > 1e-9) {
    throw new Error(
      `non-uniform resize ${doc.w}x${doc.h} -> ${width}x${height} would distort the animation; ` +
      `keep the aspect ratio (or letterbox in your container instead)`);
  }
  const f = fx;
  let scaled = 0;
  for (const l of doc.layers) {
    if ('parent' in l) continue;
    if (l.ks?.p) scaleProp(l.ks.p, f, true);
    for (const axis of ['px', 'py', 'pz']) if (l.ks?.[axis]) scaleProp(l.ks[axis], f, false);
    if (l.ks?.s) scaleProp(l.ks.s, f, false);        // scale is a percentage: multiply
    else if (l.ks) l.ks.s = { a: 0, k: [f * 100, f * 100, 100] };
    scaled++;
  }
  doc.w = width;
  doc.h = height;
  return { doc, stats: { factor: f, rootLayersScaled: scaled } };
}
