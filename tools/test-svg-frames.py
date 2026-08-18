#!/usr/bin/env python3
"""Self-test for tools/svg-frames-to-lottie.py — synthetic frames, no browser needed."""
import importlib.util, json, os, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('f2l', os.path.join(here, 'svg-frames-to-lottie.py'))
f2l = importlib.util.module_from_spec(spec); spec.loader.exec_module(f2l)

passed = 0
def check(name, cond):
    global passed
    if not cond: print('  FAIL', name); sys.exit(1)
    passed += 1; print('  ok  ', name)

def svg(body, extra_css=''):
    return f'''<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><style>.bg{{fill:#ffc522;}} .red{{fill:#d7282f;}} .blue{{fill:#0000ff;}} .half{{fill:#000;opacity:.5;}} .clip{{clip-path:url(#cp);}} .none{{fill:none;}} {extra_css}</style>
<clipPath id="cp"><circle class="none" cx="50" cy="50" r="40"/></clipPath></defs>{body}</svg>'''

BG = '<circle class="bg" cx="50" cy="50" r="40"/>'
SQ = lambda x, y, cls='red': f'<path class="{cls}" d="m{x},{y}h10v10h-10Z"/>'

def build(frames, **kw):
    d = tempfile.mkdtemp()
    for i, body in enumerate(frames):
        open(os.path.join(d, f'f{i:02d}.svg'), 'w').write(svg(body))
    files = sorted(os.path.join(d, f) for f in os.listdir(d))
    doc, insts, per_frame, crop = f2l.build(files, log=lambda *a: None, **kw)
    return doc, insts, per_frame

def groups(doc): return doc['layers'][0]['shapes']
def opacity_at(g, f):
    o = g['it'][-1]['o']
    if o['a'] == 0: return o['k']
    v = 0
    for k in o['k']:
        if k['t'] <= f: v = k['s'][0]
    return v

print('svg-frames-to-lottie self-test')

# 1. identical shape across frames -> one instance, static opacity
doc, insts, _ = build([BG + SQ(20, 20), BG + SQ(20, 20), BG + SQ(20, 20)])
check('same shape in every frame is one group with static opacity',
      len(groups(doc)) == 2 and all(g['it'][-1]['o']['a'] == 0 for g in groups(doc)))

# 2. shape present only in frame 2 -> hold keyframes 0,100,0
doc, insts, _ = build([BG, BG + SQ(20, 20), BG])
g = [g for g in groups(doc) if g['it'][-1]['o']['a'] == 1][0]
check('a shape visible in one frame gets hold keyframes', [opacity_at(g, f) for f in range(3)] == [0, 100, 0]
      and all(k.get('h') == 1 for k in g['it'][-1]['o']['k']))

# 3. translated copy is the same geometry key but a different instance (position differs)
doc, insts, _ = build([BG + SQ(20, 20), BG + SQ(30, 20)])
check('translated shape is a separate static instance (no position keyframes)',
      len(insts) == 3 and all(g['it'][-1]['p']['a'] == 0 for g in groups(doc)))

# 4. paint order: red under blue in frame 1, blue under red in frame 2 -> conflict split, both frames right
doc, insts, per_frame = build([BG + SQ(20, 20, 'red') + SQ(25, 25, 'blue'), BG + SQ(25, 25, 'blue') + SQ(20, 20, 'red')])
gs = groups(doc)  # lottie order: first = on top
def visible_order(f):
    return [g for g in gs if opacity_at(g, f) > 0]
def color_of(g): return tuple(round(c, 2) for c in [it for it in g['it'] if it['ty'] == 'fl'][0]['c']['k'])
red, blue = (0.84, 0.16, 0.18), (0.0, 0.0, 1.0)
o1 = [color_of(g) for g in visible_order(0)]; o2 = [color_of(g) for g in visible_order(1)]
check('z-order conflict is resolved by splitting, each frame keeps its own stacking',
      o1.index(blue) < o1.index(red) and o2.index(red) < o2.index(blue))

# 5. occlusion: shape painted under the opaque circle and inside it is culled; outside is kept
doc, insts, _ = build([SQ(40, 40) + BG + SQ(0, 0)])
check('hidden-under-background shape is culled, visible one kept', len(insts) == 2)

# 6. clip-path circle resolved geometrically, output has no masks
doc, insts, _ = build([BG + '<g class="clip"><rect class="red" x="0" y="45" width="100" height="10"/></g>'])
layer = doc['layers'][0]
check('circle clip-path becomes geometry, no masksProperties',
      'masksProperties' not in layer and len(insts) == 2 and any(abs(v[0] - 10.0) < 0.5 for g in groups(doc) for it in g['it'] if it['ty'] == 'sh' for v in it['ks']['k']['v']))

# 7. adjacent same-style opaque non-overlapping shapes merge into one group; half-opaque do not
doc, _, _ = build([BG + SQ(10, 10) + SQ(30, 10) + SQ(50, 10)])
check('adjacent same-style opaque shapes merge into one group', len(groups(doc)) == 2)
doc, _, _ = build([BG + SQ(10, 10, 'half') + SQ(30, 10, 'half')])
check('semi-transparent shapes are never merged', len(groups(doc)) == 3)
doc, _, _ = build([BG + SQ(10, 10) + SQ(30, 10)], merge=False)
check('--no-merge keeps one group per shape', len(groups(doc)) == 3)

# 8. re-alignment: whole frame shifted by 0.7 px is pulled back onto the others
def shifted(dx): return f'<circle class="bg" cx="{50+dx}" cy="50" r="40"/>' + SQ(20 + dx, 20)
doc, insts, _ = build([BG + SQ(20, 20), shifted(0.7), BG + SQ(20, 20)])
check('sub-pixel artboard drift is corrected (one instance, not two)', len(insts) == 2 and f2l.SHIFTS[1] == (-0.7, 0))
doc, insts, _ = build([BG + SQ(20, 20), shifted(0.7), BG + SQ(20, 20)], realign=False)
check('--no-realign keeps the drift', len(insts) == 4)

# 9. colors survive truncating renderers: v*255 never lands below the integer
c = f2l.color((0x8f / 255, 0xc5 / 255, 0x22 / 255))
check('color channels round up so floor(v*255) is exact', [int(x * 255) for x in c] == [0x8f, 0xc5, 0x22] and all(round(x * 255) == n for x, n in zip(c, [0x8f, 0xc5, 0x22])))

# 10. lottie draw order: last group in the array is painted first (background must be last)
doc, _, _ = build([BG + SQ(20, 20)])
check('background circle is the last group in the shapes array', len(groups(doc)[-1]['it'][0]['ks']['k']['v']) == 8)

# 11. document shape
check('document has one shape layer, fps and op set', doc['layers'][0]['ty'] == 4 and doc['op'] == 1 and doc['fr'] == 30 and doc['w'] == 100)

print(f'{passed} passed')
