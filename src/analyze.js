/** Read-only diagnostics: where the bytes actually are, and what to do about it. */

const bytes = (v) => JSON.stringify(v).length;
const allComps = (doc) => [doc, ...(doc.assets ?? []).filter((a) => Array.isArray(a.layers))];

export function analyze(doc) {
  const byLayerKey = {}, byTransform = {}, byShapeType = {};
  let layers = 0, keyframes = 0, holdKeyframes = 0, animatedProps = 0;
  let redundantHolds = 0, zeroOpacityLayers = 0, retimable = 0;
  const shapeBlobs = new Map();

  const countKf = (node) => {
    if (Array.isArray(node)) return node.forEach(countKf);
    if (!node || typeof node !== 'object') return;
    if (node.a === 1 && Array.isArray(node.k) && node.k[0] && typeof node.k[0] === 'object') {
      animatedProps++; keyframes += node.k.length;
      let prev = null;
      for (const k of node.k) {
        if (k.h === 1) holdKeyframes++;
        if (prev && prev.h === 1 && 's' in k && 's' in prev
            && JSON.stringify(k.s) === JSON.stringify(prev.s)) redundantHolds++;
        prev = k;
      }
      return;
    }
    Object.values(node).forEach(countKf);
  };

  for (const comp of allComps(doc)) {
    const parentInds = new Set(comp.layers.filter((l) => 'parent' in l).map((l) => l.parent));
    for (const l of comp.layers) {
      layers++;
      for (const [k, v] of Object.entries(l)) byLayerKey[k] = (byLayerKey[k] ?? 0) + bytes(v);
      for (const [k, v] of Object.entries(l.ks ?? {})) byTransform[k] = (byTransform[k] ?? 0) + bytes(v);
      countKf(l.ks); countKf(l.shapes); countKf(l.masksProperties); countKf(l.ef);

      if (l.shapes) {
        const blob = JSON.stringify(l.shapes);
        shapeBlobs.set(blob, (shapeBlobs.get(blob) ?? 0) + 1);
        const walkShapes = (n) => {
          if (Array.isArray(n)) return n.forEach(walkShapes);
          if (!n || typeof n !== 'object') return;
          if (typeof n.ty === 'string') byShapeType[n.ty] = (byShapeType[n.ty] ?? 0) + bytes(n);
          Object.values(n).forEach(walkShapes);
        };
        walkShapes(l.shapes);
      }

      const o = l.ks?.o;
      if (o?.a === 1 && Array.isArray(o.k) && o.k[0]?.s !== undefined) {
        const vals = o.k.filter((k) => 's' in k).map((k) => k.s[0]);
        if (vals.every((v) => v === 0)) zeroOpacityLayers++;
        else if (!parentInds.has(l.ind) && l.td === undefined
                 && (vals[0] === 0 || vals[vals.length - 1] === 0)) retimable++;
      }
    }
  }

  let duplicateShapeBytes = 0, distinctShapes = 0;
  for (const [blob, n] of shapeBlobs) { distinctShapes++; if (n > 1) duplicateShapeBytes += (n - 1) * blob.length; }

  return {
    total: bytes(doc),
    layers, keyframes, animatedProps, holdKeyframes, redundantHolds,
    zeroOpacityLayers, retimable,
    shapeLayers: [...shapeBlobs.values()].reduce((a, b) => a + b, 0),
    distinctShapes, duplicateShapeBytes,
    byLayerKey: sortDesc(byLayerKey), byTransform: sortDesc(byTransform), byShapeType: sortDesc(byShapeType),
    hints: hints({ redundantHolds, retimable, zeroOpacityLayers, duplicateShapeBytes, keyframes }),
  };
}

const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

function hints(m) {
  const out = [];
  if (m.redundantHolds > 50)
    out.push(`${m.redundantHolds} hold keyframes repeat the previous value — a frame-by-frame export. Default pass folds these.`);
  if (m.retimable > 20)
    out.push(`${m.retimable} layers sit at opacity 0 outside a short window — converting that to ip/op also makes playback faster, since the player skips them entirely.`);
  if (m.zeroOpacityLayers)
    out.push(`${m.zeroOpacityLayers} layers are never visible at any frame and can be dropped outright.`);
  if (m.duplicateShapeBytes > 100_000)
    out.push(`${(m.duplicateShapeBytes / 1024).toFixed(0)} KB of duplicated path data. --dedup hoists it into shared precomps, but measure runtime first (see README).`);
  if (!out.length) out.push('Nothing structurally wasteful found; expect modest gains.');
  return out;
}
